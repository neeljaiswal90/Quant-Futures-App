from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import pytest

from rithmic_dashboard.features.live_signals import compute_live_signals, load_trade_ticks_from_tail
from rithmic_dashboard.models import DataWarning
from rithmic_dashboard.session_state import PT, determine_session_state

from .conftest import sample_envelope


def _write_raw(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")


def _trade(ts: int, price: float, qty: int, side: str = "buy") -> dict[str, object]:
    return {
        "stream": "LAST_TRADE",
        "exchange_event_ts_ns": ts,
        "price": price,
        "size": qty,
        "aggressor": side,
    }


def _mbo(ts: int, action: str, order_id: str, size: int = 30) -> dict[str, object]:
    return {
        "event_ts_ns": ts,
        "sequence": 1,
        "action": action,
        "side": "A",
        "price": 29425.0,
        "size": size,
        "order_id": order_id,
    }


def test_tail_parser_extracts_raw_last_trade_rows(tmp_path: Path) -> None:
    path = tmp_path / "MNQ_globex.jsonl"
    _write_raw(path, [_trade(1_000_000_000, 29500.0, 2, "buy")])
    warnings: list[DataWarning] = []
    ticks = load_trade_ticks_from_tail(path, warnings=warnings)
    assert len(ticks) == 1
    assert ticks[0].price == 29500.0
    assert ticks[0].quantity == 2
    assert ticks[0].aggressor_side == "buy"
    assert warnings == []


def test_live_signals_compute_vwap_cvd_and_velocity(tmp_path: Path) -> None:
    capture = tmp_path / "analytics" / "data" / "captures" / "2026-05-22" / "MNQ_globex.jsonl"
    base = int(datetime(2026, 5, 21, 19, 59, tzinfo=PT).timestamp() * 1_000_000_000)
    rows = [
        _trade(base + i * 60_000_000_000, 29500.0 + i, 2, "buy" if i % 2 == 0 else "sell")
        for i in range(20)
    ]
    rows.extend(_trade(base + (21 + i) * 60_000_000_000, 29530.0 + i, 5, "buy") for i in range(15))
    _write_raw(capture, rows)
    session = determine_session_state(
        now_pt=datetime(2026, 5, 21, 20, 0, tzinfo=PT),
        analytics_root=tmp_path / "analytics",
    )
    signals = compute_live_signals(
        capture_path=capture,
        envelope=sample_envelope(),
        session=session,
        dashboard_dir=tmp_path / "dashboard",
        tail_bytes=500_000,
    )
    assert signals.trade_count == 35
    assert signals.live_vwap.vwap is not None
    assert signals.cvd.last_15m_cvd is not None
    assert signals.velocity.state in {"active", "normal", "quiet"}
    assert signals.aggressor_windows
    assert signals.v_delta is not None
    assert (tmp_path / "live_analysis" / "2026-05-22_globex_cvd.jsonl").exists()
    assert (tmp_path / "live_analysis" / "2026-05-22_globex_aggressor_flow.jsonl").exists()
    assert (tmp_path / "live_analysis" / "2026-05-22_globex_footprint.jsonl").exists()


def test_live_signals_prefers_normalized_obs_trade_tail(tmp_path: Path) -> None:
    capture = tmp_path / "analytics" / "data" / "captures" / "2026-05-22" / "MNQ_globex.jsonl"
    obs = capture.with_name("MNQ_globex.obs01.jsonl")
    base = 1_779_400_000_000_000_000
    _write_raw(capture, [_trade(base, 100.0, 1, "sell")])
    _write_raw(
        obs,
        [
            _trade(base, 101.0, 3, "buy"),
            _trade(base + 60_000_000_000, 102.0, 4, "buy"),
        ],
    )
    session = determine_session_state(
        now_pt=datetime(2026, 5, 21, 20, 0, tzinfo=PT),
        analytics_root=tmp_path / "analytics",
    )

    signals = compute_live_signals(
        capture_path=capture,
        envelope=sample_envelope(),
        session=session,
        dashboard_dir=tmp_path / "dashboard",
    )

    assert signals.source_path == obs
    assert signals.trade_count == 2
    assert signals.cvd.session_cvd == 7
    assert any("normalized trade tail" in warning.message for warning in signals.warnings)


def test_live_signals_writes_iceberg_events_from_mbo_and_obs_tails(tmp_path: Path) -> None:
    capture = tmp_path / "analytics" / "data" / "captures" / "2026-05-22" / "MNQ_globex.jsonl"
    obs = capture.with_name("MNQ_globex.obs01.jsonl")
    mbo = capture.with_name("MNQ_globex.mbo.jsonl")
    base = int(datetime(2026, 5, 21, 19, 59, tzinfo=PT).timestamp() * 1_000_000_000)
    obs_rows: list[dict[str, object]] = []
    mbo_rows: list[dict[str, object]] = []
    for idx in range(3):
        add_ts = base + idx * 5_000_000_000
        cancel_ts = add_ts + 10_000_000
        mbo_rows.append(_mbo(add_ts, "A", f"ask-{idx}"))
        mbo_rows.append(_mbo(cancel_ts, "C", f"ask-{idx}"))
        obs_rows.append(_trade(cancel_ts + 20_000_000, 29425.0, 30, "buy"))
    _write_raw(capture, [_trade(base, 29425.0, 1, "buy")])
    _write_raw(obs, obs_rows)
    _write_raw(mbo, mbo_rows)
    session = determine_session_state(
        now_pt=datetime(2026, 5, 21, 20, 0, tzinfo=PT),
        analytics_root=tmp_path / "analytics",
    )

    signals = compute_live_signals(
        capture_path=capture,
        envelope=sample_envelope(),
        session=session,
        dashboard_dir=tmp_path / "dashboard",
    )

    assert len(signals.iceberg_events) == 1
    assert signals.iceberg_events[0].direction == "short"
    assert signals.iceberg_summary is not None
    assert signals.iceberg_summary.total_consumed == 90
    assert (tmp_path / "live_analysis" / "2026-05-22_globex_icebergs.jsonl").exists()


def test_live_signals_warns_when_tail_under_covers_sixty_minutes(tmp_path: Path) -> None:
    capture = tmp_path / "analytics" / "data" / "captures" / "2026-05-22" / "MNQ_globex.jsonl"
    base = 1_779_400_000_000_000_000
    _write_raw(
        capture,
        [
            _trade(base, 100.0, 1, "buy"),
            _trade(base + 10 * 60_000_000_000, 101.0, 1, "buy"),
        ],
    )
    session = determine_session_state(
        now_pt=datetime(2026, 5, 21, 20, 0, tzinfo=PT),
        analytics_root=tmp_path / "analytics",
    )

    signals = compute_live_signals(
        capture_path=capture,
        envelope=sample_envelope(),
        session=session,
        dashboard_dir=tmp_path / "dashboard",
    )

    assert any("60m CVD/dislocation signals may be under-covered" in warning.message for warning in signals.warnings)


def test_live_signals_warn_when_capture_missing(tmp_path: Path) -> None:
    session = determine_session_state(
        now_pt=datetime(2026, 5, 21, 20, 0, tzinfo=PT),
        analytics_root=tmp_path / "analytics",
    )
    signals = compute_live_signals(
        capture_path=tmp_path / "missing.jsonl",
        envelope=sample_envelope(),
        session=session,
        dashboard_dir=tmp_path / "dashboard",
    )
    assert signals.trade_count == 0
    assert signals.warnings


def test_live_signal_vwap_is_quantity_weighted(tmp_path: Path) -> None:
    capture = tmp_path / "analytics" / "data" / "captures" / "2026-05-22" / "MNQ_globex.jsonl"
    base = 1_779_400_000_000_000_000
    _write_raw(
        capture,
        [
            _trade(base, 100.0, 1, "buy"),
            _trade(base + 1_000_000_000, 110.0, 3, "buy"),
        ],
    )
    session = determine_session_state(
        now_pt=datetime(2026, 5, 21, 20, 0, tzinfo=PT),
        analytics_root=tmp_path / "analytics",
    )
    signals = compute_live_signals(
        capture_path=capture,
        envelope=sample_envelope(),
        session=session,
        dashboard_dir=tmp_path / "dashboard",
    )
    assert signals.live_vwap.vwap == pytest.approx(107.5)
