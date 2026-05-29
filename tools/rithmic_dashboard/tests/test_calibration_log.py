from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from rithmic_dashboard.features.calibration_log import (
    append_completed_outcomes,
    append_probability_snapshots,
)
from rithmic_dashboard.models import AuditEntry
from rithmic_dashboard.scenario_state import compute_scenario_states
from rithmic_dashboard.session_state import PT, determine_session_state

from .conftest import sample_envelope


def _session(tmp_path: Path):
    return determine_session_state(
        now_pt=datetime(2026, 5, 21, 8, 0, tzinfo=PT),
        analytics_root=tmp_path / "analytics",
    )


def test_probability_snapshots_log_multiplier_provenance(tmp_path: Path) -> None:
    audit: list[AuditEntry] = []
    scenarios = compute_scenario_states(sample_envelope(), 29237.5, 40.0, audit)
    path = tmp_path / "probability_snapshots.jsonl"
    append_probability_snapshots(path, session=_session(tmp_path), scenarios=scenarios)
    rows = [json.loads(raw) for raw in path.read_text(encoding="utf-8").splitlines()]
    assert len(rows) == 10
    assert rows[0]["applied_multipliers"]


def test_completed_outcomes_log_once(tmp_path: Path) -> None:
    audit: list[AuditEntry] = []
    store = {"2026-05-21_rth_A": {"state": "ACTIVE", "entry_pt": "x"}}
    scenarios = compute_scenario_states(
        sample_envelope(),
        29340.0,
        40.0,
        audit,
        store,
        session_key="2026-05-21_rth",
        now_pt=datetime(2026, 5, 21, 8, 0, tzinfo=PT),
    )
    path = tmp_path / "probability_outcomes.jsonl"
    append_completed_outcomes(path, session=_session(tmp_path), scenarios=scenarios, scenario_store=store)
    append_completed_outcomes(path, session=_session(tmp_path), scenarios=scenarios, scenario_store=store)
    rows = [json.loads(raw) for raw in path.read_text(encoding="utf-8").splitlines()]
    assert len(rows) == 1
    assert rows[0]["outcome"] == "target_hit"
