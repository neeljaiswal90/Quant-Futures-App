# QFA-612 PAPER ORDER_PLANT inactive-account gate

**Ticket**: QFA-612-PAPER-ORDER-PLANT-INACTIVE-ACCOUNT-GATE-01

## Determination

`ORDER_PLANT_AUTH_READY_WORKING_ORDER_LIFECYCLE_BLOCKED_ACCOUNT_ACTIVE`

The broker lane may continue on offline adapter, fixture, reject-lineage, and
OMS/reconciliation scope work. It must not claim working-order lifecycle,
cancelable-limit lifecycle, fill lifecycle, broker-ready closure, live
authority, or Phase 6 authority until account-active readiness is resolved.

## Evidence basis

Recent Rithmic Test probes established:

| Surface | Result |
|---|---|
| ORDER_PLANT auth | `PASS` |
| Account list | `PASS` |
| Trade route discovery | `PASS`, simulator route observed |
| Order update subscription | `PASS` |
| Zero-quantity safe reject lineage | observed via `response_new_order` reject |
| Positive-quantity submit framing | observed |
| Basket lineage | observed |
| Cancel request framing | observed |
| Fill events | `0` |
| Net position delta from observed fills | `0` |

The blocking broker notification was:

```text
rithmic_order_notification status = complete
text/report_text = Account not active
```

That means submit/cancel protocol framing is useful evidence, but it is not a
clean working-order lifecycle proof.

## Preflight gate

The ORDER_PLANT preflight now treats account-active readiness as a prerequisite
for positive-quantity cancelable-limit smoke attempts:

```text
account_active_required_before_cancelable_limit_smoke = true
```

Implementation surface:

```text
scripts/preflight/qfa-612-paper-01b/order_plant_client.py
```

Operational gate:

```text
QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED=true
```

Gate semantics:

```text
default when env var absent = false / blocked
accepted value = case-insensitive "true" after trimming whitespace
all other values = blocked
```

If the flag is not set, the cancelable-limit sub-check records `HOLD` before a
positive-quantity submit. The zero-quantity safe-reject path may still run
because it has already proven broker reject lineage without position exposure.

## No-network guard validation

Required proof:

```text
positive_quantity_guard_blocks_without_QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED = true
zero_quantity_safe_reject_path_not_blocked_by_account_active_gate = true
```

Validation commands:

```powershell
python scripts/preflight/qfa-612-paper-01b/order_plant_client.py --help
npx tsx scripts/preflight/qfa-612-paper-01b/order-plant-client.ts --help
python - <<'PY'
import importlib.util
import os
import sys

path = r"scripts/preflight/qfa-612-paper-01b/order_plant_client.py"
spec = importlib.util.spec_from_file_location("order_plant_client_gate_check", path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

for value in [None, "", "false", "1", "TRUE", " true "]:
    if value is None:
        os.environ.pop("QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED", None)
    else:
        os.environ["QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED"] = value
    print(value, module.order_plant_account_active_confirmed())
PY
```

Validation results:

```text
python order_plant_client.py --help = pass, argparse help rendered, no network path entered
npx tsx order-plant-client.ts --help = pass, wrapper help rendered before env loading or network path
gate truth table = pass
```

Truth table checked:

| `QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED` | Result |
|---|---:|
| absent | `false` |
| empty string | `false` |
| `false` | `false` |
| `1` | `false` |
| `TRUE` | `true` |
| ` true ` | `true` |

Guard proof:

```text
positive_quantity_guard_blocks_without_QFA_ORDER_PLANT_ACCOUNT_ACTIVE_CONFIRMED = true
zero_quantity_safe_reject_path_not_blocked_by_account_active_gate = true
```

## What remains blocked

```text
working-order ACK proof
cancel of an actually working non-marketable order
fill lifecycle
position reconciliation from real broker events
broker-ready / paper-ready closure
Phase 6 or live authority
```

## Authority caveat

This ticket creates no production account use, live trading authority, Phase 6
authority, roster mutation, automatic shutdown flattening authority, marketable
order path, fill, or net position exposure.

## Recommended next tickets

```text
QFA-612-BROKER-ADAPTER-SAFE-REJECT-INTEGRATION-01
QFA-612-BROKER-ORDER-LIFECYCLE-FIXTURE-HARNESS-01
QFA-615-LIVE-OMS-RECONCILIATION-SCOPE-01
```

After the account is activated:

```text
QFA-612-PAPER-ORDER-PLANT-CANCELABLE-LIMIT-SMOKE-RETRY-01
```
