from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from replay.dataset import DatasetManifest, SignalDatasetRow
from replay.runner import ReplayConfig, run_replay
from rithmic_dashboard.features.live_signals import DEFAULT_TAIL_BYTES

PT = ZoneInfo("America/Los_Angeles")
FIXTURE_TRADING_DATE = "2026-05-22"
FIXTURE_SESSION = "globex"


def _build_fixture(root: Path) -> Path:
    capture_dir = root / "data" / "captures" / FIXTURE_TRADING_DATE
    capture_dir.mkdir(parents=True, exist_ok=True)
    capture = capture_dir / f"MNQ_{FIXTURE_SESSION}.jsonl"
    base = int(datetime(2026, 5, 21, 19, 5, 3, tzinfo=PT).timestamp() * 1_000_000_000)
    rows = [
        _trade(base + 123_456_789, 29399.25, 6, "sell"),
        _trade(base + 1_123_456_789, 29399.75, 7, "buy"),
        _trade(base + 2_123_456_789, 29400.00, 8, "buy"),
        _trade(base + 3_123_456_789, 29400.75, 80, "buy"),
        _trade(base + 4_123_456_789, 29401.00, 82, "buy"),
    ]
    capture.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")
    zones = root / "data" / "zones"
    zones.mkdir(parents=True, exist_ok=True)
    envelope = {
        "schema_version": 1,
        "symbol": "MNQ",
        "timeframe": FIXTURE_SESSION,
        "atr_14": 40.0,
        "reference_lines": [
            {"price": 29400.0, "text": "VPOC 29400", "source": "vpoc"},
        ],
        "zones": [],
    }
    (zones / f"{FIXTURE_TRADING_DATE}_MNQ_{FIXTURE_SESSION}.json").write_text(
        json.dumps(envelope),
        encoding="utf-8",
    )
    return root


def _trade(ts: int, price: float, size: int, side: str) -> dict[str, object]:
    return {
        "stream": "LAST_TRADE",
        "exchange_event_ts_ns": ts,
        "price": price,
        "size": size,
        "aggressor": side,
    }


def _run_fixture_replay(tmp_path: Path, name: str, *, limit_steps: int | None = None) -> Path:
    analytics_root = _build_fixture(tmp_path / "analytics")
    out = tmp_path / f"{name}.jsonl"
    result = run_replay(
        ReplayConfig(
            analytics_root=analytics_root,
            capture_date=FIXTURE_TRADING_DATE,
            session=FIXTURE_SESSION,
            out_path=out,
            scratch_dir=tmp_path / f"{name}_scratch",
            dashboard_root=tmp_path / "dashboard",
            limit_steps=limit_steps,
        )
    )
    assert result.out_path == out
    assert result.manifest_path.exists()
    return out


def _load_rows(path: Path) -> list[SignalDatasetRow]:
    return [
        SignalDatasetRow.model_validate_json(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line
    ]


def test_replay_is_byte_identical_across_two_runs(tmp_path: Path) -> None:
    first = _run_fixture_replay(tmp_path, "first")
    second = _run_fixture_replay(tmp_path, "second")

    assert first.read_bytes() == second.read_bytes()
    first_manifest = first.with_suffix(first.suffix + ".manifest.json").read_bytes()
    second_manifest = second.with_suffix(second.suffix + ".manifest.json").read_bytes()
    assert first_manifest == second_manifest


def test_replay_emits_valid_rows_with_live_tail_parity_settings(tmp_path: Path) -> None:
    out = _run_fixture_replay(tmp_path, "dataset")
    rows = _load_rows(out)
    assert rows
    families = {row.family for row in rows}
    assert "sweep" in families
    assert all(row.replay.capture_date == FIXTURE_TRADING_DATE for row in rows)
    assert all(row.replay.session == FIXTURE_SESSION for row in rows)
    assert all(row.replay.step_ns >= row.ts_ns for row in rows)

    manifest = DatasetManifest.model_validate_json(
        out.with_suffix(out.suffix + ".manifest.json").read_text(encoding="utf-8")
    )
    assert manifest.row_count == len(rows)
    assert manifest.settings["mode"] == "parity"
    assert manifest.settings["tail_bytes"] == DEFAULT_TAIL_BYTES
    assert manifest.settings["fresh_detector_state_per_session"] is True
    assert set(manifest.seeded_files) >= {
        "dislocation_thresholds.json",
        "trade_size_thresholds.json",
        "iceberg_thresholds.json",
        "ewma_decay.json",
    }


def test_row_timestamp_comes_from_detector_event_not_step_boundary(tmp_path: Path) -> None:
    out = _run_fixture_replay(tmp_path, "timestamps")
    rows = _load_rows(out)
    sweep = next(row for row in rows if row.family == "sweep")

    source_timestamps = {
        int(json.loads(line)["exchange_event_ts_ns"])
        for line in (
            tmp_path
            / "analytics"
            / "data"
            / "captures"
            / FIXTURE_TRADING_DATE
            / f"MNQ_{FIXTURE_SESSION}.jsonl"
        ).read_text(encoding="utf-8").splitlines()
        if line
    }
    assert sweep.ts_ns in source_timestamps
    assert sweep.ts_ns != sweep.replay.step_ns


@pytest.mark.slow
def test_optional_real_capture_spot_check_runs_when_enabled(tmp_path: Path) -> None:
    if os.environ.get("RA090_REAL_SMOKE") != "1":
        pytest.skip("set RA090_REAL_SMOKE=1 to replay a local real capture spot check")
    root = Path(r"D:\Quant-futures-app\tools\rithmic_analytics")
    capture = root / "data" / "captures" / "2026-05-29" / "MNQ_rth.jsonl"
    if not capture.exists():
        pytest.skip("local 2026-05-29 RTH capture is unavailable")
    out = tmp_path / "real-smoke.jsonl"
    result = run_replay(
        ReplayConfig(
            analytics_root=root,
            dashboard_root=Path(r"D:\Quant-futures-app\tools\rithmic_dashboard"),
            capture_date="2026-05-29",
            session="rth",
            out_path=out,
            scratch_dir=tmp_path / "real-smoke-scratch",
            limit_steps=4,
        )
    )
    assert result.manifest_path.exists()
