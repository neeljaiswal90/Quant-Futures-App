"""The feed engine: monotonic seq, snapshot cache, and tiered emission.

:class:`FeedState` is the single owner of the global monotonic ``seq`` and the
most-recent :class:`~rithmic_dashboard.models.LiveSignals` snapshot. Everything
that emits a frame goes through it so the seq is consistent across the WS feed,
the REST ``/snapshot``, and the heartbeat.

Seq + gap protocol:

- Every emitted frame gets the next ``seq`` (``_next_seq``).
- When a slow client drops queued frames, its own next received ``seq`` jumps by
  more than 1 because the omitted frames already had real sequence numbers.
  Healthy clients keep the normal global stream and are not forced to resync
  because another socket fell behind.
- ``/snapshot`` returns the snapshot at the *current* seq so a resyncing client
  realigns to the live counter.

This module is async but contains no FastAPI / socket types — the app layer
wires :class:`ConnectionManager` and the watcher into it.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

from contracts.realtime.events import (
    DepthPayload,
    HeartbeatPayload,
    OrderflowStats,
    PriceTickPayload,
    RealtimeMessage,
    SnapshotPayload,
    make_message,
)
from rithmic_dashboard.features.recent_signals_panel import RecentSignal
from rithmic_dashboard.models import LiveSignals

from realtime_backend.connection_manager import ConnectionManager
from realtime_backend.price_ticks import LatestPriceTick
from realtime_backend.settings import Settings
from realtime_backend.signals import (
    build_snapshot_payload,
    classify_payloads,
    diff_signals,
    events_to_payloads,
)


@dataclass
class FeedState:
    """Owns seq, the snapshot cache, and the emit pipeline."""

    manager: ConnectionManager
    settings: Settings

    _seq: int = field(default=0, init=False)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False)

    # Snapshot inputs, refreshed by the watcher on each successful compute.
    _last_signals: LiveSignals | None = field(default=None, init=False)
    _last_envelope: dict[str, Any] | None = field(default=None, init=False)
    _last_recent_signals: list[RecentSignal] = field(default_factory=list, init=False)
    _last_append_ts_ns: int | None = field(default=None, init=False)
    _last_current_price: float | None = field(default=None, init=False)
    _last_price_tick_key: tuple[int, float, int] | None = field(default=None, init=False)
    _last_price_tick_had_orderflow: bool = field(default=False, init=False)
    _last_depth_key: tuple[object, ...] | None = field(default=None, init=False)
    _last_depth_message: RealtimeMessage | None = field(default=None, init=False)

    # ----- seq -----------------------------------------------------------

    async def _next_seq(self) -> int:
        self._seq += 1
        return self._seq

    @property
    def current_seq(self) -> int:
        return self._seq

    # ----- snapshot cache ------------------------------------------------

    def update_snapshot_inputs(
        self,
        *,
        signals: LiveSignals,
        envelope: dict[str, Any] | None,
        recent_signals: list[RecentSignal],
        last_append_ts_ns: int | None,
        current_price: float | None = None,
        price_tick: LatestPriceTick | None = None,
    ) -> None:
        """Refresh the cached state used to build snapshots + heartbeats."""
        self._last_signals = signals
        self._last_envelope = envelope
        self._last_recent_signals = recent_signals
        self._last_current_price = current_price
        if last_append_ts_ns is not None:
            self._last_append_ts_ns = last_append_ts_ns
        if self._last_price_tick_key is None and price_tick is not None:
            self._last_price_tick_key = price_tick.dedupe_key

    def build_snapshot_message(self, seq: int | None = None) -> RealtimeMessage:
        """Build a snapshot envelope at ``seq`` (defaults to current seq)."""
        payload: SnapshotPayload = build_snapshot_payload(
            self._last_signals,
            envelope=self._last_envelope,
            recent_signals=self._last_recent_signals,
            current_price=self._last_current_price,
        )
        return make_message(
            type="snapshot",
            payload=payload,
            seq=self.current_seq if seq is None else seq,
        )

    @property
    def last_signals(self) -> LiveSignals | None:
        return self._last_signals

    @property
    def latest_depth_message(self) -> RealtimeMessage | None:
        return self._last_depth_message

    # ----- emission ------------------------------------------------------

    async def _broadcast_and_account(self, message: RealtimeMessage) -> None:
        """Broadcast a message without making slow-client drops global."""
        await self.manager.broadcast(message)

    async def emit_snapshot_to(self, client_send_seq: int | None = None) -> RealtimeMessage:
        """Broadcast a fresh snapshot at the next seq and return it."""
        async with self._lock:
            seq = await self._next_seq()
        message = self.build_snapshot_message(seq=seq)
        await self._broadcast_and_account(message)
        return message

    async def emit_signal_diff(
        self,
        current: LiveSignals,
        *,
        envelope: dict[str, Any] | None,
        recent_signals: list[RecentSignal],
        current_price: float | None,
    ) -> int:
        """Diff against the cached snapshot, emit tiered events, return count.

        Refreshes the snapshot cache afterward (so /snapshot reflects the
        latest) and returns the number of event frames broadcast.
        """
        diff = diff_signals(self._last_signals, current)
        mapped = events_to_payloads(diff, current)
        tiered = classify_payloads(
            mapped,
            recent_signals=recent_signals,
            current_price=current_price,
            max_price_distance=self.settings.max_price_distance,
        )
        emitted = 0
        for event, tier in tiered:
            async with self._lock:
                seq = await self._next_seq()
            message = make_message(
                type=event.message_type,  # type: ignore[arg-type]
                payload=event.payload,
                seq=seq,
                tier=None if event.message_type == "regime" else tier,
            )
            await self._broadcast_and_account(message)
            emitted += 1
        return emitted

    async def emit_price_tick(
        self,
        tick: LatestPriceTick | None,
        *,
        orderflow: OrderflowStats | None = None,
    ) -> RealtimeMessage | None:
        """Broadcast a new trade tick for chart updates, deduped by trade key.

        ``PriceTickPayload.volume`` is the per-trade quantity. The envelope
        ``ts_ns`` is market/trade time for this family so the chart buckets the
        candle on exchange event time; other families retain server-stamped
        event time.
        """
        if tick is None:
            return None
        if tick.observed_at_ns is not None:
            self._last_append_ts_ns = tick.observed_at_ns
        self._last_current_price = tick.price
        if (
            tick.dedupe_key == self._last_price_tick_key
            and (orderflow is None or self._last_price_tick_had_orderflow)
        ):
            return None
        payload = PriceTickPayload(
            price=tick.price,
            bid=tick.bid,
            ask=tick.ask,
            volume=tick.volume,
            orderflow=orderflow,
        )
        async with self._lock:
            seq = await self._next_seq()
        message = make_message(
            type="event",
            payload=payload,
            seq=seq,
            ts_ns=tick.trade_ts_ns,
        )
        await self._broadcast_and_account(message)
        self._last_price_tick_key = tick.dedupe_key
        self._last_price_tick_had_orderflow = orderflow is not None
        return message

    async def emit_depth(self, payload: DepthPayload) -> RealtimeMessage | None:
        """Broadcast a bounded depth snapshot, deduped by visible tick window."""
        key = _depth_dedupe_key(payload)
        if key == self._last_depth_key:
            return None
        async with self._lock:
            seq = await self._next_seq()
        message = make_message(
            type="event",
            payload=payload,
            seq=seq,
            ts_ns=payload.ts_ns,
        )
        await self._broadcast_and_account(message)
        self._last_depth_key = key
        self._last_depth_message = message
        return message

    async def emit_heartbeat(self) -> RealtimeMessage:
        """Broadcast a liveness/staleness heartbeat at the next seq."""
        server_ts_ns = time.time_ns()
        last_append = self._last_append_ts_ns
        stale = self._is_stale(server_ts_ns, last_append)
        payload = HeartbeatPayload(
            server_ts_ns=server_ts_ns,
            last_capture_ts_ns=last_append,
            stale=stale,
        )
        async with self._lock:
            seq = await self._next_seq()
        message = make_message(type="heartbeat", payload=payload, seq=seq)
        await self._broadcast_and_account(message)
        return message

    def _is_stale(self, server_ts_ns: int, last_append_ns: int | None) -> bool:
        """True if the capture hasn't appended within the staleness threshold."""
        if last_append_ns is None:
            return True
        age_s = (server_ts_ns - last_append_ns) / 1_000_000_000
        return age_s > self.settings.staleness_threshold_seconds


def _depth_dedupe_key(payload: DepthPayload) -> tuple[object, ...]:
    """Hash the visible depth window on tick-grid mid, not raw sub-tick mid."""
    mid_bucket = None if payload.mid is None else round(payload.mid / 0.25)
    bids = tuple((level.price, level.size) for level in payload.bid_levels)
    asks = tuple((level.price, level.size) for level in payload.ask_levels)
    return (mid_bucket, payload.quality, payload.n_ticks, bids, asks)


__all__ = ["FeedState"]
