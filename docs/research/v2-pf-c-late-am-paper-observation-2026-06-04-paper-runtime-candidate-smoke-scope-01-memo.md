# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-PAPER-RUNTIME-CANDIDATE-SMOKE-SCOPE-01 memo

## Summary

```text
PAPER_RUNTIME_CANDIDATE_SMOKE_SCOPE_READY
```

This scope diagnostic verifies that the PR #322/#323 2026-06-04 candidate-emitting source-backed snapshot has a viable dedicated paper-runtime entry path, while preserving the no-order boundary for the next implementation. The next implementation must allow STRAT_EVAL and CANDIDATE only, then stop before order translation.

## Required answers

| question | answer | evidence |
| --- |--- |--- |
| `Can the dedicated paper-observation runtime path ingest the PR #322 2026-06-04 source-backed snapshot?` | `yes_with_processFeatureSnapshot_ingest` | `PaperTradingSession.processFeatureSnapshot accepts StrategyFeatureSnapshot and publishes a source QUOTE event before runtime evaluation` |
| `Can it invoke the strategy-evaluation path and preserve the PR #323 candidate result?` | `yes_expected_with_explicit_strategy_id` | `The paper runner passes paper_observation_explicit_strategy_ids into StrategyRuntimeRunner, and PR #323 proved the same snapshot emits candidate through the strategy generator` |
| `Where does candidate persistence begin, if any?` | `CANDIDATE_event_publication_inside_StrategyRuntimeRunner.processFeatureSnapshot` | `Candidate event is published immediately after STRAT_EVAL when result.candidate exists` |
| `Where does order translation begin?` | `createEntryOrderIntent_after_rank_sizing_and_risk_pass` | `Current full runtime cycle proceeds into sizing/risk and calls createEntryOrderIntent for passing ranked candidates` |
| `What switches/guards keep ORDER_INTENT, adapter calls, broker/live, and observation-day credit suppressed?` | `next_impl_requires_candidate_only_or_stop_before_order_translation_guard_plus_mock_adapter_and_zero_credit_locks` | `No such bounded candidate-only runtime guard is executed in this scope ticket; it must be implemented before the next smoke runs` |
| `What must be implemented next?` | `V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-PAPER-RUNTIME-CANDIDATE-SMOKE-IMPL-01` | `Implement bounded paper-runtime candidate smoke with explicit candidate marker allowance and ORDER_INTENT/order adapter/broker suppression` |

## Suppression boundary

| boundary | allowed_this_ticket | next_impl_policy | source_path | source_symbol |
| --- |--- |--- |--- |--- |
| `candidate_persistence_begins` | `false` | `allow_bounded_CANDIDATE_marker_only` | `apps/strategy_runtime/src/orchestration/runner.ts` | `StrategyRuntimeRunner.processFeatureSnapshot publishes CANDIDATE event when result.candidate exists` |
| `order_translation_begins` | `false` | `must_stop_before_createEntryOrderIntent_or_force_explicit_candidate_only_mode` | `apps/strategy_runtime/src/orchestration/runner.ts` | `createEntryOrderIntent(...) after rank, sizing, and risk pass` |
| `order_adapter_begins` | `false` | `ORDER_INTENT subscription must not receive events in smoke` | `apps/strategy_runtime/src/paper-trading/paper-trading-runner.ts` | `PaperTradingSession subscribes ORDER_INTENT events to BrokerAdapterRuntimeIntegration.handleOrderIntent` |
| `broker_adapter` | `false` | `mock adapter only; no rithmic broker/live adapter` | `config/paper/v2-pf-c-late-am-paper-observation.yaml` | `adapter_kind: mock; live_account_allowlist: []` |
| `observation_day_credit` | `false` | `observation_day_eligible=false and observation_day_increment=0 until separate full-duration criteria` | `dispatch guardrail` | `scope-only diagnostic authority lock` |

## Guard insertion point

| recommendation | guard_insertion_repo_path | guard_insertion_symbol_or_function | stop_before_symbol_or_function | allowed_marker_before_stop | disallowed_marker_after_stop | rationale |
| --- |--- |--- |--- |--- |--- |--- |
| `PRIMARY_INSERTION_IN_STRATEGY_RUNTIME_RUNNER_CANDIDATE_LOOP` | `apps/strategy_runtime/src/orchestration/runner.ts` | `StrategyRuntimeRunner.processFeatureSnapshot(...) ranked candidate loop` | `createEntryOrderIntent(...)` | `CANDIDATE` | `ORDER_INTENT` | `The current full runtime cycle publishes CANDIDATE, then rank/sizing/risk, then createEntryOrderIntent when risk passes; a candidate-only smoke needs to stop before order translation.` |
| `ALTERNATIVE_CALLER_LEVEL_STOP_IN_DEDICATED_PAPER_OBSERVATION_WRAPPER` | `scripts/paper/run-v2-pf-c-late-am-paper-observation.ts` | `dedicated v2 paper-observation wrapper / next smoke harness` | `PaperTradingSession.processFeatureSnapshot(...) full-cycle order-translation continuation` | `CANDIDATE` | `ORDER_INTENT` | `Caller-level harness can be used if the next ticket adds a bounded candidate-only runtime method or instrumentation seam without broadening general runtime authority.` |

## Next implementation contract

| field | value | reason |
| --- |--- |--- |
| `next_impl_allowed_to_emit_STRAT_EVAL` | `true` | `candidate smoke must prove strategy evaluation in paper-runtime path` |
| `next_impl_allowed_to_emit_CANDIDATE` | `true` | `candidate smoke must prove bounded candidate marker emission` |
| `next_impl_must_emit_ORDER_INTENT` | `false` | `ORDER_INTENT is outside the candidate smoke authority boundary` |
| `next_impl_must_not_call_order_translation` | `true` | `must stop before createEntryOrderIntent(...)` |
| `next_impl_must_not_call_order_adapter` | `true` | `ORDER_INTENT subscription must not drive adapter handling` |
| `next_impl_must_not_call_broker_adapter` | `true` | `broker/live and adapter side effects remain unauthorized` |
| `next_impl_observation_day_eligible` | `false` | `bounded smoke is not a full observation day` |
| `next_impl_observation_day_increment` | `0` | `bounded smoke must not alter 45/60 day accounting` |

## Success criteria for next implementation

| criterion | expected |
| --- |--- |
| `source_backed_snapshot_ingested` | `exactly_one` |
| `STRAT_EVAL_count` | `1` |
| `CANDIDATE_count` | `1` |
| `ORDER_INTENT_count` | `0` |
| `rank_sizing_risk_order_translation_side_effects` | `none_beyond_candidate_marker` |
| `observation_day_credit` | `false_eligible_zero_increment` |

## Authority caveat

This ticket does not run full paper observation, does not emit ORDER_INTENT, does not invoke order translation, order adapter, broker adapter, qfa-410b, qfa-611, Phase 6, active/candidate roster mutation, global regime-label mutation, paper/live/broker authority, or observation-day credit.

## Recommended next ticket

```text
V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-PAPER-RUNTIME-CANDIDATE-SMOKE-IMPL-01
```

Implement a bounded 2026-06-04 paper-runtime candidate smoke that allows STRAT_EVAL and CANDIDATE markers from the PR #322 source-backed snapshot while adding an explicit guard to stop before order translation, ORDER_INTENT publication, adapter calls, broker/live dispatch, fills, and observation-day accounting.
