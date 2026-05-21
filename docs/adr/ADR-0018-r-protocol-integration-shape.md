# ADR-0018: Rithmic R-Protocol integration shape

## Status

Accepted

## Context

Phase 5 closed at commit e985b10 with the first project-history
ADVANCE_TO_PAPER verdict: regime_shock_reversion_short_v2 cleared all
9 ADR-0016 Stage 1 thresholds. Phase 6 dispatch is authorized.

Phase 6 begins with broker integration. The system must connect to
Rithmic's R-Protocol API to: (a) submit order intents and receive ACKs
for paper trading (QFA-614), (b) eventually reconcile live positions
against broker state (QFA-615), and (c) capture latency and lifecycle
telemetry that feeds QFA-616 kill-switch enforcement and QFA-618
anomaly detection.

ADR-0018 locks the integration shape: which Rithmic plants we connect
to, how we implement the protocol, how we handle time/identity, how
we classify and respond to failures, and how we govern the paper/live
boundary. ADR-0020 (latency SLA) is sequenced after ADR-0018 because
the latency budget is meaningful only once the protocol round-trip
behavior is locked.

The project already uses a versioned policy artifact for data-feature
availability and MBO use-context gating: the feature-availability mask
documented in DATA-03 / DATA-MBO-03 and implemented in
apps/strategy_runtime/src/features/availability-mask.ts plus its Python
mirror at services/market_data_sidecar/features/availability_mask.py.
In the current sources that artifact is at mask_version = 5 with
mask_id = feature-availability-mask-v5-adr0003-data-mbo03-advisory-policy
and mask_hash = sha256:2846f34c38c6d5f1b69979adb3a54165462e96e46440b3ffd7fdf96383333ff0.
TypeScript/Python equivalence is covered by
apps/strategy_runtime/tests/unit/feature-availability-mask.test.ts.
REL-01D (apps/strategy_runtime/tests/unit/rel01d-feature-surface-audit.test.ts)
is directly bound to that v5 mask family, and downstream shadow-evidence
tests expect REL-01E audit outputs to remain on the same family.

This ADR does not extend that data-plane artifact with broker execution
semantics. Broker execution capability is modeled as a sibling policy
family with its own identifier and version namespace, because it
governs operational execution behavior (plant scope, paper/live mode,
ACK lifecycle, kill-switch posture, health gates) rather than
data-feature eligibility. The two masks share the same governance
pattern — versioned, ID-bound, mask-hashed, TS+Python mirrored,
validator-bound — but their semantic families are disjoint and their
state matrices, validators, audit surfaces, and lifetime expectations
differ.

## Locked decisions

### LD-018-1: Plant scoping is phase-staged

ORDER_PLANT only at QFA-614 (paper harness). PNL_PLANT added at
QFA-615 (live OMS + reconciliation). HISTORY_PLANT remains disabled
by default; its activation requires a future ADR. The execution
capability mask (LD-018-13) enforces this at runtime: enabling
PNL_PLANT in a paper-mode session fails closed, and HISTORY_PLANT
is blocked outright.

### LD-018-2: Direct Node/TS WebSocket implementation, subject to feasibility spike

The R-Protocol integration is implemented in Node/TypeScript using a
WebSocket library. No Java SDK via JNI. No process-boundary IPC
bridge. No Python sidecar for broker traffic.

This decision is subject to a formal feasibility spike at QFA-612
entry. The spike must validate, with a minimal working proof:

- Session establishment (TLS, authentication handshake)
- Message framing and decoding
- Keepalive and heartbeat behavior
- Reconnect semantics (orderly and disorderly cases)
- Representative order lifecycle messages (intent, ACK, fill, reject)
- Graceful shutdown

The spike has explicit go/no-go criteria documented in
QFA-612-SPIKE-01 (see Consequences). If the spike concludes that
direct WebSocket implementation is unreasonable, this ADR is
amended via ADR-0018-A1 to switch to the SDK or bridge path. Silent
drift to SDK or bridge without ADR amendment is forbidden per
CF-30 + CF-41.

### LD-018-3: Dual timestamps on broker-originated events

Every broker-originated journal event records two timestamps:

- `ts_ns_exchange`: the broker-server timestamp. Authoritative for
  PnL attribution, paper-vs-live comparability, INFRA-01B canonical
  exchange-time compliance, and journal ordering.
- `ts_ns_local`: the Node process timestamp at event ingestion.
  Used for latency instrumentation only.

The journal schema MUST require both fields on broker-originated
events and on order-lifecycle events. A schema validator
(EXEC-VALIDATOR-02, see LD-018-14) rejects broker events missing
either timestamp.

Latency is computed deterministically as
`ts_ns_local - ts_ns_exchange` at any downstream consumer
(QFA-618 anomaly detection, latency telemetry, replay analysis).
Without both fields the latency signal cannot be reconstructed.

### LD-018-4: Instrument bootstrap is pre-load-and-lazy

At session start, the configured strategy's instruments are pre-loaded
into the account/instrument metadata cache. For Cycle3 v2 paper this
is `[MNQ]`. Anything else (future strategy expansion) is lazy-loaded
at first reference.

The pre-load list is configured via the live session-startup
configuration surface introduced by QFA-614. The concrete file path
and format are implementation-defined within QFA-614 and remain
non-normative to this ADR. The configured list is journaled into
session metadata (LD-018-15) for audit lineage so the actual
configuration in force at session start is reconstructable from
the journal regardless of where the configuration lives.

### LD-018-5: Three-class failure taxonomy with subreason tagging

Top-level failure classes:

| Class | Examples | Default response |
|---|---|---|
| `network` | TCP/TLS errors, dropped connections, transport-layer timeouts | Reconnect with backoff per LD-018-6. Kill-switch trips only after retry budget exhausted. |
| `protocol` | Malformed messages, version mismatch, unexpected message types, sequence anomalies | Kill-switch trips immediately + operator alert. |
| `business` | Order rejected (insufficient margin, market closed, invalid order), broker-side risk halt | Log + halt the affected strategy. Other strategies continue. Operator decides resume. |

Each failure event carries a `subreason` string field with
finer-grained context (e.g., `network/auth`, `network/tls`,
`network/stall`, `protocol/sequence_gap`,
`business/insufficient_margin`, `business/risk_halt`). This
preserves auth visibility within the top-level network class while
keeping the enum stable.

QFA-616 and QFA-618 consume class + subreason to decide trigger
thresholds and alert routing. EXEC-VALIDATOR-06 (LD-018-14) ensures
every terminal or alerted failure event has both fields populated.

### LD-018-6: Reconnect policy is exponential backoff + retry budget + manual recovery

Reconnect state machine structure (binding):

- Exponential backoff
- Maximum delay per attempt (cap)
- Maximum consecutive failed retries
- Manual recovery escalation after retry budget exhaustion
- Kill-switch trip after retry budget exhaustion

Recommended starting values (configurable by QFA-612; not hardcoded
in source):

- Initial backoff: 100ms
- Multiplier: 2.0
- Maximum delay per attempt: 30s
- Maximum consecutive failed retries: 10

Retry budget math with these values, assuming a standard 1-second
per-attempt connection timeout:

```
cumulative backoff: 100ms + 200ms + 400ms + 800ms + 1.6s + 3.2s
                  + 6.4s + 12.8s + 25.6s + 30s ≈ 81s
cumulative timeouts: 10 × 1s = 10s
worst-case total: approximately 91 seconds before kill-switch trip
```

Configurable parameters live in the live reconnect-policy
configuration surface introduced by QFA-612. The concrete file path
and format are implementation-defined within QFA-612 and remain
non-normative to this ADR. The configured parameters are journaled
at session start (LD-018-15) so the actual runtime policy is
auditable.

QFA-612 may tune the specific numeric values within its dispatch
scope. The structure (exponential backoff + cap + retry budget +
manual recovery + kill-switch trip on exhaustion) is binding.

### LD-018-7: TLS/session lifecycle follows Rithmic protocol

The TLS handshake cadence (persistent session vs per-connect)
follows Rithmic's protocol mandate as documented in their R-Protocol
spec. The QFA-612 feasibility spike (LD-018-2) records the observed
behavior; ADR-0018 does not pre-pin a specific choice. Direct
WebSocket is permitted only if the protocol's TLS/session behavior
is confirmed conformant with reasonable Node WebSocket-library
defaults; if the protocol mandates non-standard behavior that
exceeds library support, that finding triggers ADR-0018-A1
amendment per LD-018-2.

### LD-018-8: Dual liveness — broker keepalive + application stall detection

Both layers operate concurrently:

- Broker-protocol keepalive at Rithmic's mandated cadence
- Application stall detection at the event-bus boundary

Stall thresholds (configurable; baseline values):

- ORDER ACK stall: 5 seconds from intent emission without ACK
- Session-wide event stall during RTH: 30 seconds without any
  inbound event when events are expected
- Low-activity stall (overnight, halts): higher threshold
  (configurable; default 5 minutes)

Stall events emit failure events classified per LD-018-5 (typically
`network/stall` or `protocol/unexpected_silence`). Test surface
(LD-018-11) includes explicit "socket alive but app stalled"
scenarios.

ADR-0018 specifies detection only. Action policy (cancel-on-stall,
escalation, etc.) is ADR-0020 territory.

### LD-018-9: ACK latency measured here; action policy in ADR-0020

Every order intent emits a journal event with `intent_ts_ns_local`
and `intent_ts_ns_exchange` (LD-018-3). The broker ACK event
includes `ack_ts_ns_local` and `ack_ts_ns_exchange`. A
`correlation_id` binds the intent to its ACK/NACK/terminal-timeout
event.

ACK lineage validator (EXEC-VALIDATOR-03, LD-018-14) ensures:

- Every order intent has a deterministic journal trail to ACK,
  NACK, or terminal-timeout
- correlation_id is present and unique within the trail
- Latency is computable from the stored timestamps

ADR-0018 does NOT specify auto-cancel thresholds or breach
actions. That coupling lives in ADR-0020 so the latency budget
can be revised without re-validating the protocol integration.

### LD-018-10: Credentials — env vars for paper, vault for live

Paper-mode credential surface (env vars; documented contract):

```
RITHMIC_USERNAME
RITHMIC_PASSWORD
RITHMIC_APP_NAME
RITHMIC_APP_VERSION
RITHMIC_SYSTEM_NAME
RITHMIC_FCM_ID
RITHMIC_IB_ID
RITHMIC_ACCOUNT_ID
```

Live mode requires a vault-backed secret source. The execution
capability mask (LD-018-13) fails closed at session start in live
mode without vault evidence. Vault integration is implemented in
QFA-620-SECRETS-01.

Secret redaction tests apply to BOTH paper and live (no credential
should leak into logs, journal events, or error messages regardless
of mode).

### LD-018-11: Test surface is mock for unit + Rithmic test environment for integration

- Unit tests use a deterministic mock broker simulator that
  supports configurable ACK latency, error injection per LD-018-5
  class, fill simulation, position-snapshot emission, and
  disconnect scenarios.
- Integration tests use Rithmic's test environment with separate
  credentials. Runs are NIGHTLY or on-demand, NOT per-commit.
- Live broker environment is reserved for LIVE-RAMP step; not used
  at Phase 6 entry.

The mock simulator honors the same execution capability mask
constraints as the real broker integration so paper-only
enforcement is testable.

### LD-018-12: Initial QFA-612 scope is paper-only

QFA-612 (Rithmic broker adapter) ships paper-mode-only. Live-mode
infrastructure is deferred to QFA-615 (live OMS + reconciliation).

The execution capability mask enforces this. Live dispatch from a
paper-mode session fails closed. Attempts to enable PNL_PLANT or
live-execution capabilities without the corresponding live-mode
unlock fail closed.

QFA-612 PR description explicitly states "Paper-mode-only.
Live-mode infrastructure deferred to QFA-615." Live-mode
capability flags remain in the mask as `blocked` until QFA-615
lands the corresponding implementation.

### LD-018-13: Execution capability mask (sibling to DATA-MBO-03)

A versioned, ID-bound, fail-closed execution capability mask is
the governance surface for all decisions in this ADR. It is a
SIBLING of the existing DATA-MBO-03 feature availability mask, NOT
a mutation of it. The two masks share the structural pattern but
their semantic enums are disjoint.

Required surface (TypeScript; Python mirror requirements in the
TS/Python parity subsection below):

```typescript
// apps/strategy_runtime/src/execution/execution-capability-mask.ts (NEW)

export const EXECUTION_CAPABILITY_MASK_SCHEMA_VERSION = 1 as const;
export const EXECUTION_CAPABILITY_MASK_VERSION = 1 as const;
export const EXECUTION_CAPABILITY_MASK_ID =
  'execution-capability-mask-v1-adr0018-paper-only-order-plant' as const;

export type ExecutionCapability =
  // Plant scope
  | 'order_plant_paper'
  | 'order_plant_live'
  | 'pnl_plant'
  | 'history_plant'
  // Order action scope
  | 'submit'
  | 'cancel_replace'
  | 'flatten'
  // ACK lifecycle
  | 'ack_measurement'
  | 'ack_enforcement'
  // Kill-switch posture
  | 'killswitch_armed'
  | 'killswitch_tripped';

export type ExecutionUseContext =
  | 'session_startup'
  | 'preload'
  | 'connection_open'
  | 'paper_order_submit'
  | 'live_order_submit'
  | 'cancel_replace'
  | 'ack_reconcile'
  | 'operator_display'
  | 'blocked_diagnostic_count';

export type ExecutionCapabilityTier =
  | 'enabled'
  | 'enabled_with_live_mode_only'
  | 'enabled_with_vault_evidence'
  | 'enabled_with_health_gates_satisfied'
  | 'blocked';

export type ExecutionScopingSurface =
  | 'global'
  | 'account'
  | 'venue'
  | 'symbol_allowlist'
  | 'strategy_allowlist';

export type ExecutionHealthGate =
  | 'connectivity_auth_health'
  | 'plant_health'
  | 'heartbeat_freshness'
  | 'account_resolution_readiness'
  | 'symbol_entitlement_readiness'
  | 'killswitch_clear';

export type ExecutionCapabilityDecisionReason =
  | 'allowed'
  | 'blocked_capability'
  | 'wrong_session_mode'
  | 'missing_health_gate'
  | 'wrong_scoping_surface'
  | 'requires_vault_evidence'
  | 'unknown_capability'
  | 'unknown_use_context'
  | 'unknown_scoping_surface'
  | 'unknown_health_gate'
  | 'unknown_tier';

export interface ExecutionCapabilityDecision {
  readonly allowed: boolean;
  readonly reason: ExecutionCapabilityDecisionReason;
}

export function evaluateExecutionCapability(
  capability: ExecutionCapability,
  useContext: ExecutionUseContext,
  sessionMode: 'paper' | 'live',
  scopingSurface: ExecutionScopingSurface,
  healthGates: ReadonlySet<ExecutionHealthGate>,
): ExecutionCapabilityDecision;

export function isExecutionCapabilityAllowed(
  capability: ExecutionCapability,
  useContext: ExecutionUseContext,
  sessionMode: 'paper' | 'live',
  scopingSurface: ExecutionScopingSurface,
  healthGates: ReadonlySet<ExecutionHealthGate>,
): boolean;

export function assertExecutionCapabilityAllowed(
  capability: ExecutionCapability,
  useContext: ExecutionUseContext,
  sessionMode: 'paper' | 'live',
  scopingSurface: ExecutionScopingSurface,
  healthGates: ReadonlySet<ExecutionHealthGate>,
): void;
```

The `assertExecutionCapabilityAllowed` API throws with a precise
operator/audit message constructed from the
`ExecutionCapabilityDecision.reason` field;
`isExecutionCapabilityAllowed` returns boolean for predicate use;
`evaluateExecutionCapability` returns the structured decision for
callers that need the reason for logging, metrics, or alert
routing.

**Mask v1 binding for Phase 6 entry (paper mode):**

| Capability | Paper | Live |
|---|---|---|
| `order_plant_paper` | enabled | enabled |
| `order_plant_live` | blocked | enabled_with_vault_evidence |
| `pnl_plant` | blocked | enabled (post-QFA-615) |
| `history_plant` | blocked | blocked (future ADR required) |
| `submit` | enabled (paper-scope only) | enabled_with_health_gates_satisfied |
| `cancel_replace` | enabled (paper-scope only) | enabled_with_health_gates_satisfied |
| `flatten` | enabled (paper-scope only) | enabled_with_health_gates_satisfied |
| `ack_measurement` | enabled | enabled |
| `ack_enforcement` | blocked | enabled (post-ADR-0020) |
| `killswitch_armed` | enabled | enabled |
| `killswitch_tripped` | blocked (set by runtime, not statically) | blocked (set by runtime, not statically) |

The runtime guard `assertExecutionCapabilityAllowed(...)` MUST be
called at every Phase-6-dispatched capability boundary. Session
startup emits `execution_mask_id` and `execution_mask_version`
into the journal session-meta event (LD-018-15) so all Phase 6
runs are auditable.

**Unknown-default behavior (fail closed):** any unknown
`ExecutionCapability`, `ExecutionUseContext`, `ExecutionScopingSurface`,
`ExecutionHealthGate`, or `ExecutionCapabilityTier` value MUST cause
`evaluateExecutionCapability` to return
`{ allowed: false, reason: 'unknown_*' }` per the matching reason
code, and `assertExecutionCapabilityAllowed` MUST throw. This
mirrors the DATA-MBO-03 fail-closed discipline.

**TS/Python parity (asymmetric per DATA-MBO-03 precedent):**

- TypeScript surface: complete (capability enums + use contexts +
  scoping + health gates + tier policy + structured decision type
  + hard guard API). The TS guard API is the enforcement surface
  for runtime Phase 6 code, which is TS-owned.
- Python mirror at `services/.../execution_capability_mask.py`:
  minimum required surface is construction + tier lookup + scalar
  publication of mask_version, mask_id, mask_hash for cross-language
  verification. A hard Python guard API is NOT required by ADR-0018
  (matches DATA-MBO-03 precedent where Python stops at
  construction-and-publication).
- Cross-language verification: a test analogous to
  `apps/strategy_runtime/tests/unit/feature-availability-mask.test.ts`
  MUST assert that the TS-built mask and Python-built mask produce
  identical `mask_version`, `mask_id`, and `mask_hash` after JSON
  parse. EXEC-VALIDATOR-08 (LD-018-14) enforces this.

If Python ever emits broker traffic, a follow-up ADR amendment
introduces the Python guard API. The current Phase 6 architecture
has all broker-execution code on the Node/TS side, so the
asymmetry is correct for v1.

### LD-018-14: Validator family for execution-plane policy

A new validator family is introduced for broker/execution
semantics, separate from the existing REL-01D / REL-01E family
(which is scoped to data-feature surfaces per DATA-MBO-03).

Validators in this family:

- `EXEC-VALIDATOR-01`: execution mask binding (every Phase 6
  runtime emits `execution_mask_id` + `execution_mask_version` at
  session start; values match expected mask).
- `EXEC-VALIDATOR-02`: broker event schema (every broker-originated
  event has both `ts_ns_exchange` and `ts_ns_local` per LD-018-3).
- `EXEC-VALIDATOR-03`: ACK lineage completeness (every order intent
  has a deterministic journal trail to ACK/NACK/terminal-timeout
  per LD-018-9; correlation_id present and unique).
- `EXEC-VALIDATOR-04`: plant/mode constraint (no PNL_PLANT or
  HISTORY_PLANT events in paper-mode sessions; no live-execution
  events in paper-mode; no order_plant_live without vault evidence).
- `EXEC-VALIDATOR-05`: session startup metadata (instrument preload
  list journaled; configured reconnect policy parameters journaled;
  credential source classified `env_vars` vs `vault`).
- `EXEC-VALIDATOR-06`: failure-event class + subreason populated
  (per LD-018-5).
- `EXEC-VALIDATOR-07`: live mask state matches session-start
  journal (per LD-018-19; drift triggers alert AND blocks new
  order submission).
- `EXEC-VALIDATOR-08`: TS/Python mask parity
  (`mask_version`, `mask_id`, `mask_hash` identical after JSON
  parse, analogous to `feature-availability-mask.test.ts`).

The data-plane validators (REL-01D feature surface, REL-01E MBO
shadow lineage) remain scoped to their existing concerns.
Execution semantics do not enter REL-01D or REL-01E.

### LD-018-15: Session manifest journaling

At every Phase 6 session start, the runtime emits a session-meta
journal event recording:

- `session_id`, `session_mode` (paper|live), `start_ts_ns_exchange`
- `execution_mask_id`, `execution_mask_version` (LD-018-13)
- `feature_availability_mask_id`, `feature_availability_mask_version`
  (DATA-MBO-03 existing surface — v5 with mask_id
  `feature-availability-mask-v5-adr0003-data-mbo03-advisory-policy`)
- Configured strategy roster (ACTIVE_STRATEGY_IDS at runtime)
- Pre-loaded instrument list (LD-018-4)
- Reconnect policy parameters (LD-018-6 configured values)
- Heartbeat/stall thresholds (LD-018-8 configured values)
- Credential source classification (`env_vars` | `vault`)
- ADR-0018 commit hash (this document at session-start time)

The session-meta event is the runtime fingerprint that connects
the execution surface to the configured policy. Replay/audit
tooling reads it to reconstruct what policy was in force at any
historical session.

### LD-018-16: Backward and forward compatibility constraints

ADR-0018 introduces no breaking changes to data-plane code. The
existing DATA-MBO-03 mask (v5) and REL-01D/01E validators are NOT
modified. Phase 0-4 determinism baselines (Phase 2 hash
`dbb45cf8...832b` and Phase 4 hash `ad8dad3c...0090`) are
preserved by Phase 6 implementations. Cycle1/Cycle2/Cycle3 verdict
artifacts (strategy-selection-v1.json, v2.json, v3.json) remain
byte-locked.

Any future ADR amendment (e.g., ADR-0018-A1 from the LD-018-2
spike failure path; or a future ADR enabling HISTORY_PLANT or a
Python guard API) bumps the execution mask version and re-binds
validators.

### LD-018-17: Open questions deferred to subsequent ADRs

ADR-0018 does NOT decide:

- Latency SLA values (deferred to ADR-0020)
- Auto-cancel-on-timeout policy (deferred to ADR-0020)
- Kill-switch trigger thresholds (deferred to QFA-616
  implementation, with ADR-0020 informing the latency-related
  thresholds)
- Operator console UI design — apart from the mask-state display
  requirements of LD-018-19 (deferred to QFA-617)
- Anomaly detection rules (deferred to QFA-618)
- Production deployment topology (deferred to ADR-0021)
- Vault provider choice (deferred to QFA-620)

### LD-018-18: ADR amendment path

ADR amendments to ADR-0018 follow the project's standard ADR
amendment process: numbered amendment files
(ADR-0018-A1-feasibility-spike-fallback.md if needed,
ADR-0018-A2-..., etc.) referenced from ADR-0018's "Amendments"
section. Amendments bump the execution mask version per LD-018-13.

Silent drift (e.g., switching SDK path without ADR-0018-A1,
enabling HISTORY_PLANT without a new ADR, or introducing a Python
guard API without a new ADR) is forbidden per CF-30 + CF-41
anti-drift discipline.

### LD-018-19: Execution capability mask state is operator-observable at runtime

The execution capability mask state must be observable at runtime
through at least two surfaces:

**(a) Journal session-meta event** (LD-018-15) — captures the mask
state at session start; reconstructable from the journal for any
historical session.

**(b) Live diagnostics surface** — operators and auditors must be
able to query the currently-active mask state during a running
session without reading raw journal events. The concrete surface
(HTTP endpoint, metrics gauge, log line on demand, operator
console panel) is implementation-defined within QFA-617 (operator
console) but the ADR-0018 contract requires *some* live-inspectable
surface.

The operator console (QFA-617) MUST display at minimum:

- `execution_mask_id`
- `execution_mask_version`
- `session_mode` (paper | live)
- enabled plants (subset of `order_plant_paper`, `order_plant_live`,
  `pnl_plant`, `history_plant`)
- blocked capabilities (subset of the capability enum currently in
  the `blocked` tier)
- health gates satisfied vs missing (subset of
  `ExecutionHealthGate`)

**Mask drift behavior:** if the live mask state diverges from the
session-start journal values, EXEC-VALIDATOR-07 (LD-018-14) MUST:

1. Emit a high-priority operator alert classified per LD-018-5.
2. **Block new order submission** until operator review explicitly
   resumes the session. Existing positions are managed by their
   established stop/target/time-stop logic; only NEW submissions
   are blocked.

Alerting alone is too weak for an execution capability surface;
drift indicates either a runtime corruption or an unauthorized
runtime mask mutation, and either case warrants halting new risk
exposure until investigation.

## What ADR-0018 does NOT do

- Does NOT mutate the DATA-MBO-03 feature availability mask or its
  validators (REL-01D, REL-01E).
- Does NOT pin latency SLA values (ADR-0020 scope).
- Does NOT specify kill-switch thresholds, console UI design,
  anomaly rules, or production topology.
- Does NOT enable live execution. Live capabilities remain blocked
  until QFA-615 + QFA-620 land and the LIVE-PROMOTION 8-gate review
  passes.
- Does NOT change the Cycle3 paper-trading strategy
  (`regime_shock_reversion_short_v2`) or its parameter lock.
- Does NOT bind to specific configuration file paths
  (`config/live/session-startup.yaml`,
  `config/live/reconnect-policy.yaml`, etc.); those are
  implementation-defined within the dispatch tickets that create
  them.

## Consequences

ADR-0018 dispatches the following follow-up tickets (named per
Phase 6 QFA-6xx convention):

| Priority | Ticket | Scope |
|---|---|---|
| Highest | QFA-622 | Execution capability mask v1: implement LD-018-13 (TS + Python mirror + structural-equivalence test + fail-closed unknown defaults) |
| Highest | QFA-612-SPIKE-01 | Direct WebSocket feasibility spike; go/no-go report + minimal proof, not a partial client |
| High | QFA-623 | Journal schema extension for dual timestamps (LD-018-3) + ACK lineage (LD-018-9) |
| High | QFA-612-PAPER-01 | Paper-mode Rithmic adapter (ORDER_PLANT only); subordinated to spike outcome |
| High | QFA-614-PAPER-01 | Paper trading harness + mock broker simulator + broker test-env integration |
| High | QFA-616-QFA-618-GUARDS-01 | Failure taxonomy, reconnect state machine, dual liveness, kill-switch wiring, anomaly telemetry |
| Medium | QFA-615-LIVE-RECON-01 | PNL_PLANT live reconciliation; broker-vs-journal drift detection |
| Medium | QFA-620-SECRETS-01 | Vault-backed credential management; promotion-gate prerequisites |
| Medium | QFA-624 | Implement EXEC-VALIDATOR-01 through EXEC-VALIDATOR-08 (LD-018-14) |

Phase 6 entry sequence: QFA-622 and QFA-612-SPIKE-01 dispatch in
parallel. QFA-623 dispatches after QFA-622. The remaining tickets
dispatch per their dependency chain.

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Direct WebSocket feasibility underestimated | High | QFA-612-SPIKE-01 is a formal go/no-go gate; ADR-0018-A1 amendment path for fallback |
| Paper/live boundary leak | High | Execution capability mask (LD-018-13) fails closed; runtime guard + validators; mask drift blocks new submission per LD-018-19 |
| Dual timestamp incomplete on broker events | High | EXEC-VALIDATOR-02 rejects events missing either timestamp |
| Reconnect policy under-calibrated | Medium | Full retry-budget math published in config + emitted to journal at session start (LD-018-6); recommended values yield ~91s worst case |
| Failure taxonomy hides auth urgency | Medium | Subreason field preserves auth granularity within top-level network class (LD-018-5) |
| Validator domain mixing | Medium | New EXEC-VALIDATOR family (LD-018-14); REL-01D/01E remain scoped to data-feature surfaces |
| Opaque execution mask state | Medium | LD-018-19 requires both journal event + live diagnostics surface; QFA-617 operator console display contract specified |
| Mask drift undetected | Medium | EXEC-VALIDATOR-07 detects + alerts + blocks new submission (LD-018-19) |

## References

- ADR-0003 (MBO action taxonomy and promotion policy)
- ADR-0013/0014/0015 (regime substrate; preserved through Phase 6
  as snapshot context)
- ADR-0016 (alpha decision criteria; locked across cycles 1-3)
- ADR-0022 (regime-conditional entry/exit gating)
- ADR-0023 (Cycle3 SignedShockMeasurement + anti-pattern lock)
- DATA-MBO-03 (feature availability mask v5 precedent for sibling
  execution mask)
- DATA-03-FEATURE-AVAILABILITY-MASK (general mask design;
  documentation typo `accepted_normalized_actions` vs
  `accepted_normalized_action_literals` to be patched in separate
  P3 docs ticket, not part of this ADR)
- docs/research/qfa-611-cycle3-closure-memo.md (Phase 5 closure;
  Phase 6 dispatch authorization)
- CF-30 + CF-41 + CF-44 (anti-tuning / anti-drift across cycles)
- CF-45 (ADR threshold revisions require external justification)
- CF-50 (`npm run build` mandatory pre-push)
- CF-52 (paper-observation window non-negotiable based on in-sample
  numbers alone)

## Voting record

All 19 locked decisions (LD-018-1 through LD-018-19) accepted on
coordinator review with three independent verifications:

1. **Walkthrough draft** (12 questions, 12 recommendations): all
   accepted as written.
2. **First independent review** (architectural soundness +
   control-plane gap identification): introduced execution
   capability mask (LD-018-13), execution validator family
   (LD-018-14), subreason-tagged failure taxonomy (LD-018-5), ACK
   lineage validator (LD-018-9 + EXEC-VALIDATOR-03), dual-timestamp
   schema validator (LD-018-3 + EXEC-VALIDATOR-02), session
   manifest journaling (LD-018-15), eight-ticket dispatch surface,
   six-risk register.
3. **Second independent review** (path-precision + observability):
   tightened LD-018-4 + LD-018-6 to be path-agnostic; corrected
   reconnect math to ~91s; added LD-018-19 (operator-visible mask
   state) with EXEC-VALIDATOR-07; reaffirmed sibling-mask framing
   with verified DATA-MBO-03 v5 hash citation.
4. **Third independent review** (deep source verification +
   refinement): verified DATA-MBO-03 mask v5 hash
   (`sha256:2846f34c38c6d5f1b69979adb3a54165462e96e46440b3ffd7fdf96383333ff0`);
   broadened LD-018-13 capability enum + scoping surfaces + health
   gates; added structured `ExecutionCapabilityDecision` return
   type; added explicit unknown-default fail-closed clause; added
   mask-drift-blocks-submission to LD-018-19; added operator
   console display contract to LD-018-19; added EXEC-VALIDATOR-08
   for TS/Python parity; noted TS/Python asymmetry per DATA-MBO-03
   precedent.

All three reviewers independently converged on the same shape:
same governance pattern as DATA-MBO-03, separate semantic family.

Coordinator decisions:
- Q-A: ticket naming convention uses QFA-6xx
  (`EXEC-SURFACE-01 → QFA-622`,
  `EXEC-AUDIT-01 → QFA-623`,
  `EXEC-VALIDATORS-01 → QFA-624`;
  `QFA-612-SPIKE-01` retained as sub-ticket of QFA-612).
- Q-B: reconnect math expressed as approximately 91 seconds
  (configurable; the structure is binding, the numeric values are
  not).

## Amendments

- **ADR-0018-A1** (commit pending) — Rithmic ORDER_PLANT broker
  sidecar. Amends LD-018-2 to lift the prohibition on Python
  sidecar architecture for Rithmic ORDER_PLANT specifically.
  Adopts vendor SDK (pyrithmic) + typed IPC + idempotency +
  reconciliation gate + phased paper/live progression. Live
  trading remains out of scope. See
  `docs/adr/ADR-0018-A1-rithmic-order-plant-broker-sidecar.md`.
