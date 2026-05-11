#!/usr/bin/env python3
"""QFA-611 strategy-selection driver.

Consumes QFA-410 held-out evidence artifacts and applies ADR-0016 Stage 1
criteria to the active strategy roster. Missing or invalid evidence is a
research/evidence state, not an alpha rejection.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

LIB_DIR = Path(__file__).resolve().parent / "_lib"
sys.path.insert(0, str(LIB_DIR))

from artifact_writer import write_canonical_json, write_lf_text
from decision import decide_strategy_verdict
from hac_sharpe import compute_hac_sharpe
from psr_dsr import compute_psr_dsr
from returns import assert_decimal_returns
from sensitivity_audit import compute_sensitivity_audit, load_fidelity_cells
from thresholds import ADR0016_STAGE1_THRESHOLDS, ANNUALIZATION_SESSIONS
from walk_forward_loader import load_held_out_artifact, load_parameter_lock_manifest


METHODOLOGY_ID = "adr-0016-v1"
PHASE4_HASH = "ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090"
PHASE2_HASH = "dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b"
STRATEGY_IDS_PATH = Path("apps/strategy_runtime/src/contracts/strategy-ids.ts")
DEFAULT_HELD_OUT_DIR = Path("artifacts/held-out-validation")
DEFAULT_REGIME_LABELS = Path("artifacts/regime/regime-labels.json")
DEFAULT_FIDELITY = Path("artifacts/regime-fidelity/qfa-402c-stratified-cells-v1.json")
DEFAULT_LOCK_MANIFEST = Path("artifacts/strategy-selection/qfa611-cycle1-parameter-locks.json")
DEFAULT_JSON_OUT = Path("artifacts/strategy-selection/strategy-selection-v1.json")
DEFAULT_MD_OUT = Path("artifacts/strategy-selection/strategy-selection-v1.md")
DEFAULT_STRATEGY_CONFIG_DIR = Path("config/strategies")
PARAMETER_LOCK_ALGORITHM = "qfa611_parameter_struct_v1"
EXECUTION_FRAGILITY_REASON_MARKERS = (
    "missing_cell_concentration",
    "low_fidelity_concentration",
    "high_residual_cell_trade_fraction",
    "low_fidelity_trade_fraction",
    "unknown_cell_trade_fraction",
    "execution_fragility",
    "execution_sensitivity_flag",
    "queue_fidelity_concentration",
    "slippage_or_fill_quality_proxy_failure",
)
REQUIRED_TRADE_FIELDS = (
    "regime",
    "spread_bucket",
    "queue_ahead_bucket",
    "gross_pnl_cents",
    "net_pnl_cents",
)


class EvidenceIncomplete(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def lf_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_text(encoding="utf-8").replace("\r", "").encode("utf-8")).hexdigest()


def active_strategy_ids() -> list[str]:
    text = STRATEGY_IDS_PATH.read_text(encoding="utf-8")
    match = re.search(r"ACTIVE_STRATEGY_IDS\s*=\s*\[(.*?)\]\s*as const", text, re.S)
    if not match:
        raise RuntimeError(f"Could not parse ACTIVE_STRATEGY_IDS from {STRATEGY_IDS_PATH}")
    ids = re.findall(r"'([^']+)'", match.group(1))
    if not ids:
        raise RuntimeError("ACTIVE_STRATEGY_IDS is empty")
    return ids


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def parse_yaml_scalar(raw: str) -> object:
    value = raw.strip()
    if value == "":
        return ""
    lowered = value.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    try:
        if any(token in value for token in (".", "e", "E")):
            return float(value)
        return int(value)
    except ValueError:
        return value.strip('"').strip("'")


def load_strategy_parameter_struct(strategy_id: str, config_dir: Path) -> dict[str, object]:
    """Load the simple Cycle1 strategy parameter YAML without adding PyYAML."""

    path = config_dir / f"{strategy_id}.yaml"
    if not path.exists():
        raise ValueError(f"runtime parameter config missing for {strategy_id}: {path}")

    parameters: dict[str, object] = {}
    in_parameters = False
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if not line.startswith(" ") and stripped.endswith(":"):
            in_parameters = stripped[:-1] == "parameters"
            continue
        if not line.startswith(" ") and ":" in stripped:
            key, value = stripped.split(":", 1)
            in_parameters = key == "parameters" and value.strip() == ""
            continue
        if in_parameters and ":" in stripped:
            key, value = stripped.split(":", 1)
            parameters[key.strip()] = parse_yaml_scalar(value)

    if not parameters:
        raise ValueError(f"runtime parameter config has no parameters for {strategy_id}: {path}")

    return {
        "parameter_lock_algorithm": PARAMETER_LOCK_ALGORITHM,
        "strategy_id": strategy_id,
        "parameters": parameters,
    }


def compute_runtime_parameter_hash(strategy_id: str, config_dir: Path) -> str:
    payload = load_strategy_parameter_struct(strategy_id, config_dir)
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def finite_or_none(value: float) -> float | None:
    return value if math.isfinite(value) else None


def artifact_path_for(held_out_dir: Path, strategy_id: str) -> Path:
    candidates = [
        held_out_dir / f"{strategy_id}-feb-mar-apr-2026.json",
        held_out_dir / f"{strategy_id}.json",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


def require_artifact_completeness(artifact: Mapping[str, Any]) -> None:
    for field in (
        "schema_version",
        "methodology_id",
        "strategy_id",
        "strategy_family",
        "parameter_lock_hash",
        "parameter_lock_source",
        "capability_status",
        "trades",
        "session_returns",
        "aggregate",
        "gating_pnl_basis",
    ):
        if field not in artifact:
            raise EvidenceIncomplete(f"missing_required_field:{field}")
    if artifact.get("gating_pnl_basis") != "net":
        raise EvidenceIncomplete("missing_or_wrong_pnl_basis")
    if artifact.get("capability_status") not in ("ready_for_replay", "ready_for_live"):
        raise EvidenceIncomplete("capability_not_ready")
    trades = artifact.get("trades")
    if not isinstance(trades, list):
        raise EvidenceIncomplete("missing_per_trade_metadata")
    for index, trade in enumerate(trades):
        if not isinstance(trade, Mapping):
            raise EvidenceIncomplete(f"invalid_trade_record:{index}")
        missing = [field for field in REQUIRED_TRADE_FIELDS if field not in trade]
        if missing:
            raise EvidenceIncomplete("missing_per_trade_metadata")
    returns = artifact.get("session_returns")
    if not isinstance(returns, list) or len(returns) < 2:
        raise EvidenceIncomplete("missing_session_returns")
    try:
        assert_decimal_returns([float(value) for value in returns])
    except (TypeError, ValueError) as error:
        raise EvidenceIncomplete(f"invalid_session_returns:{error}") from error


def profit_factor_from_aggregate(aggregate: Mapping[str, Any]) -> float | None:
    value = aggregate.get("profit_factor_ppm")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value) / 1_000_000.0
    return None


def int_cents(value: Any, field: str) -> int:
    if isinstance(value, bool):
        raise EvidenceIncomplete(f"invalid_money_field:{field}")
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return int(value)
    raise EvidenceIncomplete(f"invalid_money_field:{field}")


def initial_equity_cents(artifact: Mapping[str, Any]) -> int:
    windows = artifact.get("windows")
    if not isinstance(windows, list) or len(windows) == 0 or not isinstance(windows[0], Mapping):
        raise EvidenceIncomplete("missing_initial_equity")
    return int_cents(windows[0].get("initial_equity_cents"), "initial_equity_cents")


def regime_counts(trades: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    counts = {regime: 0 for regime in ("high", "mid", "low")}
    for trade in trades:
        regime = trade.get("regime")
        if regime in counts:
            counts[str(regime)] += 1
    total = len(trades)
    return {
        regime: {
            "trade_count": count,
            "trade_fraction": 0.0 if total == 0 else count / total,
        }
        for regime, count in counts.items()
    }


def compute_held_out_evidence(
    artifact: Mapping[str, Any],
    effective_trial_count: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    returns = [float(value) for value in artifact["session_returns"]]
    aggregate = artifact["aggregate"]
    if not isinstance(aggregate, Mapping):
        raise EvidenceIncomplete("invalid_aggregate")
    trades = artifact["trades"]
    if not isinstance(trades, list):
        raise EvidenceIncomplete("missing_per_trade_metadata")

    hac = compute_hac_sharpe(returns)
    psr_dsr = compute_psr_dsr(returns, effective_trial_count=effective_trial_count)
    initial_equity = initial_equity_cents(artifact)
    annualized_return = (sum(returns) / len(returns)) * ANNUALIZATION_SESSIONS
    max_drawdown_pct = int_cents(aggregate.get("max_drawdown_cents"), "max_drawdown_cents") / initial_equity
    profit_factor = profit_factor_from_aggregate(aggregate)
    win_rate_ppm = aggregate.get("win_rate_ppm")
    win_rate = None if win_rate_ppm is None else float(win_rate_ppm) / 1_000_000.0
    total_trades = int(aggregate.get("total_trades", len(trades)))

    evidence = {
        "total_trades": total_trades,
        "win_rate": win_rate,
        "profit_factor": profit_factor,
        "max_drawdown_pct": max_drawdown_pct,
        "annualized_return": annualized_return,
        "annualized_sharpe": hac.annualized_sharpe,
        "hac_standard_error_of_mean": hac.hac_standard_error_of_mean,
        "hac_t_stat": hac.hac_t_stat,
        "dsr_statistic": psr_dsr.dsr_statistic,
        "dsr_probability": psr_dsr.dsr_probability,
        "psr_zero_null": psr_dsr.psr_zero_null,
        "psr_hurdle_null": psr_dsr.psr_hurdle_null,
        "observation_unit": "session",
        "annualization_sessions": ANNUALIZATION_SESSIONS,
        "hac_bandwidth_lag": hac.bandwidth_lag,
        "per_regime": regime_counts(trades),
    }
    diagnostics = {
        "hac": asdict(hac),
        "psr_dsr": asdict(psr_dsr),
    }
    return evidence, diagnostics


def compute_threshold_results(evidence: Mapping[str, Any], sensitivity: Mapping[str, Any]) -> dict[str, bool]:
    thresholds = ADR0016_STAGE1_THRESHOLDS
    total_trades = int(evidence["total_trades"])
    per_regime = evidence["per_regime"]
    regime_trade_pass = False
    if total_trades > 0:
        regime_trade_pass = all(
            data["trade_count"] >= thresholds["per_regime_trades_min"]
            for data in per_regime.values()
            if data["trade_fraction"] >= thresholds["regime_trade_contribution_floor"]
        )
    profit_factor = evidence.get("profit_factor")
    return {
        "hurdle_pass": float(evidence["annualized_return"]) >= thresholds["annualized_return_min_decimal"],
        "sharpe_pass": float(evidence["annualized_sharpe"]) >= thresholds["annualized_sharpe_min"],
        "dsr_pass": float(evidence["dsr_statistic"]) >= thresholds["dsr_statistic_min"],
        "psr_zero_pass": float(evidence["psr_zero_null"]) >= thresholds["psr_zero_null_min"],
        "drawdown_pass": float(evidence["max_drawdown_pct"]) <= thresholds["max_drawdown_max_decimal"],
        "pf_pass": profit_factor is not None and float(profit_factor) >= thresholds["profit_factor_min"],
        "trade_count_pass": total_trades >= thresholds["total_trades_min"],
        "regime_trade_pass": regime_trade_pass,
        "sensitivity_audit_pass": not bool(sensitivity.get("flag")),
    }


def complete_strategy_entry(
    strategy_id: str,
    artifact: Mapping[str, Any],
    fidelity_cells: Mapping[tuple[str, str, str], Any],
    effective_trial_count: int,
    runtime_parameter_hash: str | None = None,
) -> dict[str, Any]:
    require_artifact_completeness(artifact)
    evidence, diagnostics = compute_held_out_evidence(artifact, effective_trial_count)
    sensitivity = compute_sensitivity_audit(artifact["trades"], fidelity_cells)
    thresholds = compute_threshold_results(evidence, sensitivity)
    decision = decide_strategy_verdict(evidence, thresholds, sensitivity)
    return {
        "strategy_id": strategy_id,
        "strategy_family": artifact["strategy_family"],
        "parameter_lock_source": artifact["parameter_lock_source"],
        "parameter_lock_hash": artifact["parameter_lock_hash"],
        "runtime_parameter_hash": runtime_parameter_hash,
        "evidence_package_status": "complete",
        "run_status": "complete",
        "held_out_evidence": evidence,
        "statistical_diagnostics": diagnostics,
        "threshold_results": thresholds,
        "sensitivity_audit": sensitivity,
        "verdict": decision["verdict"],
        "verdict_reason": decision["reason"],
    }


def incomplete_strategy_entry(strategy_id: str, reason: str) -> dict[str, Any]:
    return {
        "strategy_id": strategy_id,
        "strategy_family": None,
        "parameter_lock_source": None,
        "parameter_lock_hash": None,
        "runtime_parameter_hash": None,
        "evidence_package_status": "incomplete",
        "run_status": "partial_evidence",
        "held_out_evidence": None,
        "statistical_diagnostics": None,
        "threshold_results": None,
        "sensitivity_audit": None,
        "verdict": "RESEARCH_FURTHER",
        "verdict_reason": reason,
    }


def per_family_summary(per_strategy: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    families: dict[str, list[Mapping[str, Any]]] = {}
    for entry in per_strategy:
        family = entry.get("strategy_family") or "unknown"
        families.setdefault(str(family), []).append(entry)
    summary: dict[str, Any] = {}
    for family, entries in sorted(families.items()):
        dsr_values = [
            entry["held_out_evidence"]["dsr_statistic"]
            for entry in entries
            if isinstance(entry.get("held_out_evidence"), Mapping)
        ]
        dsr_values = sorted(float(value) for value in dsr_values if value is not None)
        median_dsr = None
        if dsr_values:
            mid = len(dsr_values) // 2
            median_dsr = dsr_values[mid] if len(dsr_values) % 2 else (dsr_values[mid - 1] + dsr_values[mid]) / 2
        summary[family] = {
            "strategy_count": len(entries),
            "advance_count": sum(1 for entry in entries if entry["verdict"] == "ADVANCE_TO_PAPER"),
            "reject_count": sum(1 for entry in entries if entry["verdict"] == "REJECT"),
            "research_further_count": sum(1 for entry in entries if entry["verdict"] == "RESEARCH_FURTHER"),
            "median_dsr_statistic": median_dsr,
        }
    return summary


def compute_execution_fragility(per_strategy: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    reasons: list[str] = []
    seen: set[str] = set()

    def append_reason(reason: str) -> None:
        if reason not in seen:
            seen.add(reason)
            reasons.append(reason)

    for entry in per_strategy:
        if entry.get("evidence_package_status") != "complete":
            continue
        strategy_id = str(entry.get("strategy_id", "unknown_strategy"))
        sensitivity = entry.get("sensitivity_audit")
        if isinstance(sensitivity, Mapping) and sensitivity.get("flag") is True:
            reason = str(sensitivity.get("reason") or "flagged")
            append_reason(f"{strategy_id}:sensitivity_audit_flag:{reason}")
            continue

        verdict_reason = str(entry.get("verdict_reason") or "")
        for marker in EXECUTION_FRAGILITY_REASON_MARKERS:
            if marker in verdict_reason:
                append_reason(f"{strategy_id}:verdict_reason:{marker}")
                break

    return {
        "execution_fragility": len(reasons) > 0,
        "execution_fragility_reasons": reasons,
    }


def build_selection(args: argparse.Namespace) -> dict[str, Any]:
    roster = args.strategy_ids or active_strategy_ids()
    if len(roster) == 0:
        raise RuntimeError("ACTIVE_STRATEGY_IDS empty")
    if args.lock_manifest.exists():
        locks = load_parameter_lock_manifest(args.lock_manifest)
    else:
        locks = {}
    fidelity_cells = load_fidelity_cells(args.fidelity)
    per_strategy: list[dict[str, Any]] = []
    effective_trial_count = max(len(roster), len(locks))

    for strategy_id in roster:
        path = artifact_path_for(args.held_out_dir, strategy_id)
        if not path.exists():
            per_strategy.append(incomplete_strategy_entry(strategy_id, "missing_held_out_artifact"))
            continue
        try:
            if args.lock_manifest.exists():
                artifact = load_held_out_artifact(path, args.lock_manifest)
            else:
                artifact = load_json(path)
                if artifact.get("gating_pnl_basis") != "net":
                    raise EvidenceIncomplete("missing_or_wrong_pnl_basis")
            runtime_parameter_hash = None
            if args.lock_manifest.exists() and not args.skip_runtime_parameter_hash:
                runtime_parameter_hash = compute_runtime_parameter_hash(strategy_id, args.strategy_config_dir)
                artifact_hash = str(artifact.get("parameter_lock_hash"))
                manifest_hash = locks.get(strategy_id)
                if runtime_parameter_hash != artifact_hash or (
                    manifest_hash is not None and runtime_parameter_hash != manifest_hash
                ):
                    raise ValueError("parameter_lock_hash mismatch: runtime_parameter_hash")
            per_strategy.append(
                complete_strategy_entry(
                    strategy_id,
                    artifact,
                    fidelity_cells,
                    effective_trial_count,
                    runtime_parameter_hash=runtime_parameter_hash,
                )
            )
        except EvidenceIncomplete as error:
            per_strategy.append(incomplete_strategy_entry(strategy_id, error.reason))
        except ValueError as error:
            reason = str(error)
            if "gating_pnl_basis" in reason:
                reason = "missing_or_wrong_pnl_basis"
            elif "parameter_lock_hash" in reason:
                reason = "parameter_lock_violation"
            per_strategy.append(incomplete_strategy_entry(strategy_id, reason))

    final_roster = args.strategy_ids or active_strategy_ids()
    if final_roster != roster:
        raise RuntimeError("ACTIVE_STRATEGY_IDS changed during QFA-611 run")

    advance_count = sum(1 for entry in per_strategy if entry["verdict"] == "ADVANCE_TO_PAPER")
    research_count = sum(1 for entry in per_strategy if entry["verdict"] == "RESEARCH_FURTHER")
    reject_count = sum(1 for entry in per_strategy if entry["verdict"] == "REJECT")
    partial_evidence = any(entry["evidence_package_status"] == "incomplete" for entry in per_strategy)
    run_status = "partial_evidence" if partial_evidence else "complete"
    execution_fragility = compute_execution_fragility(per_strategy)

    return {
        "schema_version": 1,
        "methodology_id": METHODOLOGY_ID,
        "input_substrate_hash": lf_sha256(args.regime_labels) if args.regime_labels.exists() else None,
        "input_phase2_hash": PHASE2_HASH,
        "input_phase4_hash": PHASE4_HASH,
        "active_strategy_ids": roster,
        "cf29_roster_count_note": "Methodology is count-agnostic; roster is locked at Step 0 for this run.",
        "bootstrap_seed": args.bootstrap_seed,
        "effective_trial_count": effective_trial_count,
        "thresholds": ADR0016_STAGE1_THRESHOLDS,
        "run_status": run_status,
        "run_outcome": "partial_evidence" if partial_evidence else ("advance_present" if advance_count > 0 else "all_reject"),
        "execution_fragility": execution_fragility["execution_fragility"],
        "execution_fragility_reasons": execution_fragility["execution_fragility_reasons"],
        "per_family_summary": per_family_summary(per_strategy),
        "per_strategy": per_strategy,
        "summary": {
            "advance_count": advance_count,
            "research_further_count": research_count,
            "reject_count": reject_count,
            "phase_6_dispatch_authorized": run_status == "complete" and advance_count > 0,
        },
        "generated_at_note": "Deterministic QFA-611 driver; no wall-clock timestamp emitted.",
    }


def write_markdown(selection: Mapping[str, Any], output: Path) -> None:
    lines = [
        "# QFA-611 strategy selection v1",
        "",
        f"- Run status: `{selection['run_status']}`",
        f"- Phase 6 dispatch authorized: `{selection['summary']['phase_6_dispatch_authorized']}`",
        f"- Execution fragility: `{selection['execution_fragility']}`",
        "",
        "| Strategy | Verdict | Evidence status | Reason |",
        "|---|---|---|---|",
    ]
    for entry in selection["per_strategy"]:
        lines.append(
            f"| `{entry['strategy_id']}` | {entry['verdict']} | "
            f"{entry['evidence_package_status']} | {entry['verdict_reason']} |"
        )
    write_lf_text("\n".join(lines), output)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run QFA-611 strategy selection")
    parser.add_argument("--held-out-dir", type=Path, default=DEFAULT_HELD_OUT_DIR)
    parser.add_argument("--regime-labels", type=Path, default=DEFAULT_REGIME_LABELS)
    parser.add_argument("--fidelity", type=Path, default=DEFAULT_FIDELITY)
    parser.add_argument("--lock-manifest", type=Path, default=DEFAULT_LOCK_MANIFEST)
    parser.add_argument("--bootstrap-seed", type=int, default=42)
    parser.add_argument("--json-out", type=Path, default=DEFAULT_JSON_OUT)
    parser.add_argument("--md-out", type=Path, default=DEFAULT_MD_OUT)
    parser.add_argument("--strategy-ids", nargs="*", default=None)
    parser.add_argument("--strategy-config-dir", type=Path, default=DEFAULT_STRATEGY_CONFIG_DIR)
    parser.add_argument(
        "--skip-runtime-parameter-hash",
        action="store_true",
        help="Test-only escape hatch for synthetic held-out fixtures without real strategy configs.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    selection = build_selection(args)
    write_canonical_json(selection, args.json_out)
    write_markdown(selection, args.md_out)
    print(json.dumps(selection["summary"], indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
