# V2-PF-C-LATE-AM-PAPER-OBSERVATION-BAR-SIGMA-SOURCE-EXTEND-01 — Bar/Sigma Source Report

## Determination

Classification: `BAR_SIGMA_SOURCE_BLOCKED_INSUFFICIENT_HISTORY`

Observation-day eligible: `false`

Observation-day increment: `0`

Input bounded source LF SHA-256: `0ab171e087826aaffb14cfbf6d3e5a51bd81173ace17efe85528790452010788`

Output bounded bar/sigma LF SHA-256: `005f76c0352fa31e16ce716595f193f5f4607b7ec1b2ae986488197967b6e541`

## Output record counts

| Record type | Count |
| --- | --- |
| BAR_SOURCE_DIAGNOSTIC | 1 |
| SIGMA_SOURCE_DIAGNOSTIC | 1 |
| SOURCE_GAP | 1 |

## Readiness

| Area | Status | Evidence |
| --- | --- | --- |
| Bar construction | partial_open_bar_only | 0 closed bars; 7 trades; 30 finite quote mids |
| Sigma | blocked_insufficient_history | 0/1 bars for sigma_pts formula |
| Signed-shock downstream | blocked_until_bar_sigma_ready | 0/15 bars for ATR14 basis |

## Formula and interval

Bar interval is pinned to `1m` from `apps/backtester/src/real-archive-execution/real-archive-execution-runner.ts:219,337-339`. `sigma_pts` source is `apps/backtester/src/real-archive-execution/real-archive-execution-runner.ts:1215,1280`: `sigma_pts = round4(max(TICK_SIZE, average(bars.map(bar => bar.high - bar.low)) / 2))`.

## Recommended next ticket

`V2-PF-C-LATE-AM-PAPER-OBSERVATION-BAR-SIGMA-SOURCE-WINDOW-EXTEND-01` — The PR #298 bounded source control is shorter than one 1m bar and cannot prove closed-bar or sigma_pts readiness; extend the bounded source window before signed-shock source work.

## Authority caveat

This report is source-data evidence only. It emits no feature snapshots, no paper runtime processing, no strategy markers, no observation-day credit, and no broker/live/Phase 6/roster authority.
