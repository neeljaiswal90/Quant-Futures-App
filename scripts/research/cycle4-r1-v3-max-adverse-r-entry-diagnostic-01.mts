import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const ticket = 'CYCLE4-R1-V3-MAX-ADVERSE-R-ENTRY-DIAGNOSTIC-01';
const sourcePath = 'artifacts/held-out-validation/cycle4-r1-v3-early-adverse-diagnostic-02/regime_shock_reversion_short_v3-feb-mar-apr-2026.json';
const outputDir = process.env.ENTRY_DIAG_OUT_DIR ?? 'artifacts/research/cycle4-r1-v3-max-adverse-r-entry-diagnostic-01';
const outputJsonPath = `${outputDir}/v3-max-adverse-r-entry-diagnostic.json`;
const outputMdPath = `${outputDir}/v3-max-adverse-r-entry-diagnostic.md`;
const memoPath = 'docs/research/cycle4-r1-v3-max-adverse-r-entry-diagnostic-01-memo.md';
const expectedSourceSha = 'acc2ee2f27e08fab09bf0c21cbce5f409b86633a4df51782357a07b565e3476f';
const expected = {
  total_trades: 889,
  max_adverse_r: 245,
  spread_fail_safe: 17,
  target: 259,
  stop_loss: 363,
  session_close: 5,
  net_pnl_cents: -102600,
};
const breakEvenGapCents = 102600;
const pfPassLossReductionGapCents = 309593;

const sourceBytes = readFileSync(sourcePath);
const sourceSha = sha(sourceBytes);
if (sourceSha !== expectedSourceSha) throw new Error(`source artifact SHA mismatch: expected ${expectedSourceSha}, got ${sourceSha}`);
const artifact = JSON.parse(sourceBytes.toString('utf8'));
const trades = artifact.trades;
assertSource();
const classes = classify(trades);
const anchors = anchorReconciliation();
if (anchors.status !== 'matched') throw new Error(`anchor mismatch: ${JSON.stringify(anchors)}`);

const fieldAvailability = entryFieldAvailability();
const winnerLoser = winnerLoserByExitClass();
const vixFresh = vixFreshBreakdown();
const distributions = entryDistributions();
const singleCandidates = buildSingleCandidates().map((candidate) => evaluateCandidate(candidate, 'single_predicate'));
singleCandidates.sort(compareCandidates);
const bestSingle = singleCandidates[0] ?? null;
const twoPredicateCandidates = buildTwoPredicateCandidates(singleCandidates.slice(0, 24)).map((candidate) => evaluateCandidate(candidate, 'two_predicate'));
twoPredicateCandidates.sort(compareCandidates);
const bestTwoPredicate = twoPredicateCandidates[0] ?? null;
const bestOverall = [bestSingle, bestTwoPredicate].filter(Boolean).sort(compareCandidates)[0] ?? null;
const decision = decide(bestSingle, bestTwoPredicate, bestOverall);
const output = sortJson({
  schema_version: 1,
  ticket,
  source_artifact: {
    path: sourcePath,
    sha256: sourceSha,
    schema_version: artifact.schema_version,
    strategy_id: artifact.strategy_id,
  },
  decision_output: decision,
  anchor_reconciliation: anchors,
  rule_semantics: {
    primary_decision_surface: 'pre-entry and entry-time fields only',
    counterfactual: 'matched trades are treated as skipped entries with zero PnL; delta = -actual_net_pnl_cents',
    prohibited_primary_fields: [
      'first_minute_close_pnl_cents',
      'first_minute_max_adverse_excursion_cents',
      'first_minute_max_favorable_excursion_cents',
      'first_minute_observed',
      'adverse_r_at_exit',
      'exit_price',
      'exit_reason',
      'hold_time',
      'MFE/MAE',
    ],
    caveat: 'Diagnostic filter accounting only. This is not a replay of a new strategy variant.',
  },
  field_availability: fieldAvailability,
  within_exit_class_winner_loser: winnerLoser,
  vix_fresh_breakdown: vixFresh,
  entry_field_distributions: distributions,
  best_single_predicate_candidate: bestSingle,
  best_two_predicate_candidate: bestTwoPredicate,
  top_single_predicate_candidates: singleCandidates.slice(0, 20),
  top_two_predicate_candidates: twoPredicateCandidates.slice(0, 20),
  two_predicate_incremental_value: incrementalValue(bestSingle, bestTwoPredicate),
  recommendation: recommendation(decision),
  authority_caveat: 'No activation, paper observation, broker/live dispatch, Phase 6 authority, ACTIVE roster mutation, strategy mutation, or management-profile mutation is authorized.',
});

mkdirSync(outputDir, { recursive: true });
writeFileSync(outputJsonPath, `${JSON.stringify(output)}\n`, 'utf8');
writeFileSync(outputMdPath, `${markdown(output)}\n`, 'utf8');
writeFileSync(memoPath, `${memo(output)}\n`, 'utf8');
console.log(JSON.stringify({
  source_sha: sourceSha,
  anchor_status: anchors.status,
  json_out: outputJsonPath,
  md_out: outputMdPath,
  memo_out: memoPath,
  best_single: bestSingle ? summarizeRule(bestSingle) : null,
  best_two_predicate: bestTwoPredicate ? summarizeRule(bestTwoPredicate) : null,
  decision: decision.decision,
}, null, 2));

function assertSource() {
  if (artifact.schema_version !== 1) throw new Error(`schema_version mismatch: ${artifact.schema_version}`);
  if (!Array.isArray(trades)) throw new Error('artifact.trades is not an array');
  if (trades.length !== expected.total_trades) throw new Error(`trade count mismatch: ${trades.length}`);
  for (const trade of trades) {
    if (trade.entry_quantity !== 1 || trade.exit_quantity !== 1) throw new Error(`non-single-contract trade ${trade.trade_id}`);
    if (!trade.trade_id) throw new Error('missing trade_id');
    if (!Array.isArray(trade.exits) || trade.exits.length !== 1) throw new Error(`expected exactly one exit for ${trade.trade_id}`);
    if (reason(trade) === 'fail_safe:max_adverse_r_exceeded' && !finite(num(trade.exits[0]?.fail_safe_context?.adverse_r_at_exit))) {
      throw new Error(`missing finite adverse_r_at_exit for ${trade.trade_id}`);
    }
  }
}

function classify(rows) {
  return {
    max_adverse_r: rows.filter((trade) => reason(trade) === 'fail_safe:max_adverse_r_exceeded'),
    spread_fail_safe: rows.filter((trade) => reason(trade) === 'fail_safe:max_spread_ticks_exceeded'),
    target: rows.filter((trade) => trade.exit_reason === 'target'),
    stop_loss: rows.filter((trade) => trade.exit_reason === 'stop_loss'),
    session_close: rows.filter((trade) => trade.exit_reason === 'session_close'),
  };
}

function anchorReconciliation() {
  const actual = {
    total_trades: trades.length,
    max_adverse_r: classes.max_adverse_r.length,
    spread_fail_safe: classes.spread_fail_safe.length,
    target: classes.target.length,
    stop_loss: classes.stop_loss.length,
    session_close: classes.session_close.length,
    net_pnl_cents: sum(trades.map(net)),
  };
  const mismatches = Object.keys(expected).filter((key) => actual[key] !== expected[key]);
  return { status: mismatches.length === 0 ? 'matched' : 'mismatch', expected, actual, mismatches };
}

function buildSingleCandidates() {
  const candidates = [];
  const numericFeatures = [
    numericFeature('signed_shock_vwap.value', (trade) => num(trade.signed_shock_vwap?.value), [2, 2.1, 2.2, 2.25, 2.3, 2.4, 2.5, 2.75, 3]),
    numericFeature('recent_shock.latest', recentLatest, [1, 1.5, 2, 2.25, 2.5, 2.75, 3]),
    numericFeature('recent_shock.mean_last_3', (trade) => meanRecent(trade, 3), [1, 1.5, 2, 2.25, 2.5, 2.75, 3]),
    numericFeature('recent_shock.mean_last_5', (trade) => meanRecent(trade, 5), [1, 1.5, 2, 2.25, 2.5, 2.75, 3]),
    numericFeature('recent_shock.min_last_5', (trade) => minRecent(trade, 5), [0, 0.5, 1, 1.5, 2]),
    numericFeature('recent_shock.max_last_5', (trade) => maxRecent(trade, 5), [2, 2.5, 3, 3.5, 4]),
    numericFeature('recent_shock.slope_last_3', (trade) => slopeRecent(trade, 3), [-1, -0.5, 0, 0.5, 1]),
    numericFeature('vix_prior_close_percentile', (trade) => num(trade.vix_prior_close_percentile), [0.25, 0.5, 0.6, 0.67, 0.75, 0.85, 0.9, 0.95]),
    numericFeature('vix_value', (trade) => num(trade.vix_value), [18, 20, 22, 24, 26, 28, 30, 35]),
    numericFeature('entry_hour_utc', entryHourUtc, [14, 15, 16, 17, 18, 19, 20]),
  ];
  for (const feature of numericFeatures) {
    const thresholds = uniqueNumbers([...feature.thresholds, ...quantiles(trades.map(feature.getter), [0.1, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9])]);
    for (const threshold of thresholds) {
      candidates.push({ name: `${feature.name} < ${fmt(threshold)}`, predicate: (trade) => finite(feature.getter(trade)) && feature.getter(trade) < threshold, features: [feature.name], rule: { type: 'numeric_threshold', field: feature.name, operator: '<', threshold } });
      candidates.push({ name: `${feature.name} >= ${fmt(threshold)}`, predicate: (trade) => finite(feature.getter(trade)) && feature.getter(trade) >= threshold, features: [feature.name], rule: { type: 'numeric_threshold', field: feature.name, operator: '>=', threshold } });
    }
  }
  for (const band of [[0, 0.25], [0.25, 0.5], [0.5, 0.67], [0.6, 0.85], [0.67, 0.85], [0.67, 0.9], [0.85, 1.01], [0.9, 1.01]]) {
    candidates.push({
      name: `vix_prior_close_percentile in [${fmt(band[0])}, ${fmt(band[1])})`,
      predicate: (trade) => finite(num(trade.vix_prior_close_percentile)) && num(trade.vix_prior_close_percentile) >= band[0] && num(trade.vix_prior_close_percentile) < band[1],
      features: ['vix_prior_close_percentile'],
      rule: { type: 'numeric_band', field: 'vix_prior_close_percentile', lower_inclusive: band[0], upper_exclusive: band[1] },
    });
  }
  const categoricalFeatures = [
    categoricalFeature('vix_fresh', (trade) => String(trade.vix_fresh)),
    categoricalFeature('spread_bucket', (trade) => trade.spread_bucket ?? 'missing'),
    categoricalFeature('queue_ahead_bucket', (trade) => trade.queue_ahead_bucket ?? 'missing'),
    categoricalFeature('regime', (trade) => trade.regime ?? 'missing'),
    categoricalFeature('entry_hour_utc_bucket', (trade) => String(entryHourUtc(trade))),
  ];
  for (const feature of categoricalFeatures) {
    const values = uniqueStrings(trades.map(feature.getter));
    for (const value of values) {
      candidates.push({ name: `${feature.name} == ${value}`, predicate: (trade) => feature.getter(trade) === value, features: [feature.name], rule: { type: 'categorical_equals', field: feature.name, value } });
      candidates.push({ name: `${feature.name} != ${value}`, predicate: (trade) => feature.getter(trade) !== value, features: [feature.name], rule: { type: 'categorical_not_equals', field: feature.name, value } });
    }
  }
  return candidates;
}

function buildTwoPredicateCandidates(topSingles) {
  const candidates = [];
  for (let i = 0; i < topSingles.length; i += 1) {
    for (let j = i + 1; j < topSingles.length; j += 1) {
      const a = topSingles[i];
      const b = topSingles[j];
      if (a.rule_complexity !== 'single_predicate' || b.rule_complexity !== 'single_predicate') continue;
      if ((a.features ?? []).some((feature) => (b.features ?? []).includes(feature))) continue;
      candidates.push({
        name: `${a.rule_name} AND ${b.rule_name}`,
        predicate: (trade) => a.predicate_source(trade) && b.predicate_source(trade),
        features: [...new Set([...(a.features ?? []), ...(b.features ?? [])])],
        rule: { type: 'two_predicate_conjunction', predicates: [a.rule, b.rule] },
      });
    }
  }
  return candidates;
}

function evaluateCandidate(candidate, complexity) {
  const affected = trades.filter(candidate.predicate);
  const affectedSet = new Set(affected.map((trade) => trade.trade_id));
  const actualNet = sum(trades.map(net));
  const counterfactualPnls = trades.map((trade) => affectedSet.has(trade.trade_id) ? 0 : net(trade));
  const counterfactualNet = sum(counterfactualPnls);
  const byExitClass = {};
  for (const [key, rows] of Object.entries(classes)) byExitClass[key] = classImpact(rows, affectedSet);
  const grossProfit = sum(counterfactualPnls.filter((value) => value > 0));
  const grossLoss = -sum(counterfactualPnls.filter((value) => value < 0));
  const concentration = sessionConcentration(affected);
  const targetDamage = Math.max(0, -byExitClass.target.net_delta_cents);
  const maxAdverseImprovement = byExitClass.max_adverse_r.net_delta_cents;
  const totalPositiveImprovement = sum(Object.values(byExitClass).map((row) => Math.max(0, row.net_delta_cents)));
  return {
    rule_name: candidate.name,
    rule: candidate.rule,
    rule_complexity: complexity,
    features: candidate.features,
    predicate_source: candidate.predicate,
    affected_trades: affected.length,
    affected_winners: affected.filter((trade) => net(trade) > 0).length,
    affected_losers: affected.filter((trade) => net(trade) < 0).length,
    actual_net_pnl_cents: actualNet,
    counterfactual_net_pnl_cents: counterfactualNet,
    net_delta_cents: counterfactualNet - actualNet,
    gross_profit_cents_proxy: grossProfit,
    gross_loss_cents_proxy: grossLoss,
    profit_factor_proxy: grossLoss === 0 ? null : round(grossProfit / grossLoss, 6),
    break_even_gap_coverage_pct: pct(counterfactualNet - actualNet, breakEvenGapCents),
    pf_pass_loss_reduction_gap_coverage_pct: pct(counterfactualNet - actualNet, pfPassLossReductionGapCents),
    max_adverse_loss_avoided_cents: maxAdverseImprovement,
    target_damage_cents: targetDamage,
    stop_loss_effect_cents: byExitClass.stop_loss.net_delta_cents,
    spread_fail_safe_effect_cents: byExitClass.spread_fail_safe.net_delta_cents,
    session_close_effect_cents: byExitClass.session_close.net_delta_cents,
    total_positive_improvement_cents: totalPositiveImprovement,
    by_exit_class: byExitClass,
    session_concentration: concentration,
    fragility: fragility(concentration),
  };
}

function classImpact(rows, affectedSet) {
  const affectedRows = rows.filter((trade) => affectedSet.has(trade.trade_id));
  const actualNet = sum(rows.map(net));
  const affectedNet = sum(affectedRows.map(net));
  const netDelta = -affectedNet;
  return {
    total: rows.length,
    affected: affectedRows.length,
    affected_winners: affectedRows.filter((trade) => net(trade) > 0).length,
    affected_losers: affectedRows.filter((trade) => net(trade) < 0).length,
    affected_actual_net_pnl_cents: affectedNet,
    actual_net_pnl_cents: actualNet,
    counterfactual_net_pnl_cents: actualNet - affectedNet,
    net_delta_cents: netDelta,
    avg_delta_per_affected_cents: affectedRows.length ? round(netDelta / affectedRows.length, 2) : 0,
  };
}

function decide(bestSingle, bestTwo, bestOverall) {
  if (!bestOverall) return { decision: 'EVIDENCE_STILL_INSUFFICIENT', basis: 'no candidate rules were generated' };
  const best = bestOverall;
  if (best.net_delta_cents < breakEvenGapCents) {
    return { decision: 'NO_ENTRY_VARIANT_JUSTIFIED', basis: `best candidate improves net PnL by ${best.net_delta_cents} cents, below the ${breakEvenGapCents} cent break-even bar`, selected_rule: summarizeRule(best) };
  }
  if (best.affected_trades / trades.length > 0.75) {
    return { decision: 'NO_ENTRY_VARIANT_JUSTIFIED', basis: `best candidate clears break-even only by filtering ${best.affected_trades}/${trades.length} trades; this is strategy suppression, not a targeted max-adverse entry filter`, selected_rule: summarizeRule(best) };
  }
  if (best.fragility.fragile) {
    return { decision: 'NO_ENTRY_VARIANT_JUSTIFIED', basis: 'best candidate clears break-even but is session-fragile under top-session concentration guardrails', selected_rule: summarizeRule(best) };
  }
  if (best.rule_complexity === 'two_predicate') {
    const increment = incrementalValue(bestSingle, bestTwo);
    if (!increment.meets_20pct_incremental_bar) {
      return { decision: 'NO_ENTRY_VARIANT_JUSTIFIED', basis: 'best two-predicate candidate does not add enough value over the best single-predicate rule', selected_rule: summarizeRule(best) };
    }
  }
  if (best.target_damage_cents > Math.max(0, best.max_adverse_loss_avoided_cents)) {
    return { decision: 'NO_ENTRY_VARIANT_JUSTIFIED', basis: 'target damage dominates max-adverse loss avoidance', selected_rule: summarizeRule(best) };
  }
  return { decision: 'ENTRY_FILTER_VARIANT_SCOPE_JUSTIFIED', basis: 'simple entry-only candidate clears break-even with acceptable target damage and concentration', selected_rule: summarizeRule(best) };
}

function recommendation(decision) {
  if (decision.decision === 'ENTRY_FILTER_VARIANT_SCOPE_JUSTIFIED') return 'Scope a separate registered-inactive entry-filter variant ticket; do not mutate v3 directly and do not create authority.';
  if (decision.decision === 'EVIDENCE_STILL_INSUFFICIENT') return 'Extend evidence or rerun diagnostics only if a specific missing pre-entry field is identified.';
  return 'No entry-filter variant is justified from current pre-entry evidence; keep v3 registered-inactive and avoid further entry tuning unless new evidence is introduced.';
}

function entryFieldAvailability() {
  const fields = {
    'signed_shock_vwap': (trade) => trade.signed_shock_vwap,
    'signed_shock_vwap.value': (trade) => num(trade.signed_shock_vwap?.value),
    'signed_shock_vwap_recent_values': (trade) => Array.isArray(trade.signed_shock_vwap_recent_values) ? trade.signed_shock_vwap_recent_values : null,
    'recent_shock.latest': recentLatest,
    'vix_value': (trade) => num(trade.vix_value),
    'vix_fresh': (trade) => typeof trade.vix_fresh === 'boolean' ? trade.vix_fresh : null,
    'vix_prior_close_percentile': (trade) => num(trade.vix_prior_close_percentile),
    'session_id': (trade) => trade.session_id,
    'entry_ts_ns': (trade) => trade.entry_ts_ns,
    'entry_hour_utc': entryHourUtc,
    'spread_bucket': (trade) => trade.spread_bucket,
    'queue_ahead_bucket': (trade) => trade.queue_ahead_bucket,
    'regime': (trade) => trade.regime,
    'entry_price': (trade) => num(trade.entry_price),
  };
  return Object.fromEntries(Object.entries(fields).map(([name, getter]) => {
    const present = trades.filter((trade) => {
      const value = getter(trade);
      if (Array.isArray(value)) return value.length > 0;
      return value !== null && value !== undefined && !(typeof value === 'number' && !Number.isFinite(value));
    }).length;
    return [name, { present, missing: trades.length - present, coverage_pct: pct(present, trades.length) }];
  }));
}

function winnerLoserByExitClass() {
  const result = {};
  for (const [name, rows] of Object.entries(classes)) {
    result[name] = {
      total: rows.length,
      winners: rows.filter((trade) => net(trade) > 0).length,
      losers: rows.filter((trade) => net(trade) < 0).length,
      flat: rows.filter((trade) => net(trade) === 0).length,
      net_pnl_cents: sum(rows.map(net)),
    };
  }
  return result;
}

function vixFreshBreakdown() {
  const result = { all_trades: boolBreakdown(trades, (trade) => trade.vix_fresh) };
  for (const [name, rows] of Object.entries(classes)) result[name] = boolBreakdown(rows, (trade) => trade.vix_fresh);
  return result;
}

function entryDistributions() {
  const metrics = {
    'signed_shock_vwap.value': (trade) => num(trade.signed_shock_vwap?.value),
    'recent_shock.latest': recentLatest,
    'recent_shock.mean_last_3': (trade) => meanRecent(trade, 3),
    'recent_shock.mean_last_5': (trade) => meanRecent(trade, 5),
    'vix_value': (trade) => num(trade.vix_value),
    'vix_prior_close_percentile': (trade) => num(trade.vix_prior_close_percentile),
    'entry_hour_utc': entryHourUtc,
  };
  const result = {};
  for (const [field, getter] of Object.entries(metrics)) {
    result[field] = {};
    for (const [name, rows] of Object.entries(classes)) result[field][name] = metric(rows.map(getter));
  }
  return result;
}

function boolBreakdown(rows, getter) {
  const trueCount = rows.filter((trade) => getter(trade) === true).length;
  const falseCount = rows.filter((trade) => getter(trade) === false).length;
  return { total: rows.length, true: trueCount, false: falseCount, missing: rows.length - trueCount - falseCount };
}

function sessionConcentration(affected) {
  const deltas = new Map();
  for (const trade of affected) {
    const key = trade.session_id ?? 'missing';
    deltas.set(key, (deltas.get(key) ?? 0) + Math.max(0, -net(trade)));
  }
  const rows = [...deltas.entries()].map(([key, positive_improvement_cents]) => ({ key, positive_improvement_cents })).sort((a, b) => b.positive_improvement_cents - a.positive_improvement_cents);
  const total = sum(rows.map((row) => row.positive_improvement_cents));
  for (const row of rows) row.pct_of_positive_improvement = pct(row.positive_improvement_cents, total);
  return {
    field: 'session_id',
    total_positive_improvement_cents: total,
    top1_pct: rows[0]?.pct_of_positive_improvement ?? 0,
    top3_pct: pct(sum(rows.slice(0, 3).map((row) => row.positive_improvement_cents)), total),
    top10_pct: pct(sum(rows.slice(0, 10).map((row) => row.positive_improvement_cents)), total),
    top_rows: rows.slice(0, 10),
  };
}

function fragility(concentration) {
  const fragile = concentration.top1_pct > 40 || concentration.top3_pct > 70;
  return { fragile, reason: fragile ? 'top1_gt_40pct_or_top3_gt_70pct' : 'not_session_fragile', top1_pct: concentration.top1_pct, top3_pct: concentration.top3_pct };
}

function incrementalValue(bestSingle, bestTwo) {
  if (!bestSingle || !bestTwo) return { best_single_delta_cents: bestSingle?.net_delta_cents ?? null, best_two_predicate_delta_cents: bestTwo?.net_delta_cents ?? null, incremental_delta_cents: null, incremental_pct_of_best_single: null, meets_20pct_incremental_bar: false };
  const incremental = bestTwo.net_delta_cents - bestSingle.net_delta_cents;
  const incrementalPct = bestSingle.net_delta_cents > 0 ? pct(incremental, bestSingle.net_delta_cents) : null;
  return {
    best_single_delta_cents: bestSingle.net_delta_cents,
    best_two_predicate_delta_cents: bestTwo.net_delta_cents,
    incremental_delta_cents: incremental,
    incremental_pct_of_best_single: incrementalPct,
    meets_20pct_incremental_bar: incrementalPct !== null && incrementalPct >= 20,
  };
}

function markdown(data) {
  const lines = [
    '# CYCLE4-R1-V3-MAX-ADVERSE-R-ENTRY-DIAGNOSTIC-01',
    '',
    '## Source',
    '',
    `- Source artifact: \`${sourcePath}\``,
    `- SHA-256: \`${sourceSha}\``,
    `- Schema version: \`${artifact.schema_version}\``,
    '',
    '## Decision',
    '',
    `- Decision: \`${data.decision_output.decision}\``,
    `- Basis: ${data.decision_output.basis}`,
    '',
    '## Anchor reconciliation',
    '',
    `- Status: \`${data.anchor_reconciliation.status}\``,
    `- Total trades: \`${data.anchor_reconciliation.actual.total_trades}\``,
    `- Max-adverse-R fail-safes: \`${data.anchor_reconciliation.actual.max_adverse_r}\``,
    `- Target exits: \`${data.anchor_reconciliation.actual.target}\``,
    `- Stop-loss exits: \`${data.anchor_reconciliation.actual.stop_loss}\``,
    `- Net PnL cents: \`${data.anchor_reconciliation.actual.net_pnl_cents}\``,
    '',
    '## Within-exit-class winners and losers',
    '',
    '| Class | Total | Winners | Losers | Net PnL cents |',
    '|---|---:|---:|---:|---:|',
  ];
  for (const [name, row] of Object.entries(data.within_exit_class_winner_loser)) lines.push(`| ${name} | ${row.total} | ${row.winners} | ${row.losers} | ${row.net_pnl_cents} |`);
  lines.push('', '## Best single-predicate candidate', '', candidateTable([data.best_single_predicate_candidate]), '', '## Best two-predicate candidate', '', candidateTable([data.best_two_predicate_candidate]), '', '## Top single-predicate candidates', '', candidateTable(data.top_single_predicate_candidates.slice(0, 10)), '', '## Top two-predicate candidates', '', candidateTable(data.top_two_predicate_candidates.slice(0, 10)), '', '## VIX freshness', '', '| Class | True | False | Missing |', '|---|---:|---:|---:|');
  for (const [name, row] of Object.entries(data.vix_fresh_breakdown)) lines.push(`| ${name} | ${row.true} | ${row.false} | ${row.missing} |`);
  lines.push('', '## Recommendation', '', data.recommendation, '', '## Authority caveat', '', data.authority_caveat);
  return lines.join('\n');
}

function memo(data) {
  const bestSingle = data.best_single_predicate_candidate;
  const bestTwo = data.best_two_predicate_candidate;
  const lines = [
    '# CYCLE4-R1-V3-MAX-ADVERSE-R-ENTRY-DIAGNOSTIC-01 Memo',
    '',
    '## 1. Context',
    '',
    'This diagnostic tests whether v3 max-adverse-R losses can be filtered using only pre-entry or entry-time fields. It intentionally excludes first-minute and exit-time fields from the primary rule search, because those belong to the separate management-diagnostic lane.',
    '',
    '## 2. Source artifact provenance',
    '',
    `- Source artifact: \`${sourcePath}\``,
    `- Source SHA-256: \`${sourceSha}\``,
    `- Source schema version: \`${artifact.schema_version}\``,
    '- Source authority: evidence only; v3 remains registered-inactive.',
    '',
    '## 3. Anchor reconciliation',
    '',
    `- Status: \`${data.anchor_reconciliation.status}\``,
    `- Total trades: \`${data.anchor_reconciliation.actual.total_trades}\``,
    `- Max-adverse-R fail-safes: \`${data.anchor_reconciliation.actual.max_adverse_r}\``,
    `- Spread fail-safes: \`${data.anchor_reconciliation.actual.spread_fail_safe}\``,
    `- Target exits: \`${data.anchor_reconciliation.actual.target}\``,
    `- Stop-loss exits: \`${data.anchor_reconciliation.actual.stop_loss}\``,
    `- Session-close exits: \`${data.anchor_reconciliation.actual.session_close}\``,
    `- Net PnL cents: \`${data.anchor_reconciliation.actual.net_pnl_cents}\``,
    '',
    '## 4. Entry-field availability',
    '',
    '| Field | Present | Missing | Coverage |',
    '|---|---:|---:|---:|',
  ];
  for (const [field, row] of Object.entries(data.field_availability)) lines.push(`| ${field} | ${row.present} | ${row.missing} | ${row.coverage_pct}% |`);
  lines.push(
    '',
    '## 5. Within-exit-class winner/loss accounting',
    '',
    'Counterfactual accounting distinguishes winners and losers inside each exit class. This matters because stop-loss exits include profitable trades; they cannot be treated as uniformly bad outcomes.',
    '',
    '| Class | Total | Winners | Losers | Net PnL cents |',
    '|---|---:|---:|---:|---:|',
  );
  for (const [name, row] of Object.entries(data.within_exit_class_winner_loser)) lines.push(`| ${name} | ${row.total} | ${row.winners} | ${row.losers} | ${row.net_pnl_cents} |`);
  lines.push(
    '',
    '## 6. Best candidates',
    '',
    '### Best single-predicate candidate',
    '',
    `- Rule: \`${bestSingle.rule_name}\``,
    `- Affected trades: \`${bestSingle.affected_trades}\``,
    `- Net delta: \`${bestSingle.net_delta_cents}\` cents`,
    `- Break-even coverage: \`${bestSingle.break_even_gap_coverage_pct}%\``,
    `- PF proxy: \`${bestSingle.profit_factor_proxy}\``,
    `- Target damage: \`${bestSingle.target_damage_cents}\` cents`,
    `- Max-adverse loss avoided: \`${bestSingle.max_adverse_loss_avoided_cents}\` cents`,
    `- Session fragility: \`${bestSingle.fragility.reason}\``,
    '',
    '### Best two-predicate candidate',
    '',
    `- Rule: \`${bestTwo.rule_name}\``,
    `- Affected trades: \`${bestTwo.affected_trades}\``,
    `- Net delta: \`${bestTwo.net_delta_cents}\` cents`,
    `- Break-even coverage: \`${bestTwo.break_even_gap_coverage_pct}%\``,
    `- PF proxy: \`${bestTwo.profit_factor_proxy}\``,
    `- Target damage: \`${bestTwo.target_damage_cents}\` cents`,
    `- Max-adverse loss avoided: \`${bestTwo.max_adverse_loss_avoided_cents}\` cents`,
    `- Session fragility: \`${bestTwo.fragility.reason}\``,
    '',
    '## 7. Interpretation',
    '',
    'The strongest entry-only candidates are broad high-VIX-style filters. They can clear the break-even target in proxy accounting, but they do so by filtering most of the strategy, including a large amount of target profit. That is not a targeted max-adverse entry filter.',
    '',
    'The result is useful diagnostically: v3 performance appears concentrated in a smaller high-volatility subset, but the current evidence does not justify directly implementing a registered-inactive entry-filter variant without a more constrained hypothesis.',
    '',
    '## 8. Decision',
    '',
    `- Decision: \`${data.decision_output.decision}\``,
    `- Basis: ${data.decision_output.basis}`,
    '',
    '## 9. Recommended next step',
    '',
    data.recommendation,
    '',
    '## 10. Authority caveat',
    '',
    data.authority_caveat,
  );
  return lines.join('\n');
}

function candidateTable(rows) {
  if (!rows.length || !rows[0]) return '_None._';
  const lines = ['| Rule | Complexity | Affected | Net delta | PF proxy | Target damage | Max adverse avoided | Top1 session | Top3 session | Fragile |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---|'];
  for (const row of rows) {
    lines.push(`| ${row.rule_name} | ${row.rule_complexity} | ${row.affected_trades} | ${row.net_delta_cents} | ${row.profit_factor_proxy} | ${row.target_damage_cents} | ${row.max_adverse_loss_avoided_cents} | ${row.session_concentration.top1_pct}% | ${row.session_concentration.top3_pct}% | ${row.fragility.fragile ? 'yes' : 'no'} |`);
  }
  return lines.join('\n');
}

function numericFeature(name, getter, thresholds) { return { name, getter, thresholds }; }
function categoricalFeature(name, getter) { return { name, getter }; }
function compareCandidates(a, b) { return b.net_delta_cents - a.net_delta_cents || a.affected_trades - b.affected_trades || a.rule_name.localeCompare(b.rule_name); }
function summarizeRule(row) { return row ? { rule_name: row.rule_name, rule_complexity: row.rule_complexity, affected_trades: row.affected_trades, net_delta_cents: row.net_delta_cents, break_even_gap_coverage_pct: row.break_even_gap_coverage_pct, profit_factor_proxy: row.profit_factor_proxy, target_damage_cents: row.target_damage_cents, max_adverse_loss_avoided_cents: row.max_adverse_loss_avoided_cents, fragility: row.fragility } : null; }
function reason(trade) { return trade.exits[0]?.management_action_reason ?? null; }
function net(trade) { return num(trade.net_pnl_cents) ?? 0; }
function num(value) { if (value === null || value === undefined) return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function sum(values) { return values.reduce((acc, value) => acc + (value ?? 0), 0); }
function avg(values) { const finiteValues = values.filter(finite); return finiteValues.length ? sum(finiteValues) / finiteValues.length : null; }
function round(value, digits = 0) { if (!finite(value)) return null; const factor = 10 ** digits; const output = Math.round(value * factor) / factor; return Object.is(output, -0) ? 0 : output; }
function pct(part, whole) { return whole ? round((part / whole) * 100, 2) : 0; }
function metric(values) { const finiteValues = values.filter(finite).sort((a, b) => a - b); return { count: finiteValues.length, missing: values.length - finiteValues.length, min: finiteValues.length ? round(finiteValues[0], 4) : null, p25: quantile(finiteValues, 0.25), median: quantile(finiteValues, 0.5), p75: quantile(finiteValues, 0.75), max: finiteValues.length ? round(finiteValues[finiteValues.length - 1], 4) : null, avg: round(avg(finiteValues), 4) }; }
function quantile(values, p) { if (!values.length) return null; const idx = (values.length - 1) * p; const lo = Math.floor(idx); const hi = Math.ceil(idx); const weight = idx - lo; return lo === hi ? round(values[lo], 4) : round(values[lo] * (1 - weight) + values[hi] * weight, 4); }
function quantiles(values, ps) { const finiteValues = values.filter(finite).sort((a, b) => a - b); return ps.map((p) => quantile(finiteValues, p)).filter(finite); }
function uniqueNumbers(values) { return [...new Set(values.filter(finite).map((value) => round(value, 6)))].sort((a, b) => a - b); }
function uniqueStrings(values) { return [...new Set(values.filter((value) => value !== null && value !== undefined).map(String))].sort(); }
function fmt(value) { return Number.isInteger(value) ? String(value) : String(round(value, 6)); }
function recentValues(trade) { return Array.isArray(trade.signed_shock_vwap_recent_values) ? trade.signed_shock_vwap_recent_values.map(num).filter(finite) : []; }
function recentLatest(trade) { const values = recentValues(trade); return values.length ? values[values.length - 1] : null; }
function meanRecent(trade, count) { const values = recentValues(trade).slice(-count); return values.length === count ? avg(values) : null; }
function minRecent(trade, count) { const values = recentValues(trade).slice(-count); return values.length === count ? Math.min(...values) : null; }
function maxRecent(trade, count) { const values = recentValues(trade).slice(-count); return values.length === count ? Math.max(...values) : null; }
function slopeRecent(trade, count) { const values = recentValues(trade).slice(-count); return values.length === count ? values[values.length - 1] - values[0] : null; }
function entryHourUtc(trade) { if (!trade.entry_ts_ns) return null; const ms = Number(BigInt(trade.entry_ts_ns) / 1000000n); return new Date(ms).getUTCHours(); }
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sortJson(value) { if (Array.isArray(value)) return value.map(sortJson); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).filter((key) => key !== 'predicate_source').sort().map((key) => [key, sortJson(value[key])])); return value; }
