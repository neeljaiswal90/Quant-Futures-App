# V2-PF-C-LATE-AM-PAPER-OBSERVATION-IMPLEMENT-01

## 1. Context and PR evidence chain

This implementation creates an explicit paper-observation path for:

`regime_shock_reversion_short_v2_utc_16_18_exclusion`

Evidence chain:

| PR | Evidence |
|---|---|
| #286 | Implemented the registered-inactive UTC 16-18 exclusion variant. |
| #288 | Extended qfa-402c fidelity coverage with real low-regime probes and produced post-extension qfa-611 `ADVANCE_TO_PAPER` evidence. |
| #289 | Recommended `APPROVE_PAPER_OBSERVATION_ONLY` as governance disposition, without creating authority. |
| #290 | Scoped a paper-observation implementation path and preserved no-authority guardrails. |

This ticket implements an explicit paper-observation entrypoint/config only. It does not activate the strategy, does not mutate rosters, does not wire broker/live execution, and does not create Phase 6 authority.

## 2. Implementation summary

Added:

| Surface | Purpose |
|---|---|
| `scripts/paper/run-v2-pf-c-late-am-paper-observation.ts` | Dedicated manual entrypoint for exactly one paper-observation strategy. |
| `config/paper/v2-pf-c-late-am-paper-observation.yaml` | Dedicated paper config for the registered-inactive UTC 16-18 exclusion variant. |
| `apps/strategy_runtime/tests/unit/paper-trading-v2-pf-c-late-am-observation.test.ts` | Focused fail-closed coverage for explicit strategy resolution, no active fallback, multi-strategy rejection, and broker/live adapter rejection. |

Default paper-session behavior is intentionally unchanged. `config/paper/paper-session-defaults.yaml` remains the default config for `scripts/paper/run-paper-session.ts`.

The paper runtime now supports a bounded `explicit_strategy_ids` override. Generic paper-session behavior remains active-roster based, but this dedicated wrapper injects exactly one explicit strategy ID so the registered-inactive variant is evaluated without mutating `ACTIVE_STRATEGY_IDS`.

## 3. Exact paper entrypoint/config

Entrypoint:

```powershell
npx tsx scripts/paper/run-v2-pf-c-late-am-paper-observation.ts
```

Config:

```text
config/paper/v2-pf-c-late-am-paper-observation.yaml
```

The wrapper forces its dedicated config path and rejects attempts to use active-roster or default-config fallback. It also rejects multi-strategy ambiguity via `strategy_ids` or `strategies` keys.

The wrapper sanitizes caller environment overrides for paper-session resolution. It does not pass through `QFA_PAPER_MARKET_DATA_SOURCE`, `QFA_JOURNAL_DIR`, `QFA_BROKER_ADAPTER_KIND`, local observation paths, metrics overrides, or duration overrides. The dedicated config is authoritative for this entrypoint.

## 4. Strategy ID and roster status

| Item | State |
|---|---|
| Strategy ID | `regime_shock_reversion_short_v2_utc_16_18_exclusion` |
| Roster | `REGISTERED_INACTIVE` |
| `ACTIVE_STRATEGY_IDS` | `[]` |
| `CANDIDATE_STRATEGY_IDS` | `[]` |
| Generator-backed | yes, via explicit strategy generator lookup |
| Paper authority created | no |
| Broker/live authority created | no |
| Phase 6 authority created | no |

The wrapper checks that active and candidate rosters remain empty and that the target strategy remains registered inactive and generator-backed.

## 5. Strategy ID resolution behavior

Fail-closed behavior:

| Condition | Behavior |
|---|---|
| Missing `session.strategy_id` | rejects; default strategy fallback is not allowed. |
| Wrong `session.strategy_id` | rejects. |
| `strategy_ids` or `strategies` key present | rejects as multi-strategy ambiguity. |
| `QFA_PAPER_SESSION_CONFIG` points elsewhere | ignored by the dedicated wrapper; dedicated config path is used. |
| Environment overrides for source, journal, adapter, metrics, or duration | ignored; dedicated config is authoritative. |
| `adapter_kind: rithmic` | rejects; broker/live adapters are not allowed. |

Registered-inactive status does not block this explicit paper-observation path because the strategy is intentionally resolved through the explicit generator path, not through active execution listing.

## 6. Test coverage

Focused tests cover:

| Test area | Coverage |
|---|---|
| Explicit target resolution | Dedicated config resolves exactly `regime_shock_reversion_short_v2_utc_16_18_exclusion`. |
| Default behavior preservation | Generic paper-session config still resolves default v2. |
| No active fallback | Dedicated wrapper ignores caller `QFA_PAPER_SESSION_CONFIG` and does not use active-roster fallback. |
| Runtime evaluation set | Starting the paper session and processing a snapshot emits exactly one `STRAT_EVAL` for the target strategy. |
| Registered-inactive explicit paper observation | Session can be constructed for the registered-inactive target through the explicit wrapper. |
| Missing strategy | Missing `session.strategy_id` rejects. |
| Wrong strategy | Non-target strategy rejects. |
| Multiple strategies | `strategy_ids` ambiguity rejects. |
| Broker/live adapter | `adapter_kind: rithmic` rejects before session creation. |

## 7. 45/60 day observation rule

The dedicated config records:

| Rule | Value |
|---|---:|
| Minimum observation target | 45 trading days |
| Preferred observation target | 60 trading days |

The current paper runner uses runtime duration in milliseconds for session process lifetime. It does not implement trading-day scheduling semantics. Therefore the 45/60 day target is preserved as observation-policy metadata and memo requirement, not as newly invented runtime scheduling behavior.

## 8. Low-fidelity monitoring requirement

Residual low-fidelity exposure from PR #288 remains a monitoring item:

| Metric | Value |
|---|---:|
| Low-fidelity trades | 43 |
| Low-fidelity fraction | 5.81867388% |

Paper observation should track whether these residual qfa-402c cells become concentrated or behaviorally important in paper events. This implementation records the requirement but does not add a paper monitoring report.

## 9. Paper-only execution path

The dedicated config sets:

```text
adapter_kind: mock
```

The wrapper rejects any resolved config whose adapter is not `mock`. Therefore this entrypoint does not create, preview, submit, or route broker/live orders. It uses the paper runner's mock order-plant path only.

## 10. Authority caveat

This PR does not activate any strategy, does not mutate `ACTIVE_STRATEGY_IDS`, does not mutate `CANDIDATE_STRATEGY_IDS`, does not remove the strategy from `REGISTERED_INACTIVE_STRATEGY_IDS`, does not authorize broker/live dispatch, does not create Phase 6 authority, and does not establish production sizing policy.

The qfa-611 `ADVANCE_TO_PAPER` evidence and PR #289 governance recommendation support this explicit paper-observation implementation path, but operational authority still requires separate operator action before any observation run is treated as authorized.

## 11. Recommended next ticket

Recommended next ticket:

`V2-PF-C-LATE-AM-PAPER-OBSERVATION-RUN-01`

Purpose:

Run the explicit paper-observation entrypoint under operator-approved paper-only conditions, collect paper journals/diagnostics, and monitor trade frequency, PnL, drawdown, paper/live isolation, and residual low-fidelity qfa-402c exposure.

## Review guardrail update

The implementation keeps the registered-inactive execution path bounded to paper observation. The orchestration runner accepts a paper-observation strategy override only when the caller also declares `runtime_mode: "paper"`; default/non-paper runner construction fails closed if it attempts to use the override. This prevents the wrapper fix from becoming a generic registered-inactive runtime escape hatch.

Paper session config also fails closed if `explicit_strategy_ids` diverges from `strategy_id`. The dedicated wrapper resolves both to exactly `regime_shock_reversion_short_v2_utc_16_18_exclusion`, so the audit label, paper config, and runtime evaluation set remain aligned.
