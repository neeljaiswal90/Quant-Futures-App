"""RA-052 incremental normalizer tests."""

from __future__ import annotations

import json
from pathlib import Path

from rithmic_analytics.cli.normalize_probe_incremental import EXIT_OK, main, normalize_incremental
from rithmic_analytics.ops.normalize_probe import normalize_probe_to_obs01


def _write_jsonl(path: Path, records: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(rec) for rec in records) + "\n", encoding="utf-8")


def _append_jsonl(path: Path, records: list[dict[str, object]]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        for rec in records:
            handle.write(json.dumps(rec) + "\n")


def _last_trade(ts: int, *, price: float, size: int = 1) -> dict[str, object]:
    return {
        "schema_version": 1,
        "stream": "LAST_TRADE",
        "symbol": "MNQM6",
        "exchange": "CME",
        "exchange_event_ts_ns": str(ts),
        "sidecar_recv_ts_ns": str(ts + 1000),
        "template_id": 150,
        "payload_kind": "LastTrade",
        "raw_present": False,
        "sequence": str(ts),
        "price": price,
        "size": size,
        "aggressor": "buy",
        "side": "buy",
    }


def _l1_quote(
    ts: int,
    *,
    bid_px: float | None = 27380.0,
    ask_px: float | None = 27380.5,
) -> dict[str, object]:
    rec: dict[str, object] = {
        "schema_version": 1,
        "stream": "L1_QUOTE",
        "symbol": "MNQM6",
        "exchange": "CME",
        "exchange_event_ts_ns": str(ts),
        "sidecar_recv_ts_ns": str(ts + 1000),
        "template_id": 151,
        "payload_kind": "BestBidOffer",
        "raw_present": False,
        "bid_sz": 5,
        "ask_sz": 3,
        "bid_orders": 2,
        "ask_orders": 1,
    }
    if bid_px is not None:
        rec["bid_px"] = bid_px
    if ask_px is not None:
        rec["ask_px"] = ask_px
    return rec


def _mbo_add(ts: int) -> dict[str, object]:
    return {
        "schema_version": 1,
        "stream": "MBO",
        "symbol": "MNQM6",
        "exchange": "CME",
        "exchange_event_ts_ns": str(ts),
        "sidecar_recv_ts_ns": str(ts + 1000),
        "template_id": 158,
        "payload_kind": "OrderHistory",
        "raw_present": False,
        "sequence": str(ts),
        "action": "new",
        "side": "buy",
        "price": 27380.0,
        "size": 10,
        "order_id": "order-1",
    }


def test_incremental_resume_matches_full_normalize_and_writes_audit(
    tmp_path: Path,
) -> None:
    raw = tmp_path / "data" / "captures" / "2026-05-27" / "MNQ_rth.jsonl"
    obs = raw.with_name("MNQ_rth.obs01.jsonl")
    mbp1 = raw.with_name("MNQ_rth.mbp1.jsonl")
    mbo = raw.with_name("MNQ_rth.mbo.jsonl")
    audit = tmp_path / "dashboard" / "_audit.json"
    initial = [
        _last_trade(1_779_000_000_000_000_000, price=27380.25),
        _l1_quote(1_779_000_001_000_000_000),
        _mbo_add(1_779_000_002_000_000_000),
    ]
    appended = [
        _last_trade(1_779_000_003_000_000_000, price=27380.50, size=2),
        # Delta-shaped quote: ask side must be forward-filled from first run.
        _l1_quote(1_779_000_004_000_000_000, bid_px=27380.25, ask_px=None),
    ]
    _write_jsonl(raw, initial)

    first_rc = main(["--input", str(raw), "--output", str(obs), "--audit-path", str(audit)])
    _append_jsonl(raw, appended)
    second_rc = main(["--input", str(raw), "--output", str(obs), "--audit-path", str(audit)])

    full_obs = tmp_path / "full" / "MNQ_rth.obs01.jsonl"
    full_mbp1 = tmp_path / "full" / "MNQ_rth.mbp1.jsonl"
    full_mbo = tmp_path / "full" / "MNQ_rth.mbo.jsonl"
    normalize_probe_to_obs01(
        raw,
        full_obs,
        mbp1_out_path=full_mbp1,
        mbo_out_path=full_mbo,
        overwrite=True,
    )

    assert first_rc == EXIT_OK
    assert second_rc == EXIT_OK
    assert obs.read_text(encoding="utf-8") == full_obs.read_text(encoding="utf-8")
    assert mbp1.read_text(encoding="utf-8") == full_mbp1.read_text(encoding="utf-8")
    assert mbo.read_text(encoding="utf-8") == full_mbo.read_text(encoding="utf-8")

    state = json.loads(raw.with_name("MNQ_rth.obs01.normalize_state.json").read_text())
    assert state["last_byte_offset"] == raw.stat().st_size
    assert state["trades_emitted_total"] == 2

    audit_data = json.loads(audit.read_text(encoding="utf-8"))
    fallback = audit_data["entries"][-1]
    assert fallback["event_type"] == "normalize_state_missing_fallback_full"
    assert fallback["metadata"]["input_size_bytes"] > 0
    assert fallback["metadata"]["session_fallback_count"] == 1


def test_normalize_incremental_wrapper_creates_siblings_and_resumes(tmp_path: Path) -> None:
    """RA-070 library wrapper: creates obs01+mbo siblings, resumes incrementally,
    and is a no-op when the raw file has no new bytes."""
    raw = tmp_path / "data" / "captures" / "2026-05-27" / "MNQ_rth.jsonl"
    obs = raw.with_name("MNQ_rth.obs01.jsonl")
    mbo = raw.with_name("MNQ_rth.mbo.jsonl")
    _write_jsonl(
        raw,
        [
            _last_trade(1_779_000_000_000_000_000, price=27380.25),
            _l1_quote(1_779_000_001_000_000_000),
            _mbo_add(1_779_000_002_000_000_000),
        ],
    )

    state1 = normalize_incremental(input_path=raw, obs01_path=obs)
    assert obs.exists() and mbo.exists()
    assert state1.trades_emitted_total == 1
    assert state1.mbo_records_emitted_total == 1

    # Append + re-run: incremental resume advances the offset without reprocessing.
    _append_jsonl(raw, [_last_trade(1_779_000_003_000_000_000, price=27380.50, size=2)])
    state2 = normalize_incremental(input_path=raw, obs01_path=obs)
    assert state2.last_byte_offset > state1.last_byte_offset
    assert state2.trades_emitted_total == 2

    # No new bytes -> no-op, offset + totals unchanged.
    state3 = normalize_incremental(input_path=raw, obs01_path=obs)
    assert state3.last_byte_offset == state2.last_byte_offset
    assert state3.trades_emitted_total == 2


def test_corrupt_state_falls_back_full_and_records_second_session_event(
    tmp_path: Path,
) -> None:
    raw = tmp_path / "data" / "captures" / "2026-05-27" / "MNQ_rth.jsonl"
    obs = raw.with_name("MNQ_rth.obs01.jsonl")
    audit = tmp_path / "dashboard" / "_audit.json"
    _write_jsonl(raw, [_last_trade(1_779_000_000_000_000_000, price=27380.25)])
    assert main(["--input", str(raw), "--output", str(obs), "--audit-path", str(audit)]) == EXIT_OK

    raw.with_name("MNQ_rth.obs01.normalize_state.json").write_text("{bad", encoding="utf-8")
    assert main(["--input", str(raw), "--output", str(obs), "--audit-path", str(audit)]) == EXIT_OK

    audit_data = json.loads(audit.read_text(encoding="utf-8"))
    fallback_entries = [
        entry
        for entry in audit_data["entries"]
        if entry["event_type"] == "normalize_state_missing_fallback_full"
    ]
    assert len(fallback_entries) == 2
    assert fallback_entries[-1]["metadata"]["reason"] == "corrupt_state"
    assert fallback_entries[-1]["metadata"]["session_fallback_count"] == 2
