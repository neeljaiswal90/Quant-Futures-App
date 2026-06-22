"""Generate a deterministic XGBoost binary:logistic parity fixture.

Trains a tiny model on synthetic data and writes, under
apps/backtester/tests/unit/meta-labeling/fixtures/:

  - model.json   : xgboost save_model('.json') output (the artifact the TS
                   meta-label evaluator reads at inference time)
  - samples.json : [{features: [...|null], proba: <xgboost predicted prob>}]

The TS parity test asserts the TS evaluator reproduces `proba` from `model.json`
to ~1e-6, including the missing-value (None) default-direction path. The fixture
is committed; this generator is a dev tool and is NOT run in CI (so CI needs no
xgboost). Re-run it to regenerate the fixture after a model-format bump.

Determinism config matches the meta-labeling trainer contract:
tree_method=hist, nthread=1, seed=0, subsample=1.0 (regularize via depth/lambda/
min_child_weight, never via subsampling -- subsample<1.0 is non-deterministic).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import xgboost as xgb

SEED = 0
N_FEATURES = 8
N_ROWS = 256
FIXTURE_DIR = (
    Path(__file__).resolve().parents[3]
    / "apps/backtester/tests/unit/meta-labeling/fixtures"
)


def main() -> int:
    rng = np.random.default_rng(SEED)
    features = rng.standard_normal((N_ROWS, N_FEATURES)).astype(np.float64)
    logit = (
        0.9 * features[:, 0]
        - 0.7 * features[:, 1]
        + 0.4 * features[:, 2] * features[:, 3]
    )
    win_prob = 1.0 / (1.0 + np.exp(-logit))
    labels = (rng.uniform(size=N_ROWS) < win_prob).astype(np.int32)

    dtrain = xgb.DMatrix(features, label=labels)
    params = {
        "objective": "binary:logistic",
        "tree_method": "hist",
        "max_depth": 3,
        "eta": 0.3,
        "reg_lambda": 1.0,
        "min_child_weight": 5,
        "subsample": 1.0,
        "seed": SEED,
        "nthread": 1,
    }
    booster = xgb.train(params, dtrain, num_boost_round=12)

    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    model_path = FIXTURE_DIR / "model.json"
    booster.save_model(str(model_path))

    sample_rows = features[:12]
    sample_probas = booster.predict(xgb.DMatrix(sample_rows))
    samples = [
        {
            "features": [float(v) for v in sample_rows[i]],
            "proba": float(sample_probas[i]),
        }
        for i in range(sample_rows.shape[0])
    ]

    # Exercise the missing-value default-direction path: set feature 0 to NaN.
    missing_row = sample_rows[0].copy()
    missing_row[0] = np.nan
    missing_proba = float(booster.predict(xgb.DMatrix(missing_row.reshape(1, -1)))[0])
    samples.append(
        {
            "features": [None if np.isnan(v) else float(v) for v in missing_row],
            "proba": missing_proba,
        }
    )

    (FIXTURE_DIR / "samples.json").write_text(
        json.dumps(samples, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    print(
        json.dumps(
            {
                "xgboost_version": xgb.__version__,
                "model_path": str(model_path),
                "n_samples": len(samples),
                "n_trees": booster.num_boosted_rounds(),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
