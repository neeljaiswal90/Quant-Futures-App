import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ticket = 'CYCLE4-R1-V3-EARLY-ADVERSE-DIAGNOSTIC-02';
const runId = 'cycle4-r1-v3-early-adverse-diagnostic-02';
const strategyId = 'regime_shock_reversion_short_v3';
const sourceArtifact = `artifacts/held-out-validation/${runId}/${strategyId}-feb-mar-apr-2026.json`;
const lockManifest = 'artifacts/strategy-selection/qfa611-cycle4-r1-v3-early-adverse-diagnostic-02-parameter-locks.json';
const metadata = 'config/research/cycle4-r1-v3-early-adverse-diagnostic-02-metadata.json';
const outRoot = process.env.EAD2_OUT_DIR ?? `artifacts/research/${runId}`;
const outJson = join(outRoot, 'v3-early-adverse-diagnostic.json');
const outMd = join(outRoot, 'v3-early-adverse-diagnostic.md');

const expected = {
  total_trades: 889,
  max_adverse_r_fail_safes: 245,
  target_exits: 259,
  stop_loss_exits: 363,
  spread_fail_safes: 17,
  session_close_exits: 5,
  total_net_pnl_cents: -102600,
};

const artifactBytes = readFileSync(sourceArtifact);
const artifact = JSON.parse(artifactBytes.toString('utf8'));
assertArtifactShape(artifact);

const classes = {
  max_adverse_r: artifact.trades.filter((trade) => onlyExit(trade).management_action_reason === 'fail_safe:max_adverse_r_exceeded'),
  target: artifact.trades.filter((trade) => trade.exit_reason === 'target'),
  stop_loss: artifact.trades.filter((trade) => trade.exit_reason === 'stop_loss'),
  spread_fail_safe: artifact.trades.filter((trade) => onlyExit(trade).management_action_reason === 'fail_safe:max_spread_ticks_exceeded'),
  session_close: artifact.trades.filter((trade) => trade.exit_reason === 'session_close'),
};

const anchors = anchorReconciliation();
if (anchors.status !== 'matched') {
  throw new Error(`anchor mismatch: ${JSON.stringify(anchors)}`);
}

const candidates = candidateSeparators();
const bestPreEntry = candidates.find((row) => row.actionability === 'pre-entry' && row.max_adverse_capture_count > 0) ?? null;
const bestEarlyPostEntry = candidates.find((row) => row.actionability === 'early-post-entry' && row.max_adverse_capture_count > 0) ?? null;
const variantDecision = decideVariant(bestPreEntry, bestEarlyPostEntry);

const diagnostic = sortJson({
  schema_version: 1,
  ticket,
  source_artifacts: {
    held_out_artifact: {
      path: sourceArtifact,
      sha256: sha256Bytes(artifactBytes),
      strategy_id: artifact.strategy_id,
      parameter_lock_hash: artifact.parameter_lock_hash,
      input_substrate_hash: artifact.input_substrate_hash,
      input_manifest_hashes: artifact.input_manifest_hashes,
    },
    lock_manifest: { path: lockManifest, sha256: sha256File(lockManifest) },
    metadata: { path: metadata, sha256: sha256File(metadata) },
  },
  evidence_hierarchy: 'diagnostic JSON/MD are derived only from the regenerated PR #273-schema held-out artifact; prior artifacts are anchors only',
  anchor_reconciliation: anchors,
  class_definitions: {
    primary_negative_class: 'exit_reason=fail_safe and exits[].management_action_reason=fail_safe:max_adverse_r_exceeded',
    primary_positive_class: 'exit_reason=target',
    secondary_comparison_classes: ['stop_loss', 'fail_safe:max_spread_ticks_exceeded', 'session_close'],
  },
  extended_field_availability: fieldAvailability(),
  negative_vs_positive_class_summary: classSummaries({ max_adverse_r: classes.max_adverse_r, target: classes.target }),
  all_class_summaries: classSummaries(classes),
  signed_shock_findings: {
    value: metricComparison(signedShockValue),
    sigma_basis_value: metricComparison((trade) => finiteOrNull(trade.signed_shock_vwap?.sigma_basis_value)),
    buckets: bucketComparison((trade) => signedShockBucket(signedShockValue(trade))),
  },
  recent_signed_shock_findings: {
    recent_count: metricComparison((trade) => recentValues(trade).length),
    latest_value: metricComparison(recentLatest),
    previous_value: metricComparison(recentPrevious),
    latest_minus_previous: metricComparison((trade) => both(recentLatest(trade), recentPrevious(trade), (left, right) => left - right)),
    last3_mean: metricComparison(recentLast3Mean),
    last3_min: metricComparison(recentLast3Min),
    last3_all_above_2_rate: rateComparison((trade) => lastN(trade, 3).length === 3 && lastN(trade, 3).every((value) => value >= 2)),
  },
  vix_findings: {
    vix_value: metricComparison((trade) => finiteOrNull(trade.vix_value)),
    vix_fresh_rate: rateComparison((trade) => trade.vix_fresh === true),
    vix_prior_close_percentile: metricComparison((trade) => finiteOrNull(trade.vix_prior_close_percentile)),
    vix_value_buckets: bucketComparison((trade) => vixValueBucket(trade.vix_value)),
    vix_percentile_buckets: bucketComparison((trade) => vixPercentileBucket(trade.vix_prior_close_percentile)),
  },
  first_minute_path_findings: {
    observed_rate: rateComparison((trade) => trade.first_minute_observed === true),
    max_adverse_excursion_cents: metricComparison(firstMinuteMae),
    max_favorable_excursion_cents: metricComparison(firstMinuteMfe),
    close_pnl_cents: metricComparison(firstMinuteClose),
    adverse_buckets: bucketComparison((trade) => firstMinuteAdverseBucket(firstMinuteMae(trade))),
    close_pnl_buckets: bucketComparison((trade) => firstMinuteCloseBucket(firstMinuteClose(trade))),
  },
  adverse_r_at_exit_findings: {
    max_adverse_r_fail_safes: metricSummary(classes.max_adverse_r.map(adverseRAtExit)),
    spread_fail_safes: metricSummary(classes.spread_fail_safe.map(adverseRAtExit)),
    max_adverse_r_buckets: bucketRows(classes.max_adverse_r, (trade) => adverseRBucket(adverseRAtExit(trade))),
  },
  spread_queue_regime_session_findings: {
    spread_bucket: bucketComparison((trade) => trade.spread_bucket ?? 'missing'),
    queue_ahead_bucket: bucketComparison((trade) => trade.queue_ahead_bucket ?? 'missing'),
    regime: bucketComparison((trade) => trade.regime ?? 'missing'),
    top_sessions: Object.fromEntries(Object.entries(classes).map(([key, rows]) => [key, bucketRows(rows, (trade) => trade.session_id, 8)])),
  },
  candidate_separator_table: candidates,
  variant_justification_decision: variantDecision,
  break_even_tradeoff: breakEvenTradeoff(),
  evidence_gaps: [
    'primary_percentile and vxn_percentile remain unavailable as first-class per-trade fields',
    'first-minute fields are causal but not pre-entry; any use would require a separate management/variant design ticket',
    'candidate separators are diagnostic screens, not causal proof and not authorization',
  ],
  recommendations: recommendations(variantDecision),
});

mkdirSync(outRoot, { recursive: true });
writeFileSync(outJson, `${JSON.stringify(diagnostic)}\n`, 'utf8');
writeFileSync(outMd, `${markdown(diagnostic)}\n`, 'utf8');
console.log(JSON.stringify({
  source_artifact_sha: diagnostic.source_artifacts.held_out_artifact.sha256,
  lock_manifest_sha: diagnostic.source_artifacts.lock_manifest.sha256,
  metadata_sha: diagnostic.source_artifacts.metadata.sha256,
  diagnostic_json: outJson,
  diagnostic_md: outMd,
  anchor_status: diagnostic.anchor_reconciliation.status,
  best_pre_entry_candidate: bestPreEntry,
  best_early_post_entry_candidate: bestEarlyPostEntry,
  variant_decision: diagnostic.variant_justification_decision.decision,
}, null, 2));

function assertArtifactShape(payload) {
  if (payload.schema_version !== 1) throw new Error(`expected schema_version 1, got ${payload.schema_version}`);
  if (payload.strategy_id !== strategyId) throw new Error(`expected ${strategyId}, got ${payload.strategy_id}`);
  for (const trade of payload.trades) {
    for (const field of [
      'vix_value',
      'vix_fresh',
      'vix_prior_close_percentile',
      'signed_shock_vwap',
      'signed_shock_vwap_recent_values',
      'first_minute_max_favorable_excursion_cents',
      'first_minute_max_adverse_excursion_cents',
      'first_minute_close_pnl_cents',
      'first_minute_observed',
    ]) {
      if (!(field in trade)) throw new Error(`missing ${field} on ${trade.trade_id}`);
    }
    if (trade.entry_quantity !== 1 || trade.exit_quantity !== 1) {
      throw new Error(`non-standard sizing on ${trade.trade_id}`);
    }
    for (const exit of trade.exits ?? []) {
      if (exit.management_action_reason === 'fail_safe:max_adverse_r_exceeded') {
        const adverseR = exit.fail_safe_context?.adverse_r_at_exit;
        if (typeof adverseR !== 'number' || !Number.isFinite(adverseR)) {
          throw new Error(`missing finite adverse_r_at_exit on ${trade.trade_id}`);
        }
      }
    }
  }
}

function anchorReconciliation() {
  const actual = {
    total_trades: artifact.trades.length,
    max_adverse_r_fail_safes: classes.max_adverse_r.length,
    target_exits: classes.target.length,
    stop_loss_exits: classes.stop_loss.length,
    spread_fail_safes: classes.spread_fail_safe.length,
    session_close_exits: classes.session_close.length,
    total_net_pnl_cents: sum(artifact.trades.map(netPnl)),
    single_contract_replay: artifact.trades.every((trade) => trade.entry_quantity === 1 && trade.exit_quantity === 1),
  };
  const mismatches = Object.entries(expected)
    .filter(([key, value]) => actual[key] !== value)
    .map(([key]) => key);
  if (actual.single_contract_replay !== true) mismatches.push('single_contract_replay');
  return { status: mismatches.length === 0 ? 'matched' : 'mismatch', expected, actual, mismatches };
}

function fieldAvailability() {
  const fields = [
    ['vix_value', (trade) => trade.vix_value, 'pre-entry'],
    ['vix_fresh', (trade) => trade.vix_fresh, 'pre-entry'],
    ['vix_prior_close_percentile', (trade) => trade.vix_prior_close_percentile, 'pre-entry'],
    ['signed_shock_vwap', (trade) => trade.signed_shock_vwap, 'pre-entry'],
    ['signed_shock_vwap.value', signedShockValue, 'pre-entry'],
    ['signed_shock_vwap_recent_values', (trade) => trade.signed_shock_vwap_recent_values, 'pre-entry'],
    ['first_minute_max_favorable_excursion_cents', (trade) => trade.first_minute_max_favorable_excursion_cents, 'early-post-entry'],
    ['first_minute_max_adverse_excursion_cents', (trade) => trade.first_minute_max_adverse_excursion_cents, 'early-post-entry'],
    ['first_minute_close_pnl_cents', (trade) => trade.first_minute_close_pnl_cents, 'early-post-entry'],
    ['first_minute_observed', (trade) => trade.first_minute_observed, 'early-post-entry'],
    ['exits[].fail_safe_context.adverse_r_at_exit', adverseRAtExit, 'exit-context'],
  ];
  return fields.map(([field, getter, actionability]) => {
    const present = artifact.trades.filter((trade) => isPresent(getter(trade))).length;
    const maxPresent = classes.max_adverse_r.filter((trade) => isPresent(getter(trade))).length;
    const targetPresent = classes.target.filter((trade) => isPresent(getter(trade))).length;
    return {
      field,
      actionability,
      total_present: present,
      total_population_rate: pct(present, artifact.trades.length),
      max_adverse_present: maxPresent,
      max_adverse_population_rate: pct(maxPresent, classes.max_adverse_r.length),
      target_present: targetPresent,
      target_population_rate: pct(targetPresent, classes.target.length),
    };
  });
}

function classSummaries(input) {
  return Object.entries(input).map(([key, rows]) => ({
    class: key,
    count: rows.length,
    net_pnl_cents: sum(rows.map(netPnl)),
    avg_net_pnl_cents: round(avg(rows.map(netPnl)), 2),
    median_net_pnl_cents: percentile(rows.map(netPnl), 0.5),
    median_hold_minutes: percentile(rows.map(holdMinutes), 0.5, 4),
    under_2_minutes_count: rows.filter((trade) => holdMinutes(trade) < 2).length,
    under_2_minutes_pct: pct(rows.filter((trade) => holdMinutes(trade) < 2).length, rows.length),
    median_mae_cents: percentile(rows.map(maeCents), 0.5),
    median_mfe_cents: percentile(rows.map(mfeCents), 0.5),
    first_minute_observed_count: rows.filter((trade) => trade.first_minute_observed).length,
    first_minute_observed_pct: pct(rows.filter((trade) => trade.first_minute_observed).length, rows.length),
  }));
}

function candidateSeparators() {
  const rows = [];
  const add = (feature, rule, actionability, predicate, notes) => rows.push(candidate(feature, rule, actionability, predicate, notes));
  for (const threshold of [1.75, 2, 2.25, 2.5, 2.75, 3]) {
    add('signed_shock_vwap.value', `value >= ${threshold}`, 'pre-entry', (trade) => gte(signedShockValue(trade), threshold), 'entry-time signed-shock strength threshold');
    add('signed_shock_vwap.value', `value < ${threshold}`, 'pre-entry', (trade) => lt(signedShockValue(trade), threshold), 'entry-time signed-shock lower-bound threshold');
  }
  for (const threshold of [1.5, 1.75, 2, 2.25, 2.5]) {
    add('recent_signed_shock.last3_mean', `last3_mean >= ${threshold}`, 'pre-entry', (trade) => gte(recentLast3Mean(trade), threshold), 'entry-time recent shock persistence proxy');
  }
  for (const threshold of [18, 20, 22, 24]) {
    add('vix_value', `vix_value >= ${threshold}`, 'pre-entry', (trade) => gte(finiteOrNull(trade.vix_value), threshold), 'entry-time VIX value threshold');
  }
  for (const threshold of [0.25, 0.5, 0.67, 0.85]) {
    add('vix_prior_close_percentile', `percentile >= ${threshold}`, 'pre-entry', (trade) => gte(finiteOrNull(trade.vix_prior_close_percentile), threshold), 'prior-close VIX percentile threshold');
    add('vix_prior_close_percentile', `percentile < ${threshold}`, 'pre-entry', (trade) => lt(finiteOrNull(trade.vix_prior_close_percentile), threshold), 'prior-close VIX percentile threshold');
  }
  for (const bucket of ['0 ticks', '1 tick', '2 ticks', '3+ ticks']) {
    add('spread_bucket', `spread_bucket == ${bucket}`, 'pre-entry', (trade) => trade.spread_bucket === bucket, 'entry spread bucket if serialized bucket is entry-time context');
  }
  for (const bucket of ['0', '1-5', '6-10', '11+']) {
    add('queue_ahead_bucket', `queue_ahead_bucket == ${bucket}`, 'pre-entry', (trade) => trade.queue_ahead_bucket === bucket, 'entry queue bucket if serialized bucket is entry-time context');
  }
  for (const threshold of [-400, -800, -1200, -1600, -2000]) {
    add('first_minute_max_adverse_excursion_cents', `first_minute_MAE <= ${threshold}`, 'early-post-entry', (trade) => lte(firstMinuteMae(trade), threshold), 'causal first-minute marker; would require separate management design');
  }
  for (const threshold of [-400, -800, -1200]) {
    add('first_minute_close_pnl_cents', `first_minute_close_pnl <= ${threshold}`, 'early-post-entry', (trade) => lte(firstMinuteClose(trade), threshold), 'causal first-minute close marker; not pre-entry');
  }
  return rows.sort((left, right) => right.net_vs_targets_only_cents - left.net_vs_targets_only_cents || right.max_adverse_capture_count - left.max_adverse_capture_count);
}

function candidate(feature, rule, actionability, predicate, notes) {
  const maxHit = classes.max_adverse_r.filter(predicate);
  const targetHit = classes.target.filter(predicate);
  const stopHit = classes.stop_loss.filter(predicate);
  const spreadHit = classes.spread_fail_safe.filter(predicate);
  const avoided = -sum(maxHit.map(netPnl));
  const targetRisk = sum(targetHit.map(netPnl));
  const net = round(avoided - targetRisk);
  return {
    feature,
    rule,
    actionability,
    max_adverse_capture_count: maxHit.length,
    max_adverse_capture_pct: pct(maxHit.length, classes.max_adverse_r.length),
    target_at_risk_count: targetHit.length,
    target_at_risk_pct: pct(targetHit.length, classes.target.length),
    stop_loss_removed_count: stopHit.length,
    spread_fail_safe_removed_count: spreadHit.length,
    avoided_max_adverse_loss_cents: round(avoided),
    target_profit_at_risk_cents: targetRisk,
    net_vs_targets_only_cents: net,
    break_even_gap_covered_pct: pct(net, 102600),
    confidence: actionability === 'early-post-entry'
      ? 'diagnostic-only; causal but would change management semantics'
      : maxHit.length === 0
        ? 'low; captures no max-adverse trades'
        : targetHit.length > maxHit.length
          ? 'low; winner-filter risk dominates count'
          : 'medium; requires separate replay before any variant',
    notes,
  };
}

function decideVariant(bestPreEntry, bestEarly) {
  if (bestPreEntry && bestPreEntry.net_vs_targets_only_cents >= 102600 && bestPreEntry.max_adverse_capture_count >= 44 && bestPreEntry.target_at_risk_count <= Math.floor(bestPreEntry.max_adverse_capture_count * 0.75)) {
    return {
      decision: 'candidate_registered_inactive_entry_variant_may_be_justified_for_coord_review',
      basis: 'best pre-entry separator clears the break-even screen, but needs a separate implementation packet and replay; no authority follows',
      best_pre_entry_candidate: bestPreEntry,
      best_early_post_entry_candidate: bestEarly,
    };
  }
  if (bestEarly && bestEarly.net_vs_targets_only_cents >= 102600 && bestEarly.max_adverse_capture_count >= 44) {
    return {
      decision: 'candidate_causal_early_post_entry_management_diagnostic_may_be_justified_for_coord_review',
      basis: 'best separator is early-post-entry rather than pre-entry; any use changes management semantics and cannot be treated as an entry filter',
      best_pre_entry_candidate: bestPreEntry,
      best_early_post_entry_candidate: bestEarly,
    };
  }
  return {
    decision: 'no_registered_inactive_variant_justified_from_current_separators',
    basis: 'no separator satisfies clear separation, winner-filter risk, break-even impact, causal actionability, and no-lookahead criteria together',
    best_pre_entry_candidate: bestPreEntry,
    best_early_post_entry_candidate: bestEarly,
  };
}

function recommendations(decision) {
  if (decision.decision === 'candidate_registered_inactive_entry_variant_may_be_justified_for_coord_review') {
    return [
      'Route a coordinator-reviewed registered-inactive entry-variant scoping ticket for the best pre-entry separator only.',
      'Do not mutate v3 directly; preserve winner-filter risk and break-even math in the next packet.',
      'No activation, paper observation, broker/live dispatch, or Phase 6 authority follows.',
    ];
  }
  if (decision.decision === 'candidate_causal_early_post_entry_management_diagnostic_may_be_justified_for_coord_review') {
    return [
      'Route a coordinator-reviewed early-post-entry management diagnostic/scoping ticket rather than an entry-filter variant.',
      'Do not tune max_adverse_r directly from this evidence; first-minute markers require separate management design.',
      'No activation, paper observation, broker/live dispatch, or Phase 6 authority follows.',
    ];
  }
  return [
    'Do not create a registered-inactive variant from this diagnostic alone.',
    'If v3 work continues, route a narrower evidence or hypothesis ticket focused on the highest-ranking separator gaps rather than direct tuning.',
    'No activation, paper observation, broker/live dispatch, or Phase 6 authority follows.',
  ];
}

function breakEvenTradeoff() {
  const maxAvgLoss = -avg(classes.max_adverse_r.map(netPnl));
  const targetAvgProfit = avg(classes.target.map(netPnl));
  return {
    break_even_gap_cents: 102600,
    pf_pass_gap_cents_if_gross_profit_unchanged: 309593,
    max_adverse_avg_loss_cents: round(maxAvgLoss, 2),
    target_avg_profit_cents: round(targetAvgProfit, 2),
    max_adverse_trades_to_avoid_for_break_even_if_no_winners_lost: Math.ceil(102600 / maxAvgLoss),
    max_adverse_trades_to_avoid_for_pf_pass_if_no_winners_lost: Math.ceil(309593 / maxAvgLoss),
    note: 'PF around 1.0 is break-even only; it is not an ADR-0016 passing verdict. PF pass threshold remains 1.35.',
  };
}

function metricComparison(getter) {
  return Object.fromEntries(Object.entries(classes).map(([key, rows]) => [key, metricSummary(rows.map(getter))]));
}

function rateComparison(predicate) {
  return Object.fromEntries(Object.entries(classes).map(([key, rows]) => {
    const count = rows.filter(predicate).length;
    return [key, { count, total: rows.length, pct: pct(count, rows.length) }];
  }));
}

function bucketComparison(getter) {
  return Object.fromEntries(Object.entries(classes).map(([key, rows]) => [key, bucketRows(rows, getter)]));
}

function bucketRows(rows, getter, limit = 20) {
  const buckets = new Map();
  for (const trade of rows) {
    const bucket = getter(trade);
    const current = buckets.get(bucket) ?? { count: 0, net: 0 };
    current.count += 1;
    current.net += netPnl(trade);
    buckets.set(bucket, current);
  }
  return [...buckets.entries()]
    .map(([bucket, item]) => ({ bucket, count: item.count, pct: pct(item.count, rows.length), net_pnl_cents: item.net }))
    .sort((left, right) => right.count - left.count || String(left.bucket).localeCompare(String(right.bucket)))
    .slice(0, limit);
}

function metricSummary(values) {
  const finite = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  return {
    count: finite.length,
    missing: values.length - finite.length,
    min: finite.length ? round(Math.min(...finite), 4) : null,
    p10: percentile(finite, 0.1, 4),
    p25: percentile(finite, 0.25, 4),
    median: percentile(finite, 0.5, 4),
    p75: percentile(finite, 0.75, 4),
    p90: percentile(finite, 0.9, 4),
    max: finite.length ? round(Math.max(...finite), 4) : null,
    avg: round(avg(finite), 4),
  };
}

function markdown(data) {
  const lines = [
    '# CYCLE4-R1-V3-EARLY-ADVERSE-DIAGNOSTIC-02',
    '',
    '## Source artifact provenance',
    '',
    `- Held-out artifact: \`${sourceArtifact}\``,
    `- Artifact SHA-256: \`${data.source_artifacts.held_out_artifact.sha256}\``,
    '- Evidence hierarchy: diagnostic outputs are derived from the regenerated PR #273-schema artifact only.',
    '',
    '## Anchor reconciliation',
    '',
    `- Status: \`${data.anchor_reconciliation.status}\``,
    `- Total trades: \`${data.anchor_reconciliation.actual.total_trades}\``,
    `- Max-adverse-R fail-safes: \`${data.anchor_reconciliation.actual.max_adverse_r_fail_safes}\``,
    `- Target exits: \`${data.anchor_reconciliation.actual.target_exits}\``,
    `- Stop-loss exits: \`${data.anchor_reconciliation.actual.stop_loss_exits}\``,
    `- Spread fail-safes: \`${data.anchor_reconciliation.actual.spread_fail_safes}\``,
    `- Total net PnL cents: \`${data.anchor_reconciliation.actual.total_net_pnl_cents}\``,
    '',
    '## Class summaries',
    '',
    '| Class | Count | Net PnL cents | Avg PnL cents | Median hold min | Median MAE cents | First-minute observed |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of data.all_class_summaries) {
    lines.push(`| ${row.class} | ${row.count} | ${row.net_pnl_cents} | ${row.avg_net_pnl_cents} | ${row.median_hold_minutes} | ${row.median_mae_cents} | ${row.first_minute_observed_pct}% |`);
  }
  lines.push('', '## Top candidate separators', '');
  lines.push('| Feature | Rule | Actionability | Max-adverse captured | Targets at risk | Net vs targets only cents | Confidence |');
  lines.push('|---|---|---|---:|---:|---:|---|');
  for (const row of data.candidate_separator_table.slice(0, 12)) {
    lines.push(`| ${row.feature} | ${row.rule} | ${row.actionability} | ${row.max_adverse_capture_count} | ${row.target_at_risk_count} | ${row.net_vs_targets_only_cents} | ${row.confidence} |`);
  }
  lines.push('', '## Variant justification decision', '');
  lines.push(`- Decision: \`${data.variant_justification_decision.decision}\``);
  lines.push(`- Basis: ${data.variant_justification_decision.basis}`);
  lines.push('', '## Evidence gaps', '');
  for (const gap of data.evidence_gaps) lines.push(`- ${gap}`);
  lines.push('', '## Authority caveat', '');
  lines.push('This diagnostic does not activate v3, does not authorize paper observation, does not authorize broker/live dispatch, does not authorize Phase 6, and does not mutate ACTIVE_STRATEGY_IDS.');
  return lines.join('\n');
}

function onlyExit(trade) {
  if ((trade.exits ?? []).length !== 1) throw new Error(`expected one exit for ${trade.trade_id}`);
  return trade.exits[0];
}
function isPresent(value) { return value !== null && value !== undefined && (!Array.isArray(value) || value.length > 0); }
function netPnl(trade) { return cents(trade.net_pnl_cents); }
function maeCents(trade) { return cents(trade.max_adverse_excursion_cents); }
function mfeCents(trade) { return cents(trade.max_favorable_excursion_cents); }
function firstMinuteMae(trade) { return nullableCents(trade.first_minute_max_adverse_excursion_cents); }
function firstMinuteMfe(trade) { return nullableCents(trade.first_minute_max_favorable_excursion_cents); }
function firstMinuteClose(trade) { return nullableCents(trade.first_minute_close_pnl_cents); }
function signedShockValue(trade) { return finiteOrNull(trade.signed_shock_vwap?.value); }
function adverseRAtExit(trade) { return finiteOrNull(onlyExit(trade).fail_safe_context?.adverse_r_at_exit); }
function recentValues(trade) { return (trade.signed_shock_vwap_recent_values ?? []).filter((value) => typeof value === 'number' && Number.isFinite(value)); }
function recentLatest(trade) { const values = recentValues(trade); return values.length ? values[values.length - 1] : null; }
function recentPrevious(trade) { const values = recentValues(trade); return values.length > 1 ? values[values.length - 2] : null; }
function lastN(trade, count) { const values = recentValues(trade); return values.slice(Math.max(0, values.length - count)); }
function recentLast3Mean(trade) { const values = lastN(trade, 3); return values.length === 3 ? avg(values) : null; }
function recentLast3Min(trade) { const values = lastN(trade, 3); return values.length === 3 ? Math.min(...values) : null; }
function holdMinutes(trade) { return Number(BigInt(trade.exit_ts_ns) - BigInt(trade.entry_ts_ns)) / 60_000_000_000; }
function cents(value) { const parsed = typeof value === 'number' ? value : Number(value); if (!Number.isFinite(parsed)) throw new Error(`invalid cents ${value}`); return parsed; }
function nullableCents(value) { return value === null || value === undefined ? null : cents(value); }
function finiteOrNull(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function both(left, right, fn) { return left === null || right === null ? null : fn(left, right); }
function gte(value, threshold) { return value !== null && value >= threshold; }
function lt(value, threshold) { return value !== null && value < threshold; }
function lte(value, threshold) { return value !== null && value <= threshold; }
function sum(values) { return values.reduce((acc, value) => acc + value, 0); }
function avg(values) { return values.length ? sum(values) / values.length : Number.NaN; }
function round(value, digits = 0) { if (!Number.isFinite(value)) return 0; const factor = 10 ** digits; const out = Math.round(value * factor) / factor; return Object.is(out, -0) ? 0 : out; }
function pct(numerator, denominator) { return denominator === 0 ? 0 : round((numerator / denominator) * 100, 2); }
function percentile(values, q, digits = 0) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!finite.length) return null;
  const index = (finite.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return round(finite[lower], digits);
  return round(finite[lower] * (1 - (index - lower)) + finite[upper] * (index - lower), digits);
}
function signedShockBucket(value) { if (value === null) return 'missing'; if (value < 1.5) return '<1.5'; if (value < 2) return '1.5-2.0'; if (value < 2.5) return '2.0-2.5'; if (value < 3) return '2.5-3.0'; return '>=3.0'; }
function vixPercentileBucket(value) { if (value === null) return 'missing'; if (value < 0.25) return '<0.25'; if (value < 0.5) return '0.25-0.50'; if (value < 0.67) return '0.50-0.67'; if (value < 0.85) return '0.67-0.85'; return '>=0.85'; }
function vixValueBucket(value) { if (value === null) return 'missing'; if (value < 18) return '<18'; if (value < 20) return '18-20'; if (value < 22) return '20-22'; if (value < 24) return '22-24'; return '>=24'; }
function firstMinuteAdverseBucket(value) { if (value === null) return 'missing'; if (value <= -2000) return '<=-2000'; if (value <= -1200) return '-2000..-1200'; if (value <= -400) return '-1200..-400'; return '>-400'; }
function firstMinuteCloseBucket(value) { if (value === null) return 'missing'; if (value <= -1200) return '<=-1200'; if (value <= -400) return '-1200..-400'; if (value < 0) return '-400..0'; return '>=0'; }
function adverseRBucket(value) { if (value === null) return 'missing'; if (value < 1) return '<1'; if (value < 1.5) return '1.0-1.5'; if (value < 2) return '1.5-2.0'; if (value < 2.5) return '2.0-2.5'; return '>=2.5'; }
function sha256Bytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sha256File(path) { return sha256Bytes(readFileSync(path)); }
function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  return value;
}

