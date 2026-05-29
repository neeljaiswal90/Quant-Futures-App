import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type ClassKey = 'max_adverse_r' | 'target' | 'stop_loss' | 'spread_fail_safe' | 'session_close';

interface ArtifactExit {
  readonly exit_quantity: number;
  readonly exit_ts_ns: string;
  readonly fail_safe_context: Record<string, JsonValue> | null;
  readonly management_action_reason: string | null;
  readonly management_action_type: string | null;
  readonly target_label: string | null;
}

interface ArtifactTrade {
  readonly entry_price: number;
  readonly entry_quantity: number;
  readonly entry_ts_ns: string;
  readonly exit_price: number;
  readonly exit_quantity: number;
  readonly exit_reason: string;
  readonly exit_ts_ns: string;
  readonly exits: readonly ArtifactExit[];
  readonly gross_pnl_cents: number | string;
  readonly max_adverse_excursion_cents: number | string;
  readonly max_favorable_excursion_cents: number | string;
  readonly net_pnl_cents: number | string;
  readonly queue_ahead_bucket: string | null;
  readonly regime: string | null;
  readonly session_id: string;
  readonly spread_bucket: string | null;
  readonly trade_id: string;
  readonly vix_prior_close_percentile: number | null;
}

interface HeldOutArtifact {
  readonly schema_version: number;
  readonly strategy_id: string;
  readonly trades: readonly ArtifactTrade[];
}

const TICKET = 'CYCLE4-R1-V3-EARLY-ADVERSE-MOVEMENT-DIAGNOSTIC-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v3';
const SOURCE_ARTIFACT = 'artifacts/held-out-validation/cycle4-r1-v3-failsafe-forensics-02/regime_shock_reversion_short_v3-feb-mar-apr-2026.json';
const PRIOR_MAX_ADVERSE_JSON = 'artifacts/research/cycle4-r1-v3-max-adverse-r-diagnostic-01/v3-max-adverse-r-diagnostic.json';
const PRIOR_MAX_ADVERSE_MD = 'artifacts/research/cycle4-r1-v3-max-adverse-r-diagnostic-01/v3-max-adverse-r-diagnostic.md';
const OUT_JSON = 'artifacts/research/cycle4-r1-v3-early-adverse-movement-diagnostic-01/v3-early-adverse-movement-diagnostic.json';
const OUT_MD = 'artifacts/research/cycle4-r1-v3-early-adverse-movement-diagnostic-01/v3-early-adverse-movement-diagnostic.md';

const EXPECTED = Object.freeze({
  sourceArtifactSha: '30383348fbf6d3f014a1df09b05120e14f63fdedb832fb2ea053f9651a8a2329',
  priorMaxAdverseJsonLfSha: '23483e4d7fa5672dd3180cd7e7603255398335e10c018ca61da7a1be29ed378f',
  priorMaxAdverseMdLfSha: '8109b20b04f6550a5cb129410ba05cf4a55b6d14633af0664e8085ba2b846777',
  totalTrades: 889,
  maxAdverseFailSafes: 245,
  targetExits: 259,
  stopLossExits: 363,
  spreadFailSafes: 17,
  sessionCloseExits: 5,
  totalNetPnlCents: -102_600,
});

function main(): void {
  const artifactBytes = readFileSync(SOURCE_ARTIFACT);
  const artifactSha = sha256Bytes(artifactBytes);
  const priorJsonByteSha = sha256File(PRIOR_MAX_ADVERSE_JSON);
  const priorJsonLfSha = lfSha256File(PRIOR_MAX_ADVERSE_JSON);
  const priorMdByteSha = sha256File(PRIOR_MAX_ADVERSE_MD);
  const priorMdLfSha = lfSha256File(PRIOR_MAX_ADVERSE_MD);
  const artifact = JSON.parse(artifactBytes.toString('utf8')) as HeldOutArtifact;

  assertArtifact(artifact, artifactSha, priorJsonLfSha, priorMdLfSha);

  const classes = classifyTrades(artifact.trades);
  const output = {
    schema_version: 1,
    ticket: TICKET,
    source_artifacts: {
      held_out_artifact: {
        path: SOURCE_ARTIFACT,
        sha256: artifactSha,
        strategy_id: artifact.strategy_id,
      },
      prior_max_adverse_json: {
        path: PRIOR_MAX_ADVERSE_JSON,
        byte_sha256: priorJsonByteSha,
        lf_sha256: priorJsonLfSha,
        expected_lf_sha256: EXPECTED.priorMaxAdverseJsonLfSha,
        line_ending_note: priorJsonByteSha === priorJsonLfSha ? 'byte hash equals LF-canonical hash' : 'working-tree byte hash differs from LF-canonical hash due checkout line endings; LF-canonical hash matches dispatch anchor',
      },
      prior_max_adverse_markdown: {
        path: PRIOR_MAX_ADVERSE_MD,
        byte_sha256: priorMdByteSha,
        lf_sha256: priorMdLfSha,
        expected_lf_sha256: EXPECTED.priorMaxAdverseMdLfSha,
        line_ending_note: priorMdByteSha === priorMdLfSha ? 'byte hash equals LF-canonical hash' : 'working-tree byte hash differs from LF-canonical hash due checkout line endings; LF-canonical hash matches dispatch anchor',
      },
    },
    anchor_reconciliation: {
      status: 'matched',
      total_trades: artifact.trades.length,
      max_adverse_r_fail_safes: classes.max_adverse_r.length,
      target_exits: classes.target.length,
      stop_loss_exits: classes.stop_loss.length,
      spread_fail_safes: classes.spread_fail_safe.length,
      session_close_exits: classes.session_close.length,
      total_net_pnl_cents: sum(artifact.trades.map(netPnl)),
      single_contract_replay: artifact.trades.every((trade) => trade.entry_quantity === 1 && trade.exit_quantity === 1 && trade.exits.length === 1),
    },
    class_definitions: {
      primary_negative_class: 'exit_reason=fail_safe and exits[].management_action_reason=fail_safe:max_adverse_r_exceeded',
      primary_positive_class: 'exit_reason=target',
      secondary_comparison_classes: [
        'exit_reason=stop_loss',
        'exits[].management_action_reason=fail_safe:max_spread_ticks_exceeded',
        'exit_reason=session_close',
      ],
    },
    negative_vs_positive_class_summary: classSummaries({ max_adverse_r: classes.max_adverse_r, target: classes.target }),
    all_class_summaries: classSummaries(classes),
    pre_entry_observables: preEntryInventory(classes),
    early_post_entry_observables: earlyPostEntryInventory(classes),
    distribution_comparison: {
      vix_prior_close_percentile_bucket: bucketComparison(classes, (trade) => vixBucket(trade.vix_prior_close_percentile)),
      regime: bucketComparison(classes, (trade) => trade.regime ?? 'missing'),
      spread_bucket: bucketComparison(classes, (trade) => trade.spread_bucket ?? 'missing'),
      queue_ahead_bucket: bucketComparison(classes, (trade) => trade.queue_ahead_bucket ?? 'missing'),
      session_id_top10: topSessionComparison(classes),
      hold_time_minutes: metricComparison(classes, holdMinutes),
      max_adverse_excursion_cents: metricComparison(classes, maeCents),
      max_favorable_excursion_cents: metricComparison(classes, mfeCents),
      short_price_delta_points: metricComparison(classes, shortPriceDeltaPoints),
    },
    candidate_separators: candidateSeparators(classes),
    break_even_tradeoff: breakEvenTradeoff(classes),
    evidence_gaps: [
      'per-trade signed_shock_vwap is unavailable, blocking direct analysis of entry shock strength',
      'per-trade signed_shock_vwap_recent_values is unavailable, blocking persistence/delay-style pre-entry separation analysis',
      'per-trade vix_value and vix_fresh are unavailable; only vix_prior_close_percentile is serialized',
      'primary_percentile and vxn_percentile are unavailable per trade',
      'exact adverse-R scalar at exit is unavailable; max-adverse classification is available through management_action_reason and MAE context',
      'first-minute adverse movement path is unavailable; only entry/exit timestamps, entry/exit prices, MFE, and MAE are serialized',
    ],
    recommendations: [
      'Do not tune v3 entry thresholds, VIX bands, stops, or max_adverse_r from this diagnostic alone.',
      'Current serialized pre-entry fields do not provide a clean enough separator to justify a registered-inactive entry-quality variant.',
      'Route a narrow evidence-surface extension or controlled replay instrumentation for signed-shock, recent-shock, VIX freshness/value, regime percentiles, and first-minute adverse movement path before tuning.',
      'If instrumentation confirms a pre-entry proxy for the max-adverse class, then dispatch a separate registered-inactive entry-quality variant ticket.',
      'No activation, paper observation, broker/live dispatch, or Phase 6 authority follows from this diagnostic.',
    ],
  } satisfies JsonValue;

  writeJson(output);
  writeMarkdown(output);

  process.stdout.write(JSON.stringify({
    source_sha: artifactSha,
    prior_json_lf_sha: priorJsonLfSha,
    prior_json_byte_sha: priorJsonByteSha,
    total_trades: artifact.trades.length,
    max_adverse_trades: classes.max_adverse_r.length,
    target_trades: classes.target.length,
    stop_loss_trades: classes.stop_loss.length,
    spread_fail_safe_trades: classes.spread_fail_safe.length,
    session_close_trades: classes.session_close.length,
    total_net_pnl_cents: sum(artifact.trades.map(netPnl)),
    json_out: OUT_JSON,
    md_out: OUT_MD,
  }, null, 2));
  process.stdout.write('\n');
}

function assertArtifact(artifact: HeldOutArtifact, artifactSha: string, priorJsonLfSha: string, priorMdLfSha: string): void {
  if (artifactSha !== EXPECTED.sourceArtifactSha) throw new Error(`source artifact SHA mismatch: ${artifactSha}`);
  if (priorJsonLfSha !== EXPECTED.priorMaxAdverseJsonLfSha) throw new Error(`prior max-adverse JSON LF SHA mismatch: ${priorJsonLfSha}`);
  if (priorMdLfSha !== EXPECTED.priorMaxAdverseMdLfSha) throw new Error(`prior max-adverse MD LF SHA mismatch: ${priorMdLfSha}`);
  if (artifact.schema_version !== 1) throw new Error(`expected schema_version 1, got ${artifact.schema_version}`);
  if (artifact.strategy_id !== STRATEGY_ID) throw new Error(`expected strategy ${STRATEGY_ID}, got ${artifact.strategy_id}`);
  if (artifact.trades.length !== EXPECTED.totalTrades) throw new Error(`expected ${EXPECTED.totalTrades} trades, got ${artifact.trades.length}`);
  if (sum(artifact.trades.map(netPnl)) !== EXPECTED.totalNetPnlCents) throw new Error('total net PnL anchor mismatch');
  if (!artifact.trades.every((trade) => trade.entry_quantity === 1 && trade.exit_quantity === 1 && trade.exits.length === 1)) throw new Error('expected all trades to be single-contract single-exit');

  const classes = classifyTrades(artifact.trades);
  const anchors: Array<[string, number, number]> = [
    ['max-adverse fail-safes', classes.max_adverse_r.length, EXPECTED.maxAdverseFailSafes],
    ['target exits', classes.target.length, EXPECTED.targetExits],
    ['stop-loss exits', classes.stop_loss.length, EXPECTED.stopLossExits],
    ['spread fail-safes', classes.spread_fail_safe.length, EXPECTED.spreadFailSafes],
    ['session-close exits', classes.session_close.length, EXPECTED.sessionCloseExits],
  ];
  for (const [label, actual, expected] of anchors) {
    if (actual !== expected) throw new Error(`${label} anchor mismatch: expected ${expected}, got ${actual}`);
  }
}

function classifyTrades(trades: readonly ArtifactTrade[]): Record<ClassKey, readonly ArtifactTrade[]> {
  return {
    max_adverse_r: trades.filter((trade) => onlyExit(trade).management_action_reason === 'fail_safe:max_adverse_r_exceeded'),
    target: trades.filter((trade) => trade.exit_reason === 'target'),
    stop_loss: trades.filter((trade) => trade.exit_reason === 'stop_loss'),
    spread_fail_safe: trades.filter((trade) => onlyExit(trade).management_action_reason === 'fail_safe:max_spread_ticks_exceeded'),
    session_close: trades.filter((trade) => trade.exit_reason === 'session_close'),
  };
}

function classSummaries(classes: Partial<Record<ClassKey, readonly ArtifactTrade[]>>): JsonValue[] {
  return Object.entries(classes).map(([key, trades]) => {
    const rows = trades ?? [];
    return {
      class: key,
      count: rows.length,
      net_pnl_cents: sum(rows.map(netPnl)),
      avg_net_pnl_cents: round(avg(rows.map(netPnl))),
      median_net_pnl_cents: percentile(rows.map(netPnl), 0.5),
      p10_net_pnl_cents: percentile(rows.map(netPnl), 0.1),
      p90_net_pnl_cents: percentile(rows.map(netPnl), 0.9),
      avg_hold_minutes: round(avg(rows.map(holdMinutes)), 4),
      median_hold_minutes: percentile(rows.map(holdMinutes), 0.5, 4),
      under_2_minutes_count: rows.filter((trade) => holdMinutes(trade) < 2).length,
      under_2_minutes_pct: pct(rows.filter((trade) => holdMinutes(trade) < 2).length, rows.length),
      median_mae_cents: percentile(rows.map(maeCents), 0.5),
      median_mfe_cents: percentile(rows.map(mfeCents), 0.5),
      median_short_price_delta_points: percentile(rows.map(shortPriceDeltaPoints), 0.5, 4),
    };
  });
}

function preEntryInventory(classes: Record<ClassKey, readonly ArtifactTrade[]>): JsonValue[] {
  return [
    observable('session_id', 'available', 'pre-entry usable only as session-level diagnostic; not a robust strategy filter by itself', 'serialized on every trade', bucketComparison(classes, (trade) => trade.session_id, 5)),
    observable('vix_prior_close_percentile', 'available', 'pre-entry usable', 'serialized on every trade; simple high-VIX exclusion has high winner-filter risk', bucketComparison(classes, (trade) => vixBucket(trade.vix_prior_close_percentile))),
    observable('regime', 'available', 'pre-entry usable', 'serialized as high/low/non-trading style label', bucketComparison(classes, (trade) => trade.regime ?? 'missing')),
    observable('spread_bucket', 'available', 'pre-entry usable if bucket reflects entry-time spread', 'serialized bucket; compare winner-filter risk before any variant', bucketComparison(classes, (trade) => trade.spread_bucket ?? 'missing')),
    observable('queue_ahead_bucket', 'available', 'pre-entry usable if bucket reflects entry-time queue context', 'serialized bucket; compare winner-filter risk before any variant', bucketComparison(classes, (trade) => trade.queue_ahead_bucket ?? 'missing')),
    observable('entry_price', 'available', 'pre-entry usable only with a separately justified market-structure hypothesis', 'serialized but continuous level is not a stable causal filter by itself', metricComparison(classes, (trade) => trade.entry_price)),
  ];
}

function earlyPostEntryInventory(classes: Record<ClassKey, readonly ArtifactTrade[]>): JsonValue[] {
  return [
    observable('hold_time_minutes', 'derivable', 'early-post-entry / outcome diagnostic only', 'derived from entry_ts_ns and exit_ts_ns; not a pre-entry filter', metricComparison(classes, holdMinutes)),
    observable('entry_to_exit_short_price_delta_points', 'derivable', 'early-post-entry / outcome diagnostic only', 'entry_price - exit_price for short trades; realized path endpoint', metricComparison(classes, shortPriceDeltaPoints)),
    observable('max_adverse_excursion_cents', 'available', 'outcome-only / diagnostic only', 'strong separator but cannot be used directly as an entry filter', metricComparison(classes, maeCents)),
    observable('max_favorable_excursion_cents', 'available', 'outcome-only / diagnostic only', 'strong target-quality descriptor; not pre-entry', metricComparison(classes, mfeCents)),
  ];
}

function observable(field: string, availability: string, actionability: string, notes: string, summary: JsonValue): JsonValue {
  return { field, availability, actionability, notes, summary };
}

function candidateSeparators(classes: Record<ClassKey, readonly ArtifactTrade[]>): JsonValue[] {
  return [
    predicateCandidate(classes, 'exclude_vix_prior_close_percentile_ge_0_85', 'vix_prior_close_percentile >= 0.85', 'pre-entry usable', (trade) => (trade.vix_prior_close_percentile ?? -Infinity) >= 0.85, 'Not recommended as a standalone filter because targets have higher exposure than max-adverse trades.'),
    predicateCandidate(classes, 'exclude_vix_prior_close_percentile_0_25_to_0_50', '0.25 <= vix_prior_close_percentile < 0.50', 'pre-entry usable', (trade) => (trade.vix_prior_close_percentile ?? -Infinity) >= 0.25 && (trade.vix_prior_close_percentile ?? Infinity) < 0.5, 'Largest max-adverse count bucket, but target exposure is also large; needs richer context.'),
    predicateCandidate(classes, 'exclude_worst_spread_bucket_3_plus_ticks', 'spread_bucket == 3+ ticks', 'pre-entry usable if spread_bucket is entry-time context', (trade) => trade.spread_bucket === '3+ ticks', 'Potentially available but likely broad; must quantify target loss before any implementation.'),
    predicateCandidate(classes, 'exclude_queue_bucket_1_to_5', 'queue_ahead_bucket == 1-5', 'pre-entry usable if queue bucket is entry-time context', (trade) => trade.queue_ahead_bucket === '1-5', 'Queue bucket is available, but current evidence does not prove a clean adverse-only separator.'),
    predicateCandidate(classes, 'hold_time_under_2_minutes', 'hold_time_minutes < 2', 'early-post-entry only', (trade) => holdMinutes(trade) < 2, 'Corroborates R2 chop-flip timing but is not a pre-entry filter.'),
    predicateCandidate(classes, 'mae_at_or_below_minus_2000_cents', 'max_adverse_excursion_cents <= -2000', 'outcome-only / diagnostic only', (trade) => maeCents(trade) <= -2000, 'Strong realized separator; useful only if future evidence finds a pre-entry proxy.'),
  ];
}

function predicateCandidate(
  classes: Record<ClassKey, readonly ArtifactTrade[]>,
  feature: string,
  rule: string,
  actionability: string,
  predicate: (trade: ArtifactTrade) => boolean,
  notes: string,
): JsonValue {
  const max = classes.max_adverse_r;
  const target = classes.target;
  const stop = classes.stop_loss;
  const spread = classes.spread_fail_safe;
  const maxHit = max.filter(predicate);
  const targetHit = target.filter(predicate);
  const stopHit = stop.filter(predicate);
  const spreadHit = spread.filter(predicate);
  const avoidedLossCents = -sum(maxHit.map(netPnl));
  const targetProfitAtRiskCents = sum(targetHit.map(netPnl));
  const netVsTargetsOnlyCents = avoidedLossCents - targetProfitAtRiskCents;
  return {
    feature,
    rule,
    actionability,
    max_adverse_capture_count: maxHit.length,
    max_adverse_capture_pct: pct(maxHit.length, max.length),
    target_at_risk_count: targetHit.length,
    target_at_risk_pct: pct(targetHit.length, target.length),
    stop_loss_removed_count: stopHit.length,
    spread_fail_safe_removed_count: spreadHit.length,
    avoided_max_adverse_loss_cents: avoidedLossCents,
    target_profit_at_risk_cents: targetProfitAtRiskCents,
    net_vs_targets_only_cents: netVsTargetsOnlyCents,
    confidence: actionability === 'outcome-only / diagnostic only' ? 'high diagnostic confidence, zero direct entry-filter authority' : 'medium diagnostic confidence',
    notes,
  };
}

function breakEvenTradeoff(classes: Record<ClassKey, readonly ArtifactTrade[]>): JsonValue {
  const max = classes.max_adverse_r;
  const target = classes.target;
  const maxAvgLoss = -avg(max.map(netPnl));
  const targetAvgProfit = avg(target.map(netPnl));
  const breakEvenGap = 102_600;
  const pfPassGap = 309_593;
  const requiredMaxAdverseAvoidedForBreakEven = Math.ceil(breakEvenGap / maxAvgLoss);
  const requiredMaxAdverseAvoidedForPfPass = Math.ceil(pfPassGap / maxAvgLoss);
  const scenarios = [44, 60, 100, 131, 245].map((avoided) => {
    const benefit = avoided * maxAvgLoss;
    return {
      max_adverse_trades_avoided: avoided,
      gross_benefit_cents: round(benefit),
      avg_target_winners_lost_allowed_for_break_even: Math.max(0, Math.floor((benefit - breakEvenGap) / targetAvgProfit)),
      avg_target_winners_lost_allowed_for_pf_pass: Math.max(0, Math.floor((benefit - pfPassGap) / targetAvgProfit)),
    };
  });
  return {
    break_even_gap_cents: breakEvenGap,
    pf_pass_gap_cents_if_gross_profit_unchanged: pfPassGap,
    max_adverse_avg_loss_cents: round(maxAvgLoss, 2),
    target_avg_profit_cents: round(targetAvgProfit, 2),
    required_max_adverse_trades_avoided_for_break_even_with_no_target_loss: requiredMaxAdverseAvoidedForBreakEven,
    required_max_adverse_trades_avoided_for_pf_pass_with_no_target_loss: requiredMaxAdverseAvoidedForPfPass,
    scenarios,
  };
}

function bucketComparison(classes: Record<ClassKey, readonly ArtifactTrade[]>, getKey: (trade: ArtifactTrade) => string, limit?: number): JsonValue[] {
  return Object.entries(classes).map(([classKey, trades]) => {
    const rows = new Map<string, ArtifactTrade[]>();
    for (const trade of trades) {
      const key = getKey(trade);
      const bucket = rows.get(key) ?? [];
      bucket.push(trade);
      rows.set(key, bucket);
    }
    const groups = [...rows.entries()]
      .map(([key, group]) => ({
        key,
        count: group.length,
        pct_of_class: pct(group.length, trades.length),
        net_pnl_cents: sum(group.map(netPnl)),
        avg_net_pnl_cents: round(avg(group.map(netPnl)), 2),
      }))
      .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
    return { class: classKey, groups: typeof limit === 'number' ? groups.slice(0, limit) : groups };
  });
}

function topSessionComparison(classes: Record<ClassKey, readonly ArtifactTrade[]>): JsonValue[] {
  return bucketComparison(classes, (trade) => trade.session_id, 10);
}

function metricComparison(classes: Record<ClassKey, readonly ArtifactTrade[]>, getValue: (trade: ArtifactTrade) => number): JsonValue[] {
  return Object.entries(classes).map(([classKey, trades]) => {
    const values = trades.map(getValue).filter(Number.isFinite);
    return {
      class: classKey,
      count: values.length,
      avg: round(avg(values), 4),
      median: percentile(values, 0.5, 4),
      p10: percentile(values, 0.1, 4),
      p25: percentile(values, 0.25, 4),
      p75: percentile(values, 0.75, 4),
      p90: percentile(values, 0.9, 4),
    };
  });
}

function writeJson(value: JsonValue): void {
  mkdirSync(dirname(OUT_JSON), { recursive: true });
  writeFileSync(OUT_JSON, `${stableStringify(value)}\n`, 'utf8');
}

function writeMarkdown(value: JsonValue): void {
  const root = value as Record<string, JsonValue>;
  const anchors = root.anchor_reconciliation as Record<string, JsonValue>;
  const summaries = root.all_class_summaries as Array<Record<string, JsonValue>>;
  const candidates = root.candidate_separators as Array<Record<string, JsonValue>>;
  const tradeoff = root.break_even_tradeoff as Record<string, JsonValue>;
  mkdirSync(dirname(OUT_MD), { recursive: true });
  const lines = [
    '# v3 Early Adverse Movement Diagnostic',
    '',
    '## Anchor reconciliation',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| Total trades | ${anchors.total_trades} |`,
    `| Max-adverse-R fail-safes | ${anchors.max_adverse_r_fail_safes} |`,
    `| Target exits | ${anchors.target_exits} |`,
    `| Stop-loss exits | ${anchors.stop_loss_exits} |`,
    `| Spread fail-safes | ${anchors.spread_fail_safes} |`,
    `| Session-close exits | ${anchors.session_close_exits} |`,
    `| Total net PnL cents | ${anchors.total_net_pnl_cents} |`,
    '',
    '## Class summaries',
    '',
    '| Class | Count | Net PnL cents | Avg PnL cents | Median hold min | Under 2m % | Median MAE cents | Median MFE cents |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...summaries.map((row) => `| ${row.class} | ${row.count} | ${row.net_pnl_cents} | ${row.avg_net_pnl_cents} | ${row.median_hold_minutes} | ${row.under_2_minutes_pct} | ${row.median_mae_cents} | ${row.median_mfe_cents} |`),
    '',
    '## Candidate separators',
    '',
    '| Feature | Actionability | Max adverse captured | Targets at risk | Net vs targets only cents | Notes |',
    '|---|---|---:|---:|---:|---|',
    ...candidates.map((row) => `| ${row.feature} | ${row.actionability} | ${row.max_adverse_capture_count} (${row.max_adverse_capture_pct}%) | ${row.target_at_risk_count} (${row.target_at_risk_pct}%) | ${row.net_vs_targets_only_cents} | ${row.notes} |`),
    '',
    '## Break-even tradeoff',
    '',
    `Break-even gap: ${tradeoff.break_even_gap_cents} cents.`,
    '',
    `PF pass gap, if gross profit is unchanged: ${tradeoff.pf_pass_gap_cents_if_gross_profit_unchanged} cents.`,
    '',
    `Required average max-adverse trades avoided for break-even with no target loss: ${tradeoff.required_max_adverse_trades_avoided_for_break_even_with_no_target_loss}.`,
    '',
    `Required average max-adverse trades avoided for PF pass with no target loss: ${tradeoff.required_max_adverse_trades_avoided_for_pf_pass_with_no_target_loss}.`,
    '',
    '## Recommendation',
    '',
    'Current serialized pre-entry fields do not provide a clean separator with acceptable winner-filter risk. Route a narrow evidence-surface extension or controlled replay instrumentation before tuning.',
    '',
  ];
  writeFileSync(OUT_MD, `${lines.join('\n')}\n`, 'utf8');
}

function onlyExit(trade: ArtifactTrade): ArtifactExit {
  if (trade.exits.length !== 1) throw new Error(`expected one exit for ${trade.trade_id}`);
  return trade.exits[0];
}

function netPnl(trade: ArtifactTrade): number {
  return Number(trade.net_pnl_cents);
}

function maeCents(trade: ArtifactTrade): number {
  return Number(trade.max_adverse_excursion_cents);
}

function mfeCents(trade: ArtifactTrade): number {
  return Number(trade.max_favorable_excursion_cents);
}

function shortPriceDeltaPoints(trade: ArtifactTrade): number {
  return trade.entry_price - trade.exit_price;
}

function holdMinutes(trade: ArtifactTrade): number {
  return Number(BigInt(trade.exit_ts_ns) - BigInt(trade.entry_ts_ns)) / 60_000_000_000;
}

function vixBucket(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'missing';
  if (value < 0.25) return '<0.25';
  if (value < 0.5) return '0.25-0.50';
  if (value < 0.67) return '0.50-0.67';
  if (value < 0.85) return '0.67-0.85';
  return '>=0.85';
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function avg(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function percentile(values: readonly number[], p: number, digits = 2): number {
  const sorted = values.filter(Number.isFinite).slice().sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return round(sorted[lower], digits);
  const weight = index - lower;
  return round(sorted[lower] * (1 - weight) + sorted[upper] * weight, digits);
}

function pct(count: number, denominator: number): number {
  return denominator === 0 ? 0 : round((count / denominator) * 100, 2);
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

function lfSha256File(path: string): string {
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  return sha256Bytes(Buffer.from(text, 'utf8'));
}

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

main();
