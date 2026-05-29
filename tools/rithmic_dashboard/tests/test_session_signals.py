from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from rithmic_dashboard.session_signals import compute_session_signals_for_window
from rithmic_dashboard.session_state import PT

from .conftest import sample_envelope


def _write_trades(path: Path, start: datetime) -> None:
    rows: list[dict[str, Any]] = []
    for idx in range(6):
        rows.append(
            {
                "type": "TRADE",
                "ts_ns": str(int((start + timedelta(minutes=idx)).astimezone(UTC).timestamp() * 1_000_000_000)),
                "payload": {
                    "price": 29232.75 + idx,
                    "quantity": 100,
                    "aggressor_side": "buy" if idx < 5 else "sell",
                    "exchange_event_ts_ns": str(int((start + timedelta(minutes=idx)).astimezone(UTC).timestamp() * 1_000_000_000)),
                },
            }
        )
    path.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")


def test_session_signal_open_print(tmp_path: Path) -> None:
    start = datetime(2026, 5, 21, 6, 30, tzinfo=PT)
    path = tmp_path / "signals.jsonl"
    try:
        _write_trades(path, start)
        signals = compute_session_signals_for_window(sample_envelope(), path, start)
        assert signals is not None
        assert signals.open_print == 29232.75
    finally:
        path.unlink(missing_ok=True)


def test_session_signal_cvd_direction(tmp_path: Path) -> None:
    start = datetime(2026, 5, 21, 6, 30, tzinfo=PT)
    path = tmp_path / "signals.jsonl"
    try:
        _write_trades(path, start)
        signals = compute_session_signals_for_window(sample_envelope(), path, start)
        assert signals is not None
        assert signals.cvd_direction == "neutral"
        assert signals.net_cvd_30min == 400
    finally:
        path.unlink(missing_ok=True)


def test_session_signal_detects_lower_confluence_test(tmp_path: Path) -> None:
    start = datetime(2026, 5, 21, 6, 30, tzinfo=PT)
    path = tmp_path / "signals.jsonl"
    try:
        _write_trades(path, start)
        signals = compute_session_signals_for_window(sample_envelope(), path, start)
        assert signals is not None
        assert signals.first_test_of_lower_confluence
    finally:
        path.unlink(missing_ok=True)


def test_session_signal_missing_file_returns_none(tmp_path: Path) -> None:
    start = datetime(2026, 5, 21, 6, 30, tzinfo=PT)
    signals = compute_session_signals_for_window(sample_envelope(), tmp_path / "missing.jsonl", start)
    assert signals is None
