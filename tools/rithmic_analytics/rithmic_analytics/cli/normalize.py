"""``python -m rithmic_analytics.cli.normalize`` — probe-parity → OBS-01 CLI.

Wraps :func:`rithmic_analytics.ops.normalize_probe.normalize_probe_to_obs01`.

Exit codes:
    0 — success
    1 — bad input (file missing, unrecoverable capture, parse errors)
    2 — usage error (output exists and --force not set, bad session_id)

Example::

    python -m rithmic_analytics.cli.normalize \\
        --input data\\captures\\2026-05-20\\MNQ_rth.jsonl \\
        --output data\\captures\\2026-05-20\\MNQ_rth.obs01.jsonl

Idempotent — refuses to overwrite an existing ``--output`` unless ``--force``.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from rithmic_analytics.ops.normalize_probe import (
    UnrecoverableCaptureError,
    normalize_probe_to_obs01,
)

EXIT_OK: int = 0
EXIT_BAD_INPUT: int = 1
EXIT_USAGE: int = 2

_LOG = logging.getLogger("rithmic_analytics.normalize")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m rithmic_analytics.cli.normalize",
        description=(
            "Transform probe-parity JSONL records into OBS-01 envelope JSONL "
            "consumable by load_obs01_trades(). Pure JSON transformation — "
            "no protobuf parsing."
        ),
    )
    parser.add_argument(
        "--input", type=Path, required=True,
        help="Path to probe-parity JSONL (raw capture).",
    )
    parser.add_argument(
        "--output", type=Path, required=True,
        help="Destination OBS-01 JSONL path. Convention: <ROOT>_<session>.obs01.jsonl",
    )
    parser.add_argument(
        "--mbp1-output", type=Path, default=None,
        help=(
            "Destination MBP1 JSONL path. Default: derive from --output by "
            "swapping .obs01.jsonl → .mbp1.jsonl. Pass --skip-mbp1 to disable."
        ),
    )
    parser.add_argument(
        "--skip-mbp1", action="store_true",
        help=(
            "Disable MBP1 emission entirely. Use only if you specifically "
            "need the OBS-01 file without the MBP1 sibling (rare). The "
            "absorption detector needs MBP1 — without it, displacement_factor "
            "is pinned to 0."
        ),
    )
    # RA-035: MBO sibling routing
    parser.add_argument(
        "--mbo-output", type=Path, default=None,
        help=(
            "Destination MBO JSONL path. Default: derive from --output by "
            "swapping .obs01.jsonl → .mbo.jsonl. Pass --skip-mbo to disable."
        ),
    )
    parser.add_argument(
        "--skip-mbo", action="store_true",
        help=(
            "Disable MBO emission entirely. Without MBO, the order_pressure "
            "detector (RA-035) has no input."
        ),
    )
    parser.add_argument(
        "--session-id", type=str, default=None,
        help=(
            "Session ID for the output envelopes. Default: derive from "
            "input path (data/captures/YYYY-MM-DD/<ROOT>_<session>.jsonl)."
        ),
    )
    parser.add_argument(
        "--run-id", type=str, default=None,
        help=(
            "run_id field stamped on emitted records. Default: "
            "normalize-<session-id>."
        ),
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Overwrite --output if it already exists.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. See module docstring for exit-code semantics."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = _build_parser().parse_args(argv)

    def _derive_sibling(suffix: str) -> Path:
        """``out.obs01.jsonl`` → ``out.<suffix>.jsonl`` (or fallback)."""
        out_path: Path = args.output
        out_str = str(out_path)
        if out_str.endswith(".obs01.jsonl"):
            return Path(out_str[: -len(".obs01.jsonl")] + f".{suffix}.jsonl")
        if out_str.endswith(".jsonl"):
            return Path(out_str[: -len(".jsonl")] + f".{suffix}.jsonl")
        return Path(out_str + f".{suffix}.jsonl")

    # Resolve mbp1 output: explicit > auto-derived > skipped
    mbp1_out: Path | None
    if args.skip_mbp1:
        mbp1_out = None
        if args.mbp1_output is not None:
            _LOG.warning(
                "--skip-mbp1 set; ignoring --mbp1-output. MBP1 sibling will "
                "NOT be produced. Absorption will run in degraded 3-factor mode."
            )
    elif args.mbp1_output is not None:
        mbp1_out = args.mbp1_output
    else:
        mbp1_out = _derive_sibling("mbp1")

    # RA-035: Resolve mbo output (same shape as mbp1)
    mbo_out: Path | None
    if args.skip_mbo:
        mbo_out = None
        if args.mbo_output is not None:
            _LOG.warning(
                "--skip-mbo set; ignoring --mbo-output. MBO sibling will "
                "NOT be produced. order_pressure (RA-035) needs MBO."
            )
    elif args.mbo_output is not None:
        mbo_out = args.mbo_output
    else:
        mbo_out = _derive_sibling("mbo")

    try:
        report = normalize_probe_to_obs01(
            args.input, args.output,
            mbp1_out_path=mbp1_out,
            mbo_out_path=mbo_out,
            session_id=args.session_id,
            run_id=args.run_id,
            overwrite=args.force,
        )
    except FileNotFoundError as exc:
        _LOG.error(str(exc))
        return EXIT_BAD_INPUT
    except FileExistsError as exc:
        _LOG.error(str(exc))
        return EXIT_USAGE
    except UnrecoverableCaptureError as exc:
        _LOG.error(f"UNRECOVERABLE CAPTURE: {exc}")
        return EXIT_BAD_INPUT
    except ValueError as exc:
        _LOG.error(str(exc))
        return EXIT_USAGE

    # Emit the report summary to stderr per ticket spec
    sys.stderr.write(json.dumps(report.to_dict(), indent=2) + "\n")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
