from __future__ import annotations

from rithmic_dashboard.features.sweep_detector import append_new_sweeps, detect_sweeps, load_sweeps
from rithmic_dashboard.models import TradeTick


def _tick(second: int, price: float) -> TradeTick:
    return TradeTick(
        timestamp_ns=1_779_400_000_000_000_000 + second * 1_000_000_000,
        price=price,
        quantity=1,
        aggressor_side="buy",
    )


def test_sweep_detector_fires_on_five_ticks_through_level_in_30_seconds() -> None:
    ticks = [_tick(0, 29499.75), _tick(10, 29500.25), _tick(30, 29501.25)]
    events = detect_sweeps(
        ticks,
        [{"level_id": "vpoc", "text": "VPOC", "price": 29500.0}],
    )
    assert len(events) == 1
    assert events[0].direction == "up"
    assert events[0].intensity_score > 1.0


def test_sweep_detector_ignores_slow_moves() -> None:
    ticks = [_tick(0, 29499.75), _tick(90, 29501.25)]
    events = detect_sweeps(
        ticks,
        [{"level_id": "vpoc", "text": "VPOC", "price": 29500.0}],
    )
    assert events == []


def test_sweep_detector_marks_recovered_sweep() -> None:
    ticks = [_tick(0, 29499.75), _tick(20, 29501.0), _tick(120, 29499.5)]
    events = detect_sweeps(
        ticks,
        [{"level_id": "vpoc", "text": "VPOC", "price": 29500.0}],
    )
    assert events[0].recovered_within_5min is True


def test_sweep_persistence_dedupes_events(tmp_path) -> None:
    events = detect_sweeps(
        [_tick(0, 29499.75), _tick(20, 29501.0), _tick(400, 29502.0)],
        [{"level_id": "vpoc", "text": "VPOC", "price": 29500.0}],
    )
    path = tmp_path / "sweeps.jsonl"
    append_new_sweeps(path, events)
    append_new_sweeps(path, events)
    loaded = load_sweeps(path)
    assert len(loaded) == 1
