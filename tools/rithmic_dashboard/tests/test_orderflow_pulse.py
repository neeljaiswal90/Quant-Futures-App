from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

from rithmic_dashboard.features.orderflow_pulse import compute_orderflow_pulse
from rithmic_dashboard.session_state import PT, determine_session_state


def test_orderflow_pulse_populates_dual_cvd_spread_absorption_and_pressure(
    tmp_path: Path,
) -> None:
    analytics = tmp_path / "rithmic_analytics"
    date = "2026-05-21"
    _write_artifacts(analytics, date)
    session = determine_session_state(
        now_pt=datetime(2026, 5, 21, 8, 0, tzinfo=PT),
        analytics_root=analytics,
        trading_date_override=date,
        session_override="rth",
    )

    pulse = compute_orderflow_pulse(
        analytics_root=analytics,
        dashboard_dir=tmp_path / "dashboard",
        session=session,
        zones_path=analytics / "data" / "zones" / f"{date}_MNQ_session_combined.json",
    )

    assert pulse.artifact_session == "rth"
    assert pulse.session_cvd == 12
    assert pulse.last_60m_cvd == 2
    assert pulse.buy_volume_pct == 15 / 18
    assert pulse.spread_mean_ticks == 3.0
    assert pulse.spread_p99_ticks == 4.0
    assert pulse.crossed_quotes == 1
    assert "29,420.00 score 0.62 sell_absorbed" in (pulse.recent_absorption or "")
    assert pulse.top_spoof_bins[0].price == 29420.0
    assert pulse.top_spoof_bins[0].n_events == 90


def test_orderflow_pulse_uses_cache_when_signatures_match(tmp_path: Path) -> None:
    analytics = tmp_path / "rithmic_analytics"
    date = "2026-05-21"
    _write_artifacts(analytics, date)
    session = determine_session_state(
        now_pt=datetime(2026, 5, 21, 8, 0, tzinfo=PT),
        analytics_root=analytics,
        trading_date_override=date,
        session_override="rth",
    )
    dashboard_dir = tmp_path / "dashboard"

    first = compute_orderflow_pulse(
        analytics_root=analytics,
        dashboard_dir=dashboard_dir,
        session=session,
        zones_path=analytics / "data" / "zones" / f"{date}_MNQ_session_combined.json",
    )
    second = compute_orderflow_pulse(
        analytics_root=analytics,
        dashboard_dir=dashboard_dir,
        session=session,
        zones_path=analytics / "data" / "zones" / f"{date}_MNQ_session_combined.json",
    )

    assert second == first
    assert (dashboard_dir / "_orderflow_cache.json").exists()


def test_orderflow_pulse_missing_artifacts_degrades_to_warnings(tmp_path: Path) -> None:
    analytics = tmp_path / "rithmic_analytics"
    session = determine_session_state(
        now_pt=datetime(2026, 5, 21, 8, 0, tzinfo=PT),
        analytics_root=analytics,
        trading_date_override="2026-05-21",
        session_override="rth",
    )

    pulse = compute_orderflow_pulse(
        analytics_root=analytics,
        dashboard_dir=tmp_path / "dashboard",
        session=session,
        zones_path=None,
    )

    assert pulse.session_cvd is None
    assert pulse.spread_mean_ticks is None
    assert pulse.top_spoof_bins == ()
    assert pulse.warnings


def test_orderflow_pulse_filters_outlier_pressure_prices(tmp_path: Path) -> None:
    analytics = tmp_path / "rithmic_analytics"
    date = "2026-05-21"
    _write_artifacts(analytics, date)
    session = determine_session_state(
        now_pt=datetime(2026, 5, 21, 8, 0, tzinfo=PT),
        analytics_root=analytics,
        trading_date_override=date,
        session_override="rth",
    )

    pulse = compute_orderflow_pulse(
        analytics_root=analytics,
        dashboard_dir=tmp_path / "dashboard",
        session=session,
        zones_path=analytics / "data" / "zones" / f"{date}_MNQ_session_combined.json",
    )

    assert all(bin.price > 10_000 for bin in pulse.top_spoof_bins)
    assert {bin.price for bin in pulse.top_spoof_bins} == {29420.0}


def test_orderflow_pulse_marks_pressure_missing_without_reading_full_file(
    tmp_path: Path,
) -> None:
    analytics = tmp_path / "rithmic_analytics"
    date = "2026-05-21"
    _write_artifacts(analytics, date)
    summary = analytics / "data" / "order_pressure" / f"{date}_MNQ_rth_summary.json"
    summary.unlink()
    session = determine_session_state(
        now_pt=datetime(2026, 5, 21, 8, 0, tzinfo=PT),
        analytics_root=analytics,
        trading_date_override=date,
        session_override="rth",
    )

    pulse = compute_orderflow_pulse(
        analytics_root=analytics,
        dashboard_dir=tmp_path / "dashboard",
        session=session,
        zones_path=analytics / "data" / "zones" / f"{date}_MNQ_session_combined.json",
    )

    assert pulse.top_spoof_bins == ()
    assert "summary missing" in pulse.pressure_status


def _write_artifacts(analytics: Path, date: str) -> None:
    capture_dir = analytics / "data" / "captures" / date
    capture_dir.mkdir(parents=True)
    zones_dir = analytics / "data" / "zones"
    zones_dir.mkdir(parents=True)
    absorption_dir = analytics / "data" / "absorption"
    absorption_dir.mkdir(parents=True)
    pressure_dir = analytics / "data" / "order_pressure"
    pressure_dir.mkdir(parents=True)

    start = datetime(2026, 5, 21, 8, 0, tzinfo=PT)
    trades = [
        _trade(start, 10, "buy"),
        _trade(start + timedelta(minutes=90), 3, "sell"),
        _trade(start + timedelta(minutes=100), 5, "buy"),
    ]
    (capture_dir / "MNQ_rth.obs01.jsonl").write_text(
        "\n".join(json.dumps(trade) for trade in trades),
        encoding="utf-8",
    )
    mbp1 = [
        {"bid_px_00": 29419.5, "ask_px_00": 29420.0},
        {"bid_px_00": 29419.0, "ask_px_00": 29420.0},
        {"bid_px_00": 29421.0, "ask_px_00": 29420.0},
    ]
    (capture_dir / "MNQ_rth.mbp1.jsonl").write_text(
        "\n".join(json.dumps(row) for row in mbp1),
        encoding="utf-8",
    )
    (zones_dir / f"{date}_MNQ_session_combined.json").write_text("{}", encoding="utf-8")
    absorption = [
        {
            "end_ts_ns": _ts_ns(start + timedelta(minutes=30)),
            "dominant_price": 29420.0,
            "side": "sell_absorbed",
            "score": 0.62,
        }
    ]
    (absorption_dir / f"{date}_MNQ_rth.json").write_text(
        json.dumps(absorption),
        encoding="utf-8",
    )
    pressure = {
        "29420.00": {
            "n_adds_total": 50,
            "n_cancels_total": 40,
            "n_fills_total": 0,
            "max_spoof_score": 0.94,
        },
        "100.00": {
            "n_adds_total": 100,
            "n_cancels_total": 100,
            "n_fills_total": 0,
            "max_spoof_score": 1.0,
        },
    }
    (pressure_dir / f"{date}_MNQ_rth_summary.json").write_text(
        json.dumps(pressure),
        encoding="utf-8",
    )


def _trade(ts: datetime, qty: int, side: str) -> dict[str, object]:
    return {
        "type": "TRADE",
        "payload": {
            "exchange_event_ts_ns": str(_ts_ns(ts)),
            "quantity": qty,
            "aggressor_side": side,
            "price": 29420.0,
        },
    }


def _ts_ns(ts: datetime) -> int:
    return int(ts.timestamp() * 1_000_000_000)
