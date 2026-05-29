from __future__ import annotations

from pathlib import Path

import pytest

from rithmic_dashboard.models import (
    AbsorptionProxyEvent,
    DeltaDislocationEvent,
    IcebergEvent,
    InstitutionalFlowEvent,
    LiveCvd,
    LiveSignals,
    LiveVwap,
    SweepEvent,
    VolumeVelocity,
)
from rithmic_dashboard.probability_adjuster import (
    ProbabilitySignalContext,
    adjust,
    get_adjustment_factors,
)


def _signals(
    *,
    session_cvd: int = 0,
    last_15m_cvd: int = 0,
    velocity: str = "normal",
    sweeps: tuple[SweepEvent, ...] = (),
    absorption: tuple[AbsorptionProxyEvent, ...] = (),
    dislocations: tuple[DeltaDislocationEvent, ...] = (),
    institutional: tuple[InstitutionalFlowEvent, ...] = (),
    icebergs: tuple[IcebergEvent, ...] = (),
) -> LiveSignals:
    return LiveSignals(
        trading_date="2026-05-22",
        session="globex",
        computed_at_pt="2026-05-21 20:00:00 PT",
        source_path=Path("capture.jsonl"),
        tail_bytes=750_000,
        trade_count=100,
        live_vwap=LiveVwap(60, 29500.0, 10.0, 29510.0, 29490.0),
        cvd=LiveCvd(
            session_cvd=session_cvd,
            last_60m_cvd=session_cvd,
            last_15m_cvd=last_15m_cvd,
            session_direction="bullish" if session_cvd > 500 else "bearish" if session_cvd < -500 else "neutral",
            last_15m_direction="bullish" if last_15m_cvd > 500 else "bearish" if last_15m_cvd < -500 else "neutral",
            momentum_flip=(session_cvd > 500 and last_15m_cvd < -250)
            or (session_cvd < -500 and last_15m_cvd > 250),
        ),
        velocity=VolumeVelocity(30, 2.0, 2.0, 0.5 if velocity == "quiet" else 1.8 if velocity == "active" else 1.0, velocity),  # type: ignore[arg-type]
        sweeps=sweeps,
        absorption_proxies=absorption,
        delta_dislocations=dislocations,
        institutional_flow_events=institutional,
        iceberg_events=icebergs,
    )


def _dislocation(
    *,
    side: str = "long",
    strong: bool = False,
    confidence: str = "high",
) -> DeltaDislocationEvent:
    return DeltaDislocationEvent(
        timestamp_pt="2026-05-22 20:00:00 PT",
        timestamp_ns=1,
        side="short" if side == "short" else "long",
        level_id="vpoc",
        level_text="VPOC",
        level_price=29500.0,
        candle_direction="up" if side == "short" else "down",
        hourly_cvd=-1500 if side == "short" else 1500,
        threshold_used=500.0,
        proximity_pts=1.0,
        confidence="low_tail_span" if confidence == "low_tail_span" else "high",
        rolling_window_start_ts=0,
        tail_span_minutes=42.0 if confidence == "low_tail_span" else 60.0,
        is_strong=strong,
    )


def _institutional_event(
    *,
    event_type: str = "institutional_concentration_detected",
    side: str = "buy",
    net_delta: int = 180,
    timestamp_ns: int = 10,
) -> InstitutionalFlowEvent:
    return InstitutionalFlowEvent(
        timestamp_pt="2026-05-22 20:00:00 PT",
        timestamp_ns=timestamp_ns,
        event_type=(
            "block_trade_at_zone"
            if event_type == "block_trade_at_zone"
            else "institutional_concentration_detected"
        ),
        level_id="vpoc",
        level_text="VPOC",
        level_price=29500.0,
        side="sell" if side == "sell" else "buy",
        trade_count=1 if event_type == "block_trade_at_zone" else 3,
        institutional_volume=abs(net_delta),
        net_delta=net_delta,
        block_count=1 if event_type == "block_trade_at_zone" else 0,
        largest_trade=120 if event_type == "block_trade_at_zone" else 70,
        window_minutes=0 if event_type == "block_trade_at_zone" else 15,
        confidence="high",
        tail_span_minutes=60.0,
        intensity=2.0,
        description="Institutional flow at VPOC",
    )


def _iceberg_event(
    *,
    direction: str = "long",
    timestamp_ns: int = 20,
    refills: int = 5,
    consumed: int = 145,
) -> IcebergEvent:
    side = "bid" if direction == "long" else "ask"
    return IcebergEvent(
        timestamp_pt="2026-05-22 20:00:00 PT",
        timestamp_ns=timestamp_ns,
        event_type="iceberg_detected",
        level_id="vpoc",
        level_text="VPOC",
        level_price=29500.0,
        side=side,
        direction="short" if direction == "short" else "long",
        refill_count=refills,
        total_consumed=consumed,
        median_refill_size=30.0,
        window_seconds=30,
        confidence="high",
        intensity=2.0,
        description="Iceberg-like refill at VPOC",
        metadata={"confirmation_source": "obs_trade_tail"},
    )


def test_cvd_direction_match_boosts_long_probability() -> None:
    context = ProbabilitySignalContext(
        direction="long",
        entry_zone_low=29495.0,
        entry_zone_high=29505.0,
        live_signals=_signals(session_cvd=2_000, last_15m_cvd=1_000),
    )
    low, high = adjust(
        0.45,
        0.55,
        distance_atr=0.1,
        matches_session_drift=True,
        time_into_session_pct=0.2,
        state="ACTIVE",
        signal_context=context,
    )
    assert low == pytest.approx(0.6075)
    assert high == pytest.approx(0.7425)


def test_cvd_direction_oppose_discounts_short_probability() -> None:
    factors = get_adjustment_factors(
        distance_atr=0.1,
        matches_session_drift=True,
        time_into_session_pct=0.2,
        state="ACTIVE",
        signal_context=ProbabilitySignalContext(
            direction="short",
            entry_zone_low=29495.0,
            entry_zone_high=29505.0,
            live_signals=_signals(session_cvd=2_000, last_15m_cvd=1_000),
        ),
    )
    assert any(factor.name == "cvd_direction_oppose" for factor in factors)


def test_cvd_momentum_flip_adds_discount() -> None:
    factors = get_adjustment_factors(
        distance_atr=0.1,
        matches_session_drift=True,
        time_into_session_pct=0.2,
        state="ACTIVE",
        signal_context=ProbabilitySignalContext(
            direction="long",
            entry_zone_low=29495.0,
            entry_zone_high=29505.0,
            live_signals=_signals(session_cvd=2_000, last_15m_cvd=-600),
        ),
    )
    assert any(factor.name == "cvd_momentum_flip" for factor in factors)


def test_sweep_absorption_and_confluence_emit_structural_factors() -> None:
    sweep = SweepEvent("x", 1, "vpoc", "VPOC", 29500.0, "up", 1.2, False)
    absorption = (
        AbsorptionProxyEvent("x", 1, 29500.0, 500, 0, "balanced", "low"),
        AbsorptionProxyEvent("x", 2, 29500.0, 520, 10, "balanced", "low"),
    )
    factors = get_adjustment_factors(
        distance_atr=0.1,
        matches_session_drift=True,
        time_into_session_pct=0.2,
        state="ACTIVE",
        signal_context=ProbabilitySignalContext(
            direction="long",
            entry_zone_low=29495.0,
            entry_zone_high=29505.0,
            live_signals=_signals(sweeps=(sweep,), absorption=absorption),
            confluence_method_count=4,
        ),
    )
    names = {factor.name for factor in factors}
    assert {"recent_sweep_at_entry", "absorption_proxy_at_entry", "multi_method_confluence_bonus"} <= names
    assert any(factor.is_structural for factor in factors)


def test_volume_velocity_factors_fire() -> None:
    quiet = get_adjustment_factors(
        distance_atr=0.1,
        matches_session_drift=True,
        time_into_session_pct=0.2,
        state="ACTIVE",
        signal_context=ProbabilitySignalContext(
            direction="long",
            entry_zone_low=29495.0,
            entry_zone_high=29505.0,
            live_signals=_signals(velocity="quiet"),
        ),
    )
    active = get_adjustment_factors(
        distance_atr=0.1,
        matches_session_drift=True,
        time_into_session_pct=0.2,
        state="ACTIVE",
        signal_context=ProbabilitySignalContext(
            direction="long",
            entry_zone_low=29495.0,
            entry_zone_high=29505.0,
            live_signals=_signals(velocity="active"),
        ),
    )
    assert any(factor.name == "volume_velocity_quiet" for factor in quiet)
    assert any(factor.name == "volume_velocity_active" for factor in active)


def test_delta_dislocation_cofires_with_base_cvd_multiplier() -> None:
    factors = get_adjustment_factors(
        distance_atr=0.1,
        matches_session_drift=True,
        time_into_session_pct=0.2,
        state="ACTIVE",
        signal_context=ProbabilitySignalContext(
            direction="long",
            entry_zone_low=29495.0,
            entry_zone_high=29505.0,
            live_signals=_signals(
                session_cvd=2_000,
                last_15m_cvd=1_000,
                dislocations=(_dislocation(),),
            ),
        ),
    )
    names = {factor.name for factor in factors}
    assert "cvd_direction_match" in names
    assert "delta_dislocation_at_entry" in names


def test_strong_delta_dislocation_suppresses_base_variant() -> None:
    factors = get_adjustment_factors(
        distance_atr=0.1,
        matches_session_drift=True,
        time_into_session_pct=0.2,
        state="ACTIVE",
        signal_context=ProbabilitySignalContext(
            direction="long",
            entry_zone_low=29495.0,
            entry_zone_high=29505.0,
            live_signals=_signals(dislocations=(_dislocation(strong=True),)),
        ),
    )
    names = {factor.name for factor in factors}
    assert "delta_dislocation_at_entry_strong" in names
    assert "delta_dislocation_at_entry" not in names


def test_low_tail_span_dislocation_uses_degraded_multiplier_and_tooltip_text() -> None:
    factors = get_adjustment_factors(
        distance_atr=0.1,
        matches_session_drift=True,
        time_into_session_pct=0.2,
        state="ACTIVE",
        signal_context=ProbabilitySignalContext(
            direction="long",
            entry_zone_low=29495.0,
            entry_zone_high=29505.0,
            live_signals=_signals(
                dislocations=(_dislocation(confidence="low_tail_span"),),
            ),
        ),
    )
    factor = next(item for item in factors if item.name == "delta_dislocation_at_entry")
    assert factor.multiplier == pytest.approx(1.15)
    assert factor.trigger is not None
    assert "degraded: tail spans 42min, not 60min" in factor.trigger


def test_additive_composition_caps_with_dislocation_and_cvd() -> None:
    low, high = adjust(
        0.80,
        0.90,
        distance_atr=0.1,
        matches_session_drift=True,
        time_into_session_pct=0.2,
        state="ACTIVE",
        signal_context=ProbabilitySignalContext(
            direction="long",
            entry_zone_low=29495.0,
            entry_zone_high=29505.0,
            live_signals=_signals(
                session_cvd=2_000,
                last_15m_cvd=1_000,
                velocity="active",
                dislocations=(_dislocation(strong=True),),
            ),
            confluence_method_count=5,
        ),
    )
    assert low == pytest.approx(0.95)
    assert high == pytest.approx(0.95)


def test_institutional_flow_match_and_oppose_are_mutually_exclusive() -> None:
    factors = get_adjustment_factors(
        distance_atr=0.1,
        matches_session_drift=True,
        time_into_session_pct=0.2,
        state="ACTIVE",
        signal_context=ProbabilitySignalContext(
            direction="long",
            entry_zone_low=29495.0,
            entry_zone_high=29505.0,
            live_signals=_signals(institutional=(_institutional_event(net_delta=-220, side="sell"),)),
        ),
    )
    names = {factor.name for factor in factors}
    assert "institutional_flow_oppose" in names
    assert "institutional_flow_match" not in names


def test_block_trade_at_entry_composes_with_concentration() -> None:
    factors = get_adjustment_factors(
        distance_atr=0.1,
        matches_session_drift=True,
        time_into_session_pct=0.2,
        state="ACTIVE",
        signal_context=ProbabilitySignalContext(
            direction="long",
            entry_zone_low=29495.0,
            entry_zone_high=29505.0,
            live_signals=_signals(
                institutional=(
                    _institutional_event(net_delta=240, side="buy", timestamp_ns=10),
                    _institutional_event(
                        event_type="block_trade_at_zone",
                        side="buy",
                        net_delta=120,
                        timestamp_ns=11,
                    ),
                )
            ),
        ),
    )
    names = {factor.name for factor in factors}
    assert {"institutional_flow_match", "block_trade_at_entry"} <= names


def test_institutional_cvd_dislocation_cofire_respects_composition_cap() -> None:
    low, high = adjust(
        0.80,
        0.90,
        distance_atr=0.1,
        matches_session_drift=True,
        time_into_session_pct=0.2,
        state="ACTIVE",
        signal_context=ProbabilitySignalContext(
            direction="long",
            entry_zone_low=29495.0,
            entry_zone_high=29505.0,
            live_signals=_signals(
                session_cvd=2_000,
                last_15m_cvd=1_000,
                dislocations=(_dislocation(strong=True),),
                institutional=(_institutional_event(net_delta=260, side="buy"),),
            ),
        ),
    )
    assert low == pytest.approx(0.95)
    assert high == pytest.approx(0.95)


def test_iceberg_match_and_oppose_are_mutually_exclusive() -> None:
    factors = get_adjustment_factors(
        distance_atr=0.1,
        matches_session_drift=True,
        time_into_session_pct=0.2,
        state="ACTIVE",
        signal_context=ProbabilitySignalContext(
            direction="long",
            entry_zone_low=29495.0,
            entry_zone_high=29505.0,
            live_signals=_signals(icebergs=(_iceberg_event(direction="short"),)),
        ),
    )
    names = {factor.name for factor in factors}
    assert "iceberg_opposing_entry" in names
    assert "iceberg_at_entry" not in names


def test_iceberg_high_intensity_stack_replaces_base_multiplier() -> None:
    factors = get_adjustment_factors(
        distance_atr=0.1,
        matches_session_drift=True,
        time_into_session_pct=0.2,
        state="ACTIVE",
        signal_context=ProbabilitySignalContext(
            direction="long",
            entry_zone_low=29495.0,
            entry_zone_high=29505.0,
            live_signals=_signals(
                icebergs=(
                    _iceberg_event(direction="long", timestamp_ns=20),
                    _iceberg_event(direction="long", timestamp_ns=21),
                )
            ),
        ),
    )
    names = {factor.name for factor in factors}
    assert "iceberg_high_intensity_stack" in names
    assert "iceberg_at_entry" not in names


def test_iceberg_institutional_cvd_dislocation_cofire_respects_cap_and_tooltips() -> None:
    factors = get_adjustment_factors(
        distance_atr=0.1,
        matches_session_drift=True,
        time_into_session_pct=0.2,
        state="ACTIVE",
        signal_context=ProbabilitySignalContext(
            direction="long",
            entry_zone_low=29495.0,
            entry_zone_high=29505.0,
            live_signals=_signals(
                session_cvd=2_000,
                last_15m_cvd=1_000,
                dislocations=(_dislocation(strong=True),),
                institutional=(_institutional_event(net_delta=260, side="buy"),),
                icebergs=(_iceberg_event(direction="long"),),
            ),
        ),
    )
    names = {factor.name for factor in factors}
    assert {
        "cvd_direction_match",
        "delta_dislocation_at_entry_strong",
        "institutional_flow_match",
        "iceberg_at_entry",
    } <= names
    iceberg = next(factor for factor in factors if factor.name == "iceberg_at_entry")
    assert iceberg.trigger is not None
    assert "5 bid-side refills, 145 consumed at VPOC via OBS confirmation" in iceberg.trigger

    low, high = adjust(
        0.80,
        0.90,
        distance_atr=0.1,
        matches_session_drift=True,
        time_into_session_pct=0.2,
        state="ACTIVE",
        signal_context=ProbabilitySignalContext(
            direction="long",
            entry_zone_low=29495.0,
            entry_zone_high=29505.0,
            live_signals=_signals(
                session_cvd=2_000,
                last_15m_cvd=1_000,
                dislocations=(_dislocation(strong=True),),
                institutional=(_institutional_event(net_delta=260, side="buy"),),
                icebergs=(_iceberg_event(direction="long"),),
            ),
        ),
    )
    assert low == pytest.approx(0.95)
    assert high == pytest.approx(0.95)
