#!/usr/bin/env python3
"""QFA-611 strategy-selection artifact generator.

Applies ADR-0016 Stage 1 evidence-package gates to ACTIVE_STRATEGY_IDS.
This script is intentionally conservative: it does not synthesize held-out
trade evidence when QFA-410 validation-grade per-strategy artifacts are absent.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import OrderedDict
from pathlib import Path
from typing import Any

METHODOLOGY_ID = "adr-0016-v1"
PHASE4_HASH = "ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090"
PHASE2_HASH = "dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b"
SELECTION_SCHEMA_VERSION = 1

STRATEGY_IDS_PATH = Path("apps/strategy_runtime/src/contracts/strategy-ids.ts")
REGIME_LABELS_PATH = Path("artifacts/regime/regime-labels.json")
REGIME_FIDELITY_PATH = Path("artifacts/regime-fidelity/regime-stratified-fidelity-v1.json")
MANIFEST_PATHS = OrderedDict([
    ("2026-02", Path("config/research/manifests/manifest-feb-2026.json")),
    ("2026-03", Path("config/research/manifests/manifest-mar-2026.json")),
    ("2026-04", Path("config/research/manifests/manifest-apr-2026.json")),
])
ADR_PATH = Path("docs/adr/ADR-0016-qfa-611-alpha-decision-criteria.md")
OUTPUT_JSON = Path("artifacts/strategy-selection/strategy-selection-v1.json")
OUTPUT_MD = Path("docs/research/qfa-611-strategy-selection.md")

THRESHOLDS = OrderedDict([
    ("annualized_hurdle_rate", 0.12),
    ("min_hac_sharpe", 1.0),
    ("min_dsr", 0.0),
    ("min_psr_zero_null", 0.80),
    ("max_drawdown_pct", 0.08),
    ("min_profit_factor", 1.35),
    ("min_total_trades", 300),
    ("min_regime_trades_when_regime_contributes_ge_10pct", 30),
    ("sensitivity_concentration_fraction", 0.30),
    ("low_fidelity_cell_threshold_ppm", 750_000),
])


def lf_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_text(encoding="utf-8").replace("\r", "").encode("utf-8")).hexdigest()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def active_strategy_ids() -> list[str]:
    text = STRATEGY_IDS_PATH.read_text(encoding="utf-8")
    match = re.search(r"ACTIVE_STRATEGY_IDS\s*=\s*\[(.*?)\]\s*as const", text, re.S)
    if not match:
        raise RuntimeError(f"Could not parse ACTIVE_STRATEGY_IDS from {STRATEGY_IDS_PATH}")
    ids = re.findall(r"'([^']+)'", match.group(1))
    if not ids:
        raise RuntimeError("ACTIVE_STRATEGY_IDS is empty")
    return ids


def config_hash(strategy_id: str) -> str | None:
    path = Path("config/strategies") / f"{strategy_id}.yaml"
    if not path.exists():
        return None
    return lf_sha256(path)


def regime_summary(regime_labels: dict[str, Any]) -> OrderedDict[str, Any]:
    counts = OrderedDict((label, 0) for label in ["high", "mid", "low"])
    excluded: list[dict[str, Any]] = []
    for label in regime_labels.get("labels", []):
        confirmed = label.get("confirmed_label")
        if label.get("quality_excluded") is True:
            excluded.append(OrderedDict([
                ("session_id", label.get("session_id")),
                ("confirmed_label", confirmed),
                ("quality_exclusion_reason", label.get("quality_exclusion_reason")),
            ]))
            continue
        if label.get("use_for_calibration") is False:
            continue
        if confirmed in counts:
            counts[confirmed] += 1
    return OrderedDict([
        ("calibration_eligible_counts", counts),
        ("quality_excluded_sessions", excluded),
        ("secondary_percentile_basis", regime_labels.get("secondary_substrate", {}).get("percentile_basis")),
    ])


def fidelity_summary(regime_fidelity: dict[str, Any]) -> OrderedDict[str, Any]:
    return OrderedDict([
        ("methodology_id", regime_fidelity.get("methodology_id")),
        ("primary_verdict", regime_fidelity.get("primary_verdict")),
        ("twenty_one_plus_warning_flag", regime_fidelity.get("twenty_one_plus_warning_flag")),
        ("mid_anomaly_flag", regime_fidelity.get("mid_anomaly_flag")),
        ("per_regime_equal_weight", regime_fidelity.get("per_regime_equal_weight")),
        ("per_regime_probe_weighted", regime_fidelity.get("per_regime_probe_weighted")),
    ])


def unavailable_held_out_evidence() -> OrderedDict[str, Any]:
    per_regime = OrderedDict()
    for regime in ["high", "mid", "low"]:
        per_regime[regime] = OrderedDict([
            ("trades", 0),
            ("session_count", 0),
            ("annualized_return", None),
            ("annualized_sharpe_HAC", None),
            ("profit_factor", None),
            ("max_drawdown_pct", None),
        ])
    return OrderedDict([
        ("total_trades", 0),
        ("win_rate", None),
        ("profit_factor", None),
        ("max_drawdown_pct", None),
        ("annualized_return", None),
        ("annualized_sharpe_HAC", None),
        ("hac_bandwidth_lag", None),
        ("dsr", None),
        ("psr_zero_null", None),
        ("psr_hurdle_null", None),
        ("observation_unit", "session"),
        ("per_regime", per_regime),
    ])


def threshold_results() -> OrderedDict[str, bool]:
    return OrderedDict([
        ("hurdle_pass", False),
        ("sharpe_pass", False),
        ("dsr_pass", False),
        ("psr_zero_pass", False),
        ("drawdown_pass", False),
        ("pf_pass", False),
        ("trade_count_pass", False),
        ("regime_trade_pass", False),
        ("sensitivity_audit_pass", False),
    ])


def sensitivity_audit_unavailable() -> OrderedDict[str, Any]:
    return OrderedDict([
        ("status", "not_evaluable_no_held_out_trades"),
        ("flag", False),
        ("high_residual_cell_trade_fraction", None),
        ("flagged_cells", []),
        ("reason", "No validation-grade per-trade held-out record is present, so LD-611-1 concentration audit cannot be computed."),
    ])


def per_strategy_entry(strategy_id: str) -> OrderedDict[str, Any]:
    cfg_hash = config_hash(strategy_id)
    missing = [
        "validation_grade_qfa301_replay_sanity_artifact",
        "pinned_qfa302_strategy_fingerprint_artifact",
        "qfa303_ready_for_replay_or_ready_for_live_capability_artifact",
        "qfa410_per_trade_held_out_validation_artifact",
        "qfa310_primary_pass_artifact_for_feb_mar_apr_test_windows",
    ]
    return OrderedDict([
        ("strategy_id", strategy_id),
        ("evidence_package_status", "incomplete"),
        ("evidence_package", OrderedDict([
            ("qfa301_replay_sanity", "missing_validation_grade_artifact"),
            ("qfa302_fingerprint", "missing_pinned_artifact"),
            ("qfa303_capability", "missing_ready_capability_artifact"),
            ("qfa410_held_out_validation", "missing_per_trade_held_out_artifact"),
            ("qfa310_validation_gate", "missing_primary_pass_artifact"),
            ("strategy_config_sha256", cfg_hash),
            ("missing_components", missing),
        ])),
        ("held_out_evidence", unavailable_held_out_evidence()),
        ("threshold_results", threshold_results()),
        ("sensitivity_audit", sensitivity_audit_unavailable()),
        ("verdict", "REJECT"),
        ("verdict_reason", "LD-611-1 evidence package incomplete: no validation-grade QFA-410 per-trade/session held-out evidence is present for this strategy; statistical Stage 1 thresholds are therefore not evaluable."),
    ])


def build_selection() -> OrderedDict[str, Any]:
    for path in [ADR_PATH, REGIME_LABELS_PATH, REGIME_FIDELITY_PATH, *MANIFEST_PATHS.values()]:
        if not path.exists():
            raise FileNotFoundError(path)
    strategy_ids = active_strategy_ids()
    regime_labels = load_json(REGIME_LABELS_PATH)
    regime_fidelity = load_json(REGIME_FIDELITY_PATH)
    per_strategy = [per_strategy_entry(strategy_id) for strategy_id in strategy_ids]
    advance_count = sum(1 for item in per_strategy if item["verdict"] == "ADVANCE_TO_PAPER")
    research_count = sum(1 for item in per_strategy if item["verdict"] == "RESEARCH_FURTHER")
    reject_count = sum(1 for item in per_strategy if item["verdict"] == "REJECT")
    return OrderedDict([
        ("schema_version", SELECTION_SCHEMA_VERSION),
        ("methodology_id", METHODOLOGY_ID),
        ("methodology_source", "docs/adr/ADR-0016-qfa-611-alpha-decision-criteria.md"),
        ("input_substrate_hash", lf_sha256(REGIME_LABELS_PATH)),
        ("input_phase2_hash", PHASE2_HASH),
        ("input_phase4_hash", PHASE4_HASH),
        ("input_manifest_hashes", OrderedDict((key, lf_sha256(path)) for key, path in MANIFEST_PATHS.items())),
        ("active_strategy_ids", strategy_ids),
        ("active_strategy_count", len(strategy_ids)),
        ("cf29_roster_count_note", "ACTIVE_STRATEGY_IDS count is descriptive and count-agnostic; this run applies ADR-0016 to the canonical non-empty roster."),
        ("thresholds", THRESHOLDS),
        ("regime_substrate_summary", regime_summary(regime_labels)),
        ("regime_fidelity_summary", fidelity_summary(regime_fidelity)),
        ("trial_accounting", OrderedDict([
            ("effective_trial_method", "max_of_manual_and_distinct_fingerprints"),
            ("manual_declared_effective_trials", len(strategy_ids)),
            ("distinct_window_fingerprint_tuples", None),
            ("effective_trial_count", len(strategy_ids)),
            ("note", "No validation-grade QFA-410 window fingerprints are present; effective trial count records the actual candidate roster count for this incomplete-evidence run."),
        ])),
        ("per_strategy", per_strategy),
        ("summary", OrderedDict([
            ("advance_count", advance_count),
            ("research_further_count", research_count),
            ("reject_count", reject_count),
            ("phase_6_dispatch_authorized", advance_count > 0),
            ("primary_blocker", "missing_validation_grade_per_strategy_evidence_package"),
            ("recommended_next_action", "Produce validation-grade QFA-301/QFA-302/QFA-303/QFA-410 evidence packages before re-running QFA-611."),
        ])),
        ("generated_at_note", "Deterministic QFA-611 selection script; no wall-clock timestamp emitted."),
    ])


def write_json(selection: OrderedDict[str, Any], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(selection, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def fmt(value: Any) -> str:
    if value is None:
        return "n/a"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def write_markdown(selection: OrderedDict[str, Any], output: Path) -> None:
    lines: list[str] = []
    lines.append("# QFA-611 strategy selection v1")
    lines.append("")
    lines.append("## Status")
    lines.append("")
    lines.append("REJECT all current candidates because ADR-0016 LD-611-1 evidence packages are incomplete.")
    lines.append("")
    lines.append("This is an implementation result, not a methodology amendment. ADR-0016 is applied count-agnostically to the canonical 4-strategy roster per CF-29.")
    lines.append("")
    lines.append("## Inputs")
    lines.append("")
    lines.append(f"- Methodology: `{selection['methodology_id']}`")
    lines.append(f"- Phase 2 hash: `{selection['input_phase2_hash']}`")
    lines.append(f"- Phase 4 hash: `{selection['input_phase4_hash']}`")
    lines.append(f"- Regime substrate hash: `{selection['input_substrate_hash']}`")
    lines.append("- Active strategy roster: " + ", ".join(f"`{s}`" for s in selection["active_strategy_ids"]))
    lines.append("")
    lines.append("## Regime substrate context")
    lines.append("")
    counts = selection["regime_substrate_summary"]["calibration_eligible_counts"]
    lines.append("| Regime | Calibration-eligible sessions |")
    lines.append("|---|---:|")
    for regime in ["high", "mid", "low"]:
        lines.append(f"| {regime} | {counts[regime]} |")
    lines.append("")
    lines.append("QFA-420 Outcome A remains the system-level fidelity context; no regime-conditioned sizing or threshold changes are introduced.")
    lines.append("")
    lines.append("## Evidence-package finding")
    lines.append("")
    lines.append("The repository currently contains strategy source/configuration plus QFA-301/302/303/410 framework code, but it does not contain validation-grade per-strategy QFA-410 held-out trade artifacts for Feb-Mar-Apr 2026. Existing replay-sanity fixtures are diagnostics and QFA-303 explicitly treats replay-sanity placeholder features as degraded replay, which cannot pass QFA-310.")
    lines.append("")
    lines.append("Per ADR-0016 LD-611-1, QFA-611 must not fabricate held-out returns when this evidence package is missing. The Stage 1 statistical metrics are therefore not evaluable.")
    lines.append("")
    lines.append("## Per-strategy verdicts")
    lines.append("")
    lines.append("| Strategy | Verdict | Evidence status | Trades | Sharpe HAC | DSR | PSR zero | PSR hurdle | Max DD | PF | Reason |")
    lines.append("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|")
    for item in selection["per_strategy"]:
        ev = item["held_out_evidence"]
        lines.append("| " + " | ".join([
            f"`{item['strategy_id']}`",
            item["verdict"],
            item["evidence_package_status"],
            fmt(ev["total_trades"]),
            fmt(ev["annualized_sharpe_HAC"]),
            fmt(ev["dsr"]),
            fmt(ev["psr_zero_null"]),
            fmt(ev["psr_hurdle_null"]),
            fmt(ev["max_drawdown_pct"]),
            fmt(ev["profit_factor"]),
            item["verdict_reason"],
        ]) + " |")
    lines.append("")
    lines.append("## Threshold application")
    lines.append("")
    lines.append("All Stage 1 quantitative threshold booleans are false because the required held-out evidence is unavailable, not because measured alpha failed. This distinction matters for next dispatch: the blocker is evidence construction, not strategy performance inference.")
    lines.append("")
    lines.append("## Sensitivity audit")
    lines.append("")
    lines.append("The LD-611-1 strategy-level execution sensitivity audit is not evaluable without per-trade held-out records containing regime / spread / queue-ahead cells. The system-level QFA-420 21+ warning flag remains false, but no strategy-specific concentration claim is made.")
    lines.append("")
    lines.append("## Verdict summary")
    lines.append("")
    summary = selection["summary"]
    lines.append(f"- ADVANCE_TO_PAPER: {summary['advance_count']}")
    lines.append(f"- RESEARCH_FURTHER: {summary['research_further_count']}")
    lines.append(f"- REJECT: {summary['reject_count']}")
    lines.append(f"- Phase 6 dispatch authorized: {fmt(summary['phase_6_dispatch_authorized'])}")
    lines.append("")
    lines.append("## Recommended next coordinator action")
    lines.append("")
    lines.append("Do not dispatch Phase 6 paper/live tickets yet. The next enabling ticket should construct validation-grade per-strategy evidence packages: QFA-410 per-trade held-out replay output, QFA-302 pinned fingerprints, QFA-303 ready capability assessments, and QFA-310 primary pass artifacts for each active strategy. Then rerun QFA-611 against those artifacts.")
    lines.append("")
    lines.append("## Scope discipline")
    lines.append("")
    lines.append("No ADR, QFA-105, QFA-402, strategy formula, RunSpec, journal, determinism-gate, VIX/VXN, regime-label, or manifest changes are made by this ticket.")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate QFA-611 strategy-selection artifacts")
    parser.add_argument("--json-out", type=Path, default=OUTPUT_JSON)
    parser.add_argument("--md-out", type=Path, default=OUTPUT_MD)
    args = parser.parse_args()
    selection = build_selection()
    write_json(selection, args.json_out)
    write_markdown(selection, args.md_out)
    print(json.dumps(OrderedDict([
        ("json_out", str(args.json_out)),
        ("md_out", str(args.md_out)),
        ("active_strategy_count", selection["active_strategy_count"]),
        ("advance_count", selection["summary"]["advance_count"]),
        ("research_further_count", selection["summary"]["research_further_count"]),
        ("reject_count", selection["summary"]["reject_count"]),
        ("phase_6_dispatch_authorized", selection["summary"]["phase_6_dispatch_authorized"]),
    ]), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
