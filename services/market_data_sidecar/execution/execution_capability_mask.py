"""ADR-0018 execution capability mask mirror for cross-language parity."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

ExecutionCapability = Literal[
    "order_plant_paper",
    "order_plant_live",
    "pnl_plant",
    "history_plant",
    "submit",
    "cancel_replace",
    "flatten",
    "ack_measurement",
    "ack_enforcement",
    "killswitch_armed",
    "killswitch_tripped",
]

ExecutionUseContext = Literal[
    "session_startup",
    "preload",
    "connection_open",
    "paper_order_submit",
    "live_order_submit",
    "cancel_replace",
    "ack_reconcile",
    "operator_display",
    "blocked_diagnostic_count",
]

ExecutionCapabilityTier = Literal[
    "enabled",
    "enabled_with_live_mode_only",
    "enabled_with_vault_evidence",
    "enabled_with_health_gates_satisfied",
    "blocked",
]

ExecutionScopingSurface = Literal[
    "global",
    "account",
    "venue",
    "symbol_allowlist",
    "strategy_allowlist",
]

ExecutionHealthGate = Literal[
    "connectivity_auth_health",
    "plant_health",
    "heartbeat_freshness",
    "account_resolution_readiness",
    "symbol_entitlement_readiness",
    "killswitch_clear",
]

ExecutionCapabilityDecisionReason = Literal[
    "allowed",
    "unknown_capability",
    "unknown_use_context",
    "unknown_scoping_surface",
    "unknown_health_gate",
    "unknown_tier",
    "blocked_capability",
    "wrong_session_mode",
    "requires_vault_evidence",
    "missing_health_gate",
    "unsupported_caller_pattern",
]

EXECUTION_CAPABILITY_MASK_SCHEMA_VERSION = 1
EXECUTION_CAPABILITY_MASK_VERSION = 1
EXECUTION_CAPABILITY_MASK_ID = (
    "execution-capability-mask-v1-adr0018-paper-only-order-plant"
)

EXECUTION_CAPABILITIES: list[ExecutionCapability] = [
    "order_plant_paper",
    "order_plant_live",
    "pnl_plant",
    "history_plant",
    "submit",
    "cancel_replace",
    "flatten",
    "ack_measurement",
    "ack_enforcement",
    "killswitch_armed",
    "killswitch_tripped",
]

EXECUTION_USE_CONTEXTS: list[ExecutionUseContext] = [
    "session_startup",
    "preload",
    "connection_open",
    "paper_order_submit",
    "live_order_submit",
    "cancel_replace",
    "ack_reconcile",
    "operator_display",
    "blocked_diagnostic_count",
]

EXECUTION_CAPABILITY_TIERS: list[ExecutionCapabilityTier] = [
    "enabled",
    "enabled_with_live_mode_only",
    "enabled_with_vault_evidence",
    "enabled_with_health_gates_satisfied",
    "blocked",
]

EXECUTION_SCOPING_SURFACES: list[ExecutionScopingSurface] = [
    "global",
    "account",
    "venue",
    "symbol_allowlist",
    "strategy_allowlist",
]

EXECUTION_HEALTH_GATES: list[ExecutionHealthGate] = [
    "connectivity_auth_health",
    "plant_health",
    "heartbeat_freshness",
    "account_resolution_readiness",
    "symbol_entitlement_readiness",
    "killswitch_clear",
]

EXECUTION_CAPABILITY_DECISION_REASONS: list[ExecutionCapabilityDecisionReason] = [
    "allowed",
    "unknown_capability",
    "unknown_use_context",
    "unknown_scoping_surface",
    "unknown_health_gate",
    "unknown_tier",
    "blocked_capability",
    "wrong_session_mode",
    "requires_vault_evidence",
    "missing_health_gate",
    "unsupported_caller_pattern",
]

EXECUTION_CAPABILITY_BINDINGS: dict[
    ExecutionCapability, dict[str, ExecutionCapabilityTier]
] = {
    "order_plant_paper": {"paper": "enabled", "live": "enabled"},
    "order_plant_live": {
        "paper": "blocked",
        "live": "enabled_with_vault_evidence",
    },
    "pnl_plant": {"paper": "blocked", "live": "enabled"},
    "history_plant": {"paper": "blocked", "live": "blocked"},
    "submit": {
        "paper": "enabled",
        "live": "enabled_with_health_gates_satisfied",
    },
    "cancel_replace": {
        "paper": "enabled",
        "live": "enabled_with_health_gates_satisfied",
    },
    "flatten": {
        "paper": "enabled",
        "live": "enabled_with_health_gates_satisfied",
    },
    "ack_measurement": {"paper": "enabled", "live": "enabled"},
    "ack_enforcement": {"paper": "blocked", "live": "enabled"},
    "killswitch_armed": {"paper": "enabled", "live": "enabled"},
    "killswitch_tripped": {"paper": "blocked", "live": "blocked"},
}

REQUIRED_EXECUTION_HEALTH_GATES_BY_CAPABILITY: dict[
    ExecutionCapability, list[ExecutionHealthGate]
] = {
    "submit": EXECUTION_HEALTH_GATES,
    "cancel_replace": EXECUTION_HEALTH_GATES,
    "flatten": EXECUTION_HEALTH_GATES,
}


def build_execution_capability_mask() -> dict[str, Any]:
    core: dict[str, Any] = {
        "schema_version": EXECUTION_CAPABILITY_MASK_SCHEMA_VERSION,
        "mask_version": EXECUTION_CAPABILITY_MASK_VERSION,
        "mask_id": EXECUTION_CAPABILITY_MASK_ID,
        "capabilities": EXECUTION_CAPABILITIES,
        "use_contexts": EXECUTION_USE_CONTEXTS,
        "capability_tiers": EXECUTION_CAPABILITY_TIERS,
        "scoping_surfaces": EXECUTION_SCOPING_SURFACES,
        "health_gates": EXECUTION_HEALTH_GATES,
        "decision_reasons": EXECUTION_CAPABILITY_DECISION_REASONS,
        "binding_table": EXECUTION_CAPABILITY_BINDINGS,
        "required_health_gates_by_capability": REQUIRED_EXECUTION_HEALTH_GATES_BY_CAPABILITY,
    }
    return {**core, "mask_hash": _hash_execution_capability_mask_core(core)}


def execution_capability_values() -> dict[str, int | str]:
    return {
        "execution_mask_version": EXECUTION_CAPABILITY_MASK_VERSION,
        "execution_mask_id": EXECUTION_CAPABILITY_MASK_ID,
        "execution_mask_hash": EXECUTION_CAPABILITY_MASK["mask_hash"],
    }


def tier_of_execution_capability(
    mask: dict[str, Any],
    capability: ExecutionCapability,
    session_mode: Literal["paper", "live"],
) -> ExecutionCapabilityTier:
    return mask["binding_table"][capability][session_mode]


def _hash_execution_capability_mask_core(core: dict[str, Any]) -> str:
    payload = json.dumps(core, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


EXECUTION_CAPABILITY_MASK = build_execution_capability_mask()


if __name__ == "__main__":
    print(
        json.dumps(
            build_execution_capability_mask(),
            sort_keys=True,
            separators=(",", ":"),
        )
    )
