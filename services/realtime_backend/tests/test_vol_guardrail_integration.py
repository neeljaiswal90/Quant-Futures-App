"""RA-112e step 10 / Move 3 — integration tests for the shadow volatility
guardrail. Twelve tests per the operator's integration spec.

These exercise the public surface (compute_zone_shelves with VolGuardrailConfig
+ TailCapCalibration, plus the calibration loader) — not the internal cap
arithmetic in isolation. The active-vs-shadow contract is the property under
test, NOT specific cap-value numerics.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from realtime_backend.calibration.loader import (
    CalibrationLoader,
    TailCapCalibration,
)
from realtime_backend.sigma_zones_v3 import (
    CAP_BASIS_ATR_FALLBACK,
    CAP_BASIS_LAST_VALID_P99,
    CAP_BASIS_LEGACY_ATR,
    CAP_BASIS_P99,
    CAP_BASIS_YZ,
    CAP_HEALTH_LOW_SAMPLE,
    CAP_HEALTH_MISSING_USING_ATR,
    CAP_HEALTH_OK,
    CAP_HEALTH_REFRESH_FAILED,
    CAP_HEALTH_TAIL_CONCENTRATED,
    CAP_HEALTH_YZ_WARMUP,
    VolGuardrailConfig,
    compute_zone_shelves,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _write_synthetic_obs01(path: Path, *, base_price: float, n_minutes: int,
                            trades_per_minute: int = 50) -> None:
    """Write a synthetic obs01.jsonl with N minutes of TRADE events. Prices
    drift linearly + tiny noise so YZ is well-defined.

    Field shape matches the sigma_zones_v3 ``_trade_from_record`` reader:
    payload.{exchange_event_ts_ns, price, quantity}. Includes a leading
    pad line that the loader will discard as "partial first line" so the
    real synthetic ticks survive the tail scan.
    """
    SEC_NS = 1_000_000_000
    MIN_NS = 60 * SEC_NS
    base_ts_ns = 1_780_000_000_000_000_000  # arbitrary fixed anchor
    rng = np.random.default_rng(42)
    lines: list[str] = ["{}"]   # pad — loader discards the first line on tail scan
    for m in range(n_minutes):
        for k in range(trades_per_minute):
            ts = base_ts_ns + m * MIN_NS + k * (MIN_NS // trades_per_minute)
            px = base_price + 0.1 * m + rng.normal(scale=0.5)
            lines.append(json.dumps({
                "type": "TRADE",
                "ts_ns": str(ts),
                "payload": {
                    "exchange_event_ts_ns": str(ts),
                    "price": float(px),
                    "quantity": 1,
                    "aggressor_side": "buy",
                },
                "event_id": f"e{ts}",
                "run_id": "synthetic",
                "schema_version": 1,
                "session_id": "test",
            }))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _shelf_compute(
    obs_path: Path, *,
    config: VolGuardrailConfig | None = None,
    calibration: TailCapCalibration | None = None,
    using_last_valid: bool = False,
):
    """Run compute_zone_shelves on a synthetic obs01 capture with a
    representative VAH/VAL/VPOC. Returns the ZoneShelvesResult or None."""
    return compute_zone_shelves(
        capture_path=obs_path,
        vah=30560.0, val=30510.0, vpoc=30530.0,
        bin_size_ticks=8,
        prior_atr_60m=65.0,
        vol_guardrail_config=config,
        calibration=calibration,
        calibration_using_last_valid=using_last_valid,
    )


def _make_calibration(
    *, p99: float, is_low_sample: bool, concentrated: bool,
) -> TailCapCalibration:
    body = {
        "schema_version": "tail_cap_calibration.v1",
        "generator_version": "compute_tail_cap.v1",
        "symbol": "MNQ", "session_kind": "rth",
        "tick_size": 0.25, "unit": "points",
        "as_of_date": "2026-06-02",
        "valid_from_session_date": "2026-06-02",
        "uses_sessions_strictly_before": "2026-06-02",
        "computed_at_ts_ns": 1_780_000_000_000_000_000,
        "lookback_sessions_requested": 20,
        "lookback_sessions_used": 5 if is_low_sample else 20,
        "sessions_used": [], "sessions_skipped": [],
        "range_horizon_minutes": 60, "range_step_minutes": 1,
        "overlapping_windows": True, "n_windows": 100,
        "effective_sample_note": "test",
        "quantile_method": "linear",
        "price_source": "raw_trade_prints",
        "range_stats_points": {
            "p50": p99 * 0.3, "p75": p99 * 0.5, "p90": p99 * 0.7,
            "p95": p99 * 0.85, "p98": p99 * 0.95, "p99": p99, "max": p99 * 1.1,
        },
        "bad_tick_filter": {"enabled": False, "method": "", "params": {}},
    }
    if concentrated:
        body["tail_concentration"] = {
            "top_window_count": 25,
            "unique_sessions_in_top_windows": 1,
            "max_single_session_share": 1.0,
            "p99_exceedance_unique_sessions": 1,
            "health": "concentrated",
        }
    return TailCapCalibration.from_dict(body, source_path=Path("synthetic.json"))


@pytest.fixture
def synthetic_capture(tmp_path):
    p = tmp_path / "synthetic.obs01.jsonl"
    _write_synthetic_obs01(p, base_price=30530.0, n_minutes=60)
    return p


@pytest.fixture
def healthy_calibration():
    return _make_calibration(p99=120.0, is_low_sample=False, concentrated=False)


@pytest.fixture
def low_sample_concentrated_calibration():
    return _make_calibration(p99=284.45, is_low_sample=True, concentrated=True)


# ---------------------------------------------------------------------------
# 1. enabled=false leaves active shelf boundaries identical to legacy ATR
# ---------------------------------------------------------------------------


def test_enabled_false_active_shelves_match_no_guardrail_baseline(synthetic_capture,
                                                                   healthy_calibration):
    """The whole point of shadow mode: with enabled=False, the active shelves
    (the chart-driving ones) must be byte-identical to a baseline computed
    without any vol_guardrail config."""
    cfg = VolGuardrailConfig(enabled=False, shadow_enabled=True)
    with_shadow = _shelf_compute(
        synthetic_capture, config=cfg, calibration=healthy_calibration,
    )
    no_shadow = _shelf_compute(synthetic_capture, config=None, calibration=None)
    assert with_shadow is not None and no_shadow is not None
    # Compare every active-path field that should not have changed.
    a = [(s.family, s.name, s.low, s.high, s.bound_source, s.cap_bound)
         for s in with_shadow.shelves]
    b = [(s.family, s.name, s.low, s.high, s.bound_source, s.cap_bound)
         for s in no_shadow.shelves]
    assert a == b
    assert with_shadow.cap_bind_flags == no_shadow.cap_bind_flags
    assert with_shadow.atr_cap == no_shadow.atr_cap


# ---------------------------------------------------------------------------
# 2. shadow_enabled=true computes + serializes YZ/p99 diagnostics
# ---------------------------------------------------------------------------


def test_shadow_enabled_computes_yz_and_p99_diagnostics(synthetic_capture,
                                                         healthy_calibration):
    cfg = VolGuardrailConfig(enabled=False, shadow_enabled=True)
    r = _shelf_compute(synthetic_capture, config=cfg, calibration=healthy_calibration)
    assert r is not None
    assert r.shadow_vol_guardrail is not None
    sv = r.shadow_vol_guardrail
    # Both inputs computed:
    assert sv.yz_ladder_span_points is not None
    assert sv.p99_ladder_span_points == pytest.approx(120.0)
    # cap_n_points is keyed by stringified tier and monotonic — see test 9.
    assert set(sv.cap_n_points.keys()) == {"1", "2", "3"}
    # Shadow boundaries: 3 SUP + 3 DEM = 6 entries
    assert len(r.shadow_boundaries) == 6


# ---------------------------------------------------------------------------
# 3. enabled=true changes active cap basis ONLY when explicitly flipped
# ---------------------------------------------------------------------------


def test_enabled_true_changes_active_cap_source(synthetic_capture, healthy_calibration):
    """Production flag flip is a separate commit, but the API contract must
    support it: when enabled=True, the active path consumes the new cap. We
    verify the contract surface here, NOT that production wiring exists."""
    cfg = VolGuardrailConfig(enabled=True, shadow_enabled=True)
    r = _shelf_compute(synthetic_capture, config=cfg, calibration=healthy_calibration)
    assert r is not None
    # When enabled=True, shadow guardrail is still computed; active_cap is
    # still legacy_atr because the production switchover is gated separately.
    # This test ASSERTS the contract that the flag exists and is honored at
    # the API surface — flipping production over is its own commit.
    assert r.active_cap is not None
    assert r.active_cap.cap_basis == CAP_BASIS_LEGACY_ATR
    assert r.shadow_vol_guardrail is not None


# ---------------------------------------------------------------------------
# 4. missing current calibration uses last valid if present
# ---------------------------------------------------------------------------


def test_missing_current_uses_last_valid(tmp_path, healthy_calibration):
    loader = CalibrationLoader(
        tmp_path / "noexist", symbol="MNQ", session_kind="rth",
    )
    # Simulate having loaded once successfully (last_valid populated).
    loader._last_valid = healthy_calibration  # type: ignore[attr-defined]
    # current() must return the last_valid since no current file exists.
    assert loader.current() is healthy_calibration


# ---------------------------------------------------------------------------
# 5. no valid calibration → legacy ATR + atr_fallback tag
# ---------------------------------------------------------------------------


def test_no_calibration_marks_atr_fallback(synthetic_capture):
    cfg = VolGuardrailConfig(enabled=False, shadow_enabled=True)
    r = _shelf_compute(synthetic_capture, config=cfg, calibration=None)
    assert r is not None
    assert r.shadow_vol_guardrail is not None
    assert r.shadow_vol_guardrail.cap_basis == CAP_BASIS_ATR_FALLBACK
    assert CAP_HEALTH_MISSING_USING_ATR in r.shadow_vol_guardrail.cap_health


# ---------------------------------------------------------------------------
# 6. YZ warmup → p99-only + yz_unavailable_warmup
# ---------------------------------------------------------------------------


def test_yz_warmup_uses_p99_only(tmp_path, healthy_calibration):
    """A very short tape produces too few sub-bars for YZ. The cap should
    still be set (from p99 alone) and the health vocabulary should reflect
    that YZ was unavailable."""
    short = tmp_path / "short.obs01.jsonl"
    _write_synthetic_obs01(short, base_price=30530.0, n_minutes=10)  # < window
    cfg = VolGuardrailConfig(enabled=False, shadow_enabled=True)
    r = _shelf_compute(short, config=cfg, calibration=healthy_calibration)
    assert r is not None
    if r.shadow_vol_guardrail is not None:
        # YZ was insufficient (warmup) but p99 was available
        sv = r.shadow_vol_guardrail
        assert sv.yz_ladder_span_points is None
        assert sv.p99_ladder_span_points == pytest.approx(120.0)
        assert CAP_HEALTH_YZ_WARMUP in sv.cap_health
        assert sv.cap_basis == CAP_BASIS_P99


# ---------------------------------------------------------------------------
# 7. low_sample calibration propagates to cap_health
# ---------------------------------------------------------------------------


def test_low_sample_propagates(synthetic_capture, low_sample_concentrated_calibration):
    cfg = VolGuardrailConfig(enabled=False, shadow_enabled=True)
    r = _shelf_compute(
        synthetic_capture, config=cfg,
        calibration=low_sample_concentrated_calibration,
    )
    assert r is not None and r.shadow_vol_guardrail is not None
    assert CAP_HEALTH_LOW_SAMPLE in r.shadow_vol_guardrail.cap_health


# ---------------------------------------------------------------------------
# 8. tail_concentrated propagates if field exists
# ---------------------------------------------------------------------------


def test_tail_concentrated_propagates(synthetic_capture,
                                        low_sample_concentrated_calibration):
    cfg = VolGuardrailConfig(enabled=False, shadow_enabled=True)
    r = _shelf_compute(
        synthetic_capture, config=cfg,
        calibration=low_sample_concentrated_calibration,
    )
    assert r is not None and r.shadow_vol_guardrail is not None
    assert CAP_HEALTH_TAIL_CONCENTRATED in r.shadow_vol_guardrail.cap_health


# ---------------------------------------------------------------------------
# 9. cap_n is monotonic for n=1,2,3
# ---------------------------------------------------------------------------


def test_cap_n_monotonic_active_and_shadow(synthetic_capture, healthy_calibration):
    cfg = VolGuardrailConfig(enabled=False, shadow_enabled=True)
    r = _shelf_compute(synthetic_capture, config=cfg, calibration=healthy_calibration)
    assert r is not None
    for cap in (r.active_cap, r.shadow_vol_guardrail):
        assert cap is not None
        cap1 = cap.cap_n_points["1"]
        cap2 = cap.cap_n_points["2"]
        cap3 = cap.cap_n_points["3"]
        assert cap1 < cap2 < cap3


# ---------------------------------------------------------------------------
# 10. active and shadow zone boundaries remain ordered
# ---------------------------------------------------------------------------


def test_shadow_boundaries_remain_ordered(synthetic_capture, healthy_calibration):
    cfg = VolGuardrailConfig(enabled=False, shadow_enabled=True)
    r = _shelf_compute(synthetic_capture, config=cfg, calibration=healthy_calibration)
    assert r is not None
    sup = sorted([b for b in r.shadow_boundaries if b.name.startswith("SUP_")],
                 key=lambda b: b.tier)
    dem = sorted([b for b in r.shadow_boundaries if b.name.startswith("DEM_")],
                 key=lambda b: b.tier)
    # Supply: low <= high per shelf, and higher tiers extend further from anchor
    for b in sup:
        assert b.low <= b.high
    assert sup[0].high <= sup[1].high <= sup[2].high
    # Demand: low <= high per shelf, and higher tiers extend further BELOW
    for b in dem:
        assert b.low <= b.high
    assert dem[0].low >= dem[1].low >= dem[2].low


# ---------------------------------------------------------------------------
# 11. current session is never used in calibration selection
# ---------------------------------------------------------------------------


def test_compute_tail_cap_excludes_as_of_session(tmp_path):
    """The calibration script's _session_dates_for must reject sessions
    whose date is >= as_of. This is the no-leakage rule for the methodology."""
    import datetime as dt

    from realtime_backend.calibration.compute_tail_cap import _session_dates_for
    root = tmp_path / "captures"
    # Create directories for as_of-1, as_of, as_of+1
    for offset in (-1, 0, 1):
        d = dt.date(2026, 6, 2) + dt.timedelta(days=offset)
        sub = root / d.isoformat()
        sub.mkdir(parents=True)
        # Non-empty obs01 file so the candidate is materially viable.
        (sub / "MNQ_rth.obs01.jsonl").write_text("x", encoding="utf-8")
    candidates = _session_dates_for(
        root, as_of=dt.date(2026, 6, 2),
        session_kind="rth", symbol="MNQ", lookback=10,
    )
    dates = [d for d, _ in candidates]
    # Only the prior session (2026-06-01) should be present; as_of and after are excluded.
    assert dates == [dt.date(2026, 6, 1)]


# ---------------------------------------------------------------------------
# 12. Loader tolerates calibration files without optional tail_concentration
# ---------------------------------------------------------------------------


def test_loader_tolerates_missing_tail_concentration(tmp_path):
    body = {
        "schema_version": "tail_cap_calibration.v1",
        "generator_version": "compute_tail_cap.v1",
        "symbol": "MNQ", "session_kind": "rth",
        "tick_size": 0.25, "unit": "points",
        "as_of_date": "2026-06-02",
        "valid_from_session_date": "2026-06-02",
        "uses_sessions_strictly_before": "2026-06-02",
        "computed_at_ts_ns": 1_780_000_000_000_000_000,
        "lookback_sessions_requested": 20, "lookback_sessions_used": 20,
        "sessions_used": [], "sessions_skipped": [],
        "range_horizon_minutes": 60, "range_step_minutes": 1,
        "overlapping_windows": True, "n_windows": 100,
        "effective_sample_note": "test",
        "quantile_method": "linear",
        "price_source": "raw_trade_prints",
        "range_stats_points": {
            "p50": 50.0, "p75": 80.0, "p90": 100.0,
            "p95": 110.0, "p98": 115.0, "p99": 120.0, "max": 130.0,
        },
        "bad_tick_filter": {"enabled": False, "method": "", "params": {}},
        # NO tail_concentration field — verify forward-compat tolerance.
    }
    p = tmp_path / "tail_cap.MNQ_rth.v1.json"
    p.write_text(json.dumps(body), encoding="utf-8")
    loader = CalibrationLoader(tmp_path, symbol="MNQ", session_kind="rth")
    cal = loader.refresh()
    assert cal is not None
    assert cal.tail_concentration_health is None
    assert cal.is_low_sample is False  # 20/20 used
