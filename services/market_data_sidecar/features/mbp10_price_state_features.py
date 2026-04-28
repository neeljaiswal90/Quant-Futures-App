"""DATA-02-PS MBP10 price-state feature snapshots.

This module consumes the accepted DATA-01B-PS price-state sub-scope only. It derives
price-state features from reconstructed MBP10 prices while keeping size/order-count fields
diagnostic. INFRA-01F accepts MBO as a separate provider-internal sub-scope; this feature
builder still does not consume MBO or queue features.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from services.market_data_sidecar.book.mbp10_price_state import (
    Mbp10PriceStateReconstructor,
)
from services.market_data_sidecar.config import (
    DATA01B_FULL_STATUS,
    DATA01B_MBO_SUBSCOPE_REASON,
    DATA01B_MBO_STATUS,
    DATA01B_MBP10_PRICE_STATE_STATUS,
    DATA01B_SIZE_ORDER_COUNT_STATUS,
)
from services.market_data_sidecar.providers.rithmic_live import (
    NormalizationDiagnostic,
    RithmicL1TradeNormalizer,
)
from services.market_data_sidecar.publish.event_journal import make_source_event_envelope

FEATURE_SCHEMA_VERSION = 1
MAX_RECORDED_DIAGNOSTICS = 100
DEFAULT_TICK_SIZE = 0.25
DEFAULT_STALE_THRESHOLD_MS = 1_000


@dataclass(frozen=True)
class PriceLevelInput:
    px: float | int
    size_diagnostic: float | int | None = None
    order_count_diagnostic: int | None = None


@dataclass(frozen=True)
class L1TopOfBook:
    bid_px: float | int
    ask_px: float | int


@dataclass(frozen=True)
class Mbp10PriceStateFeatureReport:
    input_rows: int
    emitted_feature_snapshots: int
    invalid_feature_snapshots: int
    skipped_mbo_rows: int
    skipped_non_price_state_rows: int
    diagnostic_count: int
    diagnostic_counts: dict[str, int]
    diagnostics: list[dict[str, Any]]
    diagnostics_truncated: bool
    feature_schema_version: int
    mbp10_price_state_status: str
    mbo_status: str
    size_order_count_status: str
    data01b_full_status: str
    l2_l3_scope: str
    mbo_features_available: bool


class Mbp10PriceStateFeatureBuilder:
    """Builds deterministic MBP10 price-state feature payloads."""

    def __init__(
        self,
        *,
        symbol: str,
        tick_size: float = DEFAULT_TICK_SIZE,
        stale_threshold_ms: int = DEFAULT_STALE_THRESHOLD_MS,
    ) -> None:
        if tick_size <= 0:
            raise ValueError("tick_size must be positive")
        if stale_threshold_ms < 0:
            raise ValueError("stale_threshold_ms must be non-negative")

        self._symbol = symbol
        self._tick_size = tick_size
        self._stale_threshold_ns = stale_threshold_ms * 1_000_000
        self._last_mbp10_ts_ns: int | None = None
        self._latest_l1: L1TopOfBook | None = None

    def update_l1(self, payload: dict[str, Any]) -> bool:
        bid_px = _finite_number(payload.get("bid_px"))
        ask_px = _finite_number(payload.get("ask_px"))
        if bid_px is None or ask_px is None:
            return False
        self._latest_l1 = L1TopOfBook(bid_px=bid_px, ask_px=ask_px)
        return True

    def build_payload(
        self,
        *,
        price_state_payload: dict[str, Any],
        feature_snapshot_id: str,
    ) -> dict[str, Any]:
        exchange_ts_ns = _decimal_ns(price_state_payload.get("exchange_event_ts_ns"))
        sidecar_recv_ts_ns = _decimal_ns(price_state_payload.get("sidecar_recv_ts_ns"))
        if exchange_ts_ns is None:
            raise ValueError("price-state payload missing exchange_event_ts_ns")
        if sidecar_recv_ts_ns is None:
            raise ValueError("price-state payload missing sidecar_recv_ts_ns")

        current_ts = int(exchange_ts_ns)
        previous_ts = self._last_mbp10_ts_ns
        stale_mbp10_state = (
            previous_ts is not None and current_ts - previous_ts > self._stale_threshold_ns
        )
        self._last_mbp10_ts_ns = current_ts

        bids = _extract_levels(price_state_payload.get("bids"))
        asks = _extract_levels(price_state_payload.get("asks"))
        top_bid = bids[0].px if bids else None
        top_ask = asks[0].px if asks else None
        has_complete_top_of_book = top_bid is not None and top_ask is not None
        spread_points = top_ask - top_bid if has_complete_top_of_book else None
        spread_ticks = spread_points / self._tick_size if spread_points is not None else None
        mid_px = (top_bid + top_ask) / 2 if has_complete_top_of_book else None
        spread_valid = spread_points is not None and spread_points >= 0
        price_ladder_valid = _strictly_sorted([level.px for level in bids], reverse=True) and (
            _strictly_sorted([level.px for level in asks], reverse=False)
        )

        l1_consistency = _l1_consistency(self._latest_l1, top_bid, top_ask, self._tick_size)
        values = _scalar_values(
            symbol=self._symbol,
            top_bid=top_bid,
            top_ask=top_ask,
            spread_points=spread_points,
            spread_ticks=spread_ticks,
            mid_px=mid_px,
            bids=bids,
            asks=asks,
            stale_mbp10_state=stale_mbp10_state,
            freshness_status="stale" if stale_mbp10_state else "fresh",
            has_complete_top_of_book=has_complete_top_of_book,
            spread_valid=spread_valid,
            price_ladder_valid=price_ladder_valid,
            l1_consistency=l1_consistency,
        )

        payload: dict[str, Any] = {
            "feature_schema_version": FEATURE_SCHEMA_VERSION,
            "feature_snapshot_id": feature_snapshot_id,
            "exchange_event_ts_ns": exchange_ts_ns,
            "sidecar_recv_ts_ns": sidecar_recv_ts_ns,
            "symbol": self._symbol,
            "source": "mbp10_price_state",
            "l3_authority": "unavailable",
            "top_bid_px": top_bid,
            "top_ask_px": top_ask,
            "spread_points": spread_points,
            "spread_ticks": spread_ticks,
            "mid_px": mid_px,
            "bid_levels_px": [level.px for level in bids],
            "ask_levels_px": [level.px for level in asks],
            "price_ladder_summary": _price_ladder_summary(bids, asks, mid_px),
            "freshness_status": "stale" if stale_mbp10_state else "fresh",
            "validity": {
                "has_complete_top_of_book": has_complete_top_of_book,
                "spread_valid": spread_valid,
                "price_ladder_valid": price_ladder_valid,
                "stale_mbp10_state": stale_mbp10_state,
                "l2_l3_scope": "price_state_only",
                "mbo_features_available": False,
            },
            "diagnostic": _diagnostic_summary(bids, asks),
            "l1_mbp10_consistency": l1_consistency,
            "values": values,
            "mbp10_price_state_status": DATA01B_MBP10_PRICE_STATE_STATUS,
            "mbo_status": DATA01B_MBO_STATUS,
            "size_order_count_status": DATA01B_SIZE_ORDER_COUNT_STATUS,
            "data01b_full_status": DATA01B_FULL_STATUS,
        }
        rithmic_publish_ts_ns = _decimal_ns(price_state_payload.get("rithmic_publish_ts_ns"))
        if rithmic_publish_ts_ns is not None:
            payload["rithmic_publish_ts_ns"] = rithmic_publish_ts_ns
        return payload


def build_mbp10_price_state_feature_journal(
    *,
    input_path: Path,
    output_path: Path,
    run_id: str,
    session_id: str,
    symbol: str,
    tick_size: float = DEFAULT_TICK_SIZE,
    stale_threshold_ms: int = DEFAULT_STALE_THRESHOLD_MS,
) -> Mbp10PriceStateFeatureReport:
    builder = Mbp10PriceStateFeatureBuilder(
        symbol=symbol,
        tick_size=tick_size,
        stale_threshold_ms=stale_threshold_ms,
    )
    mbp10_reconstructor = Mbp10PriceStateReconstructor()
    l1_normalizer = RithmicL1TradeNormalizer()
    diagnostics: list[NormalizationDiagnostic] = []
    diagnostic_counts: dict[str, int] = {}
    diagnostic_count = 0
    input_rows = 0
    emitted = 0
    invalid = 0
    skipped_mbo_rows = 0
    skipped_non_price_state_rows = 0

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
                continue

            price_state_payload, source_event_id, diagnostic = _price_state_payload_from_row(
                row,
                line_number=line_number,
                mbp10_reconstructor=mbp10_reconstructor,
                l1_normalizer=l1_normalizer,
                builder=builder,
            )
            if diagnostic is not None:
                diagnostic_count = _record_diagnostic(
                    diagnostics,
                    diagnostic_counts,
                    diagnostic_count,
                    diagnostic,
                )
                if diagnostic.reason == DATA01B_MBO_SUBSCOPE_REASON:
                    skipped_mbo_rows += 1
                else:
                    skipped_non_price_state_rows += 1
                continue

            if price_state_payload is None:
                skipped_non_price_state_rows += 1
                continue

            sequence = emitted + 1
            feature_snapshot_id = f"mbp10-price-state-features-{run_id}-{sequence:012d}"
            try:
                payload = builder.build_payload(
                    price_state_payload=price_state_payload,
                    feature_snapshot_id=feature_snapshot_id,
                )
            except ValueError as exc:
                diagnostic_count = _record_diagnostic(
                    diagnostics,
                    diagnostic_counts,
                    diagnostic_count,
                    NormalizationDiagnostic(line_number, "MBP10", str(exc)),
                )
                continue

            if not payload["validity"]["has_complete_top_of_book"]:
                invalid += 1

            event_id = f"mbp10-price-state-features-{run_id}-{sequence:012d}"
            envelope = make_source_event_envelope(
                event_id=event_id,
                event_type="MICROSTRUCTURE",
                ts_ns=payload["exchange_event_ts_ns"],
                run_id=run_id,
                session_id=session_id,
                payload={**payload, **({"source_event_id": source_event_id} if source_event_id else {})},
                causation_id=source_event_id,
            )
            output.write(json.dumps(envelope, sort_keys=True, separators=(",", ":")))
            output.write("\n")
            emitted += 1

    return Mbp10PriceStateFeatureReport(
        input_rows=input_rows,
        emitted_feature_snapshots=emitted,
        invalid_feature_snapshots=invalid,
        skipped_mbo_rows=skipped_mbo_rows,
        skipped_non_price_state_rows=skipped_non_price_state_rows,
        diagnostic_count=diagnostic_count,
        diagnostic_counts=dict(sorted(diagnostic_counts.items())),
        diagnostics=[asdict(diagnostic) for diagnostic in diagnostics],
        diagnostics_truncated=diagnostic_count > len(diagnostics),
        feature_schema_version=FEATURE_SCHEMA_VERSION,
        mbp10_price_state_status=DATA01B_MBP10_PRICE_STATE_STATUS,
        mbo_status=DATA01B_MBO_STATUS,
        size_order_count_status=DATA01B_SIZE_ORDER_COUNT_STATUS,
        data01b_full_status=DATA01B_FULL_STATUS,
        l2_l3_scope="price_state_only",
        mbo_features_available=False,
    )


def _price_state_payload_from_row(
    row: dict[str, Any],
    *,
    line_number: int,
    mbp10_reconstructor: Mbp10PriceStateReconstructor,
    l1_normalizer: RithmicL1TradeNormalizer,
    builder: Mbp10PriceStateFeatureBuilder,
) -> tuple[dict[str, Any] | None, str | None, NormalizationDiagnostic | None]:
    event_type = row.get("type")
    if event_type == "QUOTE" and isinstance(row.get("payload"), dict):
        builder.update_l1(row["payload"])
        return None, None, None
    if event_type == "MICROSTRUCTURE" and isinstance(row.get("payload"), dict):
        payload = row["payload"]
        if payload.get("source") == "mbp10_price_state" or payload.get(
            "mbp10_price_state_status"
        ) == DATA01B_MBP10_PRICE_STATE_STATUS:
            source_event_id = row.get("event_id")
            return payload, str(source_event_id) if isinstance(source_event_id, str) else None, None
        return None, None, NormalizationDiagnostic(
            line_number,
            "MICROSTRUCTURE",
            "non_mbp10_price_state_microstructure",
        )

    stream = str(row.get("stream") or row.get("stream_id") or "")
    if stream == "L1_QUOTE":
        normalized, diagnostic = l1_normalizer.normalize_row(row, line_number=line_number)
        if normalized is not None and normalized.event_type == "QUOTE":
            builder.update_l1(normalized.payload)
        return None, None, diagnostic
    if stream == "MBO":
        return None, None, NormalizationDiagnostic(line_number, stream, DATA01B_MBO_SUBSCOPE_REASON)
    if stream == "MBP10":
        normalized, diagnostic = mbp10_reconstructor.normalize_row(row, line_number=line_number)
        if diagnostic is not None:
            return None, None, diagnostic
        if normalized is None:
            return None, None, None
        return normalized.payload, None, None
    return None, None, NormalizationDiagnostic(
        line_number,
        stream or str(event_type or "missing"),
        "unsupported_price_state_feature_input",
    )


def _scalar_values(
    *,
    symbol: str,
    top_bid: float | int | None,
    top_ask: float | int | None,
    spread_points: float | int | None,
    spread_ticks: float | int | None,
    mid_px: float | int | None,
    bids: list[PriceLevelInput],
    asks: list[PriceLevelInput],
    stale_mbp10_state: bool,
    freshness_status: str,
    has_complete_top_of_book: bool,
    spread_valid: bool,
    price_ladder_valid: bool,
    l1_consistency: dict[str, bool | float | int | None | str],
) -> dict[str, float | int | str | bool | None]:
    summary = _price_ladder_summary(bids, asks, mid_px)
    diagnostics = _diagnostic_summary(bids, asks)
    values: dict[str, float | int | str | bool | None] = {
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "symbol": symbol,
        "source": "mbp10_price_state",
        "top_bid_px": top_bid,
        "top_ask_px": top_ask,
        "spread_points": spread_points,
        "spread_ticks": spread_ticks,
        "mid_px": mid_px,
        "has_complete_top_of_book": has_complete_top_of_book,
        "spread_valid": spread_valid,
        "price_ladder_valid": price_ladder_valid,
        "stale_mbp10_state": stale_mbp10_state,
        "freshness_status": freshness_status,
        "l2_l3_scope": "price_state_only",
        "mbo_features_available": False,
        "mbp10_price_state_status": DATA01B_MBP10_PRICE_STATE_STATUS,
        "mbo_status": DATA01B_MBO_STATUS,
        "size_order_count_status": DATA01B_SIZE_ORDER_COUNT_STATUS,
        "data01b_full_status": DATA01B_FULL_STATUS,
        **summary,
        **diagnostics,
        **l1_consistency,
    }
    for side, levels in (("bid", bids), ("ask", asks)):
        for index, level in enumerate(levels):
            suffix = f"{index:02d}"
            values[f"{side}_level_px_{suffix}"] = level.px
            values[f"{side}_size_diagnostic_{suffix}"] = level.size_diagnostic
            values[f"{side}_order_count_diagnostic_{suffix}"] = level.order_count_diagnostic
    return values


def _extract_levels(value: Any) -> list[PriceLevelInput]:
    if not isinstance(value, list):
        return []
    levels: list[PriceLevelInput] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        px = _finite_number(item.get("px"))
        if px is None:
            continue
        levels.append(
            PriceLevelInput(
                px=px,
                size_diagnostic=_finite_number(item.get("size_diagnostic")),
                order_count_diagnostic=_finite_int(item.get("order_count_diagnostic")),
            )
        )
    return levels


def _price_ladder_summary(
    bids: list[PriceLevelInput],
    asks: list[PriceLevelInput],
    mid_px: float | int | None,
) -> dict[str, float | int | None]:
    bid_spacings = _adjacent_spacings([level.px for level in bids])
    ask_spacings = _adjacent_spacings([level.px for level in asks])
    top_bid = bids[0].px if bids else None
    top_ask = asks[0].px if asks else None
    return {
        "bid_level_count": len(bids),
        "ask_level_count": len(asks),
        "bid_min_px": min((level.px for level in bids), default=None),
        "bid_max_px": max((level.px for level in bids), default=None),
        "ask_min_px": min((level.px for level in asks), default=None),
        "ask_max_px": max((level.px for level in asks), default=None),
        "bid_nearest_level_gap_points": bid_spacings[0] if bid_spacings else None,
        "ask_nearest_level_gap_points": ask_spacings[0] if ask_spacings else None,
        "bid_avg_spacing_points": _average(bid_spacings),
        "ask_avg_spacing_points": _average(ask_spacings),
        "mid_to_nearest_bid_points": mid_px - top_bid
        if mid_px is not None and top_bid is not None
        else None,
        "mid_to_nearest_ask_points": top_ask - mid_px
        if mid_px is not None and top_ask is not None
        else None,
    }


def _diagnostic_summary(
    bids: list[PriceLevelInput],
    asks: list[PriceLevelInput],
) -> dict[str, float | int | None]:
    bid_sizes = [level.size_diagnostic for level in bids if level.size_diagnostic is not None]
    ask_sizes = [level.size_diagnostic for level in asks if level.size_diagnostic is not None]
    bid_counts = [
        level.order_count_diagnostic
        for level in bids
        if level.order_count_diagnostic is not None
    ]
    ask_counts = [
        level.order_count_diagnostic
        for level in asks
        if level.order_count_diagnostic is not None
    ]
    return {
        "bid_size_diagnostic_sum": sum(bid_sizes) if bid_sizes else None,
        "ask_size_diagnostic_sum": sum(ask_sizes) if ask_sizes else None,
        "bid_order_count_diagnostic_sum": sum(bid_counts) if bid_counts else None,
        "ask_order_count_diagnostic_sum": sum(ask_counts) if ask_counts else None,
    }


def _l1_consistency(
    latest_l1: L1TopOfBook | None,
    top_bid: float | int | None,
    top_ask: float | int | None,
    tick_size: float,
) -> dict[str, bool | float | int | None | str]:
    if latest_l1 is None:
        return {
            "l1_mbp10_consistency_status": "unavailable",
            "l1_bid_px": None,
            "l1_ask_px": None,
            "l1_mbp10_bid_delta_ticks": None,
            "l1_mbp10_ask_delta_ticks": None,
            "l1_mbp10_top_bid_within_1_tick": None,
            "l1_mbp10_top_ask_within_1_tick": None,
        }
    bid_delta_ticks = (
        abs(latest_l1.bid_px - top_bid) / tick_size if top_bid is not None else None
    )
    ask_delta_ticks = (
        abs(latest_l1.ask_px - top_ask) / tick_size if top_ask is not None else None
    )
    bid_match = bid_delta_ticks is not None and bid_delta_ticks <= 1
    ask_match = ask_delta_ticks is not None and ask_delta_ticks <= 1
    return {
        "l1_mbp10_consistency_status": "available",
        "l1_bid_px": latest_l1.bid_px,
        "l1_ask_px": latest_l1.ask_px,
        "l1_mbp10_bid_delta_ticks": bid_delta_ticks,
        "l1_mbp10_ask_delta_ticks": ask_delta_ticks,
        "l1_mbp10_top_bid_within_1_tick": bid_match,
        "l1_mbp10_top_ask_within_1_tick": ask_match,
    }


def _adjacent_spacings(levels: list[float | int]) -> list[float | int]:
    return [abs(levels[index] - levels[index + 1]) for index in range(len(levels) - 1)]


def _strictly_sorted(values: list[float | int], *, reverse: bool) -> bool:
    if len(values) < 2:
        return True
    pairs = zip(values, values[1:])
    if reverse:
        return all(left > right for left, right in pairs)
    return all(left < right for left, right in pairs)


def _average(values: list[float | int]) -> float | int | None:
    if not values:
        return None
    return sum(values) / len(values)


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


def _finite_int(value: Any) -> int | None:
    parsed = _finite_number(value)
    if parsed is None or not isinstance(parsed, int):
        return None
    return parsed
