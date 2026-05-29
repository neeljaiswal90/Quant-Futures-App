from __future__ import annotations

import json
from pathlib import Path

from rithmic_dashboard.features.iceberg_detector import detect_icebergs, load_iceberg_thresholds
from rithmic_dashboard.models import MboOrderEvent, TradeTick

BASE_NS = 1_780_000_000_000_000_000


def _mbo(
    *,
    action: str,
    ts: int,
    order_id: str,
    side: str = "A",
    price: float = 30220.0,
    size: int = 30,
) -> MboOrderEvent:
    return MboOrderEvent(
        timestamp_ns=ts,
        recv_ts_ns=None,
        sequence=None,
        action="A" if action == "A" else "M" if action == "M" else "C",
        side="B" if side == "B" else "A",
        price=price,
        size=size,
        order_id=order_id,
    )


def _trade(*, ts: int, side: str = "buy", qty: int = 30, price: float = 30220.0) -> TradeTick:
    return TradeTick(
        timestamp_ns=ts,
        price=price,
        quantity=qty,
        aggressor_side="sell" if side == "sell" else "buy",
    )


def _levels() -> list[dict[str, object]]:
    return [
        {
            "level_id": "w-plus-2",
            "text": "W+2σ short zone",
            "price": 30220.0,
        }
    ]


def _ask_refill_sequence(
    *,
    quantities: list[int],
    gap_seconds: int = 5,
    trade_side: str = "buy",
) -> tuple[tuple[MboOrderEvent, ...], list[TradeTick]]:
    events: list[MboOrderEvent] = []
    trades: list[TradeTick] = []
    for idx, quantity in enumerate(quantities):
        add_ts = BASE_NS + idx * gap_seconds * 1_000_000_000
        cancel_ts = add_ts + 10_000_000
        order_id = f"ask-{idx}"
        events.append(_mbo(action="A", ts=add_ts, order_id=order_id, size=quantity))
        events.append(_mbo(action="C", ts=cancel_ts, order_id=order_id, size=quantity))
        trades.append(_trade(ts=cancel_ts + 20_000_000, side=trade_side, qty=quantity))
    return tuple(events), trades


def test_detects_obs_confirmed_ask_side_iceberg() -> None:
    events, trades = _ask_refill_sequence(quantities=[30, 25, 30, 30, 30])

    detected = detect_icebergs(mbo_events=events, trades=trades, levels=_levels())

    assert len(detected) == 1
    event = detected[0]
    assert event.side == "ask"
    assert event.direction == "short"
    assert event.level_text == "W+2σ short zone"
    assert event.refill_count == 5
    assert event.total_consumed == 145
    assert event.confidence == "high"
    assert "OBS confirmation" in event.description


def test_ignores_repeated_cancels_without_obs_consumption() -> None:
    events, _ = _ask_refill_sequence(quantities=[30, 30, 30])

    assert detect_icebergs(mbo_events=events, trades=[], levels=_levels()) == ()


def test_ignores_mixed_aggressor_confirmation() -> None:
    events, trades = _ask_refill_sequence(quantities=[30, 30, 30])
    trades = [trades[0], _trade(ts=trades[1].timestamp_ns or 0, side="sell"), trades[2]]

    assert detect_icebergs(mbo_events=events, trades=trades, levels=_levels()) == ()


def test_ignores_refills_outside_window() -> None:
    events, trades = _ask_refill_sequence(quantities=[30, 30, 30], gap_seconds=60)

    assert detect_icebergs(mbo_events=events, trades=trades, levels=_levels()) == ()


def test_loads_calibrated_thresholds(tmp_path: Path) -> None:
    path = tmp_path / "iceberg_thresholds.json"
    path.write_text(
        json.dumps(
            {
                "thresholds": {
                    "min_refills": 4,
                    "refill_window_seconds": 45,
                    "size_consistency_pct": 0.5,
                    "min_total_consumed": 75,
                    "match_tolerance_ms": 40,
                }
            }
        ),
        encoding="utf-8",
    )

    config = load_iceberg_thresholds(path)

    assert config.min_refills == 4
    assert config.refill_window_seconds == 45
    assert config.size_consistency_pct == 0.5
    assert config.min_total_consumed == 75
    assert config.match_tolerance_ms == 40
