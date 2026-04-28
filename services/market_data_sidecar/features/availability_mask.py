"""DATA-03 feature availability mask shared by sidecar payloads."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

FeatureAvailabilityTier = Literal["authoritative", "diagnostic_only", "blocked", "subscope"]

FEATURE_AVAILABILITY_MASK_SCHEMA_VERSION = 1
FEATURE_AVAILABILITY_MASK_VERSION = 1
FEATURE_AVAILABILITY_MASK_ID = "feature-availability-mask-v1-adr0002-infra01e-infra01f"

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
    "mbp10_size_diagnostic": "MBP10 size parity remains diagnostic under ADR-0002.",
    "mbp10_order_count_diagnostic": "MBP10 order-count parity remains diagnostic under ADR-0002.",
    "mbp10_size_summary_diagnostic": "Aggregates diagnostic MBP10 size fields.",
    "mbp10_order_count_summary_diagnostic": "Aggregates diagnostic MBP10 order-count fields.",
    "microprice_size_weighted": "Depends on size semantics that are not hard-gate validated.",
    "top_of_book_size_imbalance": "Depends on size semantics that are not hard-gate validated.",
    "depth_size_imbalance": "Depends on size/depth semantics that are not hard-gate validated.",
    "ofi_size_accumulation": "Depends on size accumulation semantics that are not hard-gate validated.",
    "mbo_trade_unknown_taxonomy": "Databento trade/unknown equivalence remains diagnostic.",
    "queue_position": "Requires DATA-02-MBO/DATA-03/SIM calibration before use.",
    "queue_position_as_fact": "Queue position is an estimate, not a provider-neutral fact.",
    "order_lifetime": "Requires MBO book-state implementation and replay evidence.",
    "cancel_add_ratio": "Requires MBO book-state implementation and replay evidence.",
    "absorption": "Requires DATA-04 feature definition and replay evidence.",
    "sweep": "Requires DATA-04 feature definition and replay evidence.",
    "mbo_derived_features": "Deferred to DATA-04 after DATA-02-MBO and DATA-03.",
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
