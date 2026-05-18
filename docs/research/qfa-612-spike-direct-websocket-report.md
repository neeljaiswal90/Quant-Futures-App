# QFA-612-SPIKE-01: Direct WebSocket feasibility spike report

## Verdict

**PROCEED.**

Direct Node/TypeScript WebSocket implementation remains feasible for
ADR-0018 LD-018-2. The isolated proof under
`scripts/spikes/qfa-612-direct-websocket/` demonstrates that the mechanics
required by ADR-0018 can be handled without a Java SDK, JNI bridge,
process-boundary IPC, or Python broker sidecar:

- TLS session establishment plus HTTP WebSocket upgrade.
- Auth request/ACK exchange with credential redaction.
- RFC 6455 framing, masked client frames, and message decoding.
- WebSocket ping/pong plus broker-style application heartbeat.
- Orderly and disorderly reconnect with sequence recovery.
- Representative order intent, ACK, fill, and reject messages.
- Logout ACK followed by graceful WebSocket close code `1000`.

This is not a production broker adapter. It is a research spike and should not
be used as an execution path.

## Real-vs-mocked evidence status

Real Rithmic test credentials and a vendor test endpoint were not assumed
available for this worker task. The proof therefore ran in mocked mode using a
local TLS WebSocket server that simulates R-Protocol-shaped semantics.

The mocked proof is enough to avoid escalating to `ADR-0018-A1` now because it
found no Node/TypeScript WebSocket limitation that makes direct implementation
unreasonable. However, before any QFA-612 paper adapter work is merged, the
same six checks must be replayed against the real Rithmic test environment with
redacted fixture evidence.

Credential handling rules observed by the spike:

- Rithmic credential values are read only from environment variables.
- Required env vars are `RITHMIC_USERNAME`, `RITHMIC_PASSWORD`,
  `RITHMIC_APP_NAME`, `RITHMIC_APP_VERSION`, `RITHMIC_SYSTEM_NAME`,
  `RITHMIC_FCM_ID`, `RITHMIC_IB_ID`, and `RITHMIC_ACCOUNT_ID`.
- Fixture logs record only presence booleans and redact auth fields.
- No credential values, tokens, or reusable TLS private keys are committed.

## Evidence table

| ADR-0018 LD-018-2 area | Proof script | Fixture | Result | Notes |
|---|---|---|---|---|
| Session establishment: TLS + auth handshake | `spike-01-session.ts` | `fixtures/spike-01-session.jsonl` | PASS in mock | Uses an ephemeral self-signed TLS cert, verifies HTTP `101`, verifies `Sec-WebSocket-Accept`, sends `auth.login`, decodes `auth.ack`. |
| Message framing and decoding | `spike-02-framing.ts` | `fixtures/spike-02-framing.jsonl` | PASS in mock | Client frames are masked; server decodes subscribe request; client decodes snapshot and delta messages. |
| Keepalive and heartbeat | `spike-03-keepalive.ts` | `fixtures/spike-03-keepalive.jsonl` | PASS in mock | Runs WebSocket ping/pong plus five application heartbeat ACKs. Mock compresses five logical minutes into five one-second intervals because real credentials/endpoints are unavailable. |
| Reconnect semantics | `spike-04-reconnect.ts` | `fixtures/spike-04-reconnect.jsonl` | PASS in mock | Covers orderly logout/reconnect and disorderly socket drop followed by `recover.request` from last observed sequence. |
| Representative order lifecycle | `spike-05-order.ts` | `fixtures/spike-05-order.jsonl` | PASS in mock | Sends order intents and decodes accepted ACK, fill, and rejected order cases. |
| Graceful shutdown | `spike-06-shutdown.ts` | `fixtures/spike-06-shutdown.jsonl` | PASS in mock | Sends logout request, decodes logout ACK, observes close code `1000`. |

## Mock substitutions

| Production concern | Mock substitution | Follow-up required before paper adapter merge |
|---|---|---|
| Vendor TLS certificate and endpoint | Ephemeral localhost TLS certificate generated at runtime; no key material written to repo | Validate Node WebSocket client against real Rithmic test endpoint and certificate chain. |
| R-Protocol auth payload | JSON-shaped `auth.login` message with env-only credential fields and redacted fixtures | Replace with actual R-Protocol auth schema and confirm required app/system/FCM/IB/account fields. |
| Wire encoding | JSON text frames over RFC 6455 | Confirm actual R-Protocol payload encoding/framing, including protobuf or binary payload requirements if applicable. |
| Keepalive cadence | Five logical minutes compressed to five one-second mocked intervals | Run at least one real five-minute heartbeat soak in Rithmic test environment. |
| Reconnect recovery | Sequence-based mock replay from `lastSeq` | Confirm vendor reconnect/session recovery behavior, including any required login replay, subscription replay, and order-state reconciliation. |
| Order lifecycle | Simulated order ACK/fill/reject messages | Confirm actual paper order plant messages and rejection codes before QFA-614 paper harness integration. |

## Go/no-go rationale

ADR-0018 LD-018-7 says direct WebSocket is permitted only if TLS/session
behavior is conformant with reasonable Node WebSocket-library defaults; if the
protocol requires non-standard behavior beyond library support, the project
must amend via `ADR-0018-A1`.

This spike did not uncover such a blocker. Node can establish TLS, complete a
WebSocket upgrade, mask client frames, decode server frames, handle ping/pong,
track heartbeat ACKs, reconnect, replay from a sequence marker, and close
gracefully within an isolated TypeScript proof.

The remaining uncertainty is vendor-specific, not a demonstrated Node
WebSocket feasibility failure. Therefore the correct action is `PROCEED`, with
real-environment validation as a QFA-612 implementation preflight rather than
an immediate escalation to `ADR-0018-A1`.

## Constraints preserved

- No production broker adapter was implemented.
- No files under `apps/`, `services/`, `config/`,
  `scripts/strategy-selection/`, or `scripts/backtester/` were touched.
- QFA-622 write scope remains disjoint.
- Sample logs are redacted and safe for commit.

## Recommended preflight for QFA-612 implementation

Before merging a paper adapter, rerun equivalent checks against the Rithmic
test environment and attach redacted evidence:

1. Real TLS/WebSocket connect and auth ACK.
2. Real market/order message framing decode.
3. Real heartbeat run for at least five wall-clock minutes.
4. Real orderly and disorderly reconnect behavior.
5. Real paper order ACK/fill/reject lifecycle.
6. Real logout and close semantics.
