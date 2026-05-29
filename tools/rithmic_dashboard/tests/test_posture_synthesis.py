from __future__ import annotations

from datetime import datetime
from pathlib import Path

from rithmic_dashboard.features.posture_synthesis import synthesize_active_posture
from rithmic_dashboard.models import AuditEntry, OrderflowPulse
from rithmic_dashboard.scenario_state import compute_scenario_states
from rithmic_dashboard.session_state import PT, determine_session_state

from .conftest import sample_envelope


def test_posture_renders_three_structured_sentences(tmp_path: Path) -> None:
    envelope = sample_envelope()
    audit: list[AuditEntry] = []
    scenarios = compute_scenario_states(envelope, 29500.0, 40.0, audit)
    session = determine_session_state(
        now_pt=datetime(2026, 5, 21, 8, 0, tzinfo=PT),
        analytics_root=tmp_path,
        trading_date_override="2026-05-21",
        session_override="rth",
    )
    pulse = OrderflowPulse(
        artifact_date="2026-05-21",
        artifact_session="rth",
        session_cvd=1000,
        last_60m_cvd=-800,
        buy_volume_pct=0.51,
        spread_mean_ticks=2.0,
        spread_p99_ticks=7.0,
        crossed_quotes=0,
        recent_absorption=None,
        top_spoof_bins=(),
        pressure_status="ok",
    )

    posture = synthesize_active_posture(
        envelope=envelope,
        current_price=29500.0,
        atr=40.0,
        scenarios=scenarios,
        pulse=pulse,
        session=session,
    )

    assert len(posture.sentences) == 3
    assert "RTH trading" in posture.sentences[0]
    assert "Focus scenarios" in posture.sentences[1]
    assert "Last-60m CVD is bearish" in posture.sentences[2]


def test_posture_fail_open_when_data_missing(tmp_path: Path) -> None:
    session = determine_session_state(
        now_pt=datetime(2026, 5, 21, 8, 0, tzinfo=PT),
        analytics_root=tmp_path,
        trading_date_override="2026-05-21",
        session_override="rth",
    )
    posture = synthesize_active_posture(
        envelope=None,
        current_price=None,
        atr=40.0,
        scenarios=[],
        pulse=None,
        session=session,
    )
    assert len(posture.sentences) == 3
    assert "unavailable" in posture.sentences[0]


def test_posture_mentions_no_nearby_scenario_when_all_dormant(tmp_path: Path) -> None:
    envelope = sample_envelope()
    audit: list[AuditEntry] = []
    scenarios = compute_scenario_states(envelope, 28000.0, 40.0, audit)
    session = determine_session_state(
        now_pt=datetime(2026, 5, 21, 8, 0, tzinfo=PT),
        analytics_root=tmp_path,
        trading_date_override="2026-05-21",
        session_override="rth",
    )
    pulse = OrderflowPulse(
        artifact_date="2026-05-21",
        artifact_session="rth",
        session_cvd=0,
        last_60m_cvd=0,
        buy_volume_pct=0.5,
        spread_mean_ticks=2.0,
        spread_p99_ticks=4.0,
        crossed_quotes=0,
        recent_absorption=None,
        top_spoof_bins=(),
        pressure_status="ok",
    )

    posture = synthesize_active_posture(
        envelope=envelope,
        current_price=28000.0,
        atr=40.0,
        scenarios=scenarios,
        pulse=pulse,
        session=session,
    )

    assert "No ACTIVE/WATCHING/IN_PROGRESS scenario" in posture.sentences[1]
    assert "neutral" in posture.sentences[2]
