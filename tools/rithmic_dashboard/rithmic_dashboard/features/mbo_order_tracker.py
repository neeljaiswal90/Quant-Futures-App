"""Bounded-tail MBO lifecycle tracking for iceberg-like refill detection."""

from __future__ import annotations

import json
import math
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from rithmic_dashboard.models import DataWarning, MboOrderEvent, TradeTick

DEFAULT_MAX_ACTIVE_ORDERS = 50_000
DEFAULT_ORDER_TTL_SECONDS = 120
DEFAULT_MATCH_TOLERANCE_MS = 50
TICK_SIZE = 0.25


@dataclass(frozen=True)
class MboTailResult:
    """Bounded MBO tail parse result."""

    source_path: Path
    events: tuple[MboOrderEvent, ...]
    tail_bytes: int
    tail_span_minutes: float


@dataclass(frozen=True)
class ConsumedOrder:
    """An MBO order disappearance confirmed by matching OBS trade volume."""

    order_id: str
    side: Literal["B", "A"]
    price: float
    visible_size: int
    consumed_qty: int
    aggressor_side: Literal["buy", "sell"]
    add_ts_ns: int
    consume_ts_ns: int


@dataclass(slots=True)
class _TrackedOrder:
    order_id: str
    side: Literal["B", "A"]
    price: float
    size: int
    add_ts_ns: int
    last_ts_ns: int


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
    ) -> None:
        self.match_tolerance_ns = match_tolerance_ms * 1_000_000
        self.max_active_orders = max_active_orders
        self.order_ttl_ns = order_ttl_seconds * 1_000_000_000
        self.tick_size = tick_size
        self.active: dict[str, _TrackedOrder] = {}
        self._order_queue: deque[tuple[int, str]] = deque()

    def process(
        self,
        mbo_events: tuple[MboOrderEvent, ...] | list[MboOrderEvent],
        trades: list[TradeTick],
    ) -> tuple[ConsumedOrder, ...]:
        """Process MBO events and return OBS-confirmed consumed orders."""

        consumed: list[ConsumedOrder] = []
        trade_index = _TradeIndex(trades, tick_size=self.tick_size)
        for event in sorted(mbo_events, key=lambda item: (item.timestamp_ns, item.sequence or 0)):
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

    def _add(self, event: MboOrderEvent) -> None:
        if event.size <= 0:
            return
        order = _TrackedOrder(
            order_id=event.order_id,
            side=event.side,
            price=event.price,
            size=event.size,
            add_ts_ns=event.timestamp_ns,
            last_ts_ns=event.timestamp_ns,
        )
        self.active[event.order_id] = order
        self._order_queue.append((event.timestamp_ns, event.order_id))

    def _modify(self, event: MboOrderEvent) -> None:
        order = self.active.get(event.order_id)
        if order is None:
            self._add(event)
            return
        if event.price > 0 and math.isfinite(event.price):
            order.price = event.price
        if event.size > 0:
            order.size = event.size
        order.last_ts_ns = event.timestamp_ns
        self._order_queue.append((event.timestamp_ns, event.order_id))

    def _remove(self, event: MboOrderEvent, trade_index: _TradeIndex) -> ConsumedOrder | None:
        order = self.active.pop(event.order_id, None)
        if order is None:
            return None
        expected_aggressor: Literal["buy", "sell"] = "sell" if order.side == "B" else "buy"
        matched_qty = trade_index.consume_matching_volume(
            price=order.price,
            timestamp_ns=event.timestamp_ns,
            aggressor_side=expected_aggressor,
            tolerance_ns=self.match_tolerance_ns,
            max_qty=max(order.size, event.size, 1),
        )
        if matched_qty <= 0:
            return None
        return ConsumedOrder(
            order_id=order.order_id,
            side=order.side,
            price=order.price,
            visible_size=max(order.size, event.size, 1),
            consumed_qty=matched_qty,
            aggressor_side=expected_aggressor,
            add_ts_ns=order.add_ts_ns,
            consume_ts_ns=event.timestamp_ns,
        )

    def _evict_stale(self, now_ns: int) -> None:
        cutoff = now_ns - self.order_ttl_ns
        while self._order_queue and self._order_queue[0][0] < cutoff:
            _, order_id = self._order_queue.popleft()
            order = self.active.get(order_id)
            if order is not None and order.last_ts_ns < cutoff:
                self.active.pop(order_id, None)

    def _evict_overflow(self) -> None:
        while len(self.active) > self.max_active_orders and self._order_queue:
            queued_ts, order_id = self._order_queue.popleft()
            order = self.active.get(order_id)
            if order is not None and order.last_ts_ns == queued_ts:
                self.active.pop(order_id, None)


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
        try:
            rec = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(rec, dict):
            continue
        event = _mbo_event(rec)
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
