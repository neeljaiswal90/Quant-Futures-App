from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from rithmic_dashboard.confluence import compute_confluence_groups
from rithmic_dashboard.legacy_v1.dashboard_renderer import render_dashboard, render_error_page
from rithmic_dashboard.level_distances import compute_level_distances
from rithmic_dashboard.models import (
    ActivePosture,
    AuditEntry,
    DayTypeClassification,
    LiveCvd,
    LiveSignals,
    LiveVwap,
    OrderflowPulse,
    PriceSnapshot,
    SpoofBin,
    VolatilityRegime,
    VolumeVelocity,
)
from rithmic_dashboard.scenario_state import compute_scenario_states
from rithmic_dashboard.session_state import PT, determine_session_state

from .conftest import sample_envelope


def test_renderer_outputs_required_sections(tmp_path: Path) -> None:
    envelope = sample_envelope()
    audit: list[AuditEntry] = []
    html = render_dashboard(
        envelope=envelope,
        current_price=29237.5,
        price_snapshot=PriceSnapshot(29237.5, None, None, "test"),
        distances=compute_level_distances(envelope, 29237.5, 40.0),
        scenarios=compute_scenario_states(envelope, 29237.5, 40.0, audit),
        confluence=compute_confluence_groups(envelope),
        signals=None,
        audit=audit,
        orderflow_pulse=OrderflowPulse(
            artifact_date="2026-05-21",
            artifact_session="rth",
            session_cvd=100,
            last_60m_cvd=-50,
            buy_volume_pct=0.51,
            spread_mean_ticks=2.0,
            spread_p99_ticks=7.0,
            crossed_quotes=0,
            recent_absorption="29,420 score 0.62 sell_absorbed",
            top_spoof_bins=(SpoofBin(29420.0, 90, 0.94),),
            pressure_status="ok",
        ),
        active_posture=ActivePosture("ACTIVE POSTURE (08:00 PT)", ("Test posture.",)),
        session_state=determine_session_state(
            now_pt=datetime(2026, 5, 21, 8, 0, tzinfo=PT),
            analytics_root=tmp_path,
        ),
        warnings=[],
        zones_path=tmp_path / "zones.json",
        output_path=tmp_path / "index.html",
        day_type=DayTypeClassification(
            trading_date="2026-05-21",
            session="rth",
            computed_at_pt="2026-05-21 08:00:00 PT",
            status="classified",
            day_type="normal_variation_up",
            confidence="high",
            reason="fixture",
            classification_timestamp_pt="2026-05-21 08:00:00 PT",
            ib_high=29400.0,
            ib_low=29300.0,
            ib_range=100.0,
            current_extension_pts=24.0,
            current_extension_x_ib=0.24,
        ),
    )
    assert "Distance To Key Levels" in html
    assert "Active Posture" in html
    assert "Today's Day Type" in html
    assert "NORMAL VARIATION UP" in html
    assert "Orderflow Pulse" in html
    assert "Recent Signals" in html
    assert "CVD session" in html
    assert "29,420 score 0.62" in html
    assert "Scenario Status" in html
    assert "Audit Trail" in html


def test_renderer_shows_volatility_regime_in_orderflow_pulse(tmp_path: Path) -> None:
    envelope = sample_envelope()
    audit: list[AuditEntry] = []
    session = determine_session_state(
        now_pt=datetime(2026, 5, 21, 8, 0, tzinfo=PT),
        analytics_root=tmp_path,
    )
    live_signals = LiveSignals(
        trading_date=session.trading_date,
        session=session.session,
        computed_at_pt="2026-05-21 08:00:00 PT",
        source_path=tmp_path / "capture.jsonl",
        tail_bytes=20_000_000,
        trade_count=12,
        live_vwap=LiveVwap(60, 100.0, 2.0, 102.0, 98.0),
        cvd=LiveCvd(120, 80, 20, "neutral", "neutral", False),
        velocity=VolumeVelocity(12, 0.8, 1.0, 0.8, "normal"),
        sweeps=(),
        absorption_proxies=(),
        volatility_regime=VolatilityRegime(
            trading_date=session.trading_date,
            session=session.session,
            computed_at_pt="2026-05-21 08:00:00 PT",
            status="active",
            regime="HIGH",
            observation_window_minutes=15,
            observation_sigma_pts=18.0,
            ewma_sigma_pts=14.0,
            sigma_effective_pts=22.4,
            corpus_median_sigma_pts=10.0,
            ratio=1.4,
            lambda_value=0.9,
            regime_factor=1.6,
            calibration_path=tmp_path / "ewma_decay.json",
            state_path=tmp_path / "ewma_state.json",
            reason="fixture",
        ),
    )

    html = render_dashboard(
        envelope=envelope,
        current_price=29237.5,
        price_snapshot=PriceSnapshot(29237.5, None, None, "test"),
        distances=compute_level_distances(envelope, 29237.5, 40.0),
        scenarios=compute_scenario_states(envelope, 29237.5, 40.0, audit),
        confluence=compute_confluence_groups(envelope),
        signals=None,
        audit=audit,
        orderflow_pulse=None,
        active_posture=None,
        session_state=session,
        warnings=[],
        zones_path=tmp_path / "zones.json",
        output_path=tmp_path / "dashboard" / "index.html",
        live_signals=live_signals,
    )

    assert "Volatility regime" in html
    assert "HIGH" in html
    assert "effective" in html
    assert "22.4pt" in html


def test_renderer_surfaces_recent_signal_panel_and_badges(tmp_path: Path) -> None:
    live_dir = tmp_path / "live_analysis"
    live_dir.mkdir()
    (live_dir / "2026-05-21_rth_sweeps.jsonl").write_text(
        json.dumps(
            {
                "timestamp_pt": "2026-05-21 07:59:00 PT",
                "timestamp_ns": None,
                "level_id": "ref-vah-29425.00",
                "level_text": "VAH 29425",
                "level_price": 29425.0,
                "direction": "down",
                "intensity_score": 5.0,
                "recovered_within_5min": False,
            },
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    envelope = sample_envelope()
    audit: list[AuditEntry] = []
    output_path = tmp_path / "dashboard" / "index.html"
    html = render_dashboard(
        envelope=envelope,
        current_price=29424.0,
        price_snapshot=PriceSnapshot(29424.0, None, None, "test"),
        distances=compute_level_distances(envelope, 29424.0, 40.0),
        scenarios=compute_scenario_states(envelope, 29424.0, 40.0, audit),
        confluence=compute_confluence_groups(envelope),
        signals=None,
        audit=audit,
        orderflow_pulse=None,
        active_posture=None,
        session_state=determine_session_state(
            now_pt=datetime(2026, 5, 21, 8, 0, tzinfo=PT),
            analytics_root=tmp_path,
        ),
        warnings=[],
        zones_path=tmp_path / "zones.json",
        output_path=output_path,
    )

    assert "Recent Signals" in html
    assert "Sweep / VAH 29425" in html
    assert "zone-badge-sweep" in html


def test_renderer_includes_meta_refresh(tmp_path: Path) -> None:
    html = render_error_page(
        title="x",
        message="y",
        output_path=tmp_path / "index.html",
        now_pt=datetime(2026, 5, 21, 8, 0, tzinfo=PT),
    )
    assert 'http-equiv="refresh" content="300"' in html


def test_renderer_surfaces_warning_text(tmp_path: Path) -> None:
    html = render_error_page(
        title="Missing data",
        message="Zones JSON missing",
        output_path=tmp_path / "index.html",
        now_pt=datetime(2026, 5, 21, 8, 0, tzinfo=PT),
    )
    assert "Zones JSON missing" in html


def test_renderer_keeps_required_statistical_rows_when_far_away(tmp_path: Path) -> None:
    envelope = sample_envelope()
    envelope["reference_lines"].append(
        {
            "price": 29128.17,
            "text": "VWAP RTH -2sd",
            "source": "vwap_rth_band_m2sd",
        }
    )
    audit: list[AuditEntry] = []
    html = render_dashboard(
        envelope=envelope,
        current_price=29520.0,
        price_snapshot=PriceSnapshot(29520.0, None, None, "test"),
        distances=compute_level_distances(envelope, 29520.0, 40.0),
        scenarios=compute_scenario_states(envelope, 29520.0, 40.0, audit),
        confluence=compute_confluence_groups(envelope),
        signals=None,
        audit=audit,
        orderflow_pulse=None,
        active_posture=None,
        session_state=determine_session_state(
            now_pt=datetime(2026, 5, 21, 8, 0, tzinfo=PT),
            analytics_root=tmp_path,
        ),
        warnings=[],
        zones_path=tmp_path / "zones.json",
        output_path=tmp_path / "index.html",
    )
    assert "vwap_rth_band_m2sd" in html
