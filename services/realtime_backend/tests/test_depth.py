"""Tests for RA-081 backend depth payloads, feed emission, and watcher polling."""

from __future__ import annotations

import asyncio
import json
import threading
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, cast

from contracts.realtime.events import DepthPayload
from fastapi import WebSocketDisconnect
from rithmic_dashboard.features.depth_book import DepthBook, DepthLevel, DepthSnapshot
from rithmic_dashboard.models import MboOrderEvent

from realtime_backend.app import create_app
from realtime_backend.connection_manager import ConnectionManager
from realtime_backend.depth import (
    DepthMid,
    build_depth_payload,
    classify_depth_quality,
    resolve_depth_mid,
)
from realtime_backend.feed import FeedState
from realtime_backend.history import BookmapHistory
from realtime_backend.price_ticks import LatestPriceTick
from realtime_backend.settings import Settings
from realtime_backend.watcher import CaptureWatcher, ComputeResult

from .conftest import sample_envelope, trade, write_raw


def _collector(sink: list[str]) -> Callable[[str], Awaitable[None]]:
    async def _send(text: str) -> None:
        sink.append(text)

    return _send


def _depth_payload(
    *,
    ts_ns: int = 1_000,
    mid: float = 30220.01,
    quality: str = "live",
    bid_size: int = 10,
) -> DepthPayload:
    snapshot = DepthSnapshot(
        mid=mid,
        n_ticks=2,
        bid_levels=(
            _level(30220.0, bid_size),
            _level(30219.75, 7),
        ),
        ask_levels=(
            _level(30220.25, 8),
            _level(30220.50, 6),
        ),
    )
    payload = build_depth_payload(
        snapshot,
        quality=cast(Any, quality),
        ts_ns=ts_ns,
    )
    assert payload is not None
    return payload


def _level(price: float, size: int) -> DepthLevel:
    return DepthLevel(price=price, size=size)


def _mbo_event(
    *,
    ts_ns: int,
    action: str,
    order_id: str,
    side: str = "B",
    price: float = 30220.0,
    size: int = 10,
) -> MboOrderEvent:
    return MboOrderEvent(
        timestamp_ns=ts_ns,
        recv_ts_ns=None,
        sequence=1,
        action=cast(Any, action),
        side=cast(Any, side),
        price=price,
        size=size,
        order_id=order_id,
    )


def _write_mbo(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")


def _mbo_row(
    *,
    ts_ns: int,
    action: str,
    order_id: str,
    side: str = "B",
    price: float = 29400.0,
    size: int = 10,
) -> dict[str, object]:
    return {
        "event_ts_ns": ts_ns,
        "sequence": 1,
        "action": action,
        "side": side,
        "price": price,
        "size": size,
        "order_id": order_id,
    }


def _quote_row(*, bid: float, ask: float) -> dict[str, object]:
    return {"bid_px": bid, "ask_px": ask}


def test_depth_book_tracks_last_event_timestamp() -> None:
    book = DepthBook(order_ttl_seconds=1_000, max_ticks_from_mid=None)

    book.apply(_mbo_event(ts_ns=100, action="A", order_id="one"))
    book.apply(_mbo_event(ts_ns=90, action="A", order_id="two"))
    book.apply(_mbo_event(ts_ns=120, action="C", order_id="one"))

    assert book.last_ts_ns == 120


def test_build_depth_payload_preserves_ordering_and_bounds() -> None:
    payload = _depth_payload()

    assert payload.family == "depth"
    assert payload.n_ticks == 2
    assert [level.price for level in payload.bid_levels] == [30220.0, 30219.75]
    assert [level.price for level in payload.ask_levels] == [30220.25, 30220.5]


def test_build_depth_payload_accepts_100_level_bookmap_window() -> None:
    snapshot = DepthSnapshot(
        mid=30220.0,
        n_ticks=100,
        bid_levels=tuple(_level(30220.0 - index * 0.25, 1) for index in range(100)),
        ask_levels=tuple(_level(30220.25 + index * 0.25, 1) for index in range(100)),
    )

    payload = build_depth_payload(snapshot, quality="live", ts_ns=1_000)

    assert payload is not None
    assert payload.n_ticks == 100
    assert len(payload.bid_levels) == 100
    assert len(payload.ask_levels) == 100


def test_depth_quality_uses_mid_source_and_depth_age() -> None:
    now_ns = 1_000_000_000_000
    fresh_book = now_ns - 5_000_000_000
    old_book = now_ns - 35_000_000_000

    assert (
        classify_depth_quality(
            has_book=True,
            book_ts_ns=fresh_book,
            mid=DepthMid(mid=30220.125, source="l1", ts_ns=fresh_book),
            now_ns=now_ns,
            staleness_threshold_seconds=30.0,
        )
        == "live"
    )
    assert (
        classify_depth_quality(
            has_book=True,
            book_ts_ns=fresh_book,
            mid=DepthMid(mid=30220.25, source="trade", ts_ns=fresh_book),
            now_ns=now_ns,
            staleness_threshold_seconds=30.0,
        )
        == "inferred"
    )
    assert (
        classify_depth_quality(
            has_book=True,
            book_ts_ns=old_book,
            mid=DepthMid(mid=30220.125, source="l1", ts_ns=fresh_book),
            now_ns=now_ns,
            staleness_threshold_seconds=30.0,
        )
        == "stale_l1"
    )
    assert (
        classify_depth_quality(
            has_book=False,
            book_ts_ns=None,
            mid=DepthMid(mid=None, source="none", ts_ns=None),
            now_ns=now_ns,
            staleness_threshold_seconds=30.0,
        )
        == "unavailable"
    )


def test_resolve_depth_mid_prefers_bid_ask_mid() -> None:
    tick = LatestPriceTick(
        trade_ts_ns=123,
        price=30220.25,
        volume=3,
        bid=30220.0,
        ask=30220.5,
    )
    assert resolve_depth_mid(tick) == DepthMid(mid=30220.25, source="l1", ts_ns=123)
    assert resolve_depth_mid(
        LatestPriceTick(trade_ts_ns=123, price=30220.25, volume=3)
    ) == DepthMid(mid=30220.25, source="trade", ts_ns=123)


def test_feed_emit_depth_dedupes_on_bucketed_mid_and_caches_latest() -> None:
    async def scenario() -> None:
        feed = FeedState(manager=ConnectionManager(), settings=Settings())
        received: list[str] = []
        await feed.manager.connect(_collector(received))

        first = await feed.emit_depth(_depth_payload(mid=30220.01))
        duplicate_mid_jitter = await feed.emit_depth(_depth_payload(ts_ns=2_000, mid=30220.04))
        changed_quality = await feed.emit_depth(
            _depth_payload(ts_ns=3_000, mid=30220.04, quality="stale_l1")
        )
        changed_level = await feed.emit_depth(
            _depth_payload(ts_ns=4_000, mid=30220.04, quality="stale_l1", bid_size=11)
        )

        assert first is not None
        assert duplicate_mid_jitter is None
        assert changed_quality is not None
        assert changed_level is not None
        assert feed.latest_depth_message is changed_level
        await asyncio.sleep(0.05)
        frames = [json.loads(text) for text in received]
        assert [frame["seq"] for frame in frames] == [1, 2, 3]
        assert all(frame["payload"]["family"] == "depth" for frame in frames)

    asyncio.run(scenario())


def test_bookmap_backfill_retains_compact_depth_columns() -> None:
    async def scenario() -> None:
        feed = FeedState(manager=ConnectionManager(), settings=Settings())
        first = await feed.emit_depth(_depth_payload(ts_ns=1_000, mid=30220.01))
        duplicate_mid_jitter = await feed.emit_depth(
            _depth_payload(ts_ns=2_000, mid=30220.04)
        )
        changed_level = await feed.emit_depth(
            _depth_payload(ts_ns=3_000, mid=30220.04, bid_size=11)
        )

        assert first is not None
        assert duplicate_mid_jitter is None
        assert changed_level is not None

        payload = await feed.bookmap_backfill_payload()

        assert payload["through_seq"] == 2
        assert payload["limits"]["depth_columns_max"] == 12_000
        assert len(payload["depth"]) == 2
        first_column = payload["depth"][0]
        assert first_column["family"] == "depth"
        assert first_column["seq"] == 1
        assert first_column["ts_ns"] == 1_000
        assert first_column["n_ticks"] == 2
        assert [level["price"] for level in first_column["bid_levels"]] == [
            30220.0,
            30219.75,
        ]
        assert [level["price"] for level in first_column["ask_levels"]] == [
            30220.25,
            30220.5,
        ]

    asyncio.run(scenario())


def test_bookmap_backfill_reports_effective_caps_under_byte_guard() -> None:
    history = BookmapHistory(max_depth_columns=20, max_response_bytes=3_500)
    for i in range(20):
        history.append_depth(
            seq=i + 1,
            payload=_depth_payload(ts_ns=1_000 + i, bid_size=10 + i),
            dedupe_key=(i,),
        )

    payload = history.to_response(
        generated_at_ns=9_999,
        through_seq=20,
        trading_date="2026-06-01",
        session="globex",
    )
    encoded_len = len(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    )

    assert encoded_len <= payload["limits"]["max_response_bytes"]
    assert payload["limits"]["effective_depth_columns_max"] == len(payload["depth"])
    assert payload["limits"]["effective_depth_columns_max"] < 20
    assert payload["depth"][-1]["seq"] == 20


def test_bookmap_backfill_byte_guard_still_binds_at_100_ticks() -> None:
    history = BookmapHistory(max_depth_columns=8, max_response_bytes=18_000)
    for i in range(8):
        payload = build_depth_payload(
            DepthSnapshot(
                mid=30220.0,
                n_ticks=100,
                bid_levels=tuple(
                    _level(30220.0 - index * 0.25, 10 + i) for index in range(100)
                ),
                ask_levels=tuple(
                    _level(30220.25 + index * 0.25, 9 + i) for index in range(100)
                ),
            ),
            quality="live",
            ts_ns=10_000 + i,
        )
        assert payload is not None
        history.append_depth(seq=i + 1, payload=payload, dedupe_key=(i,))

    response = history.to_response(
        generated_at_ns=20_000,
        through_seq=8,
        trading_date="2026-06-01",
        session="globex",
    )

    assert response["limits"]["effective_depth_columns_max"] < 8
    assert response["limits"]["estimated_response_bytes"] <= response["limits"]["max_response_bytes"]


def test_app_replays_latest_depth_before_snapshot_on_ws_connect(tmp_path: Path) -> None:
    async def scenario() -> None:
        app = create_app(Settings(scratch_dir=tmp_path / "scratch"))
        backend = app.state.backend
        await backend.feed.emit_depth(_depth_payload())
        route = next(r for r in app.routes if getattr(r, "path", None) == "/ws")
        websocket = _FakeWebSocket()

        await route.endpoint(websocket)  # type: ignore[attr-defined]

        frames = [json.loads(text) for text in websocket.sent]
        assert frames[0]["payload"]["family"] == "depth"
        assert frames[1]["type"] == "snapshot"
        assert frames[0]["seq"] <= frames[1]["seq"]

    asyncio.run(scenario())


def test_app_exits_quietly_if_ws_disconnects_during_initial_snapshot(tmp_path: Path) -> None:
    async def scenario() -> None:
        app = create_app(Settings(scratch_dir=tmp_path / "scratch"))
        backend = app.state.backend
        route = next(r for r in app.routes if getattr(r, "path", None) == "/ws")
        websocket = _DisconnectOnFirstSendWebSocket()

        await route.endpoint(websocket)  # type: ignore[attr-defined]

        assert websocket.accepted is True
        assert backend.manager.client_count == 0

    asyncio.run(scenario())


def test_depth_poller_emits_without_compute_trigger(tmp_path: Path) -> None:
    root = tmp_path / "analytics"
    capture = root / "data" / "captures" / "2026-05-22" / "MNQ_globex.jsonl"
    mbo_path = capture.with_name("MNQ_globex.mbo.jsonl")
    mbp_path = capture.with_name("MNQ_globex.mbp1.jsonl")
    now_ns = time.time_ns()
    write_raw(capture, [trade(now_ns, 29400.0, 1, "buy")])
    _write_mbo(
        mbo_path,
        [
            _mbo_row(ts_ns=now_ns, action="A", order_id="bid-1", side="B", price=29400.0),
            _mbo_row(ts_ns=now_ns + 1, action="A", order_id="ask-1", side="A", price=29400.25),
        ],
    )
    write_raw(mbp_path, [_quote_row(bid=29400.0, ask=29400.25)])
    zones = root / "data" / "zones" / "2026-05-22_MNQ_globex.json"
    zones.parent.mkdir(parents=True, exist_ok=True)
    zones.write_text(json.dumps(sample_envelope()), encoding="utf-8")

    settings = Settings(
        analytics_root=root,
        scratch_dir=tmp_path / "scratch" / "dashboard",
        ewma_calibration_path=None,
        session_override="globex",
        trading_date_override="2026-05-22",
        poll_fallback_interval_seconds=0.0,
        fast_price_poll_interval_seconds=0.0,
        depth_enabled=True,
        depth_emit_interval_seconds=0.05,
        depth_seed_tail_bytes=10_000,
    )
    results: list[ComputeResult] = []
    depth_payloads: list[DepthPayload] = []
    done = threading.Event()

    def on_depth(payload: DepthPayload) -> None:
        depth_payloads.append(payload)
        done.set()

    watcher = CaptureWatcher(
        settings,
        results.append,
        on_depth=on_depth,
    )
    watcher.start()
    try:
        asyncio.run(_wait_for_thread_event(done))
    finally:
        watcher.stop()

    assert results == []
    assert depth_payloads
    assert depth_payloads[0].quality == "live"
    assert len(depth_payloads[0].bid_levels) <= settings.depth_n_ticks
    assert len(depth_payloads[0].ask_levels) <= settings.depth_n_ticks


async def _wait_for_thread_event(done: threading.Event) -> None:
    deadline = asyncio.get_running_loop().time() + 2.0
    while asyncio.get_running_loop().time() < deadline:
        if done.is_set():
            return
        await asyncio.sleep(0.05)
    raise AssertionError("depth poller did not emit")


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def accept(self) -> None:
        return None

    async def send_text(self, text: str) -> None:
        self.sent.append(text)

    async def receive_text(self) -> str:
        raise WebSocketDisconnect()


class _DisconnectOnFirstSendWebSocket:
    def __init__(self) -> None:
        self.accepted = False

    async def accept(self) -> None:
        self.accepted = True

    async def send_text(self, _text: str) -> None:
        raise WebSocketDisconnect()

    async def receive_text(self) -> str:
        raise AssertionError("receive_text should not be reached")
