"""Orderflow context builder for compute-path price ticks.

The wire contract keeps fast-path ticks lean (`orderflow = null`) and attaches
the richer detector-derived orderflow context only when a full compute pass has
fresh `LiveSignals`. The values here are inference-derived from the normalized
OBS/L1 stack, not exchange-provided fill/trade action truth.
"""

from __future__ import annotations

from typing import Any, cast

from contracts.realtime.events import (
    AggressorWindowStats,
    CvdStats,
    FlowDirection,
    FootprintSide,
    FootprintStats,
    InferredDirection,
    OrderflowQuality,
    OrderflowStats,
    TradeAggressor,
    VDeltaStats,
)
from rithmic_dashboard.models import LiveSignals

from realtime_backend.price_ticks import LatestPriceTick


def build_orderflow_stats(
    signals: LiveSignals | None,
    tick: LatestPriceTick | None,
) -> OrderflowStats | None:
    """Convert detector `LiveSignals` into optional price-tick orderflow.

    Returns `None` when no compute signals exist; callers use that for the
    fast-path/null contract.
    """

    if signals is None:
        return None
    aggressor = _trade_aggressor(tick)
    return OrderflowStats(
        quality=_quality(tick, aggressor),
        last_trade_aggressor=aggressor,
        last_trade_delta=_trade_delta(tick, aggressor),
        cvd=_cvd(getattr(signals, "cvd", None)),
        aggressor_windows=[
            _aggressor_window(window)
            for window in (getattr(signals, "aggressor_windows", None) or [])
        ],
        v_delta=_v_delta(getattr(signals, "v_delta", None)),
        footprint=_footprint(getattr(signals, "footprint_bar", None)),
    )


def _quality(tick: LatestPriceTick | None, aggressor: TradeAggressor) -> OrderflowQuality:
    if tick is None:
        return "unavailable"
    has_l1 = tick.bid is not None or tick.ask is not None
    if aggressor != "unknown" and has_l1:
        return "high"
    if aggressor != "unknown":
        return "inferred"
    if has_l1:
        return "stale_l1"
    return "unavailable"


def _trade_aggressor(tick: LatestPriceTick | None) -> TradeAggressor:
    if tick is None:
        return "unknown"
    side = str(getattr(tick, "aggressor_side", "unknown")).lower()
    if side in {"buy", "sell"}:
        return cast(TradeAggressor, side)
    return "unknown"


def _trade_delta(tick: LatestPriceTick | None, aggressor: TradeAggressor) -> int | None:
    if tick is None or aggressor == "unknown":
        return None
    sign = 1 if aggressor == "buy" else -1
    return sign * int(tick.volume)


def _flow_direction(value: Any) -> FlowDirection:
    text = str(value or "neutral").lower()
    if text in {"bullish", "bearish", "neutral"}:
        return cast(FlowDirection, text)
    return "neutral"


def _inferred_direction(value: Any) -> InferredDirection:
    text = str(value or "unknown").lower()
    if text in {"bullish", "bearish", "neutral", "unknown"}:
        return cast(InferredDirection, text)
    return "unknown"


def _footprint_side(value: Any) -> FootprintSide:
    text = str(value or "unknown").lower()
    if text in {"buy", "sell", "none", "unknown"}:
        return cast(FootprintSide, text)
    return "unknown"


def _int_attr(obj: Any, name: str, default: int = 0) -> int:
    try:
        return int(getattr(obj, name))
    except (TypeError, ValueError):
        return default


def _float_attr(obj: Any, name: str) -> float | None:
    value = getattr(obj, name, None)
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _cvd(cvd: Any) -> CvdStats | None:
    if cvd is None:
        return None
    return CvdStats(
        session_cvd=_int_attr(cvd, "session_cvd"),
        last_60m_cvd=_int_attr(cvd, "last_60m_cvd"),
        last_15m_cvd=_int_attr(cvd, "last_15m_cvd"),
        session_direction=_flow_direction(getattr(cvd, "session_direction", None)),
        last_15m_direction=_flow_direction(getattr(cvd, "last_15m_direction", None)),
        momentum_flip=bool(getattr(cvd, "momentum_flip", False)),
    )


def _aggressor_window(window: Any) -> AggressorWindowStats:
    return AggressorWindowStats(
        window_seconds=_int_attr(window, "window_seconds"),
        label=str(getattr(window, "label", "")),
        lift_ask=_int_attr(window, "lift_ask"),
        hit_bid=_int_attr(window, "hit_bid"),
        net=_int_attr(window, "net"),
        ratio=float(getattr(window, "ratio", 0.0) or 0.0),
        total_volume=_int_attr(window, "total_volume"),
        direction=_inferred_direction(getattr(window, "direction", None)),
    )


def _v_delta(v_delta: Any) -> VDeltaStats | None:
    if v_delta is None:
        return None
    return VDeltaStats(
        window_seconds=_int_attr(v_delta, "window_seconds"),
        value=_int_attr(v_delta, "value"),
        direction=_inferred_direction(getattr(v_delta, "direction", None)),
        sign_flip=bool(getattr(v_delta, "sign_flip", False)),
        prior_direction=_inferred_direction(getattr(v_delta, "prior_direction", None)),
        confirmed_seconds=_int_attr(v_delta, "confirmed_seconds"),
    )


def _footprint(footprint: Any) -> FootprintStats | None:
    if footprint is None:
        return None
    return FootprintStats(
        bar_start_ns=getattr(footprint, "bar_start_ns", None),
        bar_end_ns=getattr(footprint, "bar_end_ns", None),
        stacked_side=_footprint_side(getattr(footprint, "stacked_side", None)),
        stacked_count=_int_attr(footprint, "stacked_count"),
        stacked_low_price=_float_attr(footprint, "stacked_low_price"),
        stacked_high_price=_float_attr(footprint, "stacked_high_price"),
    )


__all__ = ["build_orderflow_stats"]
