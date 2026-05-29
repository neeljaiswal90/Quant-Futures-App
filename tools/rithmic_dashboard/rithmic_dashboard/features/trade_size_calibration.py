"""Calibration for trade-size classifier thresholds."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from rithmic_dashboard.features.trade_size_classifier import TradeSizeThresholds

DEFAULT_SYMBOL = "MNQ"
DEFAULT_LOOKBACK_SESSIONS = 7


class InsufficientTradeSizeCalibrationData(RuntimeError):
    """Raised when the corpus is too small for trade-size calibration."""


@dataclass(frozen=True)
class TradeSizeCalibration:
    """Calibrated trade-size threshold payload."""

    symbol: str
    lookback_sessions: int
    sessions_used: int
    trade_count: int
    p50: int
    p75: int
    p95: int
    thresholds: TradeSizeThresholds
    source_files: tuple[str, ...]


def calibrate_trade_size_thresholds(
    captures_root: Path,
    *,
    symbol: str = DEFAULT_SYMBOL,
    lookback_sessions: int = DEFAULT_LOOKBACK_SESSIONS,
) -> TradeSizeCalibration:
    """Compute retail/mixed/institutional/block thresholds from recent OBS sessions."""

    files = _candidate_obs_files(captures_root, symbol=symbol)
    if len(files) < lookback_sessions:
        raise InsufficientTradeSizeCalibrationData(
            f"only {len(files)} {symbol} OBS sessions available; need {lookback_sessions}"
        )
    selected = files[:lookback_sessions]
    quantities: list[int] = []
    sessions_with_data = 0
    for path in selected:
        sizes = _trade_sizes(path)
        if not sizes:
            continue
        sessions_with_data += 1
        quantities.extend(sizes)
    if sessions_with_data < lookback_sessions:
        raise InsufficientTradeSizeCalibrationData(
            f"only {sessions_with_data} {symbol} OBS sessions contain trades; "
            f"need {lookback_sessions}"
        )
    if not quantities:
        raise InsufficientTradeSizeCalibrationData("no trade sizes available")

    quantities.sort()
    p50 = int(math.ceil(_percentile(quantities, 0.50)))
    p75 = int(math.ceil(_percentile(quantities, 0.75)))
    p95 = int(math.ceil(_percentile(quantities, 0.95)))
    mixed_min = max(2, p50)
    institutional_min = max(mixed_min + 1, p75)
    block_min = max(institutional_min + 1, p95)
    thresholds = TradeSizeThresholds(
        symbol=symbol,
        mixed_min=mixed_min,
        institutional_min=institutional_min,
        block_min=block_min,
        source="calibrated",
    )
    return TradeSizeCalibration(
        symbol=symbol,
        lookback_sessions=lookback_sessions,
        sessions_used=sessions_with_data,
        trade_count=len(quantities),
        p50=p50,
        p75=p75,
        p95=p95,
        thresholds=thresholds,
        source_files=tuple(str(path) for path in selected),
    )


def write_trade_size_thresholds_atomic(path: Path, calibration: TradeSizeCalibration) -> None:
    """Write calibrated thresholds via temp+rename."""

    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "thresholds": {
            calibration.symbol: {
                "lookback_sessions": calibration.lookback_sessions,
                "sessions_used": calibration.sessions_used,
                "trade_count": calibration.trade_count,
                "p50": calibration.p50,
                "p75": calibration.p75,
                "p95": calibration.p95,
                "mixed_min": calibration.thresholds.mixed_min,
                "institutional_min": calibration.thresholds.institutional_min,
                "block_min": calibration.thresholds.block_min,
                "source_files": list(calibration.source_files),
            }
        },
    }
    temp = path.with_name(f"{path.name}.tmp")
    temp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temp.replace(path)


def _candidate_obs_files(captures_root: Path, *, symbol: str) -> list[Path]:
    if not captures_root.exists():
        return []
    files = [
        path
        for path in captures_root.glob(f"*/{symbol}_*.obs01.jsonl")
        if path.is_file()
        and path.stat().st_size > 0
        and "session_combined" not in path.name
    ]
    return sorted(files, key=lambda path: (path.parent.name, path.name), reverse=True)


def _trade_sizes(path: Path) -> list[int]:
    sizes: list[int] = []
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        try:
            rec = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(rec, dict):
            continue
        payload = rec.get("payload") if isinstance(rec.get("payload"), dict) else rec
        if not isinstance(payload, dict):
            continue
        qty = _int(
            rec.get(
                "size",
                rec.get("quantity", rec.get("qty", payload.get("quantity", payload.get("size")))),
            )
        )
        if qty is not None and qty > 0:
            sizes.append(qty)
    return sizes


def _percentile(values: list[int], q: float) -> float:
    if not values:
        return 0.0
    idx = min(len(values) - 1, max(0, math.ceil(q * len(values)) - 1))
    return float(values[idx])


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
