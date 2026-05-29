"""``python -m rithmic_analytics.cli.rotate`` — capture-file rotation CLI.

Thin wrapper over :func:`rithmic_analytics.ops.rotation.apply_rotation` /
:func:`plan_rotation`. Used by the ``RithmicRotation`` scheduled task; also
usable for manual / ad-hoc runs.

Exit codes:
    0 — success (rotation completed, even with per-file errors recorded in the report)
    1 — bad config (captures root missing or unreadable)
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

from rithmic_analytics.ops.rotation import (
    apply_rotation,
    plan_rotation,
)

EXIT_OK: int = 0
EXIT_BAD_CONFIG: int = 1


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m rithmic_analytics.cli.rotate",
        description="Rotate capture files: compress raw, delete old archives.",
    )
    parser.add_argument(
        "--captures-root",
        type=Path,
        default=Path("data/captures"),
        help="Live capture directory. Default: data/captures.",
    )
    parser.add_argument(
        "--archive-root",
        type=Path,
        default=None,
        help="Archive directory. Defaults to {captures_root.parent}/{captures_root.name}_archive.",
    )
    parser.add_argument(
        "--reference-date",
        type=date.fromisoformat,
        default=None,
        help="YYYY-MM-DD 'today' for age calculations. Defaults to UTC today.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Plan only — print the planned actions without modifying any files.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    args = _build_parser().parse_args(argv)

    if args.dry_run:
        report = plan_rotation(
            args.captures_root,
            archive_root=args.archive_root,
            reference_date=args.reference_date,
        )
    else:
        report = apply_rotation(
            args.captures_root,
            archive_root=args.archive_root,
            reference_date=args.reference_date,
        )

    print(json.dumps(report.to_dict(), indent=2, default=str))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
