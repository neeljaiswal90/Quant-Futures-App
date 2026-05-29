from __future__ import annotations

import json
from dataclasses import asdict
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
    priority: str | None = None,
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
        priority=priority,
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


# ---------------------------------------------------------------------------
# RA-065: byte-exact backward-compat gate + priority does not perturb detector
# ---------------------------------------------------------------------------


def test_ra065_all_none_priority_iceberg_output_is_byte_exact() -> None:
    """FROZEN GOLDEN GATE: running the canonical OBS-confirmed iceberg fixture
    with priority ABSENT on every event must emit an IcebergEvent that is
    byte-identical (asdict equality) to the pre-RA-065 output — including
    confirmation_source='obs_trade_tail' and every numeric. Priority absent =>
    the new channel touches NOTHING."""
    events, trades = _ask_refill_sequence(quantities=[30, 25, 30, 30, 30])
    detected = detect_icebergs(mbo_events=events, trades=trades, levels=_levels())
    assert len(detected) == 1

    # This dict is the pre-RA-065 frozen golden output for this fixture. If the
    # additive priority channel ever perturbs the all-None path, this fails.
    assert asdict(detected[0]) == {
        "timestamp_pt": detected[0].timestamp_pt,  # tz-formatting is unchanged logic
        "timestamp_ns": detected[0].timestamp_ns,
        "event_type": "iceberg_detected",
        "level_id": "w-plus-2",
        "level_text": "W+2σ short zone",
        "level_price": 30220.0,
        "side": "ask",
        "direction": "short",
        "refill_count": 5,
        "total_consumed": 145,
        "median_refill_size": 30.0,
        "window_seconds": 30,
        "confidence": "high",
        "intensity": detected[0].intensity,
        "description": (
            "Iceberg-like ask-side refill at W+2σ short zone: 5 refills, "
            "145 consumed via OBS confirmation"
        ),
        "metadata": {
            "price": 30220.0,
            "side": "ask",
            "mbo_side": "A",
            "refill_count": 5,
            "total_consumed": 145,
            "median_refill_size": 30.0,
            "window_seconds": 30,
            "size_consistency_pct": 0.40,
            "aggressor_side": "buy",
            "confirmation_source": "obs_trade_tail",
            "match_tolerance_ms": 50,
        },
    }


def test_ra065_priority_present_does_not_change_obs_confirmed_iceberg() -> None:
    """Threading non-None priority through the SAME OBS-confirmed fixture must
    not change the detector output: the detector reads only the legacy
    ConsumedOrder fields, so the iceberg is identical with or without priority."""
    events_no_prio, trades = _ask_refill_sequence(quantities=[30, 25, 30, 30, 30])
    # Same sequence, but every event now carries a (monotonic) priority.
    events_with_prio = tuple(
        _mbo(
            action=e.action if e.action in {"A", "M"} else "C",
            ts=e.timestamp_ns,
            order_id=e.order_id,
            side=e.side,
            price=e.price,
            size=e.size,
            priority=str(1000 + i),
        )
        for i, e in enumerate(events_no_prio)
    )
    without = detect_icebergs(mbo_events=events_no_prio, trades=trades, levels=_levels())
    with_prio = detect_icebergs(mbo_events=events_with_prio, trades=trades, levels=_levels())
    assert len(without) == len(with_prio) == 1
    assert asdict(without[0]) == asdict(with_prio[0])


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
