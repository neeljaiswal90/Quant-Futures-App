"""DATA-01B-PS MBP10 price-state reconstruction.

This module is offline-safe and consumes already-captured rich Rithmic rows. It accepts
only the ADR-0002 MBP10 price-state sub-scope: price levels are authoritative for V1,
while size/order-count fields remain diagnostic and MBO remains blocked.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from services.market_data_sidecar.config import (
    DATA01B_FULL_STATUS,
    DATA01B_MBO_BLOCK_REASON,
    DATA01B_MBO_STATUS,
    DATA01B_MBP10_PRICE_STATE_STATUS,
    DATA01B_SIZE_ORDER_COUNT_STATUS,
)
from services.market_data_sidecar.providers.rithmic_live import NormalizationDiagnostic

BookSide = Literal["bid", "ask"]


@dataclass(frozen=True)
class PriceLevelState:
    px: float | int
    size_diagnostic: float | int | None = None
    order_count_diagnostic: int | None = None


@dataclass(frozen=True)
class Mbp10PriceStateEvent:
    event_type: Literal["MICROSTRUCTURE"]
    event_id_prefix: str
    ts_ns: str
    payload: dict[str, Any]


class Mbp10PriceStateReconstructor:
    """Reconstructs Rithmic MBP10 as price-keyed bid/ask state.

    Rithmic rich MBP10 rows are state updates, not stable array-index snapshots. The state
    key is the price. Bids are exposed high-to-low; asks are exposed low-to-high.
    """

    def __init__(self, *, depth: int = 10) -> None:
        self._depth = depth
        self._bids: dict[float | int, PriceLevelState] = {}
        self._asks: dict[float | int, PriceLevelState] = {}

    def normalize_row(
        self,
        row: dict[str, Any],
        *,
        line_number: int,
    ) -> tuple[Mbp10PriceStateEvent | None, NormalizationDiagnostic | None]:
        stream = str(row.get("stream") or row.get("stream_id") or "")
        if stream == "MBO":
            return None, NormalizationDiagnostic(line_number, stream, DATA01B_MBO_BLOCK_REASON)
        if stream != "MBP10":
            return None, NormalizationDiagnostic(line_number, stream or "missing", "non_mbp10_stream")

        exchange_ts_ns = _decimal_ns(row.get("exchange_event_ts_ns"))
        sidecar_recv_ts_ns = _decimal_ns(row.get("sidecar_recv_ts_ns"))
        if sidecar_recv_ts_ns is None:
            return None, NormalizationDiagnostic(line_number, stream, "missing_sidecar_recv_ts_ns")

        applied = self._apply_updates(row)
        if applied == 0:
            return None, NormalizationDiagnostic(line_number, stream, "missing_mbp10_price_state_fields")

        if exchange_ts_ns is None:
            return None, NormalizationDiagnostic(line_number, stream, "seeded_null_exchange_ts_ns")

        bid_levels = self._sorted_levels("bid")
        ask_levels = self._sorted_levels("ask")
        if not bid_levels and not ask_levels:
            return None, NormalizationDiagnostic(line_number, stream, "empty_mbp10_price_state")

        payload = {
            "exchange_event_ts_ns": exchange_ts_ns,
            "sidecar_recv_ts_ns": sidecar_recv_ts_ns,
            "feature_snapshot_id": f"mbp10-price-state-{exchange_ts_ns}",
            "l3_authority": "unavailable",
            "values": self._scalar_values(bid_levels, ask_levels),
            "bids": [_level_payload(level) for level in bid_levels],
            "asks": [_level_payload(level) for level in ask_levels],
            "depth": self._depth,
            "mbp10_price_state_status": DATA01B_MBP10_PRICE_STATE_STATUS,
            "mbo_status": DATA01B_MBO_STATUS,
            "size_order_count_status": DATA01B_SIZE_ORDER_COUNT_STATUS,
            "data01b_full_status": DATA01B_FULL_STATUS,
        }
        rithmic_publish_ts_ns = _decimal_ns(row.get("rithmic_publish_ts_ns"))
        if rithmic_publish_ts_ns is not None:
            payload["rithmic_publish_ts_ns"] = rithmic_publish_ts_ns

        return (
            Mbp10PriceStateEvent(
                event_type="MICROSTRUCTURE",
                event_id_prefix="mbp10-price-state",
                ts_ns=exchange_ts_ns,
                payload=payload,
            ),
            None,
        )

    def _apply_updates(self, row: dict[str, Any]) -> int:
        applied = 0
        for side, key in (("bid", "bids"), ("ask", "asks")):
            values = row.get(key)
            if not isinstance(values, list):
                continue
            for value in values:
                if isinstance(value, dict) and self._apply_level(side, value):
                    applied += 1
        return applied

    def _apply_level(self, side: BookSide, value: dict[str, Any]) -> bool:
        px = _finite_number(value.get("px", value.get("price")))
        if px is None:
            return False
        size = _finite_number(value.get("sz", value.get("size", value.get("qty"))))
        order_count = _finite_int(value.get("order_count", value.get("ct", value.get("orders"))))
        target = self._bids if side == "bid" else self._asks
        if size == 0:
            target.pop(px, None)
            return True
        target[px] = PriceLevelState(px=px, size_diagnostic=size, order_count_diagnostic=order_count)
        return True

    def _sorted_levels(self, side: BookSide) -> list[PriceLevelState]:
        values = self._bids.values() if side == "bid" else self._asks.values()
        return sorted(values, key=lambda level: level.px, reverse=side == "bid")[: self._depth]

    def _scalar_values(
        self,
        bids: list[PriceLevelState],
        asks: list[PriceLevelState],
    ) -> dict[str, float | int | str | bool | None]:
        values: dict[str, float | int | str | bool | None] = {
            "mbp10_price_state_status": DATA01B_MBP10_PRICE_STATE_STATUS,
            "mbo_status": DATA01B_MBO_STATUS,
            "size_order_count_status": DATA01B_SIZE_ORDER_COUNT_STATUS,
            "data01b_full_status": DATA01B_FULL_STATUS,
        }
        for side, levels in (("bid", bids), ("ask", asks)):
            for index, level in enumerate(levels):
                suffix = f"{index:02d}"
                values[f"{side}_px_{suffix}"] = level.px
                values[f"{side}_size_diagnostic_{suffix}"] = level.size_diagnostic
                values[f"{side}_order_count_diagnostic_{suffix}"] = level.order_count_diagnostic
        return values


def _level_payload(level: PriceLevelState) -> dict[str, float | int | None]:
    return {
        "px": level.px,
        "size_diagnostic": level.size_diagnostic,
        "order_count_diagnostic": level.order_count_diagnostic,
    }


def _decimal_ns(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, int) and value >= 0:
        return str(value)
    if isinstance(value, str) and value.isdecimal():
        return value
    return None


def _finite_number(value: Any) -> float | int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value == value and value not in (float("inf"), float("-inf")):
        return value
    return None


def _finite_int(value: Any) -> int | None:
    parsed = _finite_number(value)
    if parsed is None or not isinstance(parsed, int):
        return None
    return parsed
