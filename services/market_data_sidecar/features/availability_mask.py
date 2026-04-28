"""DATA-03 feature availability mask shared by sidecar payloads."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

FeatureAvailabilityTier = Literal["authoritative", "diagnostic_only", "blocked", "subscope"]

FEATURE_AVAILABILITY_MASK_SCHEMA_VERSION = 1
FEATURE_AVAILABILITY_MASK_VERSION = 3
FEATURE_AVAILABILITY_MASK_ID = "feature-availability-mask-v3-adr0002-infra01e-infra01f-data04"

FIELD_TIERS: dict[str, FeatureAvailabilityTier] = {
    "exchange_event_ts_ns": "authoritative",
    "sidecar_recv_ts_ns": "diagnostic_only",
    "rithmic_publish_ts_ns": "diagnostic_only",
    "l1_quote_bid_px": "authoritative",
    "l1_quote_ask_px": "authoritative",
    "last_trade_price": "authoritative",
    "last_trade_size": "authoritative",
    "last_trade_aggressor_side": "authoritative",
    "mbp10_top_bid_px": "authoritative",
    "mbp10_top_ask_px": "authoritative",
    "mbp10_spread_points": "authoritative",
    "mbp10_spread_ticks": "authoritative",
    "mbp10_mid_px": "authoritative",
    "mbp10_bid_levels_px": "authoritative",
    "mbp10_ask_levels_px": "authoritative",
    "mbp10_price_ladder_summary": "authoritative",
    "mbp10_price_state_freshness": "authoritative",
    "l1_mbp10_top_of_book_consistency": "authoritative",
    "mbo_lifecycle_event": "subscope",
    "mbo_action": "subscope",
    "mbo_side": "subscope",
    "mbo_price": "subscope",
    "mbo_size": "subscope",
    "mbo_order_id": "subscope",
    "mbo_sequence": "subscope",
    "mbo_priority": "subscope",
    "mbo_book_state": "subscope",
    "mbo_top_bid_px": "subscope",
    "mbo_top_ask_px": "subscope",
    "mbo_spread_points": "subscope",
    "mbo_spread_ticks": "subscope",
    "mbo_mid_px": "subscope",
    "mbo_active_order_count": "subscope",
    "mbo_bid_level_count": "subscope",
    "mbo_ask_level_count": "subscope",
    "mbo_level_aggregate_size": "subscope",
    "mbo_level_order_count": "subscope",
    "queue_position_estimate": "subscope",
    "queue_ahead_size_estimate": "subscope",
    "queue_ahead_order_count_estimate": "subscope",
    "microstructure_spread_points": "authoritative",
    "microstructure_spread_ticks": "authoritative",
    "microstructure_mid_px": "authoritative",
    "mbo_top_of_book_size_imbalance": "subscope",
    "mbo_microprice_offset_ticks": "subscope",
    "mbo_ofi_short": "subscope",
    "mbo_ofi_medium": "subscope",
    "mbo_ofi_blend": "subscope",
    "trade_aggressor_imbalance": "authoritative",
    "mbo_recent_depth_imbalance": "subscope",
    "mbo_queue_imbalance": "subscope",
    "queue_ahead_fraction_estimate": "subscope",
    "mbp10_size_diagnostic": "diagnostic_only",
    "mbp10_order_count_diagnostic": "diagnostic_only",
    "mbp10_size_summary_diagnostic": "diagnostic_only",
    "mbp10_order_count_summary_diagnostic": "diagnostic_only",
    "microprice_size_weighted": "diagnostic_only",
    "top_of_book_size_imbalance": "diagnostic_only",
    "depth_size_imbalance": "diagnostic_only",
    "ofi_size_accumulation": "diagnostic_only",
    "mbo_trade_unknown_taxonomy": "diagnostic_only",
    "queue_position": "blocked",
    "queue_position_as_fact": "blocked",
    "order_lifetime": "blocked",
    "cancel_add_ratio": "blocked",
    "absorption": "blocked",
    "sweep": "blocked",
    "mbo_derived_features": "blocked",
    "ml_research_features": "blocked",
    "sim_fill_calibration": "blocked",
    "rel_replay_gate": "blocked",
}

RATIONALE: dict[str, str] = {
    "exchange_event_ts_ns": "ADR-0001 canonical event time.",
    "sidecar_recv_ts_ns": "Receive-time telemetry only; never canonical for replay or labels.",
    "rithmic_publish_ts_ns": "Provider publish-time telemetry only.",
    "l1_quote_bid_px": "DATA-01A reconstructed L1 BBO price field.",
    "l1_quote_ask_px": "DATA-01A reconstructed L1 BBO price field.",
    "last_trade_price": "DATA-01A normalized trade field.",
    "last_trade_size": "DATA-01A normalized trade field.",
    "last_trade_aggressor_side": "DATA-01A normalized trade field.",
    "mbp10_top_bid_px": "ADR-0002 accepts MBP10 price-state sub-scope.",
    "mbp10_top_ask_px": "ADR-0002 accepts MBP10 price-state sub-scope.",
    "mbp10_spread_points": "Derived only from accepted MBP10 price-state.",
    "mbp10_spread_ticks": "Derived only from accepted MBP10 price-state.",
    "mbp10_mid_px": "Derived only from accepted MBP10 price-state.",
    "mbp10_bid_levels_px": "ADR-0002 accepts MBP10 price ladder prices.",
    "mbp10_ask_levels_px": "ADR-0002 accepts MBP10 price ladder prices.",
    "mbp10_price_ladder_summary": "Derived only from accepted price ladder spacing.",
    "mbp10_price_state_freshness": "Uses exchange-event-time gaps over accepted MBP10 price-state.",
    "l1_mbp10_top_of_book_consistency": "Compares two accepted price-state surfaces.",
    "mbo_lifecycle_event": "INFRA-01F accepts provider-internal MBO lifecycle sub-scope.",
    "mbo_action": "INFRA-01F provider-internal MBO sub-scope.",
    "mbo_side": "INFRA-01F provider-internal MBO sub-scope.",
    "mbo_price": "INFRA-01F provider-internal MBO sub-scope.",
    "mbo_size": "INFRA-01F provider-internal MBO sub-scope.",
    "mbo_order_id": "INFRA-01F provider-internal MBO sub-scope.",
    "mbo_sequence": "INFRA-01F provider-internal MBO sub-scope.",
    "mbo_priority": "INFRA-01F provider-internal MBO sub-scope.",
    "mbo_book_state": "DATA-02-MBO provider-internal book state built from accepted MBO lifecycle events.",
    "mbo_top_bid_px": "DATA-02-MBO top bid derived from provider-internal MBO book state.",
    "mbo_top_ask_px": "DATA-02-MBO top ask derived from provider-internal MBO book state.",
    "mbo_spread_points": "DATA-02-MBO spread derived from provider-internal MBO book state.",
    "mbo_spread_ticks": "DATA-02-MBO spread-tick count derived from provider-internal MBO book state.",
    "mbo_mid_px": "DATA-02-MBO midprice derived from provider-internal MBO book state.",
    "mbo_active_order_count": "DATA-02-MBO provider-internal active order count.",
    "mbo_bid_level_count": "DATA-02-MBO provider-internal bid price-level count.",
    "mbo_ask_level_count": "DATA-02-MBO provider-internal ask price-level count.",
    "mbo_level_aggregate_size": "DATA-02-MBO provider-internal aggregate level size.",
    "mbo_level_order_count": "DATA-02-MBO provider-internal order count by price level.",
    "queue_position_estimate": "DATA-02-MBO FIFO queue-position estimate within one provider feed.",
    "queue_ahead_size_estimate": "DATA-02-MBO provider-internal quantity ahead of the order at its price.",
    "queue_ahead_order_count_estimate": "DATA-02-MBO provider-internal order count ahead of the order.",
    "microstructure_spread_points": "DATA-04 derived spread from authoritative MBP10 price-state.",
    "microstructure_spread_ticks": "DATA-04 derived spread ticks from authoritative MBP10 price-state.",
    "microstructure_mid_px": "DATA-04 derived midprice from authoritative MBP10 price-state.",
    "mbo_top_of_book_size_imbalance": "DATA-04 provider-internal size imbalance derived from DATA-02-MBO.",
    "mbo_microprice_offset_ticks": "DATA-04 provider-internal microprice offset derived from DATA-02-MBO size and price state.",
    "mbo_ofi_short": "DATA-04 provider-internal short-window order-flow imbalance estimate.",
    "mbo_ofi_medium": "DATA-04 provider-internal medium-window order-flow imbalance estimate.",
    "mbo_ofi_blend": "DATA-04 provider-internal blended order-flow imbalance estimate.",
    "trade_aggressor_imbalance": "DATA-04 derived from DATA-01A normalized trade side and size.",
    "mbo_recent_depth_imbalance": "DATA-04 provider-internal recent depth imbalance derived from DATA-02-MBO levels.",
    "mbo_queue_imbalance": "DATA-04 provider-internal queue-position estimate transformed into an imbalance-style signal.",
    "queue_ahead_fraction_estimate": "DATA-04 provider-internal queue-ahead fraction, not a provider-neutral queue fact.",
    "mbp10_size_diagnostic": "MBP10 size parity remains diagnostic under ADR-0002.",
    "mbp10_order_count_diagnostic": "MBP10 order-count parity remains diagnostic under ADR-0002.",
    "mbp10_size_summary_diagnostic": "Aggregates diagnostic MBP10 size fields.",
    "mbp10_order_count_summary_diagnostic": "Aggregates diagnostic MBP10 order-count fields.",
    "microprice_size_weighted": "Depends on size semantics that are not hard-gate validated.",
    "top_of_book_size_imbalance": "Depends on size semantics that are not hard-gate validated.",
    "depth_size_imbalance": "Depends on size/depth semantics that are not hard-gate validated.",
    "ofi_size_accumulation": "Depends on size accumulation semantics that are not hard-gate validated.",
    "mbo_trade_unknown_taxonomy": "Databento trade/unknown equivalence remains diagnostic.",
    "queue_position": "Generic queue position as a hard trading fact remains blocked; use queue_position_estimate for provider-internal diagnostics.",
    "queue_position_as_fact": "Queue position is an estimate, not a provider-neutral fact.",
    "order_lifetime": "Requires MBO book-state implementation and replay evidence.",
    "cancel_add_ratio": "Requires MBO book-state implementation and replay evidence.",
    "absorption": "Requires DATA-04 feature definition and replay evidence.",
    "sweep": "Requires DATA-04 feature definition and replay evidence.",
    "mbo_derived_features": "DATA-04 emits only provider-internal sub-scope features; strict cross-feed feature equivalence is still not claimed.",
    "ml_research_features": "Blocked until RSRCH gates and calibrated replay evidence.",
    "sim_fill_calibration": "Blocked until SIM-02/SIM-03 implementation and calibration.",
    "rel_replay_gate": "Blocked until provider-internal replay evidence exists.",
}


def build_feature_availability_mask() -> dict[str, Any]:
    core: dict[str, Any] = {
        "schema_version": FEATURE_AVAILABILITY_MASK_SCHEMA_VERSION,
        "mask_version": FEATURE_AVAILABILITY_MASK_VERSION,
        "mask_id": FEATURE_AVAILABILITY_MASK_ID,
        "lineage": {
            "adr": "ADR-0002",
            "infra01e": "MBP10_PRICE_STATE_ACCEPTED_SUBSCOPE",
            "infra01f": "MBO_PROVIDER_INTERNAL_ACCEPTED_SUBSCOPE",
            "data01b_full_status": "blocked",
            "data01_full_status": "blocked",
        },
        "field_tiers": FIELD_TIERS,
        "rationale": RATIONALE,
    }
    return {**core, "mask_hash": _hash_mask_core(core)}


def feature_availability_values() -> dict[str, int | str]:
    return {
        "feature_availability_mask_version": FEATURE_AVAILABILITY_MASK_VERSION,
        "feature_availability_mask_id": FEATURE_AVAILABILITY_MASK_ID,
        "feature_availability_mask_hash": FEATURE_AVAILABILITY_MASK["mask_hash"],
    }


def tier_of(mask: dict[str, Any], field: str) -> FeatureAvailabilityTier:
    return mask["field_tiers"][field]


def assert_authoritative(mask: dict[str, Any], field: str) -> None:
    tier = tier_of(mask, field)
    if tier != "authoritative":
        raise ValueError(f"Feature field {field} is {tier}, not authoritative")


def _hash_mask_core(core: dict[str, Any]) -> str:
    payload = json.dumps(core, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


FEATURE_AVAILABILITY_MASK = build_feature_availability_mask()
