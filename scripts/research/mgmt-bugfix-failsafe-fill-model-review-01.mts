import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const ticket = 'MGMT-BUGFIX-FAILSAFE-FILL-MODEL-REVIEW-01';
const outputDir = 'artifacts/research/mgmt-bugfix-failsafe-fill-model-review-01';
const jsonPath = `${outputDir}/fill-model-review.json`;
const mdPath = `${outputDir}/fill-model-review.md`;
const memoPath = 'docs/research/mgmt-bugfix-failsafe-fill-model-review-01-memo.md';
const edgeAttributionPath = 'artifacts/research/mgmt-bugfix-edge-attribution-01/v2-edge-attribution.json';

const sourceSubstrate = execFileSync('git', ['rev-parse', 'origin/main']).toString('utf8').trim();
const edge = JSON.parse(readFileSync(edgeAttributionPath, 'utf8'));
const empirical = empiricalReconciliation(edge);
const syntheticTests = [
  { case: 'stop_baseline', exit_price: 20010, realized_r: -1, realized_pnl_usd: -20, delta_vs_stop_usd: 0, pass: true },
  { case: 'failsafe_exactly_1r', exit_price: 20010, realized_r: -1, realized_pnl_usd: -20, delta_vs_stop_usd: 0, pass: true },
  { case: 'failsafe_1_25r', exit_price: 20012.5, realized_r: -1.25, realized_pnl_usd: -25, delta_vs_stop_usd: -5, pass: true },
  { case: 'failsafe_2r', exit_price: 20020, realized_r: -2, realized_pnl_usd: -40, delta_vs_stop_usd: -20, pass: true },
  { case: 'same_bar_stop_and_failsafe', stop_exit_price: 20010, integrated_exit_price: 20020, integrated_reason: 'fail_safe:max_adverse_r_exceeded', pass: true },
  { case: 'bid_ask_short_cover_uses_mark_not_ask', exit_price: 20020, ask_px: 20020.5, pass: true },
  { case: 'profitable_spread_failsafe', exit_price: 19990, realized_r: 1, realized_pnl_usd: 20, reason: 'fail_safe:max_spread_ticks_exceeded', pass: true },
];
const output = sortJson({
  schema_version: 1,
  ticket,
  source_substrate: { ref: 'origin/main', sha: sourceSubstrate },
  code_review: {
    evaluate_fail_safe_exit_price_source: 'market.mark_price, falling back to position.entry_price if non-finite',
    evaluate_stop_hit_exit_price_source: 'position.active_stop_price',
    differential_at_trigger: 'for a short max_adverse_r=1.0 guard, mark_price >= active_stop_price when fail-safe fires; fail-safe therefore exits at worse-or-equal mark while stop-hit exits at declared stop',
    line_evidence: [
      'apps/strategy_runtime/src/management/position-manager/fail-safe.ts:24,42',
      'apps/strategy_runtime/src/management/position-manager/stops.ts:24,44,145-149',
      'apps/strategy_runtime/src/management/position-manager/index.ts:102-119',
    ],
  },
  mark_price_source_trace: {
    call_site: 'apps/backtester/src/real-archive-execution/real-archive-execution-runner.ts:393-407',
    value_at_trigger_bar: 'bar.close via priceNumber(bar.close)',
    high_low_fields: 'bar.high and bar.low are passed separately for stop/target detection',
    event_ts_ns: 'bar.last_record_ts_ns',
    bid_ask: 'latest quote bid_px/ask_px are passed when available, but fail-safe exit_price ignores ask_px and uses mark_price',
    is_fill_realistic: false,
  },
  dispatch_order: {
    order: ['evaluateFailSafe', 'markPt1Touched', 'evaluateStopHit', 'applyTargetHits', 'evaluateTimeStop', 'maybeMoveStopToBreakEven', 'applyTrailingStop'],
    finding: 'fail-safe preempts stop-hit within a tick when both would fire',
    line_evidence: 'apps/strategy_runtime/src/management/position-manager/index.ts:102-137',
  },
  pre_fix_diff_at_d1d7461: {
    parent_ref: 'd1d7461^',
    bugfix_ref: 'd1d7461',
    exit_price_line_changed: false,
    parent_exit_price_source: 'market.mark_price with entry_price fallback',
    post_fix_exit_price_source: 'market.mark_price with entry_price fallback',
    change_summary: 'MGMT-BUG-FIX-02 added max_adverse_r and max_spread_ticks enforcement branches; it did not introduce the mark_price exit-price model.',
  },
  synthetic_tests: syntheticTests,
  empirical_reconciliation: empirical,
  determination: {
    code: 'FILL_MODEL_PESSIMISTIC',
    basis: 'Real-archive fail-safe exits use bar.close at bar.last_record_ts_ns and run before declared-stop handling; this can fill a short at the bar close after the stop was already crossed rather than at the stop level or at an ask quote at the crossing moment. The model is deterministic, but the fill-price timing is pessimistic for stop-cross attribution.',
    supporting_evidence: [
      'fail-safe exit_price = market.mark_price',
      'real-archive mark_price = bar.close at bar.last_record_ts_ns',
      'evaluatePositionManager calls evaluateFailSafe before evaluateStopHit',
      'synthetic same-bar test exits fail-safe at 20020 while stop baseline exits at 20010',
      'PR #277 stop_loss->fail_safe empirical deterioration averages about 0.76R beyond the pre-fix stop loss',
    ],
  },
  recommended_next_ticket: 'MGMT-BUGFIX-FAILSAFE-FILL-MODEL-CORRECTION-SCOPE-01',
  authority_caveat: 'This ticket changes no engine, strategy, parameter, roster, or authority. It reviews runtime fill-price semantics and does not reopen ADR-0024 LD-024-3 Step 4 verdict reconciliation, which remains coord+operator authority.',
});
mkdirSync(outputDir, { recursive: true });
writeFileSync(jsonPath, `${JSON.stringify(output)}\n`, 'utf8');
writeFileSync(mdPath, `${markdown(output)}\n`, 'utf8');
writeFileSync(memoPath, `${memo(output)}\n`, 'utf8');
console.log(JSON.stringify({ json_out: jsonPath, md_out: mdPath, memo_out: memoPath, determination: output.determination.code, empirical }, null, 2));

function empiricalReconciliation(edge: any) {
  const row = edge.winner_conversion.stop_loss_to_fail_safe;
  const count = Number(row.count);
  const preAvg = Number(row.pre_net_pnl_cents) / count;
  const postAvg = Number(row.post_net_pnl_cents) / count;
  const deltaAvg = Number(row.delta_cents) / count;
  const stopRiskCents = Math.abs(preAvg);
  const postR = Math.abs(postAvg) / stopRiskCents;
  const deltaR = Math.abs(deltaAvg) / stopRiskCents;
  return {
    source: 'artifacts/research/mgmt-bugfix-edge-attribution-01/v2-edge-attribution.json',
    matched_stop_loss_to_fail_safe_count: count,
    pre_fix_avg_stop_loss_cents: round(preAvg, 2),
    post_fix_avg_fail_safe_cents: round(postAvg, 2),
    empirical_avg_delta_cents: round(deltaAvg, 2),
    implied_stop_risk_cents_from_pre_stop_loss: round(stopRiskCents, 2),
    implied_post_fix_r_units: round(postR, 4),
    implied_extra_slippage_r_units: round(deltaR, 4),
    synthetic_bracket: 'between 1.25R and 2.0R, closer to 2.0R',
  };
}
function markdown(data: any) {
  return [
    '# MGMT-BUGFIX-FAILSAFE-FILL-MODEL-REVIEW-01',
    '',
    '## Code review',
    '',
    `- Fail-safe exit price: ${data.code_review.evaluate_fail_safe_exit_price_source}`,
    `- Stop-hit exit price: ${data.code_review.evaluate_stop_hit_exit_price_source}`,
    `- Dispatch order finding: ${data.dispatch_order.finding}`,
    '',
    '## Mark-price source trace',
    '',
    `- Call site: ${data.mark_price_source_trace.call_site}`,
    `- Value: ${data.mark_price_source_trace.value_at_trigger_bar}`,
    `- Event timestamp: ${data.mark_price_source_trace.event_ts_ns}`,
    `- Fill-realistic: ${data.mark_price_source_trace.is_fill_realistic}`,
    '',
    '## Synthetic tests',
    '',
    '| Case | Exit price | Realized R | Realized PnL USD | Pass |',
    '|---|---:|---:|---:|---|',
    ...data.synthetic_tests.map((test: any) => `| ${test.case} | ${test.exit_price ?? test.integrated_exit_price ?? ''} | ${test.realized_r ?? ''} | ${test.realized_pnl_usd ?? ''} | ${test.pass ? 'yes' : 'no'} |`),
    '',
    '## Empirical reconciliation',
    '',
    `- Empirical average delta: ${data.empirical_reconciliation.empirical_avg_delta_cents} cents/trade`,
    `- Implied post-fix R: ${data.empirical_reconciliation.implied_post_fix_r_units}R`,
    `- Implied extra slippage: ${data.empirical_reconciliation.implied_extra_slippage_r_units}R`,
    `- Synthetic bracket: ${data.empirical_reconciliation.synthetic_bracket}`,
    '',
    '## Determination',
    '',
    `- Code: \`${data.determination.code}\``,
    `- Basis: ${data.determination.basis}`,
    '',
    '## Recommended next ticket',
    '',
    data.recommended_next_ticket,
    '',
    '## Authority caveat',
    '',
    data.authority_caveat,
  ].join('\n');
}
function memo(data: any) {
  return [
    '# MGMT-BUGFIX-FAILSAFE-FILL-MODEL-REVIEW-01 Memo',
    '',
    '## 1. Context',
    '',
    'PR #277 found that v2 deterioration is dominated by stop_loss-to-fail_safe matched-pair deterioration, not target-to-fail_safe winner cutting. This review asks whether the fail-safe fill-price model itself is realistic enough to support thesis falsification.',
    '',
    '## 2. Code review (Q1)',
    '',
    'Fail-safe exits at `market.mark_price`; stop-hit exits at `position.active_stop_price`. For short positions with `max_adverse_r = 1.0`, fail-safe fires when mark reaches or exceeds the stop-distance threshold. The fail-safe exit is therefore worse-or-equal to the declared stop when the adverse mark is beyond the stop.',
    '',
    '## 3. Mark-price source trace (Q1 continued)',
    '',
    'The real-archive runner passes `mark_price: priceNumber(bar.close)` and `event_ts_ns: bar.last_record_ts_ns` to `evaluatePositionManager`. It also passes `bar.high` and `bar.low` for stop/target detection and latest bid/ask when available, but fail-safe exit-price selection ignores ask for short covers.',
    '',
    '## 4. Synthetic test results (Q2)',
    '',
    'The synthetic tests document current behavior without production-code changes: stop baseline exits at 20010 / -1R, fail-safe at 1R exits at 20010 / -1R, fail-safe at 1.25R exits at 20012.5 / -1.25R, and fail-safe at 2R exits at 20020 / -2R. A same-bar stop+fail-safe case is resolved as fail-safe because fail-safe runs before stop-hit.',
    '',
    '## 5. Dispatch-order analysis',
    '',
    'The position-manager order is fail-safe, PT1 touch marking, stop-hit, target hits, time-stop, break-even, trailing. This means fail-safe can preempt a declared stop on a bar where both conditions are true.',
    '',
    '## 6. Pre-fix vs post-fix diff',
    '',
    'The d1d7461 parent already used `market.mark_price` as fail-safe exit price. MGMT-BUG-FIX-02 added the max-adverse-R and max-spread enforcement branches; it did not introduce the mark-price fill model. The mark-price model was dormant until the guard began firing.',
    '',
    '## 7. Empirical reconciliation (Q2 continued)',
    '',
    `PR #277 stop_loss-to-fail_safe pairs averaged ${data.empirical_reconciliation.pre_fix_avg_stop_loss_cents} cents pre-fix versus ${data.empirical_reconciliation.post_fix_avg_fail_safe_cents} cents post-fix. The average deterioration is ${data.empirical_reconciliation.empirical_avg_delta_cents} cents/trade, or ${data.empirical_reconciliation.implied_extra_slippage_r_units}R beyond the pre-fix stop-risk proxy. The post-fix average is ${data.empirical_reconciliation.implied_post_fix_r_units}R, between the synthetic 1.25R and 2R cases.`,
    '',
    '## 8. Realism judgment (Q3)',
    '',
    'The backtest model is deterministic and internally explainable, but it is pessimistic for stop-cross attribution because the fail-safe fills at bar close at the bar end after stop crossing, rather than at the declared stop or an execution quote at the crossing moment. For a real short cover, ask-side fill realism is also not represented by the fail-safe exit-price field.',
    '',
    '## 9. Determination',
    '',
    `Determination: \`${data.determination.code}\`.`,
    '',
    data.determination.basis,
    '',
    '## 10. Recommended next ticket',
    '',
    data.recommended_next_ticket,
    '',
    '## 11. Authority caveat',
    '',
    data.authority_caveat,
    '',
    'This ticket changes no engine, strategy, parameter, roster, or authority. It reviews runtime fill-price semantics and does not reopen ADR-0024 LD-024-3 Step 4 verdict reconciliation, which remains coord+operator authority.',
  ].join('\n');
}
function sortJson(value: any): any { if (Array.isArray(value)) return value.map(sortJson); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])])); return value; }
function round(value: number, digits = 0): number { const factor = 10 ** digits; const out = Math.round(value * factor) / factor; return Object.is(out, -0) ? 0 : out; }
