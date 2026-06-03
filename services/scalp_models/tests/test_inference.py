"""Smoke tests for the RA-094 inference helper that consumes RA-093 outputs.

Strategy:
* Train a tiny fixture model (or stub) and verify the bundle loads it
  + produces a probability in [0, 1] from a representative setup row.

These tests do NOT depend on the on-disk yesterday-training run; they
exercise the API contract purely. A live-data smoke against the actual
recent training run is run separately.
"""

from __future__ import annotations

import json
from pathlib import Path

import joblib
import pytest
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from scalp_models.features import FEATURE_NAMES
from scalp_models.inference import ScalpModelInferenceBundle, ScoreResult


def _make_fixture_run_dir(tmp_path: Path) -> Path:
    """Build a minimal but valid trained-run layout under ``tmp_path``."""
    run_dir = tmp_path / "fixture-run"
    (run_dir / "models").mkdir(parents=True)

    # Train a trivial 2-class logistic on synthetic features. We don't care
    # about the metric quality — just that the joblib + dict structure is
    # the same shape the trainer produces.
    n_features = len(FEATURE_NAMES)
    rng_seed = 42
    import numpy as np
    rng = np.random.default_rng(rng_seed)
    X = rng.normal(size=(120, n_features))
    # Synthetic positive class biased by sum of first 5 features
    y = (X[:, :5].sum(axis=1) > 0).astype(int)

    pipeline = Pipeline([("scaler", StandardScaler()), ("logit", LogisticRegression(C=1.0))])
    pipeline.fit(X, y)
    cal = IsotonicRegression(out_of_bounds="clip")
    cal.fit(pipeline.predict_proba(X)[:, 1], y)

    payload = {
        "model_schema_version": 1,
        "setup_type": "zone_rejection",
        "horizon_seconds": 5,
        "target_ticks": 4.0,
        "feature_names": list(FEATURE_NAMES),
        "base_pipeline": pipeline,
        "calibration_method": "isotonic",
        "calibrator": cal,
    }
    joblib.dump(payload, run_dir / "models" / "zone_rejection_5s.joblib")

    # Add a second horizon so score_all_horizons has something to enumerate.
    payload_15s = {**payload, "horizon_seconds": 15}
    joblib.dump(payload_15s, run_dir / "models" / "zone_rejection_15s.joblib")

    config = {"target_ticks": 4.0, "tick_size": 0.25, "horizons_seconds": [1, 5, 15]}
    (run_dir / "config.json").write_text(json.dumps(config), encoding="utf-8")
    (run_dir / "features.json").write_text(
        json.dumps({"feature_names": list(FEATURE_NAMES)}),
        encoding="utf-8",
    )
    return run_dir


def _setup_row() -> dict:
    """A representative setup row shape (matches the dataset.py expectations)."""
    return {
        "setup_type": "zone_rejection",
        "confluence_stack_size": 3,
        "regime": "LOW",
        "features": {"sigma": 16.3, "atr_14": 23.5, "microprice_start_lean_ticks": 0.2},
        "zone_context": {"kind": "sigma", "distance_pts": 4.0},
        "orderflow_snapshot": {
            "v_delta": 12.0,
            "quality": "live",
            "cvd": {
                "session_cvd": 154.0,
                "last_60m_cvd": 22.0,
                "last_15m_cvd": -3.0,
                "momentum_flip": False,
                "session_direction": "bullish",
                "last_15m_direction": "neutral",
            },
            "footprint": {"imbalance": 0.32},
            "aggressor_windows": [
                {"seconds": 60, "net": 12, "ratio": 0.61},
                {"seconds": 300, "net": 30, "ratio": 0.55},
            ],
            "last_trade_aggressor": "buy",
        },
        "depth_snapshot": {"quality": "live"},
    }


def test_bundle_loads_all_models(tmp_path):
    run_dir = _make_fixture_run_dir(tmp_path)
    bundle = ScalpModelInferenceBundle(run_dir)
    assert bundle.available_setups == [("zone_rejection", 5), ("zone_rejection", 15)]
    assert bundle.tick_size == 0.25


def test_score_returns_calibrated_probability_in_unit_interval(tmp_path):
    bundle = ScalpModelInferenceBundle(_make_fixture_run_dir(tmp_path))
    result = bundle.score(
        _setup_row(), setup_type="zone_rejection", horizon_seconds=5,
    )
    assert isinstance(result, ScoreResult)
    assert 0.0 <= result.p_raw <= 1.0
    assert 0.0 <= result.p_calibrated <= 1.0
    assert result.feature_count == len(FEATURE_NAMES)
    assert result.setup_type == "zone_rejection"
    assert result.horizon_seconds == 5


def test_score_unknown_setup_returns_none(tmp_path):
    bundle = ScalpModelInferenceBundle(_make_fixture_run_dir(tmp_path))
    # No model for sweep_absorption in the fixture
    assert bundle.score(
        _setup_row(), setup_type="sweep_absorption", horizon_seconds=5,
    ) is None
    # No 1s horizon in the fixture (only 5s + 15s)
    assert bundle.score(
        _setup_row(), setup_type="zone_rejection", horizon_seconds=1,
    ) is None


def test_score_all_horizons_returns_sorted_results(tmp_path):
    bundle = ScalpModelInferenceBundle(_make_fixture_run_dir(tmp_path))
    results = bundle.score_all_horizons(
        _setup_row(), setup_type="zone_rejection",
    )
    assert [r.horizon_seconds for r in results] == [5, 15]
    for r in results:
        assert 0.0 <= r.p_calibrated <= 1.0


def test_missing_run_dir_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        ScalpModelInferenceBundle(tmp_path / "no-such-dir")


def test_missing_models_subdir_raises(tmp_path):
    (tmp_path / "config.json").write_text("{}", encoding="utf-8")
    with pytest.raises(FileNotFoundError):
        ScalpModelInferenceBundle(tmp_path)


def test_score_uses_model_feature_order_not_global_order(tmp_path):
    """If a trained model captured a subset / different ordering of features,
    the inference path must use the model's recorded order — not the global
    FEATURE_NAMES tuple at import time. Future-proofs against trainer
    refactors that change feature surface."""
    run_dir = tmp_path / "subset-run"
    (run_dir / "models").mkdir(parents=True)
    # 3-feature subset (the model knows about only these)
    subset = list(FEATURE_NAMES[:3])
    import numpy as np
    rng = np.random.default_rng(0)
    X = rng.normal(size=(60, 3))
    y = (X[:, 0] > 0).astype(int)
    pipeline = Pipeline([("logit", LogisticRegression())]).fit(X, y)
    cal = IsotonicRegression(out_of_bounds="clip").fit(pipeline.predict_proba(X)[:, 1], y)
    joblib.dump(
        {
            "model_schema_version": 1,
            "setup_type": "zone_rejection",
            "horizon_seconds": 5,
            "target_ticks": 4.0,
            "feature_names": subset,
            "base_pipeline": pipeline,
            "calibration_method": "isotonic",
            "calibrator": cal,
        },
        run_dir / "models" / "zone_rejection_5s.joblib",
    )
    (run_dir / "config.json").write_text(json.dumps({"tick_size": 0.25}))
    bundle = ScalpModelInferenceBundle(run_dir)
    result = bundle.score(
        _setup_row(), setup_type="zone_rejection", horizon_seconds=5,
    )
    assert result is not None
    assert result.feature_count == 3
