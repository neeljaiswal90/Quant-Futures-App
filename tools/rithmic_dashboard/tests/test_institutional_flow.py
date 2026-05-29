from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from rithmic_dashboard.features.institutional_flow import (
    append_new_institutional_flow_events,
    compute_institutional_flow,
    load_institutional_flow_events,
)
from rithmic_dashboard.features.multi_signal_stack_alert import build_multi_signal_stack_alerts
from rithmic_dashboard.features.recent_signals_panel import RecentSignal
from rithmic_dashboard.features.trade_size_classifier import TradeSizeThresholds
from rithmic_dashboard.models import TradeTick


def test_institutional_concentration_requires_unbalanced_net_delta() -> None:
    base = _ns(datetime(2026, 5, 26, 15, 0, tzinfo=UTC))
    result = compute_institutional_flow(
        [
            TradeTick(base, 30_000.0, 60, "buy"),
            TradeTick(base + 60_000_000_000, 30_000.25, 60, "buy"),
            TradeTick(base + 120_000_000_000, 30_000.0, 55, "buy"),
        ],
        [_level(30_000.0)],
        thresholds=TradeSizeThresholds(),
        tail_span_minutes=60.0,
    )

    assert len(result.events) == 1
    event = result.events[0]
    assert event.event_type == "institutional_concentration_detected"
    assert event.side == "buy"
    assert event.net_delta == 175
    assert event.confidence == "high"


def test_balanced_institutional_flow_does_not_emit_concentration() -> None:
    base = _ns(datetime(2026, 5, 26, 15, 0, tzinfo=UTC))
    result = compute_institutional_flow(
        [
            TradeTick(base, 30_000.0, 60, "buy"),
            TradeTick(base + 60_000_000_000, 30_000.25, 60, "sell"),
            TradeTick(base + 120_000_000_000, 30_000.0, 55, "buy"),
        ],
        [_level(30_000.0)],
        thresholds=TradeSizeThresholds(),
        tail_span_minutes=60.0,
    )

    assert result.events == ()


def test_block_trade_persists_schema_for_recent_signals_contract(tmp_path: Path) -> None:
    base = _ns(datetime(2026, 5, 26, 15, 0, tzinfo=UTC))
    result = compute_institutional_flow(
        [TradeTick(base, 30_000.0, 120, "sell")],
        [_level(30_000.0)],
        thresholds=TradeSizeThresholds(),
        tail_span_minutes=12.0,
    )
    path = tmp_path / "2026-05-26_globex_institutional_flow.jsonl"

    appended = append_new_institutional_flow_events(path, result.events)
    loaded = load_institutional_flow_events(path)

    assert len(appended) == 1
    assert loaded[0].event_type == "block_trade_at_zone"
    assert loaded[0].confidence == "low_tail_span"
    text = path.read_text(encoding="utf-8")
    assert '"family": "institutional_flow"' in text
    assert '"direction": "short"' in text


def test_two_institutional_events_count_as_one_stack_family() -> None:
    now = datetime(2026, 5, 26, 15, 10, tzinfo=UTC)
    signals = [
        _recent_signal("institutional_concentration_detected", "institutional_flow", now),
        _recent_signal("block_trade_at_zone", "institutional_flow", now + timedelta(seconds=1)),
    ]

    alerts = build_multi_signal_stack_alerts(recent_signals=signals, current_price=30_000.0)

    assert alerts == []


def _level(price: float) -> dict[str, object]:
    return {
        "level_id": f"ref-vah-{price:.2f}",
        "text": "VAH",
        "source": "vah",
        "price": price,
    }


def _recent_signal(event_type: str, family: str, ts: datetime) -> RecentSignal:
    return RecentSignal(
        timestamp_pt="2026-05-26 15:10:00 PT",
        timestamp_ns=_ns(ts),
        event_type=event_type,
        family=family,
        icon="■",
        label="Institutional",
        level_id="ref-vah-30000.00",
        level_text="VAH",
        level_price=30_000.0,
        price=30_000.0,
        description=event_type,
        direction="long",
        urgency="medium",
        decay_class="signal-age-fresh",
        age_minutes=1.0,
        scenario_refs=(),
        zone_key="level:ref-vah-30000.00",
        zone_text="VAH",
        zone_price=30_000.0,
        tooltip=event_type,
    )


def _ns(value: datetime) -> int:
    return int(value.timestamp() * 1_000_000_000)
