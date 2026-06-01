"""Tests for FeedState: seq monotonicity, client drops, heartbeat staleness."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

from rithmic_dashboard.models import (
    LiveCvd,
    LiveSignals,
    LiveVwap,
    SweepEvent,
    VolumeVelocity,
)

from realtime_backend.connection_manager import ConnectionManager
from realtime_backend.feed import FeedState
from realtime_backend.orderflow import build_orderflow_stats
from realtime_backend.price_ticks import LatestPriceTick
from realtime_backend.settings import Settings


async def _noop(_text: str) -> None:
    """An async send sink that discards frames (mypy-friendly)."""
    return None


def _collector(sink: list[str]) -> Callable[[str], Awaitable[None]]:
    async def _send(text: str) -> None:
        sink.append(text)

    return _send


def _signals(sweeps: tuple[SweepEvent, ...] = ()) -> LiveSignals:
    return LiveSignals(
        trading_date="2026-05-22",
        session="globex",
        computed_at_pt="2026-05-21 20:00:00 PT",
        source_path=Path("x"),
        tail_bytes=1000,
        trade_count=10,
        live_vwap=LiveVwap(60, 29400.0, 12.0, 29412.0, 29388.0),
        cvd=LiveCvd(100, 50, 25, "bullish", "bullish", False),
        velocity=VolumeVelocity(10, 0.67, 0.5, 1.3, "normal"),
        sweeps=sweeps,
        absorption_proxies=(),
    )


def _sweep(ts: int, intensity: float) -> SweepEvent:
    return SweepEvent(
        timestamp_pt="2026-05-21 20:00:00 PT",
        timestamp_ns=ts,
        level_id=f"ref-vah-{ts}",
        level_text="VAH 29425",
        level_price=29425.0,
        direction="up",
        intensity_score=intensity,
        recovered_within_5min=None,
    )


def _feed(maxsize: int = 256) -> FeedState:
    settings = Settings(client_queue_maxsize=maxsize, staleness_threshold_seconds=30.0)
    return FeedState(manager=ConnectionManager(client_queue_maxsize=maxsize), settings=settings)


def test_seq_is_monotonic_across_emits() -> None:
    async def scenario() -> None:
        feed = _feed()
        await feed.manager.connect(_noop)
        await feed.emit_snapshot_to()
        emitted = await feed.emit_signal_diff(
            _signals((_sweep(1, 3.0), _sweep(2, 4.0))),
            envelope=None,
            recent_signals=[],
            current_price=29420.0,
        )
        assert emitted == 2
        # snapshot(1) + 2 events => seq advanced to 3.
        assert feed.current_seq == 3

    asyncio.run(scenario())


def test_diff_emits_only_new_events_on_second_pass() -> None:
    async def scenario() -> None:
        feed = _feed()
        await feed.manager.connect(_noop)
        first = _signals((_sweep(1, 3.0),))
        n1 = await feed.emit_signal_diff(
            first, envelope=None, recent_signals=[], current_price=29420.0
        )
        feed.update_snapshot_inputs(
            signals=first, envelope=None, recent_signals=[], last_append_ts_ns=time.time_ns()
        )
        second = _signals((_sweep(1, 3.0), _sweep(2, 4.0)))
        n2 = await feed.emit_signal_diff(
            second, envelope=None, recent_signals=[], current_price=29420.0
        )
        assert n1 == 1
        assert n2 == 1  # only the new sweep ts=2

    asyncio.run(scenario())


def test_slow_client_drop_does_not_bump_global_seq() -> None:
    async def scenario() -> None:
        feed = _feed(maxsize=2)

        async def stuck(_text: str) -> None:
            await asyncio.sleep(3600)

        await feed.manager.connect(stuck)
        # Emit enough events to overflow the stuck client's queue.
        sweeps = tuple(_sweep(i, 2.0) for i in range(1, 12))
        await feed.emit_signal_diff(
            _signals(sweeps), envelope=None, recent_signals=[], current_price=29420.0
        )
        # 11 events emitted; slow-client drops are local to that client. Healthy
        # sockets should not see a global seq gap just because another socket
        # fell behind.
        assert feed.current_seq == 11

    asyncio.run(scenario())


def test_heartbeat_fresh_data_not_stale() -> None:
    async def scenario() -> None:
        feed = _feed()
        feed.update_snapshot_inputs(
            signals=_signals(),
            envelope=None,
            recent_signals=[],
            last_append_ts_ns=time.time_ns(),
        )
        msg = await feed.emit_heartbeat()
        assert msg.payload.stale is False  # type: ignore[attr-defined]
        assert msg.type == "heartbeat"

    asyncio.run(scenario())


def test_heartbeat_old_data_is_stale() -> None:
    async def scenario() -> None:
        feed = _feed()
        old = time.time_ns() - 120 * 1_000_000_000  # 2 minutes ago
        feed.update_snapshot_inputs(
            signals=_signals(), envelope=None, recent_signals=[], last_append_ts_ns=old
        )
        msg = await feed.emit_heartbeat()
        assert msg.payload.stale is True  # type: ignore[attr-defined]

    asyncio.run(scenario())


def test_heartbeat_no_data_is_stale() -> None:
    async def scenario() -> None:
        feed = _feed()
        msg = await feed.emit_heartbeat()
        assert msg.payload.stale is True  # type: ignore[attr-defined]
        assert msg.payload.last_capture_ts_ns is None  # type: ignore[attr-defined]

    asyncio.run(scenario())


def test_price_tick_emits_market_time_and_dedupes_on_trade_key() -> None:
    async def scenario() -> None:
        feed = _feed()
        received: list[str] = []
        await feed.manager.connect(_collector(received))

        first = LatestPriceTick(
            trade_ts_ns=123,
            price=29400.25,
            volume=3,
            bid=29400.0,
            ask=29400.5,
        )
        duplicate_with_quote_change = LatestPriceTick(
            trade_ts_ns=123,
            price=29400.25,
            volume=3,
            bid=29399.75,
            ask=29400.25,
        )
        second_trade = LatestPriceTick(
            trade_ts_ns=124,
            price=29400.25,
            volume=3,
            bid=29399.75,
            ask=29400.25,
        )

        msg = await feed.emit_price_tick(first)
        assert msg is not None
        assert msg.ts_ns == 123
        assert msg.payload.family == "price_tick"
        assert msg.payload.volume == 3  # type: ignore[attr-defined]
        assert msg.payload.orderflow is None  # type: ignore[attr-defined]

        assert await feed.emit_price_tick(duplicate_with_quote_change) is None
        assert await feed.emit_price_tick(second_trade) is not None
        await asyncio.sleep(0.05)

        frames = [json.loads(text) for text in received]
        assert [frame["payload"]["family"] for frame in frames] == [
            "price_tick",
            "price_tick",
        ]

    asyncio.run(scenario())


def test_compute_orderflow_can_enrich_a_fast_path_duplicate() -> None:
    async def scenario() -> None:
        feed = _feed()
        received: list[str] = []
        await feed.manager.connect(_collector(received))
        tick = LatestPriceTick(
            trade_ts_ns=123,
            price=29400.25,
            volume=3,
            bid=29400.0,
            ask=29400.5,
            aggressor_side="buy",
        )

        fast = await feed.emit_price_tick(tick, orderflow=None)
        enriched = await feed.emit_price_tick(
            tick,
            orderflow=build_orderflow_stats(_signals(), tick),
        )
        assert fast is not None
        assert enriched is not None
        assert enriched.payload.orderflow is not None  # type: ignore[attr-defined]
        assert enriched.payload.orderflow.last_trade_aggressor == "buy"  # type: ignore[attr-defined]
        assert await feed.emit_price_tick(
            tick,
            orderflow=build_orderflow_stats(_signals(), tick),
        ) is None

    asyncio.run(scenario())


def test_bookmap_backfill_merges_fast_and_enriched_duplicate_tick() -> None:
    async def scenario() -> None:
        feed = _feed()
        tick = LatestPriceTick(
            trade_ts_ns=123,
            price=29400.25,
            volume=3,
            bid=29400.0,
            ask=29400.5,
            aggressor_side="buy",
        )

        fast = await feed.emit_price_tick(tick, orderflow=None)
        enriched = await feed.emit_price_tick(
            tick,
            orderflow=build_orderflow_stats(_signals(), tick),
        )
        assert fast is not None
        assert enriched is not None

        payload = await feed.bookmap_backfill_payload()

        assert payload["through_seq"] == 2
        assert payload["limits"]["price_ticks_max"] == 100_000
        assert len(payload["price_ticks"]) == 1
        tick_row = payload["price_ticks"][0]
        assert tick_row["seq"] == 2
        assert tick_row["ts_ns"] == 123
        assert tick_row["price"] == 29400.25
        assert tick_row["volume"] == 3
        assert tick_row["aggressor_side"] == "buy"
        assert tick_row["orderflow_quality"] == "high"
        assert tick_row["last_trade_delta"] == 3

    asyncio.run(scenario())


def test_snapshot_message_uses_current_seq() -> None:
    async def scenario() -> None:
        feed = _feed()
        await feed.manager.connect(_noop)
        await feed.emit_heartbeat()  # seq -> 1
        await feed.emit_heartbeat()  # seq -> 2
        snap = feed.build_snapshot_message()
        assert snap.seq == feed.current_seq == 2
        assert snap.type == "snapshot"

    asyncio.run(scenario())
