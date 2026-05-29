"""Trade-size classification helpers for institutional-flow detection."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

TradeSizeClass = Literal["retail", "mixed", "institutional", "block"]


@dataclass(frozen=True)
class TradeSizeThresholds:
    """Quantity thresholds used to classify normalized trades."""

    symbol: str = "MNQ"
    mixed_min: int = 10
    institutional_min: int = 50
    block_min: int = 100
    source: str = "default"


def classify_trade_size(
    quantity: int,
    thresholds: TradeSizeThresholds | None = None,
) -> TradeSizeClass:
    """Classify one trade by quantity using monotonic size thresholds."""

    thresholds = thresholds or TradeSizeThresholds()
    if quantity >= thresholds.block_min:
        return "block"
    if quantity >= thresholds.institutional_min:
        return "institutional"
    if quantity >= thresholds.mixed_min:
        return "mixed"
    return "retail"


def load_trade_size_thresholds(path: Path, *, symbol: str = "MNQ") -> TradeSizeThresholds:
    """Load calibrated thresholds, falling back to approved defaults."""

    if not path.exists():
        return TradeSizeThresholds(symbol=symbol)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return TradeSizeThresholds(symbol=symbol)
    if not isinstance(data, dict):
        return TradeSizeThresholds(symbol=symbol)

    raw_thresholds = data.get("thresholds")
    if isinstance(raw_thresholds, dict):
        raw_symbol = raw_thresholds.get(symbol)
        if isinstance(raw_symbol, dict):
            return _thresholds_from_mapping(raw_symbol, symbol=symbol, source=str(path))
        return _thresholds_from_mapping(raw_thresholds, symbol=symbol, source=str(path))
    return _thresholds_from_mapping(data, symbol=symbol, source=str(path))


def _thresholds_from_mapping(
    data: dict[str, Any],
    *,
    symbol: str,
    source: str,
) -> TradeSizeThresholds:
    mixed_min = _int(data.get("mixed_min"), default=10)
    institutional_min = _int(data.get("institutional_min"), default=50)
    block_min = _int(data.get("block_min"), default=100)
    return TradeSizeThresholds(
        symbol=str(data.get("symbol") or symbol),
        mixed_min=max(1, mixed_min),
        institutional_min=max(max(1, mixed_min) + 1, institutional_min),
        block_min=max(max(1, mixed_min) + 2, institutional_min + 1, block_min),
        source=source,
    )


def _int(value: Any, *, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
