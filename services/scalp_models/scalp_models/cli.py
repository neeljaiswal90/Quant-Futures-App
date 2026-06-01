"""Command line entrypoint for RA-093 model training."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import cast

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
    pipeline = subparsers.add_parser(
        "pipeline",
        help="Run RA-093b replay -> labels -> train pipeline for capture sessions.",
    )
    pipeline.add_argument(
        "--pair",
        action="append",
        default=[],
        help="Capture pair formatted YYYY-MM-DD:globex or YYYY-MM-DD:rth. Repeatable.",
    )
    pipeline.add_argument(
        "--date-range",
        type=str,
        default=None,
        help="Inclusive date range formatted START..END, used with --session.",
    )
    pipeline.add_argument(
        "--session",
        action="append",
        choices=("globex", "rth"),
        default=[],
        help="Session to expand for --date-range. Repeatable.",
    )
    pipeline.add_argument("--analytics-root", type=Path, default=None)
    pipeline.add_argument("--dashboard-root", type=Path, default=None)
    pipeline.add_argument("--out-root", type=Path, default=None)
    pipeline.add_argument("--run-id", type=str, default=None)
    pipeline.add_argument("--step-ms", type=int, default=500)
    pipeline.add_argument("--depth-n-ticks", type=int, default=20)
    pipeline.add_argument("--limit-steps", type=int, default=None)
    pipeline.add_argument("--target-ticks", type=float, default=4.0)
    pipeline.add_argument("--min-positives", type=int, default=30)
    pipeline.add_argument("--min-negatives", type=int, default=30)
    pipeline.add_argument("--tick-size", type=float, default=0.25)
    pipeline.add_argument(
        "--allow-live-capture-contention",
        action="store_true",
        help="Override the active-capture guard. Use only in a quiet/test window.",
    )
    args = parser.parse_args(argv)
    if args.command == "pipeline":
        from scalp_models.pipeline import (
            DEFAULT_ANALYTICS_ROOT,
            DEFAULT_DASHBOARD_ROOT,
            DEFAULT_OUT_ROOT,
            PipelineConfig,
            PipelineSession,
            SessionName,
            parse_pair,
            run_pipeline,
            sessions_from_date_range,
        )

        sessions: list[PipelineSession] = [parse_pair(item) for item in args.pair]
        if args.date_range is not None:
            range_sessions = (
                tuple(cast(SessionName, item) for item in args.session)
                if args.session
                else ("globex", "rth")
            )
            sessions.extend(sessions_from_date_range(args.date_range, range_sessions))
        if not sessions:
            parser.error("pipeline requires at least one --pair or --date-range")
        pipeline_result = run_pipeline(
            PipelineConfig(
                sessions=tuple(sessions),
                analytics_root=args.analytics_root or DEFAULT_ANALYTICS_ROOT,
                dashboard_root=args.dashboard_root or DEFAULT_DASHBOARD_ROOT,
                out_root=args.out_root or DEFAULT_OUT_ROOT,
                run_id=args.run_id,
                step_ms=args.step_ms,
                depth_n_ticks=args.depth_n_ticks,
                limit_steps=args.limit_steps,
                target_ticks=args.target_ticks,
                min_positives=args.min_positives,
                min_negatives=args.min_negatives,
                tick_size=args.tick_size,
                allow_live_capture_contention=args.allow_live_capture_contention,
            )
        )
        print(
            "scalp_pipeline_complete: "
            f"run_dir={pipeline_result.run_dir} "
            f"manifest={pipeline_result.manifest_path} "
            f"report={pipeline_result.training.report_path}"
        )
        return 0
    if args.command != "train":
        parser.print_help()
        return 2
    training_result = train_models(
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
        f"run_id={training_result.run_id} "
        f"run_dir={training_result.run_dir} "
        f"models={len(training_result.model_paths)} "
        f"report={training_result.report_path}"
    )
    return 0
