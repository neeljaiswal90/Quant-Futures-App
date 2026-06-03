"""Tests for the RA-094 shadow-mode performance evaluator."""

from __future__ import annotations

import json
from pathlib import Path

import joblib
import numpy as np
import pytest
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline

from scalp_models.evaluate import (
    DEFAULT_THRESHOLDS,
    CellMetrics,
    evaluate,
    render_markdown_report,
)
from scalp_models.features import FEATURE_NAMES


def _make_run_dir(tmp_path: Path) -> Path:
    """Build a tiny zone_rejection model so the evaluator has something to score."""
    run_dir = tmp_path / "run"
    (run_dir / "models").mkdir(parents=True)
    n = len(FEATURE_NAMES)
    rng = np.random.default_rng(42)
    X = rng.normal(size=(120, n))
    y = (X[:, :5].sum(axis=1) > 0).astype(int)
    pipeline = Pipeline([("logit", LogisticRegression(C=1.0))]).fit(X, y)
    cal = IsotonicRegression(out_of_bounds="clip").fit(pipeline.predict_proba(X)[:, 1], y)
    joblib.dump(
        {
            "model_schema_version": 1,
            "setup_type": "zone_rejection",
            "horizon_seconds": 5,
            "target_ticks": 4.0,
            "feature_names": list(FEATURE_NAMES),
            "base_pipeline": pipeline,
            "calibration_method": "isotonic",
            "calibrator": cal,
        },
        run_dir / "models" / "zone_rejection_5s.joblib",
    )
    (run_dir / "config.json").write_text(
        json.dumps({"tick_size": 0.25}), encoding="utf-8"
    )
    return run_dir


def _make_setups_and_labels(tmp_path: Path, n: int = 20) -> tuple[Path, Path]:
    """Build a paired setups.jsonl + labels.jsonl. Each setup has a matching
    label with mfe_ticks varying so we get a mix of 1s and 0s."""
    setups_path = tmp_path / "setups.jsonl"
    labels_path = tmp_path / "labels.jsonl"

    setups: list[dict] = []
    labels: list[dict] = []
    base_ts = 1779975090000000000
    for i in range(n):
        ts = base_ts + i * 1_000_000_000  # 1s apart
        mfe = 8.0 if i % 3 == 0 else 0.5  # ~1/3 are hits at target=4.0
        # Setup row — minimal but valid schema
        setups.append({
            "schema_version": 1,
            "setup_type": "zone_rejection",
            "ts_ns": str(ts),
            "level_id": f"test-{i}",
            "direction": "long",
            "regime": "LOW",
            "confluence_stack_size": 2,
            "features": {"sigma": 16.0},
            "zone_context": {"kind": "sigma", "distance_pts": 4.0},
            "orderflow_snapshot": {"quality": "live", "cvd": {"session_cvd": 100.0}},
            "depth_snapshot": {"quality": "live"},
            "source_signals": [{
                "signal_id": f"sig-{i}",
                "ts_ns": str(ts),
                "session": "rth",
                "capture_date": "2026-05-28",
            }],
            "replay": {
                "capture_date": "2026-05-28",
                "session": "rth",
                "step_ns": str(ts),
                "source_obs01": "synthetic.obs01.jsonl",
                "schema_version": 1,
            },
        })
        # Matching label row — keyed by signal ts/replay so the join works
        labels.append({
            "label_schema_version": 1,
            "candidate_seed": {
                "seed_schema_version": 1,
                "ts_ns": str(ts),
                "session": "rth",
                "capture_date": "2026-05-28",
                "family": "zone_rejection",
                "event_type": "test",
                "side": None,
                "level_id": f"test-{i}",
                "normalized_direction": "long",
                "signal_price": 30500.0,
                "source_obs01": "synthetic.obs01.jsonl",
                "seed_id": f"2026-05-28|rth|{ts}|zone_rejection|test|test-{i}|no-side",
            },
            "signal": {
                "schema_version": 1,
                "ts_ns": str(ts),
                "event_type": "test",
                "family": "zone_rejection",
                "tier": None,
                "side": None,
                "level_id": f"test-{i}",
                "direction": "long",
                "price": 30500.0,
                "replay": {
                    "capture_date": "2026-05-28",
                    "session": "rth",
                    "step_ns": str(ts),
                    "source_obs01": "synthetic.obs01.jsonl",
                    "schema_version": 1,
                },
            },
            "forward_returns": [
                {
                    "horizon_seconds": h,
                    "direction": "long",
                    "status": "ok",
                    "mfe_ticks": mfe,
                    "mfe_pts": mfe * 0.25,
                    "mae_ticks": -1.0,
                    "mae_pts": -0.25,
                    "realized_ticks": mfe,
                    "realized_pts": mfe * 0.25,
                    "entry_price": 30500.0,
                    "exit_price": 30500.0 + mfe * 0.25,
                    "entry_ts_ns": str(ts),
                    "exit_ts_ns": str(ts + h * 1_000_000_000),
                    "max_favorable_price": 30500.0 + mfe * 0.25,
                    "max_adverse_price": 30499.75,
                    "trade_count": 5,
                }
                for h in (1, 5, 15, 60, 300)
            ],
        })
    setups_path.write_text(
        "\n".join(json.dumps(s) for s in setups) + "\n", encoding="utf-8"
    )
    labels_path.write_text(
        "\n".join(json.dumps(l) for l in labels) + "\n", encoding="utf-8"
    )
    return setups_path, labels_path


def test_evaluate_returns_metrics_for_each_cell_with_models(tmp_path):
    run_dir = _make_run_dir(tmp_path)
    setups_path, labels_path = _make_setups_and_labels(tmp_path, n=30)
    result = evaluate(run_dir=run_dir, setups_path=setups_path, labels_path=labels_path)
    # Only zone_rejection 5s has a model in this fixture; other horizons should
    # surface as "no_model" notes.
    by_key = {(c.setup_type, c.horizon_seconds): c for c in result.cells}
    assert ("zone_rejection", 5) in by_key
    cell_5s = by_key[("zone_rejection", 5)]
    assert cell_5s.n_total > 0
    assert cell_5s.n_positive + cell_5s.n_negative == cell_5s.n_total
    # AUC is between 0 and 1 (or None if all one class)
    if cell_5s.auc is not None:
        assert 0.0 <= cell_5s.auc <= 1.0
    if cell_5s.brier is not None:
        assert 0.0 <= cell_5s.brier <= 1.0
    assert cell_5s.note is None
    # Other horizons present in dataset but missing from bundle → no_model note
    for (st, h), cell in by_key.items():
        if h != 5:
            assert cell.note is not None
            assert "no_model" in cell.note


def test_evaluate_handles_zero_examples_gracefully(tmp_path):
    """If labels are missing / all setups exclude, evaluator shouldn't crash."""
    run_dir = _make_run_dir(tmp_path)
    setups_path = tmp_path / "empty_setups.jsonl"
    labels_path = tmp_path / "empty_labels.jsonl"
    setups_path.write_text("", encoding="utf-8")
    labels_path.write_text("", encoding="utf-8")
    result = evaluate(run_dir=run_dir, setups_path=setups_path, labels_path=labels_path)
    assert result.n_setup_rows == 0
    assert result.n_label_rows == 0
    assert result.cells == []


def test_render_markdown_report_includes_all_sections(tmp_path):
    run_dir = _make_run_dir(tmp_path)
    setups_path, labels_path = _make_setups_and_labels(tmp_path, n=30)
    result = evaluate(run_dir=run_dir, setups_path=setups_path, labels_path=labels_path)
    md = render_markdown_report(result)
    assert "# Shadow-Mode Performance Report" in md
    assert "zone_rejection · 5s" in md
    # The cell with data should have reliability + hit-rate tables
    assert "Reliability curve" in md
    assert "Hit rate at threshold" in md


def test_calibration_error_is_zero_for_perfectly_calibrated_predictions(tmp_path):
    """Synthetic sanity check: if predictions exactly match outcomes,
    calibration error should be ~0."""
    from scalp_models.evaluate import _reliability_curve
    # Perfect calibration: predicted == realized rate per bin
    y = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1]
    p = [0.1, 0.1, 0.1, 0.1, 0.1, 0.9, 0.9, 0.9, 0.9, 0.9]
    _, cal_err = _reliability_curve(y, p, n_bins=2)
    assert cal_err is not None
    assert cal_err < 0.15  # 2-bin split won't be perfect, but should be small


def test_hit_rate_at_threshold_computes_lift(tmp_path):
    """If 30% of samples are positive and we threshold p>=0.7 picking the most
    confident 20%, hit rate should be higher than the 30% base rate."""
    from scalp_models.evaluate import _hit_rate_at_threshold
    y = [1, 0, 1, 0, 1, 0, 0, 0, 0, 0]  # 30% base
    p = [0.9, 0.2, 0.85, 0.3, 0.95, 0.4, 0.1, 0.2, 0.15, 0.1]  # high-p match high-y
    result = _hit_rate_at_threshold(y, p, [0.7])
    assert "0.70" in result
    assert result["0.70"]["n_above"] == 3
    assert result["0.70"]["hit_rate"] == pytest.approx(1.0)
    assert result["0.70"]["base_rate"] == pytest.approx(0.3)
    assert result["0.70"]["lift"] == pytest.approx(0.7)
