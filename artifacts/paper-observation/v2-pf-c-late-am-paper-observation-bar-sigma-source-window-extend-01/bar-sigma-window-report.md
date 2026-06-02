# V2-PF-C-LATE-AM-PAPER-OBSERVATION-BAR-SIGMA-SOURCE-WINDOW-EXTEND-01 — Bar/Sigma Window Report

## Determination

| Metric | Value |
| --- | --- |
| classification | BAR_SIGMA_WINDOW_READY_FOR_SIGNED_SHOCK_SOURCE |
| bounded_input_source_lf_sha256 | 4844a8c6dcb17bd875e0c43969eb03742df5ea961ba92c88c8c6445b388ffff2 |
| bounded_bar_sigma_output_lf_sha256 | 04f09204e4a05ffeb3e9067a1d5237ce018710e97de9bb909e6f599be48a796a |
| closed_bars_constructed | 30 |
| bounded_source_end_ts_ns_gte_bar_window_end_ts_ns | true |
| closure_trigger_in_bounded_source | true |
| sigma_pts_ready | true |
| sigma_pts_value_if_ready | 6.375 |
| recommended_next_ticket | V2-PF-C-LATE-AM-PAPER-OBSERVATION-SIGNED-SHOCK-SOURCE-EXTEND-01 |

## Source selection

start from first PR #298 bounded source timestamp; merge eligible obs01 TRADE and mbp1 QUOTE records by source_ts_ns, source_path, source_line_number; continue until target closed 1m bars or scan cap; MBO excluded from bar/sigma readiness

Full-file hashes are point-in-time only. The bounded input source hash is authoritative.

## Bar and sigma

Bar interval remains `1m`. Formula: `sigma_pts = round4(max(TICK_SIZE, average(bars.map(bar => bar.high - bar.low)) / 2))` from `apps/backtester/src/real-archive-execution/real-archive-execution-runner.ts:1215,1280`.

Final closure proof: `bounded_source_end_ts_ns=1780266840004665119`, `bar_window_end_ts_ns=1780266840000000000`, `closure_trigger_source_ts_ns=1780266840004665119`, `closure_trigger_in_bounded_source=true`. The closure trigger is marked `closure_only_not_used_for_bar_ohlc_or_sigma_range`.

## Signed-shock boundary

sigma_pts readiness does not imply signed-shock readiness; signed-shock still requires ATR14/session VWAP/recent-history checks in the follow-up ticket

## Authority caveat

Observation-day eligible: `false`. Observation-day increment: `0`. No feature snapshots, paper runtime, strategy markers, broker/live, Phase 6, active roster, or candidate roster authority.
