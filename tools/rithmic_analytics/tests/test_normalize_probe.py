"""Tests for ``rithmic_analytics.ops.normalize_probe`` (RA-029)."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pytest

from rithmic_analytics.core.loader import load_obs01_trades
from rithmic_analytics.ops.normalize_probe import (
    NormalizeReport,
    UnrecoverableCaptureError,
    normalize_probe_to_obs01,
    parity_record_to_obs01_dict,
    session_id_from_path,
)

# ---------------------------------------------------------------------------
# Fixture builders
# ---------------------------------------------------------------------------


def _parity_last_trade(
    *,
    exchange_event_ts_ns: str | None = "1777301422098008205",
    sidecar_recv_ts_ns: str = "1777301421596955300",
    price: float | None = 27381.25,
    size: int | None = 1,
    aggressor: str | None = "sell",
    sequence: str | None = "6875892387204",
    exchange_order_id: str | None = "6875892387204",
    raw_present: bool = False,
    symbol: str = "MNQM6",
) -> dict[str, object]:
    """Build a probe-parity LAST_TRADE record."""
    rec: dict[str, object] = {
        "schema_version": 1,
        "probe_id": "rithmic-MNQM6-1777301421",
        "symbol": symbol,
        "exchange": "CME",
        "stream": "LAST_TRADE",
        "exchange_event_ts_ns": exchange_event_ts_ns,
        "sidecar_recv_ts_ns": sidecar_recv_ts_ns,
        "template_id": 150,
        "payload_kind": "LastTrade",
        "raw_present": raw_present,
    }
    if sequence is not None:
        rec["sequence"] = sequence
    if price is not None:
        rec["price"] = price
    if size is not None:
        rec["size"] = size
    if aggressor is not None:
        rec["aggressor"] = aggressor
        rec["side"] = aggressor
    if exchange_order_id is not None:
        rec["exchange_order_id"] = exchange_order_id
    return rec


def _parity_l1_quote(*, exchange_event_ts_ns: str = "1777301422100000000") -> dict[str, object]:
    return {
        "schema_version": 1, "probe_id": "rithmic-MNQM6-1777301421",
        "symbol": "MNQM6", "exchange": "CME", "stream": "L1_QUOTE",
        "exchange_event_ts_ns": exchange_event_ts_ns,
        "sidecar_recv_ts_ns": "1777301421596955100",
        "template_id": 151, "payload_kind": "BestBidOffer",
        "raw_present": False,
        "bid_px": 27381.0, "ask_px": 27381.5,
        "bid_sz": 5, "ask_sz": 3,
    }


def _parity_mbo_non_trade(
    *,
    action: str = "new",
    exchange_event_ts_ns: str = "1777301422100000000",
) -> dict[str, object]:
    return {
        "schema_version": 1, "probe_id": "rithmic-MNQM6-1777301421",
        "symbol": "MNQM6", "exchange": "CME", "stream": "MBO",
        "exchange_event_ts_ns": exchange_event_ts_ns,
        "sidecar_recv_ts_ns": "1777301421596955100",
        "template_id": 158, "payload_kind": "OrderHistory",
        "raw_present": False,
        "action": action,
        "side": "buy", "price": 27381.0, "size": 10,
        "order_id": "999", "priority": "1",
    }


def _parity_mbo_trade(
    *,
    exchange_event_ts_ns: str = "1777301422100000000",
    price: float = 27381.25,
    size: int = 2,
    side: str = "sell",
) -> dict[str, object]:
    """Forward-compat: MBO record with action='T' (not emitted by today's probe)."""
    return {
        "schema_version": 1, "probe_id": "rithmic-MNQM6-1777301421",
        "symbol": "MNQM6", "exchange": "CME", "stream": "MBO",
        "exchange_event_ts_ns": exchange_event_ts_ns,
        "sidecar_recv_ts_ns": "1777301421596955100",
        "template_id": 158, "payload_kind": "OrderHistory",
        "raw_present": False,
        "action": "T",
        "side": side, "price": price, "size": size,
        "sequence": "999888777",
    }


def _bare_metadata_only(*, stream: str = "LAST_TRADE") -> dict[str, object]:
    """Today's 2026-05-19 metadata-only record (raw_present=false + no parity)."""
    return {
        "schema_version": 1,
        "probe_id": "rithmic-MNQM6-1779206915",
        "symbol": "MNQM6",
        "stream": stream,
        "exchange_event_ts_ns": "1779206916023916633",
        "template_id": 150,
        "payload_kind": "LastTrade",
        "raw_present": False,
        "sequence": "6876810646414",
    }


def _write_jsonl(path: Path, records: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(r) for r in records) + "\n",
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# session_id_from_path
# ---------------------------------------------------------------------------


def test_session_id_from_path_canonical_rth(tmp_path: Path) -> None:
    p = tmp_path / "data" / "captures" / "2026-05-19" / "MNQ_rth.jsonl"
    assert session_id_from_path(p) == "mnq-2026-05-19-rth"


def test_session_id_from_path_canonical_globex(tmp_path: Path) -> None:
    p = tmp_path / "captures" / "2026-05-20" / "MNQ_globex.jsonl"
    assert session_id_from_path(p) == "mnq-2026-05-20-globex"


def test_session_id_from_path_non_canonical_returns_none(tmp_path: Path) -> None:
    p = tmp_path / "random" / "file.jsonl"
    assert session_id_from_path(p) is None


def test_session_id_from_path_bad_date_returns_none(tmp_path: Path) -> None:
    p = tmp_path / "2026-13-99" / "MNQ_rth.jsonl"
    assert session_id_from_path(p) is None


# ---------------------------------------------------------------------------
# parity_record_to_obs01_dict — happy paths
# ---------------------------------------------------------------------------


def test_last_trade_record_emits_obs01_envelope() -> None:
    rec = _parity_last_trade()
    result = parity_record_to_obs01_dict(
        rec, session_id="mnq-2026-04-27-rth", run_id="run-1", counter=1,
    )
    assert isinstance(result, dict)
    assert result["type"] == "TRADE"
    assert result["session_id"] == "mnq-2026-04-27-rth"
    assert result["schema_version"] == 1
    assert result["run_id"] == "run-1"
    assert result["event_id"] == "trade-run-1-000000000001"
    assert result["ts_ns"] == "1777301422098008205"

    payload = result["payload"]
    assert isinstance(payload, dict)
    assert payload["aggressor_side"] == "sell"
    assert payload["exchange_event_ts_ns"] == "1777301422098008205"
    assert payload["sidecar_recv_ts_ns"] == "1777301421596955300"
    assert payload["price"] == 27381.25
    assert payload["quantity"] == 1
    assert payload["trade_id"] == "6875892387204"


def test_mbo_action_T_record_emits_obs01_envelope_forward_compat() -> None:
    """MBO action=T isn't in today's probe output but should normalize cleanly."""
    rec = _parity_mbo_trade()
    result = parity_record_to_obs01_dict(
        rec, session_id="mnq-2026-04-27-rth", run_id="run-1", counter=42,
    )
    assert isinstance(result, dict)
    payload = result["payload"]
    assert isinstance(payload, dict)
    assert payload["price"] == 27381.25
    assert payload["quantity"] == 2
    assert payload["aggressor_side"] == "sell"
    assert result["event_id"] == "trade-run-1-000000000042"


def test_event_id_counter_pad_to_12_digits() -> None:
    rec = _parity_last_trade()
    result = parity_record_to_obs01_dict(
        rec, session_id="mnq-2026-04-27-rth", run_id="x", counter=999_999_999,
    )
    assert isinstance(result, dict)
    assert result["event_id"] == "trade-x-000999999999"


def test_trade_id_falls_back_to_exchange_order_id_when_sequence_missing() -> None:
    rec = _parity_last_trade(sequence=None, exchange_order_id="abc-123")
    # parity_record_to_obs01_dict still requires sequence|exchange_order_id
    result = parity_record_to_obs01_dict(
        rec, session_id="x", run_id="y", counter=1,
    )
    assert isinstance(result, dict)
    payload = result["payload"]
    assert isinstance(payload, dict)
    assert payload["trade_id"] == "abc-123"


def test_unknown_aggressor_becomes_unknown_string() -> None:
    rec = _parity_last_trade(aggressor=None)
    result = parity_record_to_obs01_dict(
        rec, session_id="x", run_id="y", counter=1,
    )
    assert isinstance(result, dict)
    payload = result["payload"]
    assert isinstance(payload, dict)
    assert payload["aggressor_side"] == "unknown"


# ---------------------------------------------------------------------------
# parity_record_to_obs01_dict — skip reasons
# ---------------------------------------------------------------------------


def test_l1_quote_record_dropped_with_reason() -> None:
    rec = _parity_l1_quote()
    result = parity_record_to_obs01_dict(rec, session_id="x", run_id="y", counter=1)
    assert result == (None, "wrong_stream")


def test_mbo_non_trade_record_dropped_with_reason() -> None:
    rec = _parity_mbo_non_trade(action="new")
    result = parity_record_to_obs01_dict(rec, session_id="x", run_id="y", counter=1)
    assert result == (None, "mbo_non_trade")


def test_null_exchange_event_ts_dropped() -> None:
    rec = _parity_last_trade(exchange_event_ts_ns=None)
    result = parity_record_to_obs01_dict(rec, session_id="x", run_id="y", counter=1)
    assert result == (None, "no_timestamp")


def test_last_trade_missing_price_dropped_as_envelope_only() -> None:
    """LAST_TRADE without price is Rithmic protocol noise (net_change/volume/
    vwap updates), not a data bug. Categorized separately so analyst can
    distinguish ~30-40% expected protocol drops from genuine anomalies."""
    rec = _parity_last_trade(price=None)
    result = parity_record_to_obs01_dict(rec, session_id="x", run_id="y", counter=1)
    assert result == (None, "last_trade_no_payload")


def test_last_trade_missing_size_dropped_as_envelope_only() -> None:
    rec = _parity_last_trade(size=None)
    result = parity_record_to_obs01_dict(rec, session_id="x", run_id="y", counter=1)
    assert result == (None, "last_trade_no_payload")


def test_mbo_action_t_missing_payload_stays_missing_payload() -> None:
    """MBO action=T without price/size IS a genuine data anomaly (not
    protocol noise), so it stays in the missing_payload bucket — that's
    what the analyst should investigate if non-zero."""
    rec = _parity_mbo_trade()
    rec.pop("price")
    result = parity_record_to_obs01_dict(rec, session_id="x", run_id="y", counter=1)
    assert result == (None, "missing_payload")


def test_zero_size_dropped() -> None:
    rec = _parity_last_trade(size=0)
    result = parity_record_to_obs01_dict(rec, session_id="x", run_id="y", counter=1)
    assert result == (None, "zero_quantity")


# ---------------------------------------------------------------------------
# normalize_probe_to_obs01 — end-to-end + acceptance criteria
# ---------------------------------------------------------------------------


def test_normalize_emits_obs01_loadable_output(tmp_path: Path) -> None:
    """Round-trip: parity records → normalize → load_obs01_trades reads them."""
    in_path = tmp_path / "2026-05-19" / "MNQ_rth.jsonl"
    out_path = tmp_path / "2026-05-19" / "MNQ_rth.obs01.jsonl"
    _write_jsonl(in_path, [
        _parity_last_trade(exchange_event_ts_ns="1779000000000000001"),
        _parity_l1_quote(),  # dropped
        _parity_last_trade(exchange_event_ts_ns="1779000000000000002"),
        _parity_mbo_non_trade(),  # dropped
        _parity_last_trade(exchange_event_ts_ns="1779000000000000003"),
    ])

    report = normalize_probe_to_obs01(in_path, out_path)

    assert report.trades_emitted == 3
    assert report.skipped_wrong_stream == 1
    assert report.skipped_mbo_non_trade == 1
    assert report.session_id == "mnq-2026-05-19-rth"

    # Load with the canonical loader → must succeed
    trades = load_obs01_trades(out_path)
    assert len(trades) == 3
    assert list(trades.columns)[0] == "event_ts_ns"
    assert trades["price"].iloc[0] == 27381.25


def test_envelope_only_last_trade_counted_separately(tmp_path: Path) -> None:
    """Envelope-only LAST_TRADE records (Rithmic auxiliary updates — net_change,
    volume, vwap with no trade_price) route to skipped_last_trade_no_payload,
    NOT skipped_missing_payload. Lets analyst spot real anomalies vs protocol
    noise (which runs ~30-40% in live captures)."""
    in_path = tmp_path / "2026-05-19" / "MNQ_rth.jsonl"
    out_path = tmp_path / "2026-05-19" / "MNQ_rth.obs01.jsonl"
    _write_jsonl(in_path, [
        _parity_last_trade(exchange_event_ts_ns="1779000000000000001"),  # real trade
        _parity_last_trade(exchange_event_ts_ns="1779000000000000002", price=None),
        _parity_last_trade(exchange_event_ts_ns="1779000000000000003", size=None),
        _parity_last_trade(exchange_event_ts_ns="1779000000000000004"),  # real trade
    ])

    report = normalize_probe_to_obs01(in_path, out_path)

    assert report.trades_emitted == 2
    assert report.skipped_last_trade_no_payload == 2
    assert report.skipped_missing_payload == 0  # critical: not lumped together
    assert "skipped_last_trade_no_payload" in report.to_dict()


def test_normalize_trade_count_matches_inputs_within_zero(tmp_path: Path) -> None:
    """Acceptance: emitted trade count = LAST_TRADE + MBO-action=T inputs."""
    in_path = tmp_path / "2026-05-19" / "MNQ_rth.jsonl"
    out_path = tmp_path / "2026-05-19" / "MNQ_rth.obs01.jsonl"
    records: list[dict[str, object]] = []
    for i in range(5):
        records.append(_parity_last_trade(
            exchange_event_ts_ns=f"177900000000000000{i}",
        ))
    for i in range(3):
        records.append(_parity_mbo_trade(
            exchange_event_ts_ns=f"17790000000000010{i:02d}",
        ))
    # Plus 7 noise records that should be dropped
    for i in range(7):
        records.append(_parity_l1_quote(
            exchange_event_ts_ns=f"17790000000000020{i:02d}",
        ))
    _write_jsonl(in_path, records)

    report = normalize_probe_to_obs01(in_path, out_path)

    assert report.trades_emitted == 5 + 3  # exactly ±0
    assert report.skipped_wrong_stream == 7


def test_normalize_refuses_to_overwrite_without_force(tmp_path: Path) -> None:
    in_path = tmp_path / "2026-05-19" / "MNQ_rth.jsonl"
    out_path = tmp_path / "2026-05-19" / "MNQ_rth.obs01.jsonl"
    _write_jsonl(in_path, [_parity_last_trade()])
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("existing\n", encoding="utf-8")

    with pytest.raises(FileExistsError):
        normalize_probe_to_obs01(in_path, out_path)


def test_normalize_overwrites_with_force(tmp_path: Path) -> None:
    in_path = tmp_path / "2026-05-19" / "MNQ_rth.jsonl"
    out_path = tmp_path / "2026-05-19" / "MNQ_rth.obs01.jsonl"
    _write_jsonl(in_path, [_parity_last_trade()])
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("existing\n", encoding="utf-8")

    normalize_probe_to_obs01(in_path, out_path, overwrite=True)
    content = out_path.read_text(encoding="utf-8")
    assert "TRADE" in content
    assert "existing" not in content


def test_normalize_unrecoverable_capture_raises_clear_error(tmp_path: Path) -> None:
    """Acceptance: today's 2026-05-19 metadata-only file is detected, not silent."""
    in_path = tmp_path / "2026-05-19" / "MNQ_rth.jsonl"
    out_path = tmp_path / "2026-05-19" / "MNQ_rth.obs01.jsonl"
    _write_jsonl(in_path, [_bare_metadata_only() for _ in range(50)])

    with pytest.raises(UnrecoverableCaptureError, match="raw_present"):
        normalize_probe_to_obs01(in_path, out_path)

    # Output must NOT have been created
    assert not out_path.exists()


def test_normalize_mixed_capture_with_at_least_one_parity_record_is_recoverable(
    tmp_path: Path,
) -> None:
    """If the first N records show *any* parity field, we proceed."""
    in_path = tmp_path / "2026-05-19" / "MNQ_rth.jsonl"
    out_path = tmp_path / "2026-05-19" / "MNQ_rth.obs01.jsonl"
    records: list[dict[str, object]] = [_bare_metadata_only() for _ in range(50)]
    records.append(_parity_last_trade())  # one good record
    _write_jsonl(in_path, records)

    report = normalize_probe_to_obs01(in_path, out_path)
    assert report.trades_emitted == 1


def test_normalize_missing_input_raises_file_not_found(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        normalize_probe_to_obs01(
            tmp_path / "nope.jsonl",
            tmp_path / "out.jsonl",
        )


def test_normalize_explicit_session_id_overrides_path_derivation(tmp_path: Path) -> None:
    in_path = tmp_path / "random" / "weird.jsonl"
    out_path = tmp_path / "out.jsonl"
    _write_jsonl(in_path, [_parity_last_trade()])

    report = normalize_probe_to_obs01(
        in_path, out_path, session_id="custom-session",
    )

    assert report.session_id == "custom-session"
    first = json.loads(out_path.read_text(encoding="utf-8").splitlines()[0])
    assert first["session_id"] == "custom-session"


def test_normalize_raises_when_session_id_not_derivable(tmp_path: Path) -> None:
    in_path = tmp_path / "weird" / "file.jsonl"
    out_path = tmp_path / "out.jsonl"
    _write_jsonl(in_path, [_parity_last_trade()])

    with pytest.raises(ValueError, match="cannot derive session_id"):
        normalize_probe_to_obs01(in_path, out_path)


def test_normalize_handles_blank_lines_and_decode_errors(tmp_path: Path) -> None:
    in_path = tmp_path / "2026-05-19" / "MNQ_rth.jsonl"
    out_path = tmp_path / "2026-05-19" / "MNQ_rth.obs01.jsonl"
    # Mix valid records with blank lines and one malformed line
    parity = json.dumps(_parity_last_trade())
    in_path.parent.mkdir(parents=True, exist_ok=True)
    in_path.write_text(
        parity + "\n\n" + "not-valid-json\n" + parity + "\n",
        encoding="utf-8",
    )

    report = normalize_probe_to_obs01(in_path, out_path)
    assert report.trades_emitted == 2
    assert report.skipped_decode_error == 1


def test_normalize_run_id_defaults_from_session_id(tmp_path: Path) -> None:
    in_path = tmp_path / "2026-05-19" / "MNQ_rth.jsonl"
    out_path = tmp_path / "2026-05-19" / "MNQ_rth.obs01.jsonl"
    _write_jsonl(in_path, [_parity_last_trade()])

    report = normalize_probe_to_obs01(in_path, out_path)
    assert report.run_id == "normalize-mnq-2026-05-19-rth"


def test_normalize_creates_output_parent_dir(tmp_path: Path) -> None:
    in_path = tmp_path / "2026-05-19" / "MNQ_rth.jsonl"
    out_path = tmp_path / "deep" / "nested" / "path" / "out.obs01.jsonl"
    _write_jsonl(in_path, [_parity_last_trade()])

    normalize_probe_to_obs01(in_path, out_path, session_id="x")
    assert out_path.exists()


# ---------------------------------------------------------------------------
# NormalizeReport
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# RA-030: L1_QUOTE → MBP1 routing
# ---------------------------------------------------------------------------


def _parity_l1quote_full(
    *,
    exchange_event_ts_ns: str | None = "1777301422100000000",
    sidecar_recv_ts_ns: str = "1777301421596955100",
    bid_px: float | None = 27381.0,
    bid_sz: int | None = 5,
    bid_orders: int | None = 2,
    ask_px: float | None = 27381.5,
    ask_sz: int | None = 3,
    ask_orders: int | None = 1,
) -> dict[str, object]:
    rec: dict[str, object] = {
        "schema_version": 1, "stream": "L1_QUOTE",
        "exchange_event_ts_ns": exchange_event_ts_ns,
        "sidecar_recv_ts_ns": sidecar_recv_ts_ns,
        "template_id": 151, "payload_kind": "BestBidOffer",
        "raw_present": False,
    }
    if bid_px is not None:
        rec["bid_px"] = bid_px
    if bid_sz is not None:
        rec["bid_sz"] = bid_sz
    if bid_orders is not None:
        rec["bid_orders"] = bid_orders
    if ask_px is not None:
        rec["ask_px"] = ask_px
    if ask_sz is not None:
        rec["ask_sz"] = ask_sz
    if ask_orders is not None:
        rec["ask_orders"] = ask_orders
    return rec


def test_l1quote_to_mbp1_field_rename_correct() -> None:
    from rithmic_analytics.ops.normalize_probe import parity_l1quote_record_to_mbp1_dict
    rec = _parity_l1quote_full()
    result = parity_l1quote_record_to_mbp1_dict(rec)
    assert isinstance(result, dict)
    assert result == {
        "ts_event_ns": "1777301422100000000",
        "ts_recv_ns": "1777301421596955100",
        "bid_px_00": 27381.0,
        "bid_sz_00": 5,
        "bid_ct_00": 2,
        "ask_px_00": 27381.5,
        "ask_sz_00": 3,
        "ask_ct_00": 1,
    }


def test_l1quote_ns_precision_preserved_as_string() -> None:
    """int64-precision ts must round-trip exactly as a string (no float drift)."""
    from rithmic_analytics.ops.normalize_probe import parity_l1quote_record_to_mbp1_dict
    rec = _parity_l1quote_full(exchange_event_ts_ns="9223372036854775000")
    result = parity_l1quote_record_to_mbp1_dict(rec)
    assert isinstance(result, dict)
    assert result["ts_event_ns"] == "9223372036854775000"


def test_l1quote_wrong_stream_dropped() -> None:
    from rithmic_analytics.ops.normalize_probe import parity_l1quote_record_to_mbp1_dict
    rec = _parity_last_trade()
    assert parity_l1quote_record_to_mbp1_dict(rec) == (None, "wrong_stream")


def test_l1quote_null_timestamp_dropped() -> None:
    from rithmic_analytics.ops.normalize_probe import parity_l1quote_record_to_mbp1_dict
    rec = _parity_l1quote_full(exchange_event_ts_ns=None)
    assert parity_l1quote_record_to_mbp1_dict(rec) == (None, "no_timestamp")


def test_l1quote_missing_both_sides_dropped() -> None:
    from rithmic_analytics.ops.normalize_probe import parity_l1quote_record_to_mbp1_dict
    rec = _parity_l1quote_full(bid_px=None, ask_px=None)
    assert parity_l1quote_record_to_mbp1_dict(rec) == (None, "missing_quote")


def test_l1quote_one_sided_bid_only_emits_with_ask_zero() -> None:
    """Ask-side empty (pre-open / halt): emit with ask_px/sz/ct = 0."""
    from rithmic_analytics.ops.normalize_probe import parity_l1quote_record_to_mbp1_dict
    rec = _parity_l1quote_full(ask_px=None, ask_sz=None, ask_orders=None)
    result = parity_l1quote_record_to_mbp1_dict(rec)
    assert isinstance(result, dict)
    assert result["bid_px_00"] == 27381.0
    assert result["ask_px_00"] == 0.0
    assert result["ask_sz_00"] == 0
    assert result["ask_ct_00"] == 0


def test_l1quote_one_sided_ask_only_emits_with_bid_zero() -> None:
    from rithmic_analytics.ops.normalize_probe import parity_l1quote_record_to_mbp1_dict
    rec = _parity_l1quote_full(bid_px=None, bid_sz=None, bid_orders=None)
    result = parity_l1quote_record_to_mbp1_dict(rec)
    assert isinstance(result, dict)
    assert result["bid_px_00"] == 0.0
    assert result["ask_px_00"] == 27381.5


def test_l1quote_missing_orders_defaults_to_zero() -> None:
    """bid_orders/ask_orders absent → bid_ct_00/ask_ct_00 = 0 (defensive)."""
    from rithmic_analytics.ops.normalize_probe import parity_l1quote_record_to_mbp1_dict
    rec = _parity_l1quote_full(bid_orders=None, ask_orders=None)
    result = parity_l1quote_record_to_mbp1_dict(rec)
    assert isinstance(result, dict)
    assert result["bid_ct_00"] == 0
    assert result["ask_ct_00"] == 0


# ---------------------------------------------------------------------------
# Whole-file normalize with MBP1 sibling
# ---------------------------------------------------------------------------


def test_normalize_with_mbp1_out_routes_l1quote_to_sibling(tmp_path: Path) -> None:
    """L1_QUOTE records route to MBP1 path; counted in mbp1_records_emitted."""
    in_path = tmp_path / "2026-05-19" / "MNQ_rth.jsonl"
    obs01_out = tmp_path / "2026-05-19" / "MNQ_rth.obs01.jsonl"
    mbp1_out = tmp_path / "2026-05-19" / "MNQ_rth.mbp1.jsonl"
    _write_jsonl(in_path, [
        _parity_last_trade(exchange_event_ts_ns="1779000000000000001"),
        _parity_l1quote_full(exchange_event_ts_ns="1779000000000000002"),
        _parity_l1quote_full(exchange_event_ts_ns="1779000000000000003"),
        _parity_last_trade(exchange_event_ts_ns="1779000000000000004"),
    ])

    report = normalize_probe_to_obs01(
        in_path, obs01_out, mbp1_out_path=mbp1_out,
    )

    assert report.trades_emitted == 2
    assert report.mbp1_records_emitted == 2
    # L1_QUOTE no longer counts as wrong_stream when MBP1 output is enabled
    assert report.skipped_wrong_stream == 0
    assert obs01_out.exists()
    assert mbp1_out.exists()

    # MBP1 file is consumable by load_mbp1
    from rithmic_analytics.core.loader import load_mbp1
    mbp1_df = load_mbp1(mbp1_out)
    assert len(mbp1_df) == 2
    assert "bid_px_00" in mbp1_df.columns
    assert "ask_px_00" in mbp1_df.columns


def test_normalize_without_mbp1_out_legacy_drops_l1quote(tmp_path: Path) -> None:
    """Without mbp1_out_path, L1_QUOTE counts as wrong_stream (legacy behavior)."""
    in_path = tmp_path / "2026-05-19" / "MNQ_rth.jsonl"
    obs01_out = tmp_path / "2026-05-19" / "MNQ_rth.obs01.jsonl"
    _write_jsonl(in_path, [
        _parity_last_trade(exchange_event_ts_ns="1779000000000000001"),
        _parity_l1quote_full(exchange_event_ts_ns="1779000000000000002"),
    ])

    report = normalize_probe_to_obs01(in_path, obs01_out)

    assert report.trades_emitted == 1
    assert report.mbp1_records_emitted == 0
    assert report.skipped_wrong_stream == 1


def test_normalize_mbp1_existing_output_refused_without_force(tmp_path: Path) -> None:
    in_path = tmp_path / "2026-05-19" / "MNQ_rth.jsonl"
    obs01_out = tmp_path / "2026-05-19" / "MNQ_rth.obs01.jsonl"
    mbp1_out = tmp_path / "2026-05-19" / "MNQ_rth.mbp1.jsonl"
    _write_jsonl(in_path, [_parity_last_trade()])
    mbp1_out.parent.mkdir(parents=True, exist_ok=True)
    mbp1_out.write_text("existing\n", encoding="utf-8")

    with pytest.raises(FileExistsError, match="mbp1"):
        normalize_probe_to_obs01(in_path, obs01_out, mbp1_out_path=mbp1_out)


def test_normalize_mbp1_no_timestamp_l1quote_counted_separately(tmp_path: Path) -> None:
    """Early-print L1_QUOTE (null exchange_event_ts) → counted in skipped_no_timestamp."""
    in_path = tmp_path / "2026-05-19" / "MNQ_rth.jsonl"
    obs01_out = tmp_path / "2026-05-19" / "MNQ_rth.obs01.jsonl"
    mbp1_out = tmp_path / "2026-05-19" / "MNQ_rth.mbp1.jsonl"
    _write_jsonl(in_path, [
        _parity_last_trade(),  # so the recoverability check passes
        _parity_l1quote_full(exchange_event_ts_ns=None),
        _parity_l1quote_full(exchange_event_ts_ns="1779000000000000003"),
    ])

    report = normalize_probe_to_obs01(in_path, obs01_out, mbp1_out_path=mbp1_out)

    assert report.mbp1_records_emitted == 1
    assert report.skipped_no_timestamp == 1


def test_normalize_mbp1_missing_quote_counted_separately(tmp_path: Path) -> None:
    """L1_QUOTE with no bid AND no ask → skipped_l1quote_missing_quote."""
    in_path = tmp_path / "2026-05-19" / "MNQ_rth.jsonl"
    obs01_out = tmp_path / "2026-05-19" / "MNQ_rth.obs01.jsonl"
    mbp1_out = tmp_path / "2026-05-19" / "MNQ_rth.mbp1.jsonl"
    _write_jsonl(in_path, [
        _parity_last_trade(),
        _parity_l1quote_full(bid_px=None, ask_px=None),
    ])

    report = normalize_probe_to_obs01(in_path, obs01_out, mbp1_out_path=mbp1_out)

    assert report.mbp1_records_emitted == 0
    assert report.skipped_l1quote_missing_quote == 1


# ---------------------------------------------------------------------------
# RA-035: MBO → databento-flat MBO routing
# ---------------------------------------------------------------------------


def _parity_mbo_record(
    *,
    exchange_event_ts_ns: str | None = "1779000000000000001",
    sidecar_recv_ts_ns: str = "1779000000000000000",
    sequence: str | None = "9000001",
    action: str | None = "new",   # parity enum: new/change/delete
    side: str | None = "buy",     # parity enum: buy/sell
    price: float | None = 27381.25,
    size: int | None = 10,
    order_id: str | None = "order-42",
    orders: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    """Build a probe-parity MBO record. Top-level fields hoisted from first order."""
    rec: dict[str, object] = {
        "schema_version": 1, "stream": "MBO",
        "probe_id": "rithmic-MNQM6-1779000000",
        "symbol": "MNQM6", "exchange": "CME",
        "exchange_event_ts_ns": exchange_event_ts_ns,
        "sidecar_recv_ts_ns": sidecar_recv_ts_ns,
        "template_id": 158, "payload_kind": "OrderHistory",
        "raw_present": False,
    }
    if sequence is not None:
        rec["sequence"] = sequence
    if action is not None:
        rec["action"] = action
    if side is not None:
        rec["side"] = side
    if price is not None:
        rec["price"] = price
    if size is not None:
        rec["size"] = size
    if order_id is not None:
        rec["order_id"] = order_id
    if orders is not None:
        rec["orders"] = orders
    return rec


def test_mbo_record_translates_action_and_side() -> None:
    from rithmic_analytics.ops.normalize_probe import parity_mbo_record_to_mbo_dicts
    rec = _parity_mbo_record(action="new", side="buy")
    result = parity_mbo_record_to_mbo_dicts(rec)
    assert isinstance(result, list)
    assert len(result) == 1
    row = result[0]
    assert row["action"] == "A"      # new → A
    assert row["side"] == "B"        # buy → B
    assert row["price"] == 27381.25
    assert row["size"] == 10
    assert row["order_id"] == "order-42"
    assert row["sequence"] == "9000001"


def test_mbo_action_change_translates_to_M() -> None:
    from rithmic_analytics.ops.normalize_probe import parity_mbo_record_to_mbo_dicts
    rec = _parity_mbo_record(action="change")
    result = parity_mbo_record_to_mbo_dicts(rec)
    assert isinstance(result, list)
    assert result[0]["action"] == "M"


def test_mbo_action_delete_translates_to_C() -> None:
    from rithmic_analytics.ops.normalize_probe import parity_mbo_record_to_mbo_dicts
    rec = _parity_mbo_record(action="delete")
    result = parity_mbo_record_to_mbo_dicts(rec)
    assert isinstance(result, list)
    assert result[0]["action"] == "C"


def test_mbo_side_sell_translates_to_A() -> None:
    from rithmic_analytics.ops.normalize_probe import parity_mbo_record_to_mbo_dicts
    rec = _parity_mbo_record(side="sell")
    result = parity_mbo_record_to_mbo_dicts(rec)
    assert isinstance(result, list)
    assert result[0]["side"] == "A"  # sell → A (ask side)


def test_mbo_wrong_stream_dropped() -> None:
    from rithmic_analytics.ops.normalize_probe import parity_mbo_record_to_mbo_dicts
    rec = _parity_last_trade()
    assert parity_mbo_record_to_mbo_dicts(rec) == (None, "wrong_stream")


def test_mbo_null_timestamp_dropped() -> None:
    from rithmic_analytics.ops.normalize_probe import parity_mbo_record_to_mbo_dicts
    rec = _parity_mbo_record(exchange_event_ts_ns=None)
    assert parity_mbo_record_to_mbo_dicts(rec) == (None, "no_timestamp")


def test_mbo_missing_sequence_dropped() -> None:
    """sequence is required — load_mbo's int64 cast would fail without it."""
    from rithmic_analytics.ops.normalize_probe import parity_mbo_record_to_mbo_dicts
    rec = _parity_mbo_record(sequence=None)
    assert parity_mbo_record_to_mbo_dicts(rec) == (None, "no_sequence")


def test_mbo_unknown_action_dropped() -> None:
    from rithmic_analytics.ops.normalize_probe import parity_mbo_record_to_mbo_dicts
    rec = _parity_mbo_record(action="warp_speed")  # unknown
    assert parity_mbo_record_to_mbo_dicts(rec) == (None, "unknown_action")


def test_mbo_unknown_side_dropped() -> None:
    from rithmic_analytics.ops.normalize_probe import parity_mbo_record_to_mbo_dicts
    rec = _parity_mbo_record(side="diagonal")
    assert parity_mbo_record_to_mbo_dicts(rec) == (None, "unknown_side")


def test_mbo_null_price_emits_nan_not_drop() -> None:
    """MBO permits NaN price per Rithmic spec — preserve as float('nan')."""
    import math

    from rithmic_analytics.ops.normalize_probe import parity_mbo_record_to_mbo_dicts
    rec = _parity_mbo_record(price=None)
    result = parity_mbo_record_to_mbo_dicts(rec)
    assert isinstance(result, list)
    assert math.isnan(result[0]["price"])


def test_mbo_batch_orders_emits_one_row_per_order() -> None:
    """A parity record with orders=[...] of length N emits N rows."""
    from rithmic_analytics.ops.normalize_probe import parity_mbo_record_to_mbo_dicts
    rec = _parity_mbo_record(orders=[
        {"action": "new", "side": "buy", "price": 27380.0, "size": 5, "order_id": "o1"},
        {"action": "change", "side": "buy", "price": 27380.0, "size": 7, "order_id": "o1"},
        {"action": "delete", "side": "sell", "price": 27385.0, "size": 3, "order_id": "o2"},
    ])
    result = parity_mbo_record_to_mbo_dicts(rec)
    assert isinstance(result, list)
    assert len(result) == 3
    assert [r["action"] for r in result] == ["A", "M", "C"]
    assert [r["side"] for r in result] == ["B", "B", "A"]


def test_mbo_databento_passthrough_for_forward_compat() -> None:
    """If a future probe directly emits A/M/C/F/T, just pass through."""
    from rithmic_analytics.ops.normalize_probe import parity_mbo_record_to_mbo_dicts
    rec = _parity_mbo_record(action="F", side="A")
    result = parity_mbo_record_to_mbo_dicts(rec)
    assert isinstance(result, list)
    assert result[0]["action"] == "F"
    assert result[0]["side"] == "A"


# ---------------------------------------------------------------------------
# RA-065: priority through-flow (depth_order_priority → normalized MBO row)
# ---------------------------------------------------------------------------


def test_ra065_priority_carried_from_orders_array() -> None:
    """Priority on a nested order surfaces as a str on the normalized row."""
    from rithmic_analytics.ops.normalize_probe import parity_mbo_record_to_mbo_dicts
    rec = _parity_mbo_record(orders=[
        {"action": "new", "side": "buy", "price": 27380.0, "size": 5,
         "order_id": "o1", "priority": "104910029979"},
        {"action": "delete", "side": "sell", "price": 27385.0, "size": 3,
         "order_id": "o2", "priority": "104910029983"},
    ])
    result = parity_mbo_record_to_mbo_dicts(rec)
    assert isinstance(result, list)
    assert result[0]["priority"] == "104910029979"
    assert result[1]["priority"] == "104910029983"


def test_ra065_priority_carried_from_hoisted_top_level_fields() -> None:
    """The single-order hoisted fallback also carries priority."""
    from rithmic_analytics.ops.normalize_probe import parity_mbo_record_to_mbo_dicts
    rec = _parity_mbo_record()  # hoisted single order, no orders[]
    rec["priority"] = "777"
    result = parity_mbo_record_to_mbo_dicts(rec)
    assert isinstance(result, list)
    assert len(result) == 1
    assert result[0]["priority"] == "777"


def test_ra065_priority_coerced_to_string() -> None:
    """A numeric priority is normalized to str (probe emits str, but be defensive)."""
    from rithmic_analytics.ops.normalize_probe import parity_mbo_record_to_mbo_dicts
    rec = _parity_mbo_record(orders=[
        {"action": "new", "side": "buy", "price": 27380.0, "size": 5,
         "order_id": "o1", "priority": 104910029979},
    ])
    result = parity_mbo_record_to_mbo_dicts(rec)
    assert isinstance(result, list)
    assert result[0]["priority"] == "104910029979"


def test_ra065_priority_absent_byte_exact_backward_compat() -> None:
    """BYTE-EXACT GATE (normalize side): when priority is absent on input, the
    normalized row equals the pre-RA-065 8-key dict plus exactly one additive
    key ``priority=None`` — every other field byte-identical."""
    from rithmic_analytics.ops.normalize_probe import parity_mbo_record_to_mbo_dicts
    rec = _parity_mbo_record(action="new", side="buy")  # no priority field
    result = parity_mbo_record_to_mbo_dicts(rec)
    assert isinstance(result, list)
    assert result[0] == {
        # the exact pre-RA-065 dict literal ...
        "ts_event_ns": "1779000000000000001",
        "ts_recv_ns": "1779000000000000000",
        "sequence": "9000001",
        "action": "A",
        "side": "B",
        "price": 27381.25,
        "size": 10,
        "order_id": "order-42",
        # ... plus the single additive key, defaulting to None.
        "priority": None,
    }


# ---------------------------------------------------------------------------
# Whole-file MBO routing
# ---------------------------------------------------------------------------


def test_normalize_with_mbo_out_routes_mbo_to_sibling(tmp_path: Path) -> None:
    in_path = tmp_path / "2026-05-21" / "MNQ_globex.jsonl"
    obs01_out = tmp_path / "2026-05-21" / "MNQ_globex.obs01.jsonl"
    mbo_out = tmp_path / "2026-05-21" / "MNQ_globex.mbo.jsonl"
    _write_jsonl(in_path, [
        _parity_last_trade(exchange_event_ts_ns="1779000000000000001"),
        _parity_mbo_record(exchange_event_ts_ns="1779000000000000002", action="new"),
        _parity_mbo_record(exchange_event_ts_ns="1779000000000000003", action="delete"),
        _parity_last_trade(exchange_event_ts_ns="1779000000000000004"),
    ])

    report = normalize_probe_to_obs01(in_path, obs01_out, mbo_out_path=mbo_out)

    assert report.trades_emitted == 2
    assert report.mbo_records_emitted == 2
    # MBO non-trade no longer counts as skipped_mbo_non_trade when MBO out is enabled
    assert report.skipped_mbo_non_trade == 0
    assert mbo_out.exists()

    # The output is consumable by load_mbo
    from rithmic_analytics.core.loader import load_mbo
    mbo_df = load_mbo(mbo_out)
    assert len(mbo_df) == 2
    assert set(mbo_df["action"].unique()) == {"A", "C"}


def test_normalize_without_mbo_out_legacy_drops_mbo(tmp_path: Path) -> None:
    """Without mbo_out_path, MBO non-trade records count as mbo_non_trade
    (existing pre-RA-035 behavior unchanged)."""
    in_path = tmp_path / "2026-05-21" / "MNQ_globex.jsonl"
    obs01_out = tmp_path / "2026-05-21" / "MNQ_globex.obs01.jsonl"
    _write_jsonl(in_path, [
        _parity_last_trade(exchange_event_ts_ns="1779000000000000001"),
        _parity_mbo_record(exchange_event_ts_ns="1779000000000000002", action="new"),
    ])

    report = normalize_probe_to_obs01(in_path, obs01_out)

    assert report.trades_emitted == 1
    assert report.mbo_records_emitted == 0
    assert report.skipped_mbo_non_trade == 1


def test_normalize_with_all_three_siblings(tmp_path: Path) -> None:
    """The full trio: OBS-01 + MBP1 + MBO produced in one pass."""
    in_path = tmp_path / "in.jsonl"
    obs01_out = tmp_path / "out.obs01.jsonl"
    mbp1_out = tmp_path / "out.mbp1.jsonl"
    mbo_out = tmp_path / "out.mbo.jsonl"
    _write_jsonl(in_path, [
        _parity_last_trade(exchange_event_ts_ns="1779000000000000001"),
        _parity_l1quote_full(exchange_event_ts_ns="1779000000000000002"),
        _parity_mbo_record(exchange_event_ts_ns="1779000000000000003", action="new"),
        _parity_mbo_record(exchange_event_ts_ns="1779000000000000004", action="delete"),
    ])

    report = normalize_probe_to_obs01(
        in_path, obs01_out,
        mbp1_out_path=mbp1_out, mbo_out_path=mbo_out,
        session_id="mnq-2026-05-21-globex",
    )

    assert report.trades_emitted == 1
    assert report.mbp1_records_emitted == 1
    assert report.mbo_records_emitted == 2

    # All three siblings consumable by their respective loaders
    from rithmic_analytics.core.loader import load_mbo, load_mbp1, load_obs01_trades
    assert len(load_obs01_trades(obs01_out)) == 1
    assert len(load_mbp1(mbp1_out)) == 1
    assert len(load_mbo(mbo_out)) == 2


def test_normalize_mbo_existing_output_refused_without_force(tmp_path: Path) -> None:
    in_path = tmp_path / "in.jsonl"
    obs01_out = tmp_path / "out.obs01.jsonl"
    mbo_out = tmp_path / "out.mbo.jsonl"
    _write_jsonl(in_path, [_parity_last_trade()])
    mbo_out.parent.mkdir(parents=True, exist_ok=True)
    mbo_out.write_text("existing\n", encoding="utf-8")

    with pytest.raises(FileExistsError, match="mbo"):
        normalize_probe_to_obs01(in_path, obs01_out, mbo_out_path=mbo_out)


def test_normalize_mbo_action_T_stays_on_obs01_path(tmp_path: Path) -> None:
    """MBO action=T is forward-compat: stays on OBS-01 even with mbo_out enabled.
    Pressure detector doesn't want trade events; sweep_detection reads MBO trades
    from MBO stream's own loader independently."""
    in_path = tmp_path / "in.jsonl"
    obs01_out = tmp_path / "out.obs01.jsonl"
    mbo_out = tmp_path / "out.mbo.jsonl"
    _write_jsonl(in_path, [
        _parity_last_trade(),  # ensure recoverable check passes
        _parity_mbo_trade(exchange_event_ts_ns="1779000000000000002"),
    ])

    report = normalize_probe_to_obs01(
        in_path, obs01_out, mbo_out_path=mbo_out,
        session_id="mnq-2026-05-21-globex",
    )

    # MBO action=T produced an OBS-01 trade, not an MBO row
    assert report.trades_emitted == 2  # the LAST_TRADE + the MBO action=T
    assert report.mbo_records_emitted == 0


def test_normalize_report_to_dict_serialisable() -> None:
    r = NormalizeReport(
        records_read=10, trades_emitted=5, skipped_wrong_stream=3,
        skipped_mbo_non_trade=2,
        session_id="mnq-2026-05-19-rth", run_id="run-x",
    )
    d = r.to_dict()
    assert d["trades_emitted"] == 5
    s = json.dumps(d)
    assert "mnq-2026-05-19-rth" in s


# ---------------------------------------------------------------------------
# RA-041: L1_QUOTE forward-fill (delta → snapshot conversion)
# ---------------------------------------------------------------------------


def _write_parity_jsonl(path: Path, records: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec) + "\n")


def test_ra041_forward_fill_bid_only_then_ask_only_then_bid_only(tmp_path: Path) -> None:
    """[bid-only, ask-only, bid-only] sequence:
    - rec 1 carries bid only → ask emitted as null (no prior state).
    - rec 2 carries ask only → bid forward-filled from rec 1.
    - rec 3 carries bid only → ask forward-filled from rec 2.
    """
    in_path = tmp_path / "2026-05-21" / "MNQ_rth.jsonl"
    obs01_out = tmp_path / "2026-05-21" / "MNQ_rth.obs01.jsonl"
    mbp1_out = tmp_path / "2026-05-21" / "MNQ_rth.mbp1.jsonl"

    # Sentinel LAST_TRADE first so the recoverability check passes (it samples
    # the first 100 records looking for any with parity fields).
    records = [
        _parity_last_trade(),
        _parity_l1quote_full(
            exchange_event_ts_ns="1000",
            bid_px=27381.25, bid_sz=5, bid_orders=2,
            ask_px=None, ask_sz=None, ask_orders=None,
        ),
        _parity_l1quote_full(
            exchange_event_ts_ns="2000",
            bid_px=None, bid_sz=None, bid_orders=None,
            ask_px=27381.50, ask_sz=3, ask_orders=1,
        ),
        _parity_l1quote_full(
            exchange_event_ts_ns="3000",
            bid_px=27381.00, bid_sz=4, bid_orders=2,
            ask_px=None, ask_sz=None, ask_orders=None,
        ),
    ]
    _write_parity_jsonl(in_path, records)

    report = normalize_probe_to_obs01(in_path, obs01_out, mbp1_out_path=mbp1_out)

    rows = [json.loads(line) for line in mbp1_out.read_text().splitlines()]
    assert len(rows) == 3
    # rec 1: bid present, ask edge → null
    assert rows[0]["bid_px_00"] == 27381.25
    assert rows[0]["bid_sz_00"] == 5
    assert rows[0]["ask_px_00"] is None
    assert rows[0]["ask_sz_00"] == 0
    assert rows[0]["ask_ct_00"] == 0
    # rec 2: ask fresh, bid forward-filled from rec 1
    assert rows[1]["bid_px_00"] == 27381.25
    assert rows[1]["bid_sz_00"] == 5
    assert rows[1]["bid_ct_00"] == 2
    assert rows[1]["ask_px_00"] == 27381.50
    assert rows[1]["ask_sz_00"] == 3
    # rec 3: bid fresh (updated cache), ask forward-filled from rec 2
    assert rows[2]["bid_px_00"] == 27381.00
    assert rows[2]["ask_px_00"] == 27381.50
    assert rows[2]["ask_sz_00"] == 3

    # Counters
    # rec 1 contributes +1 to first_record_one_sided (ask no-cache edge)
    # rec 2 contributes +1 to forward_filled (bid filled from cache)
    # rec 3 contributes +1 to forward_filled (ask filled from cache)
    assert report.mbp1_records_emitted == 3
    assert report.mbp1_forward_filled == 2
    assert report.mbp1_first_record_one_sided == 1


def test_ra041_first_record_one_sided_emits_json_null(tmp_path: Path) -> None:
    """First record carries only the bid → ask serializes as JSON null
    and size/ct stay at 0 so the loader's int32 cast doesn't choke."""
    in_path = tmp_path / "2026-05-21" / "MNQ_rth.jsonl"
    obs01_out = tmp_path / "2026-05-21" / "MNQ_rth.obs01.jsonl"
    mbp1_out = tmp_path / "2026-05-21" / "MNQ_rth.mbp1.jsonl"

    records = [
        _parity_last_trade(),
        _parity_l1quote_full(
            exchange_event_ts_ns="1000",
            bid_px=27381.0, bid_sz=5, bid_orders=2,
            ask_px=None, ask_sz=None, ask_orders=None,
        ),
    ]
    _write_parity_jsonl(in_path, records)

    normalize_probe_to_obs01(in_path, obs01_out, mbp1_out_path=mbp1_out)

    # Inspect the raw JSON to confirm `null` (not `0.0`).
    raw_line = mbp1_out.read_text().splitlines()[0]
    parsed = json.loads(raw_line)
    assert parsed["ask_px_00"] is None
    assert parsed["ask_sz_00"] == 0
    assert parsed["ask_ct_00"] == 0
    # Now via the loader: NaN price, int32 sz/ct.
    from rithmic_analytics.core.loader import load_mbp1
    df = load_mbp1(mbp1_out)
    assert pd.isna(df.iloc[0]["ask_px_00"])
    assert df.iloc[0]["ask_sz_00"] == 0
    # Spread filter (RA-040) must treat this as one-sided.
    assert pd.isna(df.iloc[0]["spread_ticks"])
    assert not df.iloc[0]["is_crossed"]


def test_ra041_forward_fill_unconditional_across_gaps(tmp_path: Path) -> None:
    """No reconnect-aware reset: even a 30-min gap preserves cache state.
    (Q-RA041-3 (a): stale cache preferred over NaN.)"""
    in_path = tmp_path / "2026-05-21" / "MNQ_rth.jsonl"
    obs01_out = tmp_path / "2026-05-21" / "MNQ_rth.obs01.jsonl"
    mbp1_out = tmp_path / "2026-05-21" / "MNQ_rth.mbp1.jsonl"

    # Two records 30 minutes (1.8e12 ns) apart; second one carries only ask.
    records = [
        _parity_last_trade(),
        _parity_l1quote_full(
            exchange_event_ts_ns="1000000000000",  # t=1000s
            bid_px=27381.25, bid_sz=5, bid_orders=2,
            ask_px=27381.50, ask_sz=3, ask_orders=1,
        ),
        _parity_l1quote_full(
            exchange_event_ts_ns="2800000000000",  # t=2800s (30min later)
            bid_px=None, bid_sz=None, bid_orders=None,
            ask_px=27382.0, ask_sz=2, ask_orders=1,
        ),
    ]
    _write_parity_jsonl(in_path, records)

    report = normalize_probe_to_obs01(in_path, obs01_out, mbp1_out_path=mbp1_out)

    rows = [json.loads(line) for line in mbp1_out.read_text().splitlines()]
    assert len(rows) == 2
    # Second row's bid forward-fills from 30 min ago — preserved.
    assert rows[1]["bid_px_00"] == 27381.25
    assert rows[1]["bid_sz_00"] == 5
    assert report.mbp1_forward_filled == 1
    assert report.mbp1_first_record_one_sided == 0


def test_ra041_existing_two_sided_records_pass_through_unchanged(tmp_path: Path) -> None:
    """Backward-compat: fully two-sided records aren't molested by the filler.
    (Verifies the existing test_l1quote_to_mbp1_field_rename_correct invariant
    survives end-to-end through the new fill step.)"""
    in_path = tmp_path / "2026-05-21" / "MNQ_rth.jsonl"
    obs01_out = tmp_path / "2026-05-21" / "MNQ_rth.obs01.jsonl"
    mbp1_out = tmp_path / "2026-05-21" / "MNQ_rth.mbp1.jsonl"

    records = [
        _parity_last_trade(),
        _parity_l1quote_full(
            exchange_event_ts_ns="1000",
            bid_px=27381.0, bid_sz=5, bid_orders=2,
            ask_px=27381.5, ask_sz=3, ask_orders=1,
        ),
    ]
    _write_parity_jsonl(in_path, records)

    report = normalize_probe_to_obs01(in_path, obs01_out, mbp1_out_path=mbp1_out)

    row = json.loads(mbp1_out.read_text().splitlines()[0])
    # Identical to the pre-RA-041 expectation.
    assert row["bid_px_00"] == 27381.0
    assert row["bid_sz_00"] == 5
    assert row["bid_ct_00"] == 2
    assert row["ask_px_00"] == 27381.5
    assert row["ask_sz_00"] == 3
    assert row["ask_ct_00"] == 1
    # No fill counted (no missing sides).
    assert report.mbp1_forward_filled == 0
    assert report.mbp1_first_record_one_sided == 0


@pytest.mark.skipif(
    not Path("data/captures/2026-05-20/MNQ_globex.jsonl").exists(),
    reason="real Globex parity capture not present",
)
def test_ra041_real_globex_yields_high_two_sided_coverage(tmp_path: Path) -> None:
    """Load-bearing acceptance gate (per RA-041 ticket): re-normalizing the
    2026-05-20 Globex parity capture must produce an MBP1 sibling where
    >95% of records have both bid_px_00 > 0 AND ask_px_00 > 0.

    Pre-RA-041 baseline (from the RA-040 diagnostic): 0.03% two-sided.
    Post-RA-041 target: >95%.
    """
    in_path = Path("data/captures/2026-05-20/MNQ_globex.jsonl")
    obs01_out = tmp_path / "MNQ_globex.obs01.jsonl"
    mbp1_out = tmp_path / "MNQ_globex.mbp1.jsonl"

    report = normalize_probe_to_obs01(
        in_path, obs01_out, mbp1_out_path=mbp1_out,
        session_id="mnq-2026-05-20-globex",
    )

    from rithmic_analytics.core.loader import load_mbp1
    df = load_mbp1(mbp1_out)

    n_two_sided = int(((df["bid_px_00"] > 0) & (df["ask_px_00"] > 0)).sum())
    coverage = n_two_sided / len(df)
    assert coverage > 0.95, (
        f"two-sided coverage {coverage:.4f} < 0.95 target "
        f"(forward_filled={report.mbp1_forward_filled}, "
        f"first_record_edge={report.mbp1_first_record_one_sided})"
    )
