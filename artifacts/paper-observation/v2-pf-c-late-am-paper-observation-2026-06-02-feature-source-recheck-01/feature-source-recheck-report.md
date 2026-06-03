# V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FEATURE-SOURCE-RECHECK-01

Determination: `FEATURE_SOURCE_RECHECK_BLOCKED_SESSION_STATE`

Blocker subclassification: `SESSION_STATE_SOURCE_BLOCKED_MISSING_EXPLICIT_HALT_ROLL_CALENDAR`

Recommended next ticket: `V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-HALT-ROLL-CALENDAR-SOURCE-EXTEND-01`

Recommended next ticket reason: session.is_rth is already source-ready; the remaining session-state blocker is explicit halt/roll calendar provenance or a deliberate documented conservative default for session.is_halt=false and session.is_roll_block=false.

## Source stack summary

- Target strategy: `regime_shock_reversion_short_v2_utc_16_18_exclusion`
- Target session: `2026-06-02-rth`
- Session VWAP: `30645.9255`
- ATR14: `9.9665`
- Signed-shock source value: `-1.7986`
- Scoped regime label: `low`
- Global regime labels mutated: `false`

## Behavior-bearing field readiness

| Field | Status | Source | Date basis | Notes |
| --- | --- | --- | --- | --- |
| created_ts_ns | READY | artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-source-readiness-01/bounded-2026-06-02-source-readiness.jsonl | 2026-06-02 RTH source window | Feature builder can derive created_ts_ns from bounded source timestamps; no StrategyFeatureSnapshot is emitted here. |
| quote.mid_px | READY | artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-source-readiness-01/source-readiness-report.json | 2026-06-02 RTH MBP1 normalized quote source | Latest finite mid_px is 30628 at 2026-06-02T17:59:59.835478000Z. |
| session.is_rth | READY | artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-source-readiness-01/source-readiness-report.json | target_session_id 2026-06-02-rth | RTH membership is source-ready for the selected 2026-06-02 RTH candidate window. |
| session.is_halt | BLOCKED | PR #303/#304/#305 merged source surfaces; apps/strategy_runtime/src/contracts/market.ts; apps/strategy_runtime/src/session/mnq-session-calendar.ts | target_session_id 2026-06-02-rth | No current repo default/fallback was found for SessionState.is_halt in paper/local replay. Timestamp-window inference is not enough; future builder needs an explicit halt calendar/source or deliberate documented conservative default. |
| session.is_roll_block | BLOCKED | PR #303/#304/#305 merged source surfaces; apps/strategy_runtime/src/contracts/market.ts; apps/strategy_runtime/src/session/mnq-session-calendar.ts | target_session_id 2026-06-02-rth | No current repo default/fallback was found for SessionState.is_roll_block in paper/local replay. The v2 generator treats roll-block as behavior-bearing, so source readiness remains blocked until this flag is causally sourced or deliberately defaulted. |
| indicators.sigma_pts | READY | artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-source-readiness-01/source-readiness-report.json; apps/backtester/src/real-archive-execution/real-archive-execution-runner.ts | 2026-06-02 RTH closed-bar source window | Source bars are ready for sigma construction; closed_1m_bars=119. This recheck does not materialize a StrategyFeatureSnapshot value. |
| context.regime_label | READY | artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-regime-label-source-acquire-01/scoped-regime-label-source.jsonl | target_session_id 2026-06-02-rth; primary prior close 2026-06-01 | Scoped source label is low; global regime labels remain unmutated and target is not present in global artifact. |
| context.signed_shock_vwap.value | READY | artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-source-readiness-01/source-readiness-report.json | 2026-06-02 RTH source window | source-readiness value=-1.7986; session_vwap=30645.9255; ATR14=9.9665. |
| config lineage for regime_shock_reversion_short_v2_utc_16_18_exclusion | READY | apps/strategy_runtime/src/strategies/regime_shock_reversion_short_v2_utc_16_18_exclusion.ts; config/strategies/regime_shock_reversion_short_v2_utc_16_18_exclusion.yaml; apps/strategy_runtime/src/strategies/registry.ts | repo config at origin/main after PR #305 | Config lineage is ready from variant YAML, registry generator mapping, and variant-owned getStrategyParameters path. |

## Diagnostic-only / non-blocking fields

| Field | Status | Notes |
| --- | --- | --- |
| VIX value / freshness / percentile | DIAGNOSTIC_ONLY | VIXCLS=16.05; PR #304 primary_value=16.05, primary_percentile=0.05. |
| VXN percentile | DIAGNOSTIC_ONLY | VXN value=23.18; vxn_percentile is null and non-blocking for v2 behavior. |
| primary percentile | DIAGNOSTIC_ONLY | primary_percentile=0.05; diagnostic-only for this source recheck. |
| spread bucket | NOT_REQUIRED | Spread bucket can remain absent from the causal StrategyFeatureSnapshot builder for this v2 behavior path. |
| queue bucket | NOT_REQUIRED | Queue bucket can remain absent from the causal StrategyFeatureSnapshot builder for this v2 behavior path. |
| signed-shock recent values | NOT_REQUIRED | Recent values are useful diagnostic context but not a behavior-bearing blocker for v2 candidate generation. |

## Session field source-code provenance

| Field | Repo symbol or path | Current default behavior | External source required |
| --- | --- | --- | --- |
| session.is_halt / session.is_roll_block | apps/strategy_runtime/src/contracts/market.ts; apps/strategy_runtime/src/session/mnq-session-calendar.ts; apps/strategy_runtime/src/strategies/regime_shock_reversion_short_v2.ts | no default found | true |
| session.is_halt / session.is_roll_block | apps/strategy_runtime/src/session/mnq-session-calendar.ts#getMnqSessionPhase | calendar derives phase and is_maintenance_halt, but not SessionState.is_halt or SessionState.is_roll_block defaults | true |

## PR source anchors

- PR #303 merge commit: `9c5a874374125574b2a93f55d84b9c9ad3d69466`
- PR #303 bounded source SHA: `3e79062c0c8cb490e05534ed67d8ccbf9e0f64529c01179bf61e3c6c785e14bf`
- PR #304 merge commit: `5c9c0a234959693e4e6c9418467d10aed63811d4`
- PR #304 bounded source-input SHA: `f9e2ac81a5577b24a7b72fe884f88ec7323c12d2d9d7a74a358fb1291ac8fac8`
- PR #305 merge commit: `7b13b559148fd33bd71d33910483d65e37de578f`
- PR #305 scoped label source SHA: `152e7fbfdfca52494edbb11a7364cfbbaf33e9d03390bca1f17ee739e38d9662`

## Guardrails

- No StrategyFeatureSnapshot materialized.
- No STRAT_EVAL, CANDIDATE, or ORDER_INTENT markers emitted.
- No qfa-410b or qfa-611 run.
- No global regime-label mutation.
- observation_day_eligible=false and observation_day_increment=0 remain locked.
- No paper/live/broker/Phase 6/roster authority created.
