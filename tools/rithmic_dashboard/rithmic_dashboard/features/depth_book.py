"""Incremental MBO depth-book aggregation for the v2 heatmap/DOM ladder."""

from __future__ import annotations

import json
import math
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from rithmic_dashboard.features.mbo_order_tracker import (
    DEFAULT_MAX_ACTIVE_ORDERS,
    DEFAULT_ORDER_TTL_SECONDS,
    TICK_SIZE,
    MboTailResult,
    _mbo_event,
    load_mbo_events_from_tail,
)
from rithmic_dashboard.models import MboOrderEvent

BookSide = Literal["B", "A"]
LevelKey = tuple[int, BookSide]

DEFAULT_MAX_TICKS_FROM_MID = 400


@dataclass(frozen=True)
class DepthLevel:
    """Aggregate visible size at one price level and side."""

    price: float
    size: int


@dataclass(frozen=True)
class DepthSnapshot:
    """Bounded full depth snapshot around the current mid/last price."""

    mid: float | None
    n_ticks: int
    bid_levels: tuple[DepthLevel, ...]
    ask_levels: tuple[DepthLevel, ...]


@dataclass(slots=True)
class _DepthOrder:
    order_id: str
    side: BookSide
    bucket: int
    size: int
    last_ts_ns: int


class DepthBook:
    """Long-lived MBO depth book with per-level size aggregates.

    The lifecycle semantics intentionally mirror ``MboOrderTracker``:
    ``A`` inserts/replaces, ``M`` modifies or orphan-adds, and ``C``/``F``/``T``
    remove. The book maintains the missing DOM primitive that the iceberg
    tracker does not need: ``level_size[(price_bucket, side)]``.
    """

    def __init__(
        self,
        *,
        tick_size: float = TICK_SIZE,
        max_active_orders: int = DEFAULT_MAX_ACTIVE_ORDERS,
        order_ttl_seconds: int = DEFAULT_ORDER_TTL_SECONDS,
        max_ticks_from_mid: int | None = DEFAULT_MAX_TICKS_FROM_MID,
    ) -> None:
        self.tick_size = tick_size
        self.max_active_orders = max_active_orders
        self.order_ttl_ns = order_ttl_seconds * 1_000_000_000
        self.max_ticks_from_mid = max_ticks_from_mid
        self.orders: dict[str, _DepthOrder] = {}
        self.level_size: dict[LevelKey, int] = {}
        self._order_queue: deque[tuple[int, str]] = deque()
        self._last_mid_bucket: int | None = None

    @property
    def active_order_count(self) -> int:
        return len(self.orders)

    @property
    def level_count(self) -> int:
        return len(self.level_size)

    @property
    def total_depth(self) -> int:
        return sum(self.level_size.values())

    def apply(self, event: MboOrderEvent) -> None:
        """Apply one normalized MBO event to the live book."""

        self._evict_stale(event.timestamp_ns)
        if event.action in {"A", "M"}:
            self._upsert(event)
        elif event.action in {"C", "F", "T"}:
            self._remove(event.order_id)
        self._evict_overflow()
        self._prune_outside_mid()

    def apply_many(self, events: tuple[MboOrderEvent, ...] | list[MboOrderEvent]) -> None:
        """Apply events in deterministic exchange order."""

        for event in sorted(events, key=lambda item: (item.timestamp_ns, item.sequence or 0)):
            self.apply(event)

    def snapshot(self, *, mid: float | None, n_ticks: int) -> DepthSnapshot:
        """Return a bounded full snapshot around ``mid``.

        ``n_ticks`` caps each side independently. Missing levels are omitted;
        the contract layer can decide whether to render gaps as zeros.
        """

        capped_ticks = max(0, n_ticks)
        mid_bucket = self._bucket(mid)
        if mid_bucket is None or capped_ticks == 0:
            return DepthSnapshot(
                mid=None if mid_bucket is None else mid,
                n_ticks=capped_ticks,
                bid_levels=(),
                ask_levels=(),
            )

        self._last_mid_bucket = mid_bucket
        self._prune_outside_mid()
        bid_low = mid_bucket - capped_ticks + 1
        ask_high = mid_bucket + capped_ticks - 1
        bids = [
            DepthLevel(price=self._price(bucket), size=size)
            for (bucket, side), size in self.level_size.items()
            if side == "B" and bid_low <= bucket <= mid_bucket and size > 0
        ]
        asks = [
            DepthLevel(price=self._price(bucket), size=size)
            for (bucket, side), size in self.level_size.items()
            if side == "A" and mid_bucket <= bucket <= ask_high and size > 0
        ]
        bids.sort(key=lambda level: level.price, reverse=True)
        asks.sort(key=lambda level: level.price)
        return DepthSnapshot(
            mid=mid,
            n_ticks=capped_ticks,
            bid_levels=tuple(bids[:capped_ticks]),
            ask_levels=tuple(asks[:capped_ticks]),
        )

    def _upsert(self, event: MboOrderEvent) -> None:
        if event.size <= 0:
            return
        bucket = self._bucket(event.price)
        if bucket is None:
            return
        old = self.orders.get(event.order_id)
        if old is not None:
            self._subtract_level((old.bucket, old.side), old.size)
        order = _DepthOrder(
            order_id=event.order_id,
            side=event.side,
            bucket=bucket,
            size=event.size,
            last_ts_ns=event.timestamp_ns,
        )
        self.orders[event.order_id] = order
        self._add_level((bucket, event.side), event.size)
        self._order_queue.append((event.timestamp_ns, event.order_id))

    def _remove(self, order_id: str) -> None:
        old = self.orders.pop(order_id, None)
        if old is None:
            return
        self._subtract_level((old.bucket, old.side), old.size)

    def _add_level(self, key: LevelKey, size: int) -> None:
        next_size = self.level_size.get(key, 0) + size
        if next_size > 0:
            self.level_size[key] = next_size
        else:
            self.level_size.pop(key, None)

    def _subtract_level(self, key: LevelKey, size: int) -> None:
        next_size = self.level_size.get(key, 0) - size
        if next_size > 0:
            self.level_size[key] = next_size
        else:
            self.level_size.pop(key, None)

    def _evict_stale(self, now_ns: int) -> None:
        cutoff = now_ns - self.order_ttl_ns
        while self._order_queue and self._order_queue[0][0] < cutoff:
            _, order_id = self._order_queue.popleft()
            order = self.orders.get(order_id)
            if order is not None and order.last_ts_ns < cutoff:
                self._remove(order_id)

    def _evict_overflow(self) -> None:
        while len(self.orders) > self.max_active_orders and self._order_queue:
            queued_ts, order_id = self._order_queue.popleft()
            order = self.orders.get(order_id)
            if order is not None and order.last_ts_ns == queued_ts:
                self._remove(order_id)

    def _prune_outside_mid(self) -> None:
        if self._last_mid_bucket is None or self.max_ticks_from_mid is None:
            return
        low = self._last_mid_bucket - self.max_ticks_from_mid
        high = self._last_mid_bucket + self.max_ticks_from_mid
        for order_id, order in list(self.orders.items()):
            if order.bucket < low or order.bucket > high:
                self._remove(order_id)

    def _bucket(self, price: float | None) -> int | None:
        if price is None or not math.isfinite(price) or price <= 0:
            return None
        return round(price / self.tick_size)

    def _price(self, bucket: int) -> float:
        return round(bucket * self.tick_size, 10)


class DepthBookTailer:
    """Incremental file-offset adapter for a long-lived ``DepthBook``."""

    def __init__(
        self,
        mbo_path: Path,
        *,
        book: DepthBook | None = None,
        seed_tail_bytes: int = 20_000_000,
    ) -> None:
        self.mbo_path = mbo_path
        self.book = book or DepthBook()
        self.seed_tail_bytes = seed_tail_bytes
        self.offset = 0
        self._partial = b""

    def seed_from_tail(self) -> MboTailResult:
        result = load_mbo_events_from_tail(self.mbo_path, tail_bytes=self.seed_tail_bytes)
        self.book.apply_many(result.events)
        self.offset = self.mbo_path.stat().st_size if self.mbo_path.exists() else 0
        self._partial = b""
        return result

    def poll(self) -> int:
        """Read newly appended complete JSONL rows and return applied-event count."""

        if not self.mbo_path.exists():
            return 0
        size = self.mbo_path.stat().st_size
        if size < self.offset:
            self.offset = 0
            self._partial = b""
        with self.mbo_path.open("rb") as f:
            f.seek(self.offset)
            chunk = f.read()
            self.offset = f.tell()
        if not chunk:
            return 0
        data = self._partial + chunk
        lines = data.splitlines(keepends=True)
        if lines and not (lines[-1].endswith(b"\n") or lines[-1].endswith(b"\r")):
            self._partial = lines.pop()
        else:
            self._partial = b""
        events: list[MboOrderEvent] = []
        for raw_line in lines:
            try:
                rec = json.loads(raw_line.decode("utf-8", errors="ignore"))
            except json.JSONDecodeError:
                continue
            if not isinstance(rec, dict):
                continue
            event = _mbo_event(rec)
            if event is not None:
                events.append(event)
        self.book.apply_many(events)
        return len(events)


def build_depth_book_from_tail(
    mbo_path: Path,
    *,
    tail_bytes: int = 20_000_000,
    book: DepthBook | None = None,
) -> tuple[DepthBook, MboTailResult]:
    """Build or update a depth book from the same bounded MBO tail parser."""

    depth_book = book or DepthBook()
    result = load_mbo_events_from_tail(mbo_path, tail_bytes=tail_bytes)
    depth_book.apply_many(result.events)
    return depth_book, result
