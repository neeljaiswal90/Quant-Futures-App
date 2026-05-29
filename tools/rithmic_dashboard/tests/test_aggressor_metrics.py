from __future__ import annotations

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

