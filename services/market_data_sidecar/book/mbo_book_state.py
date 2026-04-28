"""DATA-02-MBO provider-internal MBO book-state reconstruction.

This layer consumes accepted DATA-01B-MBO lifecycle events and builds provider-internal
order state. Queue-position fields emitted here are estimates within a single provider
feed; they are not cross-feed facts and do not complete full DATA-01B.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal

from services.market_data_sidecar.book.mbo_order_lifecycle import (
    RithmicMboOrderLifecycleNormalizer,
)
from services.market_data_sidecar.config import (
    DATA01B_FULL_STATUS,
    DATA01B_MBO_LIFECYCLE_STATUS,
    DATA01B_MBO_PROVIDER_SCOPE,
    DATA01B_MBO_STATUS,
    DATA02_MBO_BOOK_STATE_STATUS,
    DATA02_MBO_QUEUE_POSITION_STATUS,
)
from services.market_data_sidecar.features.availability_mask import (
    FEATURE_AVAILABILITY_MASK,
    feature_availability_values,
)
from services.market_data_sidecar.providers.rithmic_live import NormalizationDiagnostic
from services.market_data_sidecar.publish.event_journal import make_source_event_envelope

MboBookAction = Literal["add", "modify", "cancel"]
MboBookSide = Literal["bid", "ask"]

BOOK_STATE_SCHEMA_VERSION = 1
DEFAULT_TICK_SIZE = 0.25
MAX_RECORDED_DIAGNOSTICS = 100
MAX_LEVELS = 10


@dataclass(frozen=True)
class MboBookStateReport:
    input_rows: int
    consumed_mbo_lifecycle_events: int
    emitted_book_state_snapshots: int
    skipped_non_mbo_lifecycle_rows: int
    skipped_invalid_lifecycle_rows: int
    missing_state_update_count: int
    active_orders: int
    bid_level_count: int
    ask_level_count: int
    diagnostic_count: int
    diagnostic_counts: dict[str, int]
    diagnostics: list[dict[str, Any]]
    diagnostics_truncated: bool
    book_state_schema_version: int
    mbo_status: str
    mbo_lifecycle_status: str
    mbo_book_state_status: str
    queue_position_status: str
    provider_scope: str
    data01b_full_status: str


@dataclass
class OrderState:
    order_id: str
    side: MboBookSide
    price: float | int
    size: int
    queue_ordinal: int
    created_exchange_event_ts_ns: str
    last_exchange_event_ts_ns: str
    sequence: str | None
    priority: str | None


class MboOrderBookStateBuilder:
    """Maintains provider-internal order state and emits queue estimates."""

    def __init__(self, *, symbol: str, tick_size: float = DEFAULT_TICK_SIZE) -> None:
        if tick_size <= 0:
            raise ValueError("tick_size must be positive")
        self._symbol = symbol
        self._tick_size = tick_size
        self._orders: dict[str, OrderState] = {}
        self._next_queue_ordinal = 0
        self.missing_state_update_count = 0

    @property
    def active_order_count(self) -> int:
        return len(self._orders)

    @property
    def bid_level_count(self) -> int:
        return len(self._levels("bid"))

    @property
    def ask_level_count(self) -> int:
        return len(self._levels("ask"))

    def apply_lifecycle_payload(self, payload: dict[str, Any], *, snapshot_id: str) -> dict[str, Any]:
        exchange_ts_ns = _decimal_ns(payload.get("exchange_event_ts_ns"))
        sidecar_recv_ts_ns = _decimal_ns(payload.get("sidecar_recv_ts_ns"))
        if exchange_ts_ns is None:
            raise ValueError("mbo lifecycle payload missing exchange_event_ts_ns")
        if sidecar_recv_ts_ns is None:
            raise ValueError("mbo lifecycle payload missing sidecar_recv_ts_ns")

        action = _mbo_action(payload.get("action"))
        side = _mbo_side(payload.get("side"))
        price = _finite_number(payload.get("price"))
        size = _finite_int(payload.get("size"))
        order_id = _non_empty_str(payload.get("order_id"))
        if action is None:
            raise ValueError("mbo lifecycle payload missing or unsupported action")
        if side is None:
            raise ValueError("mbo lifecycle payload missing or unsupported side")
        if price is None:
            raise ValueError("mbo lifecycle payload missing price")
        if size is None or size < 0:
            raise ValueError("mbo lifecycle payload missing size")
        if order_id is None:
            raise ValueError("mbo lifecycle payload missing order_id")

        previous = self._orders.get(order_id)
        order_active = False
        state_reason = "applied"
        if action == "cancel" or size == 0:
            if previous is None:
                self.missing_state_update_count += 1
                state_reason = "cancel_missing_order"
            else:
                del self._orders[order_id]
                order_active = False
        elif action == "add":
            queue_ordinal = previous.queue_ordinal if previous is not None else self._allocate_queue_ordinal()
            created_ts = previous.created_exchange_event_ts_ns if previous is not None else exchange_ts_ns
            self._orders[order_id] = OrderState(
                order_id=order_id,
                side=side,
                price=price,
                size=size,
                queue_ordinal=queue_ordinal,
                created_exchange_event_ts_ns=created_ts,
                last_exchange_event_ts_ns=exchange_ts_ns,
                sequence=_decimal_ns(payload.get("sequence")),
                priority=_non_empty_str(payload.get("priority")),
            )
            order_active = True
            if previous is not None:
                state_reason = "duplicate_add_replaced"
        else:
            if previous is None:
                self.missing_state_update_count += 1
                queue_ordinal = self._allocate_queue_ordinal()
                created_ts = exchange_ts_ns
                state_reason = "modify_missing_order_inserted"
            else:
                moved_level = previous.side != side or previous.price != price
                queue_ordinal = self._allocate_queue_ordinal() if moved_level else previous.queue_ordinal
                created_ts = previous.created_exchange_event_ts_ns
                state_reason = "modify_moved_level" if moved_level else "applied"
            self._orders[order_id] = OrderState(
                order_id=order_id,
                side=side,
                price=price,
                size=size,
                queue_ordinal=queue_ordinal,
                created_exchange_event_ts_ns=created_ts,
                last_exchange_event_ts_ns=exchange_ts_ns,
                sequence=_decimal_ns(payload.get("sequence")),
                priority=_non_empty_str(payload.get("priority")),
            )
            order_active = True

        order_state = self._orders.get(order_id)
        queue = _queue_estimate(order_state, self._orders) if order_state is not None else _empty_queue_estimate()
        bids = self._levels("bid")[:MAX_LEVELS]
        asks = self._levels("ask")[:MAX_LEVELS]
        top_bid = bids[0]["px"] if bids else None
        top_ask = asks[0]["px"] if asks else None
        spread_points = top_ask - top_bid if top_bid is not None and top_ask is not None else None
        spread_ticks = spread_points / self._tick_size if spread_points is not None else None
        mid_px = (top_bid + top_ask) / 2 if spread_points is not None else None

        values = _scalar_values(
            symbol=self._symbol,
            action=action,
            side=side,
            price=price,
            size=size,
            order_id=order_id,
            order_active=order_active,
            state_reason=state_reason,
            top_bid=top_bid,
            top_ask=top_ask,
            spread_points=spread_points,
            spread_ticks=spread_ticks,
            mid_px=mid_px,
            bids=bids,
            asks=asks,
            queue=queue,
            active_orders=self.active_order_count,
        )

        output: dict[str, Any] = {
            "book_state_schema_version": BOOK_STATE_SCHEMA_VERSION,
            "feature_snapshot_id": snapshot_id,
            "exchange_event_ts_ns": exchange_ts_ns,
            "sidecar_recv_ts_ns": sidecar_recv_ts_ns,
            "symbol": self._symbol,
            "source": "mbo_order_book_state",
            "microstructure_kind": "mbo_order_book_state",
            "provider": "rithmic",
            "provider_scope": DATA01B_MBO_PROVIDER_SCOPE,
            "l3_authority": "unavailable",
            "action": action,
            "side": side,
            "price": price,
            "size": size,
            "order_id": order_id,
            "order_active": order_active,
            "state_reason": state_reason,
            "top_bid_px": top_bid,
            "top_ask_px": top_ask,
            "spread_points": spread_points,
            "spread_ticks": spread_ticks,
            "mid_px": mid_px,
            "bid_levels": bids,
            "ask_levels": asks,
            "active_order_count": self.active_order_count,
            "bid_level_count": len(bids),
            "ask_level_count": len(asks),
            "queue": queue,
            "validity": {
                "provider_internal_scope": True,
                "has_complete_top_of_book": top_bid is not None and top_ask is not None,
                "queue_position_estimate_available": queue["queue_position_estimate"] is not None,
                "queue_position_as_fact_available": False,
                "l2_l3_scope": "mbo_provider_internal",
            },
            "feature_availability_mask": FEATURE_AVAILABILITY_MASK,
            "values": values,
            "mbo_status": DATA01B_MBO_STATUS,
            "mbo_lifecycle_status": DATA01B_MBO_LIFECYCLE_STATUS,
            "mbo_book_state_status": DATA02_MBO_BOOK_STATE_STATUS,
            "queue_position_status": DATA02_MBO_QUEUE_POSITION_STATUS,
            "data01b_full_status": DATA01B_FULL_STATUS,
        }
        rithmic_publish_ts_ns = _decimal_ns(payload.get("rithmic_publish_ts_ns"))
        sequence = _decimal_ns(payload.get("sequence"))
        priority = _non_empty_str(payload.get("priority"))
        if rithmic_publish_ts_ns is not None:
            output["rithmic_publish_ts_ns"] = rithmic_publish_ts_ns
        if sequence is not None:
            output["sequence"] = sequence
        if priority is not None:
            output["priority"] = priority
        return output

    def _allocate_queue_ordinal(self) -> int:
        current = self._next_queue_ordinal
        self._next_queue_ordinal += 1
        return current

    def _levels(self, side: MboBookSide) -> list[dict[str, float | int]]:
        grouped: dict[float | int, list[OrderState]] = {}
        for order in self._orders.values():
            if order.side == side:
                grouped.setdefault(order.price, []).append(order)
        prices = sorted(grouped.keys(), reverse=side == "bid")
        levels: list[dict[str, float | int]] = []
        for price in prices:
            orders = sorted(grouped[price], key=lambda order: order.queue_ordinal)
            levels.append(
                {
                    "px": price,
                    "aggregate_size_subscope": sum(order.size for order in orders),
                    "order_count_subscope": len(orders),
                }
            )
        return levels


def build_mbo_book_state_journal(
    *,
    input_path: Path,
    output_path: Path,
    report_path: Path | None = None,
    run_id: str,
    session_id: str,
    symbol: str,
    tick_size: float = DEFAULT_TICK_SIZE,
) -> MboBookStateReport:
    builder = MboOrderBookStateBuilder(symbol=symbol, tick_size=tick_size)
    lifecycle_normalizer = RithmicMboOrderLifecycleNormalizer()
    diagnostics: list[NormalizationDiagnostic] = []
    diagnostic_counts: dict[str, int] = {}
    diagnostic_count = 0
    input_rows = 0
    consumed = 0
    emitted = 0
    skipped_non_mbo_lifecycle_rows = 0
    skipped_invalid_lifecycle_rows = 0

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with (
        input_path.open("r", encoding="utf-8", errors="replace") as source,
        output_path.open("w", encoding="utf-8", newline="\n") as output,
    ):
        for line_number, line in enumerate(source, 1):
            if line.strip() == "":
                continue
            input_rows += 1
            row = json.loads(line)
            if not isinstance(row, dict):
                diagnostic_count = _record_diagnostic(
                    diagnostics,
                    diagnostic_counts,
                    diagnostic_count,
                    NormalizationDiagnostic(line_number, "missing", "row_not_object"),
                )
                skipped_invalid_lifecycle_rows += 1
                continue

            lifecycle_events = _lifecycle_events_from_row(
                row,
                line_number=line_number,
                normalizer=lifecycle_normalizer,
            )
            if isinstance(lifecycle_events, NormalizationDiagnostic):
                diagnostic_count = _record_diagnostic(
                    diagnostics,
                    diagnostic_counts,
                    diagnostic_count,
                    lifecycle_events,
                )
                skipped_non_mbo_lifecycle_rows += 1
                continue

            for lifecycle in lifecycle_events:
                consumed += 1
                sequence = emitted + 1
                event_id = f"mbo-book-state-{run_id}-{sequence:012d}"
                try:
                    payload = builder.apply_lifecycle_payload(
                        lifecycle.payload,
                        snapshot_id=event_id,
                    )
                except ValueError as exc:
                    diagnostic_count = _record_diagnostic(
                        diagnostics,
                        diagnostic_counts,
                        diagnostic_count,
                        NormalizationDiagnostic(line_number, "MBO", str(exc)),
                    )
                    skipped_invalid_lifecycle_rows += 1
                    continue

                envelope = make_source_event_envelope(
                    event_id=event_id,
                    event_type="MICROSTRUCTURE",
                    ts_ns=payload["exchange_event_ts_ns"],
                    run_id=run_id,
                    session_id=session_id,
                    payload={
                        **payload,
                        **({"source_event_id": lifecycle.source_event_id} if lifecycle.source_event_id else {}),
                    },
                    causation_id=lifecycle.source_event_id,
                )
                output.write(json.dumps(envelope, sort_keys=True, separators=(",", ":")))
                output.write("\n")
                emitted += 1

    report = MboBookStateReport(
        input_rows=input_rows,
        consumed_mbo_lifecycle_events=consumed,
        emitted_book_state_snapshots=emitted,
        skipped_non_mbo_lifecycle_rows=skipped_non_mbo_lifecycle_rows,
        skipped_invalid_lifecycle_rows=skipped_invalid_lifecycle_rows,
        missing_state_update_count=builder.missing_state_update_count,
        active_orders=builder.active_order_count,
        bid_level_count=builder.bid_level_count,
        ask_level_count=builder.ask_level_count,
        diagnostic_count=diagnostic_count,
        diagnostic_counts=dict(sorted(diagnostic_counts.items())),
        diagnostics=[asdict(diagnostic) for diagnostic in diagnostics],
        diagnostics_truncated=diagnostic_count > len(diagnostics),
        book_state_schema_version=BOOK_STATE_SCHEMA_VERSION,
        mbo_status=DATA01B_MBO_STATUS,
        mbo_lifecycle_status=DATA01B_MBO_LIFECYCLE_STATUS,
        mbo_book_state_status=DATA02_MBO_BOOK_STATE_STATUS,
        queue_position_status=DATA02_MBO_QUEUE_POSITION_STATUS,
        provider_scope=DATA01B_MBO_PROVIDER_SCOPE,
        data01b_full_status=DATA01B_FULL_STATUS,
    )
    if report_path is not None:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(
            json.dumps(asdict(report), sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
            newline="\n",
        )
    return report


@dataclass(frozen=True)
class _LifecycleInput:
    payload: dict[str, Any]
    source_event_id: str | None


def _lifecycle_events_from_row(
    row: dict[str, Any],
    *,
    line_number: int,
    normalizer: RithmicMboOrderLifecycleNormalizer,
) -> list[_LifecycleInput] | NormalizationDiagnostic:
    if row.get("type") == "MICROSTRUCTURE" and isinstance(row.get("payload"), dict):
        payload = row["payload"]
        if payload.get("source") == "mbo_order_lifecycle" or payload.get(
            "microstructure_kind"
        ) == "mbo_order_lifecycle":
            source_event_id = row.get("event_id")
            return [_LifecycleInput(payload=payload, source_event_id=str(source_event_id) if isinstance(source_event_id, str) else None)]
        return NormalizationDiagnostic(line_number, "MICROSTRUCTURE", "non_mbo_lifecycle_microstructure")

    stream = str(row.get("stream") or row.get("stream_id") or "")
    if stream == "MBO":
        normalized_events, diagnostics = normalizer.normalize_row(row, line_number=line_number)
        if diagnostics and not normalized_events:
            return diagnostics[0]
        return [_LifecycleInput(payload=event.payload, source_event_id=None) for event in normalized_events]
    if stream == "MBP10":
        return NormalizationDiagnostic(line_number, stream, "mbp10_not_consumed_by_mbo_book_state_path")
    return NormalizationDiagnostic(
        line_number,
        stream or str(row.get("type") or "missing"),
        "non_mbo_lifecycle_input",
    )


def _queue_estimate(order: OrderState | None, orders: dict[str, OrderState]) -> dict[str, int | bool | None]:
    if order is None:
        return _empty_queue_estimate()
    level_orders = sorted(
        (
            candidate
            for candidate in orders.values()
            if candidate.side == order.side and candidate.price == order.price
        ),
        key=lambda candidate: candidate.queue_ordinal,
    )
    index = next((idx for idx, candidate in enumerate(level_orders) if candidate.order_id == order.order_id), None)
    if index is None:
        return _empty_queue_estimate()
    ahead = level_orders[:index]
    return {
        "queue_position_estimate": index,
        "queue_ahead_order_count_estimate": len(ahead),
        "queue_ahead_size_estimate": sum(candidate.size for candidate in ahead),
        "level_order_count_subscope": len(level_orders),
        "level_aggregate_size_subscope": sum(candidate.size for candidate in level_orders),
        "queue_position_as_fact_available": False,
    }


def _empty_queue_estimate() -> dict[str, int | bool | None]:
    return {
        "queue_position_estimate": None,
        "queue_ahead_order_count_estimate": None,
        "queue_ahead_size_estimate": None,
        "level_order_count_subscope": None,
        "level_aggregate_size_subscope": None,
        "queue_position_as_fact_available": False,
    }


def _scalar_values(
    *,
    symbol: str,
    action: MboBookAction,
    side: MboBookSide,
    price: float | int,
    size: int,
    order_id: str,
    order_active: bool,
    state_reason: str,
    top_bid: float | int | None,
    top_ask: float | int | None,
    spread_points: float | int | None,
    spread_ticks: float | int | None,
    mid_px: float | int | None,
    bids: list[dict[str, float | int]],
    asks: list[dict[str, float | int]],
    queue: dict[str, int | bool | None],
    active_orders: int,
) -> dict[str, float | int | str | bool | None]:
    values: dict[str, float | int | str | bool | None] = {
        "book_state_schema_version": BOOK_STATE_SCHEMA_VERSION,
        "symbol": symbol,
        "source": "mbo_order_book_state",
        "microstructure_kind": "mbo_order_book_state",
        "provider": "rithmic",
        "provider_scope": DATA01B_MBO_PROVIDER_SCOPE,
        "action": action,
        "side": side,
        "price": price,
        "size": size,
        "order_id": order_id,
        "order_active": order_active,
        "state_reason": state_reason,
        "top_bid_px": top_bid,
        "top_ask_px": top_ask,
        "spread_points": spread_points,
        "spread_ticks": spread_ticks,
        "mid_px": mid_px,
        "active_order_count": active_orders,
        "bid_level_count": len(bids),
        "ask_level_count": len(asks),
        "mbo_status": DATA01B_MBO_STATUS,
        "mbo_lifecycle_status": DATA01B_MBO_LIFECYCLE_STATUS,
        "mbo_book_state_status": DATA02_MBO_BOOK_STATE_STATUS,
        "queue_position_status": DATA02_MBO_QUEUE_POSITION_STATUS,
        "data01b_full_status": DATA01B_FULL_STATUS,
        **queue,
        **feature_availability_values(),
    }
    for side_name, levels in (("bid", bids), ("ask", asks)):
        for index, level in enumerate(levels):
            suffix = f"{index:02d}"
            values[f"{side_name}_level_px_{suffix}"] = level["px"]
            values[f"{side_name}_level_aggregate_size_subscope_{suffix}"] = level["aggregate_size_subscope"]
            values[f"{side_name}_level_order_count_subscope_{suffix}"] = level["order_count_subscope"]
    return values


def _record_diagnostic(
    diagnostics: list[NormalizationDiagnostic],
    diagnostic_counts: dict[str, int],
    diagnostic_count: int,
    diagnostic: NormalizationDiagnostic,
) -> int:
    key = f"{diagnostic.stream}:{diagnostic.reason}"
    diagnostic_counts[key] = diagnostic_counts.get(key, 0) + 1
    if len(diagnostics) < MAX_RECORDED_DIAGNOSTICS:
        diagnostics.append(diagnostic)
    return diagnostic_count + 1


def _mbo_action(value: Any) -> MboBookAction | None:
    return value if value in {"add", "modify", "cancel"} else None  # type: ignore[return-value]


def _mbo_side(value: Any) -> MboBookSide | None:
    return value if value in {"bid", "ask"} else None  # type: ignore[return-value]


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
