# ADR-0016: QFA-611 alpha decision criteria

## Status

Accepted

## Context

Phase 4 closure (PRs #156-#162) established the regime substrate
(ADR-0013/0014/0015), validated cross-regime queue fidelity at the
+/-50,000 ppm SESOI granularity (QFA-420 Outcome A, regime-equivalent),
and locked the substrate into the determinism gate (QFA-420-h1 with
CF-27 + CF-28).

QFA-611 is the alpha decision: which validated strategies advance to
paper trading, then to live capital deployment, under what criteria.
ADR-0016 locks the criteria; QFA-611 implementation applies them.

The walkthrough that produced ADR-0016 rejected five draft decisions
on statistical grounds, all documented in
`docs/research/qfa-611-alpha-decision-research.md`:

- PSR >= 0.95 on paper-period alone is mathematically too tight (paper
  windows of 21-60 trading days require Sharpe 3.44-6.05 to clear PSR
  0.95 against zero null, even under the optimistic IID-Gaussian case)
- "Realized Sharpe within 30% of expected" is statistically mismatched
  to short paper windows; the Sharpe estimator is too noisy
- Cash-equity-style "position size as % of capital" is the wrong
  primitive for MNQ futures with discrete contract economics
- Calendar days are statistically vague; trading days are the right
  observation unit
- "Queue tolerance breach in ppm" is research-only language; live
  runtime kill-switches must use live-measurable triggers

The corrections preserve the anti-overfitting discipline from
ADR-0010 through ADR-0015 (White's Reality Check, Bailey-Lopez de
Prado PSR/DSR/MinTRL, Lo's Sharpe-dependence work, Newey-West HAC,
Ledoit-Wolf Sharpe-difference inference) and apply it consistently
to alpha promotion.

## Decision

LD-611-1: Evidence package required per strategy candidate.

Each strategy advancing to paper trading must have a validated
evidence package containing all of:

- Replay sanity (QFA-301): byte-deterministic decisions on identical
  input fixtures
- Strategy fingerprint (QFA-302): pinned via SHA-256 (now in Phase 4
  determinism gate per QFA-420-h1)
- Capability assessment (QFA-303): status `ready_for_replay` or
  `ready_for_live`; non-degraded
- Walk-forward held-out validation (QFA-410):
  - Tier A archive Feb-Mar-Apr 2026
  - Test windows only (LD-310-3 preserved)
  - Regime-stratified per QFA-420 Outcome A (regime-uniform sizing)
- Trial accounting (QFA-310 LD-310-6): max_of_manual_and_distinct_
  fingerprints; effective_trial_count documented and used in DSR
- Validation gate result (QFA-310): primary status `pass` with no
  warning codes overriding
- Cross-regime fidelity confirmation (QFA-420): system-level
  established (Outcome A); strategy-level execution sensitivity audit
  REQUIRED below

Strategy-level execution sensitivity audit (NEW addition):
A candidate strategy that is disproportionately concentrated in known
residual execution cells (e.g., sparse deep-queue states per ADR-0012
21+ queue-ahead diagnostic) MUST be flagged for coordinator review
even if the system-level QFA-420 outcome passed. Concentration
threshold: >= 30% of strategy's held-out trades occur in cells where
QFA-402c stratified within-tolerance share is below 750k ppm.

LD-611-2: Two-stage statistical gate.

Statistical evidence is partitioned by stage. The paper period adds
incremental observations to support strong live-promotion inference;
it does NOT carry standalone statistical weight on its own.

Stage 1 — Historical held-out evidence supports paper promotion:
- Deflated Sharpe Ratio (DSR) >= 0 under the locked effective trial
  count
- Probabilistic Sharpe Ratio (PSR) against zero null >= 0.80
- Dependence-adjusted annualized Sharpe ratio >= 1.0 with
  Newey-West HAC standard errors
- Predeclared non-overlapping return frequency for ALL Sharpe-style
  computations (locked at session-level by default; per-trade or
  per-bar requires explicit walkthrough exception)

Stage 2 — Combined archive-plus-paper OOS evidence supports live
promotion:
- DSR >= 0 maintained under updated effective trial count
- PSR against zero null >= 0.95
- PSR against the 12% hurdle rate null >= 0.50
- Dependence-adjusted annualized Sharpe ratio >= 1.0 maintained
- Newey-West HAC standard errors throughout

Observation unit lock:
The primary significance test uses session-level returns under
non-overlapping aggregation. Per-trade or higher-frequency views
are reported as robustness summaries only. Switching the observation
unit post-hoc would inflate effective sample size; this is
explicitly forbidden.

Tie-breaker among multiple passing strategies (when applicable):
Use Ledoit-Wolf studentized time-series bootstrap CI for the Sharpe
difference. The higher-Sharpe strategy is selected only if the 95%
CI on the Sharpe difference excludes zero. Otherwise, both candidates
proceed (or coordinator selects based on operational criteria).

LD-611-3: Quantitative thresholds (locked values).

Held-out / archive thresholds (Stage 1):

```text
Annualized hurdle rate:                 12.0%
  (vs current 3-month T-bill 3.69% per FRED 2026-05-07;
   demands ~831 bps excess over contemporaneous cash)

Minimum dependence-adjusted Sharpe:     1.0 (annualized; HAC SE)
DSR >= 0:                               required
PSR vs zero null:                       >= 0.80 (Stage 1)
                                        >= 0.95 (Stage 2; combined OOS)
PSR vs 12% hurdle null:                 >= 0.50 (Stage 2 only)

Maximum held-out drawdown:              8.0% of equity
  (200 bps headroom below 10% live kill-switch per LD-611-9)

Minimum profit factor:                  1.35
  (cushion vs research-to-live degradation)

Win rate:                               reported, NOT gating
                                        (rely on profit factor +
                                         expectancy)

Minimum total held-out trades:          300
  (95% binomial half-width ~5.7pp at p=0.5; 100 trades leaves
   ~9.8pp; 300 is the threshold where trade-level inference
   becomes meaningful)

Minimum trades per regime where regime contributes >= 10% of
candidate's held-out trades:            30 trades
  (95% half-width ~17.9pp at p=0.5; screening only)

Mid regime (n=3 sessions per QFA-420 substrate):
  treated as diagnostic unless strategy is materially active there
  by design AND meets the 30-trade per-regime floor under the
  >=10% contribution rule
```

LD-611-4: Position sizing rule.

Regime-uniform sizing across all regimes (high/mid/low). Carries
forward QFA-420 Outcome A: queue fidelity is regime-equivalent at
the SESOI granularity, so regime-conditioned sizing has no empirical
justification in Phase 5.

Regime-conditioned sizing remains an explicit Phase 6+ option, gated
on:
- A regime-detection-in-production methodology ADR (does not exist)
- QFA-510 evidence supporting regime-conditioned strategy behavior
  (held; orthogonal)

Default Phase 5 lock: regime-uniform sizing.

Conditional escape hatch: if a candidate strategy's evidence package
shows materially different held-out performance per regime
(>50% relative difference in dependence-adjusted Sharpe), surface as
research finding requiring coordinator walkthrough before paper
promotion.

LD-611-5: Capital framework — futures-native exposure locks.

Exposure is expressed in gross notional leverage, not in cash-equity
"% of capital" terms. MNQ economics (CME May 5, 2026 snapshot:
$2 x Nasdaq-100, ~$56,180 notional, $3,579 margin per contract)
require this primitive.

```text
Gross notional leverage cap:            2.0x equity
Concurrent position cap:                1 (single-instrument family)
Capital planning unit:                  ~$30,000 per intended
                                        steady-state MNQ contract
                                        (2.0x leverage / contract
                                         notional rounded conservatively)

Live capital ramp (in contract counts, not %):
  Smallest practical steady-state book: 3 contracts (~$90,000)
  Ramp schedule:                        1 -> 2 -> 3 contracts
                                        (each step requires gates
                                         in LD-611-8 met for >= 30
                                         live trading days at the
                                         current step)

  If intended live capital supports only 1 contract:
    Ramp is binary (trade 1 contract or trade nothing).
    No fractional contract trading.

Paper trading capital:                  Set equal to intended initial
                                        live capital. Do not
                                        paper-trade with unrealistic
                                        notional.
```

LD-611-6: Risk budgets (regime-uniform).

```text
Per-trade equity at risk:               0.25% of equity
  (stop-loss-derived; conservative Kelly-fractional)

Daily loss circuit-breaker:             1.0% of equity
  (~ 4 max-loss trades cumulative; auto-pause on hit, NOT auto-resume)

Weekly drawdown circuit-breaker:        3.0% of equity
  (~ 3 daily kill-switch trips; auto-pause on hit, NOT auto-resume)

Total drawdown kill-switch:             10.0% of equity
  (full halt; coordinator review required for restart)
```

All four limits are regime-uniform per LD-611-4. Regime-conditioned
risk budgets are explicitly out of scope for Phase 5.

LD-611-7: Paper trading protocol.

Observation period locked in trading days (not calendar days):

```text
Minimum:        45 trading days
Recommended:    60 trading days
Rationale:      Covers >= 1 quarterly futures roll cycle, multiple
                payroll Fridays, multiple FOMC cycles. Sufficient
                operational and distributional calibration evidence
                without forcing the period to carry standalone
                statistical alpha proof.
```

Observed-vs-expected metrics (predictive-interval based, NOT fixed
relative tolerances):

```text
Realized cumulative return:
  must lie inside predeclared block-bootstrap predictive interval
  generated from held-out historical OOS returns
  (bootstrap method: stationary block bootstrap with median block
   length tuned per Politis-Romano; 10,000 replications; fixed seed)

Realized drawdown:
  must not exceed held-out p95 block-bootstrap drawdown forecast
  by more than 200 bps absolute buffer

Realized trade count:
  must be within +/- 25% of expected (count metrics tolerate fixed
  relative tolerance better than Sharpe-style estimators)

Realized expectancy per trade:
  must not fall below the lower bound of bootstrap or HAC confidence
  interval implied by held-out evidence

Realized slippage / fill quality:
  must lie inside predictive interval implied by the held-out
  execution model
  (specifically: per-trade slippage as fraction of stop distance,
   compared to held-out distribution; >5% of trades outside p99
   triggers anomaly flag)

Operational thresholds (exact, not interval):
  Live data feed:        zero gaps > 30 seconds during paper period
  Order execution:       100% paper orders ack'd by simulator
  Reconciliation:        100% match between expected and recorded
                         positions/fills at end of every paper day
  Determinism CI:        green at every commit during paper period
```

Pass criteria for live promotion (paper-stage):
ALL six observed-vs-expected metrics within their predictive
intervals or fixed thresholds AND no kill-switch event during the
paper period AND DSR/PSR maintained on combined OOS package per
LD-611-2 Stage 2 thresholds.

Fail handling on any metric:
- Strategy paused
- Coordinator review
- Decision options: extend paper observation (early-period anomaly),
  return to research (structural divergence), permit live with
  reduced size (minor drift, requires documented justification)

Paper trading does NOT count toward live operational record. All
live operational metrics start from live promotion.

LD-611-8: Paper-to-live promotion gates (8 gates, ALL required).

```text
G1: Paper observation period satisfied (LD-611-7)
G2: All observed-vs-expected metrics within predictive intervals
    or thresholds (LD-611-7)
G3: Stage 2 statistical gate met on COMBINED archive+paper OOS
    package per LD-611-2 thresholds:
      - DSR >= 0 (combined effective trial count)
      - PSR vs zero null >= 0.95
      - PSR vs 12% hurdle null >= 0.50
      - Dependence-adjusted Sharpe >= 1.0 (HAC SE)
G4: No kill-switch event during paper period (LD-611-9)
G5: Operational systems verified:
      - Live data feed: zero gaps > 30s during paper
      - Order execution: 100% paper orders ack'd
      - Reconciliation: 100% daily position/fill match
      - Determinism CI: green at every commit during paper
G6: Operator console monitoring verified live
    (apps/operator_console)
G7: Kill-switch tested manually >= 1 time during paper period
    (manually trigger; verify halt; verify recovery; document)
G8: Coordinator sign-off on live promotion explicitly
```

Promotion event:
- Document promotion in PR with all 8 gates evidenced
- Initial live capital = LD-611-5 ramp Week 1-2 contract count
- Capital ramp schedule begins per LD-611-5

LD-611-9: Kill-switch architecture (live-measurable triggers).

```text
Per-trade kill-switches:
  - Stop loss hit (per-strategy parameter)
  - Order rejection (broker-side error)
  - Position size limit exceeded (LD-611-5 gross notional cap)

Per-session kill-switches:
  - Daily loss limit hit (LD-611-6: 1.0%)
  - Trade-rate anomaly (>2x expected trades in window)
  - Slippage anomaly: >5% of session's trades outside the
    held-out p99 slippage predictive interval
    (live-measurable; replaces research-only "queue tolerance ppm
     breach" wording)
  - Fill-quality anomaly: realized fill quality fall outside
    predictive interval lower bound for the session

Per-week kill-switches:
  - Weekly drawdown limit hit (LD-611-6: 3.0%)

Total kill-switches:
  - Total drawdown kill-switch (LD-611-6: 10.0%)
  - Repeated daily kill-switch trips (>=3 in 5 trading days)
  - Determinism CI failure on any commit during live operation
  - Operator console: lost connection > 5 minutes
  - Risk runtime: any contract-violation alert

Manual:
  - Operator-initiated kill (red button in console)
  - Any time, any reason, no questions

Resume after kill-switch trip:
  1. Coordinator review (mandatory; no auto-resume on any trigger)
  2. Root-cause analysis documented
  3. Structural problem -> return to research
  4. Transient -> explicit resume authorization at REDUCED size
     (e.g., 50% of previous contract count for >= 1 trading week,
      then ramp back per LD-611-5)
  5. Auto-resume: NEVER, on any trigger, ever
```

LD-611-10: Pause / restart / roll-back semantics.

Paused state:
- All open orders cancelled
- All open positions closed at market or via existing stops
- Strategy decision engine receives `no_new_orders` flag
- Operator console shows paused status prominently
- Logs continue; data continues flowing
- Determinism gate continues running on commits

Resume from pause:
- Always requires explicit operator action
- Always requires evidence of root-cause resolution
- Always starts at reduced size per LD-611-5 ramp schedule

Roll-back to research:
- All paper or live data preserved as audit trail
- New tickets created for whatever issue triggered roll-back
- Methodology lock(s) explicitly re-evaluated if statistical
  assumptions violated
- No silent return to live; explicit re-promotion required

Determinism violation during live:
- Live trading PAUSED immediately (kill-switch trigger)
- Determinism CI fixture investigated
- Unintentional drift -> restore + resume per pause/resume protocol
- Structural drift -> ADR amendment required before resume

LD-611-11: Out-of-scope guards.

ADR-0016 ONLY locks alpha decision criteria. Out of scope:

- Specific strategy parameter values (per-strategy work, not
  alpha-decision)
- Rithmic adapter implementation (Phase 6 territory)
- Operator console UI/UX changes
- Production deployment topology
- Capital sourcing or broker selection
- Tax/legal/regulatory compliance
- Backup / disaster recovery procedures
- Pricing/fee analysis
- Strategy parameter tuning or re-optimization
- Live data subscription costs
- Network failover engineering
- QFA-510 HMM model layer (held; orthogonal)
- QFA-105-streaming-throughput (deferred; orthogonal)
- Post-Outcome-A regime conditioning revival (requires Phase 6+
  ADR)
- ADR-0010..0015 amendments

LD-611-12: Implementation flow.

QFA-611 implementation (engineer-autonomous post-ADR-0016):

- Apply ADR-0016 criteria to ACTIVE_STRATEGY_IDS (currently 5
  candidate strategies)
- For each strategy:
  - Run QFA-410 held-out validation on Tier A archive Feb-Mar-Apr
    2026 (test windows only)
  - Compute DSR, PSR (vs zero and vs 12% hurdle), dependence-adjusted
    annualized Sharpe with Newey-West HAC SE
  - Compute regime-stratified evidence per QFA-420 Outcome A
  - Apply LD-611-3 quantitative thresholds
  - Apply LD-611-1 strategy-level execution sensitivity audit
    (concentration check)
  - Determine: ADVANCE_TO_PAPER / REJECT / RESEARCH_FURTHER
- Emit research artifact with per-strategy verdicts
- Emit canonical strategy-selection.json artifact

Phase 6 dispatch (post-QFA-611 implementation results):

- QFA-612: Live integration scaffolding (Rithmic adapter scope)
- QFA-613: Paper trading harness
- QFA-614: Operator console wiring for live monitoring
- QFA-615..N: Per-strategy implementation (only ADVANCED ones)

Failure cases:

- 0 strategies ADVANCE_TO_PAPER -> return to research; refine
  strategies or methodology before re-running
- 1+ strategies ADVANCE_TO_PAPER -> proceed to Phase 6 with the
  ADVANCED set
- Multiple ADVANCED strategies AND coordinator wants to select:
  use Ledoit-Wolf Sharpe-difference tie-breaker per LD-611-2

LD-611-13: ADR-0016 status posture.

Status: Accepted on PR merge.

ADR-0016 IS the alpha decision methodology lock. QFA-611
implementation applies these locks against existing evidence.

Methodology amendments to ADR-0016 require new ADR (e.g., ADR-0017,
ADR-0018) as successors, never in-place edits — same predecessor-
preservation discipline as ADR-0010..0015 chain.

Specific scenarios that would trigger a successor ADR:

- Zero-strategy outcome forces methodology re-evaluation
- Paper trading observation reveals systematic error in any LD-611
  lock
- QFA-510 evidence overrides regime-uniform default (LD-611-4)
- Live trading evidence requires kill-switch threshold revision
- Regime-detection-in-production methodology is locked (would update
  LD-611-4 default)

## Consequences

QFA-611 implementation can proceed against the existing Tier A
archive (Feb-Mar-Apr 2026, 60+ sessions, regime-labeled) with
the locked methodology. Strategies in ACTIVE_STRATEGY_IDS that
satisfy LD-611-1 + LD-611-2 Stage 1 + LD-611-3 advance to paper.

Paper trading is operational and distributional calibration; it
adds incremental OOS observations rather than carrying standalone
statistical alpha proof. Live promotion requires Stage 2 statistical
gate on the combined archive+paper OOS package.

Capital framework expressed in futures-native gross notional leverage
(2.0x cap), with capital planning in $30k-per-MNQ-contract increments
and live ramps in contract counts. The smallest practical steady-state
book is 3 contracts (~$90k); below that, ramping is effectively
binary (trade 1 contract or trade nothing).

Risk budgets and kill-switches are regime-uniform under QFA-420
Outcome A. Regime-conditioned variants are gated on a future Phase 6+
ADR and either QFA-510 evidence or production regime-detection
methodology.

Phase 6 unblocks on QFA-611 implementation completion, with the
ADVANCED strategy set as the input scope for live integration tickets
(QFA-612 Rithmic adapter, QFA-613 paper harness, QFA-614 operator
console wiring, QFA-615..N per-strategy live).

ADR-0010 through ADR-0015 are preserved unchanged. The QFA-105 model
is unchanged. The QFA-402 formula is unchanged. Validation policy,
RunSpec contracts, journal events, and CI behavior are unchanged
until LD-611-12 implementation introduces strategy-selection.json
as a new validated artifact (separate ADR for that determinism
inclusion if/when needed).

## References

- ADR-0010 - Validation gate
- ADR-0011 - QFA-402 threshold posture
- ADR-0012 - QFA-402 probe policy lock at 15s/60s
- ADR-0013 - Regime substrate methodology
- ADR-0014 - QFA-212 archive-size adjustment
- ADR-0015 - QFA-420 cross-regime stratification
- `docs/research/qfa-611-alpha-decision-research.md`
- White (2000), Reality Check for data-snooping bias
- Bailey & Lopez de Prado (2012), Probabilistic Sharpe Ratio /
  Deflated Sharpe Ratio / Minimum Track Record Length
- Lo (2002), The Statistics of Sharpe Ratios
- Newey & West (1987), heteroskedasticity-and-autocorrelation-
  consistent covariance estimator
- Ledoit & Wolf (2008), Robust performance hypothesis testing
  with the Sharpe ratio
- Politis & Romano (1994), stationary block bootstrap
- CME MNQ contract specifications (May 5, 2026 snapshot:
  $2 x Nasdaq-100, ~$56,180 notional, $3,579 margin)
- FRED 3-month Treasury constant-maturity yield (3.69% as of
  2026-05-07)
- QFA-119d PR #159, Tier A archive forward extension
- QFA-212 PR #158, regime substrate v1+v2
- QFA-420 PR #161, cross-regime stratification (Outcome A)
- QFA-420-h1 PR #162, determinism gate promotion
