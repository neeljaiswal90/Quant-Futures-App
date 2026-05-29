# CYCLE4-R1-V3-FAILSAFE-FORENSICS-01 Memo

## 1. Context

This memo analyzes the remaining fail-safe loss profile in `regime_shock_reversion_short_v3` after the v2/v3 pairwise replay. v3 improved materially versus v2 but still rejected under qfa-611, so this ticket performs forensics before tuning.

## 2. Source artifact provenance

| Item | Value |
|---|---|
| Source artifact | `D:\Quant-futures-app-cycle4-r1-v3-pairwise-replay-01\artifacts\held-out-validation\cycle4-r1-v3-pairwise-replay-01\regime_shock_reversion_short_v3-feb-mar-apr-2026.json` |
| Source SHA-256 | `40c3941a3351fd915da9c40835268eaa076caac4e23f92fc985b47f69d6f83c2` |
| Provenance | Reviewed local `CYCLE4-R1-V3-PAIRWISE-REPLAY-01` worktree artifact because PR #267 is not present in this base substrate |
| Strategy | `regime_shock_reversion_short_v3` |
| Trade count assertion | `889` |

## 3. Field inventory

| Class | Fields |
|---|---|
| Available | `strategy_id`, `entry_timestamp`, `exit_timestamp`, `gross_pnl`, `net_pnl`, `exit_reason`, `management_action_type`, `target_label`, `regime_label`, `mfe`, `mae` |
| Derivable | `entry_session`, `hold_time`, `vix_value`, `vix_prior_close_percentile`, `primary_regime_percentile`, `vxn_percentile`, `window_id` |
| Unavailable | `trade_id_or_execution_id`, `entry_price`, `exit_price`, `vix_freshness`, `signed_shock_value`, `recent_signed_shock_values` |

## 4. v3 aggregate recap

| Metric | Value |
|---|---:|
| Trades | 889 |
| Net PnL | -$1,026.00 |
| Gross profit | $7,984.00 |
| Gross loss | -$9,010.00 |
| Profit factor | 0.886127 |
| Max drawdown | 254750 cents |

## 5. Fail-safe loss anatomy

Fail-safe exits account for `262` trades and `-$5,324.50` net PnL, averaging `-$20.32` per trade. They are the largest remaining loss bucket in v3.

The source artifact exit-reason integrity check passed: serialized exit reasons are limited to `stop_loss`, `target`, `fail_safe`, and `session_close`; no unexpected exit reasons were found.

## 6. Fail-safe vs target comparison

| Exit reason | Count | Net PnL | Avg | Median | P10 | P90 | Median hold sec |
|---|---:|---:|---:|---:|---:|---:|---:|
| `fail_safe` | 262 | -$5,324.50 | -$20.32 | -$18.25 | -$37.95 | -$9.55 | 60.2 |
| `target` | 259 | $7,420.00 | $28.65 | $23.00 | $18.00 | $47.20 | 120.0 |
| `stop_loss` | 363 | -$3,131.50 | -$8.63 | -$10.00 | -$18.50 | $0.50 | 119.7 |

See the data-oriented artifact Markdown for full distributions: `artifacts/research/cycle4-r1-v3-failsafe-forensics-01/v3-failsafe-trade-forensics.md`.

## 7. Window/session concentration

Fail-safe losses are not evenly distributed; the artifact Markdown contains full window, session, regime, spread, and queue tables. This memo intentionally avoids duplicating those longer data tables.

## 8. Hold-time findings

Fail-safe median hold time is `60.2` seconds versus target median hold time `120.0` seconds and stop-loss median hold time `119.7` seconds. This supports follow-up investigation of early-trade state, but is not sufficient by itself to justify tuning.

## 9. VIX/signed-shock/regime findings

Session-level VIX prior-close percentile and VXN percentile can be derived from entry timestamp plus regime labels. The artifact does not serialize exact per-trade `vix_fresh`, signed-shock value, or recent signed-shock values, so signed-shock/VIX interaction analysis is an evidence-surface gap rather than a tuning basis.

## 10. Evidence gaps

The main missing fields are stable trade/execution ID, entry/exit prices, VIX freshness, exact serialized VIX prior-close context, signed-shock value, and recent signed-shock values. The correct next move is evidence capture before proposing a registered-inactive filter.

## 11. Quantified improvement target

Break-even requires `$1,026.00` of net improvement, equivalent to `11.39%` of current gross loss or approximately `50.5` average fail-safe losses avoided if no target winners are lost.

PF approximately 1.0 is break-even, not sufficient for ADR-0016 pass. Reaching break-even would show avoidable-loss feasibility; it would not by itself flip v3 to a passing verdict.

Actual `pf_pass` feasibility: 1.35, requiring approximately $3,095.93 of gross-loss improvement if gross profit is unchanged. Future work must distinguish avoidable-loss feasibility, break-even feasibility, and actual ADR-0016 passing-verdict feasibility.

## 12. Recommended next ticket

Recommended next ticket: `CYCLE4-R1-V3-EVIDENCE-SURFACE-EXTEND-01`.

Scope recommendation: add code/test-only held-out artifact evidence fields for v3 trade forensics, including stable trade/execution ID, entry/exit prices or ticks if available, VIX value/freshness/prior-close percentile, signed-shock value, recent signed-shock values, and entry gate reason context. Keep v3 registered-inactive and do not tune parameters in that ticket.

## 13. Authority and governance caveat

This PR does not activate v3, does not authorize paper observation, does not authorize broker/live dispatch, does not authorize Phase 6, and does not mutate `ACTIVE_STRATEGY_IDS`. The work is forensics before tuning only.
