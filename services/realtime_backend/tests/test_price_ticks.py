"""Tests for backend-local latest trade tick extraction."""

from __future__ import annotations

import json
from pathlib import Path

from realtime_backend.price_ticks import latest_price_tick


def _write_jsonl(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")


def test_latest_price_tick_reads_normalized_trade_and_mbp1_context(tmp_path: Path) -> None:
    capture = tmp_path / "MNQ_rth.jsonl"
    obs01 = tmp_path / "MNQ_rth.obs01.jsonl"
    mbp1 = tmp_path / "MNQ_rth.mbp1.jsonl"
    _write_jsonl(capture, [{"stream": "L1_QUOTE", "price": 1}])
    _write_jsonl(
        obs01,
        [
            {
                "type": "TRADE",
                "ts_ns": "100",
                "payload": {
                    "exchange_event_ts_ns": "100",
                    "price": 30340.0,
                    "quantity": 2,
                },
            },
            {
                "type": "TRADE",
                "ts_ns": "200",
                "payload": {
                    "exchange_event_ts_ns": "200",
                    "price": 30341.25,
                    "quantity": 5,
                    "aggressor_side": "sell",
                },
            },
        ],
    )
    _write_jsonl(
        mbp1,
        [{"ts_event_ns": "190", "bid_px_00": 30341.0, "ask_px_00": 30341.5}],
    )

    tick = latest_price_tick(trade_source_path=obs01, capture_path=capture)

    assert tick is not None
    assert tick.trade_ts_ns == 200
    assert tick.price == 30341.25
    assert tick.volume == 5
    assert tick.aggressor_side == "sell"
    assert tick.bid == 30341.0
    assert tick.ask == 30341.5
    assert tick.dedupe_key == (200, 30341.25, 5)


def test_latest_price_tick_returns_none_without_trade(tmp_path: Path) -> None:
    capture = tmp_path / "MNQ_rth.jsonl"
    obs01 = tmp_path / "MNQ_rth.obs01.jsonl"
    _write_jsonl(capture, [{"stream": "L1_QUOTE"}])
    _write_jsonl(obs01, [{"type": "QUOTE", "ts_ns": "100"}])

    assert latest_price_tick(trade_source_path=obs01, capture_path=capture) is None


def test_latest_price_tick_ignores_raw_mbo_depth_prices(tmp_path: Path) -> None:
    capture = tmp_path / "MNQ_globex.jsonl"
    mbp1 = tmp_path / "MNQ_globex.mbp1.jsonl"
    _write_jsonl(
        capture,
        [
            {
                "stream": "LAST_TRADE",
                "exchange_event_ts_ns": "100",
                "price": 30416.75,
                "size": 2,
            },
            {
                "stream": "MBO",
                "payload_kind": "DepthByOrder",
                "exchange_event_ts_ns": "200",
                "action": "new",
                "side": "sell",
                "price": 32400.0,
                "size": 1,
            },
        ],
    )
    _write_jsonl(
        mbp1,
        [{"ts_event_ns": "190", "bid_px_00": 30416.5, "ask_px_00": 30417.0}],
    )

    tick = latest_price_tick(trade_source_path=capture, capture_path=capture)

    assert tick is not None
    assert tick.trade_ts_ns == 100
    assert tick.price == 30416.75
    assert tick.volume == 2


def test_latest_price_tick_rejects_trade_far_outside_quote_context(tmp_path: Path) -> None:
    capture = tmp_path / "MNQ_globex.jsonl"
    mbp1 = tmp_path / "MNQ_globex.mbp1.jsonl"
    _write_jsonl(
        capture,
        [
            {
                "stream": "LAST_TRADE",
                "exchange_event_ts_ns": "300",
                "price": 32400.0,
                "size": 1,
            }
        ],
    )
    _write_jsonl(
        mbp1,
        [{"ts_event_ns": "301", "bid_px_00": 30416.5, "ask_px_00": 30417.0}],
    )

    assert latest_price_tick(trade_source_path=capture, capture_path=capture) is None
