# QFA-611 alpha decision criteria — research artifact

## Status

Research artifact accompanying ADR-0016. Captures the walkthrough
methodology, statistical reasoning, and quantitative thresholds that
produced the ADR-0016 locks.

## What the literature makes non-negotiable

The QFA-611 frame is directionally correct on the big point: alpha
promotion cannot be a raw-Sharpe beauty contest. White's Reality Check
exists precisely because repeated model or rule search on the same time
series can make luck look like skill. Bailey, Borwein, Lopez de Prado,
and Zhu show that even ordinary holdout procedures can still be
unreliable in investment backtests and propose explicit overfitting
diagnostics for backtest selection. Once you have multiple candidate
strategies, multiple manual variants, and a finite archive, trial
accounting is not an optional polish item; it is the core statistical
defense against data-mined false positives.

The right question is not "what Sharpe did we observe?" but "what
confidence do we have that the observed Sharpe exceeds a relevant
threshold after correcting for sample length, non-normality, and
multiplicity?" Bailey and Lopez de Prado's Probabilistic Sharpe Ratio
incorporates sample length, skewness, and kurtosis. Their Deflated
Sharpe Ratio further adjusts the rejection threshold for the number
of independent trials and the variance across tested Sharpe ratios.
Their Minimum Track Record Length is expressed in number of
observations, not in calendar time; if the track record is shorter
than MinTRL, the strategy has not earned the claimed skill threshold
yet.

Lo's Sharpe-ratio work is the second load-bearing pillar. Monthly
Sharpe ratios cannot, in general, be annualized by multiplying by the
square root of 12 except under special conditions, and serial
correlation can overstate annual Sharpe by as much as 65% in
hedge-fund-style data. Any QFA-611 statistic that pretends serially
dependent returns are IID must be rejected. The correct dependence
discipline is HAC-robust inference, for which Newey-West remains the
canonical baseline.

If QFA-611 eventually has to choose among multiple passing strategies,
Ledoit and Wolf show that standard Sharpe-difference tests are not
robust when returns are heavy-tailed or serially dependent. They
recommend a studentized time-series bootstrap confidence interval for
differences in Sharpe ratios. The tie-breaker rule is: highest Sharpe
wins only if the Sharpe-difference confidence interval excludes zero.

## Where the original draft was statistically too tight

The original walkthrough draft's paper-period significance requirement
was underpowered. Using Bailey's PSR formula in the optimistic
IID-Gaussian case, a paper-only sample with about 60 trading-day
observations requires an annualized Sharpe of roughly 3.44 to achieve
PSR = 0.95 against a zero null. A 30-calendar-day paper window, which
is only about 21 trading days, requires an annualized Sharpe of
roughly 6.05. Even 120 daily observations still require an annualized
Sharpe of about 2.41 to reach PSR = 0.95. Real-world skewness,
kurtosis, and autocorrelation make these requirements harder, not
easier.

The same problem appears in the draft's "realized Sharpe within 30%
of expected Sharpe during paper" rule. Over a 45-60 trading-day paper
window, the annualized Sharpe estimator is too noisy for a +/-30%
relative tolerance to be meaningful. Under Lo's asymptotic
Sharpe-ratio variance, a 60-day daily-return estimate of annualized
Sharpe has a very wide confidence band; a strategy can be perfectly
healthy and still miss a +/-30% realized-vs-expected Sharpe tolerance
by pure sampling noise.

This led to the single biggest recommendation for ADR-0016: split the
statistical gate into two stages. The historical held-out archive is
the gate for advancing to paper. The combined archive-plus-paper
out-of-sample record is the gate for advancing to live. PSR = 0.95
belongs on the combined OOS package, not on the short paper segment
alone.

A second necessary refinement: ADR-0016 must explicitly lock the
observation unit used for DSR, PSR, and HAC Sharpe. Bailey's MinTRL
is in observations, not calendar terms. Without this lock,
implementation could accidentally inflate effective sample size by
moving to a too-fine return frequency after seeing the data. Locked
at session-level non-overlapping aggregation by default.

## Quantitative thresholds — derivations

### Hurdle rate (12% annualized)

The 3-month Treasury constant-maturity yield is 3.69% as of 2026-05-07
per FRED. A 12% hurdle demands approximately 831 basis points of
excess performance over a contemporaneous cash alternative. This is
conservative without being degenerate.

### Sharpe floor (1.0)

DSR and PSR are already handling the credibility problem. Pushing the
point-estimate Sharpe floor much higher mostly duplicates what DSR/PSR
are supposed to decide. Sharpe 1.0 is the right floor because
significance gates carry the inferential weight.

### Drawdown floor (8%)

The proposed live kill-switch is 10%. Leaving at least 200 basis
points of headroom between historical evidence and live hard-stop is
prudent. Strategies whose held-out drawdown is within 200 bps of the
kill-switch are likely to trip it under live noise.

### Profit factor floor (1.35)

Provides cushion against the mild degradation that often appears when
a strategy moves from historical replay to paper and live execution.
1.30 is a common minimum but does not allow for execution-degradation
buffer.

### Trade count floor (300 total held-out)

Under the ordinary binomial approximation, if true win probability
were 50%, 300 trades give a 95% half-width of roughly 5.7 percentage
points for the estimated win rate. 100 trades still leave almost 9.8
percentage points of uncertainty. 300 is the threshold where
trade-level inference becomes meaningful. Profit factor and expectancy
should dominate win rate; pure "100 trades is enough" reasoning is too
permissive for deployment decisions.

### Per-regime trade count (30 trades, conditional)

Because QFA-420 already established regime-uniform queue fidelity at
the project's SESOI, QFA-611 does not need symmetrical trade counts in
every regime for every strategy. A strategy that is genuinely sparse
in mid or low regimes should not automatically fail solely because
the substrate has only 3 mid-regime sessions and 11 low-regime
sessions. The correct lock: require at least 30 trades in any regime
that contributes at least 10% of the candidate's held-out trades, and
treat mid-regime evidence as diagnostic unless the strategy is
materially active there by design.

30 trades only support screening-level inference: the 95% half-width
on a 50% win rate at 30 trades is about 17.9 percentage points.
Mid-regime traffic remains too noisy to carry a load-bearing alpha
claim.

No standalone win-rate floor is used; if a single line in ADR-0016 is
needed, the correct line is "win rate reported, not gating."

## Capital, leverage, and contract economics

The current MNQ contract economics strongly suggest that QFA-611
should express exposure in notional leverage, not in "percent of
capital committed." Official contract data:

```text
MNQ contract                    $2 x Nasdaq-100
Minimum tick                    0.25 index points
CME May 5, 2026 estimated:
  Notional                      ~$56,180
  Margin                        ~$3,579 per contract
```

These numbers make plain why "position size as % of capital" is the
wrong primitive for futures. The right primitive is gross notional
exposure divided by account equity.

The best operational default is a 2.0x gross notional leverage cap.
At current contract economics, that implies a minimum equity of about
$28,090 per MNQ contract, which rounds naturally to $30,000 per
contract as a deployment planning unit.

Implication for live ramp: the smallest practical steady-state book
is not one contract but about three contracts, or roughly $90,000 of
live capital, because that lets you ramp 1 -> 2 -> 3 contracts
without violating the leverage cap. If intended live capital is only
enough for one contract, the ramp is effectively binary: trade one
contract or trade nothing.

## Risk budgets — internal consistency

The conservative stack:

```text
Per-trade equity at risk:               0.25%
Daily loss limit:                       1.0%
Weekly drawdown circuit-breaker:        3.0%
Total drawdown kill-switch:             10.0%
```

Internal consistency check:

- 1.0% daily limit allows ~ 4 full-risk losses at the cap before
  pausing
- 3.0% weekly limit halts the system after roughly 3 bad max-loss
  days inside a week
- 10.0% total kill-switch is tight enough to prevent slow bleed
  while still leaving room for normal variation

Because Phase 4 showed regime invariance at the SESOI, there is no
empirical reason to weaken or strengthen these limits by regime in
Phase 5. Regime-conditioned risk budgets remain explicitly out of
scope until a future regime-detection-in-production ADR exists.

## Paper-trading protocol — evidence-consistent

The paper observation period locked in trading days, not calendar
days. The original "30-60 calendar days" is statistically imprecise
and too short if the paper segment is expected to support any strong
independent inference. The better lock is 45-60 trading days, with
60 preferred. That window:

- Covers >= 1 quarterly futures-roll environment (CME contract
  specifications confirm the quarterly cycle and third-Friday
  settlement structure for Micro E-mini equity-index futures)
- Spans multiple payroll releases
- Spans multiple FOMC cycles
- Contributes a nontrivial amount of additional out-of-sample
  evidence to the combined live-promotion gate

The paper stage is operational and distributional calibration, NOT
standalone statistical proof of alpha. The six observed-vs-expected
metrics are predictive-interval based:

```text
Realized cumulative return:
  Inside predeclared block-bootstrap predictive interval generated
  from held-out historical OOS returns
  (stationary block bootstrap, 10,000 reps, fixed seed)

Realized drawdown:
  Not exceeding held-out p95 block-bootstrap drawdown forecast +
  200 bps absolute buffer

Realized trade count:
  Within +/-25% of expected
  (count metrics tolerate fixed relative tolerance better than
   Sharpe-style estimators)

Realized expectancy per trade:
  Not below lower bound of bootstrap or HAC CI implied by held-out
  evidence

Realized slippage / fill quality:
  Inside predictive interval implied by held-out execution model
  (per-trade slippage as fraction of stop distance compared to
   held-out distribution; >5% of trades outside p99 triggers anomaly)

Operational thresholds (exact, not interval):
  - Live data feed: zero gaps > 30 seconds during paper period
  - Order execution: 100% paper orders ack'd by simulator
  - Reconciliation: 100% match between expected and recorded
    positions/fills at end of every paper day
  - Determinism CI: green at every commit during paper period
```

Fixed rules like "Sharpe within 30% of expected" are removed because
they are statistically mismatched to short paper windows.

## Kill-switch architecture — live-measurable

The original kill-switch architecture was mostly sound, but one clause
needed rewriting before ADR-0016. A live auto-halt based on a direct
"400k ppm queue tolerance breach" is not operationally native: the
live runtime does not observe historical ground truth in the same way
as the fidelity research pipeline.

The live slippage or execution anomaly trigger is instead defined as:
- A breach of the paper-validated slippage predictive interval
  (>5% of session's trades outside the held-out p99 slippage interval)
- A large deviation from the expected fill-quality model

Both are observable in production. The broader architecture --
per-trade stop conditions, daily/weekly/total drawdown halts, manual
operator kill, no auto-resume -- remains correct.

Resume after kill-switch: explicit, manual, size-reduced, no
automatic recovery on any trigger ever.

## Strategy-level execution sensitivity audit (NEW addition)

Because queue fidelity is validated at the system level (QFA-420
Outcome A), a candidate strategy that is disproportionately
concentrated in known residual execution cells -- such as sparse
deep-queue states (ADR-0012 21+ queue-ahead diagnostic, where
within-tolerance share remains poor: 471k/505k Feb sessions) -- can
behave materially worse than the system-level evidence implies.

ADR-0016 LD-611-1 adds the strategy-level audit:

```text
Concentration trigger:
  >= 30% of strategy's held-out trades occur in cells where
  QFA-402c stratified within-tolerance share is below 750k ppm
Action:
  Flag for coordinator review even if system-level QFA-420 passed
```

This catches the case where the system-level fidelity claim doesn't
transfer to a specific strategy's actual trade distribution.

## ADR lock summary

ADR-0016 locks methodology with thirteen LD-611-N decisions. The
walkthrough corrected five items in the original draft:

1. Two-stage statistical gate (historical -> paper; combined -> live)
   instead of paper-period-only PSR
2. Predictive-interval observed-vs-expected metrics instead of
   fixed Sharpe-matching tolerance
3. Futures-native gross-notional-leverage exposure instead of
   cash-equity %
4. Trading-days observation period instead of calendar-days
5. Live-measurable slippage/fill-quality kill-switch instead of
   research-only ppm wording

Plus refinements: HAC observation-unit lock, strategy-level execution
sensitivity audit, per-regime trade-count rule conditional on
contribution share, hurdle rate calibrated against contemporaneous
T-bill, drawdown headroom calculated below kill-switch, trade count
floor calibrated against binomial half-width.

The result is a Phase 5 methodology that is conservative, consistent
with the literature (White, Bailey-Lopez de Prado, Lo, Newey-West,
Ledoit-Wolf), and operationally usable. It preserves the project's
anti-overfitting discipline from ADR-0010 through ADR-0015, keeps
regime-uniform sizing because Phase 4 justified it, and avoids the
two big hidden traps: trying to force short paper windows to carry
more statistical weight than they can, and expressing futures
exposure in cash-equity language that ignores discrete contract
economics.

## References

- ADR-0010 - Validation gate
- ADR-0011 - QFA-402 threshold posture
- ADR-0012 - QFA-402 probe policy lock at 15s/60s
- ADR-0013 - Regime substrate methodology
- ADR-0014 - QFA-212 archive-size adjustment
- ADR-0015 - QFA-420 cross-regime stratification
- ADR-0016 - QFA-611 alpha decision criteria
- White, H. (2000), "A Reality Check for Data Snooping",
  Econometrica
- Bailey, D. & Lopez de Prado, M. (2012), "The Sharpe Ratio
  Efficient Frontier", Journal of Risk
- Bailey, D. & Lopez de Prado, M. (2014), "The Deflated Sharpe
  Ratio", Journal of Portfolio Management
- Lo, A. (2002), "The Statistics of Sharpe Ratios", FAJ
- Newey, W. & West, K. (1987), "A Simple, Positive Semi-Definite,
  Heteroskedasticity and Autocorrelation Consistent Covariance
  Matrix", Econometrica
- Ledoit, O. & Wolf, M. (2008), "Robust Performance Hypothesis
  Testing With the Sharpe Ratio", Journal of Empirical Finance
- Politis, D. & Romano, J. (1994), "The Stationary Bootstrap",
  Journal of the American Statistical Association
- CME Group MNQ contract specifications
- FRED 3-month Treasury constant-maturity yield series (DGS3MO)
- Phase 3-4 PRs #139-#162 (carry-forward audit trail)
