"""``python -m rithmic_analytics.cli.start_capture`` — probe supervision wrapper.

Resolves the front-month contract, loads credentials, computes the session
window in ET, sleeps if launched early (capped), no-ops if launched after the
window closed, spawns ``capture-rithmic-probe.py`` as a subprocess, captures
stdout/stderr to ``wrapper.log`` alongside the JSONL output, and translates the
probe's exit code to operationally meaningful wrapper exit codes.

Exit codes (designed for Task Scheduler visibility):
    0   — probe completed cleanly
    1   — probe ran but reported errors (partial data; check alerts.ndjson)
    2   — wrapper pre-flight failed (bad creds, unknown root symbol, calendar
          miss, output path uncreatable, far-pre-window launch)
    3   — probe pre-flight failed (connectivity / credential rejection)
    130 — SIGINT received during supervision (clean wrapper teardown)

File layout (trading-day partitioned):
    data/captures/{YYYY-MM-DD}/{ROOT}_{SESSION}.jsonl  — primary capture
    data/captures/{YYYY-MM-DD}/wrapper.log             — wrapper + probe stdio

The trading day is computed from ET wall-clock, not the calendar date the
wrapper launches on, so a Globex session started at 23:00 ET on 5/14 lands
under ``2026-05-15/`` (the day it ends on).
"""

from __future__ import annotations

import argparse
import logging
import signal
import subprocess
import sys
import time
from datetime import UTC, date, datetime, timedelta
from datetime import time as dtime
from pathlib import Path
from types import FrameType
from zoneinfo import ZoneInfo

from rithmic_analytics.ops.credentials import (
    CredentialsMissing,
    RithmicCredentials,
    load_credentials,
)
from rithmic_analytics.ops.rollover_calendar import (
    RolloverCalendarMiss,
    resolve_front_month,
)

EXIT_OK: int = 0
EXIT_PROBE_ERRORS: int = 1
EXIT_BAD_CONFIG: int = 2
EXIT_PROBE_PREFLIGHT: int = 3
EXIT_SIGINT: int = 130

_DEFAULT_STREAMS: str = "L1_QUOTE,LAST_TRADE,MBO"
_DEFAULT_CAPTURES_ROOT: Path = Path("data/captures")
_MAX_PRE_WINDOW_SLEEP_SEC: int = 600  # 10 min — beyond that, something is broken upstream
_TERMINATE_GRACE_SEC: int = 5

_ET: ZoneInfo = ZoneInfo("America/New_York")

# Path to the QFA probe script. parents[4] of this file resolves to
# D:\Quant-futures-app\, where scripts/infra/capture-rithmic-probe.py lives.
_PROBE_SCRIPT: Path = (
    Path(__file__).resolve().parents[4] / "scripts" / "infra" / "capture-rithmic-probe.py"
)

_LOG = logging.getLogger("rithmic_analytics.start_capture")


# ---------------------------------------------------------------------------
# Time / session helpers (factored for monkeypatching in tests)
# ---------------------------------------------------------------------------


def _now_et() -> datetime:
    return datetime.now(_ET)


def _today_et() -> date:
    return _now_et().date()


def compute_trading_date(now_et: datetime, session: str) -> date:
    """Compute the trading-day folder for a session launched at ``now_et``.

    RTH always belongs to the wall-clock calendar date. Globex straddles
    midnight (17:55 prev day → 09:30 trading day); a launch >= 12:00 ET is
    treated as the evening before, so it goes into *tomorrow's* trading-day
    folder. An AM launch (< 12:00 ET) of a Globex job is treated as the same
    trading day.

    Example:
        >>> from datetime import datetime
        >>> from zoneinfo import ZoneInfo
        >>> et = ZoneInfo("America/New_York")
        >>> compute_trading_date(datetime(2026, 5, 14, 23, 0, tzinfo=et), "globex")
        datetime.date(2026, 5, 15)
        >>> compute_trading_date(datetime(2026, 5, 15, 9, 25, tzinfo=et), "rth")
        datetime.date(2026, 5, 15)
    """
    if session == "rth":
        return now_et.date()
    if session == "globex":
        # 12:00 ET split: PM launch → tomorrow; AM launch → today.
        if now_et.hour >= 12:
            return now_et.date() + timedelta(days=1)
        return now_et.date()
    raise ValueError(f"unknown session: {session!r}")


def compute_session_window(trading_date: date, session: str) -> tuple[datetime, datetime]:
    """Return (start, end) datetimes in ET for the given trading-day session.

    RTH: 09:25–16:05 ET on ``trading_date``.
    Globex: 17:55 ET prior day → 09:30 ET ``trading_date``.
    """
    if session == "rth":
        start = datetime.combine(trading_date, dtime(9, 25), tzinfo=_ET)
        end = datetime.combine(trading_date, dtime(16, 5), tzinfo=_ET)
    elif session == "globex":
        start = datetime.combine(trading_date - timedelta(days=1), dtime(17, 55), tzinfo=_ET)
        end = datetime.combine(trading_date, dtime(9, 30), tzinfo=_ET)
    else:
        raise ValueError(f"unknown session: {session!r}")
    return start, end


def _sleep_until(target_dt: datetime) -> None:
    """Sleep in 1-second steps so SIGINT can interrupt cleanly on Windows."""
    while _now_et() < target_dt:
        time.sleep(1.0)


def _output_path(captures_root: Path, trading_date: date, root_symbol: str, session: str) -> Path:
    return captures_root / trading_date.isoformat() / f"{root_symbol}_{session}.jsonl"


# ---------------------------------------------------------------------------
# Subprocess (factored for monkeypatching in tests)
# ---------------------------------------------------------------------------


def _build_probe_cmd(
    *,
    creds: RithmicCredentials,
    contract: str,
    duration_sec: int,
    streams: str,
    exchange: str,
    out_path: Path,
    parity_payload: bool,
) -> list[str]:
    cmd = [
        sys.executable,
        str(_PROBE_SCRIPT),
        "--connect-point", creds.connect_point,
        "--system-name", creds.system_name,
        "--user", creds.user,
        "--password", creds.password,
        "--rprotocol-home", creds.rprotocol_home,
        "--symbol", contract,
        "--exchange", exchange,
        "--duration-sec", str(duration_sec),
        "--streams", streams,
        "--out", str(out_path),
    ]
    if parity_payload:
        cmd.append("--parity-payload")
    return cmd


def _spawn_probe(cmd: list[str], log_path: Path) -> subprocess.Popen[bytes]:
    """Spawn the probe and redirect its stdout/stderr to ``log_path``.

    Factored so tests can monkey-patch with a fake-process injector.
    """
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_file = log_path.open("ab")  # append, binary; closed when wrapper exits
    return subprocess.Popen(
        cmd,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        bufsize=0,
    )


def _install_sigint_handler(proc: subprocess.Popen[bytes]) -> None:
    """Install SIGINT handler that gracefully terminates the probe subprocess."""

    def handler(signum: int, frame: FrameType | None) -> None:  # noqa: ARG001
        ts = datetime.now(UTC).isoformat()
        _LOG.warning(f"[{ts}] wrapper received SIGINT, terminating probe (pid={proc.pid})")
        proc.terminate()
        try:
            proc.wait(timeout=_TERMINATE_GRACE_SEC)
        except subprocess.TimeoutExpired:
            _LOG.warning(
                f"probe did not terminate within {_TERMINATE_GRACE_SEC}s after SIGTERM; killing"
            )
            proc.kill()
        sys.exit(EXIT_SIGINT)

    signal.signal(signal.SIGINT, handler)


def _map_probe_exit_code(probe_exit: int) -> int:
    """Translate probe exit to wrapper exit per the contract in the module docstring."""
    if probe_exit == 0:
        return EXIT_OK
    if probe_exit == 1:
        return EXIT_PROBE_ERRORS
    # probe exit 2 = ProbeConfigError; 130 = KeyboardInterrupt pre-startup; any ≥3 = unknown.
    return EXIT_PROBE_PREFLIGHT


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m rithmic_analytics.cli.start_capture",
        description="Spawn capture-rithmic-probe.py with rollover-aware symbol resolution.",
    )
    parser.add_argument(
        "--root-symbol",
        required=True,
        help="Root symbol (e.g. MNQ). Front-month is resolved via the rollover calendar.",
    )
    parser.add_argument(
        "--session",
        choices=["rth", "globex"],
        required=True,
        help="Session window: rth (09:25-16:05 ET) or globex (17:55 prior day - 09:30 ET).",
    )
    parser.add_argument(
        "--contract-override",
        default=None,
        help="Manual contract override (e.g. MNQU6). Logged in the audit trail.",
    )
    parser.add_argument(
        "--streams",
        default=_DEFAULT_STREAMS,
        help=f"Comma-separated probe streams. Default: {_DEFAULT_STREAMS}.",
    )
    parser.add_argument(
        "--exchange",
        default="CME",
        help="Exchange code passed to the probe. Default: CME.",
    )
    parser.add_argument(
        "--captures-root",
        type=Path,
        default=_DEFAULT_CAPTURES_ROOT,
        help=(
            f"Root dir for {{date}}/{{root}}_{{session}}.jsonl. "
            f"Default: {_DEFAULT_CAPTURES_ROOT}."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Resolve everything and print the probe invocation without launching it.",
    )
    parser.add_argument(
        "--credentials-toml",
        type=Path,
        default=None,
        help="Override credentials TOML path. Default: ~/.rithmic_creds.toml.",
    )
    parser.add_argument(
        "--dot-env-path",
        type=Path,
        default=None,
        help=(
            "Override .env path used by the credentials loader. "
            "Default: <project_root>/.env. Pass a nonexistent path to "
            "disable .env fallback (useful in tests / hermetic runs)."
        ),
    )
    parser.add_argument(
        "--override-duration-sec",
        type=int,
        default=None,
        help=(
            "Override the auto-computed window duration (for ops/test runs). "
            "Clamped to window end if it would extend past — never lengthens beyond "
            "the session boundary."
        ),
    )
    # RA-029: --parity-payload is ON by default. Opting out produces a
    # metadata-only capture that no downstream feature can consume — useful
    # only for probe-debugging.
    parser.add_argument(
        "--parity-payload",
        dest="parity_payload",
        action="store_true",
        default=True,
        help=(
            "Pass --parity-payload to the probe so each record carries "
            "extracted price/size/aggressor fields as JSON (default ON; "
            "RA-029)."
        ),
    )
    parser.add_argument(
        "--no-parity-payload",
        dest="parity_payload",
        action="store_false",
        help=(
            "Opt out of --parity-payload. Resulting captures are "
            "metadata-only and CANNOT feed any downstream analytics. Use "
            "only for probe-debugging."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. See module docstring for exit-code semantics."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = _build_parser().parse_args(argv)

    # ---- 1. Resolve contract ----
    try:
        resolved_contract = resolve_front_month(args.root_symbol, _today_et())
    except (RolloverCalendarMiss, ValueError) as exc:
        _LOG.error(f"contract resolution failed: {exc}")
        return EXIT_BAD_CONFIG

    if args.contract_override:
        contract = args.contract_override
        _LOG.warning(
            f"[rollover-override] using {contract} (manual override) — "
            f"resolved={resolved_contract} — today={_today_et().isoformat()}"
        )
    else:
        contract = resolved_contract

    # ---- 2. Load credentials ----
    try:
        creds = load_credentials(
            toml_path=args.credentials_toml,
            dot_env_path=args.dot_env_path,
        )
    except CredentialsMissing as exc:
        _LOG.error(f"credentials error: {exc}")
        return EXIT_BAD_CONFIG

    # ---- 3. Compute trading day + window ----
    now_et = _now_et()
    trading_date = compute_trading_date(now_et, args.session)
    window_start, window_end = compute_session_window(trading_date, args.session)

    # ---- 4. Window timing edge cases ----
    if now_et > window_end:
        _LOG.info(
            f"scheduled too late, window already closed "
            f"(window {window_start.isoformat()} -> {window_end.isoformat()}, "
            f"now {now_et.isoformat()}). Exiting no-op."
        )
        return EXIT_OK

    if now_et < window_start:
        early_seconds = (window_start - now_et).total_seconds()
        if early_seconds > _MAX_PRE_WINDOW_SLEEP_SEC:
            _LOG.error(
                f"scheduled too early: {early_seconds:.0f}s before window-start "
                f"(cap is {_MAX_PRE_WINDOW_SLEEP_SEC}s). Check Task Scheduler timing."
            )
            return EXIT_BAD_CONFIG
        _LOG.info(
            f"scheduled {early_seconds:.0f}s early; sleeping until {window_start.isoformat()}"
        )
        _sleep_until(window_start)
        now_et = _now_et()

    # ---- 5. Output path + duration ----
    out_path = _output_path(args.captures_root, trading_date, args.root_symbol, args.session)
    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        _LOG.error(f"could not create output dir {out_path.parent}: {exc}")
        return EXIT_BAD_CONFIG

    computed_duration = max(60, int((window_end - now_et).total_seconds()))
    if args.override_duration_sec is not None:
        if args.override_duration_sec > computed_duration:
            _LOG.warning(
                f"--override-duration-sec={args.override_duration_sec} exceeds computed "
                f"window ({computed_duration}s); clamping to window end"
            )
            duration_sec = computed_duration
        else:
            duration_sec = max(args.override_duration_sec, 1)
    else:
        duration_sec = computed_duration

    if not args.parity_payload:
        _LOG.warning(
            "--no-parity-payload set: capture will be metadata-only "
            "(raw_present:false, no price/size/aggressor fields). "
            "Downstream analytics features (load_obs01_trades, replay, "
            "zone scoring) WILL NOT be able to consume the resulting JSONL. "
            "Use only for probe-debugging."
        )

    cmd = _build_probe_cmd(
        creds=creds,
        contract=contract,
        duration_sec=duration_sec,
        streams=args.streams,
        exchange=args.exchange,
        out_path=out_path,
        parity_payload=args.parity_payload,
    )

    # ---- 6. Dry-run short-circuit ----
    if args.dry_run:
        # Redact password for log safety.
        safe_cmd = [_redact(arg, creds.password) for arg in cmd]
        _LOG.info(f"DRY-RUN: would invoke: {' '.join(safe_cmd)}")
        _LOG.info(f"DRY-RUN: trading_date={trading_date}, duration_sec={duration_sec}")
        return EXIT_OK

    # ---- 7. Launch probe + supervise ----
    log_path = out_path.parent / "wrapper.log"
    _LOG.info(
        f"launching probe contract={contract} duration={duration_sec}s "
        f"out={out_path} log={log_path}"
    )
    proc = _spawn_probe(cmd, log_path)
    _install_sigint_handler(proc)

    probe_exit = proc.wait()
    _LOG.info(f"probe exited with code {probe_exit}")
    return _map_probe_exit_code(probe_exit)


def _redact(arg: str, password: str) -> str:
    return "***REDACTED***" if arg == password else arg


if __name__ == "__main__":
    sys.exit(main())
