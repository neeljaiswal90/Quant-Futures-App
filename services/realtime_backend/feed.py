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
    AbsorptionPayload,
    AuctionStatePayload,
    DepthPayload,
    HeartbeatPayload,
    IcebergPayload,
    OrderflowStats,
    PriceTickPayload,
    RealtimeMessage,
    SnapshotPayload,
    SweepPayload,
    make_message,
)
from rithmic_dashboard.features.recent_signals_panel import RecentSignal
from rithmic_dashboard.models import LiveSignals

from realtime_backend.connection_manager import ConnectionManager
from realtime_backend.history import BookmapHistory
from realtime_backend.persistent_levels import PersistentLevelDetector
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
    _bookmap_history: BookmapHistory = field(default_factory=BookmapHistory, init=False)
    # RA-108: session-long persistent-levels detector. Observes the contract
    # IcebergPayload / AbsorptionPayload / SweepPayload events as they emit
    # and aggregates evidence to emit PersistentLevelPayload events when a
    # level crosses a confidence threshold or transitions status.
    _persistent_level_detector: PersistentLevelDetector = field(
        default_factory=PersistentLevelDetector,
        init=False,
    )
    # RA-112e step 3: track the auction-vs-value state across diffs so we only
    # broadcast an AuctionStatePayload on real transitions (not every cycle).
    _last_auction_state: str | None = field(default=None, init=False)
    # RA-112e step 4: cached v3 + v2-legacy shelves from the latest compute
    # pass. build_snapshot_payload reads from here so cold-start clients see
    # populated shelves on the first WS frame; the realtime backend keeps
    # this in sync via update_snapshot_inputs.
    _last_shelves: list[dict[str, Any]] = field(default_factory=list, init=False)
    _last_cap_bind_flags: dict[str, bool] = field(default_factory=dict, init=False)
    # RA-112e step 5: Globex/RTH split. Cached tactical status (live | warmup |
    # no_data) so SnapshotPayload reflects the most-recent compute pass.
    _last_tactical_status: str | None = field(default=None, init=False)
    _last_tactical_tape_minutes: float | None = field(default=None, init=False)

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
        shelves: list[dict[str, Any]] | None = None,
        cap_bind_flags: dict[str, bool] | None = None,
        tactical_status: str | None = None,
        tactical_tape_minutes: float | None = None,
    ) -> None:
        """Refresh the cached state used to build snapshots + heartbeats.

        ``shelves`` + ``cap_bind_flags`` (RA-112e step 4) are passed as plain
        dict shapes (the wire shape) so this module stays free of the v3
        compute's dataclass types. ``None`` leaves the existing cache intact —
        the orchestrator only updates these when a v3 compute succeeded.
        """
        self._last_signals = signals
        self._last_envelope = envelope
        self._last_recent_signals = recent_signals
        self._last_current_price = current_price
        if last_append_ts_ns is not None:
            self._last_append_ts_ns = last_append_ts_ns
        if self._last_price_tick_key is None and price_tick is not None:
            self._last_price_tick_key = price_tick.dedupe_key
        if shelves is not None:
            self._last_shelves = shelves
        if cap_bind_flags is not None:
            self._last_cap_bind_flags = cap_bind_flags
        if tactical_status is not None:
            self._last_tactical_status = tactical_status
        if tactical_tape_minutes is not None:
            self._last_tactical_tape_minutes = tactical_tape_minutes

    def build_snapshot_message(self, seq: int | None = None) -> RealtimeMessage:
        """Build a snapshot envelope at ``seq`` (defaults to current seq)."""
        payload: SnapshotPayload = build_snapshot_payload(
            self._last_signals,
            envelope=self._last_envelope,
            recent_signals=self._last_recent_signals,
            current_price=self._last_current_price,
            shelves=self._last_shelves,
            cap_bind_flags=self._last_cap_bind_flags,
            tactical_status=self._last_tactical_status,
            tactical_tape_minutes=self._last_tactical_tape_minutes,
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

    async def bookmap_backfill_payload(self) -> dict[str, Any]:
        """Return a compact REST hydration payload for browser reload/reconnect."""

        async with self._lock:
            generated_at_ns = time.time_ns()
            session_date = None
            session_name = None
            envelope = self._last_envelope
            if isinstance(envelope, dict):
                raw_date = envelope.get("trading_date")
                raw_session = envelope.get("session")
                session_date = str(raw_date) if raw_date is not None else None
                session_name = str(raw_session) if raw_session is not None else None
            return self._bookmap_history.to_response(
                generated_at_ns=generated_at_ns,
                through_seq=self.current_seq,
                trading_date=session_date,
                session=session_name,
            )

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
        # RA-108: collect persistent-level events produced by the detector
        # observing each signal-family event. We emit them AFTER the
        # original event so the operator sees the trigger event chip
        # followed by any structural-level promotion / transition.
        persistent_level_emissions: list[Any] = []
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
            # RA-108: feed the emitted contract payload into the detector.
            # Returns a PersistentLevelPayload iff this observation crossed
            # a promotion threshold or transitioned the level's status.
            payload = event.payload
            ts_ns = message.ts_ns
            observed: Any = None
            if isinstance(payload, IcebergPayload):
                observed = self._persistent_level_detector.observe_iceberg(payload, ts_ns)
            elif isinstance(payload, AbsorptionPayload):
                observed = self._persistent_level_detector.observe_absorption(payload, ts_ns)
            elif isinstance(payload, SweepPayload):
                observed = self._persistent_level_detector.observe_sweep(payload, ts_ns)
            if observed is not None:
                persistent_level_emissions.append(observed)

        # RA-108: periodic lifecycle check — promotes active levels with no
        # recent evidence to deteriorating. Done once per diff emit so
        # transitions ride the same broadcast cycle as regular signal events.
        now_ns = time.time_ns()
        persistent_level_emissions.extend(
            self._persistent_level_detector.tick(now_ts_ns=now_ns)
        )

        for level_payload in persistent_level_emissions:
            async with self._lock:
                seq = await self._next_seq()
            message = make_message(
                type="event",
                payload=level_payload,
                seq=seq,
                tier=None,
            )
            await self._broadcast_and_account(message)
            emitted += 1

        # RA-112e step 3: broadcast an AuctionStatePayload when the rolling-
        # anchor-vs-value classification transitions. The chip on the
        # dashboard reads this between snapshot refreshes; cold-start state
        # comes from SnapshotPayload.auction_vs_value.
        auction_payload = self._build_auction_transition(current, envelope)
        if auction_payload is not None:
            async with self._lock:
                seq = await self._next_seq()
            message = make_message(
                type="event",
                payload=auction_payload,
                seq=seq,
                tier=None,
            )
            await self._broadcast_and_account(message)
            emitted += 1
            self._last_auction_state = auction_payload.state

        return emitted

    def _build_auction_transition(
        self,
        signals: LiveSignals,
        envelope: dict[str, Any] | None,
    ) -> AuctionStatePayload | None:
        """Return an AuctionStatePayload iff the auction-vs-value state changed."""
        if envelope is None:
            return None
        anchor = signals.live_vwap.vwap if signals.live_vwap is not None else None
        vah = envelope.get("vah")
        val = envelope.get("val")
        if anchor is None or vah is None or val is None:
            return None
        try:
            anchor_f = float(anchor)
            vah_f = float(vah)
            val_f = float(val)
        except (TypeError, ValueError):
            return None
        from realtime_backend.zone_snapshots import classify_rolling_anchor_vs_value
        state, dist = classify_rolling_anchor_vs_value(
            anchor_f, vah=vah_f, val=val_f
        )
        if state == self._last_auction_state:
            return None
        return AuctionStatePayload(
            state=state,  # type: ignore[arg-type]
            distance_ticks=dist,
            prior_state=self._last_auction_state,  # type: ignore[arg-type]
            anchor_price=anchor_f,
            vah=vah_f,
            val=val_f,
        )

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
        async with self._lock:
            seq = await self._next_seq()
            payload = PriceTickPayload(
                price=tick.price,
                bid=tick.bid,
                ask=tick.ask,
                volume=tick.volume,
                orderflow=orderflow,
            )
            message = make_message(
                type="event",
                payload=payload,
                seq=seq,
                ts_ns=tick.trade_ts_ns,
            )
            self._bookmap_history.upsert_price_tick(
                seq=seq,
                tick=tick,
                orderflow=orderflow,
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
            self._bookmap_history.append_depth(
                seq=seq,
                payload=payload,
                dedupe_key=key,
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
