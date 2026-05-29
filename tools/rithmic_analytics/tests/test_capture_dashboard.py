"""Tests for ``rithmic_analytics.viewer.capture_dashboard``."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from rithmic_analytics.viewer.capture_dashboard import render_capture_dashboard


def _seed_capture(captures_root: Path, d: str, *, rth_size: int = 0, globex_size: int = 0) -> None:
    day_dir = captures_root / d
    day_dir.mkdir(parents=True, exist_ok=True)
    if rth_size > 0:
        (day_dir / "MNQ_rth.jsonl").write_bytes(b"x" * rth_size)
    if globex_size > 0:
        (day_dir / "MNQ_globex.jsonl").write_bytes(b"x" * globex_size)


def _alert_line(*, ts_iso: str, session_id: str, stream: str, severity: str) -> str:
    return json.dumps({
        "ts_iso": ts_iso, "session_id": session_id, "stream": stream,
        "gap_type": "time", "gap_value_ns": 70_000_000_000,
        "threshold_ns": 60_000_000_000, "severity": severity,
    })


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_dashboard_produces_file(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    _seed_capture(captures, "2026-05-17", rth_size=1000, globex_size=800)
    out = tmp_path / "dashboard.html"

    result = render_capture_dashboard(
        captures, out, today=date(2026, 5, 18), include_plotlyjs="cdn",
    )

    assert result == out
    assert out.exists()
    assert out.stat().st_size > 0


def test_dashboard_contains_all_section_headers(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    _seed_capture(captures, "2026-05-17", rth_size=1000, globex_size=800)
    out = tmp_path / "dashboard.html"

    render_capture_dashboard(captures, out, today=date(2026, 5, 18), include_plotlyjs="cdn")
    content = out.read_text(encoding="utf-8")

    assert "<h2>Sessions</h2>" in content
    assert "<h2>Recent alerts" in content  # may have count suffix
    # Alert timeline / File-size trend may render or empty-state depending on data


def test_dashboard_session_table_shows_file_sizes(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    _seed_capture(captures, "2026-05-17", rth_size=1234, globex_size=567)
    out = tmp_path / "dashboard.html"

    render_capture_dashboard(captures, out, today=date(2026, 5, 18), include_plotlyjs="cdn")
    content = out.read_text(encoding="utf-8")

    assert "2026-05-17" in content
    assert "1,234" in content
    assert "567" in content


def test_missing_session_shown_as_missing(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    # RTH present, Globex missing
    _seed_capture(captures, "2026-05-17", rth_size=1000)
    out = tmp_path / "dashboard.html"

    render_capture_dashboard(captures, out, today=date(2026, 5, 18), include_plotlyjs="cdn")
    content = out.read_text(encoding="utf-8")

    assert "missing" in content


# ---------------------------------------------------------------------------
# Lookback window
# ---------------------------------------------------------------------------


def test_lookback_excludes_old_days(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    _seed_capture(captures, "2026-04-01", rth_size=1000)  # >30 days before 2026-05-18
    _seed_capture(captures, "2026-05-17", rth_size=2000)
    out = tmp_path / "dashboard.html"

    render_capture_dashboard(
        captures, out, today=date(2026, 5, 18), lookback_days=30, include_plotlyjs="cdn",
    )
    content = out.read_text(encoding="utf-8")

    assert "2026-05-17" in content
    assert "2026-04-01" not in content


# ---------------------------------------------------------------------------
# Alerts
# ---------------------------------------------------------------------------


def test_no_alerts_file_shows_empty_state(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    _seed_capture(captures, "2026-05-17", rth_size=1000)
    out = tmp_path / "dashboard.html"
    nonexistent_alerts = tmp_path / "missing.ndjson"

    render_capture_dashboard(
        captures, out,
        alerts_path=nonexistent_alerts,
        today=date(2026, 5, 18), include_plotlyjs="cdn",
    )
    content = out.read_text(encoding="utf-8")

    assert "No alerts in window" in content


def test_alerts_filtered_by_lookback_and_session_id_date(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    _seed_capture(captures, "2026-05-17", rth_size=1000)
    alerts = tmp_path / "alerts.ndjson"
    alerts.write_text(
        _alert_line(
            ts_iso="2026-05-17T15:00:00+00:00",
            session_id="mnq-2026-05-17-rth", stream="LAST_TRADE", severity="WARN",
        ) + "\n"
        + _alert_line(  # Outside lookback (old)
            ts_iso="2026-04-01T15:00:00+00:00",
            session_id="mnq-2026-04-01-rth", stream="LAST_TRADE", severity="FAIL",
        ) + "\n"
        + _alert_line(  # Inside lookback
            ts_iso="2026-05-15T15:00:00+00:00",
            session_id="mnq-2026-05-15-rth", stream="HEARTBEAT", severity="FAIL",
        ) + "\n",
        encoding="utf-8",
    )
    out = tmp_path / "dashboard.html"

    render_capture_dashboard(
        captures, out, alerts_path=alerts,
        today=date(2026, 5, 18), lookback_days=30, include_plotlyjs="cdn",
    )
    content = out.read_text(encoding="utf-8")

    # 2026-05-17 alert + 2026-05-15 alert visible
    assert "2026-05-17-rth" in content
    assert "2026-05-15-rth" in content
    # 2026-04-01 alert filtered out (>30 days)
    assert "2026-04-01-rth" not in content


def test_summary_shows_fail_count(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    _seed_capture(captures, "2026-05-17", rth_size=1000)
    alerts = tmp_path / "alerts.ndjson"
    # 2 FAIL + 1 WARN
    lines = [
        _alert_line(ts_iso=f"2026-05-17T15:0{i}:00+00:00",
                    session_id="mnq-2026-05-17-rth", stream="LAST_TRADE",
                    severity="FAIL" if i < 2 else "WARN")
        for i in range(3)
    ]
    alerts.write_text("\n".join(lines) + "\n", encoding="utf-8")
    out = tmp_path / "dashboard.html"

    render_capture_dashboard(
        captures, out, alerts_path=alerts,
        today=date(2026, 5, 18), include_plotlyjs="cdn",
    )
    content = out.read_text(encoding="utf-8")

    assert "3 alerts (2 FAIL)" in content


# ---------------------------------------------------------------------------
# Empty state — no captures at all
# ---------------------------------------------------------------------------


def test_no_captures_at_all_shows_empty_state(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    captures.mkdir()
    out = tmp_path / "dashboard.html"

    render_capture_dashboard(captures, out, today=date(2026, 5, 18), include_plotlyjs="cdn")
    content = out.read_text(encoding="utf-8")

    assert "No capture days in window" in content


def test_captures_root_missing_does_not_crash(tmp_path: Path) -> None:
    out = tmp_path / "dashboard.html"
    nonexistent = tmp_path / "no_captures_here"

    render_capture_dashboard(nonexistent, out, today=date(2026, 5, 18), include_plotlyjs="cdn")

    assert out.exists()
