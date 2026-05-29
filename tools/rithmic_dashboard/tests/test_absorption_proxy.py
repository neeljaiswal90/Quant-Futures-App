from __future__ import annotations

from rithmic_dashboard.features.absorption_proxy import (
    append_new_absorption_proxies,
    detect_absorption_proxies,
    load_absorption_proxy_events,
)
from rithmic_dashboard.models import AbsorptionProxyEvent, TradeTick


def _tick(second: int, price: float, qty: int, side: str) -> TradeTick:
    return TradeTick(
        timestamp_ns=1_779_400_000_000_000_000 + second * 1_000_000_000,
        price=price,
        quantity=qty,
        aggressor_side="buy" if side == "buy" else "sell",
    )


def test_absorption_proxy_fires_on_heavy_balanced_delta_cluster() -> None:
    ticks = [
        *[_tick(i, 29400.0 + i, 10, "buy") for i in range(1, 6)],
        *[_tick(10 + i, 29400.0, 50, "buy" if i % 2 == 0 else "sell") for i in range(10)],
    ]
    events = detect_absorption_proxies(ticks, volume_multiple=3.0)
    assert len(events) == 1
    assert events[0].price == 29400.0
    assert events[0].volume == 500
    assert abs(events[0].net_delta) <= 150


def test_absorption_proxy_rejects_directional_delta_cluster() -> None:
    ticks = [
        *[_tick(i, 29400.0 + i, 10, "buy") for i in range(1, 6)],
        *[_tick(10 + i, 29400.0, 50, "buy") for i in range(10)],
    ]
    assert detect_absorption_proxies(ticks, volume_multiple=3.0) == []


def test_absorption_proxy_rejects_tiny_relative_volume_cluster() -> None:
    ticks = [
        *[_tick(i, 29400.0 + i, 1, "buy") for i in range(1, 6)],
        *[_tick(10 + i, 29400.0, 5, "buy" if i % 2 == 0 else "sell") for i in range(10)],
    ]
    assert detect_absorption_proxies(ticks, volume_multiple=3.0) == []


def test_absorption_proxy_confidence_high_after_prior_repeats() -> None:
    prior = [
        AbsorptionProxyEvent("x", i, 29400.0, 100, 0, "balanced", "low")
        for i in range(3)
    ]
    ticks = [
        *[_tick(i, 29400.0 + i, 10, "buy") for i in range(1, 6)],
        *[_tick(10 + i, 29400.0, 50, "buy" if i % 2 == 0 else "sell") for i in range(10)],
    ]
    events = detect_absorption_proxies(ticks, volume_multiple=3.0, prior_events=prior)
    assert events[0].confidence == "high"


def test_absorption_proxy_persistence_dedupes(tmp_path) -> None:
    ticks = [
        *[_tick(i, 29400.0 + i, 10, "buy") for i in range(1, 6)],
        *[_tick(10 + i, 29400.0, 50, "buy" if i % 2 == 0 else "sell") for i in range(10)],
    ]
    events = detect_absorption_proxies(ticks, volume_multiple=3.0)
    path = tmp_path / "absorption.jsonl"
    append_new_absorption_proxies(path, events)
    append_new_absorption_proxies(path, events)
    assert len(load_absorption_proxy_events(path)) == 1
