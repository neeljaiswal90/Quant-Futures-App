"""Rithmic L1/trade normalization for DATA-01A.

This file contains no websocket or live Rithmic connection code. It normalizes already
captured/provider-supplied Rithmic rows into OBS-01 source-event payloads.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from services.market_data_sidecar.config import ALLOWED_SOURCE_STREAMS, BLOCKED_SOURCE_STREAMS

NormalizedType = Literal["QUOTE", "TRADE"]


@dataclass(frozen=True)
class NormalizedSourceEvent:
    event_type: NormalizedType
    event_id_prefix: str
    ts_ns: str
    payload: dict[str, Any]


@dataclass(frozen=True)
class NormalizationDiagnostic:
    line_number: int
    stream: str
    reason: str


@dataclass(frozen=True)
class _BboSide:
    px: float | int
    qty: float | int


class RithmicL1TradeNormalizer:
    """Stateful DATA-01A normalizer for Rithmic L1 quote and trade rows.

    Rithmic L1 quote rows are state updates: many rows carry only bid or ask
    fields. The normalizer carries forward the other side and emits a complete
    BBO only after both sides are known.
    """

    def __init__(self) -> None:
        self._bid: _BboSide | None = None
        self._ask: _BboSide | None = None

    def normalize_row(
        self,
        row: dict[str, Any],
        *,
        line_number: int,
    ) -> tuple[NormalizedSourceEvent | None, NormalizationDiagnostic | None]:
        """Normalize one rich Rithmic probe row into a QUOTE or TRADE event payload.

        Rows from MBP10/MBO are deliberately skipped for DATA-01A. Rows without
        exchange_event_ts_ns are also skipped because DATA-01A preserves
        exchange_event_ts_ns as canonical event time.
        """

        stream = str(row.get("stream") or row.get("stream_id") or "")
        if stream in BLOCKED_SOURCE_STREAMS:
            return None, NormalizationDiagnostic(line_number, stream, "blocked_l2_l3_stream")
        if stream not in ALLOWED_SOURCE_STREAMS:
            return None, NormalizationDiagnostic(line_number, stream or "missing", "unsupported_stream")

        exchange_ts_ns = _decimal_ns(row.get("exchange_event_ts_ns"))
        if exchange_ts_ns is None:
            return None, NormalizationDiagnostic(line_number, stream, "missing_exchange_event_ts_ns")

        sidecar_recv_ts_ns = _decimal_ns(row.get("sidecar_recv_ts_ns"))
        if sidecar_recv_ts_ns is None:
            return None, NormalizationDiagnostic(line_number, stream, "missing_sidecar_recv_ts_ns")

        source_payload = {
            "exchange_event_ts_ns": exchange_ts_ns,
            "sidecar_recv_ts_ns": sidecar_recv_ts_ns,
        }
        rithmic_publish_ts_ns = _decimal_ns(row.get("rithmic_publish_ts_ns"))
        if rithmic_publish_ts_ns is not None:
            source_payload["rithmic_publish_ts_ns"] = rithmic_publish_ts_ns

        if stream == "L1_QUOTE":
            return self._normalize_quote(row, line_number, exchange_ts_ns, source_payload)

        return _normalize_trade(row, line_number, exchange_ts_ns, source_payload)

    def _normalize_quote(
        self,
        row: dict[str, Any],
        line_number: int,
        exchange_ts_ns: str,
        source_payload: dict[str, Any],
    ) -> tuple[NormalizedSourceEvent | None, NormalizationDiagnostic | None]:
        bid_update = _extract_quote_side(row, "bid")
        ask_update = _extract_quote_side(row, "ask")
        if bid_update is None and ask_update is None:
            return None, NormalizationDiagnostic(line_number, "L1_QUOTE", "missing_quote_bbo_fields")

        if bid_update is not None:
            self._bid = bid_update if bid_update.qty > 0 else None
        if ask_update is not None:
            self._ask = ask_update if ask_update.qty > 0 else None

        if self._bid is None or self._ask is None:
            return None, NormalizationDiagnostic(line_number, "L1_QUOTE", "warming_quote_bbo_state")

        payload = {
            **source_payload,
            "bid_px": self._bid.px,
            "bid_qty": self._bid.qty,
            "ask_px": self._ask.px,
            "ask_qty": self._ask.qty,
            "authority": "authoritative",
        }

        return (
            NormalizedSourceEvent(
                event_type="QUOTE",
                event_id_prefix="quote",
                ts_ns=exchange_ts_ns,
                payload=payload,
            ),
            None,
        )


def normalize_rithmic_l1_trade_row(
    row: dict[str, Any],
    *,
    line_number: int,
) -> tuple[NormalizedSourceEvent | None, NormalizationDiagnostic | None]:
    """Stateless compatibility wrapper for single-row normalization tests."""

    return RithmicL1TradeNormalizer().normalize_row(row, line_number=line_number)


def _normalize_trade(
    row: dict[str, Any],
    line_number: int,
    exchange_ts_ns: str,
    source_payload: dict[str, Any],
) -> tuple[NormalizedSourceEvent | None, NormalizationDiagnostic | None]:
    price = _finite_number(row.get("price"))
    quantity = _finite_number(row.get("size", row.get("quantity")))
    if price is None or quantity is None:
        return None, NormalizationDiagnostic(line_number, "LAST_TRADE", "missing_trade_price_size")

    payload = {
        **source_payload,
        "price": price,
        "quantity": quantity,
        "aggressor_side": _normalize_aggressor_side(row.get("aggressor", row.get("side"))),
    }

    trade_id = row.get("trade_id") or row.get("exchange_order_id") or row.get("order_id")
    if isinstance(trade_id, (str, int)) and str(trade_id).strip() != "":
        payload["trade_id"] = str(trade_id)

    return (
        NormalizedSourceEvent(
            event_type="TRADE",
            event_id_prefix="trade",
            ts_ns=exchange_ts_ns,
            payload=payload,
        ),
        None,
    )


def _extract_quote_side(row: dict[str, Any], side: Literal["bid", "ask"]) -> _BboSide | None:
    px = _finite_number(row.get(f"{side}_px"))
    qty = _finite_number(row.get(f"{side}_sz", row.get(f"{side}_qty")))
    if px is None or qty is None:
        return None
    return _BboSide(px=px, qty=qty)


def _normalize_aggressor_side(value: Any) -> str:
    if isinstance(value, str) and value.lower() in {"buy", "sell"}:
        return value.lower()
    return "unknown"


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
