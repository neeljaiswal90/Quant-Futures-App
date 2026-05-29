from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from rithmic_dashboard.features.ewma_volatility import (
    classify_volatility_regime,
    compute_ewma_volatility_regime,
    parkinson_observation_sigma_pts,
)
from rithmic_dashboard.models import TradeTick
from rithmic_dashboard.session_state import PT, determine_session_state


def test_parkinson_observation_feeds_one_sigma_value_from_last_15_minutes() -> None:
    base = 1_780_000_000_000_000_000
    ticks = [
        TradeTick(base + i * 60_000_000_000, price, 1, "buy")
        for i, price in enumerate([100.0, 101.0, 99.5, 102.0, 100.5, 103.0, 101.0])
    ]

    observation = parkinson_observation_sigma_pts(ticks, window_minutes=15, bar_minutes=5)

    assert observation is not None
    assert observation > 0.0


@pytest.mark.parametrize(
    ("sigma", "median", "expected"),
    [
        (6.9, 10.0, "LOW"),
        (10.0, 10.0, "NORMAL"),
        (13.1, 10.0, "HIGH"),
    ],
)
def test_classify_volatility_regime_thresholds(sigma: float, median: float, expected: str) -> None:
    assert classify_volatility_regime(sigma, median) == expected


def test_compute_ewma_volatility_persists_state_and_emits_regime_change(tmp_path: Path) -> None:
    calibration = tmp_path / "ewma_decay.json"
    calibration.write_text(
        json.dumps({"lambda_value": 0.9, "corpus_median_sigma_pts": 10.0}),
        encoding="utf-8",
    )
    live_dir = tmp_path / "live_analysis"
    live_dir.mkdir()
    (live_dir / "ewma_volatility_state.json").write_text(
        json.dumps({"variance_pts2": 100.0, "regime": "NORMAL"}),
        encoding="utf-8",
    )
    (live_dir / "2026-05-28_rth_vol_regime_state.json").write_text(
        json.dumps({"regime": "NORMAL"}),
        encoding="utf-8",
    )
    session = determine_session_state(
        now_pt=datetime(2026, 5, 28, 8, 10, tzinfo=PT),
        analytics_root=tmp_path,
        trading_date_override="2026-05-28",
        session_override="rth",
    )
    base = int(datetime(2026, 5, 28, 8, 0, tzinfo=PT).timestamp() * 1_000_000_000)
    ticks = [
        TradeTick(base + int(timedelta(minutes=i).total_seconds() * 1_000_000_000), price, 1, "buy")
        for i, price in enumerate([100.0, 140.0, 90.0, 150.0, 95.0, 160.0, 100.0])
    ]

    regime = compute_ewma_volatility_regime(
        session=session,
        ticks=ticks,
        live_dir=live_dir,
        calibration_path=calibration,
    )

    assert regime.status == "active"
    assert regime.regime == "HIGH"
    assert regime.events and regime.events[0].event_type == "vol_regime_changed"
    assert (live_dir / "2026-05-28_rth_vol_regime.jsonl").exists()

