"""Threshold calibration for delta-dislocation CVD gates."""

from __future__ import annotations

import json
import math
import statistics
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DEFAULT_SYMBOL = "MNQ"
DEFAULT_LOOKBACK_SESSIONS = 20
DEFAULT_THRESHOLD_MULTIPLIER = 1.5
DEFAULT_THRESHOLD_PATH = Path("data/live_analysis/dislocation_thresholds.json")
HOUR_NS = 3_600_000_000_000


class InsufficientCalibrationData(RuntimeError):
    """Raised when fewer than the requested lookback sessions are available."""


@dataclass(frozen=True)
class ThresholdCalibration:
    """Calibrated delta-dislocation threshold payload."""

    symbol: str
    lookback_sessions: int
    threshold_multiplier: float
    sessions_used: int
    hourly_bucket_count: int
    median_hourly_abs_cvd: float
    threshold: float
    source_files: tuple[str, ...]


def calibrate_dislocation_threshold(
    captures_root: Path,
    *,
    symbol: str = DEFAULT_SYMBOL,
    lookback_sessions: int = DEFAULT_LOOKBACK_SESSIONS,
    threshold_multiplier: float = DEFAULT_THRESHOLD_MULTIPLIER,
) -> ThresholdCalibration:
    """Compute ``threshold_multiplier * median(hourly |CVD|)`` over OBS sessions."""

    files = _candidate_obs_files(captures_root, symbol=symbol)
    if len(files) < lookback_sessions:
        raise InsufficientCalibrationData(
            f"only {len(files)} {symbol} OBS sessions available; need {lookback_sessions}"
        )
    selected = files[:lookback_sessions]
    hourly_abs_values: list[float] = []
    sessions_with_data = 0
    for path in selected:
        buckets = _hourly_cvd(path)
        if not buckets:
            continue
        sessions_with_data += 1
        hourly_abs_values.extend(abs(value) for value in buckets.values())

    if sessions_with_data < lookback_sessions:
        raise InsufficientCalibrationData(
            f"only {sessions_with_data} {symbol} OBS sessions contain CVD data; "
            f"need {lookback_sessions}"
        )
    if not hourly_abs_values:
        raise InsufficientCalibrationData("no hourly CVD buckets available")

    median_abs = float(statistics.median(hourly_abs_values))
    threshold = median_abs * threshold_multiplier
    return ThresholdCalibration(
        symbol=symbol,
        lookback_sessions=lookback_sessions,
        threshold_multiplier=threshold_multiplier,
        sessions_used=sessions_with_data,
        hourly_bucket_count=len(hourly_abs_values),
        median_hourly_abs_cvd=median_abs,
        threshold=threshold,
        source_files=tuple(str(path) for path in selected),
    )


def write_thresholds_atomic(path: Path, calibration: ThresholdCalibration) -> None:
    """Write threshold JSON via temp+rename so schedulers can re-run safely."""

    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "thresholds": {
            calibration.symbol: {
                "lookback_sessions": calibration.lookback_sessions,
                "threshold_multiplier": calibration.threshold_multiplier,
                "sessions_used": calibration.sessions_used,
                "hourly_bucket_count": calibration.hourly_bucket_count,
                "median_hourly_abs_cvd": calibration.median_hourly_abs_cvd,
                "threshold": calibration.threshold,
                "source_files": list(calibration.source_files),
            }
        },
    }
    temp = path.with_name(f"{path.name}.tmp")
    temp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temp.replace(path)


def load_threshold(path: Path, *, symbol: str = DEFAULT_SYMBOL) -> float | None:
    """Load a previously calibrated threshold for ``symbol``."""

    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    thresholds = payload.get("thresholds")
    if not isinstance(thresholds, dict):
        return None
    symbol_payload = thresholds.get(symbol)
    if not isinstance(symbol_payload, dict):
        return None
    return _float(symbol_payload.get("threshold"))


def _candidate_obs_files(captures_root: Path, *, symbol: str) -> list[Path]:
    if not captures_root.exists():
        return []
    files = [
        path
        for path in captures_root.glob(f"*/{symbol}_*.obs01.jsonl")
        if path.is_file() and path.stat().st_size > 0
    ]
    return sorted(files, key=lambda path: (path.parent.name, path.name), reverse=True)


def _hourly_cvd(path: Path) -> dict[int, int]:
    buckets: dict[int, int] = {}
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        try:
            rec = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(rec, dict):
            continue
        ts = _int(_first_present(rec, "exchange_event_ts_ns", "ts_event_ns", "ts_ns"))
        if ts is None:
            continue
        signed_qty = _signed_quantity(rec)
        if signed_qty == 0:
            continue
        bucket = ts // HOUR_NS
        buckets[bucket] = buckets.get(bucket, 0) + signed_qty
    return buckets


def _signed_quantity(rec: dict[str, Any]) -> int:
    for key in ("signed_qty", "signed_quantity", "delta"):
        value = _int(rec.get(key))
        if value is not None:
            return value
    qty = _int(_first_present(rec, "size", "quantity", "qty"))
    if qty is None:
        return 0
    side = str(
        _first_present(rec, "aggressor", "aggressor_side", "side") or ""
    ).lower()
    if side in {"b", "buy", "bid", "buyer", "aggressor_buy"}:
        return qty
    if side in {"s", "sell", "ask", "seller", "aggressor_sell"}:
        return -qty
    return 0


def _first_present(rec: dict[str, Any], *keys: str) -> Any:
    payload = rec.get("payload")
    payload_dict = payload if isinstance(payload, dict) else {}
    for key in keys:
        if rec.get(key) is not None:
            return rec.get(key)
        if payload_dict.get(key) is not None:
            return payload_dict.get(key)
    return None


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None
