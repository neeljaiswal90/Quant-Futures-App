"""Tests for the capture-tail watcher: compute, debounce, min-interval."""

from __future__ import annotations

import threading
import time
from datetime import datetime
from pathlib import Path

from realtime_backend.settings import Settings
from realtime_backend.watcher import (
    CaptureWatcher,
    ComputeResult,
    resolve_session,
    run_compute,
)

from .conftest import PT, sample_envelope, trade, write_raw


def _fixture_root(tmp_path: Path) -> Path:
    root = tmp_path / "analytics"
    capture = root / "data" / "captures" / "2026-05-22" / "MNQ_globex.jsonl"
    base = int(datetime(2026, 5, 21, 19, 5, tzinfo=PT).timestamp() * 1_000_000_000)
    rows = [
        trade(base + i * 30_000_000_000, 29400.0 + (i % 5), 4, "buy" if i % 2 == 0 else "sell")
        for i in range(40)
    ]
    write_raw(capture, rows)
    zones = root / "data" / "zones" / "2026-05-22_MNQ_globex.json"
    zones.parent.mkdir(parents=True, exist_ok=True)
    import json

    zones.write_text(json.dumps(sample_envelope()), encoding="utf-8")
    return root


def _settings(tmp_path: Path, root: Path) -> Settings:
    return Settings(
        analytics_root=root,
        scratch_dir=tmp_path / "scratch" / "dashboard",
        ewma_calibration_path=None,
        session_override="globex",
        trading_date_override="2026-05-22",
        debounce_seconds=0.05,
        min_compute_interval_seconds=0.05,
        poll_fallback_interval_seconds=0.0,  # disable backstop for determinism
        use_polling_observer=True,
    )


def test_run_compute_produces_signals(tmp_path: Path) -> None:
    root = _fixture_root(tmp_path)
    settings = _settings(tmp_path, root)
    result = run_compute(settings, now_pt=datetime(2026, 5, 21, 20, 0, tzinfo=PT))
    assert isinstance(result, ComputeResult)
    assert result.signals.trade_count == 40
    assert result.current_price is not None
    assert result.last_append_ts_ns is not None


def test_resolve_session_uses_overrides(tmp_path: Path) -> None:
    root = _fixture_root(tmp_path)
    settings = _settings(tmp_path, root)
    session = resolve_session(settings, now_pt=datetime(2026, 5, 21, 20, 0, tzinfo=PT))
    assert session.session == "globex"
    assert session.trading_date == "2026-05-22"


def test_watcher_watch_dir_re_resolves_in_auto_mode(tmp_path: Path) -> None:
    root = _fixture_root(tmp_path)
    settings = Settings(
        analytics_root=root,
        scratch_dir=tmp_path / "scratch" / "dashboard",
        ewma_calibration_path=None,
        session_override=None,
        trading_date_override=None,
        poll_fallback_interval_seconds=0.0,
        use_polling_observer=True,
    )
    current = [datetime(2026, 5, 21, 20, 0, tzinfo=PT)]
    watcher = CaptureWatcher(
        settings,
        lambda _r: None,
        now_pt_factory=lambda: current[0],
    )

    assert watcher.watch_dir == root / "data" / "captures" / "2026-05-22"

    current[0] = datetime(2026, 5, 22, 20, 0, tzinfo=PT)

    assert watcher.watch_dir == root / "data" / "captures" / "2026-05-23"


def test_watcher_recomputes_after_trigger(tmp_path: Path) -> None:
    root = _fixture_root(tmp_path)
    settings = _settings(tmp_path, root)
    capture = settings.analytics_root / "data" / "captures" / "2026-05-22" / "MNQ_globex.jsonl"

    results: list[ComputeResult] = []
    done = threading.Event()

    def on_result(r: ComputeResult) -> None:
        results.append(r)
        done.set()

    watcher = CaptureWatcher(
        settings,
        on_result,
        now_pt_factory=lambda: datetime(2026, 5, 21, 20, 0, tzinfo=PT),
    )
    seed = watcher.seed()
    seed_sweeps = len(seed.signals.sweeps)
    watcher.start()
    try:
        # Append a sweep burst and trigger a recompute deterministically.
        sweep_base = int(datetime(2026, 5, 21, 19, 50, tzinfo=PT).timestamp() * 1_000_000_000)
        with capture.open("a", encoding="utf-8") as f:
            import json

            for i in range(10):
                f.write(
                    json.dumps(trade(sweep_base + i * 1_000_000_000, 29425.0 + i * 0.25, 80, "buy"))
                    + "\n"
                )
        watcher.trigger()
        assert done.wait(timeout=10.0), "watcher did not produce a result"
    finally:
        watcher.stop()

    assert results, "no recompute result captured"
    assert len(results[-1].signals.sweeps) >= seed_sweeps


def test_debounce_coalesces_burst_into_few_runs(tmp_path: Path) -> None:
    root = _fixture_root(tmp_path)
    settings = _settings(tmp_path, root)

    run_count = {"n": 0}
    lock = threading.Lock()

    def on_result(_r: ComputeResult) -> None:
        with lock:
            run_count["n"] += 1

    watcher = CaptureWatcher(
        settings,
        on_result,
        now_pt_factory=lambda: datetime(2026, 5, 21, 20, 0, tzinfo=PT),
    )
    watcher.start()
    try:
        # Fire a tight burst of 50 triggers; debounce should collapse them
        # into far fewer than 50 detector runs.
        for _ in range(50):
            watcher.trigger()
            time.sleep(0.001)
        time.sleep(0.6)
    finally:
        watcher.stop()

    assert run_count["n"] < 50
    assert run_count["n"] >= 1
