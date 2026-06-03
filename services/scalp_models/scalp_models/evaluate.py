"""RA-094 shadow-mode performance evaluator.

Given a trained run and a fresh session's setups + labels, computes
the predicted-vs-realized metrics that decide whether the model is
performing as the calibration report claimed it would.

Reuses ``load_training_dataset`` for the (setup, label) join so the
evaluation pipeline cannot accidentally diverge from the training-time
join semantics. Setups without matching labels (still in-flight, no
trades in horizon, etc.) are excluded with the same status taxonomy
the trainer uses — and surfaced in the report so the operator sees
the eligible-sample count, not just the headline metric.

Output is a markdown performance report (mirrors the structure of the
trainer's ``calibration_report.md``) plus a JSON sidecar with the raw
per-(setup, horizon) numbers for downstream automation.

Metrics computed per (setup_type, horizon):

* sample counts: total / positives / negatives / excluded by status
* AUC (sklearn.roc_auc_score) — discrimination
* Brier score — calibration + discrimination combined
* Log loss — calibration + discrimination combined
* calibration error — mean |predicted - realized| across decile bins
* reliability curve — per-decile (predicted, realized) pairs
* hit rate at threshold — % of predictions where p_cal >= T that hit y=1

Thresholds default to [0.5, 0.6, 0.7] to match the trainer's
``hit_rate_at_predicted_ge_0_6`` field for direct comparison.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score

from scalp_models.dataset import DatasetConfig, load_training_dataset
from scalp_models.inference import ScalpModelInferenceBundle


DEFAULT_THRESHOLDS: tuple[float, ...] = (0.5, 0.6, 0.7)


@dataclass(frozen=True, slots=True)
class CellMetrics:
    """Per-(setup_type, horizon) performance metrics."""
    setup_type: str
    horizon_seconds: int
    n_total: int
    n_positive: int
    n_negative: int
    auc: float | None
    brier: float | None
    log_loss: float | None
    calibration_error: float | None
    reliability_curve: list[dict[str, Any]]
    hit_rate_at_threshold: dict[str, dict[str, Any]]
    realized_positive_rate: float | None
    mean_predicted: float | None
    note: str | None = None


@dataclass(frozen=True, slots=True)
class EvaluationResult:
    cells: list[CellMetrics]
    n_setup_rows: int
    n_label_rows: int
    n_excluded_by_status: dict[str, int]
    run_dir: str
    setups_path: str
    labels_path: str


def _safe_metric(metric_fn, y, p) -> float | None:
    """Compute a sklearn metric with single-class guards. Returns None when
    the metric is undefined (e.g. AUC with only one class)."""
    try:
        if len(set(y)) < 2:
            return None
        return float(metric_fn(y, p))
    except (ValueError, ZeroDivisionError):
        return None


def _reliability_curve(y, p, n_bins: int = 10) -> tuple[list[dict[str, Any]], float | None]:
    """Manual reliability curve to avoid sklearn's calibration_curve
    re-sampling behavior (we want raw decile-binning).

    Returns (per-bin records, mean |predicted - realized| weighted by bin size).
    """
    if len(y) == 0:
        return [], None
    y = np.asarray(y, dtype=float)
    p = np.asarray(p, dtype=float)
    # Per-decile binning by predicted probability
    sorted_idx = np.argsort(p)
    bins = np.array_split(sorted_idx, min(n_bins, max(1, len(y))))
    rows: list[dict[str, Any]] = []
    weighted_err = 0.0
    total = 0
    for i, idx in enumerate(bins):
        if len(idx) == 0:
            continue
        bin_p = float(p[idx].mean())
        bin_y = float(y[idx].mean())
        rows.append({
            "decile": i + 1,
            "n": int(len(idx)),
            "predicted": bin_p,
            "realized": bin_y,
        })
        weighted_err += abs(bin_p - bin_y) * len(idx)
        total += len(idx)
    cal_err = weighted_err / total if total > 0 else None
    return rows, cal_err


def _hit_rate_at_threshold(y, p, thresholds: Iterable[float]) -> dict[str, dict[str, Any]]:
    """For each threshold T, computes:
      n_above_t: number of predictions with p >= T
      hit_rate: fraction of those that had y=1
      base_rate: y.mean() (for comparison — would the threshold beat the unconditional rate?)
    """
    y = np.asarray(y, dtype=float)
    p = np.asarray(p, dtype=float)
    base = float(y.mean()) if len(y) else None
    out: dict[str, dict[str, Any]] = {}
    for t in thresholds:
        mask = p >= t
        n_above = int(mask.sum())
        hit = float(y[mask].mean()) if n_above > 0 else None
        out[f"{t:.2f}"] = {
            "n_above": n_above,
            "hit_rate": hit,
            "base_rate": base,
            "lift": (hit - base) if (hit is not None and base is not None) else None,
        }
    return out


def evaluate(
    *,
    run_dir: Path,
    setups_path: Path,
    labels_path: Path,
    target_ticks: float = 4.0,
    thresholds: Iterable[float] = DEFAULT_THRESHOLDS,
) -> EvaluationResult:
    """Score every eligible (setup, label) example and compute per-cell metrics.

    Reuses ``load_training_dataset`` for the join so eligibility is
    determined by the same status taxonomy as the trainer's calibration report.
    """
    bundle = ScalpModelInferenceBundle(run_dir)
    dataset_config = DatasetConfig(target_ticks=target_ticks)
    dataset = load_training_dataset(
        setup_path=setups_path,
        labels_path=labels_path,
        config=dataset_config,
    )

    # Group eligible examples by (setup_type, horizon) so we batch-score
    # within each cell.
    by_cell: dict[tuple[str, int], list] = {}
    for ex in dataset.examples:
        by_cell.setdefault((ex.setup_type, ex.horizon_seconds), []).append(ex)

    cells: list[CellMetrics] = []
    for (setup_type, horizon), examples in sorted(by_cell.items()):
        ys: list[int] = []
        ps: list[float] = []
        # Score each example.  If the bundle doesn't have a model for this
        # (setup_type, horizon), surface the cell as 'no_model' so the report
        # is explicit about which cells we attempted vs deferred.
        no_model = False
        for ex in examples:
            result = bundle.score(
                ex.setup_row,
                setup_type=ex.setup_type,
                horizon_seconds=ex.horizon_seconds,
                tick_size=dataset_config.tick_size,
            )
            if result is None:
                no_model = True
                break
            ys.append(int(ex.label))
            ps.append(float(result.p_calibrated))
        if no_model:
            cells.append(CellMetrics(
                setup_type=setup_type, horizon_seconds=horizon,
                n_total=0, n_positive=0, n_negative=0,
                auc=None, brier=None, log_loss=None, calibration_error=None,
                reliability_curve=[], hit_rate_at_threshold={},
                realized_positive_rate=None, mean_predicted=None,
                note=f"no_model_in_bundle: {setup_type}/{horizon}s",
            ))
            continue

        n_pos = sum(1 for v in ys if v == 1)
        rel_curve, cal_err = _reliability_curve(ys, ps)
        cells.append(CellMetrics(
            setup_type=setup_type,
            horizon_seconds=horizon,
            n_total=len(ys),
            n_positive=n_pos,
            n_negative=len(ys) - n_pos,
            auc=_safe_metric(roc_auc_score, ys, ps),
            brier=_safe_metric(brier_score_loss, ys, ps),
            log_loss=_safe_metric(
                lambda y, p: log_loss(y, p, labels=[0, 1]), ys, ps,
            ),
            calibration_error=cal_err,
            reliability_curve=rel_curve,
            hit_rate_at_threshold=_hit_rate_at_threshold(ys, ps, thresholds),
            realized_positive_rate=(n_pos / len(ys)) if ys else None,
            mean_predicted=float(np.mean(ps)) if ps else None,
        ))

    return EvaluationResult(
        cells=cells,
        n_setup_rows=dataset.setup_row_count,
        n_label_rows=dataset.label_row_count,
        n_excluded_by_status=dataset.exclusion_counts,
        run_dir=str(run_dir),
        setups_path=str(setups_path),
        labels_path=str(labels_path),
    )


def render_markdown_report(result: EvaluationResult) -> str:
    lines: list[str] = []
    lines.append("# Shadow-Mode Performance Report")
    lines.append("")
    lines.append(f"- run_dir: `{result.run_dir}`")
    lines.append(f"- setups_path: `{result.setups_path}`")
    lines.append(f"- labels_path: `{result.labels_path}`")
    lines.append(
        f"- setup rows: {result.n_setup_rows:,}    "
        f"label rows: {result.n_label_rows:,}"
    )
    if result.n_excluded_by_status:
        lines.append(
            f"- exclusions: {result.n_excluded_by_status}"
        )
    lines.append("")
    for cell in result.cells:
        lines.append(f"## {cell.setup_type} · {cell.horizon_seconds}s")
        lines.append("")
        if cell.note:
            lines.append(f"- _Note: {cell.note}_")
            lines.append("")
            continue
        lines.append(
            f"- Samples: total={cell.n_total} (+{cell.n_positive} / "
            f"-{cell.n_negative})"
        )
        if cell.realized_positive_rate is not None:
            lines.append(
                f"- Realized positive rate: {cell.realized_positive_rate:.3f}    "
                f"Mean predicted: {cell.mean_predicted:.3f}"
            )
        lines.append(
            f"- AUC: {cell.auc:.3f}" if cell.auc is not None else "- AUC: n/a"
        )
        lines.append(
            f"- Brier: {cell.brier:.4f}" if cell.brier is not None else "- Brier: n/a"
        )
        lines.append(
            f"- Log loss: {cell.log_loss:.4f}" if cell.log_loss is not None else "- Log loss: n/a"
        )
        lines.append(
            f"- Calibration error: {cell.calibration_error:.4f}"
            if cell.calibration_error is not None else "- Calibration error: n/a"
        )
        lines.append("")
        if cell.reliability_curve:
            lines.append("**Reliability curve**:")
            lines.append("")
            lines.append("| Decile | n | Predicted | Realized |")
            lines.append("|---:|---:|---:|---:|")
            for row in cell.reliability_curve:
                lines.append(
                    f"| {row['decile']} | {row['n']} | "
                    f"{row['predicted']:.3f} | {row['realized']:.3f} |"
                )
            lines.append("")
        if cell.hit_rate_at_threshold:
            lines.append("**Hit rate at threshold**:")
            lines.append("")
            lines.append("| Threshold | n above | Hit rate | Base rate | Lift |")
            lines.append("|---:|---:|---:|---:|---:|")
            for t, stats in cell.hit_rate_at_threshold.items():
                hit = f"{stats['hit_rate']:.3f}" if stats["hit_rate"] is not None else "n/a"
                base = f"{stats['base_rate']:.3f}" if stats["base_rate"] is not None else "n/a"
                lift = f"{stats['lift']:+.3f}" if stats["lift"] is not None else "n/a"
                lines.append(
                    f"| {t} | {stats['n_above']} | {hit} | {base} | {lift} |"
                )
            lines.append("")
    return "\n".join(lines) + "\n"


def cell_to_dict(cell: CellMetrics) -> dict[str, Any]:
    """Convert a CellMetrics to a plain JSON-safe dict for the sidecar."""
    return asdict(cell)


__all__ = [
    "DEFAULT_THRESHOLDS",
    "CellMetrics",
    "EvaluationResult",
    "evaluate",
    "render_markdown_report",
    "cell_to_dict",
]
