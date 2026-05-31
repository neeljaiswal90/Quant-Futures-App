"""Command line entrypoint for RA-093 model training."""

from __future__ import annotations

import argparse
from pathlib import Path

from scalp_models.trainer import TrainingConfig, train_models


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Train RA-093 scalp probability models.")
    subparsers = parser.add_subparsers(dest="command")
    train = subparsers.add_parser("train", help="Train calibrated setup/horizon models.")
    train.add_argument("--setups", required=True, type=Path, help="RA-092 setup-firing JSONL path.")
    train.add_argument(
        "--labels",
        required=True,
        type=Path,
        help="RA-091 forward-return label JSONL path.",
    )
    train.add_argument("--out-root", type=Path, default=Path("services/scalp_models/runs"))
    train.add_argument("--target-ticks", type=float, default=4.0)
    train.add_argument("--min-positives", type=int, default=30)
    train.add_argument("--min-negatives", type=int, default=30)
    train.add_argument("--run-id", type=str, default=None)
    args = parser.parse_args(argv)
    if args.command != "train":
        parser.print_help()
        return 2
    result = train_models(
        TrainingConfig(
            setup_path=args.setups,
            labels_path=args.labels,
            out_root=args.out_root,
            target_ticks=args.target_ticks,
            min_positives=args.min_positives,
            min_negatives=args.min_negatives,
            run_id=args.run_id,
        )
    )
    print(
        "scalp_models_trained: "
        f"run_id={result.run_id} "
        f"run_dir={result.run_dir} "
        f"models={len(result.model_paths)} "
        f"report={result.report_path}"
    )
    return 0
