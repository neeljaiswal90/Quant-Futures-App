from __future__ import annotations

import json
from pathlib import Path

from rithmic_dashboard.features.aggressor_metrics import (
    append_footprint_bar,
    append_new_aggressor_flow_events,
    build_aggressor_events,
    build_footprint_bar,
    compute_aggressor_metrics,
    compute_v_delta,
    load_aggressor_flow_events,
)
from rithmic_dashboard.models import TradeTick


def test_windowed_aggressor_metrics_compute_lift_hit_net_and_ratio() -> None:
    ticks = [
        _tick(0, 100.0, 10, "buy"),
        _tick(240, 100.25, 4, "sell"),
        _tick(330, 100.50, 7, "buy"),
        _tick(350, 100.75, 2, "sell"),
        _tick(359, 101.00, 5, "buy"),
    ]

    metrics = {metric.window_seconds: metric for metric in compute_aggressor_metrics(ticks)}

    assert metrics[60].lift_ask == 12
    assert metrics[60].hit_bid == 2
    assert metrics[60].net == 10
    assert metrics[60].ratio == 6.0
    assert metrics[300].lift_ask == 12
    assert metrics[300].hit_bid == 6
    assert metrics[300].direction == "bullish"


def test_v_delta_sign_flip_uses_ten_second_hysteresis(tmp_path: Path) -> None:
    state_path = tmp_path / "aggressor_state.json"
    first_ticks = [
        _tick(0, 100.0, 10, "buy"),
        _tick(10, 100.0, 10, "buy"),
        _tick(20, 100.0, 10, "buy"),
    ]
    first, first_event = compute_v_delta(first_ticks, state_path=state_path)

    assert first.direction == "bullish"
    assert first_event is None

    flipped_ticks = first_ticks + [
        _tick(100, 100.0, 20, "sell"),
        _tick(110, 100.0, 20, "sell"),
        _tick(120, 100.0, 20, "sell"),
    ]
    second, second_event = compute_v_delta(flipped_ticks, state_path=state_path)

    assert second.direction == "bearish"
    assert second.sign_flip is True
    assert second_event is not None
    assert second_event.event_type == "v_delta_sign_flip"
    assert second_event.direction == "short"


def test_v_delta_zscore_suppresses_near_zero_noise(tmp_path: Path) -> None:
    state_path = tmp_path / "aggressor_state.json"
    ticks: list[TradeTick] = []
    events = []

    for idx, seconds in enumerate(range(30, 210, 15)):
        side = "buy" if idx % 2 else "sell"
        ticks.extend(
            [
                _tick(seconds - 10, 100.0, 3, side),
                _tick(seconds, 100.0, 3, side),
            ]
        )
        v_delta, event = compute_v_delta(ticks, state_path=state_path)
        events.append(event)

        assert v_delta.direction == "neutral"
        assert v_delta.zscore is not None
        assert abs(v_delta.zscore) < 1.5

    assert all(event is None for event in events)


def test_v_delta_zscore_emits_one_real_reversal(tmp_path: Path) -> None:
    state_path = tmp_path / "aggressor_state.json"
    bearish_ticks = [
        _tick(20, 100.0, 50, "sell"),
        _tick(30, 100.0, 50, "sell"),
    ]
    first, first_event = compute_v_delta(bearish_ticks, state_path=state_path)

    assert first.direction == "bearish"
    assert first_event is None

    flipped_ticks = bearish_ticks + [
        _tick(90, 100.0, 100, "buy"),
        _tick(100, 100.0, 100, "buy"),
    ]
    second, second_event = compute_v_delta(flipped_ticks, state_path=state_path)

    assert second.direction == "bullish"
    assert second.sign_flip is True
    assert second.zscore is not None
    assert second.zscore > 1.5
    assert second_event is not None
    assert second_event.event_type == "v_delta_sign_flip"
    assert second_event.direction == "long"
    assert second_event.metadata["zscore"] == second.zscore
    assert second_event.metadata["stddev"] == second.stddev


def test_v_delta_zscore_enforces_flip_cooldown(tmp_path: Path) -> None:
    state_path = tmp_path / "aggressor_state.json"
    ticks = [
        _tick(20, 100.0, 50, "sell"),
        _tick(30, 100.0, 50, "sell"),
    ]
    compute_v_delta(ticks, state_path=state_path)

    ticks.extend(
        [
            _tick(90, 100.0, 100, "buy"),
            _tick(100, 100.0, 100, "buy"),
        ]
    )
    bullish, bullish_event = compute_v_delta(ticks, state_path=state_path)

    assert bullish.sign_flip is True
    assert bullish_event is not None

    ticks.extend(
        [
            _tick(105, 100.0, 300, "sell"),
            _tick(115, 100.0, 300, "sell"),
        ]
    )
    suppressed, suppressed_event = compute_v_delta(ticks, state_path=state_path)

    assert suppressed.direction == "bearish"
    assert suppressed.sign_flip is False
    assert suppressed_event is None
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["last_direction"] == "bullish"
    assert state["last_event_direction"] == "bullish"

    ticks.extend(
        [
            _tick(125, 100.0, 300, "sell"),
            _tick(135, 100.0, 300, "sell"),
        ]
    )
    bearish, bearish_event = compute_v_delta(ticks, state_path=state_path)

    assert bearish.direction == "bearish"
    assert bearish.sign_flip is True
    assert bearish_event is not None
    assert bearish_event.direction == "short"


def test_v_delta_zscore_adapts_to_high_volatility_samples(tmp_path: Path) -> None:
    state_path = tmp_path / "aggressor_state.json"
    samples = [
        {"ts_ns": index * 8_000_000_000, "value": 200 if index % 2 else -200}
        for index in range(20)
    ]
    state_path.write_text(
        json.dumps(
            {
                "last_direction": "bearish",
                "last_value": -200,
                "samples": samples,
                "updated_ts_ns": samples[-1]["ts_ns"],
            }
        ),
        encoding="utf-8",
    )
    ticks = [
        _tick(190, 100.0, 90, "buy"),
        _tick(200, 100.0, 90, "buy"),
    ]

    v_delta, event = compute_v_delta(ticks, state_path=state_path)

    assert v_delta.value == 180
    assert v_delta.stddev is not None
    assert v_delta.stddev > 100
    assert v_delta.zscore is not None
    assert v_delta.zscore < 1.5
    assert v_delta.direction == "neutral"
    assert v_delta.sign_flip is False
    assert event is None


def test_footprint_bar_detects_stacked_buy_imbalance() -> None:
    ticks = [
        _tick(60, 100.00, 10, "buy"),
        _tick(61, 100.00, 2, "sell"),
        _tick(62, 100.25, 9, "buy"),
        _tick(63, 100.25, 1, "sell"),
        _tick(64, 100.50, 8, "buy"),
        _tick(65, 100.50, 1, "sell"),
        _tick(360, 101.00, 1, "buy"),
    ]

    bar = build_footprint_bar(ticks)

    assert bar is not None
    assert bar.stacked_side == "buy"
    assert bar.stacked_count == 3
    assert bar.stacked_low_price == 100.0
    assert bar.stacked_high_price == 100.5
    assert all(-1.0 <= level.imbalance <= 1.0 for level in bar.levels)


def test_aggressor_events_persist_and_load(tmp_path: Path) -> None:
    ticks = [
        _tick(0, 100.0, 10, "buy"),
        _tick(10, 100.0, 10, "buy"),
        _tick(20, 100.25, 10, "buy"),
        _tick(30, 100.50, 10, "buy"),
    ]
    windows = compute_aggressor_metrics(ticks)
    bar = build_footprint_bar(ticks)
    events = build_aggressor_events(
        windows=windows,
        footprint_bar=bar,
        v_delta_event=None,
        timestamp_ns=ticks[-1].timestamp_ns,
    )
    event_path = tmp_path / "2026-05-29_globex_aggressor_flow.jsonl"
    footprint_path = tmp_path / "2026-05-29_globex_footprint.jsonl"

    append_new_aggressor_flow_events(event_path, events)
    append_new_aggressor_flow_events(event_path, events)
    append_footprint_bar(footprint_path, bar)
    append_footprint_bar(footprint_path, bar)

    loaded = load_aggressor_flow_events(event_path)
    assert len(loaded) == len(events)
    assert any(event.event_type == "aggressor_imbalance_extreme" for event in loaded)
    assert len(footprint_path.read_text(encoding="utf-8").splitlines()) == 1


def _tick(seconds: int, price: float, qty: int, side: str) -> TradeTick:
    return TradeTick(
        timestamp_ns=seconds * 1_000_000_000,
        price=price,
        quantity=qty,
        aggressor_side="buy" if side == "buy" else "sell",
    )

