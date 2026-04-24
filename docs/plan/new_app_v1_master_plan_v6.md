# Quant-futures-app — New Trading App V1 Master Implementation Plan v6

## Status and precedence

This is the integrated master handoff for the greenfield `Quant-futures-app` V1. It consolidates the original greenfield handoff, the soak-informed v2 changes, the v3 freeze-candidate backlog corrections, and the operator-surface/TUI addendum into one implementation plan.

This document is the planning source of truth. The authoritative ticket list is `new_app_v1_ticket_backlog_v6.csv`.

### v6 architecture decision

This v6 plan incorporates the v5 acceptance-criteria/risk-control tightening review and the canonical exchange-time architecture pivot. The material changes versus v5 are:

1. `SIM-03` now has explicit calibration residual tolerances instead of a vague “within tolerance” launch gate.
2. `RSRCH-03` now must produce a deterministic candidate-count floor file using a fixed formula before `REL-01`; the launch gate no longer depends on an undefined floor.
3. `INFRA-01B` is promoted from fallback to the primary timestamp architecture path: `exchange_event_ts_ns` is canonical for sim-first V1, while `sidecar_recv_ts_ns` is telemetry only.
4. `FEAT-04` is re-estimated from 3.0d to 4.0d because normalization, dynamic reward, and expectancy extension are three separate strategy-critical modules.
5. `RSRCH-01` is re-estimated from 3.0d to 4.5d because the Databento loader must honor the 2017+ MNQ/NQ-surrogate continuity policy and produce reproducible manifests.
6. `INFRA-03` now enforces the legacy carryover policy in CI by failing active-code imports from `legacy_seed`, `legacy_reference`, old `src/autotrade`, Bookmap, and TradingView paths.
7. `OBS-00` adds a committed mini-journal fixture from the soak run so formatter, TUI, and replay smoke tests can run before the full runner loop is complete.

Baseline metrics now include `INFRA-01B` as a required P0 path and add `EVT-00` for sidecar-to-runtime journal transport plus `EVT-01` for derived-event causation-chain timestamp invariants.

| Metric | v6 baseline value |
|---|---:|
| Baseline tickets | 64 |
| Contingent tickets | 0 |
| P0 tickets | 55 |
| P1 tickets | 9 |
| Baseline ticket-days | 122.25 |
| P0 ticket-days | 98.75 |
| P1 ticket-days | 23.50 |
| Contingent ticket-days | 0.00 |
| Longest dependency path to `REL-01`, revised baseline | ~32.0 working days, unbuffered |
| Realistic solo-dev wall clock with buffer | ~8–9 calendar weeks, plus the calendar reality of 10 RTH sessions |

The revised timestamp architecture adds approximately +1 working day from the current active baseline because `INFRA-01B` becomes primary and `EVT-00` is added. `EVT-01` is a focused follow-up that blocks runner orchestration until derived-event timestamp inheritance is enforced:

```text
APP-01 → APP-02 / APP-03 / INFRA-03 → INFRA-01B → INFRA-01 → DATA-01 → DATA-02 → DATA-04 → FEAT-03 → FEAT-04 → STRAT-06 → EVT-00 → EVT-01 → ORCH-02 → ORCH-03 → OBS-03 → REL-00 → REL-01
```

`TUI-03` is no longer coupled to `ORCH-02` for initial development. It is built first against `OBS-00` and the event-bus contract, then validated against the live runner during `REL-00`.

---

## 1. Purpose

Build a new futures trading application from scratch for simulated trading first, using:

- direct Rithmic R-protocol market data for live ingestion;
- Databento historical data for replay, research, calibration, and ML training;
- MNQ-first scope;
- only the useful quantitative strategy, indicator, risk, management, and orchestration logic from the legacy trading app;
- no Bookmap runtime dependency;
- no TradingView runtime dependency;
- no live order execution in V1;
- a new read-only operator surface that renders event-bus facts without becoming a decision source.

This is not a migration shell. The new app should preserve the quantitative math and state-machine ideas that matter, but should not preserve old UI, old runner, old repo structure, old PR/commit history assumptions, or obsolete data paths.

---

## 2. Non-negotiable V1 architecture decisions

1. **Greenfield repo.** `Quant-futures-app` is a new project folder and new repo.
2. **Simulation-first.** V1 implements only simulated execution. Live order routing and Rithmic ORDER_PLANT integration are deferred.
3. **Rithmic direct for live market data.** The live feed path is direct Rithmic R-protocol ingestion of L1, LAST_TRADE, MBP10, and MBO.
4. **Databento historical for replay/research/ML.** Databento is historical canonical, not a live provider.
5. **No Bookmap runtime role.** Bookmap code is not an active dependency, data source, order path, or UI source in V1.
6. **No TradingView runtime role.** TradingView-derived collection and dashboard paths are excluded.
7. **Four active deterministic baseline strategies only.**
   - `trend_pullback_long`
   - `trend_pullback_short`
   - `breakout_retest_long`
   - `breakdown_retest_short`
8. **ML is non-blocking.** The opportunity-decay uplift model remains part of the V1 design, but `REL-01` does not depend on ML acceptance.
9. **Event journal is authoritative.** Runtime decisions, operator display, formatter output, replay, and provenance must all derive from journaled facts.
10. **Operator UI is read-only.** The V1 TUI has no order entry, no flatten keybinding, no config edits, and no write-path controls.

---

## 3. Soak-informed live data findings

The April 23, 2026 Rithmic R-protocol soak validated direct ingestion enough to proceed without a pre-`DATA-01` connectivity spike.

Validated conditions:

- symbol: `MNQM6`, exchange `CME`;
- duration: 6,352 seconds, about 1h 46m;
- approximately 10.6M messages;
- mean rate around 1,670 msg/s;
- streams included MBO, MBP10, LAST_TRADE, and L1_QUOTE;
- zero errors, disconnects, reconnects, stale events, warnings, or rejects;
- local receive timestamps were usable for telemetry ordering, but not reliable enough to become canonical event time.

Three findings remain launch-relevant:

1. **Canonical exchange time is mandatory before `DATA-01`.** The RProtocol collector works and captured all four streams, but Windows host clock discipline failed the original local receive-clock gate. V1 therefore treats `exchange_event_ts_ns` as canonical for replay, labels, feature alignment, candidate lineage, and gap detection where populated.
2. **Receive time is telemetry only.** `sidecar_recv_ts_ns` is preserved for receive-latency diagnostics, runtime health, feed delay monitoring, and operational troubleshooting. It must not drive V1 replay ordering, first-passage labels, or feature alignment.
3. **Gap taxonomy is mandatory before launch.** The soak had 11 inter-arrival gaps over 1 second. `DATA-07` must classify them, and `DATA-08` must turn the taxonomy into structured alarms and authority behavior.

---

## 4. Target architecture

### 4.1 Runtime services

```text
Rithmic live market data
  → services/market_data_sidecar
  → typed event bus + journals
  → apps/strategy_runtime
  → strategy candidates
  → risk/sizing
  → simulated execution
  → position manager
  → management engine
  → journals, formatter, TUI, replay artifacts
```

### 4.2 Historical and research flow

```text
Databento historical DBN
  → research/databento loader
  → replay-compatible event stream
  → same feature and runtime contracts
  → candidate generation
  → simulated execution
  → labels, baseline reports, model training datasets
```

### 4.3 Python sidecar target layout

```text
services/market_data_sidecar/
  app.py
  config.py
  providers/
    rithmic_live.py
  session/
    contract_roll.py
    session_clock.py
    luld_state.py
    book_rebuild.py
  book/
    mbp10_book_state.py
    l2_authority_fsm.py
    advanced_mbo.py
    microstructure.py
    cvd.py
    rolling.py
    compute.py
    schema.py
  publish/
    snapshot_publisher.py
    event_journal.py
    feature_journal.py
    health.py
  tests/
```

### 4.4 TypeScript runtime target layout

```text
apps/strategy_runtime/
  src/
    app.ts
    config/
    contracts/
      index.ts
      events/
        event-types.ts
        schemas.ts
        channels.ts
      strategy-ids.ts
      market.ts
      candidate.ts
      position.ts
      execution.ts
    orchestration/
      runner.ts
      event-bus.ts
      runner-ipc.ts
      instrument-event-bus.ts
      engine-container.ts
      health-client.ts
      replay-clock.ts
    data/
      feature-snapshot-client.ts
      bar-builder.ts
      session-store.ts
    strategies/
      index.ts
      registry.ts
      common/
        freshness.ts
        target-utils.ts
        rejection.ts
        scoring.ts
      trend_pullback_long.ts
      trend_pullback_short.ts
      breakout_retest_long.ts
      breakout_retest_short.ts
    features/
      indicators.ts
      structure.ts
      session-levels.ts
      entry-state.ts
      orderflow-state.ts
      normalization.ts
      microstructure-score.ts
      dynamic-reward-plan.ts
      expectancy-engine.ts
      expectancy-table-loader.ts
      htf-zones.ts
      extension.ts
    risk/
      risk-manager.ts
      composed-sizer.ts
      contracts.ts
      costs.ts
      venue-cost-config.ts
      account-risk-arbiter.ts
    management/
      index.ts
      management-profiles.ts
      decision-engine.ts
      target-position.ts
      position-manager/
        index.ts
        stops.ts
        targets.ts
        trailing.ts
        time-stops.ts
        fail-safe.ts
        failure-exit/
          state.ts
          curves.ts
          evaluator.ts
    execution/
      types.ts
      simulated-execution.ts
      fill-model.ts
      slippage-model.ts
    replay/
      event-reader.ts
      harness.ts
    operator/
      formatter.ts
      tui.ts
      journal-query.ts
    ml/
      entry-uplift-types.ts
      entry-uplift-client.ts
      contract.ts
    telemetry/
      log-writer.ts
      trade-journal.ts
      metrics.ts
```

### 4.5 Research and ML target layout

```text
research/
  databento/
    ingest.py
    replay_loader.py
    dataset_builder.py
  labels/
    first_passage.py
    trade_outcomes.py
  features/
    feature_registry.py
    entry_feature_registry.py
  models/
    train_entry_uplift.py
    evaluate_entry_uplift.py
    calibrate_entry_uplift.py
    export_artifact.py
  notebooks/
  tests/
```

---

## 5. Contracts and timestamp discipline

### 5.1 Timestamp contract

`APP-02`, `INFRA-01B`, and `INFRA-01` must define and enforce these timestamp fields:

| Field | Meaning |
|---|---|
| `exchange_event_ts_ns` | exchange-matched or exchange-origin event time, as published in the source payload |
| `rithmic_publish_ts_ns` | Rithmic gateway publish/send time, if distinguishable |
| `sidecar_recv_ts_ns` | host-side receive time, preserved as non-authoritative telemetry |
| `runtime_consume_ts_ns` | TypeScript runtime processing time |
| `ts_ns` | canonical emitted event timestamp; for market-data events this is derived from `exchange_event_ts_ns` |

For V1, `exchange_event_ts_ns` is authoritative for:

- replay ordering;
- first-passage labels;
- feature alignment;
- candidate lineage;
- gap detection where exchange time is populated;
- Databento parity checks.

`sidecar_recv_ts_ns` is telemetry only. It is used for receive-latency diagnostics, runtime health, feed delay monitoring, and operational troubleshooting. It must not be used as canonical event time for V1 replay, labels, feature alignment, candidate lineage, or first-passage logic.

Per-stream exchange time must be non-decreasing, not strictly monotonic, because multiple exchange events may legitimately share the same nanosecond timestamp.

### 5.1.1 `INFRA-01B` primary exchange-time path

`INFRA-01B` is a required P0 ticket, not a contingency. It closes when:

1. `docs/adr/ADR-0001-canonical-event-time.md` is approved.
2. Linux/chrony or equivalent host-time evidence shows RMS offset <10 ms and root dispersion <50 ms across a 1-hour observation window.
3. A 30-minute RTH re-probe captures `L1_QUOTE`, `LAST_TRADE`, `MBP10`, and `MBO`.
4. `exchange_event_ts_ns` coverage is >=99.9% for market-data records, excluding documented startup/control records.
5. `exchange_event_ts_ns` is non-decreasing per stream.
6. `sidecar_recv_ts_ns - exchange_event_ts_ns` telemetry has non-negative p50 and p99 <500 ms.
7. Databento overlap parity confirms matched exchange-time windows reconstruct comparable market state; price levels align within 1 MNQ tick where comparable; unmatched/missing events are counted and documented.

This does not remove the need for better clock discipline before future live execution. It only changes the sim-first V1 data/replay/labeling gate.

### 5.1.2 `INFRA-01` revised verification gate

`INFRA-01` is reduced to a verification ticket that depends on `INFRA-01B`. It runs the revised evaluator against the `INFRA-01B` report and emits `reports/infra/infra01_revised_timestamp_gate.json`.

Acceptance criteria:

1. Runs the revised evaluator.
2. Confirms `exchange_event_ts_ns` canonical fields are present.
3. Confirms exchange-time coverage threshold and non-decreasing per-stream order.
4. Confirms sidecar receive-latency telemetry thresholds.
5. Confirms Databento overlap parity report exists.
6. Emits `reports/infra/infra01_revised_timestamp_gate.json`.
7. Allows `DATA-01` only when the report says `data01_eligible = true` and `route_to = DATA-01`.

`DATA-01` remains blocked unless that report says `data01_eligible = true` and `route_to = DATA-01`.

### 5.2 Event contract

All runtime-visible facts are emitted as typed events. Every event has:

- `type` enum;
- `event_id`;
- `ts_ns`;
- `session_id`;
- `run_id`;
- `payload` typed schema;
- `causation_id`, linking downstream decisions back to their trigger;
- optional `correlation_id` for candidate/position chains.

The event bus is authoritative for TUI, formatter, journal query, alerting, replay parity, and post-session investigation.

### 5.3 `EVT-00` sidecar-to-runtime journal transport

`EVT-00` implements the V1 transport from Python sidecar output to the TypeScript runtime. It uses a shared local folder of append-only JSONL journal files and a deterministic TypeScript file-watcher ingest path.

Scope constraints:

- no sockets;
- no runner implementation;
- no recomputation of event facts in the transport;
- deterministic cursor/checkpoint handling.

Acceptance criteria:

1. Sidecar writes append-only JSONL to a configured shared journal directory.
2. TS watcher ingests appended records in order.
3. Restart resumes from last processed byte offset or event id without duplicate ingestion.
4. Malformed lines are quarantined, not fatal.
5. Transport preserves `run_id`, `session_id`, `event_id`, `causation_id`, `exchange_event_ts_ns`, `sidecar_recv_ts_ns`, and `payload`.

### 5.4 `EVT-01` derived-event causation-chain timestamp invariant

`EVT-01` is a required follow-up before `ORCH-02`. It prevents derived runtime events from leaking wall-clock time through `ts_ns`.

Acceptance criteria:

1. Define source market-data events, derived events, and explicitly exempt system/control events.
2. Source market-data events require `event.ts_ns === payload.exchange_event_ts_ns`.
3. Derived events require `causation_id` unless explicitly exempted by schema.
4. If the causation event is available in a deterministic recent-causation buffer, require `derived_event.ts_ns === cause_event.ts_ns`.
5. If the causation event is unavailable, accept only events whose schema marks them externally sourced or replay-bootstrap-safe; otherwise reject/quarantine.
6. Reject/quarantine obvious wall-clock leakage such as a derived event with `causation_id` and mismatched `ts_ns`.
7. Tests cover valid inherited timestamps, wall-clock mismatch rejection, missing causation rejection, source market-data equality, and deterministic causation-buffer behavior.

---

## 6. Bootstrap fixture journal

### 6.1 `OBS-00` — committed mini-journal fixture

`OBS-00` normalizes a small subset of the April 23, 2026 soak run into a committed fixture journal. The fixture exists to unblock formatter, TUI, replay, and event-contract smoke tests before `ORCH-02` has a full runner loop.

Acceptance criteria:

- fixture is small enough for the repo or test-artifact store, but includes `CONN`, `FEED`, `QUOTE`, `TRADE`, `BAR_CLOSE`, `FEATURES`, `STRUCTURE`, `MICROSTRUCTURE`, `STRAT_EVAL`, `CANDIDATE`, `RISK_GATE`, `SIZING`, `SIM_FILL`, `POSITION`, `MGMT_TICK`, `GAP`, and `BOOK_REBUILD` examples, using synthetic records only where the soak lacks downstream runtime events;
- fixture has a manifest with source file, extraction range, event count, schema version, checksum, and redaction statement;
- `TUI-02` formatter smoke and `TUI-03` dashboard smoke can run from the fixture without Rithmic, Databento, or the runner loop;
- fixture output is deterministic across two consecutive test runs.

---

## 7. Operator surfaces

V1 adds a read-only operator surface, but it does not resurrect the old console runner UI. The operator surface renders the event stream; it never recomputes indicators, scores, strategy gates, or position state.

### 7.1 `TUI-01` — event-bus contract

Deliver `contracts/events/` with event schemas, channel mapping, emission cadence, and throttling rules.

| Channel | Source events | Emission cadence |
|---|---|---|
| CONNECTION | `CONN`, `FEED`, `GAP`, `BOOK_REBUILD` | 1 Hz heartbeat + event-driven |
| SESSION | `SESSION_PHASE`, `ROLL_ADVISORY`, `HALT` | event-driven |
| MARKET | `QUOTE`, `TRADE`, `BAR_CLOSE` | quotes throttled 5 Hz; bars per close |
| INDICATORS | `FEATURES` | per bar close for 1m/5m/15m |
| STRUCTURE | `STRUCTURE` | per bar close + BOS/CHoCH events |
| MICROSTRUCTURE | sidecar microstructure snapshot | 2 Hz throttled |
| STRATEGY_GATES | `STRAT_EVAL` | per evaluation cycle |
| CANDIDATES | `CANDIDATE`, `ML_UPLIFT`, `RANK`, `RISK_GATE`, `SIZING` | event-driven |
| ORDERS | `ORDER_INTENT`, `SIM_FILL` | event-driven |
| POSITION | `POSITION`, `MGMT_TICK`, `MGMT_ACTION` | event-driven + per-bar tick |

Throttling is part of the contract. Consumers do not decide their own raw-feed rate. A normal `QUOTE` subscriber receives the 5 Hz stream; `QUOTE_RAW` is explicit and should not feed the TUI by default.

### 7.2 `TUI-02` — structured log formatter

Deliver a standalone binary that reads JSON Lines on stdin and emits deterministic human-readable logs.

Required behavior:

- `runtime | formatter` and `cat journal.jsonl | formatter` produce equivalent output for the same event stream;
- output is byte-identical across replay runs with the same journal/config/seed;
- color is off by default and enabled only with `--color`;
- supported filters include `--only type=CANDIDATE,POSITION,SIM_FILL`, `--grep <id>`, `--strategy <strategy_id>`, and `--since <time>`.

`OBS-03` now includes formatter-output parity.

### 7.3 `TUI-03` — read-only operator dashboard

Deliver a single-screen TUI, implemented in TypeScript, using the event bus directly. The TUI is same-box for V1. No separate event-stream socket server is required in V1. Initial development and smoke validation run against the `OBS-00` fixture journal; live-runner validation occurs in `REL-00`.

Panels:

1. CONNECTION — gateway, auth state, last-message age, feed p50/p99, gaps this session;
2. SESSION — phase, time to close, maintenance, roll state;
3. MARKET — L1 plus 1m/5m bar recap;
4. INDICATORS — multi-timeframe EMAs, ATR, Supertrend, VWAP+z, ADX/DI;
5. STRUCTURE — trend, BOS/CHoCH, swings, OR/ON/daily-open context;
6. MICROSTRUCTURE — spread, microprice offset, OFI, aggressor imbalance, depth imbalance, queue imbalance, flags;
7. STRATEGY_GATES — per-strategy ARMED/WAITING/BLOCKED/REJECT with first-failing-gate reason;
8. POSITION — open position state, unrealized PnL/R, today’s tally.

TUI rules:

- read-only in V1;
- no keybindings that mutate orders, risk, config, or positions;
- color on by default in the TUI;
- color convention: green for `PASS`/`ARMED`/positive R, yellow for `WAIT`/warmup, red for `REJECT`/`BLOCKED`/negative R, dim for stale;
- stale panel data must dim or show `--` after channel-specific `T_stale`.

### 7.4 `TUI-04` — journal query CLI

P1, non-blocking. Deliver `journal-query` to reconstruct candidate or position provenance from journals:

```text
journal-query --candidate cand_7f2a
journal-query --position pos_2a14
journal-query --session 2026-04-23-rth
journal-query --strategy trend_pullback_long --since 17:29:00
```

`TUI-04` is useful for post-session investigation but does not block `REL-01`. Until then, `grep`/`jq` plus the formatter is acceptable.

---

## 8. Strategy scope

Only these four baseline strategies are executable in V1:

- `trend_pullback_long`
- `trend_pullback_short`
- `breakout_retest_long`
- `breakdown_retest_short`

### 8.1 Strategy config surface

All strategy thresholds move to typed YAML config under:

```text
config/strategies/
  shared.yaml
  trend_pullback_long.yaml
  trend_pullback_short.yaml
  breakout_retest_long.yaml
  breakdown_retest_short.yaml
```

Config must cover:

- freshness thresholds;
- min-R floors;
- room filters;
- pullback bounds;
- strategy enable flags;
- session/ETH behavior where strategy-specific;
- feature warmup minimums.

Every candidate journal entry must include a config revision/hash. Replay requires the same config hash unless an explicit override is supplied.

### 8.2 Strategy extraction principle

Preserve mathematical intent and directional asymmetry where present. Do not port shadow/research strategies into active runtime. Do not recreate a monolithic legacy `strategy.ts`.

---

## 9. Feature and indicator scope

### 9.1 Core V1 signals

- EMA 9/21/50/200;
- ATR 14;
- Supertrend direction;
- swings, BOS, CHoCH;
- VWAP and z-distance to VWAP;
- opening range and session levels;
- RTH/ETH/maintenance/closed session state;
- volume-relative context;
- multi-timeframe alignment;
- spread, top-of-book imbalance, microprice offset;
- OFI short/medium/blend;
- trade aggressor imbalance;
- recent depth imbalance;
- queue imbalance where available.

### 9.2 `EntryStateVector`

`EntryStateVector` is an immutable first-class record frozen at candidate time. It must carry at least:

- price;
- `sigma_pts`;
- `atr_pts`;
- `z_ema9`, `z_ema21`, `z_vwap`;
- pullback ratio;
- impulse maturity bars;
- OFI short/medium/blend;
- microprice offset;
- queue imbalance;
- spread ticks;
- depth imbalance;
- session bucket/regime;
- distances to BOS/CHoCH/pivots/session levels.

### 9.3 `FEAT-04` is critical path

`FEAT-04` is P0 because strategy ranking depends on canonical normalization, dynamic reward, and expectancy extension. It is estimated at 4.0d in v5 because these are three strategy-critical modules, not one small port. It must not create a second volatility system. `sigma_pts` and related normalization belong in one canonical layer.

---

## 10. Risk, sizing, and management

### 10.1 Pre-trade risk

V1 pre-trade checks include:

- trading session allowed;
- quote authority true;
- spread within limits;
- stop distance positive and tick-valid;
- minimum R to target satisfied;
- max exposure and max open-position caps;
- cooldown and duplicate-entry guards;
- daily realized-loss limit;
- daily max open-trade count;
- account-level circuit breaker.

When the account circuit breaker trips, new entries are blocked until next session start. Existing simulated positions remain managed.

### 10.2 Sizing

Use compositional sizing:

- risk budget per trade;
- liquidity cap;
- soft cap;
- hard cap;
- optional ML/model discount factor if ML is accepted.

### 10.3 Position management

Carry over and refactor:

- initial stop and target tracking;
- PT1/PT2 realized state;
- trailing logic;
- break-even behavior;
- failure-exit logic;
- time-stop logic;
- target-position reduction overlay;
- EV/PoP management decision logic where useful.

Position manager owns state. Management engine recommends actions; it does not mutate fills directly.

---

## 11. Simulated execution

V1 builds only `SimExecutionAdapter`.

Execution interface:

```ts
interface ExecutionAdapter {
  submit(intent: ExecutionIntent): Promise<ExecutionAck>
  cancel(orderId: string): Promise<void>
  amend(intent: AmendIntent): Promise<void>
  flatten(reason: string): Promise<void>
}
```

Fill model requirements:

- bid/ask crossing and queue-aware simplification for limit fills;
- configurable marketable slippage;
- costs from contract/venue config;
- deterministic replay with fixed seed if stochastic components exist;
- no model-free fills;
- `SIM-03` calibration to MNQ Databento tick data before `RSRCH-03` and `REL-01`.

### 11.1 `SIM-03` calibration tolerances

`SIM-03` produces `reports/sim/fill_slippage_calibration.json` and a readable markdown report. `REL-01` criterion 5 passes only if the report status is `pass`.

Calibration dataset:

- at least 20 MNQ RTH sessions from Databento, including high-volume and normal-volume sessions;
- a held-out validation split that is not used to fit model constants;
- calibration stratified by spread bucket, order type, side, session phase, and volatility regime.

Minimum residual tolerances:

| Model area | Metric | Pass threshold |
|---|---|---:|
| Marketable slippage distribution | two-sample KS statistic between modeled and empirical signed-slippage distribution on validation split | ≤ 0.15 |
| Marketable slippage p50 | absolute difference from empirical p50 | ≤ max(0.25 tick, 20% of empirical absolute p50) |
| Marketable slippage p90 | absolute difference from empirical p90 | ≤ max(0.50 tick, 25% of empirical absolute p90) |
| Adverse-tail slippage p95 | modeled adverse p95 vs empirical adverse p95 | ≤ max(0.50 tick, 25% of empirical adverse p95) |
| Limit-fill probability | fill-rate residual by queue-position bucket | ≤ 10 percentage points per bucket |
| Limit time-to-fill | median time-to-fill residual by queue-position bucket | ≤ 25% relative error |
| No-fill/cancel bucket | no-fill rate residual by queue-position bucket | ≤ 10 percentage points |
| Strategy-level cost | mean modeled slippage per strategy on validation windows | within max(0.25 tick, 15% of empirical mean absolute slippage) |

If a metric cannot be computed because the validation sample is too small, `SIM-03` must mark that bucket `insufficient_sample`, aggregate it to the next broader bucket, and record the merge in the report. `REL-01` cannot waive a failed or missing top-level calibration status.

---

## 12. MNQ operational logic

V1 is MNQ-first.

### 12.1 Roll calendar

`MNQ-01` delivers an explicit front-month calendar fixture covering 2017-01 through present. Because 2017 predates MNQ availability, the research loader must use the `RSRCH-00` historical-continuity policy when replaying pre-MNQ windows.

Default roll-window behavior:

- flatten open simulated positions 5 minutes before configured roll cutover;
- block new entries 15 minutes before through 15 minutes after configured roll cutover;
- roll behavior must be replay-testable.

### 12.2 Halt and rebuild behavior

`DATA-06` implements session, halt, roll, and rebuild flow:

- session clock covers RTH, ETH, closed, and maintenance windows;
- halt state forces quote authority false and candidate suppression;
- mid-session rebuild uses a configurable warmup window, default 60 seconds;
- no strategy candidate may emit before post-connect warmup and authority reconvergence complete.

---

## 13. Data quality, journaling, and retention

### 13.1 Gap detection

`DATA-07` classifies the observed soak gaps. `DATA-08` emits structured gap events with:

- stream;
- duration;
- start and end timestamps;
- session phase;
- classification;
- authority impact.

Unacceptable gaps mark feature snapshots non-authoritative until reconvergence completes.

### 13.2 Retention policy

`DATA-09` implements:

| Artifact class | Retention |
|---|---:|
| Raw uncompressed MBO/MBP/L1/trade journal | current session + 1 prior RTH session |
| Raw compressed journal | 14 calendar days hot |
| Derived feature snapshots and candidate journals | 90 calendar days |
| `REL-00` / `REL-01` launch artifacts | permanent |
| Research datasets and model manifests | permanent manifests/hashes; raw data can be regenerated if licensed |

Disk-pressure warning at 70%; hard fail-closed journaling mode at 85% unless explicitly overridden.

---

## 14. Research and ML

### 14.1 Historical continuity policy

`RSRCH-00` closes the 2017+ ambiguity:

1. Use MNQ where MNQ exists.
2. Use NQ as a pre-MNQ surrogate domain only with explicit `historical_domain` flag.
3. Normalize features into tick, R, and volatility units before cross-domain use.
4. Report MNQ-only metrics separately from NQ-surrogate metrics.
5. V1 launch acceptance is judged primarily on MNQ-only history where available. NQ-surrogate history can support pretraining, priors, or sanity checks, but cannot hide weak MNQ-only performance.

### 14.2 Baseline pre-ML performance

`RSRCH-03` runs after `SIM-03`, so baseline performance includes calibrated fill/slippage assumptions. It reports metrics by:

- strategy;
- direction;
- session phase;
- volatility regime;
- historical domain;
- sample-size bucket.

`RSRCH-03` must also produce `reports/baseline/strategy_activity_floor.json`. This is the only candidate-count floor used by `REL-01`; the method is fixed here so the launch gate cannot become an argument later.

Candidate-count floor method:

1. Use at least 60 MNQ RTH sessions where MNQ history is available; exclude half-days and sessions with unresolved data-quality gaps.
2. Run the four deterministic strategies with the same config schema and calibrated `SIM-03` fill/slippage model intended for `REL-01`.
3. For each strategy, compute rolling 10-session candidate counts over the baseline window.
4. Set `candidate_count_floor_10rth[strategy] = clamp(floor(0.50 × p25_rolling_10_session_count), min=3, max=25)`.
5. If a strategy has fewer than 60 valid MNQ sessions after exclusions, `RSRCH-03` must fail and request either more data or an explicit ADR; it may not silently use NQ-surrogate activity as the launch floor.
6. The JSON file must include the baseline session list, config hash, replay seed, per-strategy rolling count distribution, chosen floor, and checksum.

`REL-01` criterion 4 passes only if each active strategy's 10-session candidate count is greater than or equal to its JSON-defined `candidate_count_floor_10rth`.

### 14.3 Opportunity-decay uplift model

The ML model remains a non-blocking V1 feature. It estimates:

- `p_hit_1r_before_stop`;
- `p_hit_2r_before_stop`;
- `expected_time_to_1r_sec`;
- `opportunity_decay_score`;
- `entry_uplift_band`.

If `ML-04` passes before `REL-01`, `ML-05` may wire inference as a gate/uplift and record model version/latency per candidate. If `ML-04` fails or is incomplete, V1 ships deterministic-only.

---

## 15. Testing and launch gates

### 15.1 Unit and integration coverage

Minimum coverage:

- indicators;
- structure detection;
- session levels;
- entry-state vector;
- orderflow state;
- strategy generators;
- sizing;
- risk gates;
- target-position math;
- management profiles;
- position manager;
- simulated fill model;
- book state and authority FSM;
- event-bus contract;
- formatter deterministic rendering;
- TUI journal replay smoke.

### 15.2 `REL-00` mini-gate

Before the 10-session launch gate, `REL-00` must pass:

1. three historical replay days complete without uncaught exceptions;
2. one live RTH session completes without sidecar restart except the deliberate restart test;
3. deliberate restart reconverges and enforces warmup candidate suppression;
4. replay of the captured live session is byte-identical;
5. fills trace to candidate IDs, feature snapshot IDs, and position-state transitions;
6. every gap over 1 second is classified by `DATA-08`;
7. disk retention/compression runs without data loss;
8. formatter and TUI smoke tests pass against the `OBS-00` fixture journal before live replay;
9. TUI-03 runs cleanly against journal replay before the live session.

### 15.3 `REL-01` ten-session launch gate

All criteria must pass across 10 consecutive RTH MNQ sessions.

1. **Runtime integrity**
   - zero uncaught exceptions;
   - zero unplanned sidecar process restarts;
   - every candidate has valid `feature_snapshot_id` lineage;
   - every fill traces to a candidate and position-state transition.
2. **Connection resilience**
   - at least one deliberate mid-session sidecar restart per session;
   - quote-authority reconvergence documented;
   - no candidate before post-connect warmup.
3. **Feed quality**
   - canonical exchange timestamp gate passes (`exchange_event_ts_ns` coverage >=99.9% and non-decreasing per stream);
   - sidecar receive-time telemetry gate passes or has a documented non-canonical follow-up (`sidecar_recv_ts_ns - exchange_event_ts_ns` p50 non-negative and p99 <500 ms);
   - Databento exchange-time parity gate passes for overlapping windows;
   - no uninvestigated gap over 1 second in RTH feature snapshots.
4. **Strategy activity**
   - all four strategies produce at least their `reports/baseline/strategy_activity_floor.json` `candidate_count_floor_10rth` values produced by `RSRCH-03`;
   - every candidate carries complete `EntryStateVector` and `CandidateSetup` records.
5. **Execution simulation**
   - `SIM-03` calibration report status is `pass` under the §11.1 KS, percentile, queue-position, and strategy-cost thresholds;
   - no model-free fills.
6. **Replay parity**
   - same input journal, config hash, and seed produce byte-identical candidate, position, and formatter outputs.
7. **ML, if accepted**
   - uplift inference latency under 50 ms at candidate decision time;
   - model version recorded per candidate.
8. **Operator surface**
   - TUI renders full session including warmup, active trading, and close;
   - no panel shows stale data silently;
   - formatter output from live journal and replayed journal is byte-for-byte identical.
9. **Traceability spot-check**
   - for at least five candidates across the 10 sessions, reconstruct the chain: feature snapshot → strategy eval → candidate → ML uplift if active → risk gate → sizing → fill → position lifecycle.

---

## 16. Backlog summary

The authoritative backlog is `new_app_v1_ticket_backlog_v6.csv`.

### 16.1 New v6 tickets

| Ticket | Priority | Estimate | Depends on | Summary |
|---|---:|---:|---|---|
| `INFRA-01B` | P0 | 1.5d | `APP-02`, `INFRA-03` | Canonical exchange-time ADR and Linux/chrony re-probe path |
| `EVT-00` | P0 | 0.5d | `APP-02`, `APP-03`, `OBS-01` | Sidecar-to-runtime append-only JSONL journal transport with deterministic file-watcher ingest |
| `EVT-01` | P0 | 0.5d | `EVT-00`, `OBS-01` | Causation-chain `ts_ns` invariant for derived events before runner orchestration |
| `OBS-00` | P0 | 0.5d | `OBS-01` | Normalize soak run into committed mini-journal fixture for formatter, TUI, and replay smoke tests |

### 16.2 v6 estimate and acceptance updates

| Ticket | v6 update |
|---|---|
| `SIM-03` | explicit KS, percentile, queue-position, no-fill, and strategy-cost residual thresholds |
| `RSRCH-03` | must produce `strategy_activity_floor.json` with a fixed floor formula before `REL-01` |
| `INFRA-01B` | promoted to primary P0 exchange-time architecture path; estimate 1.5d |
| `INFRA-01` | shrunk to 0.5d revised timestamp verification gate depending on `INFRA-01B` |
| `EVT-00` | added as P0 sidecar-to-runtime append-only JSONL transport; blocks `ORCH-02` |
| `EVT-01` | added as P0 causation-chain timestamp-inheritance invariant; blocks `ORCH-02` |
| `FEAT-04` | estimate raised 3.0d → 4.0d |
| `RSRCH-01` | estimate raised 3.0d → 4.5d for 2017+ continuity-policy implementation |
| `INFRA-03` | CI must enforce no active imports from legacy/reference/old runtime paths |
| `TUI-02` | depends on `OBS-00` fixture and must pass fixture-journal formatter smoke |
| `TUI-03` | initial development decoupled from `ORCH-02` by the `OBS-00` fixture; live validation remains in `REL-00` |
| `OBS-03` | still depends on `TUI-02` and includes formatter-output parity |
| `REL-00` | depends on `OBS-00` and `TUI-03`; includes fixture-backed TUI/formatter smoke before live |
| `REL-01` | depends on `OBS-00`; launch criteria now point to explicit `SIM-03` and `RSRCH-03` outputs |

---

## 17. Implementation sequence

### Wave 1 — foundations

Primary:

```text
APP-01 → APP-02 / APP-03 → INFRA-03 / OBS-01 → INFRA-01B / OBS-00 / RISK-01 / MGMT-01 / MNQ-01 / RSRCH-00 → INFRA-01
```

Parallel:

```text
STRAT-01, RISK-02, MGMT-02, STRAT-07
```

TUI early start:

```text
OBS-01 → OBS-00 → TUI-01 / TUI-02
```

### Wave 2 — sidecar, features, early strategy extraction

Primary:

```text
INFRA-01 → DATA-01 → DATA-02 → DATA-04 → FEAT-03 → FEAT-04
```

Parallel:

```text
DATA-03, DATA-05, DATA-06, DATA-07, DATA-08, DATA-09,
FEAT-01, FEAT-02, STRAT-00, STRAT-02..05,
MGMT-03, SIM-01, RSRCH-01
```

### Wave 3 — integration, runner, operator surface

Primary:

```text
FEAT-04 → STRAT-06 → EVT-00 → EVT-01 → ORCH-02 → ORCH-03
```

Parallel:

```text
SIM-02 → SIM-03,
RSRCH-02,
OBS-02,
RISK-03,
TUI-03 from TUI-01/TUI-02/OBS-00 fixture; live-runner validation occurs in REL-00
```

### Wave 4 — determinism, mini-gate, launch gate

Primary:

```text
OBS-03 → REL-00 → REL-01
```

Parallel:

```text
RSRCH-03 with candidate-count floor file,
TUI-04 opportunistically,
OBS-04 if desired
```

### Wave 5 — ML, non-blocking

```text
ML-01 → ML-02 → ML-03 → ML-04 → ML-05
```

---

## 18. Legacy carryover policy

Copy source only as seed material. Final active code must not import from `legacy_seed`, `legacy_reference`, or old `src/autotrade` paths.

`INFRA-03` enforces this policy in CI. The build must fail if active runtime, sidecar, research, or test code imports from:

- `legacy_seed/`;
- `legacy_reference/`;
- old `src/autotrade/` aliases or relative paths;
- `dashboard/`;
- `bookmap-addon/`;
- `src/core/tradingview/`.

The only exception is tests explicitly marked as legacy extraction tests, and those tests may read legacy files as fixtures but must not make active modules depend on them.

### 18.1 High-value source to carry conceptually

- indicator math;
- structure and session-level math;
- entry-state and orderflow-state construction;
- normalization, dynamic reward, expectancy fallback;
- four baseline strategy generators and their helper math;
- risk, sizing, cost model, and account-risk ideas;
- management profiles, target-position logic, position manager, failure exits, time stops;
- runner IPC and event-bus utilities only where cleanly reusable;
- MBP10 book state, L2 authority FSM, MBO/microstructure feature extraction.

### 18.2 Source not to carry into active runtime

- old monolithic runner;
- dashboard/UI;
- console runner UI shell;
- Bookmap addon/runtime path;
- TradingView data path;
- old startup scripts;
- generated reports/logs;
- old live-order stubs;
- old ML service stubs as runtime truth.

---

## 19. V1 definition of done

V1 is done when:

1. the app runs without Bookmap or TradingView;
2. the app consumes direct Rithmic R-protocol market data and passes the revised `INFRA-01` canonical exchange timestamp, receive-telemetry, and Databento exchange-time parity gates;
3. the four deterministic baseline strategies generate candidates and simulated trades against live and replayed data;
4. position management is active, journaled, and replay-deterministic;
5. Databento replay produces byte-identical journals/candidates/formatter output under the same seed/config;
6. MNQ roll, halt, and mid-session rebuild behaviors are validated;
7. `REL-00` mini-gate passes;
8. `REL-01` ten-session launch gate passes with explicit `SIM-03` residual thresholds and `RSRCH-03` candidate floors;
9. the read-only TUI and formatter are operationally usable during full sessions;
10. `RSRCH-03` baseline pre-ML performance is documented;
11. if ML is accepted, uplift contribution is measured against baseline; if rejected/incomplete, V1 ships deterministic-only.

---

## 20. Open decisions now closed for v6

| Topic | v6 decision |
|---|---|
| TUI host | same runtime box for V1; no event-stream socket server in V1 |
| Formatter color | off by default; `--color` opt-in only |
| TUI color | on by default with simple green/yellow/red/dim semantics |
| TUI keybindings | read-only in V1; no mutation controls |
| Bootstrap fixture | `OBS-00` soak-derived mini-journal is required for formatter/TUI/replay smoke tests |
| Clock discipline | `exchange_event_ts_ns` is canonical for sim-first V1; `sidecar_recv_ts_ns` is telemetry only; `INFRA-01B` captures Linux/chrony evidence and `INFRA-01` verifies DATA-01 eligibility |
| ML launch dependency | non-blocking; `REL-01` can ship deterministic-only |
| Pre-MNQ 2017 history | NQ surrogate only with explicit domain flag and separate reporting |
