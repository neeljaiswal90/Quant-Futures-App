"""Tests for ``rithmic_analytics.cli.normalize`` (RA-029)."""

from __future__ import annotations

import json
from pathlib import Path

from rithmic_analytics.cli.normalize import EXIT_BAD_INPUT, EXIT_OK, EXIT_USAGE, main


def _write_jsonl(path: Path, records: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(r) for r in records) + "\n",
        encoding="utf-8",
    )


def _parity_last_trade(*, ts: str = "1779000000000000001") -> dict[str, object]:
    return {
        "schema_version": 1, "stream": "LAST_TRADE",
        "probe_id": "rithmic-MNQM6-1779000000",
        "symbol": "MNQM6", "exchange": "CME",
        "exchange_event_ts_ns": ts,
        "sidecar_recv_ts_ns": "1779000000000000000",
        "template_id": 150, "payload_kind": "LastTrade",
        "raw_present": False,
        "sequence": "999", "price": 27381.25, "size": 1,
        "aggressor": "sell", "side": "sell",
    }


def _bare_metadata(*, stream: str = "LAST_TRADE") -> dict[str, object]:
    return {
        "schema_version": 1, "stream": stream,
        "exchange_event_ts_ns": "1779000000000000001",
        "template_id": 150, "raw_present": False,
        "sequence": "999",
    }


def test_cli_normalizes_parity_capture_to_obs01(tmp_path: Path) -> None:
    """Acceptance: CLI against parity capture produces loader-consumable output."""
    in_path = tmp_path / "data" / "captures" / "2026-05-20" / "MNQ_rth.jsonl"
    out_path = tmp_path / "data" / "captures" / "2026-05-20" / "MNQ_rth.obs01.jsonl"
    _write_jsonl(in_path, [_parity_last_trade(ts=f"177900000000000000{i}") for i in range(3)])

    rc = main(["--input", str(in_path), "--output", str(out_path)])

    assert rc == EXIT_OK
    assert out_path.exists()
    # First emitted record carries the loader-required fields
    first = json.loads(out_path.read_text(encoding="utf-8").splitlines()[0])
    assert first["type"] == "TRADE"
    assert first["session_id"] == "mnq-2026-05-20-rth"
    assert first["payload"]["price"] == 27381.25


def test_cli_unrecoverable_capture_exits_non_zero_with_clear_error(tmp_path: Path) -> None:
    """Acceptance: today's 2026-05-19 metadata-only file detected, not silent."""
    in_path = tmp_path / "data" / "captures" / "2026-05-19" / "MNQ_rth.jsonl"
    out_path = tmp_path / "out.obs01.jsonl"
    _write_jsonl(in_path, [_bare_metadata() for _ in range(50)])

    rc = main(["--input", str(in_path), "--output", str(out_path)])

    assert rc == EXIT_BAD_INPUT
    # Output must not have been produced
    assert not out_path.exists()


def test_cli_missing_input_exits_bad_input(tmp_path: Path) -> None:
    rc = main([
        "--input", str(tmp_path / "no.jsonl"),
        "--output", str(tmp_path / "out.obs01.jsonl"),
    ])
    assert rc == EXIT_BAD_INPUT


def test_cli_existing_output_without_force_exits_usage(tmp_path: Path) -> None:
    in_path = tmp_path / "data" / "captures" / "2026-05-20" / "MNQ_rth.jsonl"
    out_path = tmp_path / "data" / "captures" / "2026-05-20" / "MNQ_rth.obs01.jsonl"
    _write_jsonl(in_path, [_parity_last_trade()])
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("preexisting\n", encoding="utf-8")

    rc = main(["--input", str(in_path), "--output", str(out_path)])
    assert rc == EXIT_USAGE
    # Original content preserved
    assert "preexisting" in out_path.read_text(encoding="utf-8")


def test_cli_force_overwrites_output(tmp_path: Path) -> None:
    in_path = tmp_path / "data" / "captures" / "2026-05-20" / "MNQ_rth.jsonl"
    out_path = tmp_path / "data" / "captures" / "2026-05-20" / "MNQ_rth.obs01.jsonl"
    _write_jsonl(in_path, [_parity_last_trade()])
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("preexisting\n", encoding="utf-8")

    rc = main(["--input", str(in_path), "--output", str(out_path), "--force"])
    assert rc == EXIT_OK
    assert "preexisting" not in out_path.read_text(encoding="utf-8")


def test_cli_explicit_session_id_override(tmp_path: Path) -> None:
    """Non-canonical input path → require explicit --session-id."""
    in_path = tmp_path / "weird" / "place.jsonl"
    out_path = tmp_path / "out.obs01.jsonl"
    _write_jsonl(in_path, [_parity_last_trade()])

    # Without --session-id: usage error (cannot derive)
    rc_no_id = main(["--input", str(in_path), "--output", str(out_path)])
    assert rc_no_id == EXIT_USAGE

    # With explicit ID: success
    rc_with_id = main([
        "--input", str(in_path), "--output", str(out_path),
        "--session-id", "mnq-2026-05-20-rth",
    ])
    assert rc_with_id == EXIT_OK
