"""RA-052 opt-in RSS smoke for intraday-light mode."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from contextlib import suppress
from pathlib import Path
from typing import Any

import pytest


def _write_obs01(path: Path, *, n_trades: int = 240) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    base_ts = 1_777_301_400_000_000_000
    with path.open("w", encoding="utf-8") as handle:
        for i in range(n_trades):
            rec: dict[str, Any] = {
                "event_id": f"trade-{i:06d}",
                "run_id": "test-run",
                "schema_version": 1,
                "session_id": "mnq-2026-05-14-rth",
                "ts_ns": str(base_ts + i * 60_000_000_000),
                "type": "TRADE",
                "payload": {
                    "aggressor_side": "buy" if i % 2 == 0 else "sell",
                    "exchange_event_ts_ns": str(base_ts + i * 60_000_000_000),
                    "sidecar_recv_ts_ns": str(base_ts + i * 60_000_000_000 + 1000),
                    "price": 27380.0 + (i % 20) * 0.25,
                    "quantity": 1,
                    "trade_id": f"t{i}",
                },
            }
            handle.write(json.dumps(rec) + "\n")


@pytest.mark.slow
def test_daily_zones_light_mode_rss_stays_below_2gb_with_large_raw_fixture(
    tmp_path: Path,
) -> None:
    """Opt-in empirical smoke.

    Enabled only when ``RUN_RA052_RSS_SMOKE=1``. The raw capture is a sparse
    5GB file with a small normalized sibling; light mode must use the OBS-01
    sibling and avoid materializing the raw file or heavy MBO analytics.
    """
    if os.environ.get("RUN_RA052_RSS_SMOKE") != "1":
        pytest.skip("set RUN_RA052_RSS_SMOKE=1 to run the RA-052 RSS smoke")
    psutil = pytest.importorskip("psutil")

    captures = tmp_path / "captures"
    capture_dir = captures / "2026-05-14"
    raw = capture_dir / "MNQ_rth.jsonl"
    raw.parent.mkdir(parents=True, exist_ok=True)
    with raw.open("wb") as handle:
        handle.truncate(5 * 1024 * 1024 * 1024)
    _write_obs01(capture_dir / "MNQ_rth.obs01.jsonl")

    cmd = [
        sys.executable,
        "-m",
        "rithmic_analytics.cli.daily_zones",
        "--captures-root",
        str(captures),
        "--zones-root",
        str(tmp_path / "zones"),
        "--logs-root",
        str(tmp_path / "logs"),
        "--trading-date",
        "2026-05-14",
        "--sessions",
        "rth",
        "--mode",
        "light",
        "--partial-capture-warn-threshold",
        "1",
    ]
    proc = subprocess.Popen(cmd, cwd=Path(__file__).resolve().parents[1])
    ps_proc = psutil.Process(proc.pid)
    peak_rss = 0
    while proc.poll() is None:
        with suppress(psutil.Error):
            peak_rss = max(peak_rss, int(ps_proc.memory_info().rss))
        time.sleep(0.05)
    assert proc.returncode == 0
    assert peak_rss < 2 * 1024 * 1024 * 1024
