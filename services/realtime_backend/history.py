"""Compact Bookmap-style session history for REST reconnect backfill.

The realtime WS path should stay live-only. This module keeps a bounded, compact
history of price ticks and depth snapshots so a browser reload can hydrate the
decision map without replaying thousands of frames through the websocket queue.
"""

from __future__ import annotations

import json
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

from contracts.realtime.events import DepthPayload, OrderflowStats

from realtime_backend.price_ticks import LatestPriceTick

MAX_PRICE_TICKS = 100_000
MAX_DEPTH_COLUMNS = 12_000
MAX_HISTORY_AGE_NS = 8 * 60 * 60 * 1_000_000_000
MAX_BACKFILL_RESPONSE_BYTES = 100 * 1024 * 1024

PriceKey = tuple[int, float, int]
DepthKey = tuple[int, tuple[object, ...]]


@dataclass(slots=True)
class PriceTickRecord:
    """Compact execution tick retained for chart/trade-bubble hydration."""

    seq: int
    ts_ns: int
    price: float
    bid: float | None
    ask: float | None
    volume: int
    aggressor_side: str
    orderflow_quality: str | None
    last_trade_delta: int | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "seq": self.seq,
            "ts_ns": self.ts_ns,
            "price": self.price,
            "bid": self.bid,
            "ask": self.ask,
            "volume": self.volume,
            "aggressor_side": self.aggressor_side,
            "orderflow_quality": self.orderflow_quality,
            "last_trade_delta": self.last_trade_delta,
        }


@dataclass(slots=True)
class DepthColumnRecord:
    """Compact full visible-window depth snapshot for heatmap hydration."""

    seq: int
    ts_ns: int
    mid: float | None
    quality: str
    n_ticks: int
    bid_levels: tuple[tuple[float, int], ...]
    ask_levels: tuple[tuple[float, int], ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "seq": self.seq,
            "family": "depth",
            "ts_ns": self.ts_ns,
            "mid": self.mid,
            "quality": self.quality,
            "n_ticks": self.n_ticks,
            "bid_levels": [
                {"price": price, "size": size} for price, size in self.bid_levels
            ],
            "ask_levels": [
                {"price": price, "size": size} for price, size in self.ask_levels
            ],
        }


class BookmapHistory:
    """Bounded session-history cache used by ``GET /api/bookmap-backfill``."""

    def __init__(
        self,
        *,
        max_price_ticks: int = MAX_PRICE_TICKS,
        max_depth_columns: int = MAX_DEPTH_COLUMNS,
        max_age_ns: int = MAX_HISTORY_AGE_NS,
        max_response_bytes: int = MAX_BACKFILL_RESPONSE_BYTES,
    ) -> None:
        self.max_price_ticks = max_price_ticks
        self.max_depth_columns = max_depth_columns
        self.max_age_ns = max_age_ns
        self.max_response_bytes = max_response_bytes
        self._price_ticks: OrderedDict[PriceKey, PriceTickRecord] = OrderedDict()
        self._depth: OrderedDict[DepthKey, DepthColumnRecord] = OrderedDict()

    def upsert_price_tick(
        self,
        *,
        seq: int,
        tick: LatestPriceTick,
        orderflow: OrderflowStats | None,
    ) -> None:
        """Insert or enrich one execution tick by live trade identity."""

        key = tick.dedupe_key
        existing = self._price_ticks.get(key)
        orderflow_quality = _orderflow_quality(orderflow)
        last_trade_delta = _last_trade_delta(orderflow)
        aggressor_side = _aggressor_side(tick, orderflow)
        if existing is not None:
            self._price_ticks[key] = PriceTickRecord(
                seq=seq,
                ts_ns=tick.trade_ts_ns,
                price=tick.price,
                bid=tick.bid if tick.bid is not None else existing.bid,
                ask=tick.ask if tick.ask is not None else existing.ask,
                volume=tick.volume,
                aggressor_side=(
                    aggressor_side
                    if aggressor_side != "unknown"
                    else existing.aggressor_side
                ),
                orderflow_quality=orderflow_quality or existing.orderflow_quality,
                last_trade_delta=(
                    last_trade_delta
                    if last_trade_delta is not None
                    else existing.last_trade_delta
                ),
            )
        else:
            self._price_ticks[key] = PriceTickRecord(
                seq=seq,
                ts_ns=tick.trade_ts_ns,
                price=tick.price,
                bid=tick.bid,
                ask=tick.ask,
                volume=tick.volume,
                aggressor_side=aggressor_side,
                orderflow_quality=orderflow_quality,
                last_trade_delta=last_trade_delta,
            )
        self._trim_price_ticks(tick.trade_ts_ns)

    def append_depth(
        self,
        *,
        seq: int,
        payload: DepthPayload,
        dedupe_key: tuple[object, ...],
    ) -> None:
        """Append one emitted visible-window depth snapshot."""

        key = (payload.ts_ns, dedupe_key)
        self._depth[key] = DepthColumnRecord(
            seq=seq,
            ts_ns=payload.ts_ns,
            mid=payload.mid,
            quality=payload.quality,
            n_ticks=payload.n_ticks,
            bid_levels=tuple((level.price, level.size) for level in payload.bid_levels),
            ask_levels=tuple((level.price, level.size) for level in payload.ask_levels),
        )
        self._trim_depth(payload.ts_ns)

    def to_response(
        self,
        *,
        generated_at_ns: int,
        through_seq: int,
        trading_date: str | None,
        session: str | None,
    ) -> dict[str, Any]:
        """Return a deterministic compact JSON-serializable backfill payload."""

        price_rows, depth_rows = self._rows_under_response_budget()
        limits = {
            "price_ticks_max": self.max_price_ticks,
            "depth_columns_max": self.max_depth_columns,
            "effective_price_ticks_max": len(price_rows),
            "effective_depth_columns_max": len(depth_rows),
            "max_age_seconds": self.max_age_ns // 1_000_000_000,
            "max_response_bytes": self.max_response_bytes,
            "estimated_response_bytes": 0,
        }
        response = {
            "schema_version": 1,
            "trading_date": trading_date,
            "session": session,
            "generated_at_ns": generated_at_ns,
            "through_seq": through_seq,
            "limits": limits,
            "price_ticks": price_rows,
            "depth": depth_rows,
        }
        estimate = 0
        while True:
            next_estimate = _encoded_len(response)
            if next_estimate == estimate:
                break
            estimate = next_estimate
            limits["estimated_response_bytes"] = estimate
        return {
            **response,
            "limits": limits,
        }

    def _rows_under_response_budget(
        self,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Return newest rows whose serialized response stays under the byte cap."""

        price_rows = [record.to_dict() for record in self._price_ticks.values()]
        depth_rows = [record.to_dict() for record in self._depth.values()]
        if self.max_response_bytes <= 0:
            return [], []

        selected_price: list[dict[str, Any]] = []
        selected_depth: list[dict[str, Any]] = []
        row_budget = max(0, self.max_response_bytes - 512)
        used = 0

        entries: list[tuple[int, int, str, int, dict[str, Any]]] = []
        for row in price_rows:
            entries.append((
                int(row["ts_ns"]),
                int(row["seq"]),
                "price",
                _encoded_len(row) + 2,
                row,
            ))
        for row in depth_rows:
            entries.append((
                int(row["ts_ns"]),
                int(row["seq"]),
                "depth",
                _encoded_len(row) + 2,
                row,
            ))

        for _ts_ns, _seq, kind, size, row in sorted(
            entries,
            key=lambda entry: (entry[0], entry[1], entry[2]),
            reverse=True,
        ):
            if used + size > row_budget:
                continue
            used += size
            if kind == "price":
                selected_price.append(row)
            else:
                selected_depth.append(row)

        selected_price.sort(key=lambda row: (int(row["ts_ns"]), int(row["seq"])))
        selected_depth.sort(key=lambda row: (int(row["ts_ns"]), int(row["seq"])))
        return selected_price, selected_depth

    def _trim_price_ticks(self, latest_ts_ns: int) -> None:
        cutoff = latest_ts_ns - self.max_age_ns
        while self._price_ticks and (
            len(self._price_ticks) > self.max_price_ticks
            or next(iter(self._price_ticks.values())).ts_ns < cutoff
        ):
            self._price_ticks.popitem(last=False)

    def _trim_depth(self, latest_ts_ns: int) -> None:
        cutoff = latest_ts_ns - self.max_age_ns
        while self._depth and (
            len(self._depth) > self.max_depth_columns
            or next(iter(self._depth.values())).ts_ns < cutoff
        ):
            self._depth.popitem(last=False)


def _orderflow_quality(orderflow: OrderflowStats | None) -> str | None:
    if orderflow is None:
        return None
    return str(orderflow.quality)


def _last_trade_delta(orderflow: OrderflowStats | None) -> int | None:
    if orderflow is None:
        return None
    return orderflow.last_trade_delta


def _aggressor_side(
    tick: LatestPriceTick,
    orderflow: OrderflowStats | None,
) -> str:
    if orderflow is not None and orderflow.last_trade_aggressor in {"buy", "sell"}:
        return str(orderflow.last_trade_aggressor)
    side = tick.aggressor_side.lower()
    if side in {"buy", "sell"}:
        return side
    return "unknown"


def _encoded_len(value: object) -> int:
    return len(
        json.dumps(
            value,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
    )


__all__ = [
    "BookmapHistory",
    "DepthColumnRecord",
    "MAX_BACKFILL_RESPONSE_BYTES",
    "MAX_DEPTH_COLUMNS",
    "MAX_HISTORY_AGE_NS",
    "MAX_PRICE_TICKS",
    "PriceTickRecord",
]
