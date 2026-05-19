# ADR-0020: Order latency SLA and internal SLO policy

## Status

Accepted

## Context

Phase 5 closed at commit `e985b10` with the first project-history
ADVANCE_TO_PAPER verdict (`regime_shock_reversion_short_v2`).
ADR-0018 (commit `0bf3bab`) locked the Rithmic R-Protocol integration
shape. ADR-0020 was deliberately sequenced after ADR-0018 because a
latency budget is meaningful only once the protocol round-trip
behavior is locked.

ADR-0020 defines the measurement and action policy for execution
latency: which signals are externally visible commitments, which
signals are internal operational targets, how each signal is
measured, how breach is detected, how breach is handled, and how
budgets are ratified.

The current repository's execution plane is **simulated**. There is
no live order-ACK lifecycle in `main` today. ADR-0018 defines the
integration shape; the actual ACK round-trip path lands with Phase 6
(QFA-623 journal extension plus the broker session work that
follows). ADR-0020 must therefore distinguish between signals that
are measurable today on local clocks (strategy-decision compute,
event-loop lag) and signals whose source does not yet exist in
`main` (order-ACK round trip, snapshot-to-submit). This distinction
is encoded in LD-020-01 (terminology) and LD-020-03 (provisional
budgets).

ADR-0020 also corrects a measurement defect identified in the
walkthrough: the originally proposed formula
`candidate.proposed_ts_ns - snapshot.created_ts_ns` collapses to
zero in the current runtime because both timestamps are stamped from
`snapshot.created_ts_ns` at the same moment. The replacement uses
Node's `perf_hooks.performance.now()` to measure actual compute
duration (LD-020-02), paired with an event-loop lag companion SLI
(LD-020-04) so that a fast strategy in a blocked event loop cannot
falsely report green.

## Definitions

- **SLA (Service Level Agreement)**: externally facing commitment
  whose breach has operational consequence (page, halt, broker
  escalation). In ADR-0020, the only SLA surface is the order-ACK
  round trip (LD-020-01).
- **SLO (Service Level Objective)**: internal operational target
  used for burn-rate alerting, weekly review, and capacity
  planning. SLO breach does not page and does not halt unless
  explicitly chained to a halt rule.
- **SLI (Service Level Indicator)**: the raw histogram or counter
  feeding both SLAs and SLOs. Multiple SLIs may exist per SLO.
- **Submission ACK**: broker confirms the order was received and is
  now resting or working. This is the milestone bound by the
  order-ACK SLA (LD-020-12).
- **Fill ACK**: broker confirms partial or full fill. Bounded by
  market dynamics, not by the trading-system pipeline. Tracked as
  an SLI; no SLA.
- **Cancel ACK**: broker confirms cancel was processed. Tracked as
  its own SLI with its own budget (LD-020-12, follow-up QFA-632).
- **insufficient_data**: SLO window state distinct from `pass` and
  `breach`, used when sample count falls below the minimum required
  for percentile statistics to be meaningful (LD-020-05,
  LD-020-13).
- **quarantine**: order state entered when an expected ACK does not
  arrive within budget. Quarantined orders do not assume failure;
  they require synchronous reconciliation against broker truth
  before any state transition (LD-020-07).
- **would_halt**: paper-mode event emitted when halt logic would
  have fired in live mode, surfaced to the same SLO surface and
  dashboards as live, without actually suppressing submission
  (LD-020-08).

## Locked decisions

### LD-020-01: Order-ACK is the only external SLA surface

The order-ACK round trip (intent submission to submission-ACK
receipt) is the only metric in ADR-0020 classified as an SLA. All
other latency metrics — strategy-decision compute, snapshot-to-
submit, queue depth, event-loop lag, cancel-ACK round trip — are
internal SLOs.

The distinction is operational, not cosmetic:

- SLA breach is page-eligible and may chain to halt (LD-020-06,
  LD-020-07).
- SLO breach surfaces on dashboards and weekly burn-rate review.
  SLO breach does not page and does not halt unless explicitly
  chained.

This prevents internal compute metrics from being treated as
broker-facing paging targets and prevents the surface area of
external commitments from drifting upward by accident.

### LD-020-02: Strategy-decision SLO uses locally measured compute duration

Strategy-decision latency is measured with Node's monotonic clock
inside the runtime, bracketing the actual compute path:

```
decision_start_ms = performance.now() at strategy entry
decision_end_ms   = performance.now() at candidate emit
sli.strategy_decision_ms = decision_end_ms - decision_start_ms
```

`performance.now()` returns a high-resolution floating-point
millisecond timestamp; it does not return nanoseconds. If the
journal event schema requires nanosecond integer fields,
`process.hrtime.bigint()` is used instead, with conversion at the
emission boundary.

The originally proposed formula
`candidate.proposed_ts_ns - snapshot.created_ts_ns` is explicitly
withdrawn. In the current runtime both timestamps are stamped from
`snapshot.created_ts_ns` at the same moment, so the difference
collapses to zero and the SLO would always pass. The local
monotonic measurement above is the canonical definition.

### LD-020-03: Order-ACK and snapshot-to-submit budgets are provisional

The order-ACK SLA budget and the snapshot-to-submit SLO budget are
**provisional** until at least 2 weeks of paper telemetry produce
empirical distributions. Until that telemetry exists:

- Placeholder budget values live in this ADR as targets.
- Alerts run in **alert-only mode**: fire to dashboard and weekly
  review, do not page, do not halt.
- Final budget values are ratified via an **ADR edit commit**
  citing the paper telemetry distribution and the rationale, not
  via PR-description drift or merge-time comment.
- This ratification path follows CF-45: ADR threshold revisions
  require external methodological justification, not retrospective
  rationalization.

Additionally, per LD-020-01 framing: until the Phase 6 live/paper
broker ACK lifecycle is merged, the order-ACK SLA is **not breach-
eligible** and must not trigger halt, page, or operational failure
states. It may be shown only as an observational target or as a
`not_applicable` state on the operator console. Accidental
enforcement before the metric source exists is forbidden.

### LD-020-04: Strategy-decision SLO target is 25 ms p95 with event-loop-lag companion

Strategy-decision SLO target: **p95 ≤ 25 ms** measured per
LD-020-02.

The SLO is considered satisfied only when **both** of the
following are green within the evaluation window:

- `sli.strategy_decision_ms` p95 ≤ 25 ms.
- `sli.event_loop_lag_ms` p95 below its companion threshold
  (provisional, ratified per LD-020-03).

This prevents the failure mode where strategy compute is fast but
the event loop is blocked by an unrelated task — the candidate
emits late on wall-clock time, but the strategy-decision metric
alone would falsely report green.

Event-loop lag is captured via Node's
`perf_hooks.monitorEventLoopDelay()` and exported as its own
histogram alongside the strategy-decision histogram.

### LD-020-05: Burn-rate windows require minimum sample counts

Multi-window burn-rate alerting is used for SLO evaluation
(typical pairing: 5-minute fast window with 1-hour slow window).
Each window requires a per-metric minimum sample count `N` before
percentile statistics are evaluated.

Below `N`, the window emits `insufficient_data` (LD-020-13)
rather than `pass` or `breach`. The sample-count table below uses
`TBD pending paper telemetry` for metrics whose natural arrival
rate is not yet known empirically:

| Metric                     | 1-min N | 5-min N | 15-min N |
|----------------------------|---------|---------|----------|
| order_ack_submission       | TBD     | TBD     | TBD      |
| order_ack_cancel           | TBD     | TBD     | TBD      |
| snapshot_to_submit         | TBD     | TBD     | TBD      |
| strategy_decision          | TBD     | TBD     | TBD      |
| event_loop_lag             | n/a     | n/a     | n/a      |

`event_loop_lag` is sampled continuously by
`monitorEventLoopDelay()` and is always-on; it does not have a
sparse-arrival problem and therefore does not need a sample-count
floor. The remaining metrics are ratified with their `N` values
in the post-paper telemetry packet (QFA-631) via ADR edit per
LD-020-03.

### LD-020-06: Halt suppresses new submissions only

The latency-driven halt action suppresses **new order submission**.
It does not protect existing positions and does not modify resting
orders. Specifically:

- In-flight orders remain in the broker's hands until ACK, timeout,
  or reconciliation resolves them (LD-020-07).
- Resting orders, partial fills, and existing positions remain
  subject to broker-native protective orders (server-side stops,
  bracket OCO) attached at entry.
- The trading system relies on Phase 6 broker-native protective
  orders for in-flight position safety; the halt mechanism is not
  a substitute.

This caveat is included verbatim in the operator runbook and the
QFA-617 console copy.

### LD-020-07: ACK timeout enters synchronous quarantine and reconciliation

On submission-ACK timeout, the order does **not** auto-cancel.
Auto-cancel was explicitly considered and rejected because it
creates a position-truth failure mode: cancelling an order the
broker has already filled leaves the system short a position it
believes it does not have.

The locked policy is:

1. **Quarantine**: the order transitions to `quarantined` state in
   the runtime journal.
2. **Halt new submissions**: while `quarantine_count > 0`, new
   order submission is halted to prevent compounding.
3. **Synchronous reconciliation**: the runtime queries broker
   order status synchronously before any further state transition.
   The broker is the source of truth.
4. **Conditional cancel**: only if reconciliation returns `pending`
   does the runtime issue a cancel. If reconciliation returns
   `filled` or `partial`, the order is adopted into journaled
   state at the broker-reported terms.
5. **Resume**: new submission resumes only after quarantine clears
   (all quarantined orders have reconciled and journal state
   matches broker state).

Throughput cost is accepted as a design property: a quarantined
order means the system no longer knows broker truth for that order,
and new submissions must stop until that truth is restored.

### LD-020-08: Paper emits would_halt instead of enforcing halt

In paper mode, halt logic is fully exercised but does not actually
suppress submission. Specifically:

- When the live halt condition would fire, paper emits a
  `would_halt` event to the same SLO surface and the same
  operator-console panel as live.
- The `would_halt` event payload is identical to the live `halt`
  event payload (same fields, same lineage).
- Submission is **not** suppressed in paper.

This ensures paper telemetry and live telemetry are directly
comparable, that halt logic is exercised before any live
promotion, and that operators see halt behavior in paper before
trusting it in live.

`would_halt` is also used in early Phase 6 live runs that
predate full SLO ratification, per LD-020-03 alert-only mode.

### LD-020-09: p95 is computed over the full distribution including outliers

Two-track reporting is used:

- **Track A**: full distribution, all standard percentiles
  (p50 / p95 / p99 / max). This is the canonical SLI/SLO surface.
- **Track B**: annotated overlay of known operational events
  (deploys, reconnects, market-wide volatility spikes) for
  diagnostic context only. Track B is never used to mask the
  underlying numbers.

Outliers are **not excluded** from p95 under any operational
mode. Excluding outliers defeats the purpose of percentile
measurement: outliers are exactly what p95 is designed to
surface, and SLA/SLO breaches caused by outliers are real
operational events that must be visible.

### LD-020-10: Latency metrics use Prometheus histograms and recording rules

All latency metrics are exported as **Prometheus histograms**,
not summaries and not pre-computed gauges. Rationale:

- Histograms preserve raw bucket counts, so percentiles can be
  recomputed across any window without re-aggregation and without
  the loss-of-information that summaries impose.
- Percentiles (p50/p95/p99) are derived via Prometheus
  **recording rules** at query time, not pre-computed at write
  time.
- Counters track halt events, quarantine entries, reconciliation
  outcomes, and `would_halt` emissions.
- The operator console (QFA-617, QFA-630) reads from the
  recording-rule outputs rather than raw histogram streams, so
  dashboard performance stays bounded.

Histogram bucket boundaries are configured per metric in the
QFA-626 dispatch and ratified post-paper alongside the budget
ratification packet (QFA-631).

### LD-020-11: Economics framing is qualitative until telemetry ratification

The ADR's economic justification for latency budgets is
qualitative only, until paper telemetry permits a quantitative
ratification:

> Latency budgets bound adverse selection and slippage risk to
> levels consistent with the strategy's edge structure.
> Quantitative budget ratification is deferred to post-paper
> telemetry (QFA-631) per CF-45.

Quantitative arguments from earlier drafts (trade-count
arithmetic, tick-value gross-win calculations) are explicitly
removed. Re-introducing them requires a methodologically sound
cost-of-latency model published in a separate research artifact
and cited by an ADR edit.

### LD-020-12: ACK milestone definitions are separate

ADR-0020 distinguishes three ACK milestones:

- **Submission ACK** — broker confirms the order was received and
  is now resting or working. **This is the milestone bound by the
  order-ACK SLA (LD-020-01).**
- **Fill ACK** — broker confirms partial or full fill. Bounded by
  market dynamics (price discovery, queue position, marketable
  intent), not by the trading-system pipeline. Tracked as an SLI
  for diagnostics and post-trade analysis. **No SLA.**
- **Cancel ACK** — broker confirms cancel was processed. Tracked
  as its own SLI with its own budget (typically tighter than
  submission ACK because no matching is required). Cancel-ACK
  timeout enters the same quarantine/reconciliation path as
  submission-ACK timeout (LD-020-07). Cancel-ACK SLI and budget
  are dispatched as QFA-632.

The SLA, SLO budgets, alert rules, and halt chains are scoped to
the specific milestone in their identifier — never to the generic
word "ACK" — to prevent ambiguous breach evaluation.

### LD-020-13: insufficient_data is distinct from pass and breach

When a measurement window has fewer than `N` samples (per
LD-020-05), the SLO window emits **`insufficient_data`** as its
state, distinct from `pass` and `breach`:

- `insufficient_data` does **not** trigger alerts.
- `insufficient_data` does **not** auto-pass; it surfaces on the
  operator console as its own state with its own color.
- Sustained `insufficient_data` across a longer enclosing window
  (default 24 hours) is itself an alert: it indicates either
  unexpectedly low traffic or broken instrumentation. The
  enclosing-window threshold and alert routing are dispatched in
  QFA-627.

This prevents two failure modes:

- A quiet hour silently "passing" a tight budget that has zero
  traffic, masking an upstream-pipeline outage.
- An overly noisy alert path firing on every low-traffic minute
  during normal market closes.

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Order-ACK SLA enforced before Phase 6 ACK lifecycle exists | High | LD-020-03 explicitly forbids breach-eligibility until ACK lifecycle merges; alerts in alert-only mode; `not_applicable` console state |
| Strategy-decision SLO false-green due to event-loop block | High | LD-020-04 requires event-loop-lag companion SLI green for SLO pass |
| Strategy-decision measurement collapse to zero | High | LD-020-02 withdraws the snapshot-timestamp formula and locks `performance.now()` local timing |
| Auto-cancel of broker-filled order corrupts position truth | High | LD-020-07 replaces auto-cancel with synchronous quarantine + reconciliation; halt new submissions while quarantine non-empty |
| Halt mistaken for in-flight position protection | High | LD-020-06 caveat published in runbook + operator console |
| Outlier exclusion masks real SLA breaches | Medium | LD-020-09 forbids outlier exclusion; Track B annotations are overlay-only |
| Paper halt drift from live | Medium | LD-020-08 `would_halt` exercises identical halt logic + payload in paper |
| Quiet-window false-pass | Medium | LD-020-13 `insufficient_data` state + sustained-insufficient-data alert |
| Budget ratification drift in PR description | Medium | LD-020-03 requires ADR edit commit for ratification per CF-45 |
| Histogram bucket misconfiguration | Low | Bucket boundaries dispatched in QFA-626 and ratified in QFA-631 |

## What ADR-0020 does NOT do

- Does NOT define the Phase 6 broker ACK lifecycle implementation
  (QFA-623 scope; ADR-0018 LD-018-3 + LD-018-9 supply the schema
  shape).
- Does NOT specify halt-chain thresholds for non-latency causes
  (kill-switch, anomaly detection — QFA-616 + QFA-618 scope).
- Does NOT pin Prometheus bucket boundaries, recording-rule
  expressions, alert routing, or paging policy (QFA-626 + QFA-627
  + QFA-630 scope).
- Does NOT specify the operator console UI for SLO panels
  (QFA-630 scope).
- Does NOT ratify final order-ACK or snapshot-to-submit budgets;
  those land in QFA-631 via ADR edit per LD-020-03.
- Does NOT enable live execution. Live-mode latency budgets are
  enforceable only after the 8-gate LIVE-PROMOTION review
  (ADR-0018 + QFA-620 + QFA-615 prerequisites).

## Consequences

ADR-0020 dispatches the following follow-up tickets:

| Priority | Ticket | Scope |
|---|---|---|
| Highest | QFA-626 | Latency SLI instrumentation + Prometheus histogram export (strategy_decision, event_loop_lag, snapshot_to_submit, order_ack_submission, order_ack_cancel); journal-event timestamp emission per LD-020-02 |
| Highest | QFA-628 | ACK quarantine + synchronous reconciliation state machine; halt-new-submissions interlock (LD-020-07) |
| High | QFA-627 | Burn-rate evaluator with multi-window logic + `insufficient_data` state + sustained-insufficient-data alert (LD-020-05, LD-020-13) |
| High | QFA-629 | Paper `would_halt` event path; identical payload + lineage to live `halt` event (LD-020-08) |
| High | QFA-630 | Operator console latency + SLO panel; reads recording-rule outputs; surfaces `pass`/`breach`/`insufficient_data`/`not_applicable` distinctly (LD-020-09, LD-020-13) |
| Medium | QFA-632 | Cancel-ACK SLI + timeout policy; reuses quarantine/reconciliation path from QFA-628 (LD-020-12) |
| Medium | QFA-631 | Post-paper latency ratification packet: empirical distributions, ratified budget values, ratified bucket boundaries, ratified minimum sample counts; lands as ADR-0020 amendment (LD-020-03, LD-020-05) |

Phase 6 entry sequence: QFA-626 and QFA-628 dispatch first
(highest priority; instrumentation and quarantine are prerequisites
for everything else). QFA-627 + QFA-629 + QFA-630 dispatch after
QFA-626 lands. QFA-632 dispatches after QFA-628 lands. QFA-631 is
deferred until ≥ 2 weeks of paper telemetry exist.

## References

- ADR-0016 (alpha decision criteria; Phase 5 closure precedent)
- ADR-0018 (R-Protocol integration shape; defines ACK schema
  surface that ADR-0020 measures against)
- ADR-0023 (Cycle3 SignedShockMeasurement; anti-pattern lock)
- docs/research/qfa-611-cycle3-closure-memo.md (Phase 5 closure;
  Phase 6 dispatch authorization)
- CF-30 + CF-41 + CF-44 (anti-tuning / anti-drift across cycles)
- CF-45 (ADR threshold revisions require external methodological
  justification; ratification path for LD-020-03 + LD-020-05)
- CF-50 (`npm run build` mandatory pre-push)
- CF-52 (paper-observation window non-negotiable based on
  in-sample numbers alone; underwrites the ≥ 2-week paper-
  telemetry prerequisite for LD-020-03 ratification)
- Node `perf_hooks` documentation: `performance.now()`,
  `monitorEventLoopDelay()`, `process.hrtime.bigint()` (canonical
  measurement primitives for LD-020-02 + LD-020-04)

## Voting record

All 13 locked decisions (LD-020-01 through LD-020-13) accepted on
coordinator review with the following sequence:

1. **Walkthrough draft** (12 questions): initial proposal.
2. **Coordinator review** (disposition table): identified three
   defects requiring amendment before final drafting —
   (a) strategy-decision formula `proposed_ts - created_ts`
   collapses to zero in the current runtime; (b) auto-cancel-on-
   timeout creates a position-truth failure mode; (c) existing-
   position safety claim was not earned by the current
   architecture. Added two required new decisions: ACK milestone
   definition (LD-020-12) and `insufficient_data` policy
   (LD-020-13). Added explicit phase-gating language for the
   order-ACK SLA (LD-020-03 final paragraph).
3. **Coordinator approval with locked sub-decisions**: framing
   note approved with strict phase-gating wording (Coordinator
   decision 1); ACK timeout reconciliation locked as **synchronous
   gate** with halt-new-submissions interlock (Coordinator
   decision 2).

Coordinator decisions:

- **Q1 (framing)**: Approved with stricter phase-gating wording.
  Until the Phase 6 live/paper broker ACK lifecycle is merged,
  the order-ACK SLA is not breach-eligible and must not trigger
  halt, page, or operational failure states. It may be shown only
  as an observational target or a `not_applicable` state.
  Encoded in LD-020-03 final paragraph.
- **Q8 (reconciliation)**: Synchronous reconciliation gate. On
  ACK timeout, quarantine the order, halt new submissions,
  synchronously reconcile broker order status, cancel only
  broker-confirmed pending orders, adopt broker-confirmed
  filled/partial orders into journaled state, resume only after
  reconciliation resolves. Encoded in LD-020-07.

## Amendments

(None at acceptance. Future amendments listed here as
ADR-0020-A1, ADR-0020-A2, etc., with commit hash and one-line
rationale. The QFA-631 post-paper ratification packet will land
as the first scheduled amendment.)
