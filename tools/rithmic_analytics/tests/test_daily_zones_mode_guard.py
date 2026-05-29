"""RA-052 daily_zones light/full mode contract tests."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from rithmic_analytics.cli import daily_zones
from rithmic_analytics.cli.daily_zones import EXIT_BAD_CONFIG, EXIT_OK, main

_ET = ZoneInfo("America/New_York")


def _write_obs01(path: Path, *, n_trades: int = 240) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    base_ts = 1_777_301_400_000_000_000
    with path.open("w", encoding="utf-8") as handle:
        for i in range(n_trades):
            rec: dict[str, Any] = {
                "event_id": f"trade-{i:06d}",
                "run_id": "test-run",
                "schema_version": 1,
                "session_id": "mnq-2026-05-14-rth",
                "ts_ns": str(base_ts + i * 60_000_000_000),
                "type": "TRADE",
                "payload": {
                    "aggressor_side": "buy" if i % 2 == 0 else "sell",
                    "exchange_event_ts_ns": str(base_ts + i * 60_000_000_000),
                    "sidecar_recv_ts_ns": str(base_ts + i * 60_000_000_000 + 1000),
                    "price": 27380.0 + (i % 20) * 0.25,
                    "quantity": 1,
                    "trade_id": f"t{i}",
                },
            }
            handle.write(json.dumps(rec) + "\n")


def _pin_complete_day(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        daily_zones,
        "_now_et",
        lambda: datetime(2026, 5, 14, 17, 30, tzinfo=_ET),
    )


def test_explicit_light_rejects_heavy_flags(tmp_path: Path) -> None:
    rc = main([
        "--captures-root", str(tmp_path / "captures"),
        "--mode", "light",
        "--emit-pressure-json",
    ])

    assert rc == EXIT_BAD_CONFIG


def test_omitted_mode_with_heavy_flag_routes_to_full(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    captures = tmp_path / "captures"
    zones = tmp_path / "zones"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl")
    _pin_complete_day(monkeypatch)

    calls: dict[str, int] = {"pressure": 0}

    def fake_pressure(**_: object) -> None:
        calls["pressure"] += 1
        return None

    monkeypatch.setattr(daily_zones, "_emit_pressure_json", fake_pressure)

    with caplog.at_level("WARNING", logger="rithmic_analytics.daily_zones"):
        rc = main([
            "--captures-root", str(captures),
            "--zones-root", str(zones),
            "--logs-root", str(tmp_path / "logs"),
            "--trading-date", "2026-05-14",
            "--sessions", "rth",
            "--emit-pressure-json",
            "--partial-capture-warn-threshold", "1",
        ])

    assert rc == EXIT_OK
    assert calls["pressure"] == 1
    assert any("routing to --mode full" in rec.message for rec in caplog.records)


def test_light_mode_call_graph_does_not_touch_heavy_emitters(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    captures = tmp_path / "captures"
    zones = tmp_path / "zones"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl")
    _pin_complete_day(monkeypatch)

    def fail_heavy(**_: object) -> None:
        raise AssertionError("heavy emitter called in light mode")

    monkeypatch.setattr(daily_zones, "_emit_pressure_json", fail_heavy)
    monkeypatch.setattr(daily_zones, "_emit_cancellation_analysis", fail_heavy)

    rc = main([
        "--captures-root", str(captures),
        "--zones-root", str(zones),
        "--logs-root", str(tmp_path / "logs"),
        "--trading-date", "2026-05-14",
        "--sessions", "rth",
        "--mode", "light",
        "--partial-capture-warn-threshold", "1",
    ])

    assert rc == EXIT_OK


def test_explicit_full_enables_heavy_emitters(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    captures = tmp_path / "captures"
    zones = tmp_path / "zones"
    _write_obs01(captures / "2026-05-14" / "MNQ_rth.jsonl")
    _pin_complete_day(monkeypatch)
    calls: dict[str, int] = {"pressure": 0, "cancellation": 0}

    def fake_pressure(**_: object) -> None:
        calls["pressure"] += 1
        return None

    def fake_cancellation(**_: object) -> None:
        calls["cancellation"] += 1
        return None

    monkeypatch.setattr(daily_zones, "_emit_pressure_json", fake_pressure)
    monkeypatch.setattr(daily_zones, "_emit_cancellation_analysis", fake_cancellation)

    rc = main([
        "--captures-root", str(captures),
        "--zones-root", str(zones),
        "--logs-root", str(tmp_path / "logs"),
        "--trading-date", "2026-05-14",
        "--sessions", "rth",
        "--mode", "full",
        "--partial-capture-warn-threshold", "1",
    ])

    assert rc == EXIT_OK
    assert calls == {"pressure": 1, "cancellation": 1}
