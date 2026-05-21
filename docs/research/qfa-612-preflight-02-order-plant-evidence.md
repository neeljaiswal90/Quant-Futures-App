# QFA-612-PREFLIGHT-02 ORDER_PLANT Evidence

**Ticket**: QFA-612-PREFLIGHT-02  
**Branch**: `feat/qfa-612-preflight-02-order-plant-evidence`  
**Date**: 2026-05-21  
**PREFLIGHT-01 reference**: `docs/research/qfa-612-preflight-01-real-env-evidence.md`

## Final disposition

**HOLD QFA-612-PAPER-01b dispatch.**

PREFLIGHT-02 upgraded the ORDER_PLANT connection/reconnect path and attempted the paper-order lifecycle gap left by PREFLIGHT-01. The final disposition remains **HOLD** unless every order lifecycle sub-check is PASS and net position is verified zero.

## Per-check disposition

| Check | Disposition | Evidence |
|---|---:|---|
| 1 upgrade: ORDER_PLANT TLS/auth ACK | FAIL | `scripts/preflight/qfa-612-paper-01b/evidence/check-01-tls-auth-order-plant.json` |
| 2 upgrade: ORDER_PLANT framing | HOLD | `scripts/preflight/qfa-612-paper-01b/evidence/check-02-order-framing.json` |
| 4: orderly + disorderly reconnect | FAIL | `scripts/preflight/qfa-612-paper-01b/evidence/check-04-reconnect-real.json` |
| 5: paper order lifecycle | HOLD | `scripts/preflight/qfa-612-paper-01b/evidence/check-05-order-lifecycle-real.json` |
| 6 upgrade: logout + close | FAIL | `scripts/preflight/qfa-612-paper-01b/evidence/check-06-logout-close-real.json` |

## Position invariant

- Net MNQM6 position delta from this preflight script: `0`.
- Fillable marketable-limit sub-check: `HOLD`.
- Reason: See order lifecycle evidence.

## Blocker analysis

QFA-612-PAPER-01b remains blocked if this memo says HOLD. ORDER_PLANT login failed before order checks could execute. Broker response: `ORDER_PLANT login failed: rp_code=['13', 'permission denied']`. This indicates the supplied test credentials can authenticate to the gateway for market-data evidence, but are not permissioned for ORDER_PLANT in the current Rithmic test environment.

Recommended remediation: Provision ORDER_PLANT permission for the Rithmic test account, or provide an ORDER_PLANT-enabled test account, then rerun PREFLIGHT-02.

## Redaction discipline

Raw local logs are written only under `scripts/preflight/qfa-612-paper-01b/evidence/raw-local/`, which is gitignored. Committed evidence is generated through the PREFLIGHT-01 redactor with the active credential values supplied as explicit secrets.
