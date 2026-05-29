"""Capture-tail watcher: filesystem events → debounced detector runs.

A :class:`CaptureWatcher` watches the live capture directory with watchdog
(falling back to :class:`PollingObserver` when native FS events are flaky) and,
on append, schedules a recompute. Two rate limits apply (GREEN-LIT):

- a **250 ms trailing debounce** — bursty appends coalesce into one run, and
- a **>= 500 ms minimum interval** between :func:`compute_live_signals` calls.

The heavy work (``compute_live_signals`` + ``build_recent_signals``, both
synchronous and disk-bound) runs in a dedicated worker thread so it never
blocks the asyncio event loop. Completed :class:`ComputeResult`s are handed
back to the loop via ``loop.call_soon_threadsafe`` and an async callback.

The detector is disk-stateful (append-then-reload), so ``dashboard_dir`` is the
BACKEND-OWNED scratch dir from :class:`Settings` — never a capture dir.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from rithmic_analytics.cli.normalize_probe_incremental import normalize_incremental
from rithmic_dashboard.data_sources import load_envelope
from rithmic_dashboard.features.live_signals import compute_live_signals
from rithmic_dashboard.features.recent_signals_panel import RecentSignal, build_recent_signals
from rithmic_dashboard.models import DashboardSession, LiveSignals
from rithmic_dashboard.session_state import determine_session_state
from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer
from watchdog.observers.api import BaseObserver
from watchdog.observers.polling import PollingObserver

from realtime_backend.price_ticks import LatestPriceTick, latest_price_tick
from realtime_backend.settings import Settings

_LOG = logging.getLogger(__name__)


@dataclass(frozen=True)
class ComputeResult:
    """One detector pass, ready for the feed engine to diff + emit."""

    signals: LiveSignals
    envelope: dict[str, Any] | None
    recent_signals: list[RecentSignal]
    current_price: float | None
    last_append_ts_ns: int | None
    price_tick: LatestPriceTick | None


ResultCallback = Callable[[ComputeResult], None]
PriceTickCallback = Callable[[LatestPriceTick], None]


def resolve_session(settings: Settings, *, now_pt: datetime | None = None) -> DashboardSession:
    """Resolve the active session against the configured analytics root."""
    return determine_session_state(
        now_pt=now_pt,
        analytics_root=settings.analytics_root,
        trading_date_override=settings.trading_date_override,
        session_override=settings.session_override,
    )


def run_compute(
    settings: Settings,
    *,
    now_pt: datetime | None = None,
) -> ComputeResult:
    """Run one full detector pass and bundle the inputs the feed needs.

    Synchronous + disk-bound — call from a worker thread, never the loop.
    """
    session = resolve_session(settings, now_pt=now_pt)
    if settings.self_normalize:
        _self_normalize(session.capture_path)
    envelope, _zones_path, _warnings = load_envelope(
        session.zones_path,
        analytics_root=settings.analytics_root,
    )
    settings.scratch_dir.mkdir(parents=True, exist_ok=True)
    signals = compute_live_signals(
        capture_path=session.capture_path,
        envelope=envelope,
        session=session,
        dashboard_dir=settings.scratch_dir,
        ewma_calibration_path=settings.resolved_calibration_path(),
        tail_bytes=settings.tail_bytes,
        vwap_window_minutes=settings.vwap_window_minutes,
    )
    price_tick = latest_price_tick(
        trade_source_path=signals.source_path,
        capture_path=session.capture_path,
    )
    current_price = (
        price_tick.price if price_tick is not None else _current_price(signals, envelope)
    )
    live_dir = settings.scratch_dir.parent / "live_analysis"
    recent_signals = build_recent_signals(
        live_dir=live_dir,
        session=session,
        audit=[],
        scenarios=[],
        levels=[],
        now_pt=session.now_pt,
    )
    return ComputeResult(
        signals=signals,
        envelope=envelope,
        recent_signals=recent_signals,
        current_price=current_price,
        last_append_ts_ns=_last_append_ts_ns(session.capture_path, signals),
        price_tick=price_tick,
    )


def _self_normalize(capture_path: Path) -> None:
    """RA-070: bring the obs01/mbo siblings current from the raw capture in-process.

    Gated by ``Settings.self_normalize`` and meaningful only when no external
    normalizer is running (the V1 cutover). Defensive: a normalize hiccup must
    never blank the feed, so on failure we log and fall through to compute over
    whatever siblings are already on disk.
    """
    if not capture_path.name.endswith(".jsonl"):
        return
    obs01_path = capture_path.with_name(
        f"{capture_path.name.removesuffix('.jsonl')}.obs01.jsonl"
    )
    try:
        normalize_incremental(input_path=capture_path, obs01_path=obs01_path)
    except Exception as exc:  # noqa: BLE001 — never let normalize gate the feed
        _LOG.warning("self-normalize failed (%s); computing over existing siblings", exc)


def _current_price(signals: LiveSignals, envelope: dict[str, Any] | None) -> float | None:
    if signals.live_vwap.vwap is not None:
        return float(signals.live_vwap.vwap)
    if envelope is not None:
        vpoc = envelope.get("vpoc")
        try:
            return float(vpoc) if vpoc is not None else None
        except (TypeError, ValueError):
            return None
    return None


def _last_append_ts_ns(capture_path: Path, signals: LiveSignals) -> int | None:
    """Best estimate of the most recent capture append, in ns.

    Prefer the source-tail mtime (the file the detector actually read); fall
    back to None when nothing is on disk (treated as stale by the heartbeat).
    """
    candidates = [signals.source_path, capture_path]
    for path in candidates:
        try:
            if path.exists():
                return int(path.stat().st_mtime * 1_000_000_000)
        except OSError:
            continue
    return None


class _DebouncedRunner:
    """Worker thread: coalesces triggers, enforces debounce + min interval."""

    def __init__(
        self,
        settings: Settings,
        on_result: ResultCallback,
        *,
        on_error: Callable[[Exception], None] | None = None,
        now_pt_factory: Callable[[], datetime | None] | None = None,
    ) -> None:
        self._settings = settings
        self._on_result = on_result
        self._on_error = on_error
        self._now_pt_factory = now_pt_factory or (lambda: None)
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="ra60-watcher", daemon=True)
        self._last_run_monotonic: float = 0.0

    def start(self) -> None:
        self._thread.start()

    def trigger(self) -> None:
        """Signal that the capture changed; the loop debounces the work."""
        self._wake.set()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        self._thread.join(timeout=5.0)

    def run_once_blocking(self) -> ComputeResult:
        """Run a compute synchronously (used for the initial snapshot seed)."""
        result = run_compute(self._settings, now_pt=self._now_pt_factory())
        self._last_run_monotonic = time.monotonic()
        return result

    def _loop(self) -> None:
        debounce = self._settings.debounce_seconds
        min_interval = self._settings.min_compute_interval_seconds
        while not self._stop.is_set():
            # Block until a trigger arrives.
            self._wake.wait()
            if self._stop.is_set():
                return
            self._wake.clear()
            # Trailing debounce: keep collapsing triggers that arrive within
            # the debounce window into this single pending run.
            while self._wake.wait(timeout=debounce):
                if self._stop.is_set():
                    return
                self._wake.clear()
            # Min-interval guard between detector calls.
            since = time.monotonic() - self._last_run_monotonic
            if since < min_interval and self._stop.wait(timeout=min_interval - since):
                return
            try:
                result = run_compute(self._settings, now_pt=self._now_pt_factory())
                self._last_run_monotonic = time.monotonic()
                self._on_result(result)
            except Exception as exc:  # noqa: BLE001 — isolate detector failures
                if self._on_error is not None:
                    self._on_error(exc)


class _CaptureEventHandler(FileSystemEventHandler):
    """Routes capture-file modifications to the debounced runner."""

    def __init__(self, runner: _DebouncedRunner, capture_dir: Path) -> None:
        self._runner = runner
        self._capture_dir = capture_dir

    def on_any_event(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        # Any append/create within the capture day dir triggers a recompute;
        # run_compute re-resolves which sibling (obs01/mbo) to read.
        self._runner.trigger()


class CaptureWatcher:
    """Wires a watchdog observer to a debounced detector runner.

    ``on_result`` is invoked from the worker thread; the app layer marshals it
    onto the asyncio loop with ``loop.call_soon_threadsafe``.
    """

    def __init__(
        self,
        settings: Settings,
        on_result: ResultCallback,
        *,
        on_price_tick: PriceTickCallback | None = None,
        on_error: Callable[[Exception], None] | None = None,
        use_polling: bool | None = None,
        now_pt_factory: Callable[[], datetime | None] | None = None,
    ) -> None:
        self._settings = settings
        self._runner = _DebouncedRunner(
            settings,
            on_result,
            on_error=on_error,
            now_pt_factory=now_pt_factory,
        )
        self._on_price_tick = on_price_tick
        polling = settings.use_polling_observer if use_polling is None else use_polling
        self._observer: BaseObserver = PollingObserver() if polling else Observer()
        self._started = False
        self._backstop_stop = threading.Event()
        self._backstop_thread: threading.Thread | None = None
        self._fast_price_stop = threading.Event()
        self._fast_price_thread: threading.Thread | None = None

    @property
    def watch_dir(self) -> Path:
        """The capture day directory we watch (created if absent)."""
        session = resolve_session(self._settings)
        capture_dir: Path = session.capture_path.parent
        capture_dir.mkdir(parents=True, exist_ok=True)
        return capture_dir

    def seed(self) -> ComputeResult:
        """Run one compute up-front so /snapshot has state before any append."""
        return self._runner.run_once_blocking()

    def start(self) -> None:
        if self._started:
            return
        watch_dir = self.watch_dir
        handler = _CaptureEventHandler(self._runner, watch_dir)
        self._runner.start()
        self._observer.schedule(handler, str(watch_dir), recursive=False)
        self._observer.start()
        self._start_backstop()
        self._start_fast_price_poller()
        self._started = True

    def _start_backstop(self) -> None:
        """Periodically trigger a recompute as a missed-FS-event backstop.

        The debounce + min-interval guards in the runner collapse this into the
        observer-driven triggers when appends are flowing, so it is cheap; when
        the observer goes silent it guarantees the feed still advances.
        """
        interval = self._settings.poll_fallback_interval_seconds
        if interval <= 0:
            return

        def _loop() -> None:
            while not self._backstop_stop.wait(timeout=interval):
                self._runner.trigger()

        self._backstop_thread = threading.Thread(
            target=_loop, name="ra60-watcher-backstop", daemon=True
        )
        self._backstop_thread.start()

    def _start_fast_price_poller(self) -> None:
        """Poll a tiny raw-capture suffix for latest trade ticks.

        This is intentionally separate from the detector runner: it keeps the
        price line moving at sub-second latency while full orderflow/context
        still arrives from debounced compute passes.
        """
        if self._on_price_tick is None:
            return
        on_price_tick = self._on_price_tick
        interval = self._settings.fast_price_poll_interval_seconds
        if interval <= 0:
            return
        tail_bytes = self._settings.fast_price_tail_bytes

        def _loop() -> None:
            last_key: tuple[int, float, int] | None = None
            while not self._fast_price_stop.wait(timeout=interval):
                try:
                    session = resolve_session(self._settings)
                    tick = latest_price_tick(
                        trade_source_path=session.capture_path,
                        capture_path=session.capture_path,
                        tail_bytes=tail_bytes,
                    )
                    if tick is None or tick.dedupe_key == last_key:
                        continue
                    last_key = tick.dedupe_key
                    on_price_tick(tick)
                except Exception as exc:  # noqa: BLE001
                    _LOG.debug("fast price poll failed: %s", exc)

        self._fast_price_thread = threading.Thread(
            target=_loop, name="ra60-fast-price", daemon=True
        )
        self._fast_price_thread.start()

    def trigger(self) -> None:
        """Manually request a recompute (used by tests)."""
        self._runner.trigger()

    def stop(self) -> None:
        if not self._started:
            return
        self._backstop_stop.set()
        self._fast_price_stop.set()
        if self._fast_price_thread is not None:
            self._fast_price_thread.join(timeout=5.0)
            self._fast_price_thread = None
        if self._backstop_thread is not None:
            self._backstop_thread.join(timeout=5.0)
            self._backstop_thread = None
        self._observer.stop()
        self._observer.join(timeout=5.0)
        self._runner.stop()
        self._started = False


__all__ = ["CaptureWatcher", "ComputeResult", "resolve_session", "run_compute"]
