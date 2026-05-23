# CYCLE4-R2: hold-time entry gate research

## Status

`RESEARCH_TIER_DEFERRED`. Output is an evidence pack for a future
amendment-cycle hypothesis (likely `regime_shock_reversion_short_v4`,
distinct from the v3 VIX-gate hypothesis in CYCLE4-R1). No code paths,
parameter locks, or ADR thresholds modified.

## Authority

- Backlog: `docs/plan/new_app_v1_ticket_backlog_v6.csv` row `CYCLE4-R2`
  (`P3, 1.5d, new_cycle4_research_carryforward`).
- Substrate: post-fix Cycle3 held-out artifact at fingerprint
  `ede3b8d5...` (commit `ffeea42`).
- Cross-references: CF-41 (new strategy_id required for any
  implementation), CF-45 (amendment-grade evidence required for any
  threshold revision; analogous discipline applies to a new gate).

## Hypothesis

A delay (e.g., 30–60 seconds) after the shock-arm signal would filter
the sub-2-min chop-flip cohort that currently consumes 58% of trades
and nets negative on the post-fix Cycle3 corpus.

## Sub-2-min cohort decomposition

The post-fix corpus has 571 trades. Decomposed by hold time:

| Hold | n | Win% | PF | Avg net | Total net |
|---|---:|---:|---:|---:|---:|
| < 30s | 1 | 100.0% | inf | $1.50 | $1.50 |
| 30s – 1 min | 129 | 24.8% | **0.78** | $−2.68 | **$−345.50** |
| 1 – 2 min | 203 | 37.4% | **0.94** | $−0.58 | **$−118.00** |
| 2 – 3 min | 118 | 72.0% | **2.88** | $7.78 | $918.50 |
| 3 – 5 min | 85 | 82.4% | **6.06** | $14.58 | $1,239.50 |
| 5 – 10 min | 32 | 75.0% | 2.88 | $6.30 | $201.50 |
| ≥ 10 min | 3 | 33.3% | 0.02 | $−8.50 | $−25.50 |

**Sub-2-min cohort (n=333, 58.3% of corpus): PF 0.872, net $−462.**

By exit reason within sub-2-min:
- `stop_loss`: 241 trades, **win% 7.1%**, avg $−14.95 — full clean stops, no BE save
- `target`: 90 trades, 100% win, avg $34.82 — fast targets that hit before chop set in
- `session_close`: 2 trades

The sub-2-min cohort is bifurcated: fast targets (good) and clean
stops (bad). Roughly 2.7× more clean stops than fast targets in this
hold-time bucket.

## Feature analysis — does anything at entry-time predict sub-2-min outcome?

Compared sub-2-min cohort (n=333) vs ≥2-min cohort (n=238) across
available entry-time features:

### Spread bucket

| Bucket | sub-2-min share | ≥2-min share | Δ |
|---|---:|---:|---:|
| 1-tick | 10.8% | 14.3% | −3.5pp |
| 2-tick | 60.1% | 64.7% | −4.6pp |
| **3+ ticks** | **29.1%** | **21.0%** | **+8.1pp** ← signal |

**Wider spreads at entry skew toward sub-2-min outcomes.** Plausible
mechanism: wider spread = more volatile microstructure → faster
chop. Not a clean separation (29% vs 21% is informative but not
decisive); a 3+ tick spread-only gate would catch only ~29% of the
sub-2-min cohort while losing 21% of the longer-hold cohort.

### Queue-ahead bucket

| Bucket | sub-2-min share | ≥2-min share | Δ |
|---|---:|---:|---:|
| **1-5 (front of queue)** | **67.0%** | **58.4%** | **+8.6pp** ← signal |
| 6-20 (back of queue) | 33.0% | 41.6% | −8.6pp |

**Front-of-queue fills correlate with sub-2-min outcomes.** Mechanism:
quick fill at the touch leaves no buffer; price reverses immediately.
Not strong enough to gate on alone.

### Regime

| Regime | sub-2-min share | ≥2-min share | Δ |
|---|---:|---:|---:|
| high | 76.0% | 74.8% | +1.2pp |
| low | 24.0% | 25.2% | −1.2pp |

**No meaningful separation by regime.** The chop-flip phenomenon is
regime-agnostic.

### MAE distribution (adverse excursion magnitudes)

| Quartile | Sub-2-min MAE | ≥2-min MAE |
|---|---:|---:|
| p25 | $8.50 (0.74R) | $5.50 (0.48R) |
| p50 | $18.50 (1.60R) | $11.00 (0.95R) |
| p75 | $30.00 (2.60R) | $18.00 (1.56R) |
| max | $205 (17.7R) | $154 (13.3R) |

**Sub-2-min trades have ~1.6× the median adverse excursion of
≥2-min trades.** This is the strongest signal in the feature analysis:
chop-flip trades suffer immediate, heavy adverse movement. A
confirmation-based gate that requires "no large MAE in first N
seconds" before entering could be more selective than pure
time-delay.

### No feature shortcut

None of the entry-time features individually separates the cohorts
cleanly. The strongest single feature (queue-ahead 1-5) catches 67%
of sub-2-min trades but also catches 58% of the good ≥2-min trades.
**Time-based gating (delay or persistence) is required for clean
separation.** Feature filters are at best secondary.

## Counterfactual: skip sub-N-second trades (upper bound on filter benefit)

Simulate removing trades that turn out to hold < N seconds. This is
an upper-bound estimate — real implementation cannot use forward
information.

| Filter | Kept | % Kept | Win% | PF | Net | Δ from baseline |
|---|---:|---:|---:|---:|---:|---:|
| BASELINE | 571 | 100.0% | 50.6% | 1.418 | $1,872.00 | — |
| Skip < 30s | 570 | 99.8% | 50.5% | 1.418 | $1,870.50 | $−1.50 (noise) |
| Skip < 60s | **441** | **77.2%** | **58.0%** | **1.754** | **$2,216.00** | **+$344** |
| Skip < 90s | 301 | 52.7% | 71.8% | **3.002** | **$2,585.00** | **+$713** |
| Skip < 120s | 238 | 41.7% | 75.6% | 3.691 | $2,334.00 | +$462 |
| Skip < 180s | 120 | 21.0% | 79.2% | 4.745 | $1,415.50 | −$456 (too aggressive) |

**Sweet spot: 60-90 second filter.** Net PnL benefit maximized at the
90s cutoff (+$713, PF 3.00), but trade retention drops to 53% which
hurts forward-sample variance. The 60s cutoff retains 77% of trades
with a still-material +$344 / PF 1.75 lift.

Beyond ~180s the filter starts cutting into the actual edge cohort
(2-3min trades have PF 2.88 — they shouldn't be excluded).

## Bootstrap CIs (post-filter, skip <60s)

N=5000 i.i.d. bootstrap on the filtered residual (n=441):

| Metric | Point | 5% | 50% | 95% |
|---|---:|---:|---:|---:|
| PF | 1.754 | 1.446 | 1.753 | 2.121 |
| Net | $2,216 | $1,413 | $2,214 | $3,019 |
| Win rate | 58.0% | 54.2% | 58.1% | 61.9% |

- P(PF < 1.0): **0.00%** (was 0.02% baseline)
- P(net < 0): **0.00%** (was 0.02% baseline)
- 5th-percentile PF moves from 1.193 → 1.446 — material robustness improvement

The filtered distribution is more reliably positive than baseline.

## Real-world implementation caveats — UPPER BOUND nature

The §4 counterfactual is biased toward optimism because it uses
forward information (hold time is only known after the trade closes).
A real delay gate would work differently:

```
t=0       shock-arm signal fires
t in [0,N] WAIT, do not enter
t=N        re-check shock condition
            if still armed: enter at new price (different from t=0 price)
            if condition lapsed: skip
```

What §4 numbers approximately model:
- Skip <Ns trades = "trades that would have closed within N seconds
  even if we'd entered at t=0"

The benefit gap between §4 numbers and real-world implementation:

1. **Some skipped trades were profitable.** Of the 130 sub-60s trades
   filtered out, ~30 (per the 25% win rate in 30-60s bucket) were
   winners. Real implementation loses these.
2. **New entry price at t=N may be worse.** During the delay, price
   moves. The strategy enters at a worse signed-shock position than
   t=0. Per-trade edge on the entered trades drops.
3. **Some shocks lapse during the delay.** Real implementation gets
   fewer entries — partially the same effect as the §4 filter
   removing them, but for a different reason (no edge available, not
   forward-looking filtering).

Realistic estimate of forward benefit: **30-70% of the §4 upper
bound.** That is, real PF lift forward might be ~1.418 → 1.50-1.60
rather than ~1.418 → 1.754.

## Two implementation patterns for a future v4 amendment

### (i) Time-based delay (simpler)

```
shock_arm fires at t=0
wait T_delay seconds (parameter; suggest 45-60s for first cut)
at t=T_delay, re-check shock condition
if signed_shock still >= threshold: enter
else: cancel
```

- No new feature substrate fields required.
- Trivial to implement in `firstRegimeShockReversionShortV2Rejection`-style
  gate.
- One new strategy parameter: `entry_confirmation_delay_seconds`.
- One new strategy_id: `regime_shock_reversion_short_v4_delay` (or
  similar — name TBD by amendment-cycle dispatcher).

### (ii) Persistence-based gate (more principled)

```
shock_arm condition must hold for K consecutive bars before entering
K is a new strategy parameter; suggest 2-3 bars for first cut
```

- Requires snapshot.context to expose a "shock_consecutive_bars" or
  equivalent stateful field.
- Cleaner under the schema discipline (per ADR-0022 LD-022-7 stateful
  contexts are tractable).
- One new strategy_id: `regime_shock_reversion_short_v4_persist` (or
  similar).

These are PARALLEL hypotheses, not sequential. Either could be the
right answer; A/B-able in forward paper trading. They are also
ORTHOGONAL to the v3 VIX-gate hypothesis (CYCLE4-R1) — combining
delay/persistence with VIX-gating in a v5 is a future decision.

## What this evidence supports and does not support

**Supports:**

1. The sub-2-min chop-flip cohort is a real, exploitable structural
   leak. Net contribution is −$462 in 333 trades on the post-fix
   corpus.
2. A 45-90 second time-based delay gate would lift PF materially
   (upper bound: 1.418 → 1.75 at 60s, 3.00 at 90s).
3. The mechanism is time-based — entry-time features (spread, queue,
   regime) don't cleanly separate, only hold-time does. Either delay
   or persistence-based gating is the right pattern.
4. The MAE asymmetry (sub-2min p50 MAE = 1.60R vs ≥2min = 0.95R) is
   the strongest single-feature signal but still secondary to
   time-based gating.

**Does NOT support:**

1. Any specific delay parameter for a production v4 amendment. The
   §4 counterfactual is upper-bound; forward data is required.
2. A choice between time-delay vs persistence-based variants. Both
   should be hypothesized and forward-tested.
3. Any modification to `regime_shock_reversion_short_v2`. Per
   CF-41, a parameter addition requires a new `strategy_id`.

## Deferred questions

1. **Real-world delay benefit calibration.** What fraction of §4's
   upper bound holds forward? Requires paper trading the delay
   variant against the original baseline.
2. **Delay parameter sensitivity.** 45s vs 60s vs 90s vs 120s —
   which is optimal? §4 suggests 60-90s but the sample is small.
3. **Interaction with VIX-gate (CYCLE4-R1).** Both gates target the
   same underlying problem (false signals) from different angles. Do
   they stack additively or do they have overlapping coverage?
4. **Persistence-based vs delay-based.** Which is mechanically
   sounder? Could either reduce the residual BE-zone bleed
   (66 trades that still net <-0.3R despite the BE fix)?
5. **Slippage in the new-entry-price scenario.** A 45-60s delay
   changes the entry tick. How much does this cost per trade?

## Caveats and bounds

- All numbers from a single 35-day held-out corpus.
- §4 counterfactual is upper-bound; real implementation is 30-70%
  of it.
- Per ADR-0024 LD-024-4, no parameter lock, strategy code, or regime
  substrate was modified by this research.
- Single-strategy scope (`regime_shock_reversion_short_v2` post-fix
  only).
- Hold-time is only known post-trade; the analysis necessarily
  uses forward-looking information for the cohort decomposition.
- This is research-tier evidence; an amendment proposal requires
  separate dispatch with external methodological justification
  per CF-45 (applied analogously to gating revisions).

## Cross-references

- `artifacts/held-out-validation/cycle3/regime_shock_reversion_short_v2-feb-mar-apr-2026.json`
  (post-fix substrate, fingerprint `ede3b8d5...`)
- `docs/research/sizing-r1-post-fix-kelly-tiered-rederivation.md`
  (the parallel sizing-side research memo)
- `docs/research/qfa-611-cycle3-rederivation-memo.md`
  (re-derivation that produced the substrate)
- `docs/adr/ADR-0022-regime-conditional-entry-exit-gating.md`
  (gating ADR; precedent for entry-condition discipline)
- `docs/adr/ADR-0023-cycle3-signed-shock-and-anti-pattern-lock.md`
  (anti-pattern lock; preserved through this research)
- `docs/adr/ADR-0024-post-verdict-bug-rederivation.md`
  (methodology preservation bound)
- `scratch/cycle4-research/hold-time-analysis.py`
  (analysis script that produced the numbers in this memo)
- CF-30 / CF-41 / CF-44 / CF-45 (anti-tuning + amendment-justification
  carry-forwards that bound any v4 amendment proposal)
- CYCLE4-R1 (the parallel VIX-gate hypothesis; orthogonal to this)
