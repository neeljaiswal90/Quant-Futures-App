"""Tests for ``rithmic_analytics.cli.daily_zones``."""

from __future__ import annotations

import json
from datetime import date, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from rithmic_analytics.cli import daily_zones
from rithmic_analytics.cli.daily_zones import (
    EXIT_OK,
    is_trading_day_complete,
    main,
)
from rithmic_analytics.core.schema import validate_envelope

_ET = ZoneInfo("America/New_York")


def _write_obs01(path: Path, *, n_trades: int) -> None:
    """Write a synthetic OBS-01 JSONL file with the given number of TRADE envelopes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    base_ts = 1_777_301_400_000_000_000
    with path.open("w", encoding="utf-8") as f:
        for i in range(n_trades):
            rec: dict[str, Any] = {
                "event_id": f"trade-{i:06d}",
                "run_id": "test-run",
                "schema_version": 1,
                "session_id": "mnq-2026-05-14-rth",
                "ts_ns": str(base_ts + i * 1_000_000_000),
                "type": "TRADE",
                "payload": {
                    "aggressor_side": "buy" if i % 2 == 0 else "sell",
                    "exchange_event_ts_ns": str(base_ts + i * 1_000_000_000),
                    "sidecar_recv_ts_ns": str(base_ts + i * 1_000_000_000 + 1000),
                    "price": 27380.0 + (i % 20) * 0.25,
                    "quantity": 1,
                    "trade_id": f"t{i}",
                },
            }
            f.write(json.dumps(rec) + "\n")


def _pin_now(monkeypatch: pytest.MonkeyPatch, dt: datetime) -> None:
    monkeypatch.setattr(daily_zones, "_now_et", lambda: dt)


# ---------------------------------------------------------------------------
# is_trading_day_complete
# ---------------------------------------------------------------------------


def test_completeness_before_close() -> None:
    now = datetime(2026, 5, 15, 14, 0, tzinfo=_ET)  # 14:00 ET, RTH still open
    assert is_trading_day_complete(date(2026, 5, 15), now) is False


def test_completeness_at_close_exactly() -> None:
    now = datetime(2026, 5, 15, 16, 5, tzinfo=_ET)  # 16:05 ET — inclusive
    assert is_trading_day_complete(date(2026, 5, 15), now) is True


def test_completeness_after_close() -> None:
    now = datetime(2026, 5, 15, 17, 30, tzinfo=_ET)  # 17:30 ET — Task Scheduler nightly
    assert is_trading_day_complete(date(2026, 5, 15), now) is True


def test_completeness_yesterday_always_complete_today_morning() -> None:
    now = datetime(2026, 5, 15, 6, 0, tzinfo=_ET)  # 06:00 ET — pre-market
    assert is_trading_day_complete(date(2026, 5, 14), now) is True


# ---------------------------------------------------------------------------
# Target-date selection
# ---------------------------------------------------------------------------


def test_scheduled_run_at_1730_picks_today(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Task Scheduler scenario: 17:30 ET 5/15, today's RTH closed at 16:05.
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    _write_obs01(captures / "2026-05-15" / "MNQ_rth.jsonl", n_trades=200)
    zones = tmp_path / "zones"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    rc = main(
        [
            "--captures-root", str(captures),
            "--zones-root", str(zones),
            "--logs-root", str(tmp_path / "logs"),
            "--partial-capture-warn-threshold", "100",
        ]
    )

    assert rc == EXIT_OK
    # Today's zone JSON is produced (NOT yesterday's)
    assert (zones / "2026-05-15_MNQ_rth.json").exists()


def test_mid_rth_run_at_1400_picks_yesterday(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Scheduler glitch / operator manual at 14:00 ET 5/15: today's RTH still open.
    # Most recent COMPLETE day is 5/14.
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    _write_obs01(captures / "2026-05-15" / "MNQ_rth.jsonl", n_trades=200)
    zones = tmp_path / "zones"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 14, 0, tzinfo=_ET))

    rc = main(
        [
            "--captures-root", str(captures),
            "--zones-root", str(zones),
            "--logs-root", str(tmp_path / "logs"),
            "--partial-capture-warn-threshold", "100",
        ]
    )

    assert rc == EXIT_OK
    assert (zones / "2026-05-14_MNQ_rth.json").exists()
    assert not (zones / "2026-05-15_MNQ_rth.json").exists()  # in-progress, not processed


def test_no_eligible_day_logs_warning_and_exits_0(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    # Only data is today and we're mid-RTH → no eligible day.
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-15" / "MNQ_rth.jsonl", n_trades=200)
    _pin_now(monkeypatch, datetime(2026, 5, 15, 14, 0, tzinfo=_ET))

    with caplog.at_level("WARNING"):
        rc = main(
            [
                "--captures-root", str(captures),
                "--zones-root", str(tmp_path / "zones"),
                "--logs-root", str(tmp_path / "logs"),
            ]
        )

    assert rc == EXIT_OK
    assert any("no complete trading day" in r.message for r in caplog.records)


def test_empty_captures_root_logs_and_exits_0(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    with caplog.at_level("WARNING"):
        rc = main(
            [
                "--captures-root", str(tmp_path / "nonexistent"),
                "--zones-root", str(tmp_path / "zones"),
                "--logs-root", str(tmp_path / "logs"),
            ]
        )

    assert rc == EXIT_OK
    assert any("does not exist" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# Operator override
# ---------------------------------------------------------------------------


def test_trading_date_override_processes_in_progress_day(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    # Mid-RTH at 14:00 ET 5/15 + --trading-date 2026-05-15 → process anyway.
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-15" / "MNQ_rth.jsonl", n_trades=200)
    zones = tmp_path / "zones"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 14, 0, tzinfo=_ET))

    with caplog.at_level("WARNING"):
        rc = main(
            [
                "--captures-root", str(captures),
                "--zones-root", str(zones),
                "--logs-root", str(tmp_path / "logs"),
                "--trading-date", "2026-05-15",
                "--partial-capture-warn-threshold", "100",
            ]
        )

    assert rc == EXIT_OK
    assert (zones / "2026-05-15_MNQ_rth.json").exists()
    assert any("operator override" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# Per-session processing
# ---------------------------------------------------------------------------


def test_both_sessions_present_emit_both_jsons(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    _write_obs01(captures / "2026-05-14" / "MNQ_globex.jsonl", n_trades=100)
    zones = tmp_path / "zones"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 8, 0, tzinfo=_ET))

    rc = main(
        [
            "--captures-root", str(captures),
            "--zones-root", str(zones),
            "--logs-root", str(tmp_path / "logs"),
            "--partial-capture-warn-threshold", "50",
        ]
    )

    assert rc == EXIT_OK
    assert (zones / "2026-05-14_MNQ_rth.json").exists()
    assert (zones / "2026-05-14_MNQ_globex.json").exists()
    # Both validate
    for fname in ("2026-05-14_MNQ_rth.json", "2026-05-14_MNQ_globex.json"):
        payload = json.loads((zones / fname).read_text(encoding="utf-8"))
        validate_envelope(payload)


def test_only_one_session_present_emits_just_that_one(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    # Only RTH captured (globex missing) — still process RTH, warn about globex.
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    zones = tmp_path / "zones"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 8, 0, tzinfo=_ET))

    with caplog.at_level("WARNING"):
        rc = main(
            [
                "--captures-root", str(captures),
                "--zones-root", str(zones),
                "--logs-root", str(tmp_path / "logs"),
                "--partial-capture-warn-threshold", "100",
            ]
        )

    assert rc == EXIT_OK
    assert (zones / "2026-05-14_MNQ_rth.json").exists()
    assert not (zones / "2026-05-14_MNQ_globex.json").exists()
    assert any("globex" in r.message and "skipping" in r.message for r in caplog.records)


def test_only_globex_present_emits_just_globex(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_globex.jsonl", n_trades=200)
    zones = tmp_path / "zones"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 8, 0, tzinfo=_ET))

    with caplog.at_level("WARNING"):
        rc = main(
            [
                "--captures-root", str(captures),
                "--zones-root", str(zones),
                "--logs-root", str(tmp_path / "logs"),
                "--partial-capture-warn-threshold", "100",
            ]
        )

    assert rc == EXIT_OK
    assert (zones / "2026-05-14_MNQ_globex.json").exists()
    assert not (zones / "2026-05-14_MNQ_rth.json").exists()
    assert any("rth" in r.message and "skipping" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# Partial capture warning
# ---------------------------------------------------------------------------


def test_partial_capture_below_threshold_warns_but_still_processes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=30)
    zones = tmp_path / "zones"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 8, 0, tzinfo=_ET))

    with caplog.at_level("WARNING"):
        rc = main(
            [
                "--captures-root", str(captures),
                "--zones-root", str(zones),
                "--logs-root", str(tmp_path / "logs"),
                "--partial-capture-warn-threshold", "100",  # > 30 trades captured
            ]
        )

    assert rc == EXIT_OK
    assert (zones / "2026-05-14_MNQ_rth.json").exists()
    assert any("partial capture" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# --drop-to
# ---------------------------------------------------------------------------


def test_drop_to_copies_zone_json(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    zones = tmp_path / "zones"
    drop = tmp_path / "drop"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 8, 0, tzinfo=_ET))

    rc = main(
        [
            "--captures-root", str(captures),
            "--zones-root", str(zones),
            "--logs-root", str(tmp_path / "logs"),
            "--drop-to", str(drop),
            "--partial-capture-warn-threshold", "100",
        ]
    )

    assert rc == EXIT_OK
    assert (zones / "2026-05-14_MNQ_rth.json").exists()
    assert (drop / "2026-05-14_MNQ_rth.json").exists()
    # Copies are byte-identical (content + schema)
    assert (drop / "2026-05-14_MNQ_rth.json").read_text() == (
        zones / "2026-05-14_MNQ_rth.json"
    ).read_text()


def test_drop_to_failure_logs_error_but_exits_0(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    # Simulate drop-copy permission denied: monkey-patch shutil.copy2.
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    zones = tmp_path / "zones"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 8, 0, tzinfo=_ET))

    def _fail_copy(src: Any, dst: Any) -> None:
        raise PermissionError("simulated drop dir read-only")

    monkeypatch.setattr(daily_zones.shutil, "copy2", _fail_copy)

    with caplog.at_level("ERROR"):
        rc = main(
            [
                "--captures-root", str(captures),
                "--zones-root", str(zones),
                "--logs-root", str(tmp_path / "logs"),
                "--drop-to", str(tmp_path / "drop"),
                "--partial-capture-warn-threshold", "100",
            ]
        )

    assert rc == EXIT_OK  # best-effort drop, zone JSON still generated
    assert (zones / "2026-05-14_MNQ_rth.json").exists()
    assert any("drop-to copy failed" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# Output validation
# ---------------------------------------------------------------------------


def test_output_validates_against_zone_schema(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    zones = tmp_path / "zones"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 8, 0, tzinfo=_ET))

    rc = main(
        [
            "--captures-root", str(captures),
            "--zones-root", str(zones),
            "--logs-root", str(tmp_path / "logs"),
            "--partial-capture-warn-threshold", "100",
        ]
    )

    assert rc == EXIT_OK
    payload = json.loads((zones / "2026-05-14_MNQ_rth.json").read_text(encoding="utf-8"))
    validate_envelope(payload)
    # Phase 1 expectations
    assert payload["symbol"] == "MNQ"
    assert payload["timeframe"] == "rth"
    assert payload["data_source"] == "rithmic"
    assert payload["bars_used"] == 200


# ---------------------------------------------------------------------------
# Logfile
# ---------------------------------------------------------------------------


def test_logfile_is_created(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    logs = tmp_path / "logs"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 8, 0, tzinfo=_ET))

    rc = main(
        [
            "--captures-root", str(captures),
            "--zones-root", str(tmp_path / "zones"),
            "--logs-root", str(logs),
            "--partial-capture-warn-threshold", "100",
        ]
    )

    assert rc == EXIT_OK
    # Logfile name uses today (ET) since no --trading-date override
    expected = logs / "daily_zones_2026-05-15.log"
    assert expected.exists()


# ---------------------------------------------------------------------------
# Trading-date override uses that date for logfile naming
# ---------------------------------------------------------------------------


def test_trading_date_override_uses_that_date_in_logfile(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    logs = tmp_path / "logs"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 8, 0, tzinfo=_ET))

    rc = main(
        [
            "--captures-root", str(captures),
            "--zones-root", str(tmp_path / "zones"),
            "--logs-root", str(logs),
            "--trading-date", "2026-05-14",
            "--partial-capture-warn-threshold", "100",
        ]
    )

    assert rc == EXIT_OK
    assert (logs / "daily_zones_2026-05-14.log").exists()


# ---------------------------------------------------------------------------
# RA-029: probe-parity capture is normalized on-the-fly
# ---------------------------------------------------------------------------


def _write_parity_capture(path: Path, *, n_trades: int) -> None:
    """Write a synthetic probe-parity JSONL (LAST_TRADE records)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    base_ts = 1_777_301_400_000_000_000
    with path.open("w", encoding="utf-8") as f:
        for i in range(n_trades):
            rec = {
                "schema_version": 1, "stream": "LAST_TRADE",
                "probe_id": "rithmic-MNQM6-1779000000",
                "symbol": "MNQM6", "exchange": "CME",
                "exchange_event_ts_ns": str(base_ts + i * 1_000_000_000),
                "sidecar_recv_ts_ns": str(base_ts + i * 1_000_000_000 + 1000),
                "template_id": 150, "payload_kind": "LastTrade",
                "raw_present": False,
                "sequence": f"{1_000_000 + i}",
                "price": 27380.0 + (i % 20) * 0.25,
                "size": 1,
                "aggressor": "buy" if i % 2 == 0 else "sell",
                "side": "buy" if i % 2 == 0 else "sell",
            }
            f.write(json.dumps(rec) + "\n")


def test_daily_zones_normalizes_parity_capture_then_emits_zones(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Probe-parity capture → on-the-fly normalize → zone JSON emitted."""
    captures = tmp_path / "captures"
    # Write a parity-mode capture (NOT pre-normalized OBS-01)
    _write_parity_capture(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    zones = tmp_path / "zones"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    rc = main(
        [
            "--captures-root", str(captures),
            "--zones-root", str(zones),
            "--logs-root", str(tmp_path / "logs"),
            "--trading-date", "2026-05-14",
            "--mode", "full",
            "--partial-capture-warn-threshold", "100",
        ]
    )

    assert rc == EXIT_OK
    assert (zones / "2026-05-14_MNQ_rth.json").exists()
    # The normalized obs01 file is cached alongside the raw capture
    assert (captures / "2026-05-14" / "MNQ_rth.obs01.jsonl").exists()


def test_daily_zones_uses_cached_obs01_when_present(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """If <ROOT>_<session>.obs01.jsonl already exists, use it without re-normalizing."""
    captures = tmp_path / "captures"
    # Raw parity file present but pre-normalized obs01 sibling already exists
    _write_parity_capture(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=10)
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.obs01.jsonl", n_trades=200)
    zones = tmp_path / "zones"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    rc = main(
        [
            "--captures-root", str(captures),
            "--zones-root", str(zones),
                    "--logs-root", str(tmp_path / "logs"),
                    "--trading-date", "2026-05-14",
                    "--mode", "full",
                    "--partial-capture-warn-threshold", "100",
                ]
            )

    assert rc == EXIT_OK
    # Bars-used should reflect the obs01 file (200 trades), not the raw parity (10)
    envelope = json.loads(
        (zones / "2026-05-14_MNQ_rth.json").read_text(encoding="utf-8")
    )
    assert envelope["bars_used"] == 200


# ---------------------------------------------------------------------------
# RA-030.1: optional absorption-events emit
# ---------------------------------------------------------------------------


def _write_mbp1_sibling(path: Path, *, n_quotes: int = 100) -> None:
    """Write a synthetic MBP1 JSONL sibling that load_mbp1 will consume."""
    path.parent.mkdir(parents=True, exist_ok=True)
    base_ts = 1_777_301_400_000_000_000
    with path.open("w", encoding="utf-8") as f:
        for i in range(n_quotes):
            rec = {
                "ts_event_ns": str(base_ts + i * 1_000_000_000),
                "ts_recv_ns": str(base_ts + i * 1_000_000_000 + 100),
                "bid_px_00": 27380.0,
                "bid_sz_00": 5,
                "bid_ct_00": 2,
                "ask_px_00": 27380.25,
                "ask_sz_00": 5,
                "ask_ct_00": 2,
            }
            f.write(json.dumps(rec) + "\n")


def test_emit_absorption_off_by_default(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Without --emit-absorption-json, no absorption file is produced."""
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    _write_mbp1_sibling(captures / "2026-05-14" / "MNQ_rth.mbp1.jsonl")
    zones = tmp_path / "zones"
    absorption = tmp_path / "absorption"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    rc = main([
        "--captures-root", str(captures),
        "--zones-root", str(zones),
        "--logs-root", str(tmp_path / "logs"),
        "--absorption-root", str(absorption),
        "--partial-capture-warn-threshold", "100",
    ])

    assert rc == EXIT_OK
    assert (zones / "2026-05-14_MNQ_rth.json").exists()
    # No absorption file when flag is off
    assert not absorption.exists() or not list(absorption.iterdir())


def test_emit_absorption_writes_file_when_flag_set(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """With flag + MBP1 sibling present → absorption JSON file is written."""
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    _write_mbp1_sibling(captures / "2026-05-14" / "MNQ_rth.mbp1.jsonl")
    zones = tmp_path / "zones"
    absorption = tmp_path / "absorption"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    rc = main([
        "--captures-root", str(captures),
        "--zones-root", str(zones),
        "--logs-root", str(tmp_path / "logs"),
        "--absorption-root", str(absorption),
        "--partial-capture-warn-threshold", "100",
        "--emit-absorption-json",
    ])

    assert rc == EXIT_OK
    assert (zones / "2026-05-14_MNQ_rth.json").exists()
    absorption_file = absorption / "2026-05-14_MNQ_rth.json"
    assert absorption_file.exists()
    # File is a JSON array (possibly empty for synthetic data that doesn't trigger absorption)
    events = json.loads(absorption_file.read_text(encoding="utf-8"))
    assert isinstance(events, list)


def test_emit_absorption_missing_mbp1_sibling_warns_no_crash(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """No MBP1 sibling → WARN log, no absorption file, but zones STILL produced."""
    import logging as _logging
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    # Deliberately do NOT write the .mbp1.jsonl sibling
    zones = tmp_path / "zones"
    absorption = tmp_path / "absorption"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    with caplog.at_level(_logging.WARNING, logger="rithmic_analytics.daily_zones"):
        rc = main([
            "--captures-root", str(captures),
            "--zones-root", str(zones),
            "--logs-root", str(tmp_path / "logs"),
            "--absorption-root", str(absorption),
            "--partial-capture-warn-threshold", "100",
            "--emit-absorption-json",
        ])

    # Critical: zones JSON still produced even though absorption emit was skipped
    assert rc == EXIT_OK
    assert (zones / "2026-05-14_MNQ_rth.json").exists()
    assert not (absorption / "2026-05-14_MNQ_rth.json").exists()
    assert any(
        "no MBP1 sibling" in r.message for r in caplog.records
    )


def test_emit_absorption_compute_failure_does_not_kill_zones(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """If compute_absorption_events raises, zones still produced + WARN logged."""
    import logging as _logging
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    _write_mbp1_sibling(captures / "2026-05-14" / "MNQ_rth.mbp1.jsonl")
    zones = tmp_path / "zones"
    absorption = tmp_path / "absorption"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    # Monkey-patch compute_absorption_events to raise
    def fake_compute(*args: object, **kwargs: object) -> object:
        raise RuntimeError("synthetic absorption-compute failure")

    monkeypatch.setattr(daily_zones, "compute_absorption_events", fake_compute)

    with caplog.at_level(_logging.WARNING, logger="rithmic_analytics.daily_zones"):
        rc = main([
            "--captures-root", str(captures),
            "--zones-root", str(zones),
            "--logs-root", str(tmp_path / "logs"),
            "--absorption-root", str(absorption),
            "--partial-capture-warn-threshold", "100",
            "--emit-absorption-json",
        ])

    # Zones JSON is the load-bearing artifact — must still exist
    assert rc == EXIT_OK
    assert (zones / "2026-05-14_MNQ_rth.json").exists()
    # No absorption file (compute failed before write)
    assert not (absorption / "2026-05-14_MNQ_rth.json").exists()
    # WARNING logged with the failure context
    assert any(
        "absorption emit failed" in r.message
        and "zones still produced" in r.message
        for r in caplog.records
    )


def test_emit_absorption_creates_parent_dir(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """absorption-root doesn't exist yet → created on demand."""
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    _write_mbp1_sibling(captures / "2026-05-14" / "MNQ_rth.mbp1.jsonl")
    deep_absorption = tmp_path / "deeply" / "nested" / "absorption"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    rc = main([
        "--captures-root", str(captures),
        "--zones-root", str(tmp_path / "zones"),
        "--logs-root", str(tmp_path / "logs"),
        "--absorption-root", str(deep_absorption),
        "--partial-capture-warn-threshold", "100",
        "--emit-absorption-json",
    ])

    assert rc == EXIT_OK
    assert (deep_absorption / "2026-05-14_MNQ_rth.json").exists()


def test_mbp1_sibling_path_derivation() -> None:
    """Both raw .jsonl and .obs01.jsonl input paths derive the same .mbp1.jsonl path."""
    from rithmic_analytics.cli.daily_zones import _mbp1_sibling_for

    raw = Path("data/captures/2026-05-19/MNQ_rth.jsonl")
    obs01 = Path("data/captures/2026-05-19/MNQ_rth.obs01.jsonl")
    expected = Path("data/captures/2026-05-19/MNQ_rth.mbp1.jsonl")

    assert _mbp1_sibling_for(raw) == expected
    assert _mbp1_sibling_for(obs01) == expected


# ---------------------------------------------------------------------------
# RA-036: optional cancellation-analysis emit
# ---------------------------------------------------------------------------


def _write_orders_csv(path: Path) -> None:
    """Write a synthetic Tradesea orders CSV with 1 cancel + 1 fill."""
    header = (
        '"Time","Symbol","Qty","Side","Order Type","Limit Price","Stop Price",'
        '"Avg Price","Commission","Status"'
    )
    rows = [
        # Use Apr 27 to align with the synthetic OBS-01 base_ts in _write_obs01.
        # base_ts in _write_obs01 = 1_777_301_400_000_000_000 ≈ 2026-04-27T22:30:00 UTC =
        # 2026-04-27 15:30 PDT. Use a cancel/fill time just before that.
        '"4/27/2026, 3:25:00 PM PDT","CME:MNQ",1,"Buy","Limit","27380.00","",'
        '"","","Cancelled (by trader)"',
        '"4/27/2026, 3:30:00 PM PDT","CME:MNQ",1,"Buy","Market","","",'
        '"27381.25","0.50","Filled"',
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(header + "\n" + "\n".join(rows) + "\n", encoding="utf-8")


def test_emit_cancellation_analysis_off_by_default(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-04-27" / "MNQ_rth.jsonl", n_trades=200)
    cancellations_root = tmp_path / "cancellations"
    orders_root = tmp_path / "trades"
    _write_orders_csv(orders_root / "2026-04-27" / "orders.csv")
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    rc = main([
        "--captures-root", str(captures),
        "--zones-root", str(tmp_path / "zones"),
        "--logs-root", str(tmp_path / "logs"),
        "--cancellations-root", str(cancellations_root),
        "--orders-root", str(orders_root),
        "--trading-date", "2026-04-27",
        "--partial-capture-warn-threshold", "100",
    ])

    assert rc == EXIT_OK
    assert not cancellations_root.exists() or not list(cancellations_root.iterdir())


def test_emit_cancellation_analysis_writes_file_when_flag_set(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-04-27" / "MNQ_rth.jsonl", n_trades=200)
    cancellations_root = tmp_path / "cancellations"
    orders_root = tmp_path / "trades"
    _write_orders_csv(orders_root / "2026-04-27" / "orders.csv")
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    rc = main([
        "--captures-root", str(captures),
        "--zones-root", str(tmp_path / "zones"),
        "--logs-root", str(tmp_path / "logs"),
        "--cancellations-root", str(cancellations_root),
        "--orders-root", str(orders_root),
        "--trading-date", "2026-04-27",
        "--partial-capture-warn-threshold", "100",
        "--emit-cancellation-analysis",
    ])

    assert rc == EXIT_OK
    out_file = cancellations_root / "2026-04-27_MNQ_rth.json"
    assert out_file.exists()
    payload = json.loads(out_file.read_text(encoding="utf-8"))
    assert payload["schema_version"] == 1
    assert "session_summary" in payload
    assert "per_cancel_outcomes" in payload


def test_emit_cancellation_analysis_missing_orders_csv_skips_silently(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """No orders CSV → INFO log + zones still produced (not a failure)."""
    import logging as _logging
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-04-27" / "MNQ_rth.jsonl", n_trades=200)
    zones = tmp_path / "zones"
    cancellations_root = tmp_path / "cancellations"
    orders_root = tmp_path / "trades"
    # Deliberately NO orders.csv at orders_root/2026-04-27/
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    with caplog.at_level(_logging.INFO, logger="rithmic_analytics.daily_zones"):
        rc = main([
            "--captures-root", str(captures),
            "--zones-root", str(zones),
            "--logs-root", str(tmp_path / "logs"),
            "--cancellations-root", str(cancellations_root),
            "--orders-root", str(orders_root),
            "--trading-date", "2026-04-27",
            "--partial-capture-warn-threshold", "100",
            "--emit-cancellation-analysis",
        ])

    assert rc == EXIT_OK
    assert (zones / "2026-04-27_MNQ_rth.json").exists()
    assert not (cancellations_root / "2026-04-27_MNQ_rth.json").exists()
    assert any("no Tradesea CSV" in r.message for r in caplog.records)


def test_emit_cancellation_analysis_failure_does_not_kill_zones(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """If analyze_cancellations raises, zones still produced + WARN logged."""
    import logging as _logging
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-04-27" / "MNQ_rth.jsonl", n_trades=200)
    cancellations_root = tmp_path / "cancellations"
    orders_root = tmp_path / "trades"
    _write_orders_csv(orders_root / "2026-04-27" / "orders.csv")
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    def fake_analyze(*args: object, **kwargs: object) -> object:
        raise RuntimeError("synthetic cancellation-analysis failure")

    monkeypatch.setattr(daily_zones, "analyze_cancellations", fake_analyze)

    with caplog.at_level(_logging.WARNING, logger="rithmic_analytics.daily_zones"):
        rc = main([
            "--captures-root", str(captures),
            "--zones-root", str(tmp_path / "zones"),
            "--logs-root", str(tmp_path / "logs"),
            "--cancellations-root", str(cancellations_root),
            "--orders-root", str(orders_root),
            "--trading-date", "2026-04-27",
            "--partial-capture-warn-threshold", "100",
            "--emit-cancellation-analysis",
        ])

    assert rc == EXIT_OK
    assert (tmp_path / "zones" / "2026-04-27_MNQ_rth.json").exists()
    assert not (cancellations_root / "2026-04-27_MNQ_rth.json").exists()
    assert any(
        "cancellation emit failed" in r.message
        and "zones still produced" in r.message
        for r in caplog.records
    )


# ---------------------------------------------------------------------------
# RA-035: optional order-pressure emit
# ---------------------------------------------------------------------------


def _write_mbo_sibling(path: Path, *, n_events: int = 100) -> None:
    """Write a synthetic MBO JSONL sibling that load_mbo will consume."""
    path.parent.mkdir(parents=True, exist_ok=True)
    base_ts = 1_777_301_400_000_000_000
    with path.open("w", encoding="utf-8") as f:
        for i in range(n_events):
            rec = {
                "ts_event_ns": str(base_ts + i * 100_000_000),  # 100ms apart
                "ts_recv_ns": str(base_ts + i * 100_000_000 + 1000),
                "sequence": str(9_000_000 + i),
                "action": "A" if i % 2 == 0 else "C",
                "side": "B" if i % 2 == 0 else "A",
                "price": 27380.0 + (i % 10) * 0.25,
                "size": 5,
                "order_id": f"o{i // 2}",  # pair A and C with same order_id
            }
            f.write(json.dumps(rec) + "\n")


def test_emit_pressure_off_by_default(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    _write_mbo_sibling(captures / "2026-05-14" / "MNQ_rth.mbo.jsonl")
    pressure = tmp_path / "pressure"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    rc = main([
        "--captures-root", str(captures),
        "--zones-root", str(tmp_path / "zones"),
        "--logs-root", str(tmp_path / "logs"),
        "--pressure-root", str(pressure),
        "--partial-capture-warn-threshold", "100",
    ])

    assert rc == EXIT_OK
    # No pressure file when flag is off
    assert not pressure.exists() or not list(pressure.iterdir())


def test_emit_pressure_writes_file_when_flag_set(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    _write_mbo_sibling(captures / "2026-05-14" / "MNQ_rth.mbo.jsonl", n_events=200)
    pressure = tmp_path / "pressure"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    rc = main([
        "--captures-root", str(captures),
        "--zones-root", str(tmp_path / "zones"),
        "--logs-root", str(tmp_path / "logs"),
        "--pressure-root", str(pressure),
        "--partial-capture-warn-threshold", "100",
        "--emit-pressure-json",
    ])

    assert rc == EXIT_OK
    pressure_file = pressure / "2026-05-14_MNQ_rth.json"
    assert pressure_file.exists()
    payload = json.loads(pressure_file.read_text(encoding="utf-8"))
    assert "rows" in payload
    assert "metadata" in payload
    assert payload["metadata"]["window_seconds"] == 30  # default


def test_emit_pressure_missing_mbo_sibling_warns_no_crash(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """No MBO sibling → WARN, no pressure file, but zones STILL produced."""
    import logging as _logging
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    # Deliberately NO .mbo.jsonl sibling
    zones = tmp_path / "zones"
    pressure = tmp_path / "pressure"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    with caplog.at_level(_logging.WARNING, logger="rithmic_analytics.daily_zones"):
        rc = main([
            "--captures-root", str(captures),
            "--zones-root", str(zones),
            "--logs-root", str(tmp_path / "logs"),
            "--pressure-root", str(pressure),
            "--partial-capture-warn-threshold", "100",
            "--emit-pressure-json",
        ])

    # Zones JSON still produced
    assert rc == EXIT_OK
    assert (zones / "2026-05-14_MNQ_rth.json").exists()
    assert not (pressure / "2026-05-14_MNQ_rth.json").exists()
    assert any("no MBO sibling" in r.message for r in caplog.records)


def test_emit_pressure_compute_failure_does_not_kill_zones(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """If compute_order_pressure raises, zones still produced + WARN logged."""
    import logging as _logging
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    _write_mbo_sibling(captures / "2026-05-14" / "MNQ_rth.mbo.jsonl")
    zones = tmp_path / "zones"
    pressure = tmp_path / "pressure"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    # Force compute_order_pressure to raise
    def fake_compute(*args: object, **kwargs: object) -> object:
        raise RuntimeError("synthetic pressure failure")

    monkeypatch.setattr(daily_zones, "compute_order_pressure", fake_compute)

    with caplog.at_level(_logging.WARNING, logger="rithmic_analytics.daily_zones"):
        rc = main([
            "--captures-root", str(captures),
            "--zones-root", str(zones),
            "--logs-root", str(tmp_path / "logs"),
            "--pressure-root", str(pressure),
            "--partial-capture-warn-threshold", "100",
            "--emit-pressure-json",
        ])

    # Critical: zones JSON still produced
    assert rc == EXIT_OK
    assert (zones / "2026-05-14_MNQ_rth.json").exists()
    assert not (pressure / "2026-05-14_MNQ_rth.json").exists()
    assert any(
        "pressure emit failed" in r.message
        and "zones still produced" in r.message
        for r in caplog.records
    )


def test_mbo_sibling_path_derivation() -> None:
    """Both raw .jsonl and .obs01.jsonl inputs derive the same .mbo.jsonl."""
    from rithmic_analytics.cli.daily_zones import _mbo_sibling_for

    raw = Path("data/captures/2026-05-19/MNQ_rth.jsonl")
    obs01 = Path("data/captures/2026-05-19/MNQ_rth.obs01.jsonl")
    expected = Path("data/captures/2026-05-19/MNQ_rth.mbo.jsonl")

    assert _mbo_sibling_for(raw) == expected
    assert _mbo_sibling_for(obs01) == expected


# ---------------------------------------------------------------------------
# RA-031: VWAP reference lines in emitted zone envelope
# ---------------------------------------------------------------------------


def test_daily_zones_emits_vwap_reference_lines(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The emitted zone JSON includes VWAP + ±1σ band reference lines."""
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    zones = tmp_path / "zones"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    rc = main([
        "--captures-root", str(captures),
        "--zones-root", str(zones),
        "--logs-root", str(tmp_path / "logs"),
        "--partial-capture-warn-threshold", "100",
    ])
    assert rc == EXIT_OK

    envelope = json.loads(
        (zones / "2026-05-14_MNQ_rth.json").read_text(encoding="utf-8")
    )
    sources = {r["source"] for r in envelope["reference_lines"]}
    # VWAP RTH + ±1σ bands + weekly
    assert "vwap_rth" in sources
    assert "vwap_rth_band_p1sd" in sources
    assert "vwap_rth_band_m1sd" in sources
    assert "vwap_weekly" in sources
    # ±2σ deliberately omitted from main output (noise floor)
    assert "vwap_rth_band_p2sd" not in sources
    assert "vwap_rth_band_m2sd" not in sources


# ---------------------------------------------------------------------------
# RA-033: heartbeat-of-heartbeat watchdog
# ---------------------------------------------------------------------------


def _write_heartbeat(heartbeat_dir: Path, d: date) -> None:
    heartbeat_dir.mkdir(parents=True, exist_ok=True)
    (heartbeat_dir / f"{d.isoformat()}.txt").write_text("{}", encoding="utf-8")


def test_heartbeat_watchdog_missing_prior_day_warns(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Prior-day heartbeat missing → WARNING log line emitted."""
    import logging as _logging
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    heartbeat_dir = tmp_path / "heartbeat"
    # Seed only an OLDER heartbeat (not prior day) so we're past bootstrap
    _write_heartbeat(heartbeat_dir, date(2026, 5, 1))
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    with caplog.at_level(_logging.WARNING, logger="rithmic_analytics.daily_zones"):
        rc = main([
            "--captures-root", str(captures),
            "--zones-root", str(tmp_path / "zones"),
            "--logs-root", str(tmp_path / "logs"),
            "--heartbeat-dir", str(heartbeat_dir),
            "--partial-capture-warn-threshold", "100",
        ])

    assert rc == EXIT_OK
    watchdog_warnings = [
        r for r in caplog.records if "heartbeat-watchdog" in r.message
    ]
    assert watchdog_warnings, "expected heartbeat-watchdog WARNING for missing prior-day heartbeat"


def test_heartbeat_watchdog_present_prior_day_silent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Prior-day heartbeat present → no watchdog noise."""
    import logging as _logging
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    heartbeat_dir = tmp_path / "heartbeat"
    # daily_zones runs for trading_date=2026-05-14, prior business day = 2026-05-13
    _write_heartbeat(heartbeat_dir, date(2026, 5, 13))
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    with caplog.at_level(_logging.WARNING, logger="rithmic_analytics.daily_zones"):
        rc = main([
            "--captures-root", str(captures),
            "--zones-root", str(tmp_path / "zones"),
            "--logs-root", str(tmp_path / "logs"),
            "--heartbeat-dir", str(heartbeat_dir),
            "--partial-capture-warn-threshold", "100",
        ])

    assert rc == EXIT_OK
    assert not any("heartbeat-watchdog" in r.message for r in caplog.records)


def test_heartbeat_watchdog_bootstrap_empty_dir_silent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Empty heartbeat dir = fresh install → no false alarm."""
    import logging as _logging
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    heartbeat_dir = tmp_path / "heartbeat"
    heartbeat_dir.mkdir()  # exists but empty
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    with caplog.at_level(_logging.WARNING, logger="rithmic_analytics.daily_zones"):
        rc = main([
            "--captures-root", str(captures),
            "--zones-root", str(tmp_path / "zones"),
            "--logs-root", str(tmp_path / "logs"),
            "--heartbeat-dir", str(heartbeat_dir),
            "--partial-capture-warn-threshold", "100",
        ])

    assert rc == EXIT_OK
    assert not any("heartbeat-watchdog" in r.message for r in caplog.records)


def test_heartbeat_watchdog_nonexistent_dir_silent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Heartbeat dir doesn't exist → no false alarm (covers `--heartbeat-dir` default before user creates it)."""
    import logging as _logging
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    with caplog.at_level(_logging.WARNING, logger="rithmic_analytics.daily_zones"):
        rc = main([
            "--captures-root", str(captures),
            "--zones-root", str(tmp_path / "zones"),
            "--logs-root", str(tmp_path / "logs"),
            "--heartbeat-dir", str(tmp_path / "nonexistent_heartbeat"),
            "--partial-capture-warn-threshold", "100",
        ])

    assert rc == EXIT_OK
    assert not any("heartbeat-watchdog" in r.message for r in caplog.records)


def test_heartbeat_watchdog_invokes_post_fail_when_alerts_wired(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """If alerts.post_fail exists (RA-032 shipped), the watchdog calls it."""
    captures = tmp_path / "captures"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl", n_trades=200)
    heartbeat_dir = tmp_path / "heartbeat"
    _write_heartbeat(heartbeat_dir, date(2026, 5, 1))  # older heartbeat
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    # Inject a post_fail shim
    posted: list[dict[str, str]] = []
    from rithmic_analytics.ops import alerts as alerts_mod

    def fake_post_fail(*, source_name: str, message: str) -> None:
        posted.append({"source_name": source_name, "message": message})

    monkeypatch.setattr(alerts_mod, "post_fail", fake_post_fail, raising=False)

    rc = main([
        "--captures-root", str(captures),
        "--zones-root", str(tmp_path / "zones"),
        "--logs-root", str(tmp_path / "logs"),
        "--heartbeat-dir", str(heartbeat_dir),
        "--partial-capture-warn-threshold", "100",
    ])

    assert rc == EXIT_OK
    assert posted, "expected post_fail to be invoked"
    assert posted[0]["source_name"] == "heartbeat_watchdog"


def test_daily_zones_skips_unrecoverable_metadata_only_capture(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Metadata-only capture (raw_present=false + no parity) → skip with error log."""
    import logging as _logging
    captures = tmp_path / "captures"
    cap_path = captures / "2026-05-14" / "MNQ_rth.jsonl"
    cap_path.parent.mkdir(parents=True, exist_ok=True)
    # 50 metadata-only records → unrecoverable
    with cap_path.open("w", encoding="utf-8") as f:
        for _ in range(50):
            f.write(json.dumps({
                "schema_version": 1, "stream": "LAST_TRADE",
                "exchange_event_ts_ns": "1779000000000000001",
                "template_id": 150, "raw_present": False,
            }) + "\n")
    zones = tmp_path / "zones"
    _pin_now(monkeypatch, datetime(2026, 5, 15, 17, 30, tzinfo=_ET))

    with caplog.at_level(_logging.ERROR, logger="rithmic_analytics.daily_zones"):
        rc = main(
            [
                "--captures-root", str(captures),
                "--zones-root", str(zones),
                "--logs-root", str(tmp_path / "logs"),
                "--trading-date", "2026-05-14",
                "--mode", "full",
                "--partial-capture-warn-threshold", "100",
            ]
        )

    # Exit OK (per the existing contract that no-output is logged-warn, not failed),
    # but no zone JSON produced
    assert rc == EXIT_OK
    assert not (zones / "2026-05-14_MNQ_rth.json").exists()
    assert any("unrecoverable" in r.message for r in caplog.records)
