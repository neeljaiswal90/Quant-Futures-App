# QFA-612-PREFLIGHT-01 Real-Environment Evidence

**Ticket**: QFA-612-PREFLIGHT-01  
**Branch**: `feat/qfa-612-preflight-01-real-env-evidence`  
**Date**: 2026-05-21  
**Rithmic test environment**: `Rithmic Test`, gateway `[REDACTED:gateway]`  
**Reference**: `docs/research/qfa-612-spike-direct-websocket-report.md`, section "Recommended preflight for QFA-612 implementation".

## Go / no-go disposition

**Disposition: HOLD QFA-612-PAPER-01b dispatch.**

The real Rithmic test gateway is reachable and authenticated market-data capture works for the existing TICKER_PLANT RProtocol probe. However, the required ORDER_PLANT paper order lifecycle and reconnect/close byte-level checks are not yet executable with the current repository tooling. QFA-612-PAPER-01b should remain blocked until an ORDER_PLANT-capable preflight client can execute checks 4 and 5, and can capture logout/close semantics against the same session family.

## Summary table

| Check | Required evidence | Result | Evidence artifact |
| --- | --- | --- | --- |
| 1. Real TLS/WebSocket connect and auth ACK | TLS handshake plus auth ACK | PASS_PARTIAL | `scripts/preflight/qfa-612-paper-01b/evidence/check-01-tls-auth.json` |
| 2. Real market/order message framing decode | Representative market and order messages decoded | PASS_PARTIAL | `scripts/preflight/qfa-612-paper-01b/evidence/check-02-framing.json` |
| 3. Real heartbeat run >= 5 wall-clock minutes | Stable 300s run, zero disconnect/errors | PASS | `scripts/preflight/qfa-612-paper-01b/evidence/check-03-heartbeat-300s.json` |
| 4. Real orderly/disorderly reconnect behavior | Reconnect within retry budget, state recovered | HOLD | `scripts/preflight/qfa-612-paper-01b/evidence/check-04-reconnect.json` |
| 5. Real paper order ACK/fill/reject lifecycle | Order intent to submission/fill/cancel/reject ACK lineage | HOLD | `scripts/preflight/qfa-612-paper-01b/evidence/check-05-order-lifecycle.json` |
| 6. Real logout and close semantics | Logout ACK and close-frame trace | PASS_PARTIAL | `scripts/preflight/qfa-612-paper-01b/evidence/check-06-logout-close.json` |

## Executed checks

### Check 1: TLS/WebSocket/auth bootstrap

The RProtocol SDK startup path loaded successfully and `--list-systems` returned the expected `Rithmic Test` system. A 10-second authenticated market-data smoke then received records from the real test gateway with zero probe errors.

This is marked **PASS_PARTIAL** because the existing collector proves the authenticated RProtocol probe path but does not commit raw TLS cipher details or an auth ACK byte trace.

### Check 2: framing decode

The 10-second smoke and 300-second run decoded real `LAST_TRADE` and `L1_QUOTE` messages for `MNQM6` / `CME`. The 300-second run produced 96 decoded records: 89 `L1_QUOTE`, 7 `LAST_TRADE`, zero unknown template IDs, zero probe errors.

This is marked **PASS_PARTIAL** because order message framing was not decoded. The available collector is documented as TICKER_PLANT-only and cannot exercise ORDER_PLANT messages.

### Check 3: 300-second liveness window

The authenticated real test-env run completed 300 wall-clock seconds with zero probe errors. The committed evidence preserves counts and timing summaries; raw local captures remain ignored and uncommitted.

### Check 4: reconnect

Not executed against the real test environment. The prior spike has mock reconnect coverage, and QFA-616/QFA-618 now has runtime reconnect machinery, but this preflight branch does not have a real Rithmic reconnect preflight harness.

### Check 5: paper order lifecycle

Not executed. No paper order was submitted. The current repository tooling only includes a TICKER_PLANT collector and the mock ORDER_PLANT adapter from QFA-612-PAPER-01a. It does not include a real ORDER_PLANT client capable of placing a test order, canceling it, and capturing ACK/fill/reject lineage.

### Check 6: logout and close

The real authenticated probes exited cleanly with process exit code 0. This is marked **PASS_PARTIAL** because the committed evidence does not include a logout ACK byte trace or RFC 6455 close-frame capture.

## Redaction discipline

- `.env.preflight.local` is ignored by git and was used only to load local credentials.
- Raw captures are kept under `scripts/preflight/qfa-612-paper-01b/evidence/raw-local/`, which is ignored by git.
- Committed evidence is summary-only or redacted sample-only.
- Redaction tests cover credential, token, account ID, session ID, order ID, and public IP shaped values.

## Recommendation

Hold QFA-612-PAPER-01b until one of these is available:

1. A real ORDER_PLANT preflight client that can execute the order lifecycle and reconnect/close checks directly against the Rithmic test environment.
2. Vendor-supported paper-order test tooling with redacted evidence that maps unambiguously to QFA-623 ACK lineage fields.

Once checks 4 and 5 pass, rerun this memo with a `PROCEED` disposition and attach the expanded redacted evidence pack to QFA-612-PAPER-01b.
