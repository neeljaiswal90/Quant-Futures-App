"""Tests for ``rithmic_analytics.ops.heartbeat_check`` + ``cli.heartbeat``."""

from __future__ import annotations

import json
from datetime import date, datetime, time
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from rithmic_analytics.cli import heartbeat as heartbeat_cli
from rithmic_analytics.cli.heartbeat import EXIT_OK, main
from rithmic_analytics.ops.alerts import emit_heartbeat_missing_alert
from rithmic_analytics.ops.heartbeat_check import (
    check_missing_heartbeats,
    write_heartbeat,
)

_ET = ZoneInfo("America/New_York")


def _make_capture_dir(captures_root: Path, trading_date: date, *, files: dict[str, int]) -> None:
    """Create a capture-day dir with the given {filename: size_bytes} map."""
    day_dir = captures_root / trading_date.isoformat()
    day_dir.mkdir(parents=True, exist_ok=True)
    for name, size in files.items():
        (day_dir / name).write_bytes(b"x" * size)


# ---------------------------------------------------------------------------
# write_heartbeat
# ---------------------------------------------------------------------------


def test_write_heartbeat_creates_file(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    hb_dir = tmp_path / "heartbeat"
    _make_capture_dir(captures, date(2026, 5, 15), files={"MNQ_rth.jsonl": 100})

    path = write_heartbeat(captures, hb_dir, date(2026, 5, 15), "MNQ")

    assert path.exists()
    record = json.loads(path.read_text(encoding="utf-8"))
    assert record["trading_date"] == "2026-05-15"
    assert record["root_symbol"] == "MNQ"
    assert "ts_iso" in record


def test_write_heartbeat_lists_capture_files_with_sizes(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    hb_dir = tmp_path / "heartbeat"
    _make_capture_dir(
        captures,
        date(2026, 5, 15),
        files={"MNQ_rth.jsonl": 100, "MNQ_globex.jsonl": 50, "wrapper.log": 200},
    )

    path = write_heartbeat(captures, hb_dir, date(2026, 5, 15), "MNQ")

    record = json.loads(path.read_text(encoding="utf-8"))
    file_names = {f["name"] for f in record["files_found"]}
    # wrapper.log should NOT be in the heartbeat record (not a capture file)
    assert file_names == {"MNQ_rth.jsonl", "MNQ_globex.jsonl"}
    sizes = {f["name"]: f["size_bytes"] for f in record["files_found"]}
    assert sizes["MNQ_rth.jsonl"] == 100
    assert sizes["MNQ_globex.jsonl"] == 50


def test_write_heartbeat_no_captures_yields_empty_list(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    captures.mkdir()  # exists but empty
    hb_dir = tmp_path / "heartbeat"

    path = write_heartbeat(captures, hb_dir, date(2026, 5, 15), "MNQ")

    record = json.loads(path.read_text(encoding="utf-8"))
    assert record["files_found"] == []


def test_write_heartbeat_is_idempotent(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    hb_dir = tmp_path / "heartbeat"
    _make_capture_dir(captures, date(2026, 5, 15), files={"MNQ_rth.jsonl": 100})

    write_heartbeat(captures, hb_dir, date(2026, 5, 15), "MNQ")
    # Rerun overwrites cleanly
    write_heartbeat(captures, hb_dir, date(2026, 5, 15), "MNQ")

    # Only one heartbeat file for the day
    files = list(hb_dir.glob("*.txt"))
    assert len(files) == 1


# ---------------------------------------------------------------------------
# check_missing_heartbeats
# ---------------------------------------------------------------------------


def test_check_missing_emits_alert_for_yesterday_when_today_present(tmp_path: Path) -> None:
    hb_dir = tmp_path / "heartbeat"
    hb_dir.mkdir()
    alerts = tmp_path / "alerts.ndjson"
    # Today's heartbeat present; yesterday's missing.
    (hb_dir / "2026-05-15.txt").write_text("{}", encoding="utf-8")
    # 2026-05-14 = Thursday (weekday) — should be flagged when missing

    now = datetime(2026, 5, 15, 11, 0, tzinfo=_ET)  # past the 10:30 deadline
    missing = check_missing_heartbeats(hb_dir, alerts, now_et=now, lookback_weekdays=5)

    assert date(2026, 5, 14) in missing
    assert alerts.exists()
    lines = alerts.read_text(encoding="utf-8").splitlines()
    assert any(json.loads(L)["session_id"] == "mnq-2026-05-14" for L in lines)


def test_check_missing_skips_today_before_deadline(tmp_path: Path) -> None:
    hb_dir = tmp_path / "heartbeat"
    hb_dir.mkdir()
    alerts = tmp_path / "alerts.ndjson"
    # No heartbeat files at all
    now = datetime(2026, 5, 15, 9, 0, tzinfo=_ET)  # 09:00, before 10:30 deadline

    missing = check_missing_heartbeats(hb_dir, alerts, now_et=now, lookback_weekdays=5)

    # Today not flagged (before deadline). Past days might be (depends on
    # lookback covering weekdays). Verify today is NOT in the missing list.
    assert date(2026, 5, 15) not in missing


def test_check_missing_flags_today_past_deadline(tmp_path: Path) -> None:
    hb_dir = tmp_path / "heartbeat"
    hb_dir.mkdir()
    alerts = tmp_path / "alerts.ndjson"
    now = datetime(2026, 5, 15, 11, 0, tzinfo=_ET)  # past 10:30

    missing = check_missing_heartbeats(hb_dir, alerts, now_et=now, lookback_weekdays=0)

    assert date(2026, 5, 15) in missing


def test_check_missing_skips_weekends(tmp_path: Path) -> None:
    hb_dir = tmp_path / "heartbeat"
    hb_dir.mkdir()
    alerts = tmp_path / "alerts.ndjson"
    # Now is Monday 2026-05-18; look back 5 days includes 5/17 Sun, 5/16 Sat.
    # Those should NOT be flagged as missing (no captures expected on weekends).
    now = datetime(2026, 5, 18, 11, 0, tzinfo=_ET)

    missing = check_missing_heartbeats(hb_dir, alerts, now_et=now, lookback_weekdays=5)

    # No weekend dates in missing
    assert date(2026, 5, 16) not in missing  # Saturday
    assert date(2026, 5, 17) not in missing  # Sunday
    # But weekdays in lookback should be
    assert date(2026, 5, 15) in missing  # Friday


def test_check_missing_present_no_alert(tmp_path: Path) -> None:
    hb_dir = tmp_path / "heartbeat"
    hb_dir.mkdir()
    alerts = tmp_path / "alerts.ndjson"
    # All recent weekdays present
    for d_iso in ["2026-05-11", "2026-05-12", "2026-05-13", "2026-05-14", "2026-05-15"]:
        (hb_dir / f"{d_iso}.txt").write_text("{}", encoding="utf-8")
    now = datetime(2026, 5, 15, 11, 0, tzinfo=_ET)

    missing = check_missing_heartbeats(hb_dir, alerts, now_et=now, lookback_weekdays=5)

    assert missing == []
    assert not alerts.exists()  # no lines written


def test_check_missing_custom_deadline(tmp_path: Path) -> None:
    hb_dir = tmp_path / "heartbeat"
    hb_dir.mkdir()
    alerts = tmp_path / "alerts.ndjson"
    now = datetime(2026, 5, 15, 11, 0, tzinfo=_ET)

    # With deadline at 12:00 (later), 11:00 is still BEFORE → today not flagged
    missing = check_missing_heartbeats(
        hb_dir, alerts, now_et=now, deadline=time(12, 0), lookback_weekdays=0
    )

    assert date(2026, 5, 15) not in missing


# ---------------------------------------------------------------------------
# emit_heartbeat_missing_alert NDJSON schema
# ---------------------------------------------------------------------------


def test_emit_heartbeat_missing_alert_writes_correct_schema(tmp_path: Path) -> None:
    alerts = tmp_path / "alerts.ndjson"

    emit_heartbeat_missing_alert(
        trading_date=date(2026, 5, 15),
        alerts_path=alerts,
        ts_iso="2026-05-15T15:00:00+00:00",
    )

    line = alerts.read_text(encoding="utf-8").strip()
    parsed = json.loads(line)
    # Mirrors Gap shape with stream='HEARTBEAT' + nullable numeric fields
    assert parsed["ts_iso"] == "2026-05-15T15:00:00+00:00"
    assert parsed["session_id"] == "mnq-2026-05-15"
    assert parsed["stream"] == "HEARTBEAT"
    assert parsed["gap_type"] == "missing_capture"
    assert parsed["gap_value_ns"] is None
    assert parsed["threshold_ns"] is None
    assert parsed["severity"] == "FAIL"


def test_emit_heartbeat_missing_alert_custom_session_id(tmp_path: Path) -> None:
    alerts = tmp_path / "alerts.ndjson"

    emit_heartbeat_missing_alert(
        trading_date=date(2026, 5, 15),
        alerts_path=alerts,
        session_id="custom-session-tag",
    )

    line = alerts.read_text(encoding="utf-8").strip()
    parsed = json.loads(line)
    assert parsed["session_id"] == "custom-session-tag"


def test_emit_heartbeat_missing_alert_append_preserves_prior(tmp_path: Path) -> None:
    alerts = tmp_path / "alerts.ndjson"
    alerts.parent.mkdir(parents=True, exist_ok=True)
    alerts.write_text('{"prior": true}\n', encoding="utf-8")

    emit_heartbeat_missing_alert(trading_date=date(2026, 5, 15), alerts_path=alerts)

    lines = alerts.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0])["prior"] is True


# ---------------------------------------------------------------------------
# CLI integration
# ---------------------------------------------------------------------------


def test_cli_writes_heartbeat_for_today(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    _make_capture_dir(captures, date(2026, 5, 15), files={"MNQ_rth.jsonl": 100})
    hb_dir = tmp_path / "heartbeat"
    alerts = tmp_path / "alerts.ndjson"

    monkeypatch.setattr(
        heartbeat_cli, "_now_et", lambda: datetime(2026, 5, 15, 10, 0, tzinfo=_ET)
    )

    rc = main(
        [
            "--captures-root", str(captures),
            "--heartbeat-dir", str(hb_dir),
            "--alerts-path", str(alerts),
        ]
    )

    assert rc == EXIT_OK
    assert (hb_dir / "2026-05-15.txt").exists()


def test_cli_emits_alert_for_missing_past_heartbeat(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    captures = tmp_path / "captures"
    _make_capture_dir(captures, date(2026, 5, 15), files={"MNQ_rth.jsonl": 100})
    hb_dir = tmp_path / "heartbeat"
    alerts = tmp_path / "alerts.ndjson"
    # 2026-05-14 (Thursday) missing on purpose

    monkeypatch.setattr(
        heartbeat_cli, "_now_et", lambda: datetime(2026, 5, 15, 11, 0, tzinfo=_ET)
    )

    rc = main(
        [
            "--captures-root", str(captures),
            "--heartbeat-dir", str(hb_dir),
            "--alerts-path", str(alerts),
        ]
    )

    assert rc == EXIT_OK
    assert alerts.exists()
    lines = alerts.read_text(encoding="utf-8").splitlines()
    assert any(json.loads(L)["session_id"] == "mnq-2026-05-14" for L in lines)
