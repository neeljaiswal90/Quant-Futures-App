"""Model-validation gate for RA-093 trial reports.

The existing TypeScript validation gate validates registered strategy runtime
IDs. RA-093 cells are ``setup_type × horizon`` model cells, not strategy IDs, so
this module mirrors the gate's evidence-first semantics without extending the
runtime strategy contract.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

GateStatus = Literal["pass", "fail", "insufficient_evidence"]


@dataclass(frozen=True)
class ModelGatePolicy:
    min_test_folds: int = 1
    min_test_samples_total: int = 20
    min_test_samples_per_fold: int = 5
    max_brier_score: float = 0.30
    min_auc: float = 0.50
    max_calibration_error: float = 0.25


def evaluate_model_gate(
    fold_metrics: list[dict[str, float | int | None]],
    policy: ModelGatePolicy | None = None,
) -> dict[str, object]:
    """Evaluate model folds with TS-gate-style evidence and threshold checks."""

    gate_policy = policy or ModelGatePolicy()
    test_folds = [fold for fold in fold_metrics if int(fold.get("test_samples") or 0) > 0]
    total_samples = sum(int(fold.get("test_samples") or 0) for fold in test_folds)
    reasons: list[str] = []
    checks: list[dict[str, object]] = []

    def add_check(name: str, passed: bool, observed: object, threshold: object) -> None:
        checks.append(
            {
                "name": name,
                "status": "pass" if passed else "fail",
                "observed": observed,
                "threshold": threshold,
            }
        )

    enough_folds = len(test_folds) >= gate_policy.min_test_folds
    add_check("test_fold_count", enough_folds, len(test_folds), gate_policy.min_test_folds)
    if not enough_folds:
        reasons.append("insufficient_test_folds")

    enough_total = total_samples >= gate_policy.min_test_samples_total
    add_check(
        "test_sample_count_total",
        enough_total,
        total_samples,
        gate_policy.min_test_samples_total,
    )
    if not enough_total:
        reasons.append("insufficient_test_samples")

    per_fold_ok = all(
        int(fold.get("test_samples") or 0) >= gate_policy.min_test_samples_per_fold
        for fold in test_folds
    )
    add_check(
        "test_sample_count_per_fold",
        per_fold_ok,
        total_samples,
        gate_policy.min_test_samples_per_fold,
    )
    if not per_fold_ok:
        reasons.append("insufficient_per_fold_samples")

    if reasons:
        return _result("insufficient_evidence", reasons, checks, gate_policy)

    mean_brier = _mean([_float(fold.get("brier")) for fold in test_folds])
    mean_auc = _mean(
        [_float(fold.get("auc")) for fold in test_folds if fold.get("auc") is not None]
    )
    mean_calibration_error = _mean([_float(fold.get("calibration_error")) for fold in test_folds])

    brier_ok = mean_brier <= gate_policy.max_brier_score
    auc_ok = mean_auc >= gate_policy.min_auc
    calibration_ok = mean_calibration_error <= gate_policy.max_calibration_error
    add_check("brier_score", brier_ok, round(mean_brier, 6), gate_policy.max_brier_score)
    add_check("auc", auc_ok, round(mean_auc, 6), gate_policy.min_auc)
    add_check(
        "calibration_error",
        calibration_ok,
        round(mean_calibration_error, 6),
        gate_policy.max_calibration_error,
    )
    if not brier_ok:
        reasons.append("brier_threshold_failed")
    if not auc_ok:
        reasons.append("auc_threshold_failed")
    if not calibration_ok:
        reasons.append("calibration_threshold_failed")
    return _result("fail" if reasons else "pass", reasons, checks, gate_policy)


def _result(
    status: GateStatus,
    reasons: list[str],
    checks: list[dict[str, object]],
    policy: ModelGatePolicy,
) -> dict[str, object]:
    return {
        "gate_schema_version": 1,
        "gate_name": "ra093_model_gate_mirror_v1",
        "status": status,
        "reasons": reasons,
        "checks": checks,
        "policy": policy.__dict__,
        "ts_validation_gate_mapping": {
            "decision": "python_mirror",
            "reason": (
                "backtester gate requires registered StrategyId; "
                "RA-093 cells are setup_type+horizon model cells"
            ),
            "shared_semantics": [
                "minimum evidence",
                "per-window evidence",
                "threshold failure reasons",
            ],
        },
    }


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0
