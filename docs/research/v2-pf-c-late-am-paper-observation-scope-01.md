# V2-PF-C-LATE-AM-PAPER-OBSERVATION-SCOPE-01

## 1. Context and evidence chain

This scope memo documents what a future paper-observation implementation would require for:

`regime_shock_reversion_short_v2_utc_16_18_exclusion`

This is scope-only. It does not enable paper trading, mutate rosters, wire broker/live execution, or create Phase 6 authority.

Evidence chain:

| PR | Result |
|---|---|
| #286 | Implemented the registered-inactive UTC 16-18 exclusion variant. Initial qfa-611 result was `RESEARCH_FURTHER` because the sensitivity audit failed on missing qfa-402c cells. |
| #288 | Extended qfa-402c fidelity coverage with real low-regime probes from `2026-04-16-rth`. Post-extension qfa-611 result became `ADVANCE_TO_PAPER`. |
| #289 | Governance memo recommended `APPROVE_PAPER_OBSERVATION_ONLY` as recommendation-only governance disposition. |

The paper-observation path is a new authority lane. It is not restoration of an existing active strategy because the system remains intentionally zero-active.

## 2. Strategy identity

| Field | Value |
|---|---|
| Strategy ID | `regime_shock_reversion_short_v2_utc_16_18_exclusion` |
| Strategy family | `regime_shock_reversion` / v2 UTC time-exclusion variant |
| Current roster state | `REGISTERED_INACTIVE` |
| `ACTIVE_STRATEGY_IDS` | `[]` |
| `CANDIDATE_STRATEGY_IDS` | `[]` |
| Actual paper authority | none |
| Actual broker/live authority | none |
| Actual Phase 6 authority | none |

The registered-inactive status should remain unchanged until a separate operator-approved implementation or authority ticket explicitly changes a paper-observation lane.

## 3. Governance basis from PR #289

PR #289 recommends:

`APPROVE_PAPER_OBSERVATION_ONLY`

That recommendation is not itself authority. It means the evidence package is strong enough to scope a paper-observation implementation/checklist. It does not grant paper observation, active roster membership, broker/live routing, or Phase 6 authority.

The next implementation ticket must independently decide whether and how to create a paper-observation lane.

## 4. qfa-611 post-extension evidence from PR #288

Post-extension qfa-611 evidence:

| Metric | Value |
|---|---:|
| Verdict | `ADVANCE_TO_PAPER` |
| Verdict reason | `all_stage1_thresholds_passed` |
| PF | 1.354742 |
| Trades | 739 |
| Win rate | 0.484438 |
| Annualized Sharpe | 3.9562743142 |
| DSR statistic | 3.4510773787 |
| PSR zero | 0.9997208233 |
| Max drawdown | 0.595% |
| Unknown-cell trades | 0 |
| Low-fidelity trades | 43 |
| Low-fidelity fraction | 5.81867388% |
| qfa-611 `phase_6_dispatch_authorized` field | `true` |

All stage-1 thresholds pass in the PR #288 post-extension qfa-611 selection. The `phase_6_dispatch_authorized: true` field is evidence, not operational authority.

## 5. Paper-observation objective

The objective of a future paper-observation implementation is to observe the registered-inactive strategy under paper-only conditions and compare observed behavior against held-out replay expectations.

Paper observation should answer:

- Does paper trade frequency remain directionally consistent with the held-out evidence?
- Does realized paper PnL and drawdown remain within an acceptable monitoring band?
- Do low-fidelity qfa-402c residual cells appear disproportionately in paper events?
- Does paper/live infrastructure preserve paper isolation without broker/live order routing?
- Are there any operational, latency, market-data, or journal issues that were not visible in held-out replay?

## 6. Paper-observation minimum and preferred duration

The threshold source is `scripts/strategy-selection/_lib/thresholds.py`.

| Threshold name | Value |
|---|---:|
| `paper_observation_trading_days_min` | 45 |
| `paper_observation_trading_days_preferred` | 60 |

Future implementation should scope at least 45 trading days of observation and prefer 60 trading days before any further promotion review.

## 7. Required future implementation surfaces

This ticket does not change these files. It only classifies likely future implementation surfaces.

| Surface | Classification | Scope note |
|---|---|---|
| `scripts/paper/run-paper-session.ts` | required | Current entrypoint starts a paper session from resolved config. Future implementation likely needs a safe explicit invocation path for this strategy or a documented command/profile that prevents accidental default-strategy use. |
| `config/paper/paper-session-defaults.yaml` | required | Current default strategy is `regime_shock_reversion_short_v2`; a future paper scope should avoid mutating default behavior unless explicitly authorized, and should likely use a dedicated paper config for the UTC 16-18 variant. |
| `apps/strategy_runtime/src/paper-trading/paper-trading-runner.ts` | unknown / requires operator decision | Runner already accepts `strategy_id`, `adapter_kind`, market-data source, duration, journals, and live-account allowlist. It may not need code changes if config-only paper scoping is sufficient, but any enforcement for strategy-specific paper isolation or monitoring hooks would touch this surface. |
| `apps/strategy_runtime/src/contracts/strategy-ids.ts` | not needed | Variant is already registered inactive. Do not mutate active, candidate, or registered-inactive rosters in the scope memo. A future paper-only roster, if desired, must be separately designed and authorized. |
| Paper monitoring/reporting scripts | optional | A future implementation may add a dedicated daily paper-observation report or checker if existing diagnostics are insufficient. |
| Broker/live adapters | not needed / forbidden | Paper observation must remain isolated from broker/live dispatch paths. Broker/live wiring is out of scope. |

`V2-PF-C-LATE-AM-PAPER-OBSERVATION-IMPLEMENT-01` may scope or implement paper-observation wiring only if separately authorized. This scope memo does not pre-approve that implementation.

## 8. Monitoring plan

A future paper-observation plan should include at least:

| Monitor | Purpose |
|---|---|
| Daily trade count | Detect strategy silence, over-trading, or divergence from held-out frequency. |
| Realized and unrealized PnL | Track paper performance against held-out expectations. |
| Drawdown | Stop or escalate if paper drawdown materially exceeds held-out behavior. |
| qfa-611 threshold drift watch | Compare paper-observed metrics against PF, Sharpe, DSR, PSR, drawdown, trade count, and sensitivity expectations. |
| Residual low-fidelity cell exposure watch | Track whether the 43-trade / 5.81867388% residual low-fidelity exposure becomes concentrated or behaviorally important in paper. |
| Paper/live parity caveat | Record differences between paper fill/market-data behavior and actual live/broker paths. |
| Paper/live isolation check | Ensure no broker/live order path is used by the paper lane. |
| Stop condition | Escalate or halt if paper behavior materially diverges from held-out evidence, if monitoring cannot be produced, or if any broker/live authority boundary is crossed. |

## 9. Residual low-fidelity risk

PR #288 resolved the missing qfa-402c coverage blocker. The residual low-fidelity cells are still monitoring risks:

| Cell | Probe count | Share ppm | Strategy trades | Strategy trade fraction |
|---|---:|---:|---:|---:|
| `low / 2-tick / 21+` | 75 | 560000 | 1 | 0.135318% |
| `low / 3+ ticks / 1-5` | 564 | 739361 | 20 | 2.706360% |
| `low / 3+ ticks / 6-20` | 383 | 592689 | 22 | 2.976996% |

The combined low-fidelity exposure is 43 trades / 5.81867388%, below the qfa-611 concentration threshold. That is acceptable for the qfa-611 sensitivity gate, but it is not proof that these cells are harmless. Future paper observation should monitor these cells explicitly.

## 10. Explicit no-authority caveat

This memo does not activate any strategy, does not enable paper trading, does not mutate `ACTIVE_STRATEGY_IDS`, does not mutate `CANDIDATE_STRATEGY_IDS`, does not remove the strategy from `REGISTERED_INACTIVE_STRATEGY_IDS`, does not authorize broker/live dispatch, does not create Phase 6 authority, and does not establish production sizing policy.

Future paper observation must remain isolated from broker/live adapters and must not route through live dispatch paths.

## 11. Recommended next ticket

Recommended next ticket:

`V2-PF-C-LATE-AM-PAPER-OBSERVATION-IMPLEMENT-01`

Purpose:

Scope or implement a paper-observation-only lane for `regime_shock_reversion_short_v2_utc_16_18_exclusion`, with explicit operator approval, no broker/live authority, no Phase 6 authority, and monitoring for residual low-fidelity qfa-402c exposure.

This recommendation does not pre-approve implementation. The implementation ticket must separately authorize any paper config, command, runner, monitoring, or roster-adjacent changes.
