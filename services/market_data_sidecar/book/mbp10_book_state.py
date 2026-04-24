"""
mbp10_book_state.py — Databento L2 book state from MBP-10 records.

v3.2.1 §2.1, DATA-11 rebuild. Under the final v3.2.1 architecture
Databento L2 (MBP-10 schema) is canonical for top-of-book, depth,
and all L2-identifiable state. The legacy per-order kernel in
orderbook_kernel.py is NOT used on the Databento path anymore.

Databento MBP-10 records carry the FULL top-10 book on both sides
with every event — they are effectively level snapshots keyed by the
triggering action. That makes the consumer simple: store the latest
levels, expose top-of-book + depth, handle the R/clear action by
dropping state so carried-over levels cannot be mistaken for a live
book.

Public surface is deliberately a subset of the legacy BookSnapshot
shape so OFI and /lob/snapshot consumers don't need a rewrite:
  - best_bid(), best_ask(), best_bid_qty(), best_ask_qty()
  - mid(), spread()
  - snapshot(depth) → Mbp10Snapshot with bids/asks lists

Authority semantics (owned by DATA-12 in the next slice):
  - apply() returns an ApplyResult telling callers whether the book
    is currently authoritative. This module publishes the observed
    state; the authoritative-book FSM (DATA-12) consults
    gap_detected, last_clear_ts_ns, and the applied-count to decide
    when quote_authoritative can be restored post-reset. Here we
    expose the primitives; the FSM will consume them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


# Action codes — MBP-10 uses the same letters as MBO at the aggregate
# level. A/M/C are additive updates that re-emit the current levels;
# T is a trade (levels updated to reflect consumed resting size); R
# is a clear of the whole book (reset boundary).
_ACTION_APPLY = frozenset({"A", "M", "C", "T"})
_ACTION_CLEAR = "R"


@dataclass(frozen=True)
class Mbp10Snapshot:
    """Point-in-time top-N book snapshot from MBP-10 state. Level
    tuples carry integer prices/sizes from the feed's native scaling
    — display conversion is the consumer's responsibility, matching
    the legacy BookSnapshot convention for drop-in interop."""
    bids: list[tuple[int, int]]  # [(price, qty), ...] descending
    asks: list[tuple[int, int]]  # [(price, qty), ...] ascending
    instrument_id: Optional[int]
    ts_recv_ns: Optional[int]

    def best_bid(self) -> Optional[int]:
        return self.bids[0][0] if self.bids else None

    def best_ask(self) -> Optional[int]:
        return self.asks[0][0] if self.asks else None

    def best_bid_qty(self) -> Optional[int]:
        return self.bids[0][1] if self.bids else None

    def best_ask_qty(self) -> Optional[int]:
        return self.asks[0][1] if self.asks else None

    def mid(self) -> Optional[float]:
        b, a = self.best_bid(), self.best_ask()
        if b is None or a is None:
            return None
        return (b + a) / 2.0

    def spread(self) -> Optional[int]:
        b, a = self.best_bid(), self.best_ask()
        if b is None or a is None:
            return None
        return a - b


@dataclass
class ApplyResult:
    """Per-apply summary used by the DATA-12 reconvergence FSM."""
    applied: bool
    action: Optional[str]
    cleared: bool
    levels_present: bool
    top_of_book_populated: bool
    ts_recv_ns: Optional[int]


def _coerce_int(x: Any) -> Optional[int]:
    if x is None:
        return None
    if isinstance(x, bool):
        # bool is an int subclass; refuse it here — feeds should never
        # hand us bool price/size fields.
        return None
    if isinstance(x, int):
        return x
    if isinstance(x, float):
        if x != x or x in (float("inf"), float("-inf")):  # NaN/inf guard
            return None
        return int(x)
    return None


def _extract_levels(payload: Any, max_depth: int = 10) -> tuple[
    list[tuple[int, int]], list[tuple[int, int]],
]:
    """Pull the bid/ask level arrays off a Databento MBP-10 payload.

    Databento's Mbp10Msg exposes a `levels` attribute — a list of
    ``BidAskPair`` objects, each with ``bid_px``, ``ask_px``, ``bid_sz``,
    ``ask_sz`` (and count fields we ignore here). Synthetic tests
    pass a SimpleNamespace-shaped mock; we support both.

    Level ordering:
      - bids descending by price (best bid first)
      - asks ascending by price (best ask first)

    Price/size 0 (or None) on a level means "no resting size there" —
    we drop those tuples rather than keeping zero-qty rows in the
    snapshot. Drop-in compatibility with BookSnapshot consumers that
    index [0] without a zero-qty check.
    """
    levels_attr = getattr(payload, "levels", None)
    if not levels_attr:
        return [], []
    bids: list[tuple[int, int]] = []
    asks: list[tuple[int, int]] = []
    for i, lvl in enumerate(levels_attr):
        if i >= max_depth:
            break
        if lvl is None:
            continue
        bp = _coerce_int(getattr(lvl, "bid_px", None))
        bs = _coerce_int(getattr(lvl, "bid_sz", None))
        ap = _coerce_int(getattr(lvl, "ask_px", None))
        as_ = _coerce_int(getattr(lvl, "ask_sz", None))
        if bp is not None and bs is not None and bs > 0:
            bids.append((bp, bs))
        if ap is not None and as_ is not None and as_ > 0:
            asks.append((ap, as_))
    # Guard the ordering contract even if the feed hands us rows out
    # of order — MBP-10 is supposed to be sorted, but defensive sort
    # is cheap at depth=10 and prevents a subtle top-of-book flip.
    bids.sort(key=lambda t: t[0], reverse=True)
    asks.sort(key=lambda t: t[0])
    return bids, asks


class Mbp10BookState:
    """Per-instrument L2 book state.

    One instance per instrument_id. Fed by ``apply(record_payload)``
    where ``record_payload`` is the raw Databento Mbp10Msg attached
    to a ProviderRecord. Callers that already have a ProviderRecord
    can use the helper ``apply_provider_record`` which reads the
    payload for them.
    """

    def __init__(self, *, instrument_id: Optional[int] = None) -> None:
        self._instrument_id = instrument_id
        self._bids: list[tuple[int, int]] = []
        self._asks: list[tuple[int, int]] = []
        self._last_ts_recv_ns: Optional[int] = None
        self._last_action: Optional[str] = None
        self._last_clear_ts_ns: Optional[int] = None
        self._apply_count_since_clear: int = 0
        self._apply_count_total: int = 0

    # ─── apply ─────────────────────────────────────────────────────

    def apply(
        self,
        payload: Any,
        *,
        ts_recv_ns: Optional[int] = None,
    ) -> ApplyResult:
        """Ingest one MBP-10 record payload.

        Contract:
          - A/M/C/T actions: snapshot the levels carried on the record.
          - R action: clear the book and record the reset boundary.
          - Unknown / missing action: no-op (conservative; feed glitches
            cannot silently promote a stale book to authoritative).
        """
        action_raw = getattr(payload, "action", None)
        action: Optional[str] = None
        if isinstance(action_raw, str) and action_raw:
            action = action_raw.upper()[:1]
        self._last_ts_recv_ns = ts_recv_ns

        if action == _ACTION_CLEAR:
            self._bids = []
            self._asks = []
            self._last_clear_ts_ns = ts_recv_ns
            self._apply_count_since_clear = 0
            self._last_action = action
            self._apply_count_total += 1
            return ApplyResult(
                applied=True, action=action, cleared=True,
                levels_present=False, top_of_book_populated=False,
                ts_recv_ns=ts_recv_ns,
            )

        if action in _ACTION_APPLY:
            bids, asks = _extract_levels(payload)
            self._bids = bids
            self._asks = asks
            self._last_action = action
            self._apply_count_since_clear += 1
            self._apply_count_total += 1
            return ApplyResult(
                applied=True, action=action, cleared=False,
                levels_present=bool(bids) or bool(asks),
                top_of_book_populated=bool(bids) and bool(asks),
                ts_recv_ns=ts_recv_ns,
            )

        # Unknown action — ignore. Do not touch state. Do not count
        # toward apply_count_since_clear; the FSM relies on that
        # counter being driven by real level events only.
        return ApplyResult(
            applied=False, action=action, cleared=False,
            levels_present=bool(self._bids) or bool(self._asks),
            top_of_book_populated=bool(self._bids) and bool(self._asks),
            ts_recv_ns=ts_recv_ns,
        )

    def apply_provider_record(self, rec: Any) -> ApplyResult:
        """Convenience: take a ProviderRecord with kind='mbp10', pull
        payload + ts_recv_ns off it."""
        payload = getattr(rec, "payload", None)
        ts_recv_ns = getattr(rec, "ts_recv_ns", None)
        if payload is None:
            return ApplyResult(
                applied=False, action=None, cleared=False,
                levels_present=bool(self._bids) or bool(self._asks),
                top_of_book_populated=bool(self._bids) and bool(self._asks),
                ts_recv_ns=ts_recv_ns,
            )
        return self.apply(payload, ts_recv_ns=ts_recv_ns)

    # ─── read accessors ────────────────────────────────────────────

    def snapshot(self, depth: int = 10) -> Mbp10Snapshot:
        if depth <= 0:
            return Mbp10Snapshot(
                bids=[], asks=[],
                instrument_id=self._instrument_id,
                ts_recv_ns=self._last_ts_recv_ns,
            )
        return Mbp10Snapshot(
            bids=list(self._bids[:depth]),
            asks=list(self._asks[:depth]),
            instrument_id=self._instrument_id,
            ts_recv_ns=self._last_ts_recv_ns,
        )

    # FSM inputs (consumed by DATA-12 in the next slice).
    @property
    def last_clear_ts_ns(self) -> Optional[int]:
        return self._last_clear_ts_ns

    @property
    def apply_count_since_clear(self) -> int:
        return self._apply_count_since_clear

    @property
    def apply_count_total(self) -> int:
        return self._apply_count_total

    @property
    def last_ts_recv_ns(self) -> Optional[int]:
        return self._last_ts_recv_ns


@dataclass
class Mbp10BookRegistry:
    """One Mbp10BookState per instrument_id.

    Mirrors DatabentoKernelRegistry's shape so the sink dispatcher
    can swap targets without learning a new API.
    """
    _states: dict[int, Mbp10BookState] = field(default_factory=dict)

    def get_or_create(self, instrument_id: int) -> Mbp10BookState:
        st = self._states.get(instrument_id)
        if st is None:
            st = Mbp10BookState(instrument_id=instrument_id)
            self._states[instrument_id] = st
        return st

    def get(self, instrument_id: int) -> Optional[Mbp10BookState]:
        return self._states.get(instrument_id)

    def apply_provider_record(self, rec: Any) -> Optional[ApplyResult]:
        iid = getattr(rec, "instrument_id", None)
        if not isinstance(iid, int):
            return None
        st = self.get_or_create(iid)
        return st.apply_provider_record(rec)

    def clear_all(self) -> None:
        self._states.clear()
