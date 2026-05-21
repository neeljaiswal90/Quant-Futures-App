# ADR-0018-A1: Rithmic ORDER_PLANT broker sidecar

## Status

Accepted

## Amends

ADR-0018 LD-018-2 (Direct Node/TS WebSocket implementation, subject
to feasibility spike). Specifically: the prohibition on "Python
sidecar for broker traffic" is lifted for Rithmic ORDER_PLANT.

## Context

ADR-0018 LD-018-2 mandated direct Node/TypeScript WebSocket
implementation for Rithmic broker traffic, conditional on a
feasibility spike. The spike (QFA-612-SPIKE-01, merged at `4243817`)
used a 945-LOC mock Rithmic WebSocket server; it validated the
architectural shape of a WebSocket-based integration but did not
exercise the real Rithmic R-Protocol. The PROCEED verdict was
conditional on a 6-point real-environment preflight against the
Rithmic test gateway.

Two preflight tickets executed against the real Rithmic test
environment and produced data points that the spike could not:

- **QFA-612-PREFLIGHT-01** (merged at `0d7b2f8`): real TICKER_PLANT
  auth + 300-second authenticated market-data run. The committed
  evidence pack references "the RProtocol SDK startup path" — i.e.,
  the project's existing TICKER_PLANT collector is already
  SDK-backed (the existing `market_data_sidecar/` runs against
  pyrithmic), not a from-scratch Node/TS implementation. Memo:
  `docs/research/qfa-612-preflight-01-real-env-evidence.md`.
- **QFA-612-PREFLIGHT-02** (merged at `0d7b2f8`'s child commit):
  built a minimal ORDER_PLANT preflight client and reached
  the real broker. The implementation used a 732-LOC Python module
  (pyrithmic SDK) orchestrated by a 207-LOC TS shim via
  `spawnSync`. ORDER_PLANT login failed with broker error
  `rp_code=['13', 'permission denied']`, but the implementation
  choice itself — a competent worker reaching for the vendor SDK
  under real delivery pressure — is the data point. Memo:
  `docs/research/qfa-612-preflight-02-order-plant-evidence.md`.

Both data points indicate that LD-018-2's original feasibility
assumption was made with insufficient real-protocol information.
The R-Protocol uses Google Protocol Buffers over WebSocket with
proprietary .proto definitions; implementing it from scratch in
Node/TS requires obtaining or deriving the .proto files from
Rithmic, generating bindings, implementing login challenge-response
specific to Rithmic's auth flow, implementing heartbeat handshake,
implementing reconnect with state recovery, implementing all
ORDER_PLANT lifecycle message types, handling protocol version
negotiation, and handling Rithmic's error taxonomy. Estimated
effort: 3-6 weeks of focused implementation plus 1-2 weeks of
debug iteration plus ongoing maintenance burden as Rithmic versions
the protocol.

The IPC overhead of a Python sidecar (0.5-2 ms local subprocess;
0.2-1 ms local domain socket) is materially smaller than the broker
+ exchange round trip (typically 50-200 ms for Rithmic
ORDER_PLANT). ORDER_PLANT is correctness-critical more than
microsecond-latency-critical. The existing
`services/market_data_sidecar/` already requires Python operationally;
adding a broker sidecar of similar shape is an incremental
operational cost, not a new architectural paradigm.

ADR-0018-A1 amends LD-018-2 for Rithmic ORDER_PLANT specifically,
adopting the Python sidecar + vendor SDK architecture and codifying
the safety constraints required to make that architecture safe for
broker execution.

## Locked decisions

### LD-018-A1-1: Scope of the amendment is Rithmic ORDER_PLANT only

This amendment applies exclusively to Rithmic ORDER_PLANT
integration.

The amendment does NOT:

- Change the existing `market_data_sidecar/` architecture (which
  already uses Python + pyrithmic for TICKER_PLANT and remains
  unchanged).
- Authorize Python sidecar architecture for future non-Rithmic
  broker integrations. Each new broker integration is decided on
  its own merits.
- Authorize PNL_PLANT or HISTORY_PLANT integration. Those plants
  remain phase-staged per ADR-0018 LD-018-1 and require their own
  ADR amendments.
- Authorize live-money trading. Live execution remains blocked
  until the LIVE-PROMOTION 8-gate review passes per ADR-0018.
- Authorize bypassing the `BrokerAdapter` interface from
  QFA-612-PAPER-01a.

### LD-018-A1-2: `BrokerAdapter` is the sole runtime boundary

The TypeScript runtime interacts with broker execution exclusively
through the `BrokerAdapter` interface defined in
`apps/strategy_runtime/src/execution/brokers/broker-adapter.ts`
(landed via QFA-612-PAPER-01a, merge `802cbc7`).

Specifically forbidden:

- No strategy, risk-gate, sizing, management, orchestration,
  observability, or operator-console module may call the Python
  broker sidecar directly via subprocess, IPC, gRPC, or any other
  channel.
- No code outside `apps/strategy_runtime/src/execution/brokers/`
  may import Python-bridge modules or invoke the sidecar.
- The sidecar IPC entry point and its TS adapter implementation
  live exclusively under `apps/strategy_runtime/src/execution/brokers/`.

The abstraction boundary is enforced by import-graph review at PR
time. A future EXEC-VALIDATOR or lint rule may add automated
enforcement (out of scope for this amendment).

### LD-018-A1-3: Typed, versioned IPC contract

The IPC contract between the TypeScript runtime and the Python
broker sidecar is typed and versioned. The contract is the
authoritative definition of broker-sidecar surface.

Required command message types (TS → Python):

- `submit_order`
- `cancel_order`
- `query_order`
- `subscribe_order_events`
- `request_position_snapshot`
- `request_reconciliation_snapshot`
- `heartbeat`
- `shutdown`

`replace_order` is reserved for a future amendment; not included
in V1.

Required event message types (Python → TS):

- `order_accepted`
- `order_rejected`
- `order_acknowledged`
- `order_partially_filled`
- `order_filled`
- `cancel_pending`
- `order_cancelled`
- `cancel_rejected`
- `broker_error`
- `connection_lost`
- `recovered`
- `position_snapshot`
- `reconciliation_snapshot`

Every command and event message includes:

- `schema_version` (integer; starts at 1, bumped on breaking changes)
- `run_id`
- `session_id`
- `client_order_id` (TS-generated, included on order commands)
- `correlation_id`
- `causation_id`
- `idempotency_key` (see LD-018-A1-4)
- `event_ts_ns` (UnixNs; sidecar wall-clock at message emit)
- `adapter_version` (string; sidecar implementation version)

`event_ts_ns` semantics match the QFA-623 `ts_ns_local` field —
the TS runtime captures `ts_ns_local` at message receipt and the
pair drives the QFA-626 SLI histograms (`qfa_order_ack_submission_ms`,
`qfa_order_ack_cancel_ms`).

Schema version mismatch between the runtime and the sidecar must
fail closed. The runtime must refuse to use a sidecar that reports
an incompatible `schema_version` and emit a `VALIDATOR_ISSUE` event
(per QFA-624 EXEC-VALIDATOR family) at session start.

### LD-018-A1-4: Idempotency on every order command

Every `submit_order` and `cancel_order` command carries a
deterministic `idempotency_key`. The key is derived such that
identical command intents produce identical keys; retries of the
same command produce the same key.

Sidecar behavior:

- On receipt of a command with a known `idempotency_key`, the
  sidecar does NOT submit a duplicate order to the broker. It
  returns the prior known outcome (the original ACK, rejection,
  or last-known terminal state).
- The sidecar maintains an idempotency cache scoped to the current
  session. The cache persists across sidecar restarts via the
  reconciliation snapshot (see LD-018-A1-5).

TS adapter behavior:

- The TS adapter persists command intent to the journal BEFORE
  sending the command to the sidecar. The intent journal entry
  carries the `idempotency_key`.
- On adapter restart, the adapter scans the journal for unACKed
  intents, reconstructs `idempotency_key`s, and queries the
  sidecar (which queries the broker) to determine actual state.
  See LD-018-A1-5 for the reconciliation flow.

The failure mode being prevented: TS adapter sends submission;
TS adapter crashes before receiving ACK; on restart, the adapter
must NOT re-send the order, because the broker may have already
accepted it. Idempotency keys + journaled intent allow the
adapter to determine: "was this order actually submitted, and
what's its current state?"

### LD-018-A1-5: Reconciliation gate on restart

On sidecar restart (cold start, warm restart after crash,
reconnect after broker-side disconnect), the sidecar:

1. Re-authenticates against the Rithmic gateway.
2. Queries the broker for all open orders associated with the
   account.
3. Queries the broker for current positions.
4. Publishes a `reconciliation_snapshot` event to the TS runtime.

The TS runtime:

1. Blocks new order submissions via
   `SubmissionGate.requestBlock('broker_reconciliation_in_progress')`
   (extends the QFA-628/629/616 multi-source gate with a new
   block source).
2. On receipt of `reconciliation_snapshot`, validates the
   snapshot against the journaled intent state.
3. Resolves divergences:
   - Orders the broker holds open that the runtime knows about
     → adopt broker state.
   - Orders the broker holds open that the runtime does NOT know
     about → escalation event; runtime stays in block; operator
     intervention required.
   - Orders the runtime knows about that the broker does NOT
     hold open → resolve via broker query (filled? cancelled?
     rejected?) and update journal.
4. Releases the submission block only after the snapshot is
   fully reconciled.

If reconciliation fails (sidecar unavailable, broker query
errors, divergence cannot be resolved):

- The submission gate remains blocked.
- An `ANOMALY_DETECTED` event is emitted (QFA-616 anomaly
  detector category) with severity `high`, which auto-engages
  the kill switch per QFA-616 LD-018-A1 anomaly rules.
- Operator intervention is required to clear the kill switch.

For the V1 paper-trading phase, if a programmatic flatten path
is not yet implemented, the reconciliation failure mode is "stay
blocked and surface to operator." Real-money flatten paths land
in a separate ADR.

New `SubmissionGate` block source: `'broker_reconciliation_in_progress'`.
Extends the union from QFA-616 (which had
`'quarantine' | 'slo_halt' | 'reconnect_in_progress' | 'kill_switch'`)
to:
`'quarantine' | 'slo_halt' | 'reconnect_in_progress' | 'kill_switch' | 'broker_reconciliation_in_progress'`.

### LD-018-A1-6: Phased paper/live progression

Broker integration progresses through explicit phases. Each phase
is its own ticket with its own merge gate. Phases are sequenced;
no phase may be skipped or merged ahead of its predecessor.

| Phase | Scope | Merge gate |
|---|---|---|
| **Phase 1 — Sidecar bring-up** | Python sidecar scaffold; auth + heartbeat against Rithmic test gateway; no order submission | Sidecar starts cleanly; auth succeeds; heartbeat stable ≥ 5 min |
| **Phase 2 — IPC contract** | Typed IPC contract definitions + TS adapter IPC client + schema validators | All message types defined; schema version check works; malformed IPC rejected |
| **Phase 3 — Paper ORDER_PLANT lifecycle** | submit / cancel / ACK / reject / fill against Rithmic paper test env | All 4 lifecycle paths demonstrated end-to-end; net position invariant zero |
| **Phase 4 — Reconciliation + recovery** | Restart-survives reconciliation; idempotency cache; divergence resolution | Sidecar restart cycle preserves state; idempotency replay verified |
| **Phase 5 — Safety validators** | Broker-side EXEC-VALIDATOR family extensions; import-graph enforcement of BrokerAdapter boundary | All safety validators pass on synthetic + real test sessions |
| **Phase 6 — Paper trading integration** | Full paper trading harness operational against real broker | ≥ 2 weeks of paper trading produces ratification data for QFA-631 |
| **Phase 7 — Live pilot** | Limited live-money execution | **Out of scope**: requires separate ADR + LIVE-PROMOTION 8-gate review |

Real-money execution (Phase 7) remains explicitly blocked. This
amendment does NOT authorize live trading.

### LD-018-A1-7: Enumerated sidecar failure states

The sidecar's failure-state taxonomy is enumerated and journaled.
Each state maps to a TS runtime response.

| Sidecar state | Cause | Runtime response |
|---|---|---|
| `sidecar_unavailable` | Sidecar process not running; IPC channel dead | Block all new submissions; emit `ANOMALY_DETECTED` high-severity; engage kill switch |
| `broker_disconnected` | Sidecar reachable; broker socket dropped | Block new submissions; await reconnect via LD-018-A1-5 path; surface to operator after 60s |
| `auth_denied` | Broker rejected credentials | Block all submissions; engage kill switch; surface fatal error to operator; require credential reprovision + operator commit to disengage |
| `order_submit_rejected` | Broker rejected a specific order | Journal as `ORDER_BROKER_REJECT` per QFA-623 schema; QFA-616 anomaly detector counts rejects; high-severity threshold triggers kill switch |
| `order_status_unknown` | Sidecar cannot determine an order's broker-side state | Order enters `quarantined` per QFA-628 state machine; runs through synchronous reconciliation; operator intervention if reconciliation `unknown` |
| `position_reconciliation_failed` | Reconciliation snapshot cannot be resolved | Submission gate stays blocked; kill switch engaged; operator intervention required |
| `duplicate_command_detected` | TS adapter sent a command with a known idempotency_key | Sidecar returns prior outcome; adapter logs the detection but does NOT treat as error |
| `schema_version_incompatible` | TS runtime and sidecar disagree on IPC schema version | Refuse to start session; emit `VALIDATOR_ISSUE` fatal; require alignment before retry |

Each state maps to either an existing event type
(`ORDER_BROKER_REJECT`, `ANOMALY_DETECTED`, `VALIDATOR_ISSUE`,
`KILL_SWITCH_ENGAGED`) or to a new additive event type to be
defined in the Phase 2 IPC contract ticket.

### LD-018-A1-8: Secrets discipline

Broker credentials follow QFA-620's CredentialResolver model:

- Loaded only from the credential-resolver path (env-var backend
  for paper; vault backend for live promotion).
- **Never** appear in: stdout, stderr, IPC frames, journal events,
  console snapshots, log files, error messages, exception traces,
  test fixtures, sample evidence files, or PR-description text.
- The PREFLIGHT-01/02 redactor patterns
  (`scripts/preflight/qfa-612-paper-01b/redactor.ts`) apply to all
  broker-sidecar output. The redactor is the source of truth for
  pre-commit log scrubbing.

Sidecar boot sequence:

- Load credentials from the resolver-determined source.
- Authenticate to the broker.
- Emit a redacted boot identity message (see LD-018-A1-9).
- Never echo, log, or include the credential values in any
  subsequent emission.

Pre-merge enforcement: a `redactor.test.ts` regression test
verifies that canned credential-shape strings do not survive
through the redactor. Any new sidecar-emission category must add a
corresponding redactor pattern + test fixture.

### LD-018-A1-9: Vendor SDK + adapter version pin + boot identity log

The vendor SDK (`pyrithmic`) version is pinned in the Python
sidecar's dependency manifest. Version drift is treated as a
deliberate decision requiring a separate PR; floating versions
are forbidden.

At sidecar startup, the sidecar emits a structured boot identity
record to the TS runtime via an IPC `boot_identity` message:

- `adapter_version`: sidecar implementation version (semver).
- `sdk_name`: `'pyrithmic'`.
- `sdk_version`: pinned version string.
- `protocol_environment`: `'rithmic_test' | 'rithmic_paper' | 'rithmic_live'` (live forbidden in this amendment's scope).
- `gateway_url_redacted`: redacted gateway URL string.
- `boot_ts_ns`: UnixNs at sidecar process start.
- `process_id`: sidecar OS process ID.

Credentials are NEVER in this message.

The TS runtime journals the boot identity message and includes it
in the session manifest (QFA-614 `SESSION_MANIFEST` payload) at
session start. EXEC-VALIDATOR-06 (session manifest completeness)
verifies the boot identity fields are present.

### LD-018-A1-10: IPC latency measured, not assumed

The amendment's rationale assumes IPC overhead is immaterial
relative to broker round-trip latency. The Phase 1 / Phase 2
implementation must validate this empirically:

- The sidecar measures and emits its own IPC turnaround time for
  every command/event pair (sidecar-side send → sidecar-side
  receive of response, where applicable).
- The TS runtime measures end-to-end command-to-event time via
  the existing QFA-626 `BoundedAckLatencyObserver`.
- Both measurements emit into the QFA-626 SLI histogram family
  with metric names:
  - `qfa_broker_sidecar_ipc_ms` (sidecar-internal IPC time)
  - `qfa_broker_command_to_event_ms` (full round trip including
    broker; this is essentially the QFA-626
    `qfa_order_ack_submission_ms` histogram with the sidecar
    path)

If the measured IPC overhead exceeds 5 ms p95 over a 1-hour
window, the assumption is invalidated and ADR-0018-A2 amendment is
required. Below 5 ms p95 sustained, the assumption holds.

Phase 1 / Phase 2 dispatch tickets require these histograms to
be wired before merge. The 5 ms threshold itself is provisional
per ADR-0020 LD-020-03 and ratified post-paper-telemetry in
QFA-631.

## What ADR-0018-A1 does NOT do

- Does NOT change `market_data_sidecar` architecture or its
  pyrithmic dependency.
- Does NOT authorize PNL_PLANT, HISTORY_PLANT, or live-mode
  execution. Each requires its own ADR / amendment.
- Does NOT decide future non-Rithmic broker integration
  architecture.
- Does NOT modify ADR-0018 LDs 1, 3-19 (only LD-018-2 is
  amended).
- Does NOT modify ADR-0020 (latency SLA policy) — the broker
  sidecar work consumes QFA-620 / QFA-626 / QFA-628 / QFA-629
  read-only beyond the additive `'broker_reconciliation_in_progress'`
  block source and the additive `qfa_broker_*` metric names.
- Does NOT modify QFA-623 schema (the broker events emitted from
  the sidecar use the existing v2 envelope + payload definitions
  from QFA-623). New IPC-contract message types are sidecar-internal,
  not journal-event-types.
- Does NOT touch strategy logic, regime substrate, or
  ADR-0016/0022/0023 thresholds.
- Does NOT ratify final IPC latency budgets (provisional per
  LD-020-03).
- Does NOT ratify final reconciliation timeout values
  (provisional per LD-020-03).
- Does NOT pin Rithmic protocol-version constants — those track
  whatever pyrithmic exposes at the pinned SDK version.

## Consequences

ADR-0018-A1 dispatches the following implementation tickets,
sequenced per LD-018-A1-6's phased progression. The original
`QFA-612-PAPER-01b` dispatch is **restructured**: it is no longer
a single multi-week ticket but the Phase 6 capstone of a six-ticket
chain.

| Phase | Ticket | Scope |
|---|---|---|
| 1 | **QFA-612-BROKER-01** | Python sidecar scaffold: process boot, credential load, auth handshake, heartbeat, IPC boot identity. No order submission. |
| 2 | **QFA-612-BROKER-00** | IPC contract definitions: command + event message types, schema version handling, schema validators, contract tests. Lands either before or in parallel with QFA-612-BROKER-01 (the contract is independent of the protocol implementation). |
| 2 | **QFA-612-BROKER-02** | TS BrokerAdapter IPC client implementing `BrokerAdapter` against the contract. Includes sidecar-unavailable handling, malformed-IPC handling, schema version check. |
| 3 | **QFA-612-BROKER-03** | Paper ORDER_PLANT submit / cancel / ACK / reject / fill lifecycle against Rithmic paper test gateway. Real preflight evidence required (mirrors PREFLIGHT-02 evidence pattern). |
| 4 | **QFA-612-BROKER-04** | Reconciliation + recovery: restart cycle, idempotency cache, divergence resolution, `broker_reconciliation_in_progress` gate source. |
| 5 | **QFA-612-BROKER-05** | Broker safety validators: import-graph enforcement, duplicate `client_order_id` detection, unknown-state-blocks-submission, real-order-mode-requires-explicit-config, paper-mode-default. |
| 6 | **QFA-612-PAPER-01b** | Paper trading integration capstone: full paper-trading harness wired to the real broker sidecar; manual operator opt-in; REL-style journal validation; operator console reflects broker state. **Replaces the original single-PR QFA-612-PAPER-01b dispatch.** |
| 7 | (deferred) | Live pilot — out of scope; requires its own ADR + LIVE-PROMOTION 8-gate review. |

Phase ordering:

```
QFA-612-BROKER-00 (contract) ──┐
                                ├── QFA-612-BROKER-02 (TS adapter)
QFA-612-BROKER-01 (scaffold)  ──┘                ↓
                                          QFA-612-BROKER-03 (lifecycle)
                                                 ↓
                                          QFA-612-BROKER-04 (recon)
                                                 ↓
                                          QFA-612-BROKER-05 (validators)
                                                 ↓
                                          QFA-612-PAPER-01b (capstone)
```

QFA-612-BROKER-00 and QFA-612-BROKER-01 may dispatch in parallel
because the contract is sidecar-implementation-agnostic. The
remaining phases are strictly sequential.

Phase 3 (QFA-612-BROKER-03) is the de facto rerun of
PREFLIGHT-02's items 4-5 + 1-2-orders-upgrade + 6-upgrade, but
embedded in a production code path rather than a one-shot script.
Its merge gate is equivalent to PREFLIGHT-02 returning PROCEED.
**A successful Phase 3 merge supersedes the standalone PREFLIGHT-02
rerun requirement**: the QFA-612-BROKER-03 PR's own evidence pack
demonstrates items 4-5 against real broker, fulfilling the original
preflight contract.

Phase 6 (QFA-612-PAPER-01b) entry requires:
- All prior phases merged.
- ORDER_PLANT permission provisioned on the Rithmic test account
  (current operational blocker per PREFLIGHT-02 memo).
- LIVE-PROMOTION 8-gate review still strictly forbids real-money
  execution.

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Dual-language broker path increases operational complexity | Medium | Mirrors existing `market_data_sidecar` pattern; ops cost is incremental, not novel |
| IPC failure modes (pipe disconnects, parse errors, partial messages) | Medium | Typed IPC contract (LD-018-A1-3); enumerated failure states (LD-018-A1-7); schema version check fails closed |
| Duplicate order submission on adapter restart | High | Idempotency keys (LD-018-A1-4); journaled intent before send; reconciliation gate on restart (LD-018-A1-5) |
| Position truth divergence between runtime and broker | High | Synchronous reconciliation snapshot on restart; submission blocked until resolved; kill switch on failure |
| Pyrithmic version drift breaks broker integration | Medium | SDK version pinned (LD-018-A1-9); boot identity log surfaces drift via session manifest |
| IPC latency assumption invalidated | Medium | Empirical measurement required (LD-018-A1-10); 5 ms p95 threshold triggers ADR-0018-A2 |
| Strategy or risk code bypasses BrokerAdapter | High | Import-graph review at PR time; Phase 5 adds programmatic safety validators (LD-018-A1-2 + QFA-612-BROKER-05) |
| Credential leakage via sidecar logging | Critical | Redactor reuse (LD-018-A1-8); pre-merge regression test on canned credential-shape strings; boot identity message is the only credential-adjacent IPC and it is redacted at construction |
| Pyrithmic protocol-version mismatch with Rithmic gateway | Medium | Pinned SDK version; gateway environment in boot identity log; auth-denied state engages kill switch |
| Sidecar process crashes mid-session | Medium | Reconciliation gate on restart; idempotency cache survives via journaled intent; submission gate blocks until restored |
| Direct Node/TS implementation later becomes feasible | Low | `BrokerAdapter` interface is the abstraction boundary; a future TS-direct implementation is a sibling `BrokerAdapter` impl with no upstream changes |

## References

- ADR-0018 (parent — Rithmic R-Protocol integration shape)
- ADR-0020 (latency SLA + SLO policy)
- QFA-612-SPIKE-01 — feasibility spike (mock-only); commit `4243817`
- QFA-612-PREFLIGHT-01 — real-environment TICKER_PLANT evidence; commit `0d7b2f8` parent
- QFA-612-PREFLIGHT-02 — real-environment ORDER_PLANT auth-deny evidence; commit `0d7b2f8` child
- QFA-612-PAPER-01a — `BrokerAdapter` interface + mock adapter; merge `802cbc7`
- QFA-614-PAPER-01 — paper trading harness; merge `776161c`
- QFA-616-QFA-618-GUARDS-01 — operational safety hardening (`SubmissionGate` multi-source); merge `57252f1`
- QFA-620-SECRETS-01 — credential resolver; merge `e74602d`
- QFA-623 — journal schema v2 + ACK lineage; merge `ddf5655`
- QFA-624 — execution validator family; merge `aa71c98`
- QFA-626 — latency SLI registry; merge `4d6f19d`
- QFA-627 — burn-rate evaluator; merge `ae9c14b`
- QFA-628 — quarantine state machine; merge `a905cbc`
- QFA-629 — `SubmissionGate` multi-source; merge `e9cb91a`
- CF-30 + CF-41 (anti-tuning / anti-drift across cycles)
- CF-45 (ADR threshold revisions require external methodological
  justification)
- CF-50 (`npm run build` mandatory pre-push)

## Voting record

Single coordinator decision after a structured LD-018-2
re-evaluation conversation:

1. **Two variants considered**: A1-strict (decisive: Rithmic
   ORDER_PLANT uses Python sidecar) vs A1-soft (permissive:
   bridge allowed where direct is "not feasible"). A1-strict
   selected for decisiveness; A1-soft rejected for ambiguity.
2. **Ten safety additions required** before acceptance, all
   incorporated as LD-018-A1-1 through LD-018-A1-10:
   - Scope narrowness (Rithmic ORDER_PLANT only)
   - BrokerAdapter as sole runtime boundary
   - Typed versioned IPC contract
   - Idempotency on every command
   - Reconciliation gate on restart
   - Phased paper/live progression (live remains out of scope)
   - Enumerated failure states
   - Secrets discipline + redactor enforcement
   - Vendor SDK version pin + boot identity log
   - Latency measured, not assumed (5 ms p95 threshold)
3. **Implementation backlog restructured**: original single
   QFA-612-PAPER-01b dispatch replaced with a six-ticket phased
   chain (QFA-612-BROKER-00 through QFA-612-BROKER-05, then
   QFA-612-PAPER-01b as the capstone).

Coordinator additions to the original draft amendment:

- A1-strict selected over A1-soft.
- All 10 safety constraints from coordinator review folded in
  verbatim.
- Phase 3 (QFA-612-BROKER-03) explicitly identified as the
  de-facto rerun of PREFLIGHT-02 items 4-5, satisfying the
  original preflight contract via Phase 3's own evidence pack.
- Live-pilot phase (Phase 7) explicitly deferred out of scope.

## Amendments

(None at acceptance. Future amendments listed here as
ADR-0018-A1-B1, A1-B2, etc., or as a new sibling
ADR-0018-A2 / A3 if the next amendment scope is broader than a
single LD-018-A1-N refinement.)
