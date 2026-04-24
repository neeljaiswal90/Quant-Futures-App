#!/usr/bin/env python3
"""
Market Data Sidecar — Full Bookmap/Rithmic LOB bridge with:

  - WebSocket ingest from Bookmap addon (BBO, trades, depth, MBO)
  - Rolling feature computation via shared lob_features module
  - JSONL recording: session snapshots, trade snapshots, events, intents
  - Context endpoints for trade/signal correlation
  - REST snapshot endpoint for TypeScript fast-path consumption

Endpoints:
  GET  /lob/health              — service health + data freshness
  GET  /lob/snapshot            — full feature snapshot (all computed features)
  POST /trade_context/start     — mark trade open (high-frequency recording begins)
  POST /trade_context/end       — mark trade close (post-exit window, then resume session rate)
  POST /signal_context/start    — mark signal evaluation window (pre-entry capture)
  POST /signal_context/end      — end signal window

WebSocket:
  ws://127.0.0.1:5010/ws/bookmap  — ingest from Bookmap addon

Start:
  python python-market-data-service/app.py
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from lob_features.schema import LobFeatureSnapshot
from lob_features.rolling import RollingTradeBuffer, RollingDepthState, RollingMboAggregator, RollingScalpState
from lob_features.advanced_mbo import AdvancedMboAnalyzer, RichMboEvent
from lob_features.compute import compute_lob_features
from lob_features.microstructure import (
    AbsorptionDetector, SweepDetector, FootprintTracker,
    LargeTradeTracker, SessionVolumeProfile,
)

NQ_TICK_SIZE = 0.25
SUPPORTED_ROOTS = ("MNQ", "MES", "NQ", "ES")


def _parse_raw_symbol_from_alias(alias: Optional[str]) -> Optional[str]:
    """
    DATA-04 — parse the pinned raw_symbol from a Bookmap source_alias.

    Bookmap / Rithmic aliases follow "<RAW_SYMBOL>.<VENUE>@<FEED>" or similar
    (e.g. "MNQM6.CME@RITHMIC"). We return the segment before the first dot
    iff it is a supported root + month + year shape (e.g. "MNQM6"). Anything
    else returns None.

    Returning the pure root (e.g. "MNQ") is NOT acceptable here — v3.1 §1.2
    requires the live session identify to a concrete raw_symbol. Degrading
    to the root would make /lob/health report a semantically wrong pin and
    could mislead operators and the session-contract-manifest writer.
    """
    if not alias or not isinstance(alias, str):
        return None
    head = alias.split(".", 1)[0].strip().upper()
    if not head:
        return None
    # Minimum shape: <ROOT><MONTH><YEAR-DIGITS>. Month letters are
    # F G H J K M N Q U V X Z; year is 1-2 digits. Keep the regex light
    # rather than importing a full symbology library here.
    import re
    m = re.match(r"^([A-Z]{2,4})([FGHJKMNQUVXZ])(\d{1,2})$", head)
    if not m:
        return None
    root = m.group(1)
    if root not in SUPPORTED_ROOTS:
        return None
    return head

# ─── JSONL Writer ─────────────────────────────────────────────────────────────

LOG_DIR = os.environ.get("LOG_DIR", os.path.join(os.path.dirname(__file__), "..", "logs"))


def _ensure_log_dir():
    os.makedirs(LOG_DIR, exist_ok=True)


class AsyncJsonlWriter:
    """Buffered JSONL writer with background flusher.

    Enqueue records and they are flushed to disk every flush_interval seconds
    or when the buffer exceeds flush_threshold lines.
    """

    def __init__(self, log_dir: str, flush_interval: float = 0.5, flush_threshold: int = 20):
        self.log_dir = log_dir
        self.flush_interval = flush_interval
        self.flush_threshold = flush_threshold
        self.buffers: dict[str, list[str]] = {}
        self._task: Optional[asyncio.Task] = None

    def enqueue(self, filename: str, record: dict) -> None:
        """Add a record to the write buffer. Non-throwing."""
        try:
            line = json.dumps(record, default=str) + "\n"
            buf = self.buffers.get(filename)
            if buf is None:
                buf = []
                self.buffers[filename] = buf
            buf.append(line)
            if len(buf) >= self.flush_threshold:
                self._flush_file(filename)
        except Exception as e:
            print(f"[LOG] Enqueue error {filename}: {e}")

    def enqueue_immediate(self, filename: str, record: dict) -> None:
        """Enqueue and immediately flush this file's buffer. For critical records."""
        self.enqueue(filename, record)
        self._flush_file(filename)

    def _flush_file(self, filename: str) -> None:
        buf = self.buffers.get(filename)
        if not buf:
            return
        try:
            path = os.path.join(self.log_dir, filename)
            with open(path, "a", encoding="utf-8") as f:
                f.writelines(buf)
            self.buffers[filename] = []
        except Exception as e:
            print(f"[LOG] Flush error {filename}: {e}")

    def flush_all(self) -> None:
        for fn in list(self.buffers.keys()):
            self._flush_file(fn)

    async def run(self) -> None:
        """Background loop: flush all buffers periodically."""
        while True:
            await asyncio.sleep(self.flush_interval)
            self.flush_all()

    def start(self) -> None:
        self._task = asyncio.create_task(self.run())

    def stop(self) -> None:
        if self._task:
            self._task.cancel()
        self.flush_all()


# Module-level writer instance (initialized in lifespan)
writer: Optional[AsyncJsonlWriter] = None


def append_jsonl(filename: str, record: dict) -> None:
    """Append one JSON line via async writer (or direct fallback if not started)."""
    if writer is not None:
        writer.enqueue(filename, record)
    else:
        try:
            path = os.path.join(LOG_DIR, filename)
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(record, default=str) + "\n")
        except Exception as e:
            print(f"[LOG] Write error {filename}: {e}")


# ─── Global State ─────────────────────────────────────────────────────────────

class SidecarState:
    def __init__(self):
        self.bid: Optional[float] = None
        self.ask: Optional[float] = None
        self.bid_size: Optional[int] = None
        self.ask_size: Optional[int] = None
        self.last_bbo_ts: float = 0.0
        self.connected: bool = False
        self.update_count: int = 0
        self.trade_count: int = 0
        self.last_heartbeat_ts: float = 0.0
        self.source_alias: Optional[str] = None

        # PH0-02 — Bookmap sidecar drop counters + queue depths from
        # the Java addon's extended heartbeat. All default to 0 until
        # the first heartbeat lands; unavailable means either (a) addon
        # not yet connected, or (b) addon is pre-PH0-02 build.
        self.bookmap_depth_dropped_total: int = 0
        self.bookmap_mbo_dropped_total: int = 0
        self.bookmap_depth_queue_size: int = 0
        self.bookmap_mbo_queue_size: int = 0
        self.bookmap_tracked_orders_count: int = 0
        self.bookmap_batch_flush_ms: Optional[int] = None
        self.bookmap_ws_reconnects_total: int = 0
        self.bookmap_heartbeat_seen: bool = False

        # DATA-10 (v3.2.3 §1.1, §2.3) — Bookmap live ingest hardening.
        # Sidecar-observed disconnect/reconnect lifecycle (distinct from
        # the addon-reported ws_reconnects_total: that counter only
        # reflects the addon's own Rithmic reconnects; this block
        # tracks the sidecar↔addon WebSocket lifecycle and the broader
        # operational observability the runbook needs under a
        # single-live-provider architecture).
        #
        # Every field here is strictly additive. No existing consumer
        # depends on these until /lob/health v2 surfaces them.
        self.bookmap_sidecar_disconnect_count: int = 0
        self.bookmap_sidecar_last_disconnect_ts: Optional[float] = None
        self.bookmap_sidecar_last_connect_ts: Optional[float] = None
        # Event-level freshness — updated on EVERY event type (bbo,
        # trade, depth, mbo, heartbeat) so a stall in one stream
        # doesn't look healthy because a different stream is still
        # ticking. `last_any_event_ts` is the authoritative "when did
        # ANYTHING arrive" signal.
        self.bookmap_last_any_event_ts: float = 0.0
        self.bookmap_last_trade_event_ts: float = 0.0
        self.bookmap_last_depth_event_ts: float = 0.0
        # Parse and unexpected-error counters. Pre-DATA-10 these were
        # print()'d and silently dropped; v3.2.3 §4 requires live
        # addon-facing errors to be machine-readable so the Phase 6
        # risk gate (RISK-07 Bookmap freshness / addon-latency-variance
        # gate) has something to consume.
        self.bookmap_parse_error_count: int = 0
        self.bookmap_unexpected_error_count: int = 0
        # Cache-at-cap observability — the tracked-orders cache has a
        # cap in the Java addon; when it sits at cap, side-unknown
        # rate rises and L3 adjunct coverage degrades. v3.2.3 §2.3
        # accepts this envelope but requires it to be visible, not
        # hidden. We count heartbeats where the cache looks pinned at
        # the addon's declared cap (reported via heartbeat).
        self.bookmap_tracked_orders_cap: Optional[int] = None
        self.bookmap_tracked_orders_at_cap_count: int = 0

        # Rolling buffers (shared computation module)
        self.trade_buf = RollingTradeBuffer(max_window_sec=60.0)
        self.depth = RollingDepthState()
        self.mbo_agg = RollingMboAggregator(max_window_sec=60.0)
        self.scalp_state = RollingScalpState(max_window_sec=3.0)
        self.advanced_mbo = AdvancedMboAnalyzer(max_window_sec=60.0)

        # MBO capability tracking
        self.mbo_ever_seen: bool = False       # True once any MBO event is received
        self.mbo_total_count: int = 0          # lifetime count (not windowed)
        self.last_mbo_ts: float = 0.0          # epoch seconds of last MBO event

        # Microstructure feature trackers
        self.absorption = AbsorptionDetector(window_sec=10.0)
        self.sweeps = SweepDetector(window_sec=10.0)
        self.footprint = FootprintTracker(max_window_sec=60.0)
        self.large_trades = LargeTradeTracker(threshold=20, max_window_sec=30.0)
        self.volume_profile = SessionVolumeProfile()

        # Context state
        self.active_trade_id: Optional[str] = None
        self.active_signal_id: Optional[str] = None
        self.trade_end_ts: Optional[float] = None  # for post-exit window

        # Recording cadence
        self.last_session_record_ts: float = 0.0
        self.last_trade_record_ts: float = 0.0

        # Snapshot cache (300ms TTL)
        self._snapshot_cache: Optional[dict] = None
        self._snapshot_cache_ts: float = 0.0
        self._prev_is_fresh: bool = False  # for freshness transition detection

    @property
    def mid(self) -> Optional[float]:
        if self.bid is not None and self.ask is not None:
            return round((self.bid + self.ask) / 2, 2)
        return None

    @property
    def bbo_age_ms(self) -> float:
        if self.last_bbo_ts == 0:
            return 99999
        return round((time.time() - self.last_bbo_ts) * 1000, 1)

    @property
    def is_fresh(self) -> bool:
        return self.bbo_age_ms < 3000

    @property
    def mbo_age_ms(self) -> float:
        if self.last_mbo_ts == 0:
            return 99999
        return round((time.time() - self.last_mbo_ts) * 1000, 1)

    @property
    def mbo_status(self) -> str:
        """Honest MBO capability/freshness status."""
        if not self.mbo_ever_seen:
            return "idle"           # MBO support exists but no events received yet
        if self.mbo_age_ms < 5000:
            return "active"         # MBO flowing normally
        return "stale"              # MBO was seen but has gone quiet

    @property
    def recording_context(self) -> str:
        if self.active_trade_id:
            return "trade"
        if self.active_signal_id:
            return "pre_entry"
        if self.trade_end_ts and (time.time() - self.trade_end_ts) < 30:
            return "post_exit"
        return "session"

    @property
    def source_symbol_root(self) -> Optional[str]:
        if not self.source_alias:
            return None
        alias_upper = self.source_alias.upper()
        for root in SUPPORTED_ROOTS:
            if alias_upper.startswith(root):
                return root
        return None

    def compute_snapshot(self) -> LobFeatureSnapshot:
        return compute_lob_features(
            bid=self.bid, ask=self.ask,
            bid_size=self.bid_size, ask_size=self.ask_size,
            trade_buf=self.trade_buf,
            depth=self.depth,
            mbo_agg=self.mbo_agg,
            now=time.time(),
            recording_context=self.recording_context,
            trade_id=self.active_trade_id,
            signal_id=self.active_signal_id,
            advanced_mbo=self.advanced_mbo,
            absorption=self.absorption,
            sweeps=self.sweeps,
            footprint=self.footprint,
            large_trades=self.large_trades,
            volume_profile=self.volume_profile,
            current_price=self.mid,
            scalp_state_tracker=self.scalp_state,
        )

    def get_cached_snapshot(self) -> dict:
        """Return cached snapshot if < 300ms old, else recompute and cache."""
        now = time.time()
        if self._snapshot_cache and (now - self._snapshot_cache_ts) < SNAPSHOT_CACHE_TTL_SEC:
            return self._snapshot_cache
        snap = self.compute_snapshot()
        self._snapshot_cache = snap.to_dict()
        self._snapshot_cache_ts = now
        return self._snapshot_cache

    def invalidate_snapshot_cache(self) -> None:
        """Force cache invalidation on state transitions."""
        self._snapshot_cache = None


state = SidecarState()
START_TIME = time.time()
SNAPSHOT_CACHE_TTL_SEC = 0.3  # 300ms

# ─── Recording Policy ────────────────────────────────────────────────────────

SESSION_RECORD_INTERVAL_SEC = 5.0   # continuous low-frequency
TRADE_RECORD_INTERVAL_SEC = 1.0     # higher frequency during trades
POST_EXIT_WINDOW_SEC = 30.0         # continue recording after trade close


def maybe_record_snapshot():
    """Called after every event. Records based on context + cadence."""
    now = time.time()
    ctx = state.recording_context

    if ctx == "trade" or ctx == "pre_entry":
        if (now - state.last_trade_record_ts) >= TRADE_RECORD_INTERVAL_SEC:
            snap = state.compute_snapshot()
            append_jsonl("lob_snapshots.jsonl", snap.to_dict())
            state.last_trade_record_ts = now
    elif ctx == "post_exit":
        if (now - state.last_trade_record_ts) >= TRADE_RECORD_INTERVAL_SEC:
            snap = state.compute_snapshot()
            append_jsonl("lob_snapshots.jsonl", snap.to_dict())
            state.last_trade_record_ts = now
    # Always record session snapshots at low frequency
    if (now - state.last_session_record_ts) >= SESSION_RECORD_INTERVAL_SEC:
        snap = state.compute_snapshot()
        append_jsonl("lob_session_snapshots.jsonl", snap.to_dict())
        state.last_session_record_ts = now


# ─── Lifespan ─────────────────────────────────────────────────────────────────

async def recording_loop():
    """Separate timed task for snapshot recording — decoupled from ingest hot loop.

    This replaces the old maybe_record_snapshot() call that ran after every WebSocket event.
    Now compute_snapshot() runs at most 2x/sec instead of on every tick (~100-200 Hz).
    """
    while True:
        try:
            await asyncio.sleep(0.5)
            now = time.time()
            ctx = state.recording_context
            if ctx in ("trade", "pre_entry", "post_exit"):
                if (now - state.last_trade_record_ts) >= TRADE_RECORD_INTERVAL_SEC:
                    snap = state.compute_snapshot()
                    append_jsonl("lob_snapshots.jsonl", snap.to_dict())
                    state.last_trade_record_ts = now
            if (now - state.last_session_record_ts) >= SESSION_RECORD_INTERVAL_SEC:
                snap = state.compute_snapshot()
                append_jsonl("lob_session_snapshots.jsonl", snap.to_dict())
                state.last_session_record_ts = now
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"[RECORDING] Error: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global writer, databento_provider, databento_ingest_task
    _ensure_log_dir()
    writer = AsyncJsonlWriter(LOG_DIR)
    writer.start()
    recording_task = asyncio.create_task(recording_loop())
    print(f"[MKT-DATA] Sidecar starting, logs -> {LOG_DIR}")

    # DATA-09: if MARKET_DATA_PROVIDER=databento, start the live-ingest
    # task alongside the existing Bookmap websocket path. Phase 2 runs
    # both in parallel so the Bookmap-authoritative book stays intact
    # while the Databento ingest accumulates records for DATA-11/DATA-16
    # to promote. Bookmap remains selected by default.
    provider_env = (os.environ.get("MARKET_DATA_PROVIDER") or "bookmap").strip().lower()
    if provider_env == "databento":
        try:
            databento_provider = _construct_databento_provider_from_env()
            databento_ingest_telemetry.reset()
            databento_ingest_task = asyncio.create_task(
                databento_provider.start(_databento_record_sink),
            )
            print("[MKT-DATA] DATA-09 databento live ingest started")
        except Exception as exc:  # noqa: BLE001 — surface and continue
            print(f"[MKT-DATA] DATA-09 failed to start databento ingest: {exc}")
            databento_provider = None
            databento_ingest_task = None

    yield

    if databento_ingest_task is not None:
        if databento_provider is not None:
            try:
                await databento_provider.stop()
            except Exception:
                pass
        databento_ingest_task.cancel()
        try:
            await databento_ingest_task
        except (asyncio.CancelledError, Exception):
            pass

    recording_task.cancel()
    try:
        await recording_task
    except asyncio.CancelledError:
        pass
    writer.stop()
    print("[MKT-DATA] Shutting down")


# ─── DATA-09: Databento live ingest wiring ───────────────────────────────────

databento_provider = None
databento_ingest_task = None

# DATA-11 RETROFIT (v3.2.1 §2.1): Databento L2 book state now lives in
# lob_features.mbp10_book_state. The legacy MBO kernel below is retained
# for rollback and Bookmap L3 use only — new L2 features must read from
# databento_mbp10_registry. During the transition both registries exist:
#   - Databento MBP-10 sessions feed databento_mbp10_registry (primary)
#   - Rollback MBO sessions (DATABENTO_SCHEMAS=mbo,...) still feed
#     databento_kernel_registry (legacy); that path is not used for
#     paper-day acceptance per docs/current_phase_status.md.
from lob_features.orderbook_kernel import OrderBookKernelRegistry
from lob_features.mbp10_book_state import Mbp10BookRegistry
from lob_features.l2_authority_fsm import (
    BOOKMAP_LIVE_INSTRUMENT_ID,
    BookmapBboApplyResult,
    BookmapBboObservation,
    L2AuthorityRegistry,
    assert_acceptance_compatible_config,
)
from lob_features.databento_ingest_telemetry import databento_ingest_telemetry
from lob_features.dual_provider_telemetry import dual_provider_telemetry
from lob_features.cvd import CvdAccumulator
from lob_features.orderflow_authoritative import OfiAccumulator

databento_kernel_registry = OrderBookKernelRegistry()
databento_mbp10_registry = Mbp10BookRegistry()

# DATA-12 rebuild (v3.2.1 §5.2): per-instrument L2 authoritative-book
# FSM. Publishes snapshot_synced / quote_authoritative / reset_count /
# reconvergence_epoch_ts_ms / ... for /lob/health and hard-risk
# consumers. The kickoff tightening §2 invariants are enforced here:
#   - quote_authoritative=true requires best bid AND ask populated
#     from updates received AFTER the most recent reset/gap boundary
#   - L2_AUTHORITY_FSM_ENABLED=false is debug/test only; combined with
#     any acceptance-mode env it raises at module import.
# v3.2.3 §6.1 — single FSM registry, provider-neutral. Bookmap is the
# primary live feed (sentinel key BOOKMAP_LIVE_INSTRUMENT_ID = -1);
# Databento-pinned FSMs (real int instrument_id) coexist in the same
# registry for rollback / historical replay only. `l2_authority_registry`
# is the v3.2.3 canonical name; `databento_l2_authority_registry` is
# retained as a back-compat alias so pre-v3.2.3 test code and any
# external importer keep resolving.
l2_authority_registry = L2AuthorityRegistry()
databento_l2_authority_registry = l2_authority_registry  # back-compat alias

# Startup acceptance-compatibility gate. Raises
# L2AuthorityConfigError if L2_AUTHORITY_FSM_ENABLED=false is combined
# with any of the acceptance-mode envs (DATA17_ACCEPTANCE_RUN,
# PHASE2_ACCEPTANCE, MEAS03_POST_RUN). Called at import time so a
# misconfigured sidecar fails fast during boot, not silently during
# paper-day capture.
assert_acceptance_compatible_config()

# DATA-16: per-instrument OFI accumulator. Fed from kernel top-of-book
# state after each MBO event. /lob/snapshot exposes the resulting
# ofi_10s/30s + z-scores + readiness; the TS runner consumes this as
# passthrough so candidate-time local OFI compute stops being the
# authoritative path (v3.1 §3.3). Bookmap-authoritative state is
# untouched — this lives in parallel under databento_orderflow.
databento_ofi_by_instrument: dict[int, OfiAccumulator] = {}


def _databento_ofi_get_or_create(instrument_id: int) -> OfiAccumulator:
    a = databento_ofi_by_instrument.get(instrument_id)
    if a is None:
        a = OfiAccumulator()
        databento_ofi_by_instrument[instrument_id] = a
    return a


def databento_ofi_snapshots(now_ns: Optional[int] = None) -> dict[int, dict]:
    """Per-instrument OFI snapshot for /lob/snapshot exposure. Dict shape
    mirrors the TS-side sidecar passthrough contract read by
    src/autotrade/features/orderflow-state.ts."""
    out: dict[int, dict] = {}
    for iid, acc in databento_ofi_by_instrument.items():
        s = acc.snapshot(now_ns=now_ns)
        out[iid] = {
            "ofi_10s": s.ofi_10s,
            "ofi_30s": s.ofi_30s,
            "z_ofi_10s": s.z_ofi_10s,
            "z_ofi_30s": s.z_ofi_30s,
            "z_ofi_blend": s.z_ofi_blend,
            "ready_10s": s.ready_10s,
            "ready_30s": s.ready_30s,
            "sample_count": s.sample_count,
            "last_event_ts_ns": s.last_event_ts_ns,
        }
    return out


def databento_ofi_reset_all() -> None:
    """DATA-16: session-boundary reset. Invoked alongside CVD reset
    when the sidecar observes a session_open StatusMsg."""
    for acc in databento_ofi_by_instrument.values():
        acc.reset_session()


def l2_authority_snapshots() -> dict[int, dict]:
    """DATA-12 (v3.2.3 §6.1): per-instrument authoritative-book FSM state.

    Returns the machine-readable health shape v3.2.1 §5.2 requires.
    Key set:
      - BOOKMAP_LIVE_INSTRUMENT_ID (-1) → live Bookmap FSM (primary)
      - any positive int → Databento-pinned FSM (rollback / historical
        replay only under v3.2.3)
    Empty dict when no events have been observed yet.
    """
    out: dict[int, dict] = {}
    for iid, fsm in l2_authority_registry.all_items():
        out[iid] = fsm.to_health_dict()
    return out


def _primary_live_authority_snapshot() -> Optional[dict]:
    """v3.2.3 §6.1: return the single-primary FSM snapshot. Bookmap
    live is primary; if the Bookmap FSM exists, it wins. Fall back to
    the Databento-pinned FSM only when Bookmap has never connected
    (rollback / dormant-live replay path). Returns None when no FSM
    has observed any events yet."""
    bm = l2_authority_registry.get(BOOKMAP_LIVE_INSTRUMENT_ID)
    if bm is not None:
        return bm.to_health_dict()
    if databento_provider is not None:
        try:
            h = databento_provider.health()
            if isinstance(h.instrument_id, int):
                db = l2_authority_registry.get(h.instrument_id)
                if db is not None:
                    return db.to_health_dict()
        except Exception:
            pass
    return None


# Back-compat alias — pre-v3.2.3 test code and external importers.
def databento_l2_authority_snapshots() -> dict[int, dict]:
    """DEPRECATED alias of l2_authority_snapshots(). Pre-v3.2.3 the
    FSM was Databento-only; v3.2.3 §6.1 makes Bookmap primary. Same
    return shape either way — the dict key for the Bookmap live FSM
    is BOOKMAP_LIVE_INSTRUMENT_ID (-1)."""
    return l2_authority_snapshots()


def dual_provider_telemetry_snapshot(
    *, now_ns: Optional[int] = None,
) -> dict:
    """DATA-13 retrofit (v3.2.1 §2.1): single canonical dual-provider
    block — per-provider lag/reset/gap, L2↔L3 join freshness, and the
    L2 authoritative-book FSM state rolled into one dict for
    /lob/health consumption. Kept separate from v1
    databento_ingest_telemetry so existing v1 consumers don't change
    shape."""
    return dual_provider_telemetry.to_dict(
        now_ns=now_ns,
        l2_authority_snapshots=databento_l2_authority_snapshots() or None,
    )

# DATA-15: per-instrument CVD accumulator. Lazy — one CvdAccumulator
# per instrument_id on first trade. Snapshot readable via
# databento_cvd_snapshots() for the /lob/snapshot endpoint. Parallel to
# the Bookmap-authoritative CVD path; does NOT mutate state.cvd_*.
# v3.1 §1.3 authority flip stays in DATA-16.
databento_cvd_by_instrument: dict[int, CvdAccumulator] = {}


def _databento_cvd_get_or_create(instrument_id: int) -> CvdAccumulator:
    c = databento_cvd_by_instrument.get(instrument_id)
    if c is None:
        c = CvdAccumulator()
        databento_cvd_by_instrument[instrument_id] = c
    return c


def databento_cvd_snapshots(now_ns: Optional[int] = None) -> dict[int, dict]:
    """
    Point-in-time CVD snapshot per instrument. Consumers (e.g. /lob/snapshot,
    DATA-16) embed the returned dict under their own key. now_ns is optional;
    when omitted each accumulator uses its own last-trade ts.
    """
    out: dict[int, dict] = {}
    for iid, acc in databento_cvd_by_instrument.items():
        s = acc.snapshot(now_ns=now_ns)
        out[iid] = {
            "cvd_session": s.cvd_session,
            "cvd_delta_250ms": s.cvd_delta_250ms,
            "cvd_delta_1s": s.cvd_delta_1s,
            "cvd_delta_3s": s.cvd_delta_3s,
            "cvd_delta_10s": s.cvd_delta_10s,
            "cvd_delta_30s": s.cvd_delta_30s,
            "trade_count": s.trade_count,
            "last_trade_ts_ns": s.last_trade_ts_ns,
            "session_start_ts_ns": s.session_start_ts_ns,
        }
    return out


def databento_cvd_reset_all(now_ns: Optional[int] = None) -> None:
    """DATA-15: v3.1 §1.3 session-boundary reset hook. Invoked when
    the sidecar observes a StatusMsg marking session rollover. Applies
    to every per-instrument accumulator."""
    for acc in databento_cvd_by_instrument.values():
        acc.reset_session(now_ns=now_ns)


def _construct_databento_provider_from_env():
    """
    Build a DatabentoLiveProvider from env. Mirrors the validation in
    src/autotrade/env.ts::resolveDatabentoEnv so mismatch between TS
    and Python env parsing is impossible. Raises on missing fields so
    the caller surfaces them loudly.
    """
    from providers.databento_live import DatabentoLiveProvider

    api_key = (os.environ.get("DATABENTO_API_KEY") or "").strip()
    dataset = (os.environ.get("DATABENTO_DATASET") or "").strip()
    stype_in = (os.environ.get("DATABENTO_STYPE_IN") or "").strip()
    parent_raw = (os.environ.get("DATABENTO_PARENT_SYMBOLS") or "").strip()
    parent_symbols = [s.strip() for s in parent_raw.split(",") if s.strip()]

    missing = []
    if not api_key: missing.append("DATABENTO_API_KEY")
    if not dataset: missing.append("DATABENTO_DATASET")
    if not stype_in: missing.append("DATABENTO_STYPE_IN")
    if not parent_symbols: missing.append("DATABENTO_PARENT_SYMBOLS")
    if missing:
        raise RuntimeError(
            f"databento mode requires: {', '.join(missing)}"
        )

    # DATA-09 retrofit (v3.2.1 §2.1): optional DATABENTO_SCHEMAS env
    # override. Accepts a comma-separated schema list. When set, it
    # wins over the provider default. This is the rollback hatch for
    # the L2-canonical default — if the stale MBO path needs to be
    # re-exercised for comparison, set:
    #   DATABENTO_SCHEMAS="mbo,definition,statistics,status"
    # New L2-canonical default (empty env var) =
    #   ("mbp-10","trades","definition","statistics","status")
    schemas_raw = (os.environ.get("DATABENTO_SCHEMAS") or "").strip()
    override_kwargs = {}
    if schemas_raw:
        schemas = tuple(s.strip() for s in schemas_raw.split(",") if s.strip())
        if not schemas:
            raise RuntimeError(
                "DATABENTO_SCHEMAS is set but parsed as empty; "
                'use a comma-separated schema list e.g. "mbp-10,trades,status"'
            )
        override_kwargs["schemas"] = schemas
        print(f"[MKT-DATA] DATA-09 schema override active: {schemas}")

    return DatabentoLiveProvider(
        api_key=api_key,
        dataset=dataset,
        stype_in=stype_in,
        parent_symbols=parent_symbols,
        **override_kwargs,
    )


async def _databento_record_sink(rec) -> None:
    """
    Databento record sink.

    DATA-09 archival: every record is logged to
    logs/databento_live_events.jsonl as a Phase 2 audit trail.

    DATA-13 telemetry: lag samples, gap detection, slow-reader warnings,
    reconnect boundary timestamp — surfaces on /lob/health.

    DATA-11 kernel dispatch: MBO/trade/fill/clear records are fed to
    the per-instrument OrderBookKernelRegistry which reconstructs the
    order book from the event stream. state.bid/ask/depth (the
    Bookmap-authoritative path) is NOT updated here — v3.1 §1.3 gates
    authoritative publication on snapshot-sync + F_LAST semantics
    which DATA-12 implements.
    """
    try:
        rc = 0
        if databento_provider is not None:
            rc = databento_provider.health().reconnect_count
        # DATA-13 v1 (existing): ingest-wide lag / gap / slow-reader.
        prev_gap = databento_ingest_telemetry.gap_detected_count
        databento_ingest_telemetry.observe(
            ts_event_ns=rec.ts_event_ns,
            ts_recv_ns=rec.ts_recv_ns,
            instrument_id=rec.instrument_id,
            reconnect_count=rc,
        )
        gap_fired = databento_ingest_telemetry.gap_detected_count > prev_gap
        # DATA-13 retrofit (v3.2.1 §2.1): dual-provider telemetry gets
        # the same observation routed to the L2 provider bucket. Reset
        # flag is set on R-action MBP-10 records (cleared=True from
        # the book state); gap flag comes from the v1 gap detector's
        # delta so we don't duplicate the detection heuristic.
        is_reset_l2 = False
        if rec.kind == "mbp10":
            payload = rec.payload
            action = getattr(payload, "action", None) if payload is not None else None
            if isinstance(action, str) and action.upper().startswith("R"):
                is_reset_l2 = True
        dual_provider_telemetry.observe_l2_event(
            ts_recv_ns=rec.ts_recv_ns,
            ts_event_ns=rec.ts_event_ns,
            is_reset=is_reset_l2,
            is_gap=gap_fired,
        )
    except Exception:
        pass

    try:
        append_jsonl("databento_live_events.jsonl", {
            "ts_recv_ns": rec.ts_recv_ns,
            "ts_event_ns": rec.ts_event_ns,
            "kind": rec.kind,
            "raw_symbol": rec.raw_symbol,
            "instrument_id": rec.instrument_id,
        })
    except Exception:
        pass

    # DATA-11 RETROFIT (v3.2.1 §2.1): Route L2 book-state updates to
    # the MBP-10 registry (canonical). The legacy MBO kernel path
    # still runs when MBO records arrive so a DATABENTO_SCHEMAS rollback
    # session keeps working; it's not used for paper-day acceptance.
    #
    # OFI observation: whichever book path produced the update feeds
    # the OFI accumulator its new top-of-book. We prefer MBP-10 state
    # when available (L2 canonical); otherwise the legacy kernel
    # snapshot is used for rollback continuity.
    if rec.kind == "mbp10":
        try:
            result = databento_mbp10_registry.apply_provider_record(rec)
            iid = rec.instrument_id
            if result is not None and isinstance(iid, int):
                st = databento_mbp10_registry.get(iid)
                top = st.snapshot(depth=1) if st is not None else None
                # DATA-12: drive the FSM on EVERY apply result —
                # including R (cleared=True) and unknown-action
                # (applied=False) — so reset/gap handling is unified.
                fsm = databento_l2_authority_registry.get_or_create(iid)
                fsm.on_apply_result(result, top, now_ns=rec.ts_recv_ns)
                if result.applied and not result.cleared and top is not None:
                    _databento_ofi_get_or_create(iid).observe_top_of_book(
                        ts_ns=rec.ts_recv_ns,
                        best_bid=top.best_bid(),
                        best_bid_qty=top.best_bid_qty(),
                        best_ask=top.best_ask(),
                        best_ask_qty=top.best_ask_qty(),
                    )
        except Exception:
            # MBP-10 / OFI / FSM errors must NOT kill the ingest task.
            pass
    elif rec.kind in ("mbo", "trade", "fill"):
        # Legacy MBO path — retained for rollback only. Not used for
        # v3.2.1 paper-day acceptance. Kept byte-identical to the
        # pre-retrofit behavior so a DATABENTO_SCHEMAS=mbo,... rollback
        # still produces the same OFI/CVD artifacts it did before.
        try:
            event_dict = _mbo_event_from_provider_record(rec)
            if event_dict is not None:
                databento_kernel_registry.apply(event_dict)
                iid = event_dict.get("instrument_id")
                if isinstance(iid, int):
                    kernel = databento_kernel_registry.get(iid)
                    if kernel is not None:
                        top = kernel.snapshot(depth=1)
                        _databento_ofi_get_or_create(iid).observe_top_of_book(
                            ts_ns=rec.ts_recv_ns,
                            best_bid=top.best_bid(),
                            best_bid_qty=top.best_bid_qty(),
                            best_ask=top.best_ask(),
                            best_ask_qty=top.best_ask_qty(),
                        )
        except Exception:
            pass
    elif rec.kind == "error":
        # DATA-12 retrofit (v3.2.1 §5.2, Slice 11 review-fix): provider
        # ErrorMsg records must flip quote_authoritative off via the
        # FSM. Without this hook, last_provider_error_ts_ms never
        # updates at runtime and the quiet-period gate (rule 4) can't
        # fire on real parse/error events — a direct DATA-12 /
        # Tightening A miss the reviewer flagged.
        #
        # Every known FSM instance is notified, not just the pinned
        # instrument: an error event from the provider applies to the
        # whole session, not to a specific symbol. Pre-pin errors
        # (no FSM entries yet) are a no-op; the first post-pin event
        # will see reconvergence_epoch_ts_ms=None and apply the
        # startup-reset path, which is correct.
        try:
            for iid, fsm in list(
                databento_l2_authority_registry.all_items()
            ):
                fsm.on_provider_error(now_ns=rec.ts_recv_ns)
        except Exception:
            pass

    # DATA-15: native CVD from true trade/aggressor data. Only trade
    # and fill kinds contribute; MBO adds/modifies/cancels do NOT.
    # Per the DATA-15 scope: strictly native CVD on the Databento path,
    # no authority flip (DATA-16 owns promotion), no TS consumer
    # changes.
    if rec.kind in ("trade", "fill") and isinstance(rec.instrument_id, int):
        try:
            payload = rec.payload
            side = getattr(payload, "side", None) if payload is not None else None
            size = getattr(payload, "size", None) if payload is not None else None
            acc = _databento_cvd_get_or_create(rec.instrument_id)
            acc.apply(rec.ts_recv_ns, side, size)
        except Exception:
            # CVD accumulator is best-effort; a malformed trade must
            # never kill ingest. Unknown-aggressor trades are already
            # counted as trade_count without mutating CVD.
            pass

    # DATA-15: session-boundary reset (v3.1 §1.3).
    # Databento StatusMsg carries a `reason` field whose canonical
    # values include `session_open`, `session_close`, `trading`, and
    # various halt/resume reasons. We fire the reset on the leading
    # edge of a new session (`session_open`) rather than the trailing
    # edge — this is the "new session starting, clear accumulators"
    # signal. Defensive: only reset ONCE per rollover by gating on a
    # change of the last-seen session-open ts so repeated open
    # heartbeats inside one session don't wipe live CVD mid-stream.
    if rec.kind == "status" and rec.payload is not None:
        try:
            _maybe_fire_cvd_session_reset(rec)
        except Exception:
            pass


# DATA-15: last session-open ts the sidecar has acted on. Used to
# dedupe repeated "session_open" StatusMsg records inside one session
# (some feeds emit them periodically as heartbeats with the same reason
# string). Only a NEW session_open ts triggers a CVD reset.
_databento_last_session_open_reset_ts_ns: Optional[int] = None


def _maybe_fire_cvd_session_reset(rec) -> None:
    """
    DATA-15: detect a session-rollover StatusMsg and, if this is a new
    rollover (not a repeated open heartbeat), reset every per-
    instrument CVD accumulator. Exposed as a module-level function so
    tests can drive it directly and so a future refactor can swap the
    detection rule without touching _databento_record_sink.
    """
    global _databento_last_session_open_reset_ts_ns
    payload = rec.payload
    reason = str(getattr(payload, "reason", "") or "").strip().lower()
    # Conservative set: only explicit session-open markers trigger a
    # reset. `session_close` is logged but does NOT reset (the
    # accumulator's data-of-interest is the just-ended session;
    # resetting at close would wipe it before any downstream reader
    # could consume the final snapshot).
    if reason not in ("session_open", "start_of_day"):
        return
    ts = rec.ts_recv_ns if isinstance(rec.ts_recv_ns, int) else None
    # Dedupe: only reset if this is a strictly-newer session_open than
    # the last one we acted on. Without ts info, fall back to resetting
    # at most once per sidecar process.
    if ts is not None:
        if (
            _databento_last_session_open_reset_ts_ns is not None
            and ts <= _databento_last_session_open_reset_ts_ns
        ):
            return
        _databento_last_session_open_reset_ts_ns = ts
    elif _databento_last_session_open_reset_ts_ns is not None:
        return
    databento_cvd_reset_all(now_ns=ts)
    # DATA-16: session-boundary reset MUST include OFI too per v3.1
    # §1.3 — otherwise post-rollover z-scores would be polluted by
    # pre-rollover moments and the "first post-reset snapshot values"
    # observability signal would show stale OFI alongside fresh CVD.
    databento_ofi_reset_all()
    # DATA-11 retrofit (v3.2.1 §2.1): clear the MBP-10 book registry
    # too. Otherwise post-rollover reads would see pre-rollover levels
    # until the first post-reset MBP-10 update arrives — violating the
    # DATA-12 post-reset-population rule planned for the next slice.
    # The legacy MBO kernel is deliberately NOT cleared here; its
    # path is rollback-only and session-boundary reset semantics for
    # it are preserved byte-identical to the pre-retrofit behavior.
    try:
        databento_mbp10_registry.clear_all()
    except Exception:
        pass
    # DATA-12 (v3.2.1 §5.2): session boundary is a reset boundary —
    # every per-instrument FSM flips snapshot_synced / quote_authoritative
    # to False and requires a fresh reconvergence before authority can be
    # restored. Clearing the registry forces get_or_create() to mint a
    # fresh FSM on the next MBP-10 event, which starts in the
    # reconverging state by construction (see L2AuthorityRegistry.get_or_create).
    try:
        databento_l2_authority_registry.clear_all()
    except Exception:
        pass
    try:
        append_jsonl("databento_live_events.jsonl", {
            "ts_recv_ns": ts,
            "event": "cvd_ofi_mbp10_session_reset",
            "reason": reason,
        })
    except Exception:
        pass


def _mbo_event_from_provider_record(rec) -> dict | None:
    """
    Convert a ProviderRecord into the OrderBookKernel event-dict shape.
    Reads raw Databento payload attributes (action, side, price, size,
    order_id) and normalizes them. Returns None when the payload is not
    usable; the caller counts that as ignored.
    """
    payload = rec.payload
    if payload is None:
        return None
    event = {
        "action": getattr(payload, "action", None),
        "side": getattr(payload, "side", None),
        "price": getattr(payload, "price", None),
        "size": getattr(payload, "size", None),
        "order_id": getattr(payload, "order_id", None),
        "instrument_id": rec.instrument_id,
        "ts_recv_ns": rec.ts_recv_ns,
    }
    # For 'trade' kind with no explicit action, coerce action='trade'.
    if rec.kind == "trade" and not event["action"]:
        event["action"] = "trade"
    if rec.kind == "fill" and not event["action"]:
        event["action"] = "fill"
    return event


# ─── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="NQ Market Data Sidecar",
    description="Bookmap/Rithmic LOB bridge with feature computation + recording",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── WebSocket Ingest ─────────────────────────────────────────────────────────

@app.websocket("/ws/bookmap")
async def bookmap_ingest(ws: WebSocket):
    await ws.accept()
    state.connected = True
    # DATA-10: stamp the connect boundary so the runbook / RISK-07
    # gate can tell a cold boot from a reconnect.
    _connect_ts = time.time()
    state.bookmap_sidecar_last_connect_ts = _connect_ts
    state.invalidate_snapshot_cache()
    print("[MKT-DATA] Bookmap addon connected")
    # DATA-12 (v3.2.3 §6.1): every /ws/bookmap connect — whether cold
    # boot or reconnect after disconnect — stamps a reset boundary on
    # the Bookmap live FSM. The post-reset-population rule (kickoff
    # tightening §2 invariant) then requires at least one post-reset
    # BBO event per side before quote_authoritative can be restored.
    # Pre-reconnect carry-over state CANNOT satisfy authority.
    try:
        _fsm = l2_authority_registry.get_or_create(BOOKMAP_LIVE_INSTRUMENT_ID)
        _fsm.on_startup_or_reconnect(now_ns=int(_connect_ts * 1_000_000_000))
    except Exception:
        # FSM errors never kill the /ws/bookmap handler; the sidecar
        # continues ingesting even if authority tracking degrades.
        pass

    def _process_event(msg: dict) -> None:
        """Process a single event dict — called for individual and batch messages."""
        msg_type = msg.get("type")
        ts_ms = msg.get("ts", int(time.time() * 1000))
        ts = ts_ms / 1000.0
        alias = msg.get("alias")
        if isinstance(alias, str) and alias.strip():
            state.source_alias = alias.strip()
        # DATA-10: event-level freshness is stamped on EVERY type so a
        # stall in one stream (e.g. MBO silent but BBO ticking) cannot
        # pass as healthy. `bookmap_last_any_event_ts` is the
        # authoritative "any-stream tick" signal consumed by the
        # RISK-07 freshness gate.
        state.bookmap_last_any_event_ts = ts

        if msg_type == "bbo":
            # Detect freshness transitions for cache invalidation
            was_fresh = state._prev_is_fresh
            state.bid = msg["bid"]
            state.ask = msg["ask"]
            state.bid_size = msg["bid_sz"]
            state.ask_size = msg["ask_sz"]
            state.scalp_state.observe_bbo(ts_ms, state.bid, state.ask, state.bid_size, state.ask_size)
            state.last_bbo_ts = ts
            state.update_count += 1
            # DATA-13 (v3.2.3 §6.1): feed Bookmap CORE events into the
            # L2 bucket of dual_provider_telemetry. Under v3.2.3 "L2"
            # means "Bookmap core" — schema key stable, semantics
            # updated. Trades and depth also advance this bucket
            # below.
            try:
                dual_provider_telemetry.observe_l2_event(
                    ts_recv_ns=int(ts_ms) * 1_000_000,
                )
            except Exception:
                pass
            # DATA-12 (v3.2.3 §6.1): feed every Bookmap BBO event into
            # the authority FSM. Top-of-book populatedness is checked
            # per-side inside the FSM (Rule 1: bid AND ask populated
            # from post-reset updates). Sequence-length, top-of-book
            # validity, quiet-period, and freshness rules all consume
            # the same apply result.
            try:
                _fsm = l2_authority_registry.get_or_create(BOOKMAP_LIVE_INSTRUMENT_ID)
                _bb = float(state.bid) if isinstance(state.bid, (int, float)) else None
                _ba = float(state.ask) if isinstance(state.ask, (int, float)) else None
                _bq = float(state.bid_size) if isinstance(state.bid_size, (int, float)) else None
                _aq = float(state.ask_size) if isinstance(state.ask_size, (int, float)) else None
                _ts_ns = int(ts_ms) * 1_000_000
                _fsm.on_apply_result(
                    BookmapBboApplyResult(
                        applied=True, cleared=False,
                        ts_recv_ns=_ts_ns,
                        top_of_book_populated=(_bb is not None and _ba is not None),
                        levels_present=(_bb is not None or _ba is not None),
                    ),
                    BookmapBboObservation(
                        bid=_bb, ask=_ba, bid_qty=_bq, ask_qty=_aq,
                    ),
                    now_ns=_ts_ns,
                )
            except Exception:
                pass
            # Persist the exact top-of-book stream used by the offline
            # scalper readiness labeler. Without this file, shadow sessions
            # produce unpairable candidate logs that cannot be labeled later.
            append_jsonl(
                "lob_top_of_book.jsonl",
                {
                    "ts_ms": ts_ms,
                    "bid": state.bid,
                    "ask": state.ask,
                    "bid_sz": state.bid_size,
                    "ask_sz": state.ask_size,
                    "source_alias": state.source_alias,
                },
            )
            now_fresh = state.is_fresh
            if was_fresh != now_fresh:
                state._prev_is_fresh = now_fresh
                state.invalidate_snapshot_cache()

        elif msg_type == "trade":
            is_buy = msg.get("aggressor", "buy") == "buy"
            trade_price = msg["price"]
            trade_raw_price = msg.get("raw_price")
            trade_size = msg["size"]
            state.trade_buf.add(ts, trade_price, trade_size, is_buy)
            state.trade_count += 1
            state.bookmap_last_trade_event_ts = ts  # DATA-10
            # DATA-13: Bookmap trade events also count as CORE.
            try:
                dual_provider_telemetry.observe_l2_event(
                    ts_recv_ns=int(ts_ms) * 1_000_000,
                )
            except Exception:
                pass
            # Feed microstructure trackers
            state.absorption.add_trade(ts, trade_price, trade_size, is_buy)
            state.footprint.add_trade(ts, trade_price, trade_size, is_buy)
            state.large_trades.add_trade(ts, trade_price, trade_size, is_buy)
            state.volume_profile.add_trade(trade_price, trade_size)
            # Log compact trade event
            event_record = {
                "type": "trade", "ts": ts_ms,
                "price": trade_price, "size": trade_size,
                "aggressor": msg.get("aggressor"),
                "trade_id": state.active_trade_id,
            }
            if isinstance(trade_raw_price, (int, float)):
                event_record["raw_price"] = trade_raw_price
            if "price_scale_source" in msg:
                event_record["price_scale_source"] = msg.get("price_scale_source")
            append_jsonl("lob_events_compact.jsonl", event_record)

        elif msg_type == "depth":
            state.depth.update(msg["side"], msg["price"], msg["size"], ts)
            state.bookmap_last_depth_event_ts = ts  # DATA-10
            # DATA-13: Bookmap depth events also count as CORE.
            try:
                dual_provider_telemetry.observe_l2_event(
                    ts_recv_ns=int(ts_ms) * 1_000_000,
                )
            except Exception:
                pass

        elif msg_type == "mbo":
            # Robust parsing: all fields optional with safe defaults.
            # The Java addon may omit price/size on cancel events if
            # order state was not tracked, and side may be "unknown".
            mbo_action = msg.get("action", "unknown")
            mbo_side = msg.get("side", "unknown")
            mbo_price = msg.get("price", 0.0)
            mbo_size = msg.get("size", 0)
            mbo_order_id = msg.get("order_id", "")
            mbo_top = msg.get("top_of_book", False)
            mbo_levels = msg.get("levels_penetrated", 0)

            # Skip events with unknown side for aggregators that
            # need bid/ask classification, but still count them.
            if mbo_side in ("bid", "ask"):
                state.mbo_agg.add_event(
                    ts=ts, action=mbo_action, side=mbo_side,
                    price=mbo_price, size=mbo_size,
                    order_id=mbo_order_id,
                    is_top_of_book=mbo_top,
                    levels_penetrated=mbo_levels,
                )
                state.advanced_mbo.add_event(RichMboEvent(
                    ts=ts, action=mbo_action, side=mbo_side,
                    price=mbo_price, size=mbo_size,
                    order_id=mbo_order_id,
                    is_top_of_book=mbo_top,
                    levels_penetrated=mbo_levels,
                ))

            # Track MBO capability state regardless of side validity
            state.mbo_ever_seen = True
            state.mbo_total_count += 1
            state.last_mbo_ts = ts
            # DATA-13 (v3.2.3 §6.1): feed Bookmap L3 adjunct events
            # into the L3 bucket. Every MBO that arrives — whether
            # the bid/ask side is known or "unknown" (filtered out
            # by the aggregator) — counts toward L3 activity, because
            # for coverage purposes we're asking "is the addon
            # emitting MBO traffic at all?", not "is every MBO
            # actionable?". This is the feed for l3_coverage_pct.
            try:
                dual_provider_telemetry.observe_l3_event(
                    ts_recv_ns=int(ts_ms) * 1_000_000,
                )
            except Exception:
                pass

        elif msg_type == "heartbeat":
            state.last_heartbeat_ts = ts
            # PH0-02 — parse extended heartbeat fields. All are optional
            # so pre-PH0-02 addon builds continue to work (values stay
            # at their zero defaults).
            state.bookmap_heartbeat_seen = True
            state.bookmap_depth_dropped_total = int(msg.get("depth_dropped_total", state.bookmap_depth_dropped_total))
            state.bookmap_mbo_dropped_total = int(msg.get("mbo_dropped_total", state.bookmap_mbo_dropped_total))
            state.bookmap_depth_queue_size = int(msg.get("depth_queue_size", state.bookmap_depth_queue_size))
            state.bookmap_mbo_queue_size = int(msg.get("mbo_queue_size", state.bookmap_mbo_queue_size))
            # tracked_orders_count is canonical; mbo_tracked_orders is the legacy alias.
            state.bookmap_tracked_orders_count = int(msg.get(
                "tracked_orders_count",
                msg.get("mbo_tracked_orders", state.bookmap_tracked_orders_count),
            ))
            if "batch_flush_ms" in msg:
                state.bookmap_batch_flush_ms = int(msg["batch_flush_ms"])
            state.bookmap_ws_reconnects_total = int(msg.get("ws_reconnects_total", state.bookmap_ws_reconnects_total))
            # DATA-10: cache-at-cap observability. The addon reports its
            # tracked-orders cap alongside the current count when it
            # emits the heartbeat (older builds may omit the cap; we
            # just skip the at-cap check in that case). v3.2.3 §2.3
            # accepts this envelope but requires it be visible: every
            # heartbeat observed at cap bumps the counter, so a paper
            # day with sustained cap pressure shows up in the
            # operational artifact instead of silently degrading the
            # L3 adjunct quality.
            cap_raw = msg.get("tracked_orders_cap")
            if isinstance(cap_raw, (int, float)) and cap_raw > 0:
                cap = int(cap_raw)
                state.bookmap_tracked_orders_cap = cap
                if state.bookmap_tracked_orders_count >= cap:
                    state.bookmap_tracked_orders_at_cap_count += 1

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
                msg_type = msg.get("type")

                if msg_type == "batch":
                    # Batch envelope from addon: {"type":"batch","events":[...]}
                    for event in msg.get("events", []):
                        try:
                            _process_event(event)
                        except (KeyError, TypeError) as e:
                            # DATA-10: count, not just log. v3.2.3 §4
                            # requires machine-readable addon error
                            # surfaces for RISK-07's latency-variance
                            # gate to consume.
                            state.bookmap_parse_error_count += 1
                            # DATA-12: same FSM provider-error flip
                            # for batch-event errors.
                            try:
                                _fsm = l2_authority_registry.get_or_create(
                                    BOOKMAP_LIVE_INSTRUMENT_ID
                                )
                                _fsm.on_provider_error(now_ns=time.time_ns())
                            except Exception:
                                pass
                            print(f"[MKT-DATA] Batch event error: {e}")
                else:
                    _process_event(msg)

            except (KeyError, TypeError, json.JSONDecodeError) as e:
                state.bookmap_parse_error_count += 1  # DATA-10
                # DATA-12 (v3.2.3 §6.1): provider parse errors must
                # flip Bookmap authority off via the FSM's
                # on_provider_error path. Rule 4 (quiet-period) then
                # requires quiet_ms to elapse before authority can be
                # restored.
                try:
                    _fsm = l2_authority_registry.get_or_create(BOOKMAP_LIVE_INSTRUMENT_ID)
                    _fsm.on_provider_error(now_ns=time.time_ns())
                except Exception:
                    pass
                print(f"[MKT-DATA] Parse error: {e}")

    except WebSocketDisconnect:
        # DATA-10: record disconnect lifecycle so the runbook can
        # distinguish (a) addon crashed, (b) WebSocket transient drop,
        # (c) cold boot with no connect yet. Sidecar-observed count is
        # separate from addon-reported bookmap_ws_reconnects_total —
        # the addon tracks ITS reconnects to Rithmic; we track the
        # sidecar↔addon lifecycle.
        state.bookmap_sidecar_disconnect_count += 1
        state.bookmap_sidecar_last_disconnect_ts = time.time()
        state.connected = False
        state.invalidate_snapshot_cache()
        print("[MKT-DATA] Bookmap addon disconnected")
    except Exception as e:  # pragma: no cover — defensive
        # DATA-10: non-clean disconnect is a distinct signal from
        # WebSocketDisconnect (which is the clean close). Count both
        # paths separately so the operational artifact can show
        # "addon went away cleanly" vs "addon died mid-frame".
        state.bookmap_unexpected_error_count += 1
        state.bookmap_sidecar_disconnect_count += 1
        state.bookmap_sidecar_last_disconnect_ts = time.time()
        state.connected = False
        state.invalidate_snapshot_cache()
        print(f"[MKT-DATA] Bookmap addon unexpected error: {type(e).__name__}: {e}")


# ─── REST: Health ─────────────────────────────────────────────────────────────

def _age_ms_since(event_ts_sec: float, now_sec: float) -> Optional[float]:
    """DATA-10: age helper. Returns None when the event has never been
    observed (ts is 0.0 default), otherwise float ms. Guards against
    negative ages from clock skew / future-stamped events."""
    if event_ts_sec <= 0.0:
        return None
    delta = now_sec - event_ts_sec
    if delta < 0:
        return 0.0
    return delta * 1000.0


def _build_bookmap_sidecar_metrics() -> "BookmapSidecarMetrics":
    """DATA-10: centralize construction so /lob/health and any future
    snapshot emitter produce byte-identical operational reports. Every
    new field is optional; pre-DATA-10 consumers ignoring them keep
    working."""
    now = time.time()
    return BookmapSidecarMetrics(
        heartbeat_seen=state.bookmap_heartbeat_seen,
        depth_dropped_total=state.bookmap_depth_dropped_total,
        mbo_dropped_total=state.bookmap_mbo_dropped_total,
        depth_queue_size=state.bookmap_depth_queue_size,
        mbo_queue_size=state.bookmap_mbo_queue_size,
        tracked_orders_count=state.bookmap_tracked_orders_count,
        batch_flush_ms=state.bookmap_batch_flush_ms,
        ws_reconnects_total=state.bookmap_ws_reconnects_total,
        # DATA-10 additions.
        sidecar_disconnect_count=state.bookmap_sidecar_disconnect_count,
        sidecar_last_disconnect_ts_ms=(
            int(state.bookmap_sidecar_last_disconnect_ts * 1000)
            if state.bookmap_sidecar_last_disconnect_ts else None
        ),
        sidecar_last_connect_ts_ms=(
            int(state.bookmap_sidecar_last_connect_ts * 1000)
            if state.bookmap_sidecar_last_connect_ts else None
        ),
        last_any_event_age_ms=_age_ms_since(state.bookmap_last_any_event_ts, now),
        last_trade_event_age_ms=_age_ms_since(state.bookmap_last_trade_event_ts, now),
        last_depth_event_age_ms=_age_ms_since(state.bookmap_last_depth_event_ts, now),
        parse_error_count=state.bookmap_parse_error_count,
        unexpected_error_count=state.bookmap_unexpected_error_count,
        tracked_orders_cap=state.bookmap_tracked_orders_cap,
        tracked_orders_at_cap_count=state.bookmap_tracked_orders_at_cap_count,
    )


class BookmapSidecarMetrics(BaseModel):
    """PH0-02 — drop counters + queue depths from the Java addon heartbeat.

    DATA-10 (v3.2.3): extended with sidecar-observed disconnect/reconnect
    lifecycle, event-level freshness, parse/error counters, and cache-at-cap
    observability. Every field additive; pre-DATA-10 consumers that ignore
    unknown fields keep working.
    """
    heartbeat_seen: bool
    depth_dropped_total: int
    mbo_dropped_total: int
    depth_queue_size: int
    mbo_queue_size: int
    tracked_orders_count: int
    batch_flush_ms: Optional[int]
    ws_reconnects_total: int
    # DATA-10 additions. All optional so older /lob/health consumers
    # that didn't model these fields pass through cleanly.
    sidecar_disconnect_count: Optional[int] = None
    sidecar_last_disconnect_ts_ms: Optional[int] = None
    sidecar_last_connect_ts_ms: Optional[int] = None
    last_any_event_age_ms: Optional[float] = None
    last_trade_event_age_ms: Optional[float] = None
    last_depth_event_age_ms: Optional[float] = None
    parse_error_count: Optional[int] = None
    unexpected_error_count: Optional[int] = None
    tracked_orders_cap: Optional[int] = None
    tracked_orders_at_cap_count: Optional[int] = None


class HealthResponse(BaseModel):
    status: str
    source_connected: bool
    bbo_fresh: bool
    bbo_age_ms: float
    update_count: int
    trade_count: int
    depth_levels_bid: int
    depth_levels_ask: int
    # MBO status — honest capability reporting
    mbo_events_buffered: int        # windowed count (rolling 60s)
    mbo_total_count: int            # lifetime event count
    mbo_status: str                 # "idle" | "active" | "stale"
    mbo_age_ms: float               # ms since last MBO event (99999 if never)
    mbo_adv_event_count: int        # events in advanced analyzer window
    # Context
    active_trade_id: Optional[str]
    active_signal_id: Optional[str]
    recording_context: str
    uptime_sec: float
    source_alias: Optional[str]
    source_symbol_root: Optional[str]
    feed_provider: str
    # PH0-02 — Bookmap sidecar drop counters + queue depths.
    bookmap_sidecar: BookmapSidecarMetrics

    # ── DATA-04 /lob/health v2 fields (v3.1 §1.3) ─────────────────────────────
    # All optional on the wire contract. Bookmap mode emits what it can
    # derive (provider_kind="bookmap", raw_symbol from source_alias,
    # reconnect_count from ws_reconnects_total) and leaves Databento-
    # specific fields null until DATA-09..13 population.
    #
    # `schema` is aliased to avoid shadowing Pydantic BaseModel.schema;
    # the wire contract still emits it as `"schema"`.
    model_config = ConfigDict(populate_by_name=True)
    provider_kind: Optional[str] = None
    dataset: Optional[str] = None
    databento_schema: Optional[str] = Field(default=None, alias="schema")
    instrument_id: Optional[int] = None
    raw_symbol: Optional[str] = None
    reconnect_count: Optional[int] = None
    last_ts_recv_ns: Optional[int] = None
    symbol_mapping_age_ms: Optional[int] = None
    snapshot_synced: Optional[bool] = None
    gap_detected_count: Optional[int] = None
    last_clear_book_ts: Optional[int] = None
    # DATA-13 — slow-reader / lag / gap / reconnect boundary (Databento mode)
    slow_reader_warning_count: Optional[int] = None
    lag_ms_p50: Optional[float] = None
    lag_ms_p95: Optional[float] = None
    # Units: nanoseconds (ts_recv_ns) at first post-reconnect record, not wall-clock ms.
    last_replay_completed_ts: Optional[int] = None
    # ── v3.2.1 §5.2 authoritative-book FSM state on /lob/health ──────────────
    # All optional on the wire. Populated in Databento L2-primary mode
    # from the pinned-instrument FSM; null in legacy/rollback.
    # Reviewer P1 (Slice 11): /lob/health must expose the machine-
    # readable authority state; previously only /lob/bbo did.
    quote_authoritative: Optional[bool] = None
    reconvergence_epoch_ts_ms: Optional[int] = None
    reconvergence_updates_without_gap: Optional[int] = None
    last_gap_ts_ms: Optional[int] = None
    last_provider_error_ts_ms: Optional[int] = None
    last_bid_update_ts_ms: Optional[int] = None
    last_ask_update_ts_ms: Optional[int] = None
    warmup_state: Optional[str] = None
    not_authoritative_reason: Optional[str] = None


def _lob_health_core_fields_from_overlay(overlay: dict) -> tuple[str, bool, bool, float]:
    """
    DATA-12: when Databento ingest is active but the MBO kernel has not yet
    observed clear/F_LAST (snapshot_synced is not True), /lob/health must not
    report Bookmap-derived ok/fresh — that would contradict fail-closed BBO.
    In that window, derive status / connection / freshness / age from the
    Databento provider + recv timestamps only.
    """
    if databento_provider is not None and overlay.get("snapshot_synced") is not True:
        h = databento_provider.health()
        now_ms = int(time.time() * 1000)
        if isinstance(h.last_ts_recv_ns, int):
            recv_ms = h.last_ts_recv_ns // 1_000_000
            db_bbo_age_ms = max(0.0, float(now_ms - recv_ms))
        else:
            db_bbo_age_ms = 99999.0
        return (
            "degraded",
            h.connected,
            False,
            db_bbo_age_ms,
        )
    status = "ok" if state.connected and state.is_fresh else "degraded"
    return (
        status,
        state.connected,
        state.is_fresh,
        state.bbo_age_ms,
    )


@app.get("/lob/health", response_model=HealthResponse)
def lob_health():
    overlay = _data09_health_overlay()
    status, source_connected, bbo_fresh, bbo_age_ms = _lob_health_core_fields_from_overlay(overlay)
    return HealthResponse(
        status=status,
        source_connected=source_connected,
        bbo_fresh=bbo_fresh,
        bbo_age_ms=bbo_age_ms,
        update_count=state.update_count,
        trade_count=state.trade_count,
        depth_levels_bid=len(state.depth.bids),
        depth_levels_ask=len(state.depth.asks),
        mbo_events_buffered=state.mbo_agg.event_count,
        mbo_total_count=state.mbo_total_count,
        mbo_status=state.mbo_status,
        mbo_age_ms=state.mbo_age_ms,
        mbo_adv_event_count=state.advanced_mbo.event_count,
        active_trade_id=state.active_trade_id,
        active_signal_id=state.active_signal_id,
        recording_context=state.recording_context,
        uptime_sec=round(time.time() - START_TIME, 1),
        source_alias=state.source_alias,
        source_symbol_root=state.source_symbol_root,
        # v3.2.1 §1.1: Databento L2 is canonical primary; Bookmap L3
        # is adjunct. The role label follows the active primary. If
        # Databento is wired (MARKET_DATA_PROVIDER=databento), the
        # role is "databento_l2_primary"; otherwise the legacy
        # Bookmap path ("bookmap_rithmic_l2_primary_legacy") is
        # advertised so a post-v3.2.1 consumer can tell which era it
        # is reading.
        feed_provider=(
            "databento_l2_primary"
            if databento_provider is not None
            else "bookmap_rithmic_l2_primary_legacy"
        ),
        bookmap_sidecar=_build_bookmap_sidecar_metrics(),
        # ── DATA-04 /lob/health v2 fields ─────────────────────────────────────
        # Per v3.1 §1.3: additive and nullable. Bookmap-mode populates what
        # it can; Databento-specific fields are filled by the DATA-09
        # live-ingest provider when it is active.
        #
        # DATA-09 integration: when the databento ingest task is running
        # alongside (MARKET_DATA_PROVIDER=databento), the Databento
        # provider's health struct overrides provider_kind, dataset,
        # raw_symbol (honest pinned value from record.raw_symbol),
        # instrument_id, reconnect_count, and last_ts_recv_ns. All other
        # DATA-04 fields still belong to later tickets (DATA-10 symbol
        # mapping, DATA-11 MBO kernel → snapshot_synced, DATA-12 F_LAST →
        # last_clear_book_ts, DATA-13 gap telemetry).
        **overlay,
    )


def _data09_health_overlay() -> dict:
    """
    Build the DATA-04 v2 fields dict, deferring to the DATA-09 databento
    provider's health struct when the provider is running, otherwise
    falling back to Bookmap-derived values.

    This is the one-place source-of-truth rule for provider-conditioned
    health — every field that depends on which provider is authoritative
    lives here so a later refactor can't silently introduce branching.
    """
    # v3.2.1 §5.2 FSM field set — all None on legacy/rollback; populated
    # from the pinned-instrument FSM in Databento L2-primary mode.
    _v321_fsm_null = {
        "quote_authoritative": None,
        "reconvergence_epoch_ts_ms": None,
        "reconvergence_updates_without_gap": None,
        "last_gap_ts_ms": None,
        "last_provider_error_ts_ms": None,
        "last_bid_update_ts_ms": None,
        "last_ask_update_ts_ms": None,
        "warmup_state": None,
        "not_authoritative_reason": None,
    }
    bookmap_defaults = {
        "provider_kind": "bookmap",
        "dataset": None,
        "databento_schema": None,
        "instrument_id": None,
        "raw_symbol": _parse_raw_symbol_from_alias(state.source_alias),
        "reconnect_count": state.bookmap_ws_reconnects_total,
        "last_ts_recv_ns": None,
        "symbol_mapping_age_ms": None,
        "snapshot_synced": None,
        "gap_detected_count": None,
        "last_clear_book_ts": None,
        "slow_reader_warning_count": None,
        "lag_ms_p50": None,
        "lag_ms_p95": None,
        "last_replay_completed_ts": None,
        **_v321_fsm_null,
    }
    # DATA-12 (v3.2.3 §6.1): under the Bookmap-primary live architecture,
    # the authority FSM is fed by the Bookmap sink (not by Databento).
    # Overlay the Bookmap live FSM state onto bookmap_defaults so
    # /lob/health surfaces quote_authoritative + the 8 diagnostic
    # fields under Bookmap mode, not just under dormant Databento mode.
    _primary = _primary_live_authority_snapshot()
    if _primary is not None:
        bookmap_defaults.update({
            "quote_authoritative": _primary.get("quote_authoritative"),
            "reconvergence_epoch_ts_ms": _primary.get("reconvergence_epoch_ts_ms"),
            "reconvergence_updates_without_gap":
                _primary.get("reconvergence_updates_without_gap"),
            "last_gap_ts_ms": _primary.get("last_gap_ts_ms"),
            "last_provider_error_ts_ms": _primary.get("last_provider_error_ts_ms"),
            "last_bid_update_ts_ms": _primary.get("last_bid_update_ts_ms"),
            "last_ask_update_ts_ms": _primary.get("last_ask_update_ts_ms"),
            "warmup_state": _primary.get("warmup_state"),
            "not_authoritative_reason": _primary.get("not_authoritative_reason"),
        })
    if databento_provider is None:
        return bookmap_defaults
    h = databento_provider.health()
    # DATA-10: expose symbol_mapping_age_ms from the resolver when the
    # Databento provider is active. None until the first
    # SymbolMappingMsg pins the session.
    try:
        mapping_age_ms = databento_provider.symbol_mapping_age_ms()
    except AttributeError:
        mapping_age_ms = None
    snapshot_synced, last_clear_book_ts = _data12_snapshot_state_for_instrument(h.instrument_id)
    lag_p50, lag_p95 = databento_ingest_telemetry.lag_percentiles()
    # DATA-12 (v3.2.3 §6.1): use the single _primary_live_authority_snapshot
    # helper so Databento-rollback mode and Bookmap-primary mode read
    # from the same source. If both FSMs exist, Bookmap wins (primary).
    fsm_overlay = dict(_v321_fsm_null)
    _primary_rollback = _primary_live_authority_snapshot()
    if _primary_rollback is not None:
        fsm_overlay = {
            "quote_authoritative": _primary_rollback.get("quote_authoritative"),
            "reconvergence_epoch_ts_ms": _primary_rollback.get("reconvergence_epoch_ts_ms"),
            "reconvergence_updates_without_gap":
                _primary_rollback.get("reconvergence_updates_without_gap"),
            "last_gap_ts_ms": _primary_rollback.get("last_gap_ts_ms"),
            "last_provider_error_ts_ms": _primary_rollback.get("last_provider_error_ts_ms"),
            "last_bid_update_ts_ms": _primary_rollback.get("last_bid_update_ts_ms"),
            "last_ask_update_ts_ms": _primary_rollback.get("last_ask_update_ts_ms"),
            "warmup_state": _primary_rollback.get("warmup_state"),
            "not_authoritative_reason": _primary_rollback.get("not_authoritative_reason"),
        }
    return {
        **bookmap_defaults,
        "provider_kind": h.provider_kind,
        "dataset": h.dataset,
        "instrument_id": h.instrument_id,
        # Databento raw_symbol is the honest pinned value from the
        # resolver (DATA-10); prefer it over the alias-parsed Bookmap
        # value. health() already overlays the resolver's pin so this
        # read is authoritative.
        "raw_symbol": h.raw_symbol if h.raw_symbol else bookmap_defaults["raw_symbol"],
        "reconnect_count": h.reconnect_count,
        "last_ts_recv_ns": h.last_ts_recv_ns,
        "symbol_mapping_age_ms": mapping_age_ms,
        "snapshot_synced": snapshot_synced,
        "last_clear_book_ts": last_clear_book_ts,
        "gap_detected_count": databento_ingest_telemetry.gap_detected_count,
        "slow_reader_warning_count": databento_ingest_telemetry.slow_reader_warning_count,
        "lag_ms_p50": lag_p50,
        "lag_ms_p95": lag_p95,
        "last_replay_completed_ts": databento_ingest_telemetry.last_replay_completed_ts_ns,
        **fsm_overlay,
    }


# ─── REST: Lightweight BBO ───────────────────────────────────────────────────

class BboResponse(BaseModel):
    bid: Optional[float] = None
    ask: Optional[float] = None
    mid: Optional[float] = None
    spread_pts: Optional[float] = None
    bbo_age_ms: float
    timestamp_ms: int  # DATA-03: deprecated; prefer source_event_ts_ms / source_recv_ts_ms / engine_response_ts_ms
    source_connected: bool
    update_count: int
    is_fresh: bool
    last_bbo_ts_ms: int

    # ── DATA-03 v2 honest-BBO timestamp fields (v3.1 §1.3) ────────────────────
    # All optional on the wire. Bookmap-mode emits source_event/recv/response
    # derived from last_bbo_ts; ns-resolution fields stay null (Bookmap does
    # not surface ns timestamps). Databento-mode population lands with
    # DATA-09..13.
    source_event_ts_ms: Optional[int] = None
    source_recv_ts_ms: Optional[int] = None
    engine_response_ts_ms: Optional[int] = None
    ts_event_ns: Optional[int] = None
    ts_recv_ns: Optional[int] = None
    ts_in_delta_ns: Optional[int] = None
    # DATA-12 publication safety fields.
    snapshot_synced: Optional[bool] = None
    last_clear_book_ts: Optional[int] = None
    # v3.2.1 §5.2 — authoritative-book FSM state on /lob/bbo.
    # All null in Bookmap-primary-legacy mode; populated in
    # Databento L2 primary mode after the first MBP-10 event.
    quote_authoritative: Optional[bool] = None
    reconvergence_epoch_ts_ms: Optional[int] = None
    reconvergence_updates_without_gap: Optional[int] = None
    last_gap_ts_ms: Optional[int] = None
    last_provider_error_ts_ms: Optional[int] = None
    last_bid_update_ts_ms: Optional[int] = None
    last_ask_update_ts_ms: Optional[int] = None
    warmup_state: Optional[str] = None
    not_authoritative_reason: Optional[str] = None


def _data12_snapshot_state_for_instrument(instrument_id: Optional[int]) -> tuple[Optional[bool], Optional[int]]:
    """
    DATA-12 retrofit (v3.2.1 §5.2): publication gate fields for
    /lob/health. Reads from the L2 authoritative-book FSM (new) AND
    the MBP-10 book state (new) rather than the legacy MBO kernel's
    F_LAST-based clear counter.

    Returns (snapshot_synced, last_clear_book_ts) — shape preserved
    for existing /lob/health consumers. Full v3.2.1 §5.2 state is
    available via databento_l2_authority_snapshots() +
    dual_provider_telemetry_snapshot().

    Rollback path (DATABENTO_SCHEMAS="mbo,..."): the legacy MBO
    kernel still populates `databento_kernel_registry` and has a
    `stats.clears_observed` counter. We honor that fallback ONLY
    when the new FSM has no state for the pinned instrument,
    preserving byte-identical behavior for rollback runs. The new
    FSM is authoritative whenever it has seen the instrument.
    """
    if not isinstance(instrument_id, int):
        return (None, None)
    fsm = databento_l2_authority_registry.get(instrument_id)
    if fsm is not None:
        s = fsm.state
        # v3.2.1 §5.2 — reconvergence is machine-readable; snapshot
        # is True only when the FSM says so. last_clear_book_ts is
        # derived from the MBP-10 book state's last R action.
        last_clear_ts_ns: Optional[int] = None
        mbp10 = databento_mbp10_registry.get(instrument_id)
        if mbp10 is not None:
            last_clear_ts_ns = mbp10.last_clear_ts_ns
        return (bool(s.snapshot_synced), last_clear_ts_ns)
    # Fallback: DATABENTO_SCHEMAS=mbo,... rollback runs still feed the
    # legacy kernel.
    kernel = databento_kernel_registry.get(instrument_id)
    if kernel is None:
        return (False, None)
    return (kernel.stats.clears_observed > 0, kernel.stats.last_clear_ts_recv_ns)


def _data12_databento_bbo_overlay(now_ms: int) -> Optional[dict]:
    """
    Build a Databento-mode /lob/bbo payload guarded by the v3.2.1
    §5.2 DATA-12 authoritative-book FSM.

    Retrofit (Slice 10): gating is now fail-closed on
    `quote_authoritative=false` per §5.2 — that single bool is the
    five-rule reconvergence verdict. Top-of-book comes from the
    MBP-10 registry (L2-canonical) when the FSM is active; legacy
    MBO-kernel fallback is preserved only for DATABENTO_SCHEMAS
    rollback sessions.

    Adds v3.2.1 §5.2 publishable fields to the response so consumers
    can read the reconvergence state machine directly:
      quote_authoritative, reconvergence_epoch_ts_ms,
      reconvergence_updates_without_gap, last_gap_ts_ms,
      last_provider_error_ts_ms, last_bid_update_ts_ms,
      last_ask_update_ts_ms, warmup_state,
      not_authoritative_reason.
    """
    if databento_provider is None:
        return None
    h = databento_provider.health()
    snapshot_synced, last_clear_book_ts = _data12_snapshot_state_for_instrument(h.instrument_id)
    ts_recv_ns = h.last_ts_recv_ns if isinstance(h.last_ts_recv_ns, int) else None
    source_recv_ms = int(ts_recv_ns / 1_000_000) if ts_recv_ns is not None else None
    bbo_age_ms = 99999.0
    if source_recv_ms is not None:
        bbo_age_ms = max(0.0, float(now_ms - source_recv_ms))

    # v3.2.1 §5.2 authority state — read the FSM when available.
    fsm_state_dict: dict = {}
    quote_authoritative: Optional[bool] = None
    if isinstance(h.instrument_id, int):
        fsm = databento_l2_authority_registry.get(h.instrument_id)
        if fsm is not None:
            fsm_state_dict = fsm.to_health_dict()
            quote_authoritative = bool(fsm_state_dict.get("quote_authoritative"))

    def _fsm_fields() -> dict:
        """Fields from §5.2 carried on every BBO response."""
        return {
            "quote_authoritative": quote_authoritative,
            "reconvergence_epoch_ts_ms": fsm_state_dict.get("reconvergence_epoch_ts_ms"),
            "reconvergence_updates_without_gap": fsm_state_dict.get("reconvergence_updates_without_gap"),
            "last_gap_ts_ms": fsm_state_dict.get("last_gap_ts_ms"),
            "last_provider_error_ts_ms": fsm_state_dict.get("last_provider_error_ts_ms"),
            "last_bid_update_ts_ms": fsm_state_dict.get("last_bid_update_ts_ms"),
            "last_ask_update_ts_ms": fsm_state_dict.get("last_ask_update_ts_ms"),
            "warmup_state": fsm_state_dict.get("warmup_state"),
            "not_authoritative_reason": fsm_state_dict.get("not_authoritative_reason"),
        }

    # Fail-closed rule (§5.2 publication):
    #   - On the v3.2.1 L2-primary path (FSM populated): publish only
    #     when BOTH snapshot_synced=true AND quote_authoritative=true.
    #   - On the legacy rollback path (FSM absent for this instrument,
    #     DATABENTO_SCHEMAS=mbo,... session): fall back to the v3.1
    #     snapshot_synced gate alone so rollback runs keep byte-
    #     identical publication behavior.
    # quote_authoritative is None when the FSM has never seen this
    # instrument (rollback case); True/False otherwise.
    if quote_authoritative is None:
        authority_ok = (snapshot_synced is True)
    else:
        authority_ok = (quote_authoritative is True) and (snapshot_synced is True)
    if not authority_ok:
        payload = {
            "bid": None,
            "ask": None,
            "mid": None,
            "spread_pts": None,
            "bbo_age_ms": bbo_age_ms,
            "timestamp_ms": now_ms,
            "source_connected": h.connected,
            "update_count": h.message_count,
            "is_fresh": False,
            "last_bbo_ts_ms": source_recv_ms or 0,
            "source_event_ts_ms": None,
            "source_recv_ts_ms": source_recv_ms,
            "engine_response_ts_ms": now_ms,
            "ts_event_ns": None,
            "ts_recv_ns": ts_recv_ns,
            "ts_in_delta_ns": None,
            "snapshot_synced": snapshot_synced,
            "last_clear_book_ts": last_clear_book_ts,
        }
        payload.update(_fsm_fields())
        return payload

    # Authoritative — read top-of-book from MBP-10 (v3.2.1 L2 primary).
    # Legacy MBO kernel is only consulted on rollback (no MBP-10 state).
    iid = h.instrument_id if isinstance(h.instrument_id, int) else None
    snap_bid = snap_ask = None
    snap_ts_recv_ns: Optional[int] = None
    if iid is not None:
        mbp10 = databento_mbp10_registry.get(iid)
        if mbp10 is not None:
            mb_snap = mbp10.snapshot(depth=1)
            snap_bid = mb_snap.best_bid()
            snap_ask = mb_snap.best_ask()
            snap_ts_recv_ns = mb_snap.ts_recv_ns
        else:
            kernel = databento_kernel_registry.get(iid)
            if kernel is not None:
                k_snap = kernel.snapshot(depth=1)
                snap_bid = k_snap.best_bid()
                snap_ask = k_snap.best_ask()
                snap_ts_recv_ns = k_snap.ts_recv_ns
    if snap_bid is None and snap_ask is None:
        return None
    bid = float(snap_bid) if snap_bid is not None else None
    ask = float(snap_ask) if snap_ask is not None else None
    mid = None
    spread = None
    if bid is not None and ask is not None:
        mid = (bid + ask) / 2.0
        spread = ask - bid
    payload = {
        "bid": bid,
        "ask": ask,
        "mid": mid,
        "spread_pts": spread,
        "bbo_age_ms": bbo_age_ms,
        "timestamp_ms": now_ms,
        "source_connected": h.connected,
        "update_count": h.message_count,
        "is_fresh": bool(bid is not None and ask is not None and bbo_age_ms < 3000.0),
        "last_bbo_ts_ms": source_recv_ms or 0,
        "source_event_ts_ms": None,
        "source_recv_ts_ms": source_recv_ms,
        "engine_response_ts_ms": now_ms,
        "ts_event_ns": None,
        "ts_recv_ns": snap_ts_recv_ns,
        "ts_in_delta_ns": None,
        "snapshot_synced": snapshot_synced,
        "last_clear_book_ts": last_clear_book_ts,
    }
    payload.update(_fsm_fields())
    return payload


@app.get("/lob/bbo", response_model=BboResponse)
def lob_bbo():
    spread = None
    if state.bid is not None and state.ask is not None:
        spread = round(state.ask - state.bid, 2)

    # DATA-03: derive honest source-side timestamps from the existing
    # state.last_bbo_ts (seconds since epoch). Bookmap does not separate
    # source_event vs source_recv; we map both to last_bbo_ts and let
    # DATA-09 Databento ingest split them with real wire timestamps.
    now_ms = int(time.time() * 1000)
    databento_overlay = _data12_databento_bbo_overlay(now_ms)
    if databento_overlay is not None:
        return BboResponse(**databento_overlay)

    source_event_ms: Optional[int] = None
    source_recv_ms: Optional[int] = None
    if state.last_bbo_ts and state.last_bbo_ts > 0:
        src_ms = int(state.last_bbo_ts * 1000)
        source_event_ms = src_ms
        source_recv_ms = src_ms

    return BboResponse(
        bid=state.bid,
        ask=state.ask,
        mid=state.mid,
        spread_pts=spread,
        bbo_age_ms=state.bbo_age_ms,
        timestamp_ms=now_ms,
        source_connected=state.connected,
        update_count=state.update_count,
        is_fresh=state.is_fresh,
        last_bbo_ts_ms=int(state.last_bbo_ts * 1000) if state.last_bbo_ts > 0 else 0,
        # DATA-03 v2 fields
        source_event_ts_ms=source_event_ms,
        source_recv_ts_ms=source_recv_ms,
        engine_response_ts_ms=now_ms,
        # ns fields stay None in Bookmap mode; Databento populates in DATA-09..13
        ts_event_ns=None,
        ts_recv_ns=None,
        ts_in_delta_ns=None,
        snapshot_synced=None,
        last_clear_book_ts=None,
    )


# ─── REST: Full Feature Snapshot ──────────────────────────────────────────────

@app.get("/lob/snapshot")
def lob_snapshot():
    """
    Full feature snapshot.

    Bookmap-authoritative state from SidecarState is the primary
    payload. DATA-15 adds a `databento_cvd` field: a map from
    instrument_id → per-instrument Databento-native CVD snapshot.
    The field is OMITTED entirely when the Databento path has never
    observed a trade, preserving the pre-DATA-15 Bookmap-only
    snapshot shape byte-for-byte for consumers that don't know
    about Databento CVD.

    DATA-16 will decide whether to promote Databento CVD into
    state.cvd_* (authority flip); today this field is purely
    additive and non-authoritative.
    """
    snap = state.get_cached_snapshot()
    cvd_by_iid = databento_cvd_snapshots()
    ofi_by_iid = databento_ofi_snapshots()
    # DATA-16 review-fix: restrict the orderflow map to the pinned
    # session instrument so TS consumers cannot bind the wrong
    # contract's OFI. Pre-pin discovery traffic, multi-parent
    # subscriptions, or stale accumulators can otherwise leave
    # multiple instruments present. If no pin is known yet, omit
    # the field entirely rather than publishing an ambiguous map.
    pinned_iid: Optional[int] = None
    pinned_raw_symbol: Optional[str] = None
    if databento_provider is not None:
        try:
            h = databento_provider.health()
            if isinstance(h.instrument_id, int):
                pinned_iid = h.instrument_id
            if isinstance(h.raw_symbol, str) and h.raw_symbol:
                pinned_raw_symbol = h.raw_symbol
        except Exception:
            pinned_iid = None
            pinned_raw_symbol = None
    if ofi_by_iid and pinned_iid is not None and pinned_iid in ofi_by_iid:
        ofi_pinned_only = {pinned_iid: ofi_by_iid[pinned_iid]}
    else:
        ofi_pinned_only = {}
    if cvd_by_iid or ofi_pinned_only:
        # Defensive: get_cached_snapshot may return a cached dict that
        # is shared across callers. Copy before mutation so we never
        # mutate cached state from a read-only endpoint.
        if isinstance(snap, dict):
            snap = dict(snap)
            if cvd_by_iid:
                snap["databento_cvd"] = cvd_by_iid
            if ofi_pinned_only:
                # DATA-16: sidecar-authoritative OFI passthrough. The
                # TS runner reads this from /lob/snapshot and prefers
                # it over its local candidate-time OFI compute (v3.1
                # §3.3). Omitted entirely when no OFI events have been
                # observed — preserves pre-DATA-16 snapshot shape for
                # the Bookmap-only path. Filtered to the pinned
                # instrument only (review-fix) so consumers cannot
                # mis-bind to a discovery/stale contract.
                snap["databento_orderflow"] = ofi_pinned_only
                snap["databento_orderflow_pinned_instrument_id"] = pinned_iid
                if pinned_raw_symbol is not None:
                    snap["databento_orderflow_pinned_raw_symbol"] = (
                        pinned_raw_symbol
                    )
        else:
            # Non-dict snapshots (Pydantic models etc.) stay unchanged.
            pass
    return snap


# ─── REST: Context Endpoints ─────────────────────────────────────────────────

class TradeContextRequest(BaseModel):
    trade_id: str
    side: Optional[str] = None
    entry_price: Optional[float] = None

class SignalContextRequest(BaseModel):
    signal_id: str
    direction: Optional[str] = None


@app.post("/trade_context/start")
def trade_context_start(req: TradeContextRequest):
    state.active_trade_id = req.trade_id
    state.trade_end_ts = None
    state.invalidate_snapshot_cache()
    state.last_trade_record_ts = 0  # force immediate snapshot
    # Record the intent
    append_jsonl("execution_intents.jsonl", {
        "type": "trade_start", "ts": int(time.time() * 1000),
        "trade_id": req.trade_id, "side": req.side,
        "entry_price": req.entry_price,
    })
    # Immediate snapshot at trade start
    snap = state.compute_snapshot()
    append_jsonl("lob_snapshots.jsonl", snap.to_dict())
    print(f"[CTX] Trade started: {req.trade_id}")
    return {"status": "ok", "trade_id": req.trade_id, "recording_context": "trade"}


@app.post("/trade_context/end")
def trade_context_end(req: TradeContextRequest):
    # Final snapshot before clearing trade context
    snap = state.compute_snapshot()
    append_jsonl("lob_snapshots.jsonl", snap.to_dict())
    append_jsonl("execution_results.jsonl", {
        "type": "trade_end", "ts": int(time.time() * 1000),
        "trade_id": req.trade_id,
    })
    state.trade_end_ts = time.time()
    state.active_trade_id = None
    state.invalidate_snapshot_cache()
    print(f"[CTX] Trade ended: {req.trade_id} (post-exit recording for {POST_EXIT_WINDOW_SEC}s)")
    return {"status": "ok", "trade_id": req.trade_id, "recording_context": "post_exit"}


@app.post("/signal_context/start")
def signal_context_start(req: SignalContextRequest):
    state.active_signal_id = req.signal_id
    state.invalidate_snapshot_cache()
    state.last_trade_record_ts = 0  # force immediate snapshot
    snap = state.compute_snapshot()
    append_jsonl("lob_snapshots.jsonl", snap.to_dict())
    print(f"[CTX] Signal window started: {req.signal_id}")
    return {"status": "ok", "signal_id": req.signal_id}


@app.post("/signal_context/end")
def signal_context_end(req: SignalContextRequest):
    snap = state.compute_snapshot()
    append_jsonl("lob_snapshots.jsonl", snap.to_dict())
    state.active_signal_id = None
    state.invalidate_snapshot_cache()
    print(f"[CTX] Signal window ended: {req.signal_id}")
    return {"status": "ok", "signal_id": req.signal_id}


# ─── Direct run ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("MKT_DATA_PORT", "5010"))
    print(f"[MKT-DATA] Starting on http://127.0.0.1:{port}")
    uvicorn.run("app:app", host="127.0.0.1", port=port, log_level="info")
