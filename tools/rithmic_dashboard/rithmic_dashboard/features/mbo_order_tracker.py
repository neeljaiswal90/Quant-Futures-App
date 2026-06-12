"""Bounded-tail MBO lifecycle tracking for iceberg-like refill detection."""

from __future__ import annotations

import bisect
import json
import math
from collections import deque
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from rithmic_dashboard.models import DataWarning, MboOrderEvent, TradeTick

# Perf: orjson parses MBO lines ~4x faster than stdlib json (measured on real
# captures). Optional dependency — fall back to stdlib when absent. orjson's
# JSONDecodeError subclasses json.JSONDecodeError, so the handler below is safe.
try:
    import orjson as _orjson

    def _loads(text: str | bytes) -> Any:
        return _orjson.loads(text)
except ImportError:  # pragma: no cover - orjson is an optional perf dependency

    def _loads(text: str | bytes) -> Any:
        return json.loads(text)

DEFAULT_MAX_ACTIVE_ORDERS = 50_000
DEFAULT_ORDER_TTL_SECONDS = 120
DEFAULT_MATCH_TOLERANCE_MS = 50
TICK_SIZE = 0.25

# RA-065: FIFO sort direction for the per-(price, side) priority-ordered index.
#
# When True we treat ASCENDING depth_order_priority as front-of-queue: the
# LOWEST priority value sits at queue-position-1 and fills next. An order seen
# at queue-position-1 on its side at delete time is therefore treated as a
# probable FIFO fill (the independent priority confirmation channel), whereas a
# delete from deeper in the book is a probable cancel.
#
# *** HIGHEST-UNCERTAINTY ASSUMPTION — flagged for RA-066 calibration. ***
# Rithmic's depth_order_priority is a large monotonically-increasing token
# (~1e11 in the live captures). RA-066 Part B-a empirically CONFIRMED the
# ascending-is-front direction from captures alone: across 88,191 within-level
# adjacent ADD pairs the token rose with arrival time 100% of the time (zero
# counterexamples), so the oldest order at a level (the FIFO front, which fills
# first) carries the lowest token -> min == front. See
# cli/verify_fifo_direction.py + docs/iceberg_tolerance_calibration.md. (Whether
# front-of-queue deletes are real fills vs cancels — the precision question —
# still needs F/T ground truth: RA-066 Part B-b.)
FIFO_ASCENDING_IS_FRONT = True

# RA-065: confirmation-source tags carried on ConsumedOrder. The all-None
# (pre-RA-065 / no-priority) path always yields the legacy OBS tag so the
# byte-exact backward-compat gate holds.
_SOURCE_OBS = "obs_trade_tail"
_SOURCE_PRIORITY = "priority_queue"
_SOURCE_OBS_PRIORITY = "obs+priority"


@dataclass(frozen=True)
class MboTailResult:
    """Bounded MBO tail parse result."""

    source_path: Path
    events: tuple[MboOrderEvent, ...]
    tail_bytes: int
    tail_span_minutes: float


@dataclass(frozen=True)
class ConsumedOrder:
    """An MBO order disappearance confirmed by matching OBS trade volume.

    RA-065 adds two ADDITIVE, defaulted metadata fields (``confirmation_source``
    and ``priority``). They default to the legacy OBS values so existing call
    sites and the byte-exact backward-compat path are untouched; the iceberg
    detector reads only the original fields, so its output is unchanged on every
    path. ``confirmation_source`` records which channel arbitrated consumption:
    ``"obs_trade_tail"`` (legacy OBS only), ``"priority_queue"`` (queue-position
    channel only — fires when OBS is silent but priority data confirms a
    front-of-queue fill), or ``"obs+priority"`` (both agreed).
    """

    order_id: str
    side: Literal["B", "A"]
    price: float
    visible_size: int
    consumed_qty: int
    aggressor_side: Literal["buy", "sell"]
    add_ts_ns: int
    consume_ts_ns: int
    confirmation_source: str = _SOURCE_OBS
    priority: str | None = None
    # Phase 4: sequence of the ADD event, for position-precise window-back
    # eviction when several events share a timestamp at the tail boundary.
    add_seq: int = 0


@dataclass(slots=True)
class _TrackedOrder:
    order_id: str
    side: Literal["B", "A"]
    price: float
    size: int
    add_ts_ns: int
    last_ts_ns: int
    add_seq: int = 0  # Phase 4: ADD-event sequence for (ts, seq) window-back order
    # RA-065: raw queue-position string (as emitted by the probe) and its
    # lazily-parsed int form. ``priority_int`` is None when priority is absent
    # or non-numeric — in that case this order never enters the priority index
    # and the priority confirmation channel is inert for it (preserving the
    # byte-exact all-None path).
    priority: str | None = None
    priority_int: int | None = None
    # RA-065: set when this order surfaced as an iceberg-refresh candidate
    # (a fresh add at the same (price, side) whose priority jumped past the
    # prior queue tail within the refill window). Purely a source tag — does
    # not gate consumption.
    refill_by_priority_jump: bool = False


@dataclass(slots=True)
class _IndexedTrade:
    timestamp_ns: int
    quantity_remaining: int


class MboOrderTracker:
    """Small LRU order-lifecycle tracker for bounded MBO tails."""

    def __init__(
        self,
        *,
        match_tolerance_ms: int = DEFAULT_MATCH_TOLERANCE_MS,
        max_active_orders: int = DEFAULT_MAX_ACTIVE_ORDERS,
        order_ttl_seconds: int = DEFAULT_ORDER_TTL_SECONDS,
        tick_size: float = TICK_SIZE,
        refill_window_seconds: int = DEFAULT_ORDER_TTL_SECONDS,
        fifo_ascending_is_front: bool = FIFO_ASCENDING_IS_FRONT,
    ) -> None:
        self.match_tolerance_ns = match_tolerance_ms * 1_000_000
        self.max_active_orders = max_active_orders
        self.order_ttl_ns = order_ttl_seconds * 1_000_000_000
        self.tick_size = tick_size
        # RA-065: window within which a fresh add at the same (price, side) whose
        # priority jumped past the prior tail counts as an iceberg refresh.
        self.refill_window_ns = refill_window_seconds * 1_000_000_000
        self.fifo_ascending_is_front = fifo_ascending_is_front
        self.active: dict[str, _TrackedOrder] = {}
        self._order_queue: deque[tuple[int, str]] = deque()
        # RA-065: per-(price_bucket, side) priority-ordered active-order index,
        # keyed exactly like the iceberg detector's grouping
        # (round(price / tick_size), side). Holds order_ids of currently-active
        # orders that carry a numeric priority. Maintained in lockstep with
        # ``self.active`` / ``self._order_queue`` (NOT a replacement — eviction
        # still depends on those). Pruned on remove + stale/overflow eviction so
        # it can't leak under busy-open churn (RA-052 <2GB).
        self._priority_index: dict[tuple[int, str], dict[str, int]] = {}
        # RA-065: last-seen queue tail priority per (price_bucket, side) and the
        # ns at which it was observed, used for refill-by-priority-jump detection.
        # Intentionally NOT pruned (unlike _priority_index): it holds one small
        # tuple per distinct price bucket, bounded by the day's price range, and
        # the tracker is rebuilt per detect_icebergs call — so it stays in the KB
        # range and cannot leak across the RA-052 light path.
        self._last_tail_priority: dict[tuple[int, str], tuple[int, int]] = {}
        # Phase 4 (incremental tracker): (add_ts_ns, add_seq, order_id) queue so
        # evict_before() can drop orders whose ADD scrolled out of the byte-window
        # in O(evicted) without scanning all active orders. Appended only in _add
        # (events arrive in (ts, seq) order, so this stays sorted). The seq makes
        # the boundary position-precise when several adds share a tail timestamp.
        self._add_queue: deque[tuple[int, int, str]] = deque()

    def process(
        self,
        mbo_events: tuple[MboOrderEvent, ...] | list[MboOrderEvent],
        trades: list[TradeTick],
    ) -> tuple[ConsumedOrder, ...]:
        """Process MBO events and return OBS-confirmed consumed orders.

        Stateless-per-call entry point (prod + the fresh-per-window replay path):
        builds a fresh trade index and consumes a fully-sorted event batch.
        """

        trade_index = _TradeIndex(trades, tick_size=self.tick_size)
        ordered = sorted(mbo_events, key=lambda item: (item.timestamp_ns, item.sequence or 0))
        return self.consume_events(ordered, trade_index)

    def consume_events(
        self,
        ordered_events: list[MboOrderEvent] | tuple[MboOrderEvent, ...],
        trade_index: _TradeIndex,
    ) -> tuple[ConsumedOrder, ...]:
        """Consume an ALREADY-SORTED event batch against a (possibly persistent)
        trade index. Extracted from ``process`` so the Phase 4 incremental path
        can feed only new events on a persistent book + persistent trade index.
        """

        consumed: list[ConsumedOrder] = []
        for event in ordered_events:
            self._evict_stale(event.timestamp_ns)
            if event.action == "A":
                self._add(event)
            elif event.action == "M":
                self._modify(event)
            elif event.action in {"C", "F", "T"}:
                observed = self._remove(event, trade_index)
                if observed is not None:
                    consumed.append(observed)
            self._evict_overflow()
        return tuple(consumed)

    def evict_before(self, window_back_ts: int, window_back_seq: int = 0) -> None:
        """Phase 4: drop active orders whose ADD is before the window-back edge
        ``(window_back_ts, window_back_seq)`` in (ts, seq) order.

        Replicates the fresh-per-window detector's cold start: a fresh tracker
        processing only the bounded tail never sees orders added before the
        window, so a persistent tracker must forget them to stay byte-identical.
        The (ts, seq) edge — not ts alone — is required because several adds can
        share a timestamp while straddling the tail boundary. Combined with the
        per-event TTL eviction in :meth:`consume_events`, the persistent active
        set equals a from-empty rebuild over the same window (inductive proof in
        docs/perf/replay-incremental-tracker-design.md).
        """

        edge = (window_back_ts, window_back_seq)
        while self._add_queue and (self._add_queue[0][0], self._add_queue[0][1]) < edge:
            add_ts, add_seq, order_id = self._add_queue.popleft()
            order = self.active.get(order_id)
            # Guard against order_id reuse: only evict if this is still the same
            # order instance the queue entry referred to (same add ts + seq).
            if order is not None and order.add_ts_ns == add_ts and order.add_seq == add_seq:
                self.active.pop(order_id, None)
                self._index_remove(order)

    def _add(self, event: MboOrderEvent) -> None:
        if event.size <= 0:
            return
        priority_int = _parse_priority(event.priority)
        add_seq = event.sequence or 0
        order = _TrackedOrder(
            order_id=event.order_id,
            side=event.side,
            price=event.price,
            size=event.size,
            add_ts_ns=event.timestamp_ns,
            last_ts_ns=event.timestamp_ns,
            add_seq=add_seq,
            priority=event.priority,
            priority_int=priority_int,
        )
        # RA-065: refill-by-priority-jump detection. Decide BEFORE indexing this
        # order so the prior tail isn't contaminated by the new arrival. Only
        # fires when priority data is present (priority_int is not None), so the
        # all-None backward-compat path never sets the tag.
        order.refill_by_priority_jump = self._is_priority_jump_refill(
            order, now_ns=event.timestamp_ns
        )
        self.active[event.order_id] = order
        self._order_queue.append((event.timestamp_ns, event.order_id))
        self._add_queue.append((event.timestamp_ns, add_seq, event.order_id))
        self._index_add(order)

    def _modify(self, event: MboOrderEvent) -> None:
        order = self.active.get(event.order_id)
        if order is None:
            self._add(event)
            return
        # RA-065: keep the priority index consistent across an in-place modify.
        # Drop the stale (price, priority) index entry first, mutate, re-insert.
        self._index_remove(order)
        if event.price > 0 and math.isfinite(event.price):
            order.price = event.price
        if event.size > 0:
            order.size = event.size
        # A modify may restate priority; refresh the parsed form when present.
        if event.priority is not None:
            order.priority = event.priority
            order.priority_int = _parse_priority(event.priority)
        order.last_ts_ns = event.timestamp_ns
        self._order_queue.append((event.timestamp_ns, event.order_id))
        self._index_add(order)

    def _remove(self, event: MboOrderEvent, trade_index: _TradeIndex) -> ConsumedOrder | None:
        order = self.active.pop(event.order_id, None)
        if order is None:
            return None
        # RA-065: detect the priority channel BEFORE pruning the index so the
        # queue-position-1 test sees this order still in place.
        at_queue_front = self._is_at_queue_front(order)
        self._index_remove(order)
        expected_aggressor: Literal["buy", "sell"] = "sell" if order.side == "B" else "buy"
        matched_qty = trade_index.consume_matching_volume(
            price=order.price,
            timestamp_ns=event.timestamp_ns,
            aggressor_side=expected_aggressor,
            tolerance_ns=self.match_tolerance_ns,
            max_qty=max(order.size, event.size, 1),
        )
        # Either-channel composition (RA-065): an OBS-trade match OR a
        # queue-position-1 delete (or both) confirms consumption. OBS-only stays
        # sufficient and numerically identical to today — the priority channel
        # only ADDS confirmations that OBS would have rejected (matched_qty == 0)
        # and only ever fires when priority data is present, so the all-None path
        # is byte-exact. Priority is NEVER a necessary condition.
        obs_confirmed = matched_qty > 0
        if not obs_confirmed and not at_queue_front:
            return None

        visible_size = max(order.size, event.size, 1)
        if obs_confirmed:
            # OBS-derived numerics are preserved exactly (RA-059 untouched). The
            # source tag is the only thing the priority channel adds here.
            consumed_qty = matched_qty
            source = _SOURCE_OBS_PRIORITY if at_queue_front else _SOURCE_OBS
        else:
            # Queue-only confirmation: OBS gave nothing but this order was at the
            # front of its FIFO queue when it deleted → probable fill. Use the
            # known visible size as the consumed quantity.
            consumed_qty = visible_size
            source = _SOURCE_PRIORITY
        return ConsumedOrder(
            order_id=order.order_id,
            side=order.side,
            price=order.price,
            visible_size=visible_size,
            consumed_qty=consumed_qty,
            aggressor_side=expected_aggressor,
            add_ts_ns=order.add_ts_ns,
            consume_ts_ns=event.timestamp_ns,
            confirmation_source=source,
            priority=order.priority,
            add_seq=order.add_seq,
        )

    def _evict_stale(self, now_ns: int) -> None:
        cutoff = now_ns - self.order_ttl_ns
        while self._order_queue and self._order_queue[0][0] < cutoff:
            _, order_id = self._order_queue.popleft()
            order = self.active.get(order_id)
            if order is not None and order.last_ts_ns < cutoff:
                self.active.pop(order_id, None)
                self._index_remove(order)

    def _evict_overflow(self) -> None:
        while len(self.active) > self.max_active_orders and self._order_queue:
            queued_ts, order_id = self._order_queue.popleft()
            order = self.active.get(order_id)
            if order is not None and order.last_ts_ns == queued_ts:
                self.active.pop(order_id, None)
                self._index_remove(order)

    # ------------------------------------------------------------------
    # RA-065: per-(price_bucket, side) priority-ordered index helpers
    # ------------------------------------------------------------------

    def _bucket_key(self, order: _TrackedOrder) -> tuple[int, str] | None:
        """Index key matching the iceberg detector's grouping, or None when the
        price isn't finite/positive (NaN-price C/T events don't get indexed)."""
        if not math.isfinite(order.price) or order.price <= 0:
            return None
        return (round(order.price / self.tick_size), order.side)

    def _index_add(self, order: _TrackedOrder) -> None:
        if order.priority_int is None:
            return
        key = self._bucket_key(order)
        if key is None:
            return
        self._priority_index.setdefault(key, {})[order.order_id] = order.priority_int

    def _index_remove(self, order: _TrackedOrder) -> None:
        if order.priority_int is None:
            return
        key = self._bucket_key(order)
        if key is None:
            return
        bucket = self._priority_index.get(key)
        if bucket is None:
            return
        bucket.pop(order.order_id, None)
        if not bucket:
            self._priority_index.pop(key, None)

    def _is_at_queue_front(self, order: _TrackedOrder) -> bool:
        """True if ``order`` holds queue-position-1 in its (price, side) bucket.

        Front-of-queue means the extreme priority per :data:`FIFO_ASCENDING_IS_FRONT`
        (min when ascending-is-front, else max). Inert when the order has no
        numeric priority or its bucket is empty — keeps the all-None path
        byte-exact (no priority → never front → OBS remains the sole arbiter)."""
        if order.priority_int is None:
            return False
        key = self._bucket_key(order)
        if key is None:
            return False
        bucket = self._priority_index.get(key)
        if not bucket:
            return False
        if self.fifo_ascending_is_front:
            front_priority = min(bucket.values())
        else:
            front_priority = max(bucket.values())
        return order.priority_int == front_priority

    def _is_priority_jump_refill(self, order: _TrackedOrder, *, now_ns: int) -> bool:
        """True when a fresh add looks like an iceberg refresh: its priority
        jumped past the prior queue tail at the same (price, side), within the
        refill window. Inert without numeric priority (byte-exact all-None path).

        Updates the per-bucket tail bookkeeping as a side effect."""
        if order.priority_int is None:
            return False
        key = self._bucket_key(order)
        if key is None:
            return False
        prior = self._last_tail_priority.get(key)
        self._last_tail_priority[key] = (order.priority_int, now_ns)
        if prior is None:
            return False
        prior_priority, prior_ns = prior
        if now_ns - prior_ns > self.refill_window_ns:
            return False
        # A jump = the new order sits BEHIND the prior tail in queue order: a
        # higher priority value when ascending-is-front, lower otherwise.
        if self.fifo_ascending_is_front:
            return order.priority_int > prior_priority
        return order.priority_int < prior_priority


class _TradeIndex:
    def __init__(self, trades: list[TradeTick], *, tick_size: float) -> None:
        self.tick_size = tick_size
        self.by_price_side: dict[tuple[int, str], list[_IndexedTrade]] = {}
        for trade in trades:
            if trade.timestamp_ns is None or trade.aggressor_side not in {"buy", "sell"}:
                continue
            bucket = round(trade.price / tick_size)
            self.by_price_side.setdefault((bucket, trade.aggressor_side), []).append(
                _IndexedTrade(
                    timestamp_ns=trade.timestamp_ns,
                    quantity_remaining=max(0, trade.quantity),
                )
            )
        for rows in self.by_price_side.values():
            rows.sort(key=lambda tick: tick.timestamp_ns)

    def extend(self, trades: list[TradeTick] | tuple[TradeTick, ...]) -> None:
        """Phase 4: append NEW trades to the persistent index. ``trades`` must be
        in ts order (a suffix of the sorted trade tail), so each bucket stays
        ts-sorted by appending — no re-sort. New trades carry full remaining
        quantity; already-indexed trades keep their depletion state.
        """
        for trade in trades:
            if trade.timestamp_ns is None or trade.aggressor_side not in {"buy", "sell"}:
                continue
            bucket = round(trade.price / self.tick_size)
            self.by_price_side.setdefault((bucket, trade.aggressor_side), []).append(
                _IndexedTrade(
                    timestamp_ns=trade.timestamp_ns,
                    quantity_remaining=max(0, trade.quantity),
                )
            )

    def evict_before(self, cutoff_ts: int) -> None:
        """Phase 4: drop trades older than ``cutoff_ts`` (the trade-window back).
        Buckets are ts-sorted, so this is a prefix trim. Keeps the persistent
        index bounded to the current trade tail and matches the fresh path, which
        only ever indexes the window's trades."""
        for key in list(self.by_price_side.keys()):
            rows = self.by_price_side[key]
            i = 0
            n = len(rows)
            while i < n and rows[i].timestamp_ns < cutoff_ts:
                i += 1
            if i:
                del rows[:i]
            if not rows:
                del self.by_price_side[key]

    def consume_matching_volume(
        self,
        *,
        price: float,
        timestamp_ns: int,
        aggressor_side: Literal["buy", "sell"],
        tolerance_ns: int,
        max_qty: int,
    ) -> int:
        bucket = round(price / self.tick_size)
        total = 0
        for trade in self.by_price_side.get((bucket, aggressor_side), []):
            if trade.quantity_remaining <= 0:
                continue
            if trade.timestamp_ns < timestamp_ns - tolerance_ns:
                continue
            if trade.timestamp_ns > timestamp_ns + tolerance_ns:
                break
            take = min(trade.quantity_remaining, max_qty - total)
            if take <= 0:
                break
            trade.quantity_remaining -= take
            total += take
            if total >= max_qty:
                break
        return total


# Perf (incremental-parse rewrite, Phase 2): the replay harness re-reads an
# overlapping bounded MBO tail every 500ms step, so the same raw line gets parsed
# thousands of times (~30M parses / 800 steps in profiling — the dominant cost).
# Parsing is a pure function of the raw line (-> immutable MboOrderEvent | None),
# so an LRU cache keyed on the line collapses N_steps re-parses to one parse per
# unique line: the per-step O(tail) parse becomes amortized O(new bytes). maxsize
# comfortably exceeds one ~20MB tail window (~40k lines) so the whole current
# window stays hot between consecutive steps; older lines evict as the window
# slides forward. Byte-exact: identical line -> identical event (golden gate).
@lru_cache(maxsize=131_072)
def _parse_mbo_line(raw: str) -> MboOrderEvent | None:
    try:
        rec = _loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(rec, dict):
        return None
    return _mbo_event(rec)


def load_mbo_events_from_tail(
    mbo_path: Path,
    *,
    tail_bytes: int,
    warnings: list[DataWarning] | None = None,
) -> MboTailResult:
    """Parse normalized MBO events from a bounded file tail."""

    if not mbo_path.exists():
        if warnings is not None:
            warnings.append(
                DataWarning("info", f"Iceberg detector unavailable; missing {mbo_path}")
            )
        return MboTailResult(mbo_path, (), tail_bytes, 0.0)
    size = mbo_path.stat().st_size
    seek_pos = max(0, size - tail_bytes)
    with mbo_path.open("rb") as f:
        f.seek(seek_pos)
        text = f.read().decode("utf-8", errors="ignore")
    lines = text.splitlines()
    if seek_pos > 0 and lines:
        lines = lines[1:]
    events: list[MboOrderEvent] = []
    for raw in lines:
        event = _parse_mbo_line(raw)
        if event is not None:
            events.append(event)
    events.sort(key=lambda item: (item.timestamp_ns, item.sequence or 0))
    return MboTailResult(
        source_path=mbo_path,
        events=tuple(events),
        tail_bytes=tail_bytes,
        tail_span_minutes=_tail_span_minutes(events),
    )


def _mbo_event(rec: dict[str, Any]) -> MboOrderEvent | None:
    action = _action(rec.get("action"))
    side = _side(rec.get("side"))
    timestamp = _int(
        rec.get("ts_event_ns") if rec.get("ts_event_ns") is not None else rec.get("event_ts_ns")
    )
    price = _float(rec.get("price"))
    size = _int(rec.get("size"))
    order_id = str(rec.get("order_id") or "")
    if (
        action is None
        or side is None
        or timestamp is None
        or price is None
        or size is None
        or not order_id
    ):
        return None
    # RA-065: carry priority as a raw string (or None when absent on pre-RA-065
    # siblings). Stringly-typed at the boundary; parsed to int lazily in the
    # tracker so non-numeric vendor priorities don't break loading and the
    # all-None path stays byte-exact.
    priority_raw = rec.get("priority")
    priority = str(priority_raw) if priority_raw is not None else None
    return MboOrderEvent(
        timestamp_ns=timestamp,
        recv_ts_ns=_int(
            rec.get("ts_recv_ns") if rec.get("ts_recv_ns") is not None else rec.get("recv_ts_ns")
        ),
        sequence=_int(rec.get("sequence")),
        action=action,
        side=side,
        price=price,
        size=size,
        order_id=order_id,
        priority=priority,
    )


def _tail_span_minutes(events: list[MboOrderEvent]) -> float:
    if len(events) < 2:
        return 0.0
    return max(0.0, (events[-1].timestamp_ns - events[0].timestamp_ns) / 60_000_000_000)


def _action(value: Any) -> Literal["A", "M", "C", "F", "T"] | None:
    raw = str(value or "").upper()
    if raw in {"A", "M", "C", "F", "T"}:
        return raw  # type: ignore[return-value]
    return None


def _side(value: Any) -> Literal["B", "A"] | None:
    raw = str(value or "").upper()
    if raw in {"B", "A"}:
        return raw  # type: ignore[return-value]
    return None


def _float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) and parsed > 0 else None


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _parse_priority(value: str | None) -> int | None:
    """RA-065: defensively parse a raw priority string to int.

    Returns None on None or any non-numeric value so the priority confirmation
    channel stays inert (and the all-None backward-compat path byte-exact)
    rather than raising on a vendor priority we can't interpret as a queue
    position. Tolerant of surrounding whitespace; rejects floats/garbage."""
    if value is None:
        return None
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


# ----------------------------------------------------------------------------
# Phase 4: persistent incremental consumption (replay perf, byte-exact)
# ----------------------------------------------------------------------------
#
# A fresh ``MboOrderTracker().process(window, trades)`` rebuilds the entire order
# book from empty on EVERY replay step — O(steps x window), the dominant cost left
# after the Phase 2 parse caches. ``RollingConsumeState`` keeps ONE book + ONE
# depleting trade index across steps, feeds only newly-appended events, and evicts
# orders/trades whose event scrolled out of the bounded tail. ``step()`` returns
# the SAME consumed set as a fresh ``process()`` over that step's window. Proof +
# the trade-depletion equivalence are gated by tests/test_incremental_tracker.py
# and the replay golden gate. Design: docs/perf/replay-incremental-tracker-design.md.


def _new_suffix(
    items: list[Any] | tuple[Any, ...],
    ts_of: Any,
    last_ts: int | None,
    n_at_last: int,
) -> tuple[list[Any], int | None, int]:
    """Return ``(new_items, updated_last_ts, updated_n_at_last)`` for a ts-sorted
    sliding window. ``new_items`` = everything past the high-water ``(last_ts,
    n_at_last)``, where ``n_at_last`` counts items already taken AT exactly
    ``last_ts`` so ts-ties at the boundary aren't double-fed. O(log n + new).

    Safe because the newest ts sits at the window END (never dropped by the
    front-sliding tail), so its already-taken count stays valid step to step.
    """
    if not items:
        return [], last_ts, n_at_last
    if last_ts is None:
        new = list(items)
    else:
        start = bisect.bisect_left(items, last_ts, key=ts_of)
        new = list(items[start + n_at_last :])
    max_ts = ts_of(items[-1])
    lo = bisect.bisect_left(items, max_ts, key=ts_of)
    return new, max_ts, len(items) - lo


@dataclass(slots=True)
class RollingConsumeState:
    """Persistent state for incremental, byte-exact iceberg consumption."""

    tracker: MboOrderTracker
    trade_index: _TradeIndex
    rolling: list[ConsumedOrder] = field(default_factory=list)
    last_mbo_ts: int | None = None
    n_mbo_at_last: int = 0
    last_trade_ts: int | None = None
    n_trade_at_last: int = 0

    def step(
        self,
        mbo_events: tuple[MboOrderEvent, ...] | list[MboOrderEvent],
        trades: list[TradeTick],
    ) -> tuple[ConsumedOrder, ...]:
        """Incremental equivalent of ``MboOrderTracker().process(mbo_events, trades)``.

        ``mbo_events`` / ``trades`` are the CURRENT bounded-tail windows (ascending,
        exactly as the fresh path receives them). Returns the consumed orders whose
        ADD is still inside the MBO window — byte-identical to a fresh per-window
        ``process()`` over the same window.
        """
        # Window-back edges. The MBO order book is keyed by the (ts, seq) of the
        # oldest in-window event so adds that share a tail timestamp are split
        # exactly as the fresh path's sorted window splits them. Trades have no
        # sequence, so the trade index uses the ts edge (trades only ever match by
        # price + time tolerance, never by tie-break).
        mbo_back_ts = mbo_events[0].timestamp_ns if mbo_events else None
        mbo_back_seq = (mbo_events[0].sequence or 0) if mbo_events else 0
        trade_back = trades[0].timestamp_ns if trades else None

        new_mbo, self.last_mbo_ts, self.n_mbo_at_last = _new_suffix(
            mbo_events, lambda e: e.timestamp_ns, self.last_mbo_ts, self.n_mbo_at_last
        )
        new_trades, self.last_trade_ts, self.n_trade_at_last = _new_suffix(
            trades, lambda t: t.timestamp_ns or 0, self.last_trade_ts, self.n_trade_at_last
        )

        # Replicate the fresh path's cold start: forget orders/trades whose event
        # scrolled out of the bounded byte-window.
        if mbo_back_ts is not None:
            self.tracker.evict_before(mbo_back_ts, mbo_back_seq)
        if trade_back is not None:
            self.trade_index.evict_before(trade_back)
        self.trade_index.extend(new_trades)

        newly = self.tracker.consume_events(new_mbo, self.trade_index)
        if newly:
            self.rolling.extend(newly)
        # A consumption is in the fresh window output iff its ADD is in-window,
        # compared on the same (ts, seq) edge used for order eviction.
        if mbo_back_ts is not None and self.rolling:
            edge = (mbo_back_ts, mbo_back_seq)
            self.rolling = [c for c in self.rolling if (c.add_ts_ns, c.add_seq) >= edge]
        return tuple(self.rolling)


def new_rolling_consume_state(
    *, match_tolerance_ms: int = DEFAULT_MATCH_TOLERANCE_MS
) -> RollingConsumeState:
    """Build empty Phase 4 incremental-consumption state (one per replay session)."""
    return RollingConsumeState(
        tracker=MboOrderTracker(match_tolerance_ms=match_tolerance_ms),
        trade_index=_TradeIndex([], tick_size=TICK_SIZE),
    )
