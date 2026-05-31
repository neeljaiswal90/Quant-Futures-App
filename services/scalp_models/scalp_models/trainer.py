"""Train calibrated RA-093 scalp setup models."""

from __future__ import annotations

import math
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from scalp_models.canonical import canonical_json, sha256_file, sha256_text
from scalp_models.dataset import (
    HORIZONS_SECONDS,
    SETUP_TYPES,
    DatasetConfig,
    TrainingExample,
    load_training_dataset,
)
from scalp_models.features import FEATURE_NAMES, feature_metadata
from scalp_models.gate import evaluate_model_gate


@dataclass(frozen=True)
class TrainingConfig:
    setup_path: Path
    labels_path: Path
    out_root: Path = Path("services/scalp_models/runs")
    target_ticks: float = 4.0
    min_positives: int = 30
    min_negatives: int = 30
    c_grid: tuple[float, ...] = (0.01, 0.1, 1.0, 10.0)
    random_state: int = 930
    tick_size: float = 0.25
    run_id: str | None = None
    horizons_seconds: tuple[int, ...] = HORIZONS_SECONDS


@dataclass(frozen=True)
class TrainingRunResult:
    run_dir: Path
    run_id: str
    report_path: Path
    metadata_paths: list[Path]
    model_paths: list[Path]


@dataclass(frozen=True)
class CellResult:
    setup_type: str
    horizon_seconds: int
    status: str
    positive_count: int
    negative_count: int
    excluded_by_status: dict[str, int]
    metadata: dict[str, Any]
    model_path: Path | None = None
    trial_report_paths: list[Path] = field(default_factory=list)


def train_models(config: TrainingConfig) -> TrainingRunResult:
    """Train all setup/horizon cells and write deterministic run artifacts."""

    dataset = load_training_dataset(
        setup_path=config.setup_path,
        labels_path=config.labels_path,
        config=DatasetConfig(
            target_ticks=config.target_ticks,
            tick_size=config.tick_size,
            horizons_seconds=config.horizons_seconds,
        ),
    )
    run_id = config.run_id or _derive_run_id(config)
    run_dir = config.out_root / run_id
    if run_dir.exists():
        shutil.rmtree(run_dir)
    (run_dir / "models").mkdir(parents=True)
    (run_dir / "metadata").mkdir()
    (run_dir / "trial_reports").mkdir()

    sklearn_versions = _sklearn_versions()
    _write_json(
        run_dir / "config.json",
        {
            "config_schema_version": 1,
            "setup_path": str(config.setup_path),
            "labels_path": str(config.labels_path),
            "setup_sha256": sha256_file(config.setup_path),
            "labels_sha256": sha256_file(config.labels_path),
            "target_ticks": config.target_ticks,
            "min_positives": config.min_positives,
            "min_negatives": config.min_negatives,
            "c_grid": list(config.c_grid),
            "random_state": config.random_state,
            "tick_size": config.tick_size,
            "horizons_seconds": list(config.horizons_seconds),
            "sklearn": sklearn_versions,
        },
    )
    _write_json(run_dir / "features.json", feature_metadata())
    (run_dir / "run_id").write_text(run_id, encoding="utf-8")

    cells: list[CellResult] = []
    for setup_type in SETUP_TYPES:
        for horizon in config.horizons_seconds:
            examples = [
                row
                for row in dataset.examples
                if row.setup_type == setup_type and row.horizon_seconds == horizon
            ]
            excluded = _excluded_for_cell(dataset.exclusion_counts, setup_type, horizon)
            cells.append(_train_cell(config, run_dir, setup_type, horizon, examples, excluded))

    report_path = run_dir / "calibration_report.md"
    report_path.write_text(_calibration_report(cells), encoding="utf-8")
    return TrainingRunResult(
        run_dir=run_dir,
        run_id=run_id,
        report_path=report_path,
        metadata_paths=[
            run_dir / "metadata" / f"{cell.setup_type}_{cell.horizon_seconds}s.json"
            for cell in cells
        ],
        model_paths=[cell.model_path for cell in cells if cell.model_path is not None],
    )


def _train_cell(
    config: TrainingConfig,
    run_dir: Path,
    setup_type: str,
    horizon: int,
    examples: list[TrainingExample],
    excluded_by_status: dict[str, int],
) -> CellResult:
    positive_count = sum(row.label for row in examples)
    negative_count = len(examples) - positive_count
    metadata_path = run_dir / "metadata" / f"{setup_type}_{horizon}s.json"
    if positive_count < config.min_positives or negative_count < config.min_negatives:
        metadata = {
            "metadata_schema_version": 1,
            "setup_type": setup_type,
            "horizon_seconds": horizon,
            "status": "insufficient_samples",
            "positive_count": positive_count,
            "negative_count": negative_count,
            "excluded_by_status": excluded_by_status,
            "minimums": {"positives": config.min_positives, "negatives": config.min_negatives},
            "recommended_action": "block",
        }
        _write_json(metadata_path, metadata)
        return CellResult(
            setup_type=setup_type,
            horizon_seconds=horizon,
            status="insufficient_samples",
            positive_count=positive_count,
            negative_count=negative_count,
            excluded_by_status=excluded_by_status,
            metadata=metadata,
        )

    model_path, metadata, trial_paths = _fit_model_cell(
        config=config,
        run_dir=run_dir,
        setup_type=setup_type,
        horizon=horizon,
        examples=examples,
        excluded_by_status=excluded_by_status,
        positive_count=positive_count,
        negative_count=negative_count,
    )
    _write_json(metadata_path, metadata)
    return CellResult(
        setup_type=setup_type,
        horizon_seconds=horizon,
        status=str(metadata["status"]),
        positive_count=positive_count,
        negative_count=negative_count,
        excluded_by_status=excluded_by_status,
        metadata=metadata,
        model_path=model_path,
        trial_report_paths=trial_paths,
    )


def _fit_model_cell(
    *,
    config: TrainingConfig,
    run_dir: Path,
    setup_type: str,
    horizon: int,
    examples: list[TrainingExample],
    excluded_by_status: dict[str, int],
    positive_count: int,
    negative_count: int,
) -> tuple[Path, dict[str, Any], list[Path]]:
    import joblib
    import numpy as np
    from sklearn.calibration import calibration_curve
    from sklearn.isotonic import IsotonicRegression
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import brier_score_loss, roc_auc_score
    from sklearn.preprocessing import StandardScaler

    examples = sorted(examples, key=lambda row: (row.session_key, row.ts_ns))
    folds = _temporal_folds(examples)
    c_metrics: list[tuple[float, float]] = []
    for c_value in config.c_grid:
        fold_briers: list[float] = []
        for fold in folds:
            if (
                len({row.label for row in fold["train"]}) < 2
                or len({row.label for row in fold["validation"]}) < 2
            ):
                continue
            pipeline = _pipeline(LogisticRegression, StandardScaler, c_value, config.random_state)
            pipeline.fit(_x(fold["train"], np), _y(fold["train"], np))
            probabilities = pipeline.predict_proba(_x(fold["validation"], np))[:, 1]
            fold_briers.append(float(brier_score_loss(_y(fold["validation"], np), probabilities)))
        c_metrics.append(
            (c_value, sum(fold_briers) / len(fold_briers) if fold_briers else math.inf)
        )
    best_c = min(c_metrics, key=lambda item: (item[1], item[0]))[0]

    method_scores: dict[str, list[float]] = {"platt": [], "isotonic": []}
    fold_metrics: list[dict[str, Any]] = []
    trial_paths: list[Path] = []
    for fold_index, fold in enumerate(folds, start=1):
        pipeline = _pipeline(LogisticRegression, StandardScaler, best_c, config.random_state)
        pipeline.fit(_x(fold["train"], np), _y(fold["train"], np))
        validation_x = _x(fold["validation"], np)
        validation_y = _y(fold["validation"], np)
        test_x = _x(fold["test"], np)
        test_y = _y(fold["test"], np)
        validation_scores = pipeline.decision_function(validation_x)

        platt = LogisticRegression(C=1.0, random_state=config.random_state, solver="liblinear")
        platt.fit(validation_scores.reshape(-1, 1), validation_y)
        isotonic = IsotonicRegression(out_of_bounds="clip")
        isotonic.fit(validation_scores, validation_y)

        platt_validation = platt.predict_proba(validation_scores.reshape(-1, 1))[:, 1]
        isotonic_validation = isotonic.predict(validation_scores)
        method_scores["platt"].append(float(brier_score_loss(validation_y, platt_validation)))
        method_scores["isotonic"].append(float(brier_score_loss(validation_y, isotonic_validation)))

        selected_method = _select_method(method_scores)
        test_scores = pipeline.decision_function(test_x)
        test_probabilities = (
            platt.predict_proba(test_scores.reshape(-1, 1))[:, 1]
            if selected_method == "platt"
            else isotonic.predict(test_scores)
        )
        fold_metric = _fold_metrics(
            test_y=test_y,
            probabilities=test_probabilities,
            brier_score_loss=brier_score_loss,
            roc_auc_score=roc_auc_score,
            calibration_curve=calibration_curve,
            test_samples=len(fold["test"]),
        )
        fold_metrics.append(fold_metric)
        trial_path = run_dir / "trial_reports" / f"{setup_type}_{horizon}s_fold{fold_index}.json"
        _write_json(
            trial_path,
            {
                "trial_report_schema_version": 1,
                "setup_type": setup_type,
                "horizon_seconds": horizon,
                "fold_index": fold_index,
                "target_ticks": config.target_ticks,
                "train_samples": len(fold["train"]),
                "validation_samples": len(fold["validation"]),
                "test_samples": len(fold["test"]),
                "metrics": fold_metric,
                "ts_validation_gate_bridge": {
                    "decision": "python_mirror",
                    "reason": "TS gate StrategyId contract does not accept setup+horizon cells",
                },
            },
        )
        trial_paths.append(trial_path)

    selected_method = _select_method(method_scores)
    final_train, final_calibration = _final_train_calibration_split(examples)
    final_pipeline = _pipeline(LogisticRegression, StandardScaler, best_c, config.random_state)
    final_pipeline.fit(_x(final_train, np), _y(final_train, np))
    calibration_scores = final_pipeline.decision_function(_x(final_calibration, np))
    if selected_method == "platt":
        calibrator = LogisticRegression(C=1.0, random_state=config.random_state, solver="liblinear")
        calibrator.fit(calibration_scores.reshape(-1, 1), _y(final_calibration, np))
    else:
        calibrator = IsotonicRegression(out_of_bounds="clip")
        calibrator.fit(calibration_scores, _y(final_calibration, np))

    model_path = run_dir / "models" / f"{setup_type}_{horizon}s.joblib"
    joblib.dump(
        {
            "model_schema_version": 1,
            "setup_type": setup_type,
            "horizon_seconds": horizon,
            "target_ticks": config.target_ticks,
            "feature_names": list(FEATURE_NAMES),
            "base_pipeline": final_pipeline,
            "calibration_method": selected_method,
            "calibrator": calibrator,
        },
        model_path,
    )
    gate = evaluate_model_gate(fold_metrics)
    metadata = {
        "metadata_schema_version": 1,
        "setup_type": setup_type,
        "horizon_seconds": horizon,
        "status": "trained",
        "positive_count": positive_count,
        "negative_count": negative_count,
        "excluded_by_status": excluded_by_status,
        "best_c": best_c,
        "calibration_method": selected_method,
        "calibration_method_brier": _average_method_scores(method_scores),
        "fold_metrics": fold_metrics,
        "gate": gate,
        "sample_counts": {
            "total": len(examples),
            "positive": positive_count,
            "negative": negative_count,
        },
        "model_path": str(model_path),
        "model_sha256": sha256_file(model_path),
        "recommended_action": _recommended_action(gate),
    }
    return model_path, metadata, trial_paths


def _pipeline(
    logistic_regression: Any,
    standard_scaler: Any,
    c_value: float,
    random_state: int,
) -> Any:
    from sklearn.pipeline import Pipeline

    return Pipeline(
        [
            ("scaler", standard_scaler()),
            (
                "model",
                logistic_regression(
                    C=c_value,
                    class_weight="balanced",
                    max_iter=1000,
                    random_state=random_state,
                    solver="liblinear",
                ),
            ),
        ]
    )


def _x(rows: list[TrainingExample], np: Any) -> Any:
    return np.array(
        [[row.feature_values[name] for name in FEATURE_NAMES] for row in rows],
        dtype=float,
    )


def _y(rows: list[TrainingExample], np: Any) -> Any:
    return np.array([row.label for row in rows], dtype=int)


def _temporal_folds(examples: list[TrainingExample]) -> list[dict[str, list[TrainingExample]]]:
    sessions = sorted({row.session_key for row in examples})
    if len(sessions) >= 5:
        train_count = max(2, int(len(sessions) * 0.6))
        validation_count = max(1, int(len(sessions) * 0.2))
        test_count = max(1, len(sessions) - train_count - validation_count)
        folds: list[dict[str, list[TrainingExample]]] = []
        for start in range(0, len(sessions) - train_count - validation_count - test_count + 1):
            train_sessions = set(sessions[start : start + train_count])
            validation_start = start + train_count
            validation_end = validation_start + validation_count
            test_start = validation_end
            test_end = test_start + test_count
            validation_sessions = set(sessions[validation_start:validation_end])
            test_sessions = set(sessions[test_start:test_end])
            folds.append(
                {
                    "train": [row for row in examples if row.session_key in train_sessions],
                    "validation": [
                        row for row in examples if row.session_key in validation_sessions
                    ],
                    "test": [row for row in examples if row.session_key in test_sessions],
                }
            )
        return folds
    first = max(2, int(len(examples) * 0.6))
    second = max(first + 2, int(len(examples) * 0.8))
    second = min(second, len(examples) - 1)
    return [
        {
            "train": examples[:first],
            "validation": examples[first:second],
            "test": examples[second:],
        }
    ]


def _final_train_calibration_split(
    examples: list[TrainingExample],
) -> tuple[list[TrainingExample], list[TrainingExample]]:
    split = max(2, int(len(examples) * 0.8))
    split = min(split, len(examples) - 2)
    return examples[:split], examples[split:]


def _fold_metrics(
    *,
    test_y: Any,
    probabilities: Any,
    brier_score_loss: Any,
    roc_auc_score: Any,
    calibration_curve: Any,
    test_samples: int,
) -> dict[str, Any]:
    brier = float(brier_score_loss(test_y, probabilities))
    try:
        auc = float(roc_auc_score(test_y, probabilities))
    except ValueError:
        auc = None
    try:
        predicted, realized = calibration_curve(
            test_y,
            probabilities,
            n_bins=10,
            strategy="quantile",
        )
        curve = [
            {"decile": index + 1, "predicted": float(pred), "realized": float(real)}
            for index, (pred, real) in enumerate(zip(predicted, realized, strict=False))
        ]
    except ValueError:
        curve = []
    calibration_error = (
        sum(abs(point["predicted"] - point["realized"]) for point in curve) / len(curve)
        if curve
        else 0.0
    )
    high_confident = probabilities >= 0.6
    hit_rate = float(test_y[high_confident].mean()) if int(high_confident.sum()) > 0 else None
    return {
        "test_samples": test_samples,
        "brier": brier,
        "auc": auc,
        "calibration_error": calibration_error,
        "hit_rate_at_predicted_ge_0_6": hit_rate,
        "reliability_curve": curve,
    }


def _select_method(method_scores: dict[str, list[float]]) -> str:
    averages = _average_method_scores(method_scores)
    return min(averages, key=lambda method: (averages[method], method))


def _average_method_scores(method_scores: dict[str, list[float]]) -> dict[str, float]:
    return {
        method: sum(values) / len(values) if values else math.inf
        for method, values in method_scores.items()
    }


def _recommended_action(gate: dict[str, Any]) -> str:
    if gate["status"] == "pass":
        return "green_light_live"
    if gate["status"] == "fail":
        return "green_light_shadow_only"
    return "block"


def _calibration_report(cells: list[CellResult]) -> str:
    lines = [
        "# RA-093 Calibration Report",
        "",
        "This report is a coordinator-review artifact. No live emission is enabled by RA-093.",
        "",
    ]
    for setup_type in SETUP_TYPES:
        lines.extend([f"## {setup_type}", ""])
        for cell in [item for item in cells if item.setup_type == setup_type]:
            metadata = cell.metadata
            lines.extend(
                [
                    f"### Horizon {cell.horizon_seconds}s",
                    "",
                    f"- Status: `{cell.status}`",
                    f"- Samples: +{cell.positive_count} / -{cell.negative_count}",
                    f"- Excluded by status: `{metadata.get('excluded_by_status', {})}`",
                    f"- Calibration method: `{metadata.get('calibration_method', 'n/a')}`",
                    f"- Gate status: `{metadata.get('gate', {}).get('status', 'n/a')}`",
                    f"- Recommended action: `{metadata.get('recommended_action', 'block')}`",
                    "",
                    "| Decile | Predicted | Realized |",
                    "|---:|---:|---:|",
                ]
            )
            curve = _aggregate_curve(metadata.get("fold_metrics", []))
            if curve:
                for point in curve:
                    lines.append(
                        "| "
                        f"{point['decile']} | "
                        f"{point['predicted']:.4f} | "
                        f"{point['realized']:.4f} |"
                    )
            else:
                lines.append("| n/a | n/a | n/a |")
            lines.extend(
                [
                    "",
                    (
                        "**Per-regime stratification:** not available until labeled "
                        "datasets span multiple regime-tagged sessions."
                    ),
                    "",
                ]
            )
    return "\n".join(lines).rstrip() + "\n"


def _aggregate_curve(fold_metrics: Any) -> list[dict[str, float]]:
    if not isinstance(fold_metrics, list):
        return []
    by_decile: dict[int, list[tuple[float, float]]] = {}
    for fold in fold_metrics:
        if not isinstance(fold, dict):
            continue
        curve = fold.get("reliability_curve")
        if not isinstance(curve, list):
            continue
        for point in curve:
            if not isinstance(point, dict):
                continue
            decile = int(point.get("decile") or 0)
            by_decile.setdefault(decile, []).append(
                (float(point.get("predicted") or 0.0), float(point.get("realized") or 0.0))
            )
    return [
        {
            "decile": decile,
            "predicted": sum(item[0] for item in values) / len(values),
            "realized": sum(item[1] for item in values) / len(values),
        }
        for decile, values in sorted(by_decile.items())
        if values
    ]


def _excluded_for_cell(counts: dict[str, int], setup_type: str, horizon: int) -> dict[str, int]:
    prefix = f"{setup_type}|{horizon}|"
    return {
        key.removeprefix(prefix): value
        for key, value in counts.items()
        if key.startswith(prefix)
    }


def _derive_run_id(config: TrainingConfig) -> str:
    payload = {
        "setup_path": str(config.setup_path),
        "labels_path": str(config.labels_path),
        "setup_sha256": sha256_file(config.setup_path),
        "labels_sha256": sha256_file(config.labels_path),
        "target_ticks": config.target_ticks,
        "min_positives": config.min_positives,
        "min_negatives": config.min_negatives,
        "c_grid": list(config.c_grid),
        "random_state": config.random_state,
        "horizons_seconds": list(config.horizons_seconds),
    }
    return sha256_text(canonical_json(payload))[:16]


def _sklearn_versions() -> dict[str, str]:
    import joblib
    import sklearn

    return {"scikit_learn": sklearn.__version__, "joblib": joblib.__version__}


def _write_json(path: Path, value: Any) -> None:
    path.write_text(canonical_json(value) + "\n", encoding="utf-8")
