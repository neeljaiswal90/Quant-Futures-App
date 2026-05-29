from __future__ import annotations

import json
from pathlib import Path

import pytest

from rithmic_dashboard.features.trade_size_calibration import (
    InsufficientTradeSizeCalibrationData,
    calibrate_trade_size_thresholds,
    write_trade_size_thresholds_atomic,
)
from rithmic_dashboard.features.trade_size_classifier import load_trade_size_thresholds


def test_trade_size_calibration_writes_monotonic_thresholds(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    _write_obs(captures / "2026-05-24" / "MNQ_globex.obs01.jsonl", [1, 5, 10, 50, 120])
    _write_obs(captures / "2026-05-25" / "MNQ_rth.obs01.jsonl", [2, 6, 12, 60, 140])

    calibration = calibrate_trade_size_thresholds(captures, lookback_sessions=2)
    output = tmp_path / "trade_size_thresholds.json"
    write_trade_size_thresholds_atomic(output, calibration)
    thresholds = load_trade_size_thresholds(output)

    assert calibration.sessions_used == 2
    assert thresholds.mixed_min >= 2
    assert thresholds.mixed_min < thresholds.institutional_min < thresholds.block_min
    assert thresholds.block_min == calibration.p95


def test_trade_size_calibration_reports_insufficient_corpus(tmp_path: Path) -> None:
    captures = tmp_path / "captures"
    _write_obs(captures / "2026-05-24" / "MNQ_globex.obs01.jsonl", [1, 5, 10])

    with pytest.raises(InsufficientTradeSizeCalibrationData):
        calibrate_trade_size_thresholds(captures, lookback_sessions=2)


def _write_obs(path: Path, quantities: list[int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = [
        {
            "type": "TRADE",
            "payload": {
                "exchange_event_ts_ns": str(1_779_400_000_000_000_000 + idx),
                "quantity": qty,
                "aggressor_side": "buy",
                "price": 30_000.0,
            },
        }
        for idx, qty in enumerate(quantities)
    ]
    path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
