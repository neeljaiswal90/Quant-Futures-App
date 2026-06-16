# QFA-612-BROKER-SIDECAR-RPROTOCOL-ORDER-PLANT-REPAIR-01

## Determination

```text
BROKER_SIDECAR_RPROTOCOL_ORDER_PLANT_REPAIR_READY_RUNTIME_START_BLOCKED_OUTSIDE_RTH
```

## Result

ORDER_PLANT sidecar repair is now boot-ready through the explicit order-placement gateway alias. The runtime start remains blocked by session time only.

```text
RITHMIC_TEST_GATEWAY_URL_present = true
allowlist_count = 1
sidecar_boot_identity = PASS
authenticated_plants = ORDER_PLANT
preflight_blocked_gate = rth_gate
session_phase = eth
session_id = 2026-06-16-eth
block_reason = outside_rth
```

## Authority boundary

```text
capture_credentials_touched = false
submit_order_executed = false
cancel_order_executed = false
paper_runtime_started = false
production_account_used = false
live_trading_authority_created = false
phase_6_authority_created = false
roster_mutated = false
net_position_exposure_created = false
```

## Next action

```text
Repeat --preflight-only during next RTH, then start the bounded paper runtime if gates are green. Do not use --allow-preopen for this RTH-only launch.
```
