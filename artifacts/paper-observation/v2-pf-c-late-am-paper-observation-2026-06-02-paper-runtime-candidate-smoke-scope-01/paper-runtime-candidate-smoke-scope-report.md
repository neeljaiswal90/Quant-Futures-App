# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-PAPER-RUNTIME-CANDIDATE-SMOKE-SCOPE-01

## Determination

```text
PAPER_RUNTIME_CANDIDATE_SMOKE_SCOPE_READY
```

## Runtime path readiness

| check | status | source_path | evidence |
| --- |--- |--- |--- |
| `paper_runtime_path_status` | `READY_WITH_REQUIRED_ORDER_SUPPRESSION_GUARD` | `scripts/paper/run-v2-pf-c-late-am-paper-observation.ts` | `createV2PfCLateAmPaperObservationSession resolves single explicit registered-inactive strategy with mock adapter` |
| `snapshot_ingest_status` | `READY` | `apps/strategy_runtime/src/paper-trading/paper-trading-runner.ts` | `PaperTradingSession.processFeatureSnapshot publishes sourceQuoteEventForSnapshot then calls StrategyRuntimeRunner.processFeatureSnapshot` |
| `strategy_eval_path_status` | `READY` | `apps/strategy_runtime/src/orchestration/runner.ts` | `StrategyRuntimeRunner uses paper_observation_explicit_strategy_ids under runtime_mode=paper and evaluateStrategySafely` |
| `candidate_emission_expected` | `READY` | `artifacts\paper-observation\v2-pf-c-late-am-paper-observation-2026-06-02-candidate-strat-eval-smoke-01\candidate-strat-eval-smoke-report.json` | `PR #312 proved STRAT_EVAL=1 and CANDIDATE=1 for the source-backed 19:05Z snapshot` |
| `order_translation_boundary` | `REQUIRES_NEXT_TICKET_GUARD` | `apps/strategy_runtime/src/orchestration/runner.ts` | `The full runtime cycle continues to sizeCandidate, evaluateRiskGate, and createEntryOrderIntent for passing ranked candidates` |

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

## Next implementation authority contract

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

## Next implementation success criteria

| criterion | expected |
| --- |--- |
| `source_backed_snapshot_ingested` | `exactly_one` |
| `STRAT_EVAL_count` | `1` |
| `CANDIDATE_count` | `1` |
| `ORDER_INTENT_count` | `0` |
| `rank_sizing_risk_order_translation_side_effects` | `none_beyond_candidate_marker` |
| `observation_day_credit` | `false_eligible_zero_increment` |

## Required next implementation guardrails

| guardrail | requirement | value |
| --- |--- |--- |
| `runtime_entrypoint` | `use dedicated wrapper/config only` | `scripts/paper/run-v2-pf-c-late-am-paper-observation.ts` |
| `required_config_path` | `mock adapter and explicit single strategy` | `config/paper/v2-pf-c-late-am-paper-observation.yaml` |
| `market_data_or_snapshot_ingest` | `use PR #311 source-backed snapshot fixture; no live broker/capture dependency` | `feature-v2pf-20260602-1780427100000000000` |
| `candidate_only_runtime_stop` | `next impl must stop before order translation or add explicit candidate-only/suppress-order-intent guard` | `PRIMARY_INSERTION_IN_STRATEGY_RUNTIME_RUNNER_CANDIDATE_LOOP` |
| `order_intent` | `ORDER_INTENT_count must remain 0` | `false` |
| `observation_day_credit` | `observation_day_eligible=false; observation_day_increment=0` | `false` |

## PR anchors

| Anchor | Value |
|---|---|
| PR #311 merge SHA | `3e588bacec2dcc98e5b334314ae630d8b93cd707` |
| PR #311 bounded JSONL SHA | `ecf32b6116263b3778819d29c2f2392153a123aec1daba91520323df353bce22` |
| PR #312 merge SHA | `b5eb3ceda03e05bdee50e22831925c5e0b829926` |
| PR #312 bounded JSONL SHA | `cc798091961a1bfe062f654198d2b74eb8648e975a93ad730676bc84bc0f0c19` |
| feature_snapshot_id | `feature-v2pf-20260602-1780427100000000000` |
| timestamp_utc | `2026-06-02T19:05:00.000000000Z` |
| strategy_id | `regime_shock_reversion_short_v2_utc_16_18_exclusion` |

## Recommended next ticket

```text
V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-PAPER-RUNTIME-CANDIDATE-SMOKE-IMPL-01
```

Implement a bounded paper-runtime candidate smoke that allows STRAT_EVAL and CANDIDATE markers from the PR #311 source-backed snapshot while adding an explicit guard to stop before order translation, ORDER_INTENT publication, adapter calls, broker/live dispatch, fills, and observation-day accounting.
