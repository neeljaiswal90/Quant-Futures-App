"""Daily heartbeat — capture-completeness check for the scheduled-task pipeline.

The ``RithmicHeartbeat`` Task Scheduler entry runs ``cli/heartbeat.py`` once
daily (10:00 ET in production). Each run does two things:

1. **Write today's heartbeat file** at ``data/heartbeat/{YYYY-MM-DD}.txt`` with
   a JSON record listing the capture files found for today and their sizes.
2. **Scan the last N weekdays for missing heartbeats.** For each past
   trading day whose heartbeat file is absent and whose deadline has passed,
   append a ``CAPTURE_HEARTBEAT_MISSING`` line to ``data/alerts/alerts.ndjson``
   via :func:`rithmic_analytics.ops.alerts.emit_heartbeat_missing_alert`.

Failure modes covered:
    - Task Scheduler ran but capture failed → heartbeat present, files missing,
      operator inspects heartbeat content
    - System was off during scheduled window → no heartbeat → next-day run
      flags the previous day's miss
    - ``RithmicHeartbeat`` task itself deleted (Windows Update edge case) →
      no alert until external monitor restores; tracked in ``future_work.md``

Today-vs-deadline rule:
    For ``trading_date == today``: only flag missing if ``now_et`` is past the
    deadline (default 10:30 ET — heartbeat task is scheduled at 10:00 with 30
    min of grace). For past dates: always flag if missing.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any

from rithmic_analytics.ops.alerts import emit_heartbeat_missing_alert


@dataclass(frozen=True, slots=True)
class HeartbeatRecord:
    """The JSON content of a daily heartbeat file."""

    trading_date: str  # ISO YYYY-MM-DD
    ts_iso: str  # write time (UTC)
    files_found: list[dict[str, Any]]  # [{"name": str, "size_bytes": int}]
    root_symbol: str


def _capture_filename_pattern(name: str) -> bool:
    """Match ``{ROOT}_rth.jsonl`` or ``{ROOT}_globex.jsonl``."""
    return name.endswith(".jsonl") and ("_rth." in name or "_globex." in name)


def write_heartbeat(
    captures_root: Path,
    heartbeat_dir: Path,
    trading_date: date,
    root_symbol: str,
    *,
    now_iso: str | None = None,
) -> Path:
    """Write today's heartbeat file. Idempotent — overwrites on re-run.

    Args:
        captures_root: ``data/captures`` root (capture files scanned).
        heartbeat_dir: ``data/heartbeat`` root (file written here).
        trading_date: The trading day this heartbeat is for.
        root_symbol: Root symbol label embedded in the record.
        now_iso: Override the ``ts_iso`` field (deterministic tests).

    Returns:
        Path to the written heartbeat file.
    """
    heartbeat_dir.mkdir(parents=True, exist_ok=True)
    capture_day_dir = captures_root / trading_date.isoformat()

    files_found: list[dict[str, Any]] = []
    if capture_day_dir.exists():
        for f in sorted(capture_day_dir.iterdir()):
            if f.is_file() and _capture_filename_pattern(f.name):
                files_found.append({"name": f.name, "size_bytes": f.stat().st_size})

    record = {
        "trading_date": trading_date.isoformat(),
        "ts_iso": now_iso or datetime.now().astimezone().isoformat(),
        "files_found": files_found,
        "root_symbol": root_symbol,
    }
    path = heartbeat_dir / f"{trading_date.isoformat()}.txt"
    path.write_text(json.dumps(record, indent=2), encoding="utf-8")
    return path


def check_missing_heartbeats(
    heartbeat_dir: Path,
    alerts_path: Path,
    *,
    now_et: datetime,
    deadline: time = time(10, 30),
    lookback_weekdays: int = 5,
) -> list[date]:
    """Scan past N weekdays for missing heartbeat files; emit one alert per miss.

    Skips weekends (Saturday/Sunday). For ``today`` specifically, only flags
    missing if ``now_et`` is past ``deadline``.

    Args:
        heartbeat_dir: Where heartbeat files live.
        alerts_path: NDJSON path to append alerts to.
        now_et: Current ET wall-clock.
        deadline: Time-of-day past which today's heartbeat is considered
            "should have run by now." Default 10:30 ET.
        lookback_weekdays: How many *calendar* days back to scan (weekends
            inside the window are skipped). Default 5.

    Returns:
        List of dates flagged as missing (also reflected as appended NDJSON lines).
    """
    today = now_et.date()
    missing: list[date] = []

    for offset in range(0, lookback_weekdays + 1):
        d = today - timedelta(days=offset)
        if d.weekday() >= 5:
            continue  # weekend
        if d == today:
            deadline_dt = datetime.combine(d, deadline, tzinfo=now_et.tzinfo)
            if now_et < deadline_dt:
                continue  # deadline not reached yet

        if not (heartbeat_dir / f"{d.isoformat()}.txt").exists():
            missing.append(d)
            emit_heartbeat_missing_alert(trading_date=d, alerts_path=alerts_path)

    return missing
