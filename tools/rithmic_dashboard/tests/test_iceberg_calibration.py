from __future__ import annotations

import json
from pathlib import Path

from rithmic_dashboard.cli.calibrate_iceberg_thresholds import (
    calibrate_iceberg_thresholds,
    write_calibration_atomic,
)

BASE_NS = 1_780_000_000_000_000_000


def test_calibrate_iceberg_thresholds_writes_threshold_json(tmp_path: Path) -> None:
    session_dir = tmp_path / "captures" / "2026-05-22"
    mbo = session_dir / "MNQ_rth.mbo.jsonl"
    obs = session_dir / "MNQ_rth.obs01.jsonl"
    _write_jsonl(mbo, _mbo_rows())
    _write_jsonl(obs, _trade_rows())

    result = calibrate_iceberg_thresholds(
        tmp_path / "captures",
        symbol="MNQ",
        lookback_sessions=1,
        min_sessions=1,
    )

    assert result is not None
    assert result.sessions_used == 1
    assert "min_refills" in result.thresholds
    output = tmp_path / "iceberg_thresholds.json"
    write_calibration_atomic(output, result)
    data = json.loads(output.read_text(encoding="utf-8"))
    assert data["symbol"] == "MNQ"
    assert data["event_counts"]


def _mbo_rows() -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for idx in range(5):
        add_ts = BASE_NS + idx * 5_000_000_000
        cancel_ts = add_ts + 10_000_000
        rows.append(_mbo(add_ts, "A", f"ask-{idx}", 30))
        rows.append(_mbo(cancel_ts, "C", f"ask-{idx}", 30))
    return rows


def _trade_rows() -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for idx in range(5):
        cancel_ts = BASE_NS + idx * 5_000_000_000 + 10_000_000
        rows.append(
            {
                "stream": "LAST_TRADE",
                "exchange_event_ts_ns": cancel_ts + 20_000_000,
                "price": 30220.0,
                "size": 30,
                "aggressor": "buy",
            }
        )
    return rows


def _mbo(ts: int, action: str, order_id: str, size: int) -> dict[str, object]:
    return {
        "event_ts_ns": ts,
        "action": action,
        "side": "A",
        "price": 30220.0,
        "size": size,
        "order_id": order_id,
    }


def _write_jsonl(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")
