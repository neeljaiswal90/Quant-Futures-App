from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

from rithmic_dashboard.features.day_type_classifier import (
    append_day_type_outcome,
    classify_ticks,
    compute_day_type_classification,
)
from rithmic_dashboard.models import AdjustmentFactor, DayTypeClassification, TradeTick
from rithmic_dashboard.session_state import PT, determine_session_state


def test_day_type_classifier_identifies_all_core_types() -> None:
    cases = {
        "trend_day_up": [100, 110, 100, 126],
        "trend_day_down": [110, 100, 110, 84],
        "double_distribution_up": [105, 100, 110, 80, 80, 80, 145, 145, 145],
        "double_distribution_down": [105, 100, 110, 140, 140, 140, 75, 75, 75],
        "neutral_day_extreme": [105, 100, 110, 95, 115],
        "neutral_day_center": [105, 100, 110, 95, 115, 105],
        "normal_variation_up": [105, 100, 110, 116],
        "normal_variation_down": [105, 100, 110, 94],
        "normal_day": [105, 100, 110, 112, 103],
    }
    for expected, prices in cases.items():
        session = _session(now_hour=8, now_minute=5)
        result = classify_ticks(
            ticks=_ticks(session.session_start_pt, prices),
            session=session,
            current_price=prices[-1],
        )
        assert result.day_type == expected
        assert result.status == "classified"
        assert result.ib_high == 110
        assert result.ib_low == 100


def test_pending_before_classification_window() -> None:
    session = _session(now_hour=7, now_minute=45)
    result = classify_ticks(
        ticks=_ticks(session.session_start_pt, [105, 100, 110, 116]),
        session=session,
        current_price=116,
    )
    assert result.day_type == "pending"
    assert result.status == "pending"


def test_partial_session_override_skips_and_emits_event(tmp_path: Path) -> None:
    live_dir = tmp_path / "dashboard" / "live_analysis"
    live_dir.mkdir(parents=True)
    (live_dir / "session_overrides.json").write_text(
        json.dumps(
            {
                "2026-05-25_rth": {
                    "partial_session": True,
                    "reason": "Memorial Day early close",
                }
            }
        ),
        encoding="utf-8",
    )
    session = determine_session_state(
        now_pt=datetime(2026, 5, 25, 8, 5, tzinfo=PT),
        analytics_root=tmp_path,
        trading_date_override="2026-05-25",
        session_override="rth",
    )

    result = compute_day_type_classification(
        session=session,
        live_dir=live_dir,
        current_price=29963.0,
    )

    assert result.status == "skipped"
    assert result.skipped_reason == "partial_session"
    text = (live_dir / "2026-05-25_rth_day_type.jsonl").read_text(encoding="utf-8")
    assert "day_type_skipped_partial_session" in text


def test_no_capture_data_skips_without_crashing(tmp_path: Path) -> None:
    live_dir = tmp_path / "dashboard" / "live_analysis"
    session = _session(now_hour=8, now_minute=5, analytics_root=tmp_path)

    result = compute_day_type_classification(
        session=session,
        live_dir=live_dir,
        current_price=30100.0,
    )

    assert result.status == "skipped"
    assert result.skipped_reason == "no_capture_data"
    text = (live_dir / "2026-05-26_rth_day_type.jsonl").read_text(encoding="utf-8")
    assert "day_type_skipped_no_capture_data" in text


def test_day_type_revision_event_when_type_changes(tmp_path: Path) -> None:
    live_dir = tmp_path / "dashboard" / "live_analysis"
    capture = tmp_path / "data" / "captures" / "2026-05-26"
    capture.mkdir(parents=True)
    path = capture / "MNQ_rth.obs01.jsonl"
    session = _session(now_hour=8, now_minute=0, analytics_root=tmp_path)
    _write_obs(path, session.session_start_pt, [105, 100, 110, 112, 103])
    first = compute_day_type_classification(
        session=session,
        live_dir=live_dir,
        current_price=103,
    )
    assert first.day_type == "normal_day"

    later = _session(now_hour=12, now_minute=0, analytics_root=tmp_path)
    _write_obs(path, later.session_start_pt, [105, 100, 110, 112, 103, 126])
    second = compute_day_type_classification(
        session=later,
        live_dir=live_dir,
        current_price=126,
    )

    assert second.day_type == "trend_day_up"
    text = (live_dir / "2026-05-26_rth_day_type.jsonl").read_text(encoding="utf-8")
    assert "day_type_classified" in text
    assert "day_type_revised" in text


def test_double_distribution_high_confidence_requires_large_mode_gap() -> None:
    session = _session(now_hour=8, now_minute=5)
    result = classify_ticks(
        ticks=_ticks(session.session_start_pt, [105, 100, 110, 80, 80, 80, 145, 145, 145]),
        session=session,
        current_price=145,
    )

    assert result.day_type == "double_distribution_up"
    assert result.confidence == "high"
    assert "value-cluster separation" in result.reason


def test_day_type_outcome_log_writes_once_after_session_close(tmp_path: Path) -> None:
    path = tmp_path / "live_analysis" / "day_type_outcomes.jsonl"
    session = _session(now_hour=13, now_minute=10, analytics_root=tmp_path)
    day_type = DayTypeClassification(
        trading_date="2026-05-26",
        session="rth",
        computed_at_pt="2026-05-26 13:10:00 PT",
        status="classified",
        day_type="normal_day",
        confidence="high",
        reason="fixture",
        ib_high=110.0,
        ib_low=100.0,
        ib_range=10.0,
    )
    scenario = SimpleNamespace(
        scenario_id="A",
        state="COMPLETED",
        adjustment_factors=(
            AdjustmentFactor(
                "day_type_normal_day_mean_reversion",
                1.2,
                "normal day",
            ),
        ),
    )

    append_day_type_outcome(path, session=session, day_type=day_type, scenarios=[scenario])
    append_day_type_outcome(path, session=session, day_type=day_type, scenarios=[scenario])

    rows = path.read_text(encoding="utf-8").splitlines()
    assert len(rows) == 1
    row = json.loads(rows[0])
    assert row["record_type"] == "day_type_outcome"
    assert row["scenario_outcomes"][0]["day_type_multipliers"][0]["name"].startswith("day_type_")


def _session(
    *,
    now_hour: int,
    now_minute: int,
    analytics_root: Path | None = None,
):
    return determine_session_state(
        now_pt=datetime(2026, 5, 26, now_hour, now_minute, tzinfo=PT),
        analytics_root=analytics_root or Path("unused"),
        trading_date_override="2026-05-26",
        session_override="rth",
    )


def _ticks(start: datetime, prices: list[float]) -> list[TradeTick]:
    ticks: list[TradeTick] = []
    for idx, price in enumerate(prices):
        if idx == 0:
            ts = start
        elif idx == 1:
            ts = start + timedelta(minutes=30)
        elif idx == 2:
            ts = start + timedelta(minutes=59)
        else:
            ts = start + timedelta(minutes=70 + (idx - 3) * 3)
        ticks.append(
            TradeTick(
                timestamp_ns=int(ts.timestamp() * 1_000_000_000),
                price=float(price),
                quantity=100,
                aggressor_side="buy",
            )
        )
    return ticks


def _write_obs(path: Path, start: datetime, prices: list[float]) -> None:
    rows = []
    for tick in _ticks(start, prices):
        rows.append(
            {
                "type": "TRADE",
                "ts_ns": tick.timestamp_ns,
                "price": tick.price,
                "quantity": tick.quantity,
                "aggressor_side": tick.aggressor_side,
            }
        )
    path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
