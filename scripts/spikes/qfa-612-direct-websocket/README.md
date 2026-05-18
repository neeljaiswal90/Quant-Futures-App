# QFA-612 direct WebSocket feasibility spike

Research spike for ADR-0018 LD-018-2. This directory is intentionally
isolated from production broker code and does not implement a Rithmic
adapter.

## What this proves

The scripts exercise a mocked R-Protocol-shaped service over a real TLS
WebSocket upgrade using Node/TypeScript primitives:

- `spike-01-session.ts`: TLS session establishment plus auth handshake.
- `spike-02-framing.ts`: RFC 6455 text-frame masking, framing, and JSON
  decoding for representative market data.
- `spike-03-keepalive.ts`: WebSocket ping/pong plus application heartbeat
  for five logical minutes in mocked mode.
- `spike-04-reconnect.ts`: orderly reconnect and disorderly reconnect with
  recovery from the last observed sequence.
- `spike-05-order.ts`: representative order intent, ACK, fill, and reject
  messages.
- `spike-06-shutdown.ts`: logout ACK followed by graceful close code `1000`.

Each script writes a redacted JSONL fixture under `fixtures/`.

## Mocked-vs-real status

No real Rithmic endpoint is encoded here. Credentials are read only from
environment variables and are always redacted from fixtures:

- `RITHMIC_USERNAME`
- `RITHMIC_PASSWORD`
- `RITHMIC_APP_NAME`
- `RITHMIC_APP_VERSION`
- `RITHMIC_SYSTEM_NAME`
- `RITHMIC_FCM_ID`
- `RITHMIC_IB_ID`
- `RITHMIC_ACCOUNT_ID`

When these variables or a real test endpoint are unavailable, run the default
mock mode. The mock server generates an ephemeral local TLS certificate at
runtime through PowerShell/.NET, performs a real WebSocket handshake, and then
simulates R-Protocol-shaped JSON messages. The local TLS key material is never
written to disk or committed.

## Commands

Run from the repository root:

```powershell
npx tsx scripts/spikes/qfa-612-direct-websocket/spike-01-session.ts
npx tsx scripts/spikes/qfa-612-direct-websocket/spike-02-framing.ts
npx tsx scripts/spikes/qfa-612-direct-websocket/spike-03-keepalive.ts
npx tsx scripts/spikes/qfa-612-direct-websocket/spike-04-reconnect.ts
npx tsx scripts/spikes/qfa-612-direct-websocket/spike-05-order.ts
npx tsx scripts/spikes/qfa-612-direct-websocket/spike-06-shutdown.ts
```

Or from this directory:

```powershell
npm run spike:all
```

## Interpretation

This spike can support `PROCEED` for the Node/TypeScript direct WebSocket
mechanics only. It does not prove vendor-specific Rithmic production behavior.
Before a paper adapter is merged, QFA-612 implementation work must replay the
same six checks against a real Rithmic test environment and attach safe,
redacted evidence.
