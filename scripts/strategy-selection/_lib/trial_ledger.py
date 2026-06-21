"""Append-only cumulative trial ledger support for QFA-611."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, Sequence

from effective_trials import compute_effective_trial_count


def load_cumulative_trial_ledger(
    path: Path,
    *,
    candidate_strategy_ids_gated: Sequence[str],
    effective_trial_method: str = "max_of_manual_and_distinct_fingerprints",
) -> tuple[dict[str, Any], int]:
    entries = _load_entries(path)
    candidate_ids = set(candidate_strategy_ids_gated)
    if not candidate_ids:
        raise ValueError("candidate_strategy_ids_gated must be non-empty")

    counted = [
        entry
        for entry in entries
        if not bool(entry.get("determinism_rerun", False))
        and _entry_strategy_id(entry) in candidate_ids
    ]
    determinism_reruns = [
        entry
        for entry in entries
        if bool(entry.get("determinism_rerun", False))
        and _entry_strategy_id(entry) in candidate_ids
    ]
    if not counted:
        raise ValueError("cumulative trial ledger has no counted entries for gated strategies")

    missing = sorted(candidate_ids - {_entry_strategy_id(entry) for entry in counted})
    if missing:
        raise ValueError(f"cumulative trial ledger missing gated strategies: {','.join(missing)}")

    distinct_window_fingerprints = {
        _required_string(entry, "window_fingerprint_tuple")
        for entry in counted
    }
    manual_declared_effective_trials = len(counted)
    distinct_window_fingerprint_tuples = len(distinct_window_fingerprints)
    effective_trial_count = compute_effective_trial_count(
        manual_declared_effective_trials=manual_declared_effective_trials,
        distinct_window_fingerprint_tuples=distinct_window_fingerprint_tuples,
        effective_trial_method=effective_trial_method,
    )
    manifest = {
        "schema_version": 1,
        "ledger_schema_version": 1,
        "ledger_path": str(path),
        "effective_trial_method": effective_trial_method,
        "manual_declared_effective_trials": manual_declared_effective_trials,
        "distinct_window_fingerprint_tuples": distinct_window_fingerprint_tuples,
        "effective_trial_count": effective_trial_count,
        "raw_research_trials": len(counted),
        "excluded_determinism_reruns": len(determinism_reruns),
        "candidate_strategy_ids_gated": list(candidate_strategy_ids_gated),
        "generation_run_ids": sorted({
            _required_string(entry, "generation_run_id")
            for entry in counted
        }),
        "campaign_ids": sorted({
            _required_string(entry, "campaign_id")
            for entry in counted
        }),
        "corpus_fingerprints": sorted({
            _required_string(entry, "corpus_fingerprint")
            for entry in counted
        }),
        "search_space_hashes": sorted({
            _required_string(entry, "search_space_hash")
            for entry in counted
        }),
    }
    return manifest, effective_trial_count


def _load_entries(path: Path) -> list[Mapping[str, Any]]:
    if not path.exists():
        raise ValueError(f"cumulative trial ledger does not exist: {path}")
    entries: list[Mapping[str, Any]] = []
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not raw.strip():
            continue
        value = json.loads(raw)
        if not isinstance(value, Mapping):
            raise ValueError(f"cumulative trial ledger line {line_number} must be an object")
        if value.get("schema_version") != 1:
            raise ValueError(f"cumulative trial ledger line {line_number} schema_version must be 1")
        entries.append(value)
    if not entries:
        raise ValueError(f"cumulative trial ledger is empty: {path}")
    return entries


def _entry_strategy_id(entry: Mapping[str, Any]) -> str:
    return _required_string(entry, "candidate_strategy_id")


def _required_string(entry: Mapping[str, Any], field: str) -> str:
    value = entry.get(field)
    if not isinstance(value, str) or value.strip() == "":
        raise ValueError(f"cumulative trial ledger entry missing non-empty {field}")
    return value
