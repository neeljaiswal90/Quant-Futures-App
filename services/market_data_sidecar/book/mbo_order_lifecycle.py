"""DATA-01B-MBO provider-internal MBO order lifecycle normalization.

This module consumes already-captured rich Rithmic MBO rows. INFRA-01F accepts MBO as
a provider-internal sub-scope; this layer therefore normalizes order lifecycle facts but
does not derive MBO features, queue authority, or full DATA-01B eligibility.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from services.market_data_sidecar.config import (
    DATA01B_FULL_STATUS,
    DATA01B_MBO_FEATURE_STATUS,
    DATA01B_MBO_LIFECYCLE_STATUS,
    DATA01B_MBO_PROVIDER_SCOPE,
    DATA01B_MBO_STATUS,
    DATA01B_MBP10_PRICE_STATE_STATUS,
)
from services.market_data_sidecar.providers.rithmic_live import NormalizationDiagnostic

MboAction = Literal["add", "modify", "cancel"]
MboSide = Literal["bid", "ask"]


@dataclass(frozen=True)
class MboOrderLifecycleEvent:
    event_type: Literal["MICROSTRUCTURE"]
    event_id_prefix: str
    ts_ns: str
    payload: dict[str, Any]


class RithmicMboOrderLifecycleNormalizer:
    """Normalizes Rithmic MBO rich rows into source-like lifecycle events."""

    def normalize_row(
        self,
        row: dict[str, Any],
        *,
        line_number: int,
    ) -> tuple[list[MboOrderLifecycleEvent], list[NormalizationDiagnostic]]:
        stream = str(row.get("stream") or row.get("stream_id") or "")
        if stream == "MBP10":
            return [], [NormalizationDiagnostic(line_number, stream, "mbp10_not_consumed_by_mbo_path")]
        if stream != "MBO":
            return [], [NormalizationDiagnostic(line_number, stream or "missing", "non_mbo_stream")]

        exchange_ts_ns = _decimal_ns(row.get("exchange_event_ts_ns"))
        sidecar_recv_ts_ns = _decimal_ns(row.get("sidecar_recv_ts_ns"))
        if exchange_ts_ns is None:
            return [], [NormalizationDiagnostic(line_number, stream, "missing_exchange_event_ts_ns")]
        if sidecar_recv_ts_ns is None:
            return [], [NormalizationDiagnostic(line_number, stream, "missing_sidecar_recv_ts_ns")]

        orders = _orders_from_row(row)
        if not orders:
            return [], [NormalizationDiagnostic(line_number, stream, "missing_mbo_orders")]

        events: list[MboOrderLifecycleEvent] = []
        diagnostics: list[NormalizationDiagnostic] = []
        for fallback_index, order in enumerate(orders):
            source_index = _finite_int(order.get("index"))
            if source_index is None:
                source_index = fallback_index

            raw_action = _first_present(order, ("action", "update_type", "event_action"))
            action = _normalize_action(raw_action)
            if action is None:
                diagnostics.append(
                    NormalizationDiagnostic(line_number, stream, _missing_or_unsupported("action", raw_action))
                )
                continue

            raw_side = _first_present(order, ("side", "transaction_type"))
            side = _normalize_side(raw_side)
            if side is None:
                diagnostics.append(NormalizationDiagnostic(line_number, stream, _missing_or_unsupported("side", raw_side)))
                continue

            price = _finite_number(_first_present(order, ("price", "px", "depth_price")))
            if price is None:
                diagnostics.append(NormalizationDiagnostic(line_number, stream, "missing_mbo_price"))
                continue

            size = _finite_int(_first_present(order, ("size", "sz", "depth_size")))
            if size is None or size < 0:
                diagnostics.append(NormalizationDiagnostic(line_number, stream, "missing_mbo_size"))
                continue

            order_id = _non_empty_str(_first_present(order, ("order_id", "exchange_order_id", "orderid")))
            if order_id is None:
                diagnostics.append(NormalizationDiagnostic(line_number, stream, "missing_mbo_order_id"))
                continue

            payload = _payload(
                row=row,
                exchange_ts_ns=exchange_ts_ns,
                sidecar_recv_ts_ns=sidecar_recv_ts_ns,
                source_index=source_index,
                raw_action=_raw_value(raw_action),
                action=action,
                raw_side=_raw_value(raw_side),
                side=side,
                price=price,
                size=size,
                order_id=order_id,
                priority=_non_empty_str(_first_present(order, ("priority", "depth_order_priority"))),
            )
            events.append(
                MboOrderLifecycleEvent(
                    event_type="MICROSTRUCTURE",
                    event_id_prefix="mbo-order-lifecycle",
                    ts_ns=exchange_ts_ns,
                    payload=payload,
                )
            )

        return events, diagnostics


def _payload(
    *,
    row: dict[str, Any],
    exchange_ts_ns: str,
    sidecar_recv_ts_ns: str,
    source_index: int,
    raw_action: str | None,
    action: MboAction,
    raw_side: str | None,
    side: MboSide,
    price: float | int,
    size: int,
    order_id: str,
    priority: str | None,
) -> dict[str, Any]:
    sequence = _decimal_ns(row.get("sequence"))
    payload: dict[str, Any] = {
        "exchange_event_ts_ns": exchange_ts_ns,
        "sidecar_recv_ts_ns": sidecar_recv_ts_ns,
        "feature_snapshot_id": f"mbo-order-lifecycle-{exchange_ts_ns}-{source_index}",
        "l3_authority": "unavailable",
        "source": "mbo_order_lifecycle",
        "microstructure_kind": "mbo_order_lifecycle",
        "provider": "rithmic",
        "provider_scope": DATA01B_MBO_PROVIDER_SCOPE,
        "source_index": source_index,
        "action": action,
        "raw_action": raw_action,
        "side": side,
        "raw_side": raw_side,
        "price": price,
        "size": size,
        "order_id": order_id,
        "mbp10_price_state_status": DATA01B_MBP10_PRICE_STATE_STATUS,
        "mbo_status": DATA01B_MBO_STATUS,
        "mbo_lifecycle_status": DATA01B_MBO_LIFECYCLE_STATUS,
        "mbo_feature_status": DATA01B_MBO_FEATURE_STATUS,
        "data01b_full_status": DATA01B_FULL_STATUS,
    }
    rithmic_publish_ts_ns = _decimal_ns(row.get("rithmic_publish_ts_ns"))
    if rithmic_publish_ts_ns is not None:
        payload["rithmic_publish_ts_ns"] = rithmic_publish_ts_ns
    if sequence is not None:
        payload["sequence"] = sequence
    if priority is not None:
        payload["priority"] = priority

    payload["values"] = {
        "source": payload["source"],
        "microstructure_kind": payload["microstructure_kind"],
        "provider": payload["provider"],
        "provider_scope": payload["provider_scope"],
        "source_index": source_index,
        "action": action,
        "side": side,
        "price": price,
        "size": size,
        "order_id": order_id,
        "has_order_id": True,
        "has_sequence": sequence is not None,
        "mbo_status": DATA01B_MBO_STATUS,
        "mbo_lifecycle_status": DATA01B_MBO_LIFECYCLE_STATUS,
        "mbo_feature_status": DATA01B_MBO_FEATURE_STATUS,
        "data01b_full_status": DATA01B_FULL_STATUS,
    }
    return payload


def _orders_from_row(row: dict[str, Any]) -> list[dict[str, Any]]:
    orders = row.get("orders")
    if isinstance(orders, list):
        return [order for order in orders if isinstance(order, dict)]
    if any(key in row for key in ("action", "update_type", "side", "transaction_type", "price", "depth_price")):
        return [row]
    return []


def _normalize_action(value: Any) -> MboAction | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return {1: "add", 2: "modify", 3: "cancel"}.get(value)  # type: ignore[return-value]
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if normalized in {"a", "add", "new"}:
        return "add"
    if normalized in {"m", "modify", "modified", "change", "update"}:
        return "modify"
    if normalized in {"c", "cancel", "cancelled", "delete", "deleted", "remove"}:
        return "cancel"
    return None


def _normalize_side(value: Any) -> MboSide | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return {1: "bid", 2: "ask"}.get(value)  # type: ignore[return-value]
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if normalized in {"b", "bid", "buy"}:
        return "bid"
    if normalized in {"a", "ask", "offer", "sell"}:
        return "ask"
    return None


def _missing_or_unsupported(field: str, value: Any) -> str:
    return f"missing_mbo_{field}" if value is None or value == "" else f"unsupported_mbo_{field}"


def _first_present(row: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        if key in row:
            return row[key]
    return None


def _raw_value(value: Any) -> str | None:
    if value is None or value == "":
        return None
    return str(value)


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
    if isinstance(parsed, int):
        return parsed
    return None


def _non_empty_str(value: Any) -> str | None:
    if value is None:
        return None
    parsed = str(value)
    return parsed if parsed != "" else None
