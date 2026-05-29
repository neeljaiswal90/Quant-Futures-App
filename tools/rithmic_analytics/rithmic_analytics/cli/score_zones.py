"""``python -m rithmic_analytics.cli.score_zones`` — RA-027 zone-quality CLI.

Two modes:

1. **Single-session**: `--zones <path> --jsonl <path> --output <quality.json>`
   Classify one set of zones against one capture session; write JSON report.

2. **Aggregate** (`--aggregate-from-dir`): walk a directory of zone JSON
   files + matching captures, build per-session reports, and emit a rolling
   :class:`HistoryReport` with Wilson 95% CI per conviction tier.

Pairing modes for aggregate (`--pairing`):

- ``next-day``  (default) — yesterday's RTH zones tested against today's
  RTH price action. **This is the structural feedback loop.**
- ``globex-to-rth`` — overnight-Globex zones tested against same-day RTH.
- ``same-day`` — zones tested against their own session. **Post-hoc only**,
  emits a WARNING on use; useful for VP-algorithm tuning, not trading
  signal validation.

Exit codes:
    0 — success
    1 — bad input (file missing, unparseable)
    2 — usage error (mutually exclusive modes, bad arg combination)
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import re
import sys
from datetime import date, timedelta
from pathlib import Path

import jsonschema

from rithmic_analytics.core.contracts import MNQ
from rithmic_analytics.core.loader import load_obs01_trades
from rithmic_analytics.core.schema import Zone, validate_envelope
from rithmic_analytics.features.zone_quality import (
    HistoryReport,
    Pairing,
    SessionQualityReport,
    aggregate_history,
    score_session,
)

EXIT_OK: int = 0
EXIT_BAD_INPUT: int = 1
EXIT_USAGE: int = 2

_LOG = logging.getLogger("rithmic_analytics.score_zones")

# zones/{YYYY-MM-DD}_{ROOT}_{session}.json
_ZONES_FILENAME_RE = re.compile(
    r"^(?P<date>\d{4}-\d{2}-\d{2})_(?P<root>[A-Z][A-Z0-9]*)_(?P<session>rth|globex)\.json$"
)


# ---------------------------------------------------------------------------
# Zone-envelope loader (shared with replay_session)
# ---------------------------------------------------------------------------


def _load_zones_envelope(path: Path) -> tuple[list[Zone], float | None]:
    """Parse a zone-envelope JSON file. Returns ``(zones, atr_14_or_None)``."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    validate_envelope(payload)
    zones = [
        Zone(
            id=z["id"],
            top=z["top"],
            bot=z["bot"],
            type=z["type"],
            conviction=z["conviction"],
            text=z["text"],
            sources=list(z["sources"]),
            volume_pct=z.get("volume_pct"),
            multi_tf_count=z.get("multi_tf_count"),
            multi_session_count=z.get("multi_session_count"),
        )
        for z in payload.get("zones", [])
    ]
    atr_raw = payload.get("atr_14")
    if atr_raw is None:
        atr_14: float | None = None
    else:
        atr_val = float(atr_raw)
        atr_14 = None if math.isnan(atr_val) else atr_val
    return zones, atr_14


# ---------------------------------------------------------------------------
# Aggregate-mode helpers
# ---------------------------------------------------------------------------


def _parse_zones_filename(name: str) -> tuple[date, str, str] | None:
    """``"2026-05-19_MNQ_rth.json"`` → ``(date, "MNQ", "rth")`` or None."""
    m = _ZONES_FILENAME_RE.match(name)
    if not m:
        return None
    try:
        return (
            date.fromisoformat(m.group("date")),
            m.group("root"),
            m.group("session"),
        )
    except ValueError:
        return None


def _find_capture_path(
    captures_root: Path, trading_date: date, root_symbol: str, session: str
) -> Path | None:
    """Returns the matching JSONL path if it exists, else None."""
    candidate = (
        captures_root
        / trading_date.isoformat()
        / f"{root_symbol}_{session}.jsonl"
    )
    return candidate if candidate.exists() else None


def _resolve_pair(
    zones_meta: tuple[date, str, str],
    *,
    pairing: Pairing,
    captures_root: Path,
    max_forward_days: int = 7,
) -> tuple[date, Path] | None:
    """Given a zones file's (date, root, session), return the trading-date +
    capture path that should be scored against per ``pairing``. Returns None
    if no matching capture exists.

    - ``next-day``: zones day N rth → capture day N+1 rth (skipping
      non-existent days up to ``max_forward_days`` for weekends/holidays).
    - ``globex-to-rth``: zones day N globex → capture day N rth.
    - ``same-day``: zones day N session → capture day N same-session.
    """
    zones_date, root, session = zones_meta
    if pairing == "same-day":
        cap = _find_capture_path(captures_root, zones_date, root, session)
        return (zones_date, cap) if cap is not None else None
    if pairing == "globex-to-rth":
        if session != "globex":
            return None  # only Globex zones feed RTH pairing
        cap = _find_capture_path(captures_root, zones_date, root, "rth")
        return (zones_date, cap) if cap is not None else None
    # next-day
    for offset in range(1, max_forward_days + 1):
        candidate_date = zones_date + timedelta(days=offset)
        cap = _find_capture_path(captures_root, candidate_date, root, session)
        if cap is not None:
            return candidate_date, cap
    return None


def _build_session_reports(
    zones_dir: Path,
    captures_root: Path,
    *,
    pairing: Pairing,
    settlement_window_minutes: int,
    internal_carveout_minutes: int,
) -> list[SessionQualityReport]:
    """Walk zones_dir, pair each file per ``pairing``, score and return reports."""
    reports: list[SessionQualityReport] = []
    for zones_file in sorted(zones_dir.iterdir()):
        if not zones_file.is_file():
            continue
        meta = _parse_zones_filename(zones_file.name)
        if meta is None:
            _LOG.debug(f"skipping non-matching filename: {zones_file.name}")
            continue
        pair = _resolve_pair(meta, pairing=pairing, captures_root=captures_root)
        if pair is None:
            _LOG.info(
                f"no capture pair for {zones_file.name} under pairing={pairing}; "
                f"skipping"
            )
            continue
        trading_date, capture_path = pair
        try:
            zones, atr = _load_zones_envelope(zones_file)
        except (json.JSONDecodeError, KeyError, jsonschema.ValidationError) as exc:
            _LOG.warning(f"could not load zones {zones_file.name}: {exc}; skipping")
            continue
        try:
            trades = load_obs01_trades(capture_path)
        except (json.JSONDecodeError, KeyError, ValueError) as exc:
            _LOG.warning(f"could not load capture {capture_path}: {exc}; skipping")
            continue
        report = score_session(
            zones, trades, MNQ,
            atr_14=atr,
            settlement_window_minutes=settlement_window_minutes,
            internal_carveout_minutes=internal_carveout_minutes,
            pairing=pairing,
            trading_date_override=trading_date,
        )
        reports.append(report)
        _LOG.info(
            f"scored zones={zones_file.name} → trades={capture_path.parent.name}: "
            f"{len(report.outcomes)} outcomes"
        )
    return reports


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m rithmic_analytics.cli.score_zones",
        description=(
            "Classify zones against captured price action and emit a "
            "per-session or rolling-history quality report."
        ),
    )
    # Single-session args (mutually exclusive with --aggregate-from-dir)
    parser.add_argument(
        "--zones", type=Path, default=None,
        help="Zone envelope JSON for single-session mode.",
    )
    parser.add_argument(
        "--jsonl", type=Path, default=None,
        help="OBS-01 capture JSONL for single-session mode.",
    )
    # Aggregate-mode args
    parser.add_argument(
        "--aggregate-from-dir", type=Path, default=None,
        help=(
            "Directory of historical zone JSON files. Requires "
            "--captures-root; produces a rolling-window HistoryReport."
        ),
    )
    parser.add_argument(
        "--captures-root", type=Path, default=Path("data/captures"),
        help="Capture root for aggregate mode. Default: data/captures.",
    )
    # Shared args
    parser.add_argument(
        "--output", type=Path, required=True,
        help="Where to write the resulting JSON report.",
    )
    parser.add_argument(
        "--pairing",
        choices=["next-day", "globex-to-rth", "same-day"],
        default="next-day",
        help=(
            "Pairing rule for aggregate mode. 'next-day' (default): "
            "yesterday's zones → today's session — structural feedback. "
            "'globex-to-rth': overnight-Globex zones → same-day RTH. "
            "'same-day': zones → own session — post-hoc, VP-tuning only "
            "(emits warning)."
        ),
    )
    parser.add_argument(
        "--window-sessions", type=int, default=30,
        help="Rolling window size for aggregate mode. Default 30.",
    )
    parser.add_argument(
        "--settlement-window-minutes", type=int, default=10,
        help=(
            "Minimum minutes between first touch and end of capture for a "
            "no-break to count as 'held' (else 'ambiguous'). 10-min default "
            "gives one full 5-min bar of follow-through. Default: 10."
        ),
    )
    parser.add_argument(
        "--internal-carveout-minutes", type=int, default=5,
        help=(
            "Window for the internal-at-open carveout: if price opens "
            "inside a zone but exits cleanly within this window, reclassify "
            "by exit direction. Default: 5."
        ),
    )
    return parser


def _validate_args_modes(args: argparse.Namespace) -> tuple[bool, str | None]:
    """Returns ``(ok, error_msg)``."""
    aggregate = args.aggregate_from_dir is not None
    single = args.zones is not None or args.jsonl is not None
    if aggregate and single:
        return False, (
            "--aggregate-from-dir is mutually exclusive with --zones/--jsonl; "
            "use one mode or the other"
        )
    if not aggregate and not single:
        return False, "must specify either --zones+--jsonl OR --aggregate-from-dir"
    if single and (args.zones is None or args.jsonl is None):
        return False, "single-session mode requires both --zones and --jsonl"
    return True, None


def _run_single_session(args: argparse.Namespace) -> int:
    if not args.zones.exists():
        _LOG.error(f"--zones path does not exist: {args.zones}")
        return EXIT_BAD_INPUT
    if not args.jsonl.exists():
        _LOG.error(f"--jsonl path does not exist: {args.jsonl}")
        return EXIT_BAD_INPUT
    try:
        zones, atr = _load_zones_envelope(args.zones)
    except (json.JSONDecodeError, KeyError, jsonschema.ValidationError) as exc:
        _LOG.error(f"failed to load zones {args.zones}: {exc}")
        return EXIT_BAD_INPUT
    try:
        trades = load_obs01_trades(args.jsonl)
    except (json.JSONDecodeError, KeyError, ValueError) as exc:
        _LOG.error(f"failed to load JSONL {args.jsonl}: {exc}")
        return EXIT_BAD_INPUT

    _LOG.info(f"loaded {len(zones)} zones, {len(trades):,} trades")

    report = score_session(
        zones, trades, MNQ,
        atr_14=atr,
        settlement_window_minutes=args.settlement_window_minutes,
        internal_carveout_minutes=args.internal_carveout_minutes,
        pairing=args.pairing,
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report.to_dict(), indent=2, default=str), encoding="utf-8"
    )
    _LOG.info(f"wrote session quality report → {args.output}")
    return EXIT_OK


def _run_aggregate(args: argparse.Namespace) -> int:
    if not args.aggregate_from_dir.exists():
        _LOG.error(f"--aggregate-from-dir path does not exist: {args.aggregate_from_dir}")
        return EXIT_BAD_INPUT
    if not args.captures_root.exists():
        _LOG.error(f"--captures-root does not exist: {args.captures_root}")
        return EXIT_BAD_INPUT

    if args.pairing == "same-day":
        _LOG.warning(
            "same-day pairing is post-hoc and not a forward trading signal — "
            "use only for VP algorithm tuning. For structural feedback use "
            "'next-day' or 'globex-to-rth'."
        )

    reports = _build_session_reports(
        args.aggregate_from_dir, args.captures_root,
        pairing=args.pairing,
        settlement_window_minutes=args.settlement_window_minutes,
        internal_carveout_minutes=args.internal_carveout_minutes,
    )

    if not reports:
        _LOG.warning("no session reports built — output will reflect empty history")

    history: HistoryReport = aggregate_history(
        reports, window_sessions=args.window_sessions
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(history.to_dict(), indent=2, default=str), encoding="utf-8"
    )
    _LOG.info(
        f"wrote history report ({history.sessions_analyzed} sessions, "
        f"pairing={history.pairing}) → {args.output}"
    )
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. See module docstring for exit-code semantics."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = _build_parser().parse_args(argv)

    ok, err = _validate_args_modes(args)
    if not ok:
        _LOG.error(err)
        return EXIT_USAGE

    if args.settlement_window_minutes < 0:
        _LOG.error("--settlement-window-minutes must be >= 0")
        return EXIT_USAGE
    if args.internal_carveout_minutes < 0:
        _LOG.error("--internal-carveout-minutes must be >= 0")
        return EXIT_USAGE
    if args.window_sessions <= 0:
        _LOG.error("--window-sessions must be > 0")
        return EXIT_USAGE

    if args.aggregate_from_dir is not None:
        return _run_aggregate(args)
    return _run_single_session(args)


if __name__ == "__main__":
    sys.exit(main())
