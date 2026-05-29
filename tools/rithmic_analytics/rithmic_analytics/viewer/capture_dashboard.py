"""Capture-quality dashboard — last N days of capture stats + alerts.

Reads from two sources:
    - ``captures_root/YYYY-MM-DD/*.jsonl`` — per-day capture files. Reports
      file sizes + presence of expected RTH/Globex sessions.
    - ``alerts.ndjson`` (RA-009 + RA-011) — gap alerts and heartbeat-miss
      alerts. Counted per date, broken out by severity.

Single self-contained HTML, dark theme, Plotly via CDN by default. Matches
the RA-022 daily-report pattern. Operator runs ``cli.dashboard`` (or imports
this module directly) when they want a snapshot of capture health.

Static by design — no interactive filtering. The 30-day data set is small
enough to skim by eye; filtering is over-engineering.
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import plotly.graph_objects as go

from rithmic_analytics.ops.rotation import (  # reuse the trading-day scanner
    _CAPTURE_FILE_RE,
    _TRADING_DAY_DIR_RE,
)

_DEFAULT_ALERTS_PATH = Path("data/alerts/alerts.ndjson")

_SEVERITY_COLORS: dict[str, str] = {
    "WARN": "#d29922",
    "FAIL": "#f85149",
}


# Vendored from vp_report.py to avoid cross-viewer import coupling; kept in
# sync manually. See architecture.md D-005 / D-006 (tracked) for the future
# extract-shared-css decision.
_CSS = """
:root {
  --bg: #0d1117; --panel: #161b22; --border: #30363d;
  --text: #c9d1d9; --muted: #8b949e; --accent: #58a6ff;
  --warn: #d29922; --fail: #f85149; --ok: #56d364;
}
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg); color: var(--text); margin: 0; padding: 16px;
  font-size: 14px;
}
.container { max-width: 1200px; margin: 0 auto; }
header { padding: 16px 0; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
header h1 { margin: 0 0 6px 0; font-size: 22px; color: var(--accent); }
.summary-stats { color: var(--muted); font-family: ui-monospace, monospace; }
section {
  margin: 24px 0; padding: 16px; background: var(--panel);
  border: 1px solid var(--border); border-radius: 6px;
}
section h2 { margin-top: 0; font-size: 18px; color: var(--accent); }
table { width: 100%; border-collapse: collapse;
        font-family: ui-monospace, monospace; font-size: 13px; }
th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border); }
th { color: var(--muted); font-weight: 500; }
tr:hover td { background: rgba(88, 166, 255, 0.05); }
.empty-state { color: var(--muted); font-style: italic; }
.sev-WARN { color: var(--warn); }
.sev-FAIL { color: var(--fail); font-weight: 600; }
.cell-ok { color: var(--ok); }
.cell-missing { color: var(--muted); font-style: italic; }
.chart-container { width: 100%; overflow-x: auto; }
footer { text-align: center; color: var(--muted); font-size: 12px; padding: 24px 0; }
"""


def _scan_capture_days(
    captures_root: Path, lookback_days: int, today: date
) -> dict[date, dict[str, int]]:
    """Walk ``captures_root`` for the last N trading days. Return
    ``{date: {filename: size_bytes}}``."""
    cutoff = today - timedelta(days=lookback_days)
    result: dict[date, dict[str, int]] = {}
    if not captures_root.exists():
        return result
    for day_dir in sorted(captures_root.iterdir()):
        if not day_dir.is_dir() or not _TRADING_DAY_DIR_RE.match(day_dir.name):
            continue
        try:
            d = date.fromisoformat(day_dir.name)
        except ValueError:
            continue
        if d < cutoff or d > today:
            continue
        files: dict[str, int] = {}
        for f in sorted(day_dir.iterdir()):
            if f.is_file() and _CAPTURE_FILE_RE.match(f.name):
                files[f.name] = f.stat().st_size
        result[d] = files
    return result


def _read_alerts(
    alerts_path: Path, lookback_days: int, today: date
) -> list[dict[str, Any]]:
    """Read alerts.ndjson and return entries within the lookback window."""
    if not alerts_path.exists():
        return []
    cutoff = today - timedelta(days=lookback_days)
    result: list[dict[str, Any]] = []
    with alerts_path.open("r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            sid = rec.get("session_id", "")
            if not isinstance(sid, str) or len(sid) < 10:
                continue
            # Match "mnq-YYYY-MM-DD-..." or "...YYYY-MM-DD..."
            try:
                date_part = sid.split("-", 1)[1] if "-" in sid else sid
                # Strip leading symbol prefix if present
                tokens = date_part.split("-")
                if len(tokens) >= 3:
                    iso = "-".join(tokens[:3])
                    parsed = date.fromisoformat(iso)
                else:
                    continue
            except ValueError:
                continue
            if cutoff <= parsed <= today:
                rec["_parsed_date"] = parsed
                result.append(rec)
    return result


def _render_session_table(
    days: dict[date, dict[str, int]],
    alerts_by_date: dict[date, list[dict[str, Any]]],
    root_symbol: str,
) -> str:
    if not days:
        return (
            "<section><h2>Sessions</h2>"
            "<p class='empty-state'>No capture days in window.</p>"
            "</section>"
        )
    rth_name = f"{root_symbol}_rth.jsonl"
    globex_name = f"{root_symbol}_globex.jsonl"
    rows = []
    for d in sorted(days.keys(), reverse=True):
        files = days[d]
        rth_size = files.get(rth_name)
        globex_size = files.get(globex_name)
        rth_cell = (
            f"<span class='cell-ok'>{rth_size:,}</span>"
            if rth_size
            else "<span class='cell-missing'>missing</span>"
        )
        globex_cell = (
            f"<span class='cell-ok'>{globex_size:,}</span>"
            if globex_size
            else "<span class='cell-missing'>missing</span>"
        )
        alert_count = len(alerts_by_date.get(d, []))
        fail_count = sum(
            1 for a in alerts_by_date.get(d, []) if a.get("severity") == "FAIL"
        )
        alert_cell = (
            f"<span class='sev-FAIL'>{fail_count} FAIL / {alert_count} total</span>"
            if fail_count > 0
            else (f"<span class='sev-WARN'>{alert_count}</span>" if alert_count else "0")
        )
        rows.append(
            f"<tr><td>{d.isoformat()}</td><td>{rth_cell}</td>"
            f"<td>{globex_cell}</td><td>{alert_cell}</td></tr>"
        )
    return (
        "<section><h2>Sessions</h2><table>"
        "<thead><tr><th>Date</th><th>RTH (bytes)</th><th>Globex (bytes)</th>"
        "<th>Alerts</th></tr></thead>"
        "<tbody>" + "\n".join(rows) + "</tbody></table></section>"
    )


def _render_alert_timeline(
    alerts_by_date: dict[date, list[dict[str, Any]]],
    include_plotlyjs: str | bool,
) -> str:
    if not alerts_by_date:
        return (
            "<section><h2>Alert timeline (last N days)</h2>"
            "<p class='empty-state'>No alerts in window.</p>"
            "</section>"
        )
    dates = sorted(alerts_by_date.keys())
    warn = [sum(1 for a in alerts_by_date[d] if a.get("severity") == "WARN") for d in dates]
    fail = [sum(1 for a in alerts_by_date[d] if a.get("severity") == "FAIL") for d in dates]

    fig = go.Figure()
    fig.add_trace(go.Bar(
        x=[d.isoformat() for d in dates], y=warn, name="WARN",
        marker={"color": _SEVERITY_COLORS["WARN"]},
    ))
    fig.add_trace(go.Bar(
        x=[d.isoformat() for d in dates], y=fail, name="FAIL",
        marker={"color": _SEVERITY_COLORS["FAIL"]},
    ))
    fig.update_layout(
        barmode="stack", template="plotly_dark",
        title="Alerts per day (stacked by severity)",
        xaxis_title="Date", yaxis_title="Alert count",
        height=350, margin={"t": 50, "b": 60, "l": 60, "r": 20},
    )
    chart_html = fig.to_html(full_html=False, include_plotlyjs=include_plotlyjs)
    return (
        "<section><h2>Alert timeline</h2>"
        f"<div class='chart-container'>{chart_html}</div></section>"
    )


def _render_file_size_trend(
    days: dict[date, dict[str, int]],
    root_symbol: str,
    include_plotlyjs: str | bool,
) -> str:
    if not days:
        return ""
    rth_name = f"{root_symbol}_rth.jsonl"
    globex_name = f"{root_symbol}_globex.jsonl"
    dates = sorted(days.keys())
    rth_sizes = [days[d].get(rth_name, 0) / 1_000_000 for d in dates]
    globex_sizes = [days[d].get(globex_name, 0) / 1_000_000 for d in dates]

    fig = go.Figure()
    fig.add_trace(go.Scatter(
        x=[d.isoformat() for d in dates], y=rth_sizes,
        mode="lines+markers", name="RTH (MB)",
        line={"color": "#58a6ff"},
    ))
    fig.add_trace(go.Scatter(
        x=[d.isoformat() for d in dates], y=globex_sizes,
        mode="lines+markers", name="Globex (MB)",
        line={"color": "#56d364"},
    ))
    fig.update_layout(
        template="plotly_dark",
        title="Capture file sizes (MB)",
        xaxis_title="Date", yaxis_title="MB",
        height=350, margin={"t": 50, "b": 60, "l": 60, "r": 20},
    )
    chart_html = fig.to_html(full_html=False, include_plotlyjs=False)  # CDN already loaded
    return (
        "<section><h2>File-size trend</h2>"
        f"<div class='chart-container'>{chart_html}</div></section>"
    )


def _render_recent_alerts(
    alerts: list[dict[str, Any]], limit: int = 50
) -> str:
    if not alerts:
        return (
            "<section><h2>Recent alerts</h2>"
            "<p class='empty-state'>No alerts in window.</p>"
            "</section>"
        )
    recent = sorted(alerts, key=lambda a: a.get("ts_iso", ""), reverse=True)[:limit]
    rows = []
    for a in recent:
        ts = str(a.get("ts_iso", ""))
        sid = str(a.get("session_id", ""))
        stream = str(a.get("stream", ""))
        gtype = str(a.get("gap_type", ""))
        sev = str(a.get("severity", ""))
        rows.append(
            f"<tr><td>{ts}</td><td>{sid}</td><td>{stream}</td>"
            f"<td>{gtype}</td><td class='sev-{sev}'>{sev}</td></tr>"
        )
    return (
        f"<section><h2>Recent alerts (latest {len(recent)})</h2><table>"
        "<thead><tr><th>Time</th><th>Session</th><th>Stream</th>"
        "<th>Type</th><th>Severity</th></tr></thead>"
        "<tbody>" + "\n".join(rows) + "</tbody></table></section>"
    )


def render_capture_dashboard(
    captures_root: Path,
    output_path: Path,
    *,
    alerts_path: Path | None = None,
    lookback_days: int = 30,
    root_symbol: str = "MNQ",
    today: date | None = None,
    title: str | None = None,
    include_plotlyjs: str | bool = "cdn",
) -> Path:
    """Render the capture-quality dashboard to a self-contained HTML file.

    Args:
        captures_root: Root dir with ``YYYY-MM-DD/`` capture day folders.
        output_path: Where to write the dashboard HTML.
        alerts_path: NDJSON alerts file. ``None`` falls back to
            ``data/alerts/alerts.ndjson``. Missing file → empty alert sections.
        lookback_days: How far back to look. Default 30.
        root_symbol: Capture filename root (``MNQ_rth.jsonl`` etc.). Default "MNQ".
        today: "Today" for the lookback window. Defaults to UTC today.
        title: Dashboard title. Default generated.
        include_plotlyjs: Default ``"cdn"``. ``True`` inlines for offline.

    Returns:
        Resolved ``output_path``.
    """
    today = today or datetime.now(UTC).date()
    final_title = title or f"Capture Quality Dashboard — last {lookback_days} days"
    computed_at = datetime.now(UTC).isoformat()
    resolved_alerts = alerts_path or _DEFAULT_ALERTS_PATH

    days = _scan_capture_days(captures_root, lookback_days, today)
    alerts = _read_alerts(resolved_alerts, lookback_days, today)

    alerts_by_date: dict[date, list[dict[str, Any]]] = defaultdict(list)
    for a in alerts:
        alerts_by_date[a["_parsed_date"]].append(a)

    # ---- Summary stats for header ----
    total_bytes = sum(
        sum(files.values()) for files in days.values()
    )
    total_alerts = len(alerts)
    fail_count = sum(1 for a in alerts if a.get("severity") == "FAIL")
    summary = (
        f"{len(days)} capture days · "
        f"{total_bytes / 1_000_000:,.1f} MB total · "
        f"{total_alerts} alerts ({fail_count} FAIL)"
    )

    header_html = (
        f"<header><h1>{final_title}</h1>"
        f"<div class='summary-stats'>{root_symbol} · computed {computed_at}</div>"
        f"<div class='summary-stats'>{summary}</div></header>"
    )

    sessions_html = _render_session_table(days, alerts_by_date, root_symbol)
    timeline_html = _render_alert_timeline(alerts_by_date, include_plotlyjs)
    filesize_html = _render_file_size_trend(days, root_symbol, include_plotlyjs)
    recent_html = _render_recent_alerts(alerts)

    full_html = (
        "<!DOCTYPE html>\n"
        f"<html lang='en'><head><meta charset='utf-8'>"
        f"<title>{final_title}</title>"
        f"<style>{_CSS}</style>"
        f"</head><body><div class='container'>"
        f"{header_html}"
        f"{sessions_html}"
        f"{timeline_html}"
        f"{filesize_html}"
        f"{recent_html}"
        f"<footer>Generated by rithmic_analytics · see docs/architecture.md</footer>"
        f"</div></body></html>"
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(full_html, encoding="utf-8")
    return output_path
