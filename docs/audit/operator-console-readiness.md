# Live-Sim Operator Console Readiness Audit

Status: draft, implementation gate for `AUD-CONSOLE-01`

This audit records the development assumptions that must stay true while building the read-only Live-Sim Operator Console. It intentionally makes no runtime changes.

## TUI Relationship

Decision: coexist for the initial console implementation.

`apps/strategy_runtime/src/operator/tui.ts` remains the active terminal operator surface while the web console is built. The console may reuse facts and formatting concepts, but it must not depend on mutable runtime internals or silently replace TUI behavior. Any later extraction of shared aggregation or staleness helpers belongs in a follow-up refactor under `apps/strategy_runtime/src/operator/`.

## P&L Fact Surface

Current OBS-01 payload facts:

- `MGMT_ACTION.realized_pnl_usd` is optional and appears only on management exits or partial exits.
- `RISK_GATE.session_risk.realized_pnl_usd` is aggregate session state.
- `POSITION` has no realized P&L field.
- `MGMT_TICK` carries `unrealized_pnl_usd`, not realized P&L.
- `SIM_FILL` does not by itself prove realized P&L.

Console rule:

- Per-position realized P&L may be reconstructed only by summing explicit `MGMT_ACTION.realized_pnl_usd` values keyed by `position_id`.
- Closed-position terminal P&L remains `unavailable` unless a dedicated lifecycle fact exists.
- Missing realized P&L is displayed as `unavailable`, never `0`.
- `RISK_GATE.session_risk.realized_pnl_usd` is not a daily-loss-usage fact and must not populate `risk.daily_loss_usage`.

Follow-up observability candidate: add an additive runtime event such as `POSITION_CLOSED` or `POSITION_PNL` if operators need guaranteed terminal position P&L in the console.

Risk fact gap: `RISK_GATE.session_risk` currently has no explicit `daily_loss_usage` or `daily_loss_usd` field, so the console risk panel must render daily-loss usage as `unavailable` until such a fact exists.

## Feature Surface

The repo uses feature availability mask v5:

- `FEATURE_AVAILABILITY_MASK_VERSION = 5`
- `FEATURE_AVAILABILITY_MASK`
- `buildFeatureAvailabilityMask()`

The console must derive `feature_surface` from embedded journal masks when present, falling back only to the exported v5 mask. It must represent these tiers:

```text
authoritative
subscope
diagnostic_only
shadow_only
advisory_only
blocked
available
```

Decision-grade state must never accept blocked, diagnostic, shadow, advisory, or subscope fields.

If an embedded mask is present but its schema version, mask version, or identity does not match the runtime v5 audit mask, the console must emit an alert and use the v5 fallback mask.

## Read-Only Boundary

The console is a journal-tail and aggregation surface only. It must not:

- publish runtime events;
- create `JournalEventEnvelope` records;
- mutate position, risk, config, or strategy state;
- route broker or simulated orders;
- expose raw journal downloads or raw DBN/probe payloads over REST/WS.

Allowed runtime imports are intentionally narrow:

- `apps/strategy_runtime/src/contracts/**`
- `apps/strategy_runtime/src/operator/formatter.ts`
- `apps/strategy_runtime/src/features/availability-mask.ts`
- `apps/strategy_runtime/src/transport/journal-jsonl-transport.ts`, only if transitive closure remains read-only
- pure validation/type helpers with no publish/write side effects

The import guard must check transitive imports from console source, not just direct imports.

## Journal Discovery

Default runtime journal selector:

```text
rel00_controlled_live_sim_journal*.jsonl
```

Precedence:

1. `--journal` / `QFA_CONSOLE_JOURNAL`
2. `--journal-dir` / `QFA_CONSOLE_JOURNAL_DIR` plus optional glob override
3. fail clearly

Excludes:

```text
shadow
sidecar
probe
quarantine
checkpoint
malformed-lines
*.tmp
*.partial
*.writing
```

Console checkpoints and quarantine files must live under the console checkpoint directory, never under runtime journal directories.

## Workspace Strategy

Decision: add npm workspaces for:

```text
apps/operator_console/server
apps/operator_console/web
```

The first scaffold keeps package-local scripts lightweight and defers React/Vite dependencies until the web MVP ticket. Root TypeScript and Vitest coverage include console source and tests.

## Remote Access

Default bind remains `127.0.0.1`. Non-loopback mode requires explicit remote opt-in, bearer token, and origin allowlist. `OPERATOR_CONSOLE_AUTH_TOKEN` is read at startup; token rotation requires restart.

Remote plain HTTP/WS is not acceptable on an untrusted network. Operators must use loopback, SSH tunneling, or a TLS-terminating reverse proxy.
