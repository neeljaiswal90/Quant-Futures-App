"""Probability provenance and outcome logging for calibration."""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from typing import Any

from rithmic_dashboard.models import DashboardSession, ScenarioState


def append_probability_snapshots(
    path: Path,
    *,
    session: DashboardSession,
    scenarios: list[ScenarioState],
) -> None:
    """Append the displayed probability and multiplier provenance for each scenario."""

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for scenario in scenarios:
            f.write(json.dumps(_snapshot_row(session, scenario), sort_keys=True) + "\n")


def append_completed_outcomes(
    path: Path,
    *,
    session: DashboardSession,
    scenarios: list[ScenarioState],
    scenario_store: dict[str, Any],
) -> None:
    """Append newly completed scenario outcomes with displayed probability provenance."""

    rows = _completed_rows(session, scenarios, scenario_store)
    if not rows:
        return
    seen = _seen_outcome_keys(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for row in rows:
            key = _outcome_key(row)
            if key in seen:
                continue
            f.write(json.dumps(row, sort_keys=True) + "\n")
            seen.add(key)


def _snapshot_row(session: DashboardSession, scenario: ScenarioState) -> dict[str, Any]:
    return {
        "record_type": "probability_snapshot",
        "trading_date": session.trading_date,
        "session": session.session,
        "scenario_id": scenario.scenario_id,
        "state": scenario.state,
        "displayed_prob_low": scenario.adjusted_prob_low,
        "displayed_prob_high": scenario.adjusted_prob_high,
        "prior_prob_low": scenario.prior_prob_low,
        "prior_prob_high": scenario.prior_prob_high,
        "recorded_at_pt": session.now_pt.isoformat(),
        "applied_multipliers": [asdict(factor) for factor in scenario.adjustment_factors],
    }


def _completed_rows(
    session: DashboardSession,
    scenarios: list[ScenarioState],
    scenario_store: dict[str, Any],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for scenario in scenarios:
        if scenario.state != "COMPLETED":
            continue
        key = f"{session.key}_{scenario.scenario_id}"
        persisted = scenario_store.get(key)
        if not isinstance(persisted, dict):
            continue
        outcome = persisted.get("outcome")
        if outcome not in {"target_hit", "stop_hit"}:
            continue
        rows.append(
            {
                "record_type": "probability_outcome",
                "trading_date": session.trading_date,
                "session": session.session,
                "scenario_id": scenario.scenario_id,
                "displayed_prob_low": scenario.adjusted_prob_low,
                "displayed_prob_high": scenario.adjusted_prob_high,
                "outcome": outcome,
                "entry_ts_ns": persisted.get("entry_ts_ns"),
                "exit_ts_ns": persisted.get("exit_ts_ns"),
                "entry_pt": persisted.get("entry_pt"),
                "exit_pt": session.now_pt.isoformat(),
                "applied_multipliers": [asdict(factor) for factor in scenario.adjustment_factors],
            }
        )
    return rows


def _seen_outcome_keys(path: Path) -> set[str]:
    if not path.exists():
        return set()
    keys: set[str] = set()
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        try:
            row = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            keys.add(_outcome_key(row))
    return keys


def _outcome_key(row: dict[str, Any]) -> str:
    return "|".join(
        [
            str(row.get("trading_date")),
            str(row.get("session")),
            str(row.get("scenario_id")),
            str(row.get("outcome")),
            str(row.get("exit_pt")),
        ]
    )
