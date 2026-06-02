"""FastAPI application wiring — the WS surface RA-067's mock specifies.

Mirrors ``contracts/realtime/mock_emitter.py`` exactly: ``GET /health``,
``GET /snapshot``, and ``WebSocket /ws``. Swapping the UI/daemon from mock to
this backend should require only a URL change.

Wiring (assembled in the lifespan):

- :class:`ConnectionManager` fans frames out to clients with per-client
  bounded queues (drop-oldest).
- :class:`FeedState` owns the monotonic seq + snapshot cache + tier policy.
- :class:`CaptureWatcher` runs the detectors on a worker thread; its results
  are marshaled onto the event loop via ``loop.call_soon_threadsafe`` and fed
  to ``FeedState.emit_signal_diff``.
- A heartbeat task emits liveness/staleness on a timer.

On WS connect we replay the current ``/snapshot`` frame so a fresh client (or
one that reconnected after a seq gap) starts aligned to the live counter.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator

from contracts.realtime.events import DepthPayload, ErrorPayload, make_message
from fastapi import BackgroundTasks, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse

from realtime_backend.config.router import create_config_router
from realtime_backend.config.store import AlertConfigStore
from realtime_backend.connection_manager import ConnectionManager
from realtime_backend.feed import FeedState
from realtime_backend.methodology_health import MethodologyHealthAccumulator
from realtime_backend.orderflow import build_orderflow_stats
from realtime_backend.price_ticks import LatestPriceTick
from realtime_backend.settings import Settings, settings_from_env
from realtime_backend.shutdown import EndDayShutdownService, ShutdownTarget
from realtime_backend.watcher import CaptureWatcher, ComputeResult
from realtime_backend.zone_snapshots import (
    ReferenceLine,
    SCHEMA_VERSION as ZONE_SNAPSHOT_SCHEMA_VERSION,
    SessionAnchors,
    Shelf,
    TacticalAnchor,
    ZoneSnapshot,
    ZoneSnapshotParams,
    ZoneSnapshotStream,
    classify_rolling_anchor_vs_value,
)
from realtime_backend.sigma_zones_v3 import (
    METHOD_VERSION_V3,
    ZoneShelvesResult,
    compute_zone_shelves,
)
from realtime_backend.zone_touches import (
    OutcomeTracker,
    RollingFeatureAccumulator,
    SCHEMA_VERSION as ZONE_TOUCH_SCHEMA_VERSION,
    Touch,
    TouchDetector,
    TouchEvent,
    ZoneTouchStream,
    monitored_levels_from_snapshot_dict,
)

logger = logging.getLogger("ra60.realtime_backend")


# RA-112e: bumped together with any schema-relevant change to ZoneSnapshot.
_ZONE_METHOD_VERSIONS: dict[str, str] = {
    "tactical": METHOD_VERSION_V3,   # v3.0.0 — VWAP-anchored shelves live.
    "legacy": "v2.0.0",
    "stream_schema": str(ZONE_SNAPSHOT_SCHEMA_VERSION),
}


def _build_zone_snapshot_candidate(
    *,
    result: ComputeResult,
    params: ZoneSnapshotParams,
    now_ts_ns: int,
    symbol: str,
    shelves_result: ZoneShelvesResult | None = None,
) -> ZoneSnapshot:
    """Project a ComputeResult + optional shelf compute into the snapshot
    schema. When shelves_result is None, the shelf-related fields ship as
    empty containers (matches the step-1 baseline behavior; the touch
    detector falls back to reference-line-only monitoring)."""
    envelope = result.envelope or {}
    vah = _as_float(envelope.get("vah"))
    val = _as_float(envelope.get("val"))
    vpoc = _as_float(envelope.get("vpoc"))
    atr_14_5m = _as_float(envelope.get("atr_14"))

    live_vwap = result.signals.live_vwap
    window_minutes = (
        live_vwap.window_minutes if live_vwap is not None else params.vwap_window_minutes
    )
    last_ts = result.last_append_ts_ns or now_ts_ns
    # RA-112e step 4: when v3 shelves are computed this cycle, source the
    # tactical anchor from the same compute so the snapshot's `tactical_anchor`
    # and `shelves[*].low`/`high` reference IDENTICAL anchor values. Falling
    # back to LiveSignals.live_vwap.vwap when no shelves are available keeps
    # the anchor populated for the step-1 baseline path.
    if shelves_result is not None:
        anchor_value: float | None = float(shelves_result.anchor)
    elif live_vwap is not None:
        anchor_value = live_vwap.vwap
    else:
        anchor_value = None
    if anchor_value is None:
        tactical_anchor: TacticalAnchor | None = None
    else:
        tactical_anchor = TacticalAnchor(
            method=f"vwap_w_{window_minutes}m",
            value=float(anchor_value),
            window_start_ts_ns=last_ts - window_minutes * 60 * 1_000_000_000,
            window_end_ts_ns=last_ts,
        )

    state, distance = classify_rolling_anchor_vs_value(
        anchor_value, vah=vah, val=val, tick_size=params.tick_size
    )

    reference_lines = tuple(
        ReferenceLine(
            source=str(line.get("source", "")),
            price=float(line["price"]),
            label=str(line.get("text", line.get("source", ""))),
        )
        for line in envelope.get("reference_lines", [])
        if isinstance(line, dict) and line.get("price") is not None
    )

    # RA-112e step 4: project v3 + v2-legacy shelves onto the snapshot.
    shelves_tuple: tuple[Shelf, ...] = ()
    cap_bind_flags: dict[str, bool] = {}
    bound_source: dict[str, str] = {}
    atr_14_60m: float | None = None
    atr_cap: float | None = None
    if shelves_result is not None:
        shelves_tuple = tuple(
            Shelf(
                family=s.family,
                name=s.name,
                low=s.low,
                high=s.high,
                tier=s.tier,
                bound_source=s.bound_source,
                cap_bound=s.cap_bound,
                overlaps_vah=s.overlaps_vah,
                overlaps_val=s.overlaps_val,
                nearest_structural_level=s.nearest_structural_level,
                distance_to_structural_level_ticks=s.distance_to_structural_level_ticks,
            )
            for s in shelves_result.shelves
        )
        cap_bind_flags = dict(shelves_result.cap_bind_flags)
        bound_source = dict(shelves_result.bound_source)
        atr_14_60m = shelves_result.atr_14_60m
        atr_cap = shelves_result.atr_cap

    return ZoneSnapshot(
        schema_version=ZONE_SNAPSHOT_SCHEMA_VERSION,
        zone_snapshot_seq=0,  # restamped by the stream.
        as_of_ts_ns=now_ts_ns,
        input_cutoff_ts_ns=last_ts,
        emit_reason="pending",  # restamped by the stream.
        symbol=symbol,
        session=result.session,
        method_versions=dict(_ZONE_METHOD_VERSIONS),
        params_hash=params.hash(),
        session_anchors=SessionAnchors(
            vah=vah,
            val=val,
            vpoc=vpoc,
            atr_14_5m=atr_14_5m,
            atr_14_60m=atr_14_60m,
            atr_cap=atr_cap,
        ),
        tactical_anchor=tactical_anchor,
        rolling_anchor_vs_session_value=state,
        rolling_anchor_distance_ticks=distance,
        shelves=shelves_tuple,
        reference_lines=reference_lines,
        cap_bind_flags=cap_bind_flags,
        bound_source=bound_source,
    )


def _tactical_status_from(shelves_result: ZoneShelvesResult | None) -> str | None:
    """Project a ZoneShelvesResult onto the contract's TacticalStatus enum.

    None -> "no_data" (no v3 shelves available this cycle — the snapshot
    ships shelves=[] and the dashboard hides the σ ladder).
    is_warmup -> "warmup" (shelves available but trailing window too short
    for stable σ; UI should render them dimmed/labelled).
    else -> "live".
    """
    if shelves_result is None:
        return "no_data"
    return "warmup" if shelves_result.is_warmup else "live"


def _shelf_to_dict(s: Any) -> dict[str, Any]:
    """Convert a ShelfDescriptor to the wire-shape dict the contract Shelf
    model accepts. Stays small + explicit rather than dataclasses.asdict so we
    don't accidentally leak internal fields if ShelfDescriptor grows later."""
    return {
        "family": s.family,
        "name": s.name,
        "low": s.low,
        "high": s.high,
        "tier": s.tier,
        "bound_source": s.bound_source,
        "cap_bound": s.cap_bound,
        "overlaps_vah": s.overlaps_vah,
        "overlaps_val": s.overlaps_val,
        "nearest_structural_level": s.nearest_structural_level,
        "distance_to_structural_level_ticks": s.distance_to_structural_level_ticks,
    }


def _as_float(value: object) -> float | None:
    if value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if result != result:  # NaN
        return None
    return result


class RealtimeBackend:
    """Holds the long-lived objects and the loop/thread plumbing."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.manager = ConnectionManager(client_queue_maxsize=settings.client_queue_maxsize)
        self.feed = FeedState(manager=self.manager, settings=settings)
        # RA-068: one shared AlertConfigStore backs both the REST surface
        # (RA-063 router) and any gating path, so a PUT is visible on the next
        # read with no restart. Persists to data/dashboard/alert_config.json —
        # the same file the RA-062 daemon reads.
        self.config_store = AlertConfigStore()
        self.watcher: CaptureWatcher | None = None
        self._heartbeat_task: asyncio.Task[None] | None = None
        # RA-112e step 7: live MBP1 pulse broadcaster.
        self._mbp_pulse_task: asyncio.Task[None] | None = None
        # RA-112e step 8: methodology-health accumulator + broadcaster.
        # Fed from _record_zone_snapshot on every compute pass; broadcast
        # to clients on a slow cadence (default 10s) by _methodology_health_loop.
        self._methodology_health = MethodologyHealthAccumulator(
            window_seconds=settings.methodology_health_window_seconds,
        )
        self._methodology_health_task: asyncio.Task[None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        # RA-112e: append-only as-of zone-snapshot stream.
        # Resolve relative paths against the project root (two levels up from
        # analytics_root) so the streams land in the repo's data/ dir regardless
        # of where the backend was launched from. Absolute settings paths
        # (e.g. tmp_path in tests) short-circuit the anchor.
        self._zone_snapshot_stream = ZoneSnapshotStream(
            self._resolve_data_path(settings.zone_snapshot_dir),
            symbol=settings.zone_snapshot_symbol,
        )
        # Reasonable step-1 defaults; the values that don't yet have a live
        # source (cap timeframe, etc.) stay constant so params_hash is stable.
        self._zone_snapshot_params = ZoneSnapshotParams(
            vwap_window_minutes=settings.vwap_window_minutes,
            cap_atr_fraction=0.5,
            va_pct=0.70,
            atr_period=14,
            atr_bar_size_min_bin=5,
            atr_bar_size_min_cap=60,
            bin_size_ticks=20,
            bin_size_mode="adaptive",
        )
        # RA-112e step 2: zone-touch + outcome event logger.
        self._zone_touch_stream = ZoneTouchStream(
            self._resolve_data_path(settings.zone_touch_root),
            symbol=settings.zone_snapshot_symbol,
        )
        self._touch_detector = TouchDetector()
        self._feature_accumulator = RollingFeatureAccumulator()
        self._outcome_tracker = OutcomeTracker(
            write_row=self._zone_touch_stream.write_outcome,
        )
        # The compute-rate path and the fast-poller path both surface price
        # ticks. Dedupe by trade_ts_ns so the touch pipeline sees each tick
        # exactly once regardless of which producer ran first.
        self._last_touch_processed_ts_ns: int | None = None
        # RA-112e step 4: most-recent 60-min ATR(14) produced by a successful
        # v3 compute. Used as a fallback when a fresh session's tape is too
        # young for 14 hours of 60-min bars.
        # RA-112e step 5: keyed by session ("globex" / "rth") so an RTH
        # session falls back to the prior RTH's ATR (which captures RTH-vol
        # characteristics), not the prior Globex's. RTH-only tape never has
        # 14h of bars so it relies on this cross-session memory.
        self._prior_atr_60m_by_session: dict[str, float] = {}

    def _resolve_data_path(self, configured: Any) -> Any:
        """Anchor a relative data-dir setting on the project root.

        Absolute paths are returned untouched (tests pass tmp_path; operators
        can override with an absolute path in env). Relative paths are
        resolved against ``analytics_root.parent.parent`` — for the standard
        layout that's ``D:\\Quant-futures-app`` — so the streams land under
        the repo's ``data/`` dir regardless of the backend's launch CWD.
        """
        from pathlib import Path
        path = Path(configured)
        if path.is_absolute():
            return path
        project_root = Path(self.settings.analytics_root).resolve().parent.parent
        return project_root / path

    # ----- watcher → loop marshaling ------------------------------------

    def _on_result_threadsafe(self, result: ComputeResult) -> None:
        """Called from the watcher worker thread; hop onto the loop."""
        loop = self._loop
        if loop is None:
            return
        loop.call_soon_threadsafe(
            lambda: asyncio.ensure_future(self._handle_result(result))
        )

    def _on_error_threadsafe(self, exc: Exception) -> None:
        loop = self._loop
        if loop is None:
            logger.warning("watcher error before loop ready: %s", exc)
            return
        loop.call_soon_threadsafe(
            lambda: asyncio.ensure_future(self._handle_error(exc))
        )

    def _on_price_tick_threadsafe(self, tick: LatestPriceTick) -> None:
        """Fast-price callback from watcher thread; emits orderflow=null."""
        loop = self._loop
        if loop is None:
            return
        loop.call_soon_threadsafe(
            lambda: asyncio.ensure_future(self._handle_fast_price_tick(tick))
        )

    def _on_depth_threadsafe(self, payload: DepthPayload) -> None:
        """Depth callback from watcher thread; emits a bounded depth snapshot."""
        loop = self._loop
        if loop is None:
            return
        loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self._handle_depth(payload)))

    async def _handle_result(self, result: ComputeResult) -> None:
        """Diff + emit tiered events, then refresh the snapshot cache."""
        try:
            await self.feed.emit_price_tick(
                result.price_tick,
                orderflow=build_orderflow_stats(result.signals, result.price_tick),
            )
            await self.feed.emit_signal_diff(
                result.signals,
                envelope=result.envelope,
                recent_signals=result.recent_signals,
                current_price=result.current_price,
            )
        finally:
            # RA-112e: as-of snapshot + v3 shelf compute. Done BEFORE
            # update_snapshot_inputs so the latest shelves land in the WS
            # snapshot cache.
            shelves_result = await self._record_zone_snapshot(result)
            self.feed.update_snapshot_inputs(
                signals=result.signals,
                envelope=result.envelope,
                recent_signals=result.recent_signals,
                last_append_ts_ns=result.last_append_ts_ns,
                current_price=result.current_price,
                price_tick=result.price_tick,
                shelves=(
                    [_shelf_to_dict(s) for s in shelves_result.shelves]
                    if shelves_result is not None else None
                ),
                cap_bind_flags=(
                    dict(shelves_result.cap_bind_flags)
                    if shelves_result is not None else None
                ),
                tactical_status=_tactical_status_from(shelves_result),
                tactical_tape_minutes=(
                    shelves_result.tape_minutes
                    if shelves_result is not None else None
                ),
            )
            # RA-112e step 2: also feed the compute-rate price tick into the
            # touch logger. Idempotent: a higher-rate fast-poller call with
            # the same trade_ts_ns is swallowed by the dedupe guard.
            if result.price_tick is not None:
                await asyncio.to_thread(
                    self._ingest_price_tick_for_touches, result.price_tick
                )

    async def _record_zone_snapshot(
        self, result: ComputeResult
    ) -> ZoneShelvesResult | None:
        """Project the compute result into a ZoneSnapshot and emit-if-material.

        Safe to call after every compute pass; the stream's policy debounces.
        Failures are logged and swallowed so a write hiccup never blanks the feed.
        Also refreshes the touch detector's monitored level set when the
        snapshot is the latest one — the detector reads zone state from here.

        Returns the v3 shelf compute result (or None on failure) so the caller
        can cache it on FeedState for the WS SnapshotPayload (RA-112e step 4c).
        """
        shelves_result: ZoneShelvesResult | None = None
        try:
            # RA-112e step 4: compute v3 + v2 shelves from the live tape.
            # The compute is sync + I/O-heavy (tape tail read + ATR + σ);
            # offload to a thread so the event loop is never blocked.
            shelves_result = await self._compute_shelves(result)
            if shelves_result is not None and shelves_result.atr_cap_source == "computed":
                # RA-112e step 5: remember the value KEYED BY SESSION. An RTH
                # session is structurally too short for ATR(14, 60m) to ever
                # compute from RTH-only tape, so its fallback chain depends
                # on this per-session memory persisting across globex→rth.
                self._prior_atr_60m_by_session[result.session] = (
                    shelves_result.atr_14_60m
                )

            candidate = _build_zone_snapshot_candidate(
                result=result,
                params=self._zone_snapshot_params,
                now_ts_ns=time.time_ns(),
                symbol=self.settings.zone_snapshot_symbol,
                shelves_result=shelves_result,
            )
            emitted = await asyncio.to_thread(
                self._zone_snapshot_stream.maybe_emit, candidate
            )
            # Refresh detector level set from the latest snapshot's reference
            # lines + shelves. Done unconditionally even if maybe_emit chose
            # to throttle — the in-memory levels track the latest known state.
            self._touch_detector.update_levels(
                monitored_levels_from_snapshot_dict(candidate.to_dict())
            )
            # RA-112e step 8: feed the methodology-health accumulator. We
            # observe EVERY compute pass (not just emitted ones) so cap-bind
            # rate / cross-anchor rate reflect the real geometry frequency,
            # not the throttled emit cadence. ``emitted`` is the bool result
            # from maybe_emit so emit_rate_per_minute still tracks broadcasts.
            self._observe_methodology_health(
                candidate=candidate,
                shelves_result=shelves_result,
                emitted=bool(emitted),
            )
        except Exception as exc:  # noqa: BLE001 — isolate persistence failures
            logger.warning("zone snapshot emit failed: %s", exc)
        return shelves_result

    async def _compute_shelves(
        self, result: ComputeResult
    ) -> ZoneShelvesResult | None:
        """Run the v3 shelf compute against the live tape. Returns None on
        any non-fatal failure (no capture path, no envelope, etc.) — the
        snapshot pipeline ships empty shelves on None and downstream
        consumers stay tolerant."""
        if result.capture_path is None:
            return None
        envelope = result.envelope or {}
        vah = _as_float(envelope.get("vah"))
        val = _as_float(envelope.get("val"))
        vpoc = _as_float(envelope.get("vpoc"))
        bin_size_ticks = envelope.get("bin_size_ticks") or 8
        if vah is None or val is None or vpoc is None:
            return None
        # RA-112e step 5: pick the prior ATR by SESSION first; fall back to
        # whatever the OTHER session last produced if the current one has no
        # history yet (e.g. cold start before any RTH compute has run).
        prior_atr = self._prior_atr_60m_by_session.get(result.session)
        if prior_atr is None:
            # any other session's value beats DEFAULT_PRIOR_ATR_60M on cold start
            for v in self._prior_atr_60m_by_session.values():
                prior_atr = v
                break
        try:
            return await asyncio.to_thread(
                compute_zone_shelves,
                capture_path=result.capture_path,
                vah=vah,
                val=val,
                vpoc=vpoc,
                bin_size_ticks=int(bin_size_ticks),
                prior_atr_60m=prior_atr,
                reference_lines=envelope.get("reference_lines", []),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("v3 shelf compute failed: %s", exc)
            return None

    def _ingest_price_tick_for_touches(self, tick: LatestPriceTick) -> None:
        """Feed a price tick to the touch logger pipeline.

        Idempotent: ticks repeated at the same ``trade_ts_ns`` are swallowed so
        the compute-rate path and the fast-poller path can both call us safely.

        Runs synchronously (deque ops + simple arithmetic + JSONL append).
        Caller invokes via ``asyncio.to_thread`` so the event loop never blocks.
        """
        ts_ns = tick.trade_ts_ns
        if (
            self._last_touch_processed_ts_ns is not None
            and ts_ns <= self._last_touch_processed_ts_ns
        ):
            return
        self._last_touch_processed_ts_ns = ts_ns
        self._feature_accumulator.on_trade(
            ts_ns=ts_ns,
            price=tick.price,
            volume=tick.volume,
            aggressor_side=tick.aggressor_side,
        )
        touches = self._touch_detector.on_price_tick(
            price=tick.price, ts_ns=ts_ns
        )
        self._outcome_tracker.on_price_tick(price=tick.price, ts_ns=ts_ns)
        for touch in touches:
            try:
                self._dispatch_touch(touch)
            except Exception as exc:  # noqa: BLE001
                logger.warning("touch dispatch failed: %s", exc)

    def _dispatch_touch(self, touch: Touch) -> None:
        """Write a touch event + register outcomes. Synchronous I/O."""
        ts_ns = touch.touch_ts_ns
        event_id = self._zone_touch_stream.next_event_id(
            session=self._touch_detector_session(), ts_ns=ts_ns
        )
        features = self._feature_accumulator.features_at(ts_ns)
        event = TouchEvent(
            schema_version=ZONE_TOUCH_SCHEMA_VERSION,
            event_id=event_id,
            touch_event_seq=self._zone_touch_stream.touch_seq,
            touch_ts_ns=ts_ns,
            symbol=self.settings.zone_snapshot_symbol,
            session=self._touch_detector_session(),
            zone_snapshot_seq=self._zone_snapshot_stream.current_seq,
            zone_id=touch.level.zone_id,
            zone_family=touch.level.zone_family,
            zone_low=touch.level.low,
            zone_high=touch.level.high,
            touch_price=touch.touch_price,
            approach_side=touch.approach_side,
            expected_bounce_direction=touch.expected_bounce_direction,
            pre_touch_features=features,
            method_versions=dict(_ZONE_METHOD_VERSIONS),
        )
        self._zone_touch_stream.write_touch(event)
        self._outcome_tracker.register_touch(event)

    def _touch_detector_session(self) -> str:
        """Return the session label the touch logger is currently scoped to."""
        return self._zone_snapshot_stream.current_session or "unknown"

    async def _handle_fast_price_tick(self, tick: LatestPriceTick) -> None:
        await self.feed.emit_price_tick(tick, orderflow=None)
        await asyncio.to_thread(self._ingest_price_tick_for_touches, tick)

    async def _handle_depth(self, payload: DepthPayload) -> None:
        await self.feed.emit_depth(payload)
        # Pipe top-of-book sizes into the feature accumulator so depth
        # imbalance / microprice are populated for the next touch.
        top_bid = payload.bid_levels[0] if payload.bid_levels else None
        top_ask = payload.ask_levels[0] if payload.ask_levels else None
        await asyncio.to_thread(
            self._feature_accumulator.on_depth,
            ts_ns=payload.ts_ns,
            bid_price=top_bid.price if top_bid is not None else None,
            ask_price=top_ask.price if top_ask is not None else None,
            bid_size=float(top_bid.size) if top_bid is not None else None,
            ask_size=float(top_ask.size) if top_ask is not None else None,
        )

    async def _handle_error(self, exc: Exception) -> None:
        logger.warning("detector pass failed: %s", exc)
        message = make_message(
            type="error",
            payload=ErrorPayload(code="detector_error", message=str(exc)),
            seq=self.feed.current_seq + 1,
        )
        with contextlib.suppress(Exception):
            await self.manager.broadcast(message)

    # ----- heartbeat -----------------------------------------------------

    async def _heartbeat_loop(self) -> None:
        interval = self.settings.heartbeat_interval_seconds
        try:
            while True:
                await asyncio.sleep(interval)
                await self.feed.emit_heartbeat()
        except asyncio.CancelledError:
            raise

    async def _mbp_pulse_loop(self) -> None:
        """RA-112e step 7: ~1Hz live MBP1 pulse from the feature accumulator.

        Cadence is independent of the compute cycle. Failures are swallowed
        so a transient pulse hiccup never wedges the loop.
        """
        interval = self.settings.mbp_pulse_interval_seconds
        try:
            while True:
                await asyncio.sleep(interval)
                try:
                    pulse = self._feature_accumulator.current_pulse(
                        time.time_ns()
                    )
                    await self.feed.emit_mbp_pulse(pulse.to_dict())
                except Exception as exc:  # noqa: BLE001
                    logger.warning("mbp pulse emit failed: %s", exc)
        except asyncio.CancelledError:
            raise

    # ----- methodology health (step 8) ----------------------------------

    def _observe_methodology_health(
        self,
        *,
        candidate: ZoneSnapshot,
        shelves_result: ZoneShelvesResult | None,
        emitted: bool,
    ) -> None:
        """Project a zone-snapshot candidate into the methodology-health
        accumulator. Called from _record_zone_snapshot on every compute pass
        — emit-or-not — so the rates reflect the real geometry frequency."""
        try:
            anchor_value: float | None = (
                candidate.tactical_anchor.value
                if candidate.tactical_anchor is not None
                else None
            )
            self._methodology_health.observe(
                ts_ns=candidate.as_of_ts_ns,
                emitted=emitted,
                auction_state=candidate.rolling_anchor_vs_session_value,
                tactical_status=_tactical_status_from(shelves_result),
                shelves=[
                    {
                        "family": s.family,
                        "name": s.name,
                        "low": s.low,
                        "high": s.high,
                    }
                    for s in candidate.shelves
                ],
                cap_bind_flags=dict(candidate.cap_bind_flags or {}),
                anchor=anchor_value,
            )
        except Exception as exc:  # noqa: BLE001 — diagnostics never fail compute
            logger.warning("methodology health observe failed: %s", exc)

    async def _methodology_health_loop(self) -> None:
        """RA-112e step 8: broadcast the rolling diagnostics on a slow cadence.

        Default 10s — slow enough that React isn't churning, fast enough that
        a regression in cap_bind_rate or shelf_cross_anchor_failure_rate is
        visible to the operator within a sub-minute window.
        """
        interval = self.settings.methodology_health_interval_seconds
        try:
            while True:
                await asyncio.sleep(interval)
                try:
                    metrics = self._methodology_health.metrics(time.time_ns())
                    await self.feed.emit_methodology_health(metrics)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "methodology health emit failed: %s", exc
                    )
        except asyncio.CancelledError:
            raise

    # ----- lifespan ------------------------------------------------------

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self.watcher = CaptureWatcher(
            self.settings,
            self._on_result_threadsafe,
            on_price_tick=self._on_price_tick_threadsafe,
            on_depth=self._on_depth_threadsafe,
            on_error=self._on_error_threadsafe,
        )
        # Seed one compute up-front (blocking, off the loop) so /snapshot has
        # state immediately. Tolerate failure — heartbeat will report stale.
        try:
            seed = await asyncio.to_thread(self.watcher.seed)
            # RA-112e: seed the zone-snapshot stream with the boot state so
            # the JSONL file always opens with a session_open record. Run
            # BEFORE update_snapshot_inputs so the seed shelves land in the
            # WS SnapshotPayload cache from the very first frame.
            seed_shelves = await self._record_zone_snapshot(seed)
            self.feed.update_snapshot_inputs(
                signals=seed.signals,
                envelope=seed.envelope,
                recent_signals=seed.recent_signals,
                last_append_ts_ns=seed.last_append_ts_ns,
                current_price=seed.current_price,
                price_tick=seed.price_tick,
                shelves=(
                    [_shelf_to_dict(s) for s in seed_shelves.shelves]
                    if seed_shelves is not None else None
                ),
                cap_bind_flags=(
                    dict(seed_shelves.cap_bind_flags)
                    if seed_shelves is not None else None
                ),
                tactical_status=_tactical_status_from(seed_shelves),
                tactical_tape_minutes=(
                    seed_shelves.tape_minutes
                    if seed_shelves is not None else None
                ),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("initial seed compute failed: %s", exc)
        self.watcher.start()
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        self._mbp_pulse_task = asyncio.create_task(self._mbp_pulse_loop())
        self._methodology_health_task = asyncio.create_task(
            self._methodology_health_loop()
        )

    async def stop(self) -> None:
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._heartbeat_task
            self._heartbeat_task = None
        if self._mbp_pulse_task is not None:
            self._mbp_pulse_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._mbp_pulse_task
            self._mbp_pulse_task = None
        if self._methodology_health_task is not None:
            self._methodology_health_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._methodology_health_task
            self._methodology_health_task = None
        if self.watcher is not None:
            await asyncio.to_thread(self.watcher.stop)
            self.watcher = None
        # RA-112e: flush + close the zone-snapshot file handle. Idempotent.
        with contextlib.suppress(Exception):
            await asyncio.to_thread(self._zone_snapshot_stream.close)
        # RA-112e step 2: flush any outcome rows whose horizon has passed,
        # then close the touch + outcome file handles.
        with contextlib.suppress(Exception):
            await asyncio.to_thread(
                self._outcome_tracker.flush_overdue, time.time_ns()
            )
        with contextlib.suppress(Exception):
            await asyncio.to_thread(self._zone_touch_stream.close)
        await self.manager.close_all()


async def _execute_end_day_shutdown(app: FastAPI, targets: list[ShutdownTarget]) -> None:
    """Run after the HTTP response: stop in-process services, then kill targets."""

    await asyncio.sleep(0.2)
    backend: RealtimeBackend = app.state.backend
    with contextlib.suppress(Exception):
        await backend.stop()
    service: EndDayShutdownService = app.state.shutdown_service
    await asyncio.to_thread(service.execute_plan, targets)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the FastAPI app bound to ``settings`` (env defaults if None)."""
    resolved = settings or settings_from_env()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        backend: RealtimeBackend = app.state.backend
        await backend.start()
        try:
            yield
        finally:
            await backend.stop()

    app = FastAPI(title="RA-060 realtime backend", lifespan=lifespan)
    backend = RealtimeBackend(resolved)
    app.state.backend = backend
    app.state.shutdown_service = EndDayShutdownService(backend_port=resolved.port)
    # RA-068: expose the shared store + mount the RA-063 config router so the
    # UI's settings PUT persists centrally (and reaches the daemon's file read).
    app.state.config_store = backend.config_store
    app.include_router(create_config_router(backend.config_store))

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved.cors_origins),
        allow_credentials=True,
        # PUT is required for the alert-config endpoint (RA-063) — the browser
        # preflights a settings save; GET-only would block it.
        # POST is required for the explicit end-day shutdown endpoint.
        allow_methods=["GET", "PUT", "POST"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health() -> dict[str, object]:
        """Liveness probe (mirrors the mock; adds live counters)."""
        backend: RealtimeBackend = app.state.backend
        return {
            "status": "ok",
            "role": "realtime_backend",
            "seq": backend.feed.current_seq,
            "clients": backend.manager.client_count,
        }

    @app.get("/snapshot")
    def snapshot() -> JSONResponse:
        """REST snapshot at the current live seq for load + resync."""
        backend: RealtimeBackend = app.state.backend
        message = backend.feed.build_snapshot_message()
        return JSONResponse(content=message.model_dump())

    @app.get("/api/bookmap-backfill")
    async def bookmap_backfill() -> JSONResponse:
        """Bounded session-history backfill for Bookmap-style reconnect hydration."""
        backend: RealtimeBackend = app.state.backend
        return JSONResponse(content=await backend.feed.bookmap_backfill_payload())

    @app.post("/api/shutdown/end-day")
    def end_day_shutdown(background_tasks: BackgroundTasks) -> JSONResponse:
        """Explicit operator-triggered shutdown for the full local live stack."""
        service: EndDayShutdownService = app.state.shutdown_service
        targets = service.build_plan()
        background_tasks.add_task(_execute_end_day_shutdown, app, targets)
        return JSONResponse(content=service.response_payload(targets))

    @app.websocket("/ws")
    async def ws_endpoint(websocket: WebSocket) -> None:
        """Stream contract frames until the client disconnects.

        On connect we send the current snapshot frame directly, then register
        the socket with the ConnectionManager so it receives live broadcasts.
        """
        backend: RealtimeBackend = app.state.backend
        await websocket.accept()

        async def send(text: str) -> None:
            await websocket.send_text(text)

        # Replay the latest cached depth before the snapshot so a new client
        # sees frames in non-decreasing seq order. The cached depth can be older
        # than the current snapshot; sending it after the snapshot would trigger
        # the UI's out-of-order/gap resync path on every connect.
        #
        # Some browsers disconnect during reload before the first send
        # completes; in that case exit quietly instead of logging an ASGI
        # exception.
        try:
            if backend.feed.latest_depth_message is not None:
                await send(backend.feed.latest_depth_message.model_dump_json())
            snapshot_msg = backend.feed.build_snapshot_message()
            await send(snapshot_msg.model_dump_json())
        except WebSocketDisconnect:
            return

        client = await backend.manager.connect(send)
        try:
            # Keep the socket open; inbound frames are ignored (read-only feed).
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            await backend.manager.disconnect(client)

    return app


# Module-level app for ``uvicorn realtime_backend.app:app`` style invocation.
app = create_app()


__all__ = ["RealtimeBackend", "app", "create_app"]
