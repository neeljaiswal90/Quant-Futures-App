from __future__ import annotations

import json
from pathlib import Path

import pytest

from rithmic_dashboard.features.threshold_calibration import (
    InsufficientCalibrationData,
    calibrate_dislocation_threshold,
    load_threshold,
    write_thresholds_atomic,
)


def _write_obs(path: Path, *, ts_ns: int, signed_qty: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"exchange_event_ts_ns": ts_ns, "price": 100.0, "signed_qty": signed_qty})
        + "\n",
        encoding="utf-8",
    )


def test_calibrates_threshold_from_last_n_sessions(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    base_ts = 1_800_000_000_000_000_000
    for idx in range(20):
        _write_obs(
            captures / f"2026-05-{idx + 1:02d}" / "MNQ_rth.obs01.jsonl",
            ts_ns=base_ts + idx * 3_600_000_000_000,
            signed_qty=100 + idx,
        )

    calibration = calibrate_dislocation_threshold(
        captures,
        symbol="MNQ",
        lookback_sessions=20,
        threshold_multiplier=1.5,
    )

    assert calibration.sessions_used == 20
    assert calibration.median_hourly_abs_cvd == pytest.approx(109.5)
    assert calibration.threshold == pytest.approx(164.25)


def test_calibration_fails_when_requested_sessions_are_missing(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    _write_obs(
        captures / "2026-05-01" / "MNQ_rth.obs01.jsonl",
        ts_ns=1_800_000_000_000_000_000,
        signed_qty=100,
    )

    with pytest.raises(InsufficientCalibrationData):
        calibrate_dislocation_threshold(captures, symbol="MNQ", lookback_sessions=2)


def test_threshold_write_is_atomic_and_loadable(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    for idx in range(2):
        _write_obs(
            captures / f"2026-05-{idx + 1:02d}" / "MNQ_globex.obs01.jsonl",
            ts_ns=1_800_000_000_000_000_000 + idx * 3_600_000_000_000,
            signed_qty=200 + idx,
        )
    calibration = calibrate_dislocation_threshold(captures, symbol="MNQ", lookback_sessions=2)
    output = tmp_path / "data" / "live_analysis" / "dislocation_thresholds.json"

    write_thresholds_atomic(output, calibration)

    assert output.exists()
    assert not output.with_name(f"{output.name}.tmp").exists()
    assert load_threshold(output, symbol="MNQ") == pytest.approx(calibration.threshold)
