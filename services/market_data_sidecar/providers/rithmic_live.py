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


def normalize_rithmic_l1_trade_row(
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
        return _normalize_quote(row, line_number, exchange_ts_ns, source_payload)

    return _normalize_trade(row, line_number, exchange_ts_ns, source_payload)


def _normalize_quote(
    row: dict[str, Any],
    line_number: int,
    exchange_ts_ns: str,
    source_payload: dict[str, Any],
) -> tuple[NormalizedSourceEvent | None, NormalizationDiagnostic | None]:
    bid_px = _finite_number(row.get("bid_px"))
    ask_px = _finite_number(row.get("ask_px"))
    bid_qty = _finite_number(row.get("bid_sz", row.get("bid_qty")))
    ask_qty = _finite_number(row.get("ask_sz", row.get("ask_qty")))
    if bid_px is None or ask_px is None or bid_qty is None or ask_qty is None:
        return None, NormalizationDiagnostic(line_number, "L1_QUOTE", "missing_quote_bbo_fields")

    payload = {
        **source_payload,
        "bid_px": bid_px,
        "bid_qty": bid_qty,
        "ask_px": ask_px,
        "ask_qty": ask_qty,
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
