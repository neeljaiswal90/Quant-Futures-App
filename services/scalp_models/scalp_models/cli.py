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

    # RA-094: offline scoring CLI. Takes a setups.jsonl + a trained run_dir,
    # writes one prediction-per-(row, horizon) to a predictions.jsonl.
    score = subparsers.add_parser(
        "score",
        help="Score a setups.jsonl with a trained run_dir, emit predictions.jsonl.",
    )
    score.add_argument(
        "--setups", required=True, type=Path,
        help="RA-092 setup-firing JSONL path (the input to score).",
    )
    score.add_argument(
        "--models", required=True, type=Path,
        help="Trained run dir, e.g. .../model_runs/quiet-window-2026-05-31/. "
             "Must contain models/, config.json.",
    )
    score.add_argument(
        "--out", required=True, type=Path,
        help="Output JSONL path. One row per (input_row, horizon) scored.",
    )
    score.add_argument(
        "--setup-type", default=None,
        help="Restrict to one setup_type (e.g. 'zone_rejection'). "
             "Default: score every row against every matching loaded model.",
    )
    score.add_argument(
        "--max-rows", type=int, default=None,
        help="Optional cap on input rows scored (for quick smoke runs).",
    )

    # RA-094: offline performance evaluator. Joins setups+labels via the same
    # logic the trainer uses, scores each eligible example, computes AUC /
    # Brier / log_loss / calibration / hit-rate-at-threshold per cell.
    evaluate = subparsers.add_parser(
        "evaluate",
        help="Evaluate trained models against a fresh session's setups + labels.",
    )
    evaluate.add_argument(
        "--setups", required=True, type=Path,
        help="RA-092 setup-firing JSONL path (the input to score).",
    )
    evaluate.add_argument(
        "--labels", required=True, type=Path,
        help="RA-091 forward-return label JSONL path (realized outcomes).",
    )
    evaluate.add_argument(
        "--models", required=True, type=Path,
        help="Trained run dir, e.g. .../model_runs/quiet-window-2026-05-31/.",
    )
    evaluate.add_argument(
        "--out", required=True, type=Path,
        help="Output markdown report path. A .json sidecar is written next to it.",
    )
    evaluate.add_argument(
        "--target-ticks", type=float, default=4.0,
        help="MFE threshold above which a label = 1. Must match training config.",
    )

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
    pipeline.add_argument(
        "--parallel-sessions",
        type=int,
        default=1,
        help=(
            "Run per-session replay + labels concurrently across N worker "
            "processes (default 1 = sequential). Capped at the session count. "
            "Each session is still single-threaded; this only overlaps sessions."
        ),
    )
    research = subparsers.add_parser("research", help="Run empirical research helpers.")
    research_subparsers = research.add_subparsers(dest="research_command")
    sweep = research_subparsers.add_parser(
        "sweep",
        help="Run RA-096 empirical sweep-continuation research.",
    )
    sweep.add_argument(
        "--pair",
        action="append",
        default=[],
        help="Capture pair formatted YYYY-MM-DD:globex or YYYY-MM-DD:rth. Repeatable.",
    )
    sweep.add_argument(
        "--date-range",
        type=str,
        default=None,
        help="Inclusive date range formatted START..END, used with --session.",
    )
    sweep.add_argument(
        "--session",
        action="append",
        choices=("globex", "rth"),
        default=[],
        help="Session to expand for --date-range. Repeatable.",
    )
    sweep.add_argument("--analytics-root", type=Path, default=None)
    sweep.add_argument("--dashboard-root", type=Path, default=None)
    sweep.add_argument("--out-root", type=Path, default=None)
    sweep.add_argument("--run-id", type=str, default=None)
    sweep.add_argument("--target-ticks", type=float, default=4.0)
    sweep.add_argument("--horizons-seconds", type=str, default="1,5,15,60,300")
    sweep.add_argument("--min-cell-samples", type=int, default=30)
    sweep.add_argument("--detector-step-seconds", type=int, default=5)
    sweep.add_argument("--tick-size", type=float, default=0.25)
    sweep.add_argument(
        "--include-partial-sessions",
        action="store_true",
        help="Include partial sessions only in the separately labeled preliminary section.",
    )
    sweep.add_argument(
        "--allow-live-capture-contention",
        action="store_true",
        help="Override the active-capture guard. Use only in a quiet/test window.",
    )
    args = parser.parse_args(argv)
    if args.command == "score":
        return _run_score(args)
    if args.command == "evaluate":
        return _run_evaluate(args)
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
                parallel_sessions=args.parallel_sessions,
            )
        )
        print(
            "scalp_pipeline_complete: "
            f"run_dir={pipeline_result.run_dir} "
            f"manifest={pipeline_result.manifest_path} "
            f"report={pipeline_result.training.report_path}"
        )
        return 0
    if args.command == "research":
        if args.research_command != "sweep":
            research.print_help()
            return 2
        from scalp_models.pipeline import (
            DEFAULT_ANALYTICS_ROOT,
            DEFAULT_DASHBOARD_ROOT,
            PipelineSession,
            SessionName,
            parse_pair,
            sessions_from_date_range,
        )
        from scalp_models.research.sweep import (
            DEFAULT_OUT_ROOT as DEFAULT_RESEARCH_OUT_ROOT,
        )
        from scalp_models.research.sweep import (
            SweepResearchConfig,
            parse_horizons,
            run_sweep_research,
        )

        research_sessions: list[PipelineSession] = [parse_pair(item) for item in args.pair]
        if args.date_range is not None:
            range_sessions = (
                tuple(cast(SessionName, item) for item in args.session)
                if args.session
                else ("globex", "rth")
            )
            research_sessions.extend(sessions_from_date_range(args.date_range, range_sessions))
        if not research_sessions:
            parser.error("research sweep requires at least one --pair or --date-range")
        result = run_sweep_research(
            SweepResearchConfig(
                sessions=tuple(research_sessions),
                analytics_root=args.analytics_root or DEFAULT_ANALYTICS_ROOT,
                dashboard_root=args.dashboard_root or DEFAULT_DASHBOARD_ROOT,
                out_root=args.out_root or DEFAULT_RESEARCH_OUT_ROOT,
                run_id=args.run_id,
                horizons_seconds=parse_horizons(args.horizons_seconds),
                target_ticks=args.target_ticks,
                min_cell_samples=args.min_cell_samples,
                include_partial_sessions=args.include_partial_sessions,
                allow_live_capture_contention=args.allow_live_capture_contention,
                detector_step_seconds=args.detector_step_seconds,
                tick_size=args.tick_size,
            )
        )
        print(
            "sweep_research_complete: "
            f"run_dir={result.run_dir} "
            f"report={result.report_path} "
            f"manifest={result.manifest_path}"
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


def _run_score(args: argparse.Namespace) -> int:
    """RA-094 offline scoring CLI implementation. Loads the trained bundle,
    streams rows from the input setups.jsonl, scores each (row, available
    horizon) combo, writes one prediction line per scored pair.

    Output schema (one JSON object per line):
        {
            "input_row_index": int,
            "ts_ns": int | null,
            "level_id": str | null,
            "setup_type": str,
            "horizon_seconds": int,
            "p_raw": float,
            "p_calibrated": float,
        }

    Failures on individual rows (bad schema, KeyError in feature builder)
    are caught and emitted as ``"error"`` entries so a single malformed row
    doesn't kill the whole run. Final stdout reports counts + skip reasons.
    """
    import json
    from scalp_models.inference import ScalpModelInferenceBundle

    bundle = ScalpModelInferenceBundle(args.models)
    if not bundle.available_setups:
        print(
            f"scalp_models_score_failed: no models loaded from {args.models}/models/",
            flush=True,
        )
        return 2

    args.out.parent.mkdir(parents=True, exist_ok=True)
    counts = {"scored": 0, "skipped_setup_filter": 0, "skipped_no_model": 0, "errors": 0}
    setups_by_type: dict[str, list[int]] = {}

    with args.setups.open("r", encoding="utf-8") as fin, args.out.open(
        "w", encoding="utf-8"
    ) as fout:
        for row_index, line in enumerate(fin):
            if args.max_rows is not None and row_index >= args.max_rows:
                break
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                counts["errors"] += 1
                continue
            setup_type = row.get("setup_type")
            if not isinstance(setup_type, str):
                counts["errors"] += 1
                continue
            if args.setup_type is not None and setup_type != args.setup_type:
                counts["skipped_setup_filter"] += 1
                continue
            setups_by_type.setdefault(setup_type, []).append(row_index)
            ts_ns = row.get("ts_ns")
            level_id = row.get("level_id") if isinstance(row.get("level_id"), str) else None
            matched = False
            for (st, h) in bundle.available_setups:
                if st != setup_type:
                    continue
                matched = True
                try:
                    result = bundle.score(
                        row, setup_type=setup_type, horizon_seconds=h,
                    )
                except Exception as exc:  # noqa: BLE001 — isolate per-row scoring failures
                    fout.write(json.dumps({
                        "input_row_index": row_index,
                        "ts_ns": ts_ns,
                        "level_id": level_id,
                        "setup_type": setup_type,
                        "horizon_seconds": h,
                        "error": f"{type(exc).__name__}: {exc}",
                    }) + "\n")
                    counts["errors"] += 1
                    continue
                if result is None:
                    continue
                fout.write(json.dumps({
                    "input_row_index": row_index,
                    "ts_ns": ts_ns,
                    "level_id": level_id,
                    "setup_type": setup_type,
                    "horizon_seconds": h,
                    "p_raw": result.p_raw,
                    "p_calibrated": result.p_calibrated,
                }) + "\n")
                counts["scored"] += 1
            if not matched:
                counts["skipped_no_model"] += 1

    breakdown = {st: len(idxs) for st, idxs in setups_by_type.items()}
    print(
        "scalp_models_scored: "
        f"out={args.out} "
        f"scored={counts['scored']} "
        f"skipped_setup_filter={counts['skipped_setup_filter']} "
        f"skipped_no_model={counts['skipped_no_model']} "
        f"errors={counts['errors']} "
        f"input_rows_by_setup_type={breakdown}"
    )
    return 0


def _run_evaluate(args: argparse.Namespace) -> int:
    """RA-094 offline performance evaluator: joins setups+labels, scores
    each eligible example with the trained bundle, computes per-cell metrics,
    emits a markdown report + JSON sidecar.
    """
    import json
    from dataclasses import asdict
    from scalp_models.evaluate import evaluate, render_markdown_report, cell_to_dict

    result = evaluate(
        run_dir=args.models,
        setups_path=args.setups,
        labels_path=args.labels,
        target_ticks=args.target_ticks,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(render_markdown_report(result), encoding="utf-8")
    sidecar = args.out.with_suffix(args.out.suffix + ".json")
    sidecar_payload = {
        "run_dir": result.run_dir,
        "setups_path": result.setups_path,
        "labels_path": result.labels_path,
        "n_setup_rows": result.n_setup_rows,
        "n_label_rows": result.n_label_rows,
        "n_excluded_by_status": result.n_excluded_by_status,
        "cells": [cell_to_dict(c) for c in result.cells],
    }
    sidecar.write_text(json.dumps(sidecar_payload, indent=2), encoding="utf-8")

    n_cells = sum(1 for c in result.cells if c.n_total > 0)
    n_skipped = sum(1 for c in result.cells if c.note and "no_model" in c.note)
    print(
        "scalp_models_evaluated: "
        f"report={args.out} "
        f"sidecar={sidecar} "
        f"cells_with_data={n_cells} "
        f"cells_skipped_no_model={n_skipped} "
        f"setup_rows={result.n_setup_rows} "
        f"label_rows={result.n_label_rows}"
    )
    return 0
