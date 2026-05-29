"""Tests for ``rithmic_analytics.cli.compute_vp``."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from rithmic_analytics.cli.compute_vp import (
    EXIT_BAD_INPUT,
    EXIT_OK,
    EXIT_SCHEMA_FAIL,
    main,
)
from rithmic_analytics.core.schema import validate_envelope

from .conftest import REAL_OBS01


def _write_obs01_fixture(path: Path, *, n_trades: int = 50) -> None:
    """Write a small synthetic OBS-01 JSONL the CLI can load end-to-end."""
    base_ts = 1_777_301_400_000_000_000
    records: list[dict[str, Any]] = []
    for i in range(n_trades):
        records.append(
            {
                "event_id": f"trade-cli-{i:06d}",
                "run_id": "cli-test",
                "schema_version": 1,
                "session_id": "mnq-test-rth",
                "ts_ns": str(base_ts + i * 1_000_000_000),
                "type": "TRADE",
                "payload": {
                    "aggressor_side": "buy" if i % 2 == 0 else "sell",
                    "exchange_event_ts_ns": str(base_ts + i * 1_000_000_000),
                    "sidecar_recv_ts_ns": str(base_ts + i * 1_000_000_000 + 1000),
                    "price": 27380.0 + (i % 5) * 0.25,  # 5 distinct prices, all in 1 bin
                    "quantity": 1,
                    "trade_id": f"trade-{i}",
                },
            }
        )
    with path.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


# ---------------------------------------------------------------------------
# Happy path: synthetic + real fixture
# ---------------------------------------------------------------------------


def test_cli_emits_valid_json_to_file(tmp_path: Path) -> None:
    src = tmp_path / "obs01.jsonl"
    _write_obs01_fixture(src, n_trades=50)
    out = tmp_path / "zones.json"

    rc = main(["--input", str(src), "--output", str(out), "--symbol", "MNQ"])

    assert rc == EXIT_OK
    assert out.exists()
    payload = json.loads(out.read_text(encoding="utf-8"))
    validate_envelope(payload)
    assert payload["symbol"] == "MNQ"
    assert payload["data_source"] == "rithmic"
    assert payload["bin_size_ticks"] == 20


def test_cli_stdout_when_no_output_flag(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    src = tmp_path / "obs01.jsonl"
    _write_obs01_fixture(src)

    rc = main(["--input", str(src)])

    assert rc == EXIT_OK
    captured = capsys.readouterr()
    # JSON goes to stdout, summary_line to stderr
    payload = json.loads(captured.out)
    validate_envelope(payload)
    assert "VPOC=" in captured.err  # summary_line marker


def test_cli_kwargs_pass_through(tmp_path: Path) -> None:
    src = tmp_path / "obs01.jsonl"
    _write_obs01_fixture(src, n_trades=20)
    out = tmp_path / "zones.json"

    rc = main(
        [
            "--input", str(src),
            "--output", str(out),
            "--bin-size-ticks", "40",  # 10-pt bins for MNQ
            "--va-pct", "0.80",
            "--top-n", "3",
        ]
    )

    assert rc == EXIT_OK
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["bin_size_ticks"] == 40


def test_cli_creates_output_dir(tmp_path: Path) -> None:
    src = tmp_path / "obs01.jsonl"
    _write_obs01_fixture(src)
    nested_out = tmp_path / "deep" / "nested" / "zones.json"

    rc = main(["--input", str(src), "--output", str(nested_out)])

    assert rc == EXIT_OK
    assert nested_out.exists()


@pytest.mark.skipif(not REAL_OBS01.exists(), reason="real fixture not present")
def test_cli_real_fixture_end_to_end(tmp_path: Path) -> None:
    # RA-006 primary acceptance: CLI runs on the captured OBS-01 fixture.
    out = tmp_path / "zones.json"

    rc = main(["--input", str(REAL_OBS01), "--output", str(out), "--symbol", "MNQ"])

    assert rc == EXIT_OK
    payload = json.loads(out.read_text(encoding="utf-8"))
    validate_envelope(payload)
    assert payload["bars_used"] == 104_358
    assert payload["vpoc"] is not None
    assert len(payload["zones"]) > 0


# ---------------------------------------------------------------------------
# Error paths
# ---------------------------------------------------------------------------


def test_cli_missing_input_returns_1(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    rc = main(["--input", str(tmp_path / "does_not_exist.jsonl")])

    assert rc == EXIT_BAD_INPUT
    captured = capsys.readouterr()
    assert "not found" in captured.err


def test_cli_malformed_jsonl_returns_1(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    src = tmp_path / "obs01.jsonl"
    src.write_text("{not valid json\n", encoding="utf-8")

    rc = main(["--input", str(src)])

    assert rc == EXIT_BAD_INPUT
    captured = capsys.readouterr()
    assert "failed to parse" in captured.err


def test_cli_help_includes_all_flags(capsys: pytest.CaptureFixture) -> None:
    with pytest.raises(SystemExit) as excinfo:
        main(["--help"])
    assert excinfo.value.code == 0

    captured = capsys.readouterr()
    for flag in [
        "--input",
        "--output",
        "--symbol",
        "--timeframe",
        "--bin-size-ticks",
        "--va-pct",
        "--hvn-dedup-ticks",
        "--top-n",
        "--atr-bar-size-min",
        "--atr-period",
    ]:
        assert flag in captured.out


# ---------------------------------------------------------------------------
# Exit codes are stable (other tickets / scripts may key on them)
# ---------------------------------------------------------------------------


def test_exit_codes_stable() -> None:
    assert EXIT_OK == 0
    assert EXIT_BAD_INPUT == 1
    assert EXIT_SCHEMA_FAIL == 2
