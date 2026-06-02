# V2-PF-C-LATE-AM-PAPER-OBSERVATION-BAR-SIGMA-SOURCE-WINDOW-EXTEND-01 Memo

## 1. Context

PR #300 classified the PR #298 control as `BAR_SIGMA_SOURCE_BLOCKED_INSUFFICIENT_HISTORY`. This ticket extends the bounded quote/trade source window deterministically to test whether closed `1m` bars and `sigma_pts` readiness can be established.

## 2. Input provenance

PR #298 control source SHA: `0ab171e087826aaffb14cfbf6d3e5a51bd81173ace17efe85528790452010788`. PR #300 control bar/sigma SHA: `005f76c0352fa31e16ce716595f193f5f4607b7ec1b2ae986488197967b6e541`. New bounded input SHA: `4844a8c6dcb17bd875e0c43969eb03742df5ea961ba92c88c8c6445b388ffff2`.

## 3. Source selection

start from first PR #298 bounded source timestamp; merge eligible obs01 TRADE and mbp1 QUOTE records by source_ts_ns, source_path, source_line_number; continue until target closed 1m bars or scan cap; MBO excluded from bar/sigma readiness. Max lines per source: `250000`.

## 4. Bar construction result

Closed bars constructed: `30`. Open partial bars seen: `0`. Bar window: `1780265040000000000` to `1780266840000000000`.

## 5. Final closure proof

The bounded source now includes the boundary-crossing closure proof for the final claimed bar: `closure_trigger_source_event_id=trade-normalize-mnq-2026-06-01-globex-000000021358`, `closure_trigger_source_ts_ns=1780266840004665119`, `closure_trigger_source_line_number=21358`, `closure_trigger_in_bounded_source=true`. The closure record is marked `closure_only_not_used_for_bar_ohlc_or_sigma_range` and is not used for bar OHLC, high-low range, or sigma range construction. The invariant `bounded_source_end_ts_ns >= bar_window_end_ts_ns` is `true`.

## 6. Sigma readiness result

Formula: `sigma_pts = round4(max(TICK_SIZE, average(bars.map(bar => bar.high - bar.low)) / 2))`. Lookback available: `30`; required: `30`. Ready: `true`. Value if ready: `6.375`.

## 7. No-lookahead contract

A `1m` bar closes only when a source event timestamp is greater than or equal to the next minute boundary. The final open partial bar is excluded from sigma readiness. Every record carries `lookahead_detected=false`.

## 8. Signed-shock boundary

sigma_pts readiness does not imply signed-shock readiness; signed-shock still requires ATR14/session VWAP/recent-history checks in the follow-up ticket.

## 9. Determination

Classification: `BAR_SIGMA_WINDOW_READY_FOR_SIGNED_SHOCK_SOURCE`. Recommended next ticket: `V2-PF-C-LATE-AM-PAPER-OBSERVATION-SIGNED-SHOCK-SOURCE-EXTEND-01` — closed 1m bars and sigma_pts are ready; proceed to signed-shock source readiness without claiming signed-shock readiness here.

## 10. Verification

The script asserts A/B byte stability for bounded input JSONL, bounded output JSONL, report JSON, and report Markdown.

## 11. Authority caveat

Observation-day eligible: `false`. Observation-day increment: `0`. No `StrategyFeatureSnapshot`, paper runtime, `STRAT_EVAL`, `CANDIDATE`, `ORDER_INTENT`, broker/live, Phase 6, active roster, candidate roster, or observation-day authority is created.
