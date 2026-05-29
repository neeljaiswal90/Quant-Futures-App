# CYCLE4-R1-V3-EARLY-ADVERSE-MOVEMENT-DIAGNOSTIC-01

## 1. Context

This memo records a diagnostic-only analysis of whether `regime_shock_reversion_short_v3` max-adverse-R losses are predictable before or immediately after entry.

PR #270 classified the v3 fail-safe loss driver as `fail_safe:max_adverse_r_exceeded`. PR #271 showed that this class has short hold times, severe MAE, and no clean high-VIX exclusion. This ticket tests whether currently serialized evidence supports a practical separator.

`regime_shock_reversion_short_v3` remains registered inactive. No strategy, management, qfa, registry, roster, ADR, paper, broker, live, or Phase 6 authority changes are made here.

## 2. Source artifact provenance

Primary source artifact:

| Field | Value |
|---|---|
| Path | `artifacts/held-out-validation/cycle4-r1-v3-failsafe-forensics-02/regime_shock_reversion_short_v3-feb-mar-apr-2026.json` |
| SHA-256 | `30383348fbf6d3f014a1df09b05120e14f63fdedb832fb2ea053f9651a8a2329` |
| Strategy | `regime_shock_reversion_short_v3` |

Prior PR #271 sources:

| Source | LF-canonical SHA-256 | Note |
|---|---|---|
| `v3-max-adverse-r-diagnostic.json` | `23483e4d7fa5672dd3180cd7e7603255398335e10c018ca61da7a1be29ed378f` | Matches dispatch anchor; Windows checkout byte hash differs due CRLF representation |
| `v3-max-adverse-r-diagnostic.md` | `8109b20b04f6550a5cb129410ba05cf4a55b6d14633af0664e8085ba2b846777` | Matches dispatch anchor; Windows checkout byte hash differs due CRLF representation |

Generated outputs:

| Output | SHA-256 |
|---|---|
| `artifacts/research/cycle4-r1-v3-early-adverse-movement-diagnostic-01/v3-early-adverse-movement-diagnostic.json` | `6a4357c41e50b66f4b9cca95fe33f76d2d3999a7b05a53429d6d47a49fa0a047` |
| `artifacts/research/cycle4-r1-v3-early-adverse-movement-diagnostic-01/v3-early-adverse-movement-diagnostic.md` | `1cd98d326e0082bb0c10228a3e704b5a41c2fc927ec0b08ac523da7d3986ff0a` |

The extractor generated JSON and Markdown twice; both outputs were byte-identical.

## 3. Anchor reconciliation

| Anchor | Expected | Observed | Status |
|---|---:|---:|---|
| Total trades | 889 | 889 | pass |
| Max-adverse-R fail-safes | 245 | 245 | pass |
| Target exits | 259 | 259 | pass |
| Stop-loss exits | 363 | 363 | pass |
| Spread fail-safes | 17 | 17 | pass |
| Session-close exits | 5 | 5 | pass |
| Total net PnL cents | -102600 | -102600 | pass |

All trades remain single-contract, single-exit records, so `exits[].management_action_reason` is unambiguous for class assignment.

## 4. Class definitions

Primary negative class:

```text
exit_reason = fail_safe
exits[].management_action_reason = fail_safe:max_adverse_r_exceeded
```

Primary positive class:

```text
exit_reason = target
```

Secondary comparison classes:

| Class | Definition |
|---|---|
| Stop loss | `exit_reason = stop_loss` |
| Spread fail-safe | `exits[].management_action_reason = fail_safe:max_spread_ticks_exceeded` |
| Session close | `exit_reason = session_close` |

## 5. Pre-entry observable findings

Currently serialized pre-entry or near-entry fields are limited to `session_id`, `vix_prior_close_percentile`, `regime`, `spread_bucket`, `queue_ahead_bucket`, and `entry_price`.

The tested pre-entry candidates do not provide a clean separator:

| Candidate exclusion | Max adverse captured | Targets at risk | Net vs targets only | Read |
|---|---:|---:|---:|---|
| `vix_prior_close_percentile >= 0.85` | 26.94% | 35.52% | -141350 cents | Not viable standalone; removes proportionally more targets |
| `0.25 <= vix_prior_close_percentile < 0.50` | 41.22% | 36.29% | -9000 cents | Largest max-adverse bucket, but target risk remains too high |
| `spread_bucket == 3+ ticks` | 16.33% | 17.37% | -40100 cents | Too broad, likely target-negative |
| `queue_ahead_bucket == 1-5` | 50.2% | 57.92% | -162400 cents | Not viable standalone; target risk dominates |

This does not rule out a future entry-quality variant. It means the current serialized pre-entry fields are not enough to justify one.

## 6. Early-post-entry / outcome diagnostic findings

Early-post-entry and outcome fields separate the classes more clearly:

| Candidate | Actionability | Max adverse captured | Targets at risk | Net vs targets only | Read |
|---|---|---:|---:|---:|---|
| `hold_time_minutes < 2` | early-post-entry only | 71.02% | 51.74% | 34450 cents | Corroborates the R2 chop-flip timing hypothesis, but not pre-entry usable |
| `max_adverse_excursion_cents <= -2000` | outcome-only / diagnostic only | 62.86% | 0.77% | 454000 cents | Strong realized separator, but cannot be used directly as an entry filter |

The most meaningful signal remains early adverse movement itself. That supports another evidence step, not immediate strategy tuning.

## 7. Candidate separator table

| Feature | Usability class | Interpretation |
|---|---|---|
| High VIX exclusion | pre-entry usable | Fails winner-risk check; target exposure exceeds max-adverse exposure |
| Mid VIX bucket exclusion | pre-entry usable | Nearly break-even against targets only; too blunt for implementation |
| Wide spread bucket exclusion | pre-entry usable if entry-time spread | Does not isolate adverse trades cleanly |
| Queue bucket exclusion | pre-entry usable if entry-time queue | Removes more targets than max-adverse trades by share |
| Hold time under 2 minutes | early-post-entry only | Diagnostic support for chop-flip behavior; any use would be management-design work |
| MAE threshold | outcome-only / diagnostic only | Confirms loss mechanism; requires a pre-entry or early-path proxy |

## 8. Break-even tradeoff

Known improvement targets:

| Target | Required improvement |
|---|---:|
| Break-even PF around 1.0 | +102600 cents |
| PF pass threshold 1.35, if gross profit unchanged | +309593 cents |

Average class values:

| Metric | Value |
|---|---:|
| Average max-adverse loss | 2367.76 cents |
| Average target profit | 2864.86 cents |
| Max-adverse trades to avoid for break-even with no target loss | 44 |
| Max-adverse trades to avoid for PF pass with no target loss | 131 |

The current pre-entry candidates do not clear the target-loss tradeoff. For example, high-VIX exclusion would avoid some adverse losses but put more target profit at risk than it saves.

## 9. Evidence gaps

Current evidence is enough to say early adverse movement is the mechanism. It is not enough to identify a safe pre-entry filter.

Key gaps:

| Gap |
|---|
| Per-trade signed-shock value |
| Per-trade recent signed-shock values |
| Per-trade VIX value and VIX freshness |
| Per-trade primary percentile and VXN percentile |
| Exact adverse-R scalar at exit |
| First-minute adverse movement path |

The first-minute path gap is especially important. Current artifacts serialize entry, exit, MFE, and MAE, but not the time path that would distinguish immediate chop-flip from later adverse drift.

## 10. Recommended next ticket

Recommended next ticket:

```text
CYCLE4-R1-V3-EARLY-ADVERSE-EVIDENCE-SURFACE-EXTEND-01
```

Purpose:

Extend or instrument the evidence surface for pre-entry and first-minute adverse-movement attribution before any strategy variant or management tuning is proposed.

Minimum target fields should include:

| Field |
|---|
| signed shock at entry |
| recent signed-shock values at entry |
| VIX value and freshness at entry |
| primary percentile / VXN percentile at entry if available |
| exact adverse-R scalar at fail-safe exit |
| first-minute adverse/favorable path summary |

If that extension finds a pre-entry proxy with acceptable target-risk tradeoff, then a separate registered-inactive entry-quality variant ticket can be considered.

## 11. Verification

Worker verification:

| Check | Result |
|---|---|
| Source artifact SHA verified | pass |
| Prior PR #271 LF-canonical hashes verified | pass |
| Anchor counts verified | pass |
| JSON A/B byte equality | pass |
| Markdown A/B byte equality | pass |

Additional TypeScript and lint verification are reported in the worker Step 7 status.

## 12. Authority caveat

This PR does not activate any strategy, does not authorize paper observation, does not authorize broker/live dispatch, does not authorize Phase 6, and does not mutate `ACTIVE_STRATEGY_IDS`.

`regime_shock_reversion_short_v3` remains registered inactive and available only for explicit research replay.
