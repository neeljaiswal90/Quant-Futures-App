"""``python -m rithmic_analytics.cli.tv_sync`` — TV chart-sync orchestrator (RA-034).

Two-phase architecture (Q-new-1: Option A):

1. **Python (this CLI)**: read zones JSON + state file, compute the
   :class:`TVSyncPlan`. ``--dry-run`` (default) prints; ``--apply``
   writes the plan to ``data/tv_sync_plans/<backend>_<chart_id>_<ts>.json``
   and updates ``_latest.json`` pointer.
2. **Executor agent** (Claude Code session with TV-MCP / Chrome-MCP
   tools, NOT this Python process): reads the plan file, invokes MCP
   tools per operation, writes back the state file with new shape_ids.

This split means the Python phase is schedulable (zero infra), and the
plan file is a permanent artifact that survives mid-execution crashes.

Exit codes:
    0 — plan computed successfully for all targeted backends
    1 — bad input (zones JSON missing / invalid)
    2 — usage error (mutually exclusive flags, bad target, etc.)

Per RA-034's "never fail one-because-of-other" rule: a per-backend
failure (e.g. state file locked) emits WARN, does NOT gate other
backends, and exits 0 if any backend planned successfully.

Example::

    python -m rithmic_analytics.cli.tv_sync \\
        --zones data/zones/2026-05-20_MNQ_rth.json \\
        --target both \\
        --apply
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import UTC, datetime
from pathlib import Path

import jsonschema

from rithmic_analytics.core.schema import validate_envelope
from rithmic_analytics.viewer.tv_publisher import (
    TVSyncPlan,
    load_state,
    plan_sync,
    write_latest_pointer,
    write_plan,
)

EXIT_OK: int = 0
EXIT_BAD_INPUT: int = 1
EXIT_USAGE: int = 2

_LOG = logging.getLogger("rithmic_analytics.tv_sync")

_VALID_BACKENDS: tuple[str, ...] = ("tv_desktop", "tradesea")
_DEFAULT_STATE_ROOT: Path = Path("data/tv_sync_state")
_DEFAULT_PLANS_ROOT: Path = Path("data/tv_sync_plans")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m rithmic_analytics.cli.tv_sync",
        description=(
            "Plan TV / Tradesea chart-shape updates from a zones JSON. "
            "Python plans; the executor agent applies via MCP tools."
        ),
    )
    parser.add_argument(
        "--zones", type=Path, required=True,
        help="Path to the zones JSON envelope.",
    )
    parser.add_argument(
        "--target",
        choices=["tv_desktop", "tradesea", "both"],
        default="both",
        help="Which backend(s) to plan for. Default: both.",
    )
    parser.add_argument(
        "--chart-id", type=str, default=None,
        help=(
            "Chart identifier for state-file key. Default: zones envelope's "
            "``symbol`` field (e.g. MNQ). Override for multi-layout setups."
        ),
    )
    parser.add_argument(
        "--state-root", type=Path, default=_DEFAULT_STATE_ROOT,
        help="State-file root. Default: data/tv_sync_state.",
    )
    parser.add_argument(
        "--plans-root", type=Path, default=_DEFAULT_PLANS_ROOT,
        help="Plan-file root. Default: data/tv_sync_plans.",
    )

    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--dry-run", dest="dry_run", action="store_true", default=True,
        help=(
            "Print the plan to stderr; don't write plan-file. Default mode. "
            "Mirrors daily_zones' smoke-before-flip pattern."
        ),
    )
    mode.add_argument(
        "--apply", dest="dry_run", action="store_false",
        help=(
            "Write the plan-file to <plans-root>/<backend>_<chart_id>_<ts>.json "
            "and update <plans-root>/_latest.json. The executor agent reads "
            "these and invokes MCP tools."
        ),
    )
    return parser


def _load_envelope(zones_path: Path) -> dict[str, object]:
    payload = json.loads(zones_path.read_text(encoding="utf-8"))
    validate_envelope(payload)
    if not isinstance(payload, dict):
        raise ValueError(f"zones JSON root is not an object: {zones_path}")
    return payload


def _resolve_chart_id(args_chart_id: str | None, envelope: dict[str, object]) -> str:
    if args_chart_id is not None:
        return args_chart_id
    symbol = envelope.get("symbol")
    if not isinstance(symbol, str) or not symbol:
        raise ValueError(
            "zones envelope has no 'symbol' field; pass --chart-id explicitly"
        )
    return symbol


def _state_path(state_root: Path, backend: str, chart_id: str) -> Path:
    return state_root / f"{backend}_{chart_id}.json"


def _plan_path(plans_root: Path, backend: str, chart_id: str) -> Path:
    ts = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return plans_root / f"{backend}_{chart_id}_{ts}.json"


def _plan_for_backend(
    *,
    backend: str,
    envelope: dict[str, object],
    chart_id: str,
    zones_path: Path,
    state_root: Path,
    plans_root: Path,
) -> tuple[TVSyncPlan, Path]:
    """Returns ``(plan, plan_output_path)``. Output path provisional —
    caller writes only on ``--apply``."""
    state_path = _state_path(state_root, backend, chart_id)
    plan_path = _plan_path(plans_root, backend, chart_id)
    state = load_state(state_path)
    plan = plan_sync(
        envelope=envelope,
        state=state,
        backend=backend,
        chart_id=chart_id,
        zones_json_path=zones_path,
        state_path=state_path,
    )
    return plan, plan_path


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. See module docstring for two-phase architecture."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = _build_parser().parse_args(argv)

    if not args.zones.exists():
        _LOG.error(f"zones path not found: {args.zones}")
        return EXIT_BAD_INPUT

    try:
        envelope = _load_envelope(args.zones)
    except (json.JSONDecodeError, jsonschema.ValidationError, ValueError) as exc:
        _LOG.error(f"failed to load zones envelope {args.zones}: {exc}")
        return EXIT_BAD_INPUT

    try:
        chart_id = _resolve_chart_id(args.chart_id, envelope)
    except ValueError as exc:
        _LOG.error(str(exc))
        return EXIT_USAGE

    targets: tuple[str, ...] = (
        _VALID_BACKENDS if args.target == "both" else (args.target,)
    )

    any_planned = False
    for backend in targets:
        try:
            plan, plan_path = _plan_for_backend(
                backend=backend,
                envelope=envelope,
                chart_id=chart_id,
                zones_path=args.zones,
                state_root=args.state_root,
                plans_root=args.plans_root,
            )
        except (json.JSONDecodeError, OSError, ValueError) as exc:
            # Per "never fail one-because-of-other": warn + continue
            _LOG.warning(
                f"tv_sync: backend {backend!r} planning failed (other targets "
                f"still attempted): {exc}"
            )
            continue

        if args.dry_run:
            _LOG.info(f"[DRY-RUN] {plan.summary_line()}")
            print(json.dumps(plan.to_dict(), indent=2))
        else:
            write_plan(plan, plan_path)
            latest_path = write_latest_pointer(args.plans_root, plan_path, backend)
            _LOG.info(
                f"[APPLY] {plan.summary_line()} → {plan_path.name} "
                f"(latest: {latest_path.name})"
            )

        any_planned = True

    if not any_planned:
        _LOG.error("no backends produced a plan — all failed")
        return EXIT_BAD_INPUT

    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
