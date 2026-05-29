"""Tests for ``rithmic_analytics.cli.replay_session`` (RA-026)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from rithmic_analytics.cli.replay_session import EXIT_BAD_INPUT, EXIT_OK, EXIT_USAGE, main


def _write_obs01_jsonl(path: Path, n_trades: int = 100) -> None:
    """Write a minimal OBS-01 JSONL fixture the loader will accept."""
    base_ts = 1_777_300_000_000_000_000
    lines = []
    for i in range(n_trades):
        envelope = {
            "type": "TRADE",
            "session_id": "mnq-2026-05-19-rth",
            "payload": {
                "exchange_event_ts_ns": str(base_ts + i * 1_000_000_000),
                "sidecar_recv_ts_ns": str(base_ts + i * 1_000_000_000),
                "price": 27000.0 + (i % 10) * 0.25,
                "quantity": 1,
                "aggressor_side": "buy" if i % 2 == 0 else "sell",
                "trade_id": f"t-{i}",
            },
        }
        lines.append(json.dumps(envelope))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _write_manual_log(path: Path) -> None:
    # Aligned with _write_obs01_jsonl's base_ts = 1_777_300_000_000_000_000 ns
    # = 2026-04-27T14:26:40+00:00. Fill lands 50s into the 100-trade window.
    path.write_text(
        json.dumps({
            "fills": [
                {
                    "fill_ts": "2026-04-27T14:27:30+00:00",
                    "symbol": "MNQ",
                    "side": "buy",
                    "price": 27000.0,
                    "quantity": 1,
                    "order_type": "market",
                    "fill_id": "m-1",
                },
            ]
        }),
        encoding="utf-8",
    )


def _write_tradesea_csv(path: Path) -> None:
    base_ts_pdt = "5/19/2026, 8:48:00 AM PDT"
    header = (
        '"Time","Symbol","Qty","Side","Order Type","Limit Price","Stop Price",'
        '"Avg Price","Commission","Status"'
    )
    row = f'"{base_ts_pdt}","CME:MNQ",1,"Buy","Market","","",27000.0,0.50,"Filled"'
    path.write_text(header + "\n" + row + "\n", encoding="utf-8")


def _write_zones_envelope(path: Path) -> None:
    """A minimal valid zone envelope JSON."""
    payload = {
        "schema_version": 1,
        "symbol": "MNQ",
        "timeframe": "rth",
        "bars_used": 100,
        "computed_at": "2026-05-18T20:00:00+00:00",
        "data_source": "rithmic",
        "vpoc": 27000.0,
        "vah": 27010.0,
        "val": 26990.0,
        "atr_14": 5.0,
        "bin_size_ticks": 20,
        "zones": [
            {
                "id": "hvn-27000", "top": 27001.0, "bot": 26999.0,
                "type": "support", "conviction": "MED",
                "text": "HVN 10%", "sources": ["hvn_rth"], "volume_pct": 0.1,
            }
        ],
        "reference_lines": [],
    }
    path.write_text(json.dumps(payload), encoding="utf-8")


# ---------------------------------------------------------------------------
# Happy paths
# ---------------------------------------------------------------------------


def test_cli_happy_path_manual_log(tmp_path: Path) -> None:
    jsonl = tmp_path / "MNQ_rth.jsonl"
    log = tmp_path / "fills.json"
    out = tmp_path / "replay.html"
    _write_obs01_jsonl(jsonl)
    _write_manual_log(log)

    exit_code = main([
        "--trade-log", str(log),
        "--jsonl", str(jsonl),
        "--output", str(out),
    ])

    assert exit_code == EXIT_OK
    assert out.exists()
    content = out.read_text(encoding="utf-8")
    assert "<title>" in content


def test_cli_happy_path_tradesea_csv(tmp_path: Path) -> None:
    """CSV-extension routes to load_tradesea_csv."""
    jsonl = tmp_path / "MNQ_rth.jsonl"
    csv = tmp_path / "orders.csv"
    out = tmp_path / "replay.html"

    # Anchor the JSONL fixture around the time the CSV fill occurred so
    # the fill lands inside the JSONL window. CSV fill is 5/19/2026 08:48 PDT
    # = 15:48 UTC.
    import pandas as pd
    base_ts = int(pd.Timestamp("2026-05-19T15:47:00", tz="UTC").value)
    lines = []
    for i in range(120):
        envelope = {
            "type": "TRADE",
            "session_id": "mnq-2026-05-19-rth",
            "payload": {
                "exchange_event_ts_ns": str(base_ts + i * 1_000_000_000),
                "sidecar_recv_ts_ns": str(base_ts + i * 1_000_000_000),
                "price": 27000.0,
                "quantity": 1,
                "aggressor_side": "buy",
                "trade_id": f"t-{i}",
            },
        }
        lines.append(json.dumps(envelope))
    jsonl.write_text("\n".join(lines) + "\n", encoding="utf-8")
    _write_tradesea_csv(csv)

    exit_code = main([
        "--trade-log", str(csv),
        "--jsonl", str(jsonl),
        "--output", str(out),
    ])

    assert exit_code == EXIT_OK
    assert out.exists()


def test_cli_with_zones(tmp_path: Path) -> None:
    jsonl = tmp_path / "MNQ_rth.jsonl"
    log = tmp_path / "fills.json"
    zones = tmp_path / "zones.json"
    out = tmp_path / "replay.html"
    _write_obs01_jsonl(jsonl)
    _write_manual_log(log)
    _write_zones_envelope(zones)

    exit_code = main([
        "--trade-log", str(log),
        "--jsonl", str(jsonl),
        "--zones", str(zones),
        "--output", str(out),
    ])

    assert exit_code == EXIT_OK


def test_cli_custom_window_and_horizons(tmp_path: Path) -> None:
    jsonl = tmp_path / "MNQ_rth.jsonl"
    log = tmp_path / "fills.json"
    out = tmp_path / "replay.html"
    _write_obs01_jsonl(jsonl)
    _write_manual_log(log)

    exit_code = main([
        "--trade-log", str(log),
        "--jsonl", str(jsonl),
        "--output", str(out),
        "--window-sec", "30",
        "--pnl-horizons", "30,90",
    ])

    assert exit_code == EXIT_OK
    content = out.read_text(encoding="utf-8")
    assert "PnL @ 30s" in content
    assert "PnL @ 90s" in content
    assert "window=30s" in content


# ---------------------------------------------------------------------------
# Bad input
# ---------------------------------------------------------------------------


def test_cli_missing_trade_log_returns_bad_input(tmp_path: Path) -> None:
    jsonl = tmp_path / "MNQ_rth.jsonl"
    out = tmp_path / "replay.html"
    _write_obs01_jsonl(jsonl)

    exit_code = main([
        "--trade-log", str(tmp_path / "does_not_exist.json"),
        "--jsonl", str(jsonl),
        "--output", str(out),
    ])

    assert exit_code == EXIT_BAD_INPUT


def test_cli_missing_jsonl_returns_bad_input(tmp_path: Path) -> None:
    log = tmp_path / "fills.json"
    out = tmp_path / "replay.html"
    _write_manual_log(log)

    exit_code = main([
        "--trade-log", str(log),
        "--jsonl", str(tmp_path / "does_not_exist.jsonl"),
        "--output", str(out),
    ])

    assert exit_code == EXIT_BAD_INPUT


def test_cli_missing_zones_returns_bad_input(tmp_path: Path) -> None:
    jsonl = tmp_path / "MNQ_rth.jsonl"
    log = tmp_path / "fills.json"
    out = tmp_path / "replay.html"
    _write_obs01_jsonl(jsonl)
    _write_manual_log(log)

    exit_code = main([
        "--trade-log", str(log),
        "--jsonl", str(jsonl),
        "--zones", str(tmp_path / "no_such_zones.json"),
        "--output", str(out),
    ])

    assert exit_code == EXIT_BAD_INPUT


def test_cli_unrecognised_trade_log_extension_returns_usage(tmp_path: Path) -> None:
    jsonl = tmp_path / "MNQ_rth.jsonl"
    log = tmp_path / "fills.xml"  # unsupported
    out = tmp_path / "replay.html"
    _write_obs01_jsonl(jsonl)
    log.write_text("<xml/>", encoding="utf-8")

    exit_code = main([
        "--trade-log", str(log),
        "--jsonl", str(jsonl),
        "--output", str(out),
    ])

    assert exit_code == EXIT_USAGE


def test_cli_bad_pnl_horizons_returns_usage(tmp_path: Path) -> None:
    jsonl = tmp_path / "MNQ_rth.jsonl"
    log = tmp_path / "fills.json"
    out = tmp_path / "replay.html"
    _write_obs01_jsonl(jsonl)
    _write_manual_log(log)

    exit_code = main([
        "--trade-log", str(log),
        "--jsonl", str(jsonl),
        "--output", str(out),
        "--pnl-horizons", "not-numeric",
    ])

    assert exit_code == EXIT_USAGE


def test_cli_negative_pnl_horizons_returns_usage(tmp_path: Path) -> None:
    jsonl = tmp_path / "MNQ_rth.jsonl"
    log = tmp_path / "fills.json"
    out = tmp_path / "replay.html"
    _write_obs01_jsonl(jsonl)
    _write_manual_log(log)

    exit_code = main([
        "--trade-log", str(log),
        "--jsonl", str(jsonl),
        "--output", str(out),
        "--pnl-horizons", "60,-30",
    ])

    assert exit_code == EXIT_USAGE


# ---------------------------------------------------------------------------
# Required args
# ---------------------------------------------------------------------------


def test_cli_missing_required_args_exits(tmp_path: Path) -> None:
    """argparse exits with code 2 (its usage code) when required args missing."""
    with pytest.raises(SystemExit):
        main(["--trade-log", str(tmp_path / "x.json")])
