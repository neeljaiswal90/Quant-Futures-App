"""Unit tests for the LiveSignals → contract-payload + tier layer."""

from __future__ import annotations

from rithmic_dashboard.features.recent_signals_panel import RecentSignal
from rithmic_dashboard.models import (
    AbsorptionProxyEvent,
    DeltaDislocationEvent,
    IcebergEvent,
    LiveCvd,
    LiveSignals,
    LiveVwap,
    SweepEvent,
    VolatilityRegime,
    VolumeVelocity,
)

from realtime_backend.signals import (
    HIGH_SWEEP_INTENSITY,
    build_snapshot_payload,
    classify_tier,
    diff_signals,
    events_to_payloads,
    map_absorption,
    map_dislocation,
    map_regime,
    map_sweep,
    zones_from_envelope,
)


def _vwap() -> LiveVwap:
    return LiveVwap(window_minutes=60, vwap=29400.0, sigma=12.0, plus_1sd=29412.0, minus_1sd=29388.0)


def _cvd() -> LiveCvd:
    return LiveCvd(100, 50, 25, "bullish", "bullish", False)


def _velocity() -> VolumeVelocity:
    return VolumeVelocity(10, 0.67, 0.5, 1.3, "normal")


def _signals(
    *,
    sweeps: tuple[SweepEvent, ...] = (),
    absorption: tuple[AbsorptionProxyEvent, ...] = (),
    dislocations: tuple[DeltaDislocationEvent, ...] = (),
    icebergs: tuple[IcebergEvent, ...] = (),
    regime: VolatilityRegime | None = None,
) -> LiveSignals:
    return LiveSignals(
        trading_date="2026-05-22",
        session="globex",
        computed_at_pt="2026-05-21 20:00:00 PT",
        source_path=__import__("pathlib").Path("x"),
        tail_bytes=1000,
        trade_count=10,
        live_vwap=_vwap(),
        cvd=_cvd(),
        velocity=_velocity(),
        sweeps=sweeps,
        absorption_proxies=absorption,
        delta_dislocations=dislocations,
        iceberg_events=icebergs,
        volatility_regime=regime,
    )


def _sweep(ts: int, price: float, intensity: float, direction: str = "up") -> SweepEvent:
    return SweepEvent(
        timestamp_pt="2026-05-21 20:00:00 PT",
        timestamp_ns=ts,
        level_id=f"ref-vah-{price:.2f}",
        level_text=f"VAH {price:.0f}",
        level_price=price,
        direction=direction,  # type: ignore[arg-type]
        intensity_score=intensity,
        recovered_within_5min=None,
    )


def _absorption(ts: int, price: float, side: str = "buy_absorbed") -> AbsorptionProxyEvent:
    return AbsorptionProxyEvent(
        timestamp_pt="2026-05-21 20:00:00 PT",
        timestamp_ns=ts,
        price=price,
        volume=200,
        net_delta=-150,
        side_inferred=side,
        confidence="high",
    )


def _dislocation(ts: int, price: float) -> DeltaDislocationEvent:
    return DeltaDislocationEvent(
        timestamp_pt="2026-05-21 20:00:00 PT",
        timestamp_ns=ts,
        side="long",
        level_id=f"ref-vpoc-{price:.2f}",
        level_text=f"VPOC {price:.0f}",
        level_price=price,
        candle_direction="down",
        hourly_cvd=900,
        threshold_used=500.0,
        proximity_pts=2.0,
        confidence="high",
        rolling_window_start_ts=None,
        tail_span_minutes=60.0,
        is_strong=True,
    )


def _regime(name: str, sigma: float = 18.0) -> VolatilityRegime:
    return VolatilityRegime(
        trading_date="2026-05-22",
        session="globex",
        computed_at_pt="2026-05-21 20:00:00 PT",
        status="active",
        regime=name,  # type: ignore[arg-type]
        observation_window_minutes=60,
        observation_sigma_pts=sigma,
        ewma_sigma_pts=sigma,
        sigma_effective_pts=sigma,
        corpus_median_sigma_pts=10.0,
        ratio=1.8,
        lambda_value=0.94,
        regime_factor=1.5,
        calibration_path=None,
        state_path=None,
        reason="ratio 1.80",
    )


def _recent(family: str, zone_key: str, zone_price: float, ts: int) -> RecentSignal:
    return RecentSignal(
        timestamp_pt="2026-05-21 20:00:00 PT",
        timestamp_ns=ts,
        event_type=f"{family}_x",
        family=family,
        icon="*",
        label=family,
        level_id=zone_key,
        level_text=f"zone {zone_price}",
        level_price=zone_price,
        price=zone_price,
        description=f"{family} at {zone_price}",
        direction="long",
        urgency="medium",
        decay_class="signal-age-fresh",
        age_minutes=1.0,
        scenario_refs=(),
        zone_key=zone_key,
        zone_text=f"zone {zone_price}",
        zone_price=zone_price,
        tooltip="t",
    )


# ----- diffing -----------------------------------------------------------


def test_diff_first_call_treats_all_events_as_new() -> None:
    sig = _signals(sweeps=(_sweep(1, 29425.0, 3.0),))
    diff = diff_signals(None, sig)
    assert len(diff.sweeps) == 1


def test_diff_only_returns_newly_appeared_events() -> None:
    prev = _signals(sweeps=(_sweep(1, 29425.0, 3.0),))
    curr = _signals(sweeps=(_sweep(1, 29425.0, 3.0), _sweep(2, 29430.0, 4.0)))
    diff = diff_signals(prev, curr)
    assert len(diff.sweeps) == 1
    assert diff.sweeps[0].timestamp_ns == 2


def test_diff_empty_when_no_change() -> None:
    sig = _signals(sweeps=(_sweep(1, 29425.0, 3.0),))
    assert diff_signals(sig, sig).is_empty()


def test_diff_regime_change_detected() -> None:
    prev = _signals(regime=_regime("NORMAL"))
    curr = _signals(regime=_regime("HIGH"))
    assert diff_signals(prev, curr).regime_changed is True


def test_diff_unknown_regime_never_flags_change() -> None:
    prev = _signals(regime=_regime("NORMAL"))
    curr = _signals(regime=_regime("UNKNOWN"))
    assert diff_signals(prev, curr).regime_changed is False


# ----- mapping -----------------------------------------------------------


def test_map_sweep_high_urgency_threshold() -> None:
    assert map_sweep(_sweep(1, 29425.0, HIGH_SWEEP_INTENSITY)).high_urgency is True
    assert map_sweep(_sweep(1, 29425.0, HIGH_SWEEP_INTENSITY - 0.1)).high_urgency is False


def test_map_sweep_payload_shape() -> None:
    mapped = map_sweep(_sweep(1, 29425.0, 5.2, "up"))
    dumped = mapped.payload.model_dump()
    assert dumped["family"] == "sweep"
    assert dumped["direction"] == "up"
    assert dumped["price"] == 29425.0
    assert dumped["ticks_cleared"] == 5


def test_map_absorption_side_inference() -> None:
    assert map_absorption(_absorption(1, 29425.0, "buy_absorbed")).payload.side == "ask"  # type: ignore[attr-defined]
    assert map_absorption(_absorption(1, 29425.0, "sell_absorbed")).payload.side == "bid"  # type: ignore[attr-defined]


def test_map_dislocation_is_high_urgency_signal_family() -> None:
    mapped = map_dislocation(_dislocation(1, 29400.0))
    assert mapped.high_urgency is True
    assert mapped.payload.family == "signal"


def test_map_regime_unknown_returns_none() -> None:
    assert map_regime(_signals(regime=_regime("UNKNOWN"))) is None


def test_map_regime_known_emits_regime_payload() -> None:
    mapped = map_regime(_signals(regime=_regime("HIGH", sigma=21.0)))
    assert mapped is not None
    assert mapped.message_type == "regime"
    assert mapped.payload.regime == "HIGH"  # type: ignore[attr-defined]
    assert mapped.payload.sigma == 21.0  # type: ignore[attr-defined]


def test_events_to_payloads_drops_unknown_regime() -> None:
    sig = _signals(sweeps=(_sweep(1, 29425.0, 3.0),), regime=_regime("UNKNOWN"))
    diff = diff_signals(None, sig)
    payloads = events_to_payloads(diff, sig)
    assert all(e.message_type != "regime" for e in payloads)


# ----- tier policy -------------------------------------------------------


def test_tier_medium_for_lone_low_intensity_sweep() -> None:
    event = map_sweep(_sweep(1, 29425.0, 2.0))
    tier = classify_tier(event, recent_signals=[], current_price=29420.0, max_price_distance=30.0)
    assert tier == "MEDIUM"


def test_tier_high_for_single_high_urgency_dislocation() -> None:
    event = map_dislocation(_dislocation(1, 29400.0))
    tier = classify_tier(event, recent_signals=[], current_price=29402.0, max_price_distance=30.0)
    assert tier == "HIGH"


def test_tier_high_for_sweep_at_or_above_intensity_threshold() -> None:
    event = map_sweep(_sweep(1, 29425.0, HIGH_SWEEP_INTENSITY))
    tier = classify_tier(event, recent_signals=[], current_price=29420.0, max_price_distance=30.0)
    assert tier == "HIGH"


def test_tier_high_for_two_family_stack() -> None:
    # Two distinct families at the same zone within 30pt -> HIGH.
    recent = [
        _recent("sweep", "level:z1", 29425.0, 1),
        _recent("absorption", "level:z1", 29425.0, 2),
    ]
    event = map_sweep(_sweep(3, 29425.0, 2.0))
    tier = classify_tier(
        event, recent_signals=recent, current_price=29420.0, max_price_distance=30.0
    )
    assert tier == "HIGH"


def test_tier_critical_for_three_family_stack() -> None:
    recent = [
        _recent("sweep", "level:z1", 29425.0, 1),
        _recent("absorption", "level:z1", 29425.0, 2),
        _recent("dislocation", "level:z1", 29425.0, 3),
    ]
    event = map_sweep(_sweep(4, 29425.0, 2.0))
    tier = classify_tier(
        event, recent_signals=recent, current_price=29420.0, max_price_distance=30.0
    )
    assert tier == "CRITICAL"


def test_tier_stack_beyond_proximity_does_not_escalate() -> None:
    # Three families but >30pt from current price -> no stack -> MEDIUM.
    recent = [
        _recent("sweep", "level:z1", 29500.0, 1),
        _recent("absorption", "level:z1", 29500.0, 2),
        _recent("dislocation", "level:z1", 29500.0, 3),
    ]
    event = map_sweep(_sweep(4, 29500.0, 2.0))
    tier = classify_tier(
        event, recent_signals=recent, current_price=29400.0, max_price_distance=30.0
    )
    assert tier == "MEDIUM"


# ----- snapshot ----------------------------------------------------------


def test_zones_from_envelope_builds_reference_lines() -> None:
    env = {
        "reference_lines": [
            {"price": 29400.0, "text": "VPOC", "source": "vpoc"},
            {"price": 29425.0, "text": "VAH", "source": "vah"},
        ]
    }
    zones = zones_from_envelope(env)
    assert {z.kind for z in zones} == {"vpoc", "vah"}


def test_build_snapshot_payload_carries_price_and_regime() -> None:
    sig = _signals(regime=_regime("NORMAL"))
    snap = build_snapshot_payload(sig, envelope={"reference_lines": []}, recent_signals=[])
    assert snap.price == 29400.0
    assert snap.regime == "NORMAL"
    assert snap.family == "snapshot"


def test_build_snapshot_payload_uses_last_trade_price_override() -> None:
    sig = _signals(regime=_regime("NORMAL"))
    snap = build_snapshot_payload(
        sig,
        envelope={"reference_lines": []},
        recent_signals=[],
        current_price=29405.25,
    )
    assert snap.price == 29405.25


def test_build_snapshot_payload_carries_recent_signal_chart_metadata() -> None:
    sig = _signals(regime=_regime("NORMAL"))
    snap = build_snapshot_payload(
        sig,
        envelope={"reference_lines": []},
        recent_signals=[_recent("sweep", "level:z1", 29425.0, 12345)],
    )
    metadata = snap.recent_signals[0].metadata
    assert metadata["timestamp_ns"] == 12345
    assert metadata["level_price"] == 29425.0
    assert metadata["price"] == 29425.0
    assert metadata["zone_price"] == 29425.0


def test_build_snapshot_unknown_regime_is_none() -> None:
    sig = _signals(regime=_regime("UNKNOWN"))
    snap = build_snapshot_payload(sig, envelope=None, recent_signals=[])
    assert snap.regime is None
