"""Train the meta-labeling take/skip classifier (STRATEGY-GEN-META-LABELING-IMPL-01).

Reads a training-rows JSONL (one primary signal per line, emitted from the
TRAIN/VALIDATION replay -- see increment 2b), builds a LEAK-FREE entry-time
feature matrix, derives NET-OF-FEES labels, trains a deterministic xgboost
binary:logistic model, and emits into --out-dir:

  model.json           : booster.save_model JSON (consumed by the TS evaluator)
  feature-spec.json    : ordered feature names + encodings + take threshold + model hash
  training-report.json : counts, validation PF lift proxy

Determinism: tree_method=hist, nthread=1, fixed seed, subsample=1.0 (regularize
via max_depth/reg_lambda/min_child_weight/eta, never via subsampling). Inference
runs in TypeScript over model.json (apps/backtester/src/meta-labeling), so no
xgboost is needed at gate time or in CI.

Leakage discipline: features are entry-time only; post-entry outcomes
(MFE/MAE/first-minute) are NEVER features. Labels are net-of-fees and rows must
declare pnl_basis == "net_of_fees" (fail-closed otherwise).

The feature encoding here is the canonical contract; the TypeScript feature
builder must produce the identical vector in FEATURE_NAMES order.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any, Iterable

SPREAD_BUCKET_ORD = {"unknown": 0.0, "1-tick": 1.0, "2-tick": 2.0, "3+ ticks": 3.0}
QUEUE_BUCKET_ORD = {"unknown": 0.0, "1-5": 1.0, "6-20": 2.0, "21+": 3.0}
REGIMES = ("high", "mid", "low")
FEATURE_NAMES = (
    "side_is_long",
    "regime_high",
    "regime_mid",
    "regime_low",
    "vix_value",
    "vix_fresh",
    "signed_shock_value",
    "signed_shock_anchor",
    "signed_shock_sigma",
    "spread_bucket_ord",
    "queue_ahead_bucket_ord",
)
FEATURE_SPEC_VERSION = 1


def _num(value: Any) -> float:
    return float("nan") if value is None else float(value)


def encode_features(row: dict[str, Any]) -> list[float]:
    """Leak-free entry-time feature vector in canonical FEATURE_NAMES order."""
    regime = row.get("regime_label")
    return [
        1.0 if row.get("side") == "long" else 0.0,
        1.0 if regime == "high" else 0.0,
        1.0 if regime == "mid" else 0.0,
        1.0 if regime == "low" else 0.0,
        _num(row.get("vix_value")),
        1.0 if bool(row.get("vix_fresh")) else 0.0,
        _num(row.get("signed_shock_vwap_value")),
        _num(row.get("signed_shock_vwap_anchor")),
        _num(row.get("signed_shock_vwap_sigma")),
        SPREAD_BUCKET_ORD.get(str(row.get("spread_bucket")), 0.0),
        QUEUE_BUCKET_ORD.get(str(row.get("queue_ahead_bucket")), 0.0),
    ]


def label_of(row: dict[str, Any]) -> int:
    return 1 if int(row["net_pnl_cents"]) > 0 else 0


def parse_training_rows(lines: Iterable[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("schema_version") != 1:
            raise ValueError(f"training row {line_number}: schema_version must be 1")
        if row.get("pnl_basis") != "net_of_fees":
            raise ValueError(
                f"training row {line_number}: pnl_basis must be 'net_of_fees' "
                f"(got {row.get('pnl_basis')!r}); meta-labels must be net of commissions"
            )
        if "net_pnl_cents" not in row:
            raise ValueError(f"training row {line_number}: missing net_pnl_cents")
        if row.get("partition") not in ("train", "validation"):
            raise ValueError(f"training row {line_number}: partition must be train|validation")
        rows.append(row)
    return rows


def load_rows(path: Path) -> list[dict[str, Any]]:
    rows = parse_training_rows(path.read_text(encoding="utf-8").splitlines())
    if not rows:
        raise ValueError(f"no training rows in {path}")
    return rows


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _profit_factor(net_cents: list[int]) -> float:
    gross = float(sum(v for v in net_cents if v > 0))
    loss = float(-sum(v for v in net_cents if v < 0))
    if loss > 0:
        return gross / loss
    return math.inf if gross > 0 else 0.0


def main() -> int:
    parser = argparse.ArgumentParser(description="Train the meta-labeling take/skip classifier.")
    parser.add_argument("--training-rows", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--take-threshold", type=float, default=0.5)
    parser.add_argument("--max-depth", type=int, default=3)
    parser.add_argument("--num-boost-round", type=int, default=64)
    parser.add_argument("--eta", type=float, default=0.1)
    parser.add_argument("--min-child-weight", type=float, default=10.0)
    parser.add_argument("--reg-lambda", type=float, default=2.0)
    args = parser.parse_args()

    import numpy as np
    import xgboost as xgb

    rows = load_rows(args.training_rows)
    train_rows = [row for row in rows if row.get("partition") == "train"]
    validation_rows = [row for row in rows if row.get("partition") == "validation"]
    if not train_rows:
        raise ValueError("no train-partition rows")

    x_train = np.array([encode_features(row) for row in train_rows], dtype=np.float64)
    y_train = np.array([label_of(row) for row in train_rows], dtype=np.int32)

    params = {
        "objective": "binary:logistic",
        "tree_method": "hist",
        "max_depth": args.max_depth,
        "eta": args.eta,
        "reg_lambda": args.reg_lambda,
        "min_child_weight": args.min_child_weight,
        "subsample": 1.0,  # determinism: never subsample (subsample<1 is non-deterministic)
        "seed": args.seed,
        "nthread": 1,
    }
    dtrain = xgb.DMatrix(x_train, label=y_train, feature_names=list(FEATURE_NAMES))
    booster = xgb.train(params, dtrain, num_boost_round=args.num_boost_round)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    model_path = args.out_dir / "model.json"
    booster.save_model(str(model_path))

    report: dict[str, Any] = {
        "schema_version": 1,
        "seed": args.seed,
        "take_threshold": args.take_threshold,
        "train_row_count": len(train_rows),
        "validation_row_count": len(validation_rows),
        "params": params,
    }
    if validation_rows:
        x_val = np.array([encode_features(row) for row in validation_rows], dtype=np.float64)
        proba = booster.predict(xgb.DMatrix(x_val, feature_names=list(FEATURE_NAMES)))
        net_all = [int(row["net_pnl_cents"]) for row in validation_rows]
        net_taken = [
            int(row["net_pnl_cents"])
            for row, p in zip(validation_rows, proba)
            if float(p) >= args.take_threshold
        ]
        report["validation_baseline_profit_factor"] = _profit_factor(net_all)
        report["validation_meta_gated_profit_factor"] = _profit_factor(net_taken)
        report["validation_taken_fraction"] = len(net_taken) / len(net_all)

    spec = {
        "schema_version": FEATURE_SPEC_VERSION,
        "feature_names": list(FEATURE_NAMES),
        "encodings": {
            "spread_bucket_ord": SPREAD_BUCKET_ORD,
            "queue_ahead_bucket_ord": QUEUE_BUCKET_ORD,
            "regimes_one_hot": list(REGIMES),
        },
        "objective": "binary:logistic",
        "take_threshold": args.take_threshold,
        "label": "net_pnl_cents_gt_0",
        "pnl_basis": "net_of_fees",
        "xgboost_version": xgb.__version__,
        "model_sha256": _sha256_text(model_path.read_text(encoding="utf-8")),
    }
    (args.out_dir / "feature-spec.json").write_text(
        json.dumps(spec, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (args.out_dir / "training-report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "model": str(model_path),
                "train_rows": len(train_rows),
                "validation_rows": len(validation_rows),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
