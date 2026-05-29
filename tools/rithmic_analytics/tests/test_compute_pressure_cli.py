"""Tests for ``rithmic_analytics.cli.compute_pressure`` (RA-035)."""

from __future__ import annotations

import json
from pathlib import Path

from rithmic_analytics.cli.compute_pressure import (
    EXIT_BAD_INPUT,
    EXIT_OK,
    EXIT_USAGE,
    main,
)


def _write_mbo(path: Path, *, n_events: int = 100) -> None:
    """Write a synthetic MBO databento-flat JSONL."""
    path.parent.mkdir(parents=True, exist_ok=True)
    base_ts = 1_779_000_000_000_000_000
    lines = []
    for i in range(n_events):
        rec = {
            "ts_event_ns": str(base_ts + i * 100_000_000),
            "ts_recv_ns": str(base_ts + i * 100_000_000 + 1000),
            "sequence": str(9_000_000 + i),
            "action": "A" if i % 2 == 0 else "C",
            "side": "B" if i % 2 == 0 else "A",
            "price": 27380.0 + (i % 10) * 0.25,
            "size": 5,
            "order_id": f"o{i // 2}",
        }
        lines.append(json.dumps(rec))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_cli_happy_path(tmp_path: Path) -> None:
    mbo = tmp_path / "MNQ_rth.mbo.jsonl"
    out = tmp_path / "pressure.json"
    _write_mbo(mbo, n_events=200)

    rc = main(["--mbo", str(mbo), "--output", str(out)])

    assert rc == EXIT_OK
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert "rows" in payload
    assert "metadata" in payload
    assert payload["metadata"]["window_seconds"] == 30


def test_cli_top_n_summary_emitted(tmp_path: Path) -> None:
    mbo = tmp_path / "MNQ_rth.mbo.jsonl"
    out = tmp_path / "pressure.json"
    _write_mbo(mbo, n_events=200)

    rc = main([
        "--mbo", str(mbo),
        "--output", str(out),
        "--top-n-levels", "3",
    ])

    assert rc == EXIT_OK
    summary_path = out.with_name(out.stem + "_summary.json")
    assert summary_path.exists()
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    assert len(summary) <= 3


def test_cli_custom_window_and_spoof_args(tmp_path: Path) -> None:
    mbo = tmp_path / "MNQ_rth.mbo.jsonl"
    out = tmp_path / "pressure.json"
    _write_mbo(mbo, n_events=100)

    rc = main([
        "--mbo", str(mbo),
        "--output", str(out),
        "--window-seconds", "60",
        "--price-bin-ticks", "8",
        "--spoof-cancel-window-ms", "250",
    ])

    assert rc == EXIT_OK
    payload = json.loads(out.read_text(encoding="utf-8"))
    meta = payload["metadata"]
    assert meta["window_seconds"] == 60
    assert meta["price_bin_ticks"] == 8
    assert meta["spoof_cancel_window_ms"] == 250


def test_cli_missing_mbo_returns_bad_input(tmp_path: Path) -> None:
    rc = main([
        "--mbo", str(tmp_path / "no.jsonl"),
        "--output", str(tmp_path / "p.json"),
    ])
    assert rc == EXIT_BAD_INPUT


def test_cli_output_exists_without_force_returns_usage(tmp_path: Path) -> None:
    mbo = tmp_path / "MNQ_rth.mbo.jsonl"
    out = tmp_path / "pressure.json"
    _write_mbo(mbo)
    out.write_text("preexisting", encoding="utf-8")

    rc = main(["--mbo", str(mbo), "--output", str(out)])
    assert rc == EXIT_USAGE
    assert "preexisting" in out.read_text(encoding="utf-8")


def test_cli_force_overwrites(tmp_path: Path) -> None:
    mbo = tmp_path / "MNQ_rth.mbo.jsonl"
    out = tmp_path / "pressure.json"
    _write_mbo(mbo)
    out.write_text("preexisting", encoding="utf-8")

    rc = main(["--mbo", str(mbo), "--output", str(out), "--force"])
    assert rc == EXIT_OK
    assert "preexisting" not in out.read_text(encoding="utf-8")


def test_cli_negative_window_returns_usage(tmp_path: Path) -> None:
    mbo = tmp_path / "MNQ_rth.mbo.jsonl"
    _write_mbo(mbo)
    rc = main([
        "--mbo", str(mbo),
        "--output", str(tmp_path / "p.json"),
        "--window-seconds", "-1",
    ])
    assert rc == EXIT_USAGE


def test_cli_negative_spoof_window_returns_usage(tmp_path: Path) -> None:
    mbo = tmp_path / "MNQ_rth.mbo.jsonl"
    _write_mbo(mbo)
    rc = main([
        "--mbo", str(mbo),
        "--output", str(tmp_path / "p.json"),
        "--spoof-cancel-window-ms", "0",
    ])
    assert rc == EXIT_USAGE
