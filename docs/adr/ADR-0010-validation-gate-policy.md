# ADR-0010: Validation gate policy

## Status

Accepted

## Context

QFA-310 adds the first deterministic validation-gate policy for Phase 2 strategy
replay. QFA-301 can invoke strategies in replay sanity mode, QFA-302 can fingerprint
their decision streams, and QFA-303 can describe whether replay/fingerprint capability
is ready, degraded, or blocked. The next layer needs to decide whether a strategy has
enough validation evidence to pass a deterministic gate without turning replay sanity
or overfit backtests into alpha claims.

QFA-310 is a policy engine. It does not run strategies, tune thresholds, generate
reports, or render charts. QFA-311 consumes its result object for reporting.

## Decision

The validation gate has four top-level statuses:

```text
pass
fail
blocked
insufficient_evidence
```

Status precedence is fixed:

```text
blocked -> insufficient_evidence -> fail -> pass
```

`degraded_replay` cannot pass. Only `ready_for_replay` is eligible under the default
policy. `degraded_replay` can still emit diagnostics and warnings, but its validation
result is blocked.

Final validation status is based on test windows only. Train windows are diagnostics
only. Validation windows are selection/tuning evidence only. Train and validation
windows are excluded from active threshold calculations.

Test windows use half-open session-index ranges and must be non-overlapping under
the default policy. Overlap produces `insufficient_evidence`, not pass or fail.

Active metrics and thresholds in policy v1 are:

- `test_window_count >= 8`
- `closed_trade_count >= 80`
- `closed_trade_count_per_window >= 5`
- `zero_trade_window_count <= 1`
- `aggregate_net_pnl_cents >= 1n`
- `aggregate_profit_factor_ppm >= 1_100_000`
- `average_trade_pnl_cents >= 1n`
- `positive_window_share_ppm >= 550_000`
- `worst_window_drawdown_ppm <= 50_000`

Trial accounting is mandatory. The default effective trial method is:

```text
max(manual_declared_effective_trials, distinct_window_fingerprint_tuples)
```

High effective trial count emits a warning, but policy v1 does not fail solely because
trial count is high.

Sharpe, Sortino, Calmar, MAR, DSR, White Reality Check, Hansen SPA, and PBO/CSCV are
out of the active gate. Advanced-statistics hooks exist in the policy object but are
disabled by default.

## Consequences

QFA-310 creates deterministic `ValidationGateResultSet` objects for QFA-311 to render.
It intentionally avoids report generation and final alpha decision language.

The policy is conservative: replay capability, fingerprints, non-overlapping test
windows, trade counts, trial accounting, and active thresholds must all line up before
the result can pass. Missing contracts or degraded replay block the result; inadequate
sample/window/trial evidence is insufficient evidence; threshold misses fail only after
eligibility and evidence sufficiency are satisfied.
