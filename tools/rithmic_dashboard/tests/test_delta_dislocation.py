from __future__ import annotations

from pathlib import Path

from rithmic_dashboard.features.delta_dislocation import (
    append_new_delta_dislocations,
    detect_delta_dislocations,
    dislocation_levels,
    load_delta_dislocations,
)
from rithmic_dashboard.models import LiveVwap, TradeTick


def _tick(minute: int, price: float, qty: int, side: str) -> TradeTick:
    return TradeTick(
        timestamp_ns=1_800_000_000_000_000_000 + minute * 60_000_000_000,
        price=price,
        quantity=qty,
        aggressor_side="buy" if side == "buy" else "sell",
    )


def test_detects_long_dislocation_on_down_candle_with_positive_cvd() -> None:
    ticks = [_tick(0, 110.0, 1, "buy")]
    ticks.extend(_tick(idx, 100.0, 10, "buy") for idx in range(1, 61))

    events = detect_delta_dislocations(
        ticks,
        [{"level_id": "vpoc", "text": "VPOC", "price": 100.0, "priority": 3}],
        threshold=100.0,
        live_vwap=LiveVwap(60, 100.0, 20.0, 120.0, 80.0),
    )

    assert len(events) == 1
    assert events[0].side == "long"
    assert events[0].candle_direction == "down"
    assert events[0].hourly_cvd > 0
    assert events[0].confidence == "high"


def test_detects_short_dislocation_on_up_candle_with_negative_cvd() -> None:
    ticks = [_tick(0, 90.0, 1, "sell")]
    ticks.extend(_tick(idx, 100.0, 10, "sell") for idx in range(1, 61))

    events = detect_delta_dislocations(
        ticks,
        [{"level_id": "vah", "text": "VAH", "price": 100.0, "priority": 4}],
        threshold=100.0,
        live_vwap=LiveVwap(60, 100.0, 20.0, 120.0, 80.0),
    )

    assert len(events) == 1
    assert events[0].side == "short"
    assert events[0].candle_direction == "up"
    assert events[0].hourly_cvd < 0


def test_dislocation_requires_level_proximity() -> None:
    ticks = [_tick(0, 110.0, 1, "buy")]
    ticks.extend(_tick(idx, 100.0, 10, "buy") for idx in range(1, 61))

    events = detect_delta_dislocations(
        ticks,
        [{"level_id": "far", "text": "Far", "price": 80.0, "priority": 1}],
        threshold=100.0,
        live_vwap=LiveVwap(60, 100.0, 20.0, 120.0, 80.0),
    )

    assert events == []


def test_low_tail_span_and_strong_variant_are_flagged() -> None:
    ticks = [_tick(0, 108.0, 1, "buy")]
    ticks.extend(_tick(idx, 100.0, 10, "buy") for idx in range(1, 43))

    events = detect_delta_dislocations(
        ticks,
        [{"level_id": "vpoc", "text": "VPOC", "price": 100.0, "priority": 3}],
        threshold=100.0,
        live_vwap=LiveVwap(60, 100.0, 20.0, 120.0, 80.0),
    )

    assert len(events) == 1
    assert events[0].confidence == "low_tail_span"
    assert events[0].is_strong is True
    assert events[0].tail_span_minutes < 55.0


def test_append_dedupes_by_level_side_and_rolling_window_start(tmp_path: Path) -> None:
    path = tmp_path / "delta.jsonl"
    first = detect_delta_dislocations(
        [_tick(0, 110.0, 1, "buy"), *[_tick(idx, 100.0, 10, "buy") for idx in range(1, 61)]],
        [{"level_id": "vpoc", "text": "VPOC", "price": 100.0, "priority": 3}],
        threshold=100.0,
        live_vwap=LiveVwap(60, 100.0, 20.0, 120.0, 80.0),
    )
    appended = append_new_delta_dislocations(path, first)
    duplicate = append_new_delta_dislocations(path, first)
    second = detect_delta_dislocations(
        [_tick(15, 110.0, 1, "buy"), *[_tick(idx, 100.0, 10, "buy") for idx in range(16, 76)]],
        [{"level_id": "vpoc", "text": "VPOC", "price": 100.0, "priority": 3}],
        threshold=100.0,
        live_vwap=LiveVwap(60, 100.0, 20.0, 120.0, 80.0),
    )
    appended_second = append_new_delta_dislocations(path, second)

    assert len(appended) == 1
    assert duplicate == []
    assert len(appended_second) == 1
    assert len(load_delta_dislocations(path)) == 2


def test_dislocation_levels_prefers_high_super_zone_over_same_price_reference() -> None:
    levels = dislocation_levels(
        {
            "reference_lines": [{"price": 100.0, "text": "VPOC", "source": "vpoc"}],
            "zones": [
                {
                    "id": "super-zone",
                    "top": 100.25,
                    "bot": 99.75,
                    "text": "SUPER zone",
                    "conviction": "SUPER",
                }
            ],
        }
    )

    assert levels[0]["level_id"] == "super-zone"
