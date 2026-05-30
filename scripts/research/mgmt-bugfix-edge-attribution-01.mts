import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const ticket = 'MGMT-BUGFIX-EDGE-ATTRIBUTION-01';
const outputDir = process.env.BFA_OUT_DIR ?? 'artifacts/research/mgmt-bugfix-edge-attribution-01';
const outJson = `${outputDir}/v2-edge-attribution.json`;
const outMd = `${outputDir}/v2-edge-attribution.md`;
const memoPath = 'docs/research/mgmt-bugfix-edge-attribution-01-memo.md';
const artifactPath = 'artifacts/held-out-validation/cycle3/regime_shock_reversion_short_v2-feb-mar-apr-2026.json';
const preRef = 'e985b10';
const postRef = 'origin/main';
const expectedPreSha = 'ef268a431980b326a138707f632470b641004243a47bc2634888fad09e928703';
const expectedPostSha = 'b86b147aa5d3d3f7e43f0e5f7153f6516ff30125175f89660cc689c7469daed9';
const expected = {
  pre: { total_trades: 528, profit_factor_ppm: 1395150, net_pnl_cents: 199650, exit_reason: { target: 207, stop_loss: 317, session_close: 4, fail_safe: 0 } },
  post: { total_trades: 572, profit_factor_ppm: 973182, net_pnl_cents: -18300, exit_reason: { target: 179, stop_loss: 234, session_close: 3, fail_safe: 156 } },
};

const pre = readArtifact(preRef, expectedPreSha);
const post = readArtifact(postRef, expectedPostSha);
assertAnchors(pre, expected.pre, 'pre');
assertAnchors(post, expected.post, 'post');
const preMap = mapByEntrySide(pre.artifact.trades, 'pre');
const postMap = mapByEntrySide(post.artifact.trades, 'post');
const matchedKeys = [...preMap.keys()].filter((key) => postMap.has(key)).sort();
const preOnlyKeys = [...preMap.keys()].filter((key) => !postMap.has(key)).sort();
const postOnlyKeys = [...postMap.keys()].filter((key) => !preMap.has(key)).sort();
const matchedPairs = matchedKeys.map((key) => ({ key, pre: preMap.get(key), post: postMap.get(key) }));
const preOnly = preOnlyKeys.map((key) => preMap.get(key));
const postOnly = postOnlyKeys.map((key) => postMap.get(key));
const matrix = transitionMatrix(matchedPairs);
const winnerConversion = winnerConversionMetrics(matchedPairs);
const pathQuality = pathQualityProxy(matchedPairs);
const availability = tradeAvailability();
const waterfall = deltaWaterfall(matrix, availability);
const determination = determine(winnerConversion, pathQuality, availability, waterfall);
const output = sortJson({
  schema_version: 1,
  ticket,
  source_artifacts: {
    pre_fix: { ref: preRef, path: artifactPath, sha256: pre.sha256, anchors: sourceSummary(pre.artifact) },
    post_fix: { ref: postRef, path: artifactPath, sha256: post.sha256, anchors: sourceSummary(post.artifact) },
  },
  anchor_reconciliation: { pre_fix: anchorCheck(pre.artifact, expected.pre), post_fix: anchorCheck(post.artifact, expected.post) },
  method: {
    matched_pair_key: '(entry_ts_ns, side)',
    source_schema_limit: 'base v1 artifact lacks fail_safe subtype, per-trade risk, entry/exit price, and fail_safe_context; subtype and premature-cut classification are evidence-limited',
    post_minus_pre_delta_cents: expected.post.net_pnl_cents - expected.pre.net_pnl_cents,
  },
  trade_availability: availability,
  exit_reason_transition_matrix: matrix,
  winner_conversion: winnerConversion,
  path_quality_proxy: pathQuality,
  time_stop_attribution: timeStopAttribution(),
  spread_attribution: spreadAttribution(),
  delta_waterfall: waterfall,
  improvement_target: improvementTarget(),
  determination,
  authority_caveat: 'This ticket changes no engine, strategy, parameter, roster, or authority. It attributes an already-merged verdict flip and does not re-open ADR-0024 LD-024-3 Step 4 verdict reconciliation, which remains coord+operator authority.',
});
mkdirSync(outputDir, { recursive: true });
writeFileSync(outJson, `${JSON.stringify(output)}\n`, 'utf8');
writeFileSync(outMd, `${markdown(output)}\n`, 'utf8');
writeFileSync(memoPath, `${memo(output)}\n`, 'utf8');
console.log(JSON.stringify({
  pre_sha: pre.sha256,
  post_sha: post.sha256,
  matched: matchedPairs.length,
  pre_only: preOnly.length,
  post_only: postOnly.length,
  winner_conversion: winnerConversion.target_to_fail_safe,
  determination: determination.code,
  json_out: outJson,
  md_out: outMd,
  memo_out: memoPath,
}, null, 2));

function readArtifact(ref, expectedSha) {
  const bytes = execFileSync('git', ['show', `${ref}:${artifactPath}`]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expectedSha) throw new Error(`${ref} SHA mismatch: ${sha256}`);
  return { ref, sha256, artifact: JSON.parse(bytes.toString('utf8')) };
}
function assertAnchors(source, exp, label) {
  const check = anchorCheck(source.artifact ?? source, exp);
  if (check.status !== 'matched') throw new Error(`${label} anchor mismatch: ${JSON.stringify(check)}`);
}
function anchorCheck(artifact, exp) {
  const trades = artifact.trades ?? [];
  const actual = { total_trades: trades.length, profit_factor_ppm: Number(artifact.aggregate.profit_factor_ppm), net_pnl_cents: Number(artifact.aggregate.net_pnl_cents), exit_reason: exitCounts(trades) };
  const mismatches = [];
  for (const key of ['total_trades', 'profit_factor_ppm', 'net_pnl_cents']) if (actual[key] !== exp[key]) mismatches.push(key);
  for (const [reason, count] of Object.entries(exp.exit_reason)) if ((actual.exit_reason[reason] ?? 0) !== count) mismatches.push(`exit_reason.${reason}`);
  return { status: mismatches.length ? 'mismatch' : 'matched', expected: exp, actual, mismatches };
}
function sourceSummary(artifact) {
  return { total_trades: artifact.trades.length, profit_factor_ppm: Number(artifact.aggregate.profit_factor_ppm), net_pnl_cents: Number(artifact.aggregate.net_pnl_cents), gross_profit_cents: Number(artifact.aggregate.gross_profit_cents), gross_loss_cents: Number(artifact.aggregate.gross_loss_cents), exit_reason: exitCounts(artifact.trades) };
}
function mapByEntrySide(trades, label) {
  const map = new Map();
  const collisions = [];
  for (const trade of trades) {
    const key = `${trade.entry_ts_ns}|${trade.side}`;
    if (map.has(key)) collisions.push(key);
    map.set(key, trade);
  }
  if (collisions.length) throw new Error(`${label} duplicate (entry_ts_ns, side) keys: ${collisions.slice(0, 5).join(', ')}`);
  return map;
}
function transitionMatrix(pairs) {
  const cells = new Map();
  for (const pair of pairs) {
    const preReason = pair.pre.exit_reason;
    const postReason = pair.post.exit_reason;
    const key = `${preReason}->${postReason}`;
    const cell = cells.get(key) ?? { pre_exit_reason: preReason, post_exit_reason: postReason, count: 0, pre_net_pnl_cents: 0, post_net_pnl_cents: 0, delta_cents: 0, pre_winners: 0, post_winners: 0 };
    cell.count += 1;
    cell.pre_net_pnl_cents += net(pair.pre);
    cell.post_net_pnl_cents += net(pair.post);
    cell.delta_cents = cell.post_net_pnl_cents - cell.pre_net_pnl_cents;
    if (net(pair.pre) > 0) cell.pre_winners += 1;
    if (net(pair.post) > 0) cell.post_winners += 1;
    cells.set(key, cell);
  }
  return [...cells.values()].sort((a, b) => a.pre_exit_reason.localeCompare(b.pre_exit_reason) || a.post_exit_reason.localeCompare(b.post_exit_reason));
}
function winnerConversionMetrics(pairs) {
  const targetToFailSafe = pairs.filter((pair) => pair.pre.exit_reason === 'target' && pair.post.exit_reason === 'fail_safe');
  const targetToAnyLoss = pairs.filter((pair) => pair.pre.exit_reason === 'target' && ['fail_safe', 'stop_loss'].includes(pair.post.exit_reason));
  const lossToTarget = pairs.filter((pair) => pair.pre.exit_reason === 'stop_loss' && pair.post.exit_reason === 'target');
  const stopLossToFailSafe = pairs.filter((pair) => pair.pre.exit_reason === 'stop_loss' && pair.post.exit_reason === 'fail_safe');
  const targetToAny = pairs.filter((pair) => pair.pre.exit_reason === 'target' && pair.post.exit_reason !== 'target');
  const matchedDelta = sum(pairs.map((pair) => net(pair.post) - net(pair.pre)));
  return {
    target_to_fail_safe: summarizePairs(targetToFailSafe),
    target_to_any_loss: summarizePairs(targetToAnyLoss),
    loss_to_target: summarizePairs(lossToTarget),
    stop_loss_to_fail_safe: summarizePairs(stopLossToFailSafe),
    target_to_any_non_target: summarizePairs(targetToAny),
    matched_delta_cents: matchedDelta,
    share_of_matched_delta: {
      target_to_fail_safe_pct: pct(summarizePairs(targetToFailSafe).delta_cents, matchedDelta),
      target_to_any_loss_pct: pct(summarizePairs(targetToAnyLoss).delta_cents, matchedDelta),
      stop_loss_to_fail_safe_pct: pct(summarizePairs(stopLossToFailSafe).delta_cents, matchedDelta),
    },
  };
}
function pathQualityProxy(pairs) {
  const targetToFailSafe = pairs.filter((pair) => pair.pre.exit_reason === 'target' && pair.post.exit_reason === 'fail_safe');
  const rows = targetToFailSafe.map((pair) => {
    const postMae = num(pair.post.max_adverse_excursion_cents);
    const postMfe = num(pair.post.max_favorable_excursion_cents);
    const preMfe = num(pair.pre.max_favorable_excursion_cents);
    return { key: pair.key, pre_net_pnl_cents: net(pair.pre), post_net_pnl_cents: net(pair.post), delta_cents: net(pair.post) - net(pair.pre), post_mae_cents: postMae, post_mfe_cents: postMfe, pre_mfe_cents: preMfe };
  });
  const negativeMae = rows.filter((row) => row.post_mae_cents < 0);
  return {
    classification: 'MFE_MAE_SEVERITY_PROXY_ONLY',
    exact_guard_threshold_classification: 'UNAVAILABLE_IN_BASE_V1_ARTIFACT',
    reason: 'base v1 artifact lacks per-trade risk, fail_safe subtype, adverse_r_at_exit, active_stop, and fail_safe_context; premature_cut cannot be proven or disproven from these fields',
    target_to_fail_safe_count: rows.length,
    post_mae_cents: metric(rows.map((row) => row.post_mae_cents)),
    post_mfe_cents: metric(rows.map((row) => row.post_mfe_cents)),
    pre_mfe_cents: metric(rows.map((row) => row.pre_mfe_cents)),
    negative_mae_count: negativeMae.length,
    non_negative_mae_count: rows.length - negativeMae.length,
    sample_worst_mae: [...rows].sort((a, b) => a.post_mae_cents - b.post_mae_cents).slice(0, 10),
    routing_constraint: 'Can support EDGE_WAS_GUARD_ARTIFACT only as an aggregate artifact-level attribution, not as exact subtype/premature-cut proof.',
  };
}
function tradeAvailability() {
  const preOnlySummary = summarizeRows(preOnly);
  const postOnlySummary = summarizeRows(postOnly);
  const matchedSummary = { count: matchedPairs.length, pre_net_pnl_cents: sum(matchedPairs.map((pair) => net(pair.pre))), post_net_pnl_cents: sum(matchedPairs.map((pair) => net(pair.post))) };
  matchedSummary.delta_cents = matchedSummary.post_net_pnl_cents - matchedSummary.pre_net_pnl_cents;
  return { matched: matchedSummary, pre_only: preOnlySummary, post_only: postOnlySummary, total_delta_cents: expected.post.net_pnl_cents - expected.pre.net_pnl_cents };
}
function summarizeRows(rows) {
  return { count: rows.length, net_pnl_cents: sum(rows.map(net)), winners: rows.filter((row) => net(row) > 0).length, losers: rows.filter((row) => net(row) < 0).length, exit_reason: exitCounts(rows) };
}
function summarizePairs(pairs) {
  return { count: pairs.length, pre_net_pnl_cents: sum(pairs.map((pair) => net(pair.pre))), post_net_pnl_cents: sum(pairs.map((pair) => net(pair.post))), delta_cents: sum(pairs.map((pair) => net(pair.post) - net(pair.pre))), pre_winners: pairs.filter((pair) => net(pair.pre) > 0).length, post_winners: pairs.filter((pair) => net(pair.post) > 0).length };
}
function timeStopAttribution() {
  return { pre_time_stop_count: (exitCounts(pre.artifact.trades).time_stop ?? 0), post_time_stop_count: (exitCounts(post.artifact.trades).time_stop ?? 0), attribution: 'NO_TIME_STOP_EXIT_REASON_IN_EITHER_ARTIFACT' };
}
function spreadAttribution() {
  const failSafes = post.artifact.trades.filter((trade) => trade.exit_reason === 'fail_safe');
  const bySpread = groupRows(failSafes, (trade) => trade.spread_bucket ?? 'missing');
  return { classification: 'FAIL_SAFE_SUBTYPE_UNAVAILABLE', reason: 'base v1 artifact has exit_reason=fail_safe and entry spread_bucket but not management_action_reason; max_spread_ticks attribution cannot be proven exactly', post_fail_safe_by_entry_spread_bucket: bySpread };
}
function deltaWaterfall(matrixRows, availabilityRows) {
  const matchedDelta = availabilityRows.matched.delta_cents;
  const preOnlyRemovalDelta = -availabilityRows.pre_only.net_pnl_cents;
  const postOnlyAdditionDelta = availabilityRows.post_only.net_pnl_cents;
  const targetToFailSafe = winnerConversion.target_to_fail_safe.delta_cents;
  const targetToStopLoss = cellDelta(matrixRows, 'target', 'stop_loss');
  const stopLossToFailSafe = winnerConversion.stop_loss_to_fail_safe.delta_cents;
  const otherMatchedDelta = matchedDelta - targetToFailSafe - targetToStopLoss - stopLossToFailSafe;
  return [
    { step: 'pre_fix_net_pnl_cents', delta_cents: 0, running_net_pnl_cents: expected.pre.net_pnl_cents },
    { step: 'matched_target_to_fail_safe', delta_cents: targetToFailSafe, running_net_pnl_cents: expected.pre.net_pnl_cents + targetToFailSafe },
    { step: 'matched_target_to_stop_loss', delta_cents: targetToStopLoss, running_net_pnl_cents: expected.pre.net_pnl_cents + targetToFailSafe + targetToStopLoss },
    { step: 'matched_stop_loss_to_fail_safe', delta_cents: stopLossToFailSafe, running_net_pnl_cents: expected.pre.net_pnl_cents + targetToFailSafe + targetToStopLoss + stopLossToFailSafe },
    { step: 'all_other_matched_transitions', delta_cents: otherMatchedDelta, running_net_pnl_cents: expected.pre.net_pnl_cents + matchedDelta },
    { step: 'remove_pre_only_entries', delta_cents: preOnlyRemovalDelta, running_net_pnl_cents: expected.pre.net_pnl_cents + matchedDelta + preOnlyRemovalDelta },
    { step: 'add_post_only_entries', delta_cents: postOnlyAdditionDelta, running_net_pnl_cents: expected.post.net_pnl_cents },
  ];
}
function improvementTarget() {
  const postNet = expected.post.net_pnl_cents;
  const grossProfit = Number(post.artifact.aggregate.gross_profit_cents);
  const grossLoss = Math.abs(Number(post.artifact.aggregate.gross_loss_cents));
  const breakEvenGap = -postNet;
  const pfPassLossAtCurrentProfit = grossProfit / 1.35;
  const pfPassGap = Math.max(0, grossLoss - pfPassLossAtCurrentProfit);
  return { post_fix_net_pnl_cents: postNet, break_even_gap_cents: breakEvenGap, pf_pass_threshold: 1.35, pf_pass_gap_cents_if_gross_profit_unchanged: round(pfPassGap, 2), note: 'PF 1.0 is break-even, not ADR-0016 pass.' };
}
function determine(wc, pq, availabilityRows, waterfallRows) {
  const targetToLoss = wc.target_to_any_loss.delta_cents;
  const totalDelta = availabilityRows.total_delta_cents;
  const dominant = Math.abs(targetToLoss) / Math.abs(totalDelta) >= 0.5;
  if (pq.exact_guard_threshold_classification === 'UNAVAILABLE_IN_BASE_V1_ARTIFACT') {
    if (dominant) {
      return { code: 'EDGE_WAS_GUARD_ARTIFACT_PROXY', basis: 'Target-to-loss conversions dominate the verdict-flip delta, and post-fix fail_safe exits replace pre-fix winners, but base v1 artifacts cannot prove exact max_adverse_r vs max_spread subtype or premature-cut threshold mechanics.', supporting_cents: { total_delta_cents: totalDelta, target_to_any_loss_delta_cents: targetToLoss, target_to_fail_safe_delta_cents: wc.target_to_fail_safe.delta_cents }, recommended_next_step: 'Treat pre-fix edge as artifact-level guard-dependent unless operator wants richer subtype evidence. Do not widen max_adverse_r based on this attribution alone.' };
    }
    return { code: 'EVIDENCE_INSUFFICIENT', basis: 'Base v1 artifacts cannot support exact guard subtype/path-quality classification, and winner conversion is not dominant enough for proxy determination.', supporting_cents: { total_delta_cents: totalDelta, target_to_any_loss_delta_cents: targetToLoss }, recommended_next_step: 'Only extend evidence if exact subtype/premature-cut proof is decision-critical.' };
  }
  return { code: 'EVIDENCE_INSUFFICIENT', basis: 'Unexpected path-quality state.', supporting_cents: { total_delta_cents: totalDelta }, recommended_next_step: 'Escalate for coord review.' };
}
function markdown(data) {
  const lines = ['# MGMT-BUGFIX-EDGE-ATTRIBUTION-01', '', '## Source anchors', '', `- Pre-fix SHA: \`${data.source_artifacts.pre_fix.sha256}\``, `- Post-fix SHA: \`${data.source_artifacts.post_fix.sha256}\``, '', '## Trade availability', '', '| Bucket | Count | Pre net | Post net | Delta |', '|---|---:|---:|---:|---:|', `| matched | ${data.trade_availability.matched.count} | ${data.trade_availability.matched.pre_net_pnl_cents} | ${data.trade_availability.matched.post_net_pnl_cents} | ${data.trade_availability.matched.delta_cents} |`, `| pre_only | ${data.trade_availability.pre_only.count} | ${data.trade_availability.pre_only.net_pnl_cents} | n/a | ${-data.trade_availability.pre_only.net_pnl_cents} |`, `| post_only | ${data.trade_availability.post_only.count} | n/a | ${data.trade_availability.post_only.net_pnl_cents} | ${data.trade_availability.post_only.net_pnl_cents} |`, '', '## Exit-reason transition matrix', '', '| Pre | Post | Count | Pre net | Post net | Delta |', '|---|---|---:|---:|---:|---:|'];
  for (const row of data.exit_reason_transition_matrix) lines.push(`| ${row.pre_exit_reason} | ${row.post_exit_reason} | ${row.count} | ${row.pre_net_pnl_cents} | ${row.post_net_pnl_cents} | ${row.delta_cents} |`);
  lines.push('', '## Winner conversion', '', `- target -> fail_safe count: \`${data.winner_conversion.target_to_fail_safe.count}\``, `- target -> fail_safe delta cents: \`${data.winner_conversion.target_to_fail_safe.delta_cents}\``, `- target -> any loss count: \`${data.winner_conversion.target_to_any_loss.count}\``, `- target -> any loss delta cents: \`${data.winner_conversion.target_to_any_loss.delta_cents}\``, '', '## Path-quality proxy', '', `- Classification: \`${data.path_quality_proxy.classification}\``, `- Exact guard-threshold classification: \`${data.path_quality_proxy.exact_guard_threshold_classification}\``, `- Reason: ${data.path_quality_proxy.reason}`, '', '## Delta waterfall', '', '| Step | Delta | Running net |', '|---|---:|---:|');
  for (const row of data.delta_waterfall) lines.push(`| ${row.step} | ${row.delta_cents} | ${row.running_net_pnl_cents} |`);
  lines.push('', '## Determination', '', `- Code: \`${data.determination.code}\``, `- Basis: ${data.determination.basis}`, '', '## Authority caveat', '', data.authority_caveat);
  return lines.join('\n');
}
function memo(data) {
  return ['# MGMT-BUGFIX-EDGE-ATTRIBUTION-01 Memo', '', '## 1. Context', '', 'This memo completes artifact-level dollar attribution for the v2 verdict flip caused by MGMT-BUG-FIX-02. It extends the rederivation-02 count-level matched-pair analysis without re-running either engine.', '', '## 2. Source provenance and anchors', '', `- Pre-fix artifact: \`${preRef}:${artifactPath}\``, `- Pre-fix SHA: \`${data.source_artifacts.pre_fix.sha256}\``, `- Pre-fix net PnL: \`${data.source_artifacts.pre_fix.anchors.net_pnl_cents}\` cents`, `- Pre-fix PF ppm: \`${data.source_artifacts.pre_fix.anchors.profit_factor_ppm}\``, `- Post-fix artifact: \`${postRef}:${artifactPath}\``, `- Post-fix SHA: \`${data.source_artifacts.post_fix.sha256}\``, `- Post-fix net PnL: \`${data.source_artifacts.post_fix.anchors.net_pnl_cents}\` cents`, `- Post-fix PF ppm: \`${data.source_artifacts.post_fix.anchors.profit_factor_ppm}\``, '', '## 3. Trade-availability accounting', '', `Matched pairs: \`${data.trade_availability.matched.count}\`; pre-only: \`${data.trade_availability.pre_only.count}\`; post-only: \`${data.trade_availability.post_only.count}\`.`, '', '## 4. Exit-reason transition matrix', '', 'See the Markdown artifact for the full data table. The load-bearing transitions are target-to-fail-safe and target-to-stop-loss.', '', '## 5. Winner-conversion finding', '', `Target-to-fail-safe conversions: \`${data.winner_conversion.target_to_fail_safe.count}\` trades, delta \`${data.winner_conversion.target_to_fail_safe.delta_cents}\` cents.`, `Target-to-any-loss conversions: \`${data.winner_conversion.target_to_any_loss.count}\` trades, delta \`${data.winner_conversion.target_to_any_loss.delta_cents}\` cents.`, '', '## 6. Path-quality determination', '', `Classification: \`${data.path_quality_proxy.classification}\`. Exact premature-cut classification is \`${data.path_quality_proxy.exact_guard_threshold_classification}\` because base v1 artifacts lack fail-safe subtype and per-trade risk fields.`, '', '## 7. Time-stop and spread attribution', '', `Time-stop attribution: \`${data.time_stop_attribution.attribution}\`. Spread attribution: \`${data.spread_attribution.classification}\`; entry spread buckets are reported, but max_spread_ticks subtype is unavailable.`, '', '## 8. Delta waterfall', '', `Pre-fix net PnL \`${expected.pre.net_pnl_cents}\` cents to post-fix net PnL \`${expected.post.net_pnl_cents}\` cents, total delta \`${data.trade_availability.total_delta_cents}\` cents. See Markdown artifact for the waterfall table.`, '', '## 9. Improvement-target framing', '', `Break-even gap from post-fix evidence: \`${data.improvement_target.break_even_gap_cents}\` cents. PF 1.0 is break-even, not ADR-0016 pass; approximate PF-pass gap if gross profit unchanged is \`${data.improvement_target.pf_pass_gap_cents_if_gross_profit_unchanged}\` cents.`, '', '## 10. Routing determination', '', `Determination: \`${data.determination.code}\`.`, '', data.determination.basis, '', '## 11. Recommended next step', '', data.determination.recommended_next_step, '', '## 12. Authority caveat', '', data.authority_caveat, '', 'This ticket changes no engine, strategy, parameter, roster, or authority. It attributes an already-merged verdict flip and does not re-open the ADR-0024 LD-024-3 Step 4 verdict reconciliation, which remains coord+operator authority.'].join('\n');
}
function exitCounts(rows) { const out = {}; for (const row of rows) out[row.exit_reason] = (out[row.exit_reason] ?? 0) + 1; return out; }
function groupRows(rows, getter) { const groups = {}; for (const row of rows) { const key = getter(row); const bucket = groups[key] ?? { count: 0, net_pnl_cents: 0, winners: 0, losers: 0 }; bucket.count += 1; bucket.net_pnl_cents += net(row); if (net(row) > 0) bucket.winners += 1; if (net(row) < 0) bucket.losers += 1; groups[key] = bucket; } return groups; }
function cellDelta(rows, preReason, postReason) { return rows.find((row) => row.pre_exit_reason === preReason && row.post_exit_reason === postReason)?.delta_cents ?? 0; }
function net(row) { return num(row.net_pnl_cents) ?? 0; }
function num(value) { if (value === null || value === undefined) return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function sum(values) { return values.reduce((acc, value) => acc + (value ?? 0), 0); }
function pct(part, whole) { return whole ? round((part / whole) * 100, 2) : 0; }
function round(value, digits = 0) { if (!Number.isFinite(value)) return null; const factor = 10 ** digits; const out = Math.round(value * factor) / factor; return Object.is(out, -0) ? 0 : out; }
function metric(values) { const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b); return { count: finite.length, missing: values.length - finite.length, min: finite.length ? round(finite[0], 2) : null, p25: quantile(finite, 0.25), median: quantile(finite, 0.5), p75: quantile(finite, 0.75), max: finite.length ? round(finite[finite.length - 1], 2) : null, avg: finite.length ? round(sum(finite) / finite.length, 2) : null }; }
function quantile(values, p) { if (!values.length) return null; const idx = (values.length - 1) * p; const lo = Math.floor(idx); const hi = Math.ceil(idx); const w = idx - lo; return lo === hi ? round(values[lo], 2) : round(values[lo] * (1 - w) + values[hi] * w, 2); }
function sortJson(value) { if (Array.isArray(value)) return value.map(sortJson); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])])); return value; }
