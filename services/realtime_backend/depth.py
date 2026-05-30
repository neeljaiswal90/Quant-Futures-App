"""Depth payload mapping and quality rules for RA-081."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

from contracts.realtime.events import DepthLevel, DepthPayload, DepthQuality
from rithmic_dashboard.features.depth_book import DepthSnapshot

from realtime_backend.price_ticks import LatestPriceTick

MidSource = Literal["l1", "trade", "none"]


@dataclass(frozen=True)
class DepthMid:
    """Mid/price context used to center a depth snapshot."""

    mid: float | None
    source: MidSource
    ts_ns: int | None


def resolve_depth_mid(tick: LatestPriceTick | None) -> DepthMid:
    """Prefer bid/ask mid; fall back to latest trade price."""

    if tick is None:
        return DepthMid(mid=None, source="none", ts_ns=None)
    bid = tick.bid
    ask = tick.ask
    if _usable_price(bid) and _usable_price(ask):
        assert bid is not None and ask is not None
        return DepthMid(
            mid=(bid + ask) / 2.0,
            source="l1",
            ts_ns=tick.trade_ts_ns,
        )
    return DepthMid(mid=tick.price, source="trade", ts_ns=tick.trade_ts_ns)


def classify_depth_quality(
    *,
    has_book: bool,
    book_ts_ns: int | None,
    mid: DepthMid,
    now_ns: int,
    staleness_threshold_seconds: float,
) -> DepthQuality:
    """Classify depth provenance for the frozen ``DepthPayload.quality`` enum."""

    if not has_book or book_ts_ns is None or mid.mid is None or mid.source == "none":
        return "unavailable"
    threshold_ns = int(staleness_threshold_seconds * 1_000_000_000)
    if threshold_ns >= 0:
        if now_ns - book_ts_ns > threshold_ns:
            return "stale_l1"
        if mid.ts_ns is not None and now_ns - mid.ts_ns > threshold_ns:
            return "stale_l1"
    if mid.source == "l1":
        return "live"
    return "inferred"


def build_depth_payload(
    snapshot: DepthSnapshot,
    *,
    quality: DepthQuality,
    ts_ns: int | None,
) -> DepthPayload | None:
    """Map a feature ``DepthSnapshot`` into the bounded wire payload."""

    if ts_ns is None:
        return None
    return DepthPayload(
        ts_ns=ts_ns,
        mid=snapshot.mid,
        bid_levels=[
            DepthLevel(price=level.price, size=level.size) for level in snapshot.bid_levels
        ],
        ask_levels=[
            DepthLevel(price=level.price, size=level.size) for level in snapshot.ask_levels
        ],
        n_ticks=snapshot.n_ticks,
        quality=quality,
    )


def _usable_price(value: float | None) -> bool:
    return value is not None and math.isfinite(value) and value > 0


__all__ = [
    "DepthMid",
    "MidSource",
    "build_depth_payload",
    "classify_depth_quality",
    "resolve_depth_mid",
]
