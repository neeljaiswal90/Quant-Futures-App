"""Command-line entry point for RA-090a detector replay datasets."""

from __future__ import annotations

import argparse
from collections.abc import Sequence
from pathlib import Path

from replay.runner import ReplayConfig, run_replay

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_ANALYTICS_ROOT = REPO_ROOT / "tools" / "rithmic_analytics"
DEFAULT_DASHBOARD_ROOT = REPO_ROOT / "tools" / "rithmic_dashboard"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Replay a Rithmic capture through the live Python detector stack.",
    )
    parser.add_argument("--capture-date", required=True, help="Trading date, YYYY-MM-DD.")
    parser.add_argument("--session", required=True, choices=("globex", "rth"))
    parser.add_argument("--out", required=True, type=Path, help="Output dataset JSONL path.")
    parser.add_argument(
        "--analytics-root",
        type=Path,
        default=DEFAULT_ANALYTICS_ROOT,
        help="Rithmic analytics root containing data/captures and data/zones.",
    )
    parser.add_argument(
        "--dashboard-root",
        type=Path,
        default=DEFAULT_DASHBOARD_ROOT,
        help="Dashboard root used for live_analysis threshold JSON seeding.",
    )
    parser.add_argument(
        "--scratch-dir",
        type=Path,
        default=None,
        help="Optional isolated scratch directory. Existing contents are replaced.",
    )
    parser.add_argument("--step-ms", type=int, default=500)
    parser.add_argument("--depth-n-ticks", type=int, default=20)
    parser.add_argument("--limit-steps", type=int, default=None)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    result = run_replay(
        ReplayConfig(
            analytics_root=args.analytics_root,
            dashboard_root=args.dashboard_root,
            capture_date=args.capture_date,
            session=args.session,
            out_path=args.out,
            scratch_dir=args.scratch_dir,
            step_ms=args.step_ms,
            depth_n_ticks=args.depth_n_ticks,
            limit_steps=args.limit_steps,
        )
    )
    print(
        "replay_dataset_written: "
        f"rows={result.row_count} sha256={result.dataset_sha256} "
        f"dataset={result.out_path} manifest={result.manifest_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
