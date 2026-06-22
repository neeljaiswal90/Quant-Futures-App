"""Local tests for the meta-labeling trainer encoder + fail-closed guards.

Run locally (pytest); CI only syntax-checks Python. These import the trainer
module WITHOUT triggering xgboost (numpy/xgboost are imported inside main()),
so the encoder + loader can be tested without the ML dependency.
"""

import json
import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import train_meta_label as trainer  # noqa: E402


def test_encode_features_known_row():
    row = {
        "side": "long",
        "regime_label": "high",
        "vix_value": 18.5,
        "vix_fresh": True,
        "signed_shock_vwap_value": 1.25,
        "signed_shock_vwap_anchor": 0.0,
        "signed_shock_vwap_sigma": 1.0,
        "spread_bucket": "2-tick",
        "queue_ahead_bucket": "6-20",
    }
    # Must match the TS feature builder's expected vector for the same input
    # (apps/backtester/tests/unit/meta-labeling/meta-label-features.test.ts).
    assert trainer.encode_features(row) == [1.0, 1.0, 0.0, 0.0, 18.5, 1.0, 1.25, 0.0, 1.0, 2.0, 2.0]


def test_encode_features_missing_numerics_are_nan():
    row = {
        "side": "short",
        "regime_label": "unknown",
        "vix_value": None,
        "vix_fresh": False,
        "signed_shock_vwap_value": None,
        "signed_shock_vwap_anchor": None,
        "signed_shock_vwap_sigma": None,
        "spread_bucket": "unknown",
        "queue_ahead_bucket": "unknown",
    }
    vector = trainer.encode_features(row)
    assert vector[0] == 0.0
    assert all(math.isnan(vector[i]) for i in (4, 6, 7, 8))
    assert vector[9] == 0.0 and vector[10] == 0.0


def test_label_is_net_of_fees():
    assert trainer.label_of({"net_pnl_cents": 5}) == 1
    assert trainer.label_of({"net_pnl_cents": -5}) == 0
    assert trainer.label_of({"net_pnl_cents": 0}) == 0


def test_parse_rows_rejects_gross_pnl_basis():
    with pytest.raises(ValueError, match="net_of_fees"):
        trainer.parse_training_rows(
            [json.dumps({"schema_version": 1, "pnl_basis": "gross", "partition": "train", "net_pnl_cents": 5})]
        )
