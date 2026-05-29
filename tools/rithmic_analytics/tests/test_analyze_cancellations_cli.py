"""Tests for ``rithmic_analytics.cli.analyze_cancellations`` (RA-036)."""

from __future__ import annotations

import json
from pathlib import Path

from rithmic_analytics.cli.analyze_cancellations import (
    EXIT_BAD_INPUT,
    EXIT_OK,
    EXIT_USAGE,
    main,
)


def _write_tradesea_csv(path: Path) -> None:
    """Write a synthetic Tradesea CSV with 1 fill + 1 cancellation."""
    header = (
        '"Time","Symbol","Qty","Side","Order Type","Limit Price","Stop Price",'
        '"Avg Price","Commission","Status"'
    )
    rows = [
        # Cancelled buy limit
        '"5/19/2026, 8:48:00 AM PDT","CME:MNQ",1,"Buy","Limit","27380.00","",'
        '"","","Cancelled (by trader)"',
        # Filled order so the loader has a recoverability data point
        '"5/19/2026, 8:50:00 AM PDT","CME:MNQ",1,"Buy","Market","","",'
        '"27381.25","0.50","Filled"',
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(header + "\n" + "\n".join(rows) + "\n", encoding="utf-8")


def _write_obs01_jsonl(path: Path, *, n_trades: int = 100) -> None:
    """Minimal OBS-01 JSONL after the cancellation timestamp."""
    # Cancellation is 8:48 AM PDT = 15:48 UTC on 5/19/2026
    import pandas as pd
    base_ts = int(pd.Timestamp("2026-05-19T15:49:00", tz="UTC").value)
    lines = []
    for i in range(n_trades):
        envelope = {
            "type": "TRADE",
            "session_id": "mnq-2026-05-19-rth",
            "payload": {
                "exchange_event_ts_ns": str(base_ts + i * 1_000_000_000),
                "sidecar_recv_ts_ns": str(base_ts + i * 1_000_000_000),
                "price": 27380.0 + (i % 10) * 0.25,
                "quantity": 1,
                "aggressor_side": "buy" if i % 2 == 0 else "sell",
                "trade_id": f"t-{i}",
            },
        }
        lines.append(json.dumps(envelope))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_cli_happy_path(tmp_path: Path) -> None:
    orders = tmp_path / "orders.csv"
    jsonl = tmp_path / "MNQ_rth.obs01.jsonl"
    out = tmp_path / "cancellations.json"
    _write_tradesea_csv(orders)
    _write_obs01_jsonl(jsonl)

    rc = main([
        "--orders", str(orders),
        "--jsonl", str(jsonl),
        "--output", str(out),
    ])

    assert rc == EXIT_OK
    assert out.exists()
    report = json.loads(out.read_text(encoding="utf-8"))
    assert report["schema_version"] == 1
    assert "session_summary" in report
    assert "per_cancel_outcomes" in report
    assert "metadata" in report
    # Default windows surface in metadata
    assert report["metadata"]["regret_window_minutes"] == 5
    assert report["metadata"]["rebuy_window_minutes"] == 10
    assert report["metadata"]["regret_tolerance_ticks"] == 1


def test_cli_custom_window_minutes(tmp_path: Path) -> None:
    orders = tmp_path / "orders.csv"
    jsonl = tmp_path / "MNQ_rth.obs01.jsonl"
    out = tmp_path / "cancellations.json"
    _write_tradesea_csv(orders)
    _write_obs01_jsonl(jsonl)

    rc = main([
        "--orders", str(orders),
        "--jsonl", str(jsonl),
        "--output", str(out),
        "--regret-window-minutes", "3",
        "--rebuy-window-minutes", "15",
        "--regret-tolerance-ticks", "2",
        "--min-window-seconds", "30",
    ])

    assert rc == EXIT_OK
    report = json.loads(out.read_text(encoding="utf-8"))
    meta = report["metadata"]
    assert meta["regret_window_minutes"] == 3
    assert meta["rebuy_window_minutes"] == 15
    assert meta["regret_tolerance_ticks"] == 2
    assert meta["min_window_seconds"] == 30


def test_cli_trading_date_metadata_stamp(tmp_path: Path) -> None:
    orders = tmp_path / "orders.csv"
    jsonl = tmp_path / "MNQ_rth.obs01.jsonl"
    out = tmp_path / "cancellations.json"
    _write_tradesea_csv(orders)
    _write_obs01_jsonl(jsonl)

    rc = main([
        "--orders", str(orders),
        "--jsonl", str(jsonl),
        "--output", str(out),
        "--trading-date", "2026-05-19",
    ])

    assert rc == EXIT_OK
    report = json.loads(out.read_text(encoding="utf-8"))
    assert report["metadata"]["trading_date"] == "2026-05-19"


def test_cli_missing_orders_returns_bad_input(tmp_path: Path) -> None:
    jsonl = tmp_path / "MNQ_rth.obs01.jsonl"
    _write_obs01_jsonl(jsonl)
    rc = main([
        "--orders", str(tmp_path / "no.csv"),
        "--jsonl", str(jsonl),
        "--output", str(tmp_path / "c.json"),
    ])
    assert rc == EXIT_BAD_INPUT


def test_cli_missing_jsonl_returns_bad_input(tmp_path: Path) -> None:
    orders = tmp_path / "orders.csv"
    _write_tradesea_csv(orders)
    rc = main([
        "--orders", str(orders),
        "--jsonl", str(tmp_path / "no.jsonl"),
        "--output", str(tmp_path / "c.json"),
    ])
    assert rc == EXIT_BAD_INPUT


def test_cli_output_exists_without_force_returns_usage(tmp_path: Path) -> None:
    orders = tmp_path / "orders.csv"
    jsonl = tmp_path / "MNQ_rth.obs01.jsonl"
    out = tmp_path / "c.json"
    _write_tradesea_csv(orders)
    _write_obs01_jsonl(jsonl)
    out.write_text("preexisting", encoding="utf-8")

    rc = main([
        "--orders", str(orders),
        "--jsonl", str(jsonl),
        "--output", str(out),
    ])
    assert rc == EXIT_USAGE
    assert "preexisting" in out.read_text(encoding="utf-8")


def test_cli_force_overwrites(tmp_path: Path) -> None:
    orders = tmp_path / "orders.csv"
    jsonl = tmp_path / "MNQ_rth.obs01.jsonl"
    out = tmp_path / "c.json"
    _write_tradesea_csv(orders)
    _write_obs01_jsonl(jsonl)
    out.write_text("preexisting", encoding="utf-8")

    rc = main([
        "--orders", str(orders),
        "--jsonl", str(jsonl),
        "--output", str(out),
        "--force",
    ])
    assert rc == EXIT_OK
    assert "preexisting" not in out.read_text(encoding="utf-8")


def test_cli_negative_window_returns_usage(tmp_path: Path) -> None:
    orders = tmp_path / "orders.csv"
    jsonl = tmp_path / "MNQ_rth.obs01.jsonl"
    _write_tradesea_csv(orders)
    _write_obs01_jsonl(jsonl)

    rc = main([
        "--orders", str(orders),
        "--jsonl", str(jsonl),
        "--output", str(tmp_path / "c.json"),
        "--regret-window-minutes", "-1",
    ])
    assert rc == EXIT_USAGE
