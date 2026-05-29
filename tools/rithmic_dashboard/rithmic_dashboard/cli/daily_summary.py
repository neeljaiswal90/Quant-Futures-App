"""Write a lightweight dashboard daily summary from logs and audit state."""

from __future__ import annotations

import argparse
import json
from datetime import date, datetime
from pathlib import Path
from typing import Any

from rithmic_dashboard.session_state import PT

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DASHBOARD_DIR = PROJECT_ROOT / "data" / "dashboard"
DEFAULT_REPORTS_DIR = PROJECT_ROOT.parent / "rithmic_analytics" / "data" / "codex_reports"


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    summary_date = date.fromisoformat(args.date) if args.date else datetime.now(PT).date()
    dashboard_dir = args.dashboard_dir
    log_path = dashboard_dir / f"generator_{summary_date.isoformat()}.log"
    audit_path = dashboard_dir / "_audit.json"
    lines = _read_lines(log_path)
    invocations = [
        line for line in lines if "generated dashboard" in line or "completed in" in line
    ]
    failures = [line for line in lines if "ERROR" in line or "failed" in line.lower()]
    runtimes = _extract_runtimes(lines)
    audit_entries = _audit_entries_for_date(audit_path, summary_date)
    warnings = [line for line in lines if "WARNING" in line or "PRICE OUTLIER" in line]

    text = _render_summary(
        day=summary_date,
        total=len(invocations),
        failed=len(failures),
        runtimes=runtimes,
        audit_entries=audit_entries,
        warnings=warnings,
    )
    out = dashboard_dir / f"daily_summary_{summary_date.isoformat()}.md"
    out.write_text(text, encoding="utf-8")
    _append_health_line(args.reports_dir, summary_date, len(invocations), len(failures))
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", default=None)
    parser.add_argument("--dashboard-dir", type=Path, default=DEFAULT_DASHBOARD_DIR)
    parser.add_argument("--reports-dir", type=Path, default=DEFAULT_REPORTS_DIR)
    return parser.parse_args(argv)


def _read_lines(path: Path) -> list[str]:
    if not path.exists():
        return []
    return path.read_text(encoding="utf-8", errors="ignore").splitlines()


def _extract_runtimes(lines: list[str]) -> list[float]:
    values: list[float] = []
    for line in lines:
        marker = "elapsed="
        if marker in line:
            raw = line.split(marker, 1)[1].split("s", 1)[0]
            values.append(_float(raw))
        elif "Generator completed in " in line:
            raw = line.split("Generator completed in ", 1)[1].split("s", 1)[0]
            values.append(_float(raw))
    return [v for v in values if v >= 0]


def _audit_entries_for_date(path: Path, day: date) -> list[str]:
    if not path.exists():
        return []
    try:
        data: Any = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
        return []
    prefix = day.isoformat()
    result: list[str] = []
    for entry in data["entries"]:
        if not isinstance(entry, dict):
            continue
        ts = str(entry.get("timestamp_pt", ""))
        if ts.startswith(prefix):
            result.append(f"- {ts}: {entry.get('description', '')}")
    return result


def _render_summary(
    *,
    day: date,
    total: int,
    failed: int,
    runtimes: list[float],
    audit_entries: list[str],
    warnings: list[str],
) -> str:
    avg_runtime = sum(runtimes) / len(runtimes) if runtimes else 0.0
    success = max(0, total - failed)
    audit_text = "\n".join(audit_entries) if audit_entries else "- None"
    warning_text = "\n".join(f"- {line}" for line in warnings[-20:]) if warnings else "- None"
    return (
        f"# Dashboard daily summary - {day.isoformat()}\n\n"
        "## Generator invocations\n"
        f"- Total: {total}\n"
        f"- Successful: {success}\n"
        f"- Failed: {failed}\n\n"
        f"## Average runtime: {avg_runtime:.2f}s\n\n"
        "## Sessions covered\n"
        "- Globex: see generator log\n"
        "- RTH: see generator log\n\n"
        "## Notable state changes\n"
        f"{audit_text}\n\n"
        "## Anomalies\n"
        f"{warning_text}\n"
    )


def _append_health_line(reports_dir: Path, day: date, total: int, failed: int) -> None:
    reports_dir.mkdir(parents=True, exist_ok=True)
    path = reports_dir / "dashboard_health.md"
    timestamp = datetime.now(PT).strftime("%Y-%m-%d %H:%M:%S PT")
    line = f"- {timestamp}: {day} total={total} failed={failed}\n"
    with path.open("a", encoding="utf-8") as f:
        f.write(line)


def _float(value: str) -> float:
    try:
        return float(value)
    except ValueError:
        return -1.0


if __name__ == "__main__":
    raise SystemExit(main())
