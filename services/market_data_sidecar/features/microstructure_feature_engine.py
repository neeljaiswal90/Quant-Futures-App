"""DATA-04 tier-aware microstructure feature engine.

This layer consumes already-accepted feature surfaces:

- DATA-02-PS MBP10 price-state snapshots for authoritative price features.
- DATA-02-MBO provider-internal book-state snapshots for sub-scope depth and queue estimates.
- DATA-01A trade events for authoritative trade-aggressor imbalance.

It does not turn provider-internal estimates into provider-neutral facts. Each emitted
feature includes an explicit tier derived from the DATA-03 feature availability mask.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal

from services.market_data_sidecar.config import (
    DATA01B_FULL_STATUS,
    DATA01B_MBO_STATUS,
    DATA01B_MBP10_PRICE_STATE_STATUS,
    DATA02_MBO_BOOK_STATE_STATUS,
    DATA02_MBO_QUEUE_POSITION_STATUS,
    DATA04_BLOCKED_FEATURE_STATUS,
    DATA04_MICROSTRUCTURE_FEATURE_STATUS,
)
from services.market_data_sidecar.features.availability_mask import (
    FEATURE_AVAILABILITY_MASK,
    feature_availability_values,
    tier_of,
)
from services.market_data_sidecar.providers.rithmic_live import (
    NormalizationDiagnostic,
    RithmicL1TradeNormalizer,
)
from services.market_data_sidecar.publish.event_journal import make_source_event_envelope

MICROSTRUCTURE_FEATURE_SCHEMA_VERSION = 1
DEFAULT_TICK_SIZE = 0.25
DEFAULT_DEPTH_LEVELS = 3
DEFAULT_OFI_SHORT_WINDOW = 3
DEFAULT_OFI_MEDIUM_WINDOW = 10
DEFAULT_TRADE_WINDOW = 20
MAX_RECORDED_DIAGNOSTICS = 100

FeatureTier = Literal["authoritative", "diagnostic_only", "shadow_only", "blocked", "subscope"]

BLOCKED_FEATURES = (
    "queue_position",
    "queue_position_as_fact",
    "order_lifetime",
    "cancel_add_ratio",
    "absorption",
    "sweep",
)


@dataclass(frozen=True)
class MicrostructureFeatureReport:
    input_rows: int
    emitted_feature_snapshots: int
    price_state_inputs: int
    mbo_book_state_inputs: int
    trade_inputs: int
    skipped_rows: int
    diagnostic_count: int
    diagnostic_counts: dict[str, int]
    diagnostics: list[dict[str, Any]]
    diagnostics_truncated: bool
    feature_schema_version: int
    feature_tier_counts: dict[str, int]
    microstructure_feature_status: str
    blocked_feature_status: str
    mbp10_price_state_status: str
    mbo_status: str
    mbo_book_state_status: str
    queue_position_status: str
    data01b_full_status: str
    sim_status: str
    rel_status: str


@dataclass(frozen=True)
class _SnapshotInput:
    payload: dict[str, Any]
    source_event_id: str | None


@dataclass(frozen=True)
class _TopState:
    bid_px: float | int | None
    bid_size: float | int | None
    ask_px: float | int | None
    ask_size: float | int | None


class MicrostructureFeatureEngine:
    """Builds deterministic DATA-04 feature snapshots from accepted upstream layers."""

    def __init__(
        self,
        *,
        symbol: str,
        tick_size: float = DEFAULT_TICK_SIZE,
        depth_levels: int = DEFAULT_DEPTH_LEVELS,
        ofi_short_window: int = DEFAULT_OFI_SHORT_WINDOW,
        ofi_medium_window: int = DEFAULT_OFI_MEDIUM_WINDOW,
        trade_window: int = DEFAULT_TRADE_WINDOW,
    ) -> None:
        if tick_size <= 0:
            raise ValueError("tick_size must be positive")
        if depth_levels <= 0:
            raise ValueError("depth_levels must be positive")
        if ofi_short_window <= 0 or ofi_medium_window <= 0:
            raise ValueError("OFI windows must be positive")
        if trade_window <= 0:
            raise ValueError("trade_window must be positive")

        self._symbol = symbol
        self._tick_size = tick_size
        self._depth_levels = depth_levels
        self._ofi_short_window = ofi_short_window
        self._ofi_medium_window = ofi_medium_window
        self._trade_window = trade_window
        self._latest_price_state: dict[str, Any] | None = None
        self._latest_price_state_source_event_id: str | None = None
        self._latest_mbo_book_state: dict[str, Any] | None = None
        self._latest_mbo_source_event_id: str | None = None
        self._previous_mbo_top: _TopState | None = None
        self._ofi_deltas: list[float | int] = []
        self._trade_signed_sizes: list[float | int] = []

    def update_price_state(self, payload: dict[str, Any], *, source_event_id: str | None) -> None:
        self._latest_price_state = payload
        self._latest_price_state_source_event_id = source_event_id

    def update_mbo_book_state(self, payload: dict[str, Any], *, source_event_id: str | None) -> None:
        current_top = _mbo_top_state(payload)
        delta = _ofi_delta(self._previous_mbo_top, current_top)
        if delta is not None:
            self._ofi_deltas.append(delta)
            self._ofi_deltas = self._ofi_deltas[-self._ofi_medium_window :]
        self._previous_mbo_top = current_top
        self._latest_mbo_book_state = payload
        self._latest_mbo_source_event_id = source_event_id

    def update_trade(self, payload: dict[str, Any]) -> None:
        signed = _signed_trade_size(payload)
        if signed is not None:
            self._trade_signed_sizes.append(signed)
            self._trade_signed_sizes = self._trade_signed_sizes[-self._trade_window :]

    def build_payload(
        self,
        *,
        trigger_payload: dict[str, Any],
        trigger_source_event_id: str | None,
        trigger_kind: str,
        feature_snapshot_id: str,
    ) -> dict[str, Any]:
        exchange_ts_ns = _decimal_ns(trigger_payload.get("exchange_event_ts_ns"))
        if exchange_ts_ns is None:
            exchange_ts_ns = _decimal_ns(trigger_payload.get("ts_ns"))
        if exchange_ts_ns is None:
            raise ValueError("trigger payload missing exchange_event_ts_ns")

        price_state = self._latest_price_state
        mbo_state = self._latest_mbo_book_state
        price_top = _price_state_top(price_state)
        mbo_top = _mbo_top_state(mbo_state)

        spread_points = _spread_points(price_top)
        spread_ticks = spread_points / self._tick_size if spread_points is not None else None
        mid_px = _mid_px(price_top)
        top_imbalance = _imbalance(mbo_top.bid_size, mbo_top.ask_size)
        microprice_offset_ticks = _microprice_offset_ticks(price_top, mbo_top, self._tick_size)
        depth_imbalance = _depth_imbalance(mbo_state, self._depth_levels)
        queue_ahead_fraction = _queue_ahead_fraction(mbo_state)
        queue_imbalance = 1 - (2 * queue_ahead_fraction) if queue_ahead_fraction is not None else None
        ofi_short = _average(self._ofi_deltas[-self._ofi_short_window :])
        ofi_medium = _average(self._ofi_deltas[-self._ofi_medium_window :])
        ofi_blend = (
            (0.6 * ofi_short) + (0.4 * ofi_medium)
            if ofi_short is not None and ofi_medium is not None
            else None
        )
        trade_imbalance = _trade_aggressor_imbalance(self._trade_signed_sizes)

        feature_tiers: dict[str, FeatureTier] = {
            "spread_points": tier_of(FEATURE_AVAILABILITY_MASK, "microstructure_spread_points"),
            "spread_ticks": tier_of(FEATURE_AVAILABILITY_MASK, "microstructure_spread_ticks"),
            "mid_px": tier_of(FEATURE_AVAILABILITY_MASK, "microstructure_mid_px"),
            "top_of_book_imbalance": tier_of(FEATURE_AVAILABILITY_MASK, "mbo_top_of_book_size_imbalance"),
            "microprice_offset_ticks": tier_of(FEATURE_AVAILABILITY_MASK, "mbo_microprice_offset_ticks"),
            "ofi_short": tier_of(FEATURE_AVAILABILITY_MASK, "mbo_ofi_short"),
            "ofi_medium": tier_of(FEATURE_AVAILABILITY_MASK, "mbo_ofi_medium"),
            "ofi_blend": tier_of(FEATURE_AVAILABILITY_MASK, "mbo_ofi_blend"),
            "trade_aggressor_imbalance": tier_of(FEATURE_AVAILABILITY_MASK, "trade_aggressor_imbalance"),
            "recent_depth_imbalance": tier_of(FEATURE_AVAILABILITY_MASK, "mbo_recent_depth_imbalance"),
            "queue_imbalance": tier_of(FEATURE_AVAILABILITY_MASK, "mbo_queue_imbalance"),
            "queue_ahead_fraction_estimate": tier_of(FEATURE_AVAILABILITY_MASK, "queue_ahead_fraction_estimate"),
        }
        blocked_feature_tiers = {
            feature: tier_of(FEATURE_AVAILABILITY_MASK, feature) for feature in BLOCKED_FEATURES
        }
        values = _scalar_values(
            symbol=self._symbol,
            trigger_kind=trigger_kind,
            spread_points=spread_points,
            spread_ticks=spread_ticks,
            mid_px=mid_px,
            top_imbalance=top_imbalance,
            microprice_offset_ticks=microprice_offset_ticks,
            ofi_short=ofi_short,
            ofi_medium=ofi_medium,
            ofi_blend=ofi_blend,
            trade_imbalance=trade_imbalance,
            depth_imbalance=depth_imbalance,
            queue_imbalance=queue_imbalance,
            queue_ahead_fraction=queue_ahead_fraction,
            feature_tiers=feature_tiers,
            blocked_feature_tiers=blocked_feature_tiers,
        )
        source_event_ids = _source_event_ids(
            self._latest_price_state_source_event_id,
            self._latest_mbo_source_event_id,
            trigger_source_event_id,
        )

        payload: dict[str, Any] = {
            "microstructure_feature_schema_version": MICROSTRUCTURE_FEATURE_SCHEMA_VERSION,
            "feature_snapshot_id": feature_snapshot_id,
            "exchange_event_ts_ns": exchange_ts_ns,
            "symbol": self._symbol,
            "source": "microstructure_feature_engine",
            "trigger_kind": trigger_kind,
            "source_event_ids": source_event_ids,
            "feature_availability_mask": FEATURE_AVAILABILITY_MASK,
            "feature_tiers": feature_tiers,
            "blocked_features": list(BLOCKED_FEATURES),
            "blocked_feature_tiers": blocked_feature_tiers,
            "values": values,
            "validity": {
                "has_price_state": price_state is not None,
                "has_mbo_book_state": mbo_state is not None,
                "has_trade_aggressor_window": bool(self._trade_signed_sizes),
                "queue_position_as_fact_available": False,
                "blocked_features_not_emitted": True,
            },
            "inputs": {
                "price_state_source_event_id": self._latest_price_state_source_event_id,
                "mbo_book_state_source_event_id": self._latest_mbo_source_event_id,
                "trigger_source_event_id": trigger_source_event_id,
            },
            "microstructure_feature_status": DATA04_MICROSTRUCTURE_FEATURE_STATUS,
            "blocked_feature_status": DATA04_BLOCKED_FEATURE_STATUS,
            "mbp10_price_state_status": DATA01B_MBP10_PRICE_STATE_STATUS,
            "mbo_status": DATA01B_MBO_STATUS,
            "mbo_book_state_status": DATA02_MBO_BOOK_STATE_STATUS,
            "queue_position_status": DATA02_MBO_QUEUE_POSITION_STATUS,
            "data01b_full_status": DATA01B_FULL_STATUS,
            "sim_status": "blocked",
            "rel_status": "blocked",
        }
        if trigger_source_event_id is not None:
            payload["source_event_id"] = trigger_source_event_id
        return payload


def build_microstructure_feature_journal(
    *,
    input_path: Path,
    output_path: Path,
    report_path: Path | None = None,
    run_id: str,
    session_id: str,
    symbol: str,
    tick_size: float = DEFAULT_TICK_SIZE,
    depth_levels: int = DEFAULT_DEPTH_LEVELS,
    ofi_short_window: int = DEFAULT_OFI_SHORT_WINDOW,
    ofi_medium_window: int = DEFAULT_OFI_MEDIUM_WINDOW,
    trade_window: int = DEFAULT_TRADE_WINDOW,
) -> MicrostructureFeatureReport:
    engine = MicrostructureFeatureEngine(
        symbol=symbol,
        tick_size=tick_size,
        depth_levels=depth_levels,
        ofi_short_window=ofi_short_window,
        ofi_medium_window=ofi_medium_window,
        trade_window=trade_window,
    )
    l1_trade_normalizer = RithmicL1TradeNormalizer()
    diagnostics: list[NormalizationDiagnostic] = []
    diagnostic_counts: dict[str, int] = {}
    input_rows = 0
    emitted = 0
    price_state_inputs = 0
    mbo_book_state_inputs = 0
    trade_inputs = 0
    skipped_rows = 0
    diagnostic_count = 0
    tier_counts: dict[str, int] = {}

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
                skipped_rows += 1
                continue

            snapshot_input, trigger_kind, diagnostic = _snapshot_input_from_row(
                row,
                line_number=line_number,
                l1_trade_normalizer=l1_trade_normalizer,
            )
            if diagnostic is not None:
                diagnostic_count = _record_diagnostic(
                    diagnostics,
                    diagnostic_counts,
                    diagnostic_count,
                    diagnostic,
                )
                skipped_rows += 1
                continue
            if snapshot_input is None or trigger_kind is None:
                continue

            if trigger_kind == "price_state":
                engine.update_price_state(snapshot_input.payload, source_event_id=snapshot_input.source_event_id)
                price_state_inputs += 1
            elif trigger_kind == "mbo_book_state":
                engine.update_mbo_book_state(snapshot_input.payload, source_event_id=snapshot_input.source_event_id)
                mbo_book_state_inputs += 1
            elif trigger_kind == "trade":
                engine.update_trade(snapshot_input.payload)
                trade_inputs += 1
            else:
                skipped_rows += 1
                continue

            sequence = emitted + 1
            event_id = f"microstructure-features-{run_id}-{sequence:012d}"
            try:
                payload = engine.build_payload(
                    trigger_payload=snapshot_input.payload,
                    trigger_source_event_id=snapshot_input.source_event_id,
                    trigger_kind=trigger_kind,
                    feature_snapshot_id=event_id,
                )
            except ValueError as exc:
                diagnostic_count = _record_diagnostic(
                    diagnostics,
                    diagnostic_counts,
                    diagnostic_count,
                    NormalizationDiagnostic(line_number, "FEATURES", str(exc)),
                )
                skipped_rows += 1
                continue

            for tier in payload["feature_tiers"].values():
                tier_counts[tier] = tier_counts.get(tier, 0) + 1

            envelope = make_source_event_envelope(
                event_id=event_id,
                event_type="FEATURES",
                ts_ns=payload["exchange_event_ts_ns"],
                run_id=run_id,
                session_id=session_id,
                payload=payload,
                causation_id=snapshot_input.source_event_id,
            )
            output.write(json.dumps(envelope, sort_keys=True, separators=(",", ":")))
            output.write("\n")
            emitted += 1

    report = MicrostructureFeatureReport(
        input_rows=input_rows,
        emitted_feature_snapshots=emitted,
        price_state_inputs=price_state_inputs,
        mbo_book_state_inputs=mbo_book_state_inputs,
        trade_inputs=trade_inputs,
        skipped_rows=skipped_rows,
        diagnostic_count=diagnostic_count,
        diagnostic_counts=dict(sorted(diagnostic_counts.items())),
        diagnostics=[asdict(diagnostic) for diagnostic in diagnostics],
        diagnostics_truncated=diagnostic_count > len(diagnostics),
        feature_schema_version=MICROSTRUCTURE_FEATURE_SCHEMA_VERSION,
        feature_tier_counts=dict(sorted(tier_counts.items())),
        microstructure_feature_status=DATA04_MICROSTRUCTURE_FEATURE_STATUS,
        blocked_feature_status=DATA04_BLOCKED_FEATURE_STATUS,
        mbp10_price_state_status=DATA01B_MBP10_PRICE_STATE_STATUS,
        mbo_status=DATA01B_MBO_STATUS,
        mbo_book_state_status=DATA02_MBO_BOOK_STATE_STATUS,
        queue_position_status=DATA02_MBO_QUEUE_POSITION_STATUS,
        data01b_full_status=DATA01B_FULL_STATUS,
        sim_status="blocked",
        rel_status="blocked",
    )
    if report_path is not None:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(
            json.dumps(asdict(report), sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
            newline="\n",
        )
    return report


def _snapshot_input_from_row(
    row: dict[str, Any],
    *,
    line_number: int,
    l1_trade_normalizer: RithmicL1TradeNormalizer,
) -> tuple[_SnapshotInput | None, str | None, NormalizationDiagnostic | None]:
    event_type = row.get("type")
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else None
    source_event_id = str(row["event_id"]) if isinstance(row.get("event_id"), str) else None
    if event_type == "MICROSTRUCTURE" and payload is not None:
        if payload.get("source") == "mbp10_price_state":
            return _SnapshotInput(payload=payload, source_event_id=source_event_id), "price_state", None
        if payload.get("source") == "mbo_order_book_state":
            return _SnapshotInput(payload=payload, source_event_id=source_event_id), "mbo_book_state", None
        return None, None, NormalizationDiagnostic(
            line_number,
            "MICROSTRUCTURE",
            "non_data04_microstructure_input",
        )
    if event_type == "TRADE" and payload is not None:
        return _SnapshotInput(payload=payload, source_event_id=source_event_id), "trade", None

    stream = str(row.get("stream") or row.get("stream_id") or "")
    if stream == "LAST_TRADE":
        normalized, diagnostic = l1_trade_normalizer.normalize_row(row, line_number=line_number)
        if normalized is not None and normalized.event_type == "TRADE":
            return _SnapshotInput(payload=normalized.payload, source_event_id=None), "trade", diagnostic
        return None, None, diagnostic
    return None, None, NormalizationDiagnostic(
        line_number,
        stream or str(event_type or "missing"),
        "unsupported_microstructure_feature_input",
    )


def _price_state_top(payload: dict[str, Any] | None) -> _TopState:
    if payload is None:
        return _TopState(None, None, None, None)
    return _TopState(
        bid_px=_finite_number(payload.get("top_bid_px")),
        bid_size=None,
        ask_px=_finite_number(payload.get("top_ask_px")),
        ask_size=None,
    )


def _mbo_top_state(payload: dict[str, Any] | None) -> _TopState:
    if payload is None:
        return _TopState(None, None, None, None)
    bids = _mbo_levels(payload, "bid")
    asks = _mbo_levels(payload, "ask")
    return _TopState(
        bid_px=_finite_number(payload.get("top_bid_px")) or (bids[0]["px"] if bids else None),
        bid_size=bids[0]["size"] if bids else None,
        ask_px=_finite_number(payload.get("top_ask_px")) or (asks[0]["px"] if asks else None),
        ask_size=asks[0]["size"] if asks else None,
    )


def _mbo_levels(payload: dict[str, Any], side: Literal["bid", "ask"]) -> list[dict[str, float | int]]:
    key = "bid_levels" if side == "bid" else "ask_levels"
    raw_levels = payload.get(key)
    if not isinstance(raw_levels, list):
        return []
    levels: list[dict[str, float | int]] = []
    for item in raw_levels:
        if not isinstance(item, dict):
            continue
        px = _finite_number(item.get("px"))
        size = _finite_number(item.get("aggregate_size_subscope"))
        order_count = _finite_number(item.get("order_count_subscope"))
        if px is None or size is None:
            continue
        levels.append({"px": px, "size": size, "order_count": order_count or 0})
    return levels


def _spread_points(top: _TopState) -> float | int | None:
    if top.bid_px is None or top.ask_px is None:
        return None
    return top.ask_px - top.bid_px


def _mid_px(top: _TopState) -> float | int | None:
    if top.bid_px is None or top.ask_px is None:
        return None
    return (top.bid_px + top.ask_px) / 2


def _imbalance(bid_size: float | int | None, ask_size: float | int | None) -> float | None:
    if bid_size is None or ask_size is None:
        return None
    total = bid_size + ask_size
    if total <= 0:
        return None
    return (bid_size - ask_size) / total


def _microprice_offset_ticks(price_top: _TopState, mbo_top: _TopState, tick_size: float) -> float | None:
    bid_px = price_top.bid_px if price_top.bid_px is not None else mbo_top.bid_px
    ask_px = price_top.ask_px if price_top.ask_px is not None else mbo_top.ask_px
    bid_size = mbo_top.bid_size
    ask_size = mbo_top.ask_size
    if bid_px is None or ask_px is None or bid_size is None or ask_size is None:
        return None
    total = bid_size + ask_size
    if total <= 0:
        return None
    mid = (bid_px + ask_px) / 2
    microprice = ((ask_px * bid_size) + (bid_px * ask_size)) / total
    return (microprice - mid) / tick_size


def _depth_imbalance(payload: dict[str, Any] | None, depth_levels: int) -> float | None:
    if payload is None:
        return None
    bid_sum = sum(level["size"] for level in _mbo_levels(payload, "bid")[:depth_levels])
    ask_sum = sum(level["size"] for level in _mbo_levels(payload, "ask")[:depth_levels])
    total = bid_sum + ask_sum
    if total <= 0:
        return None
    return (bid_sum - ask_sum) / total


def _queue_ahead_fraction(payload: dict[str, Any] | None) -> float | None:
    if payload is None or not isinstance(payload.get("queue"), dict):
        return None
    queue = payload["queue"]
    ahead = _finite_number(queue.get("queue_ahead_size_estimate"))
    aggregate = _finite_number(queue.get("level_aggregate_size_subscope"))
    if ahead is None or aggregate is None or aggregate <= 0:
        return None
    return max(0.0, min(1.0, ahead / aggregate))


def _ofi_delta(previous: _TopState | None, current: _TopState) -> float | int | None:
    if previous is None:
        return None
    bid = _side_ofi_delta(previous.bid_px, previous.bid_size, current.bid_px, current.bid_size, side="bid")
    ask = _side_ofi_delta(previous.ask_px, previous.ask_size, current.ask_px, current.ask_size, side="ask")
    if bid is None and ask is None:
        return None
    return (bid or 0) + (ask or 0)


def _side_ofi_delta(
    previous_px: float | int | None,
    previous_size: float | int | None,
    current_px: float | int | None,
    current_size: float | int | None,
    *,
    side: Literal["bid", "ask"],
) -> float | int | None:
    if previous_px is None or previous_size is None or current_px is None or current_size is None:
        return None
    if side == "bid":
        if current_px > previous_px:
            return current_size
        if current_px < previous_px:
            return -previous_size
        return current_size - previous_size
    if current_px < previous_px:
        return -current_size
    if current_px > previous_px:
        return previous_size
    return -(current_size - previous_size)


def _signed_trade_size(payload: dict[str, Any]) -> float | int | None:
    size = _finite_number(payload.get("size") or payload.get("trade_size") or payload.get("last_trade_size"))
    if size is None:
        return None
    raw_side = str(
        payload.get("aggressor_side")
        or payload.get("last_trade_aggressor_side")
        or payload.get("side")
        or ""
    ).lower()
    if raw_side in {"buy", "buyer", "bid", "at_ask"}:
        return size
    if raw_side in {"sell", "seller", "ask", "at_bid"}:
        return -size
    return None


def _trade_aggressor_imbalance(signed_sizes: list[float | int]) -> float | None:
    if not signed_sizes:
        return None
    denominator = sum(abs(value) for value in signed_sizes)
    if denominator <= 0:
        return None
    return sum(signed_sizes) / denominator


def _average(values: list[float | int]) -> float | None:
    if not values:
        return None
    return sum(values) / len(values)


def _source_event_ids(*ids: str | None) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for source_id in ids:
        if source_id is not None and source_id not in seen:
            seen.add(source_id)
            ordered.append(source_id)
    return ordered


def _scalar_values(
    *,
    symbol: str,
    trigger_kind: str,
    spread_points: float | int | None,
    spread_ticks: float | int | None,
    mid_px: float | int | None,
    top_imbalance: float | None,
    microprice_offset_ticks: float | None,
    ofi_short: float | None,
    ofi_medium: float | None,
    ofi_blend: float | None,
    trade_imbalance: float | None,
    depth_imbalance: float | None,
    queue_imbalance: float | None,
    queue_ahead_fraction: float | None,
    feature_tiers: dict[str, FeatureTier],
    blocked_feature_tiers: dict[str, FeatureTier],
) -> dict[str, float | int | str | bool | None]:
    values: dict[str, float | int | str | bool | None] = {
        "microstructure_feature_schema_version": MICROSTRUCTURE_FEATURE_SCHEMA_VERSION,
        "symbol": symbol,
        "source": "microstructure_feature_engine",
        "trigger_kind": trigger_kind,
        "spread_points": spread_points,
        "spread_ticks": spread_ticks,
        "mid_px": mid_px,
        "top_of_book_imbalance": top_imbalance,
        "microprice_offset_ticks": microprice_offset_ticks,
        "ofi_short": ofi_short,
        "ofi_medium": ofi_medium,
        "ofi_blend": ofi_blend,
        "trade_aggressor_imbalance": trade_imbalance,
        "recent_depth_imbalance": depth_imbalance,
        "queue_imbalance": queue_imbalance,
        "queue_ahead_fraction_estimate": queue_ahead_fraction,
        "microstructure_feature_status": DATA04_MICROSTRUCTURE_FEATURE_STATUS,
        "blocked_feature_status": DATA04_BLOCKED_FEATURE_STATUS,
        "mbp10_price_state_status": DATA01B_MBP10_PRICE_STATE_STATUS,
        "mbo_status": DATA01B_MBO_STATUS,
        "mbo_book_state_status": DATA02_MBO_BOOK_STATE_STATUS,
        "queue_position_status": DATA02_MBO_QUEUE_POSITION_STATUS,
        "data01b_full_status": DATA01B_FULL_STATUS,
        "sim_status": "blocked",
        "rel_status": "blocked",
        "blocked_feature_count": len(blocked_feature_tiers),
        **feature_availability_values(),
    }
    for feature, tier in feature_tiers.items():
        values[f"{feature}_tier"] = tier
    for feature, tier in blocked_feature_tiers.items():
        values[f"{feature}_tier"] = tier
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
