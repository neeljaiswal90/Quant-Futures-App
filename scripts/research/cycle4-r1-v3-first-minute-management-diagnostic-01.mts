import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const ticket = 'CYCLE4-R1-V3-FIRST-MINUTE-MANAGEMENT-DIAGNOSTIC-01';
const src = 'artifacts/held-out-validation/cycle4-r1-v3-early-adverse-diagnostic-02/regime_shock_reversion_short_v3-feb-mar-apr-2026.json';
const outDir = process.env.FMM_OUT_DIR ?? 'artifacts/research/cycle4-r1-v3-first-minute-management-diagnostic-01';
const outJson = `${outDir}/v3-first-minute-management-diagnostic.json`;
const outMd = `${outDir}/v3-first-minute-management-diagnostic.md`;
const expectedSha = 'acc2ee2f27e08fab09bf0c21cbce5f409b86633a4df51782357a07b565e3476f';
const expected = { total_trades: 889, max_adverse_r: 245, spread_fail_safe: 17, target: 259, stop_loss: 363, session_close: 5, net_pnl_cents: -102600 };
const thresholds = [-100, -200, -300, -400, -500, -600, -800, -1000];

const bytes = readFileSync(src);
const sourceSha = sha(bytes);
if (sourceSha !== expectedSha) throw new Error(`source SHA mismatch: ${sourceSha}`);
const artifact = JSON.parse(bytes.toString('utf8'));
const trades = artifact.trades;
assertSource();
const classes = classify(trades);
const anchors = anchorReconciliation();
if (anchors.status !== 'matched') throw new Error(`anchor mismatch: ${JSON.stringify(anchors)}`);
const sweeps = thresholds.map(sweep);
const best = [...sweeps].sort((a, b) => b.full_counterfactual.net_delta_cents - a.full_counterfactual.net_delta_cents)[0];
const decision = decide(best);
const output = sortJson({
  schema_version: 1,
  ticket,
  source_artifact: { path: src, sha256: sourceSha, strategy_id: artifact.strategy_id, schema_version: artifact.schema_version },
  counterfactual_formula: {
    affected_trade_definition: 'first_minute_observed=true and finite first_minute_close_pnl_cents and first_minute_close_pnl_cents <= threshold',
    counterfactual_pnl_cents: 'first_minute_close_pnl_cents',
    delta_cents: 'counterfactual_pnl_cents - actual_net_pnl_cents',
    caveat: 'Diagnostic proxy only. first_minute_close_pnl_cents is not qfa-611 verdict evidence and is not an executable backtest.',
  },
  anchor_reconciliation: anchors,
  first_minute_coverage: coverage(),
  class_summaries: classSummaries(classes),
  threshold_sweep: sweeps,
  best_threshold: best,
  decision_output: decision,
  first_minute_distribution_by_exit_class: {
    close_pnl_cents: metricByClass((t) => n(t.first_minute_close_pnl_cents)),
    adverse_excursion_cents: metricByClass((t) => n(t.first_minute_max_adverse_excursion_cents)),
    favorable_excursion_cents: metricByClass((t) => n(t.first_minute_max_favorable_excursion_cents)),
  },
  vix_and_signed_shock_for_affected_trades_at_best_threshold: affectedContext(best.threshold_cents),
  recommendation: recommendation(decision),
  authority_caveat: 'No activation, paper observation, broker/live dispatch, Phase 6 authority, ACTIVE roster mutation, strategy mutation, or management-profile mutation is authorized.',
});
mkdirSync(outDir, { recursive: true });
writeFileSync(outJson, `${JSON.stringify(output)}\n`, 'utf8');
writeFileSync(outMd, `${markdown(output)}\n`, 'utf8');
console.log(JSON.stringify({ source_sha: sourceSha, json_out: outJson, md_out: outMd, anchor_status: anchors.status, best_threshold: best.threshold_cents, best_delta_cents: best.full_counterfactual.net_delta_cents, decision: decision.decision }, null, 2));

function assertSource() {
  if (artifact.schema_version !== 1) throw new Error(`schema_version mismatch: ${artifact.schema_version}`);
  if (trades.length !== expected.total_trades) throw new Error(`trade count mismatch: ${trades.length}`);
  for (const t of trades) {
    if (t.entry_quantity !== 1 || t.exit_quantity !== 1) throw new Error(`non-single-contract trade ${t.trade_id}`);
    if (!('first_minute_observed' in t)) throw new Error(`missing first_minute_observed on ${t.trade_id}`);
    if (!('first_minute_close_pnl_cents' in t)) throw new Error(`missing first_minute_close_pnl_cents on ${t.trade_id}`);
    if (reason(t) === 'fail_safe:max_adverse_r_exceeded' && !Number.isFinite(exit(t).fail_safe_context?.adverse_r_at_exit)) throw new Error(`missing adverse_r_at_exit on ${t.trade_id}`);
  }
  const finiteClose = trades.filter((t) => finite(n(t.first_minute_close_pnl_cents))).length;
  if (finiteClose !== 438) throw new Error(`expected 438 finite first-minute close values, got ${finiteClose}`);
}
function classify(rows) {
  return {
    max_adverse_r: rows.filter((t) => reason(t) === 'fail_safe:max_adverse_r_exceeded'),
    spread_fail_safe: rows.filter((t) => reason(t) === 'fail_safe:max_spread_ticks_exceeded'),
    target: rows.filter((t) => t.exit_reason === 'target'),
    stop_loss: rows.filter((t) => t.exit_reason === 'stop_loss'),
    session_close: rows.filter((t) => t.exit_reason === 'session_close'),
  };
}
function anchorReconciliation() {
  const actual = { total_trades: trades.length, max_adverse_r: classes.max_adverse_r.length, spread_fail_safe: classes.spread_fail_safe.length, target: classes.target.length, stop_loss: classes.stop_loss.length, session_close: classes.session_close.length, net_pnl_cents: sum(trades.map(net)) };
  const mismatches = Object.keys(expected).filter((k) => actual[k] !== expected[k]);
  return { status: mismatches.length === 0 ? 'matched' : 'mismatch', expected, actual, mismatches };
}
function coverage() {
  const by = {};
  for (const [k, rows] of Object.entries(classes)) by[k] = cov(rows);
  return { all_trades: cov(trades), by_exit_class: by };
}
function cov(rows) {
  const finiteClose = rows.filter((t) => finite(n(t.first_minute_close_pnl_cents))).length;
  return { total: rows.length, observed_flag_true: rows.filter((t) => t.first_minute_observed === true).length, finite_first_minute_close: finiteClose, non_observed_or_non_finite: rows.length - finiteClose, finite_close_pct: pct(finiteClose, rows.length) };
}
function sweep(threshold) {
  const affected = trades.filter((t) => finite(n(t.first_minute_close_pnl_cents)) && t.first_minute_observed === true && n(t.first_minute_close_pnl_cents) <= threshold);
  const unaffected = trades.filter((t) => !affected.includes(t));
  const cfPnls = trades.map((t) => affected.includes(t) ? n(t.first_minute_close_pnl_cents) : net(t));
  const actualNet = sum(trades.map(net));
  const cfNet = sum(cfPnls);
  const byClass = {};
  for (const [k, rows] of Object.entries(classes)) byClass[k] = classImpact(rows, threshold);
  const gp = sum(cfPnls.filter((v) => v > 0));
  const gl = -sum(cfPnls.filter((v) => v < 0));
  const session = concentration(affected, threshold, 'session_id');
  return {
    threshold_cents: threshold,
    eligible_observed_trades: trades.filter((t) => finite(n(t.first_minute_close_pnl_cents))).length,
    non_observed_trades: trades.filter((t) => !finite(n(t.first_minute_close_pnl_cents))).length,
    affected_trades: affected.length,
    unaffected_trades: unaffected.length,
    full_counterfactual: { actual_net_pnl_cents: actualNet, counterfactual_net_pnl_cents: cfNet, net_delta_cents: cfNet - actualNet, gross_profit_cents_proxy: gp, gross_loss_cents_proxy: gl, profit_factor_proxy: gl === 0 ? null : r(gp / gl, 6), break_even_gap_coverage_pct: pct(cfNet - actualNet, 102600), pf_pass_gap_coverage_pct: pct(cfNet - actualNet, 309593) },
    by_exit_class: byClass,
    target_damage_cents: Math.max(0, -byClass.target.net_delta_cents),
    stop_loss_effect_cents: byClass.stop_loss.net_delta_cents,
    session_close_effect_cents: byClass.session_close.net_delta_cents,
    max_adverse_loss_avoided_cents: byClass.max_adverse_r.net_delta_cents,
    concentration: session,
    concentration_risk: session.top1_delta_pct_of_total_positive_improvement > 50 ? 'high_top1_session_over_50pct' : 'not_top1_dominated',
  };
}
function classImpact(rows, threshold) {
  const affected = rows.filter((t) => finite(n(t.first_minute_close_pnl_cents)) && t.first_minute_observed === true && n(t.first_minute_close_pnl_cents) <= threshold);
  const actual = sum(rows.map(net));
  const cf = sum(rows.map((t) => affected.includes(t) ? n(t.first_minute_close_pnl_cents) : net(t)));
  return { total: rows.length, eligible_observed: rows.filter((t) => finite(n(t.first_minute_close_pnl_cents))).length, affected: affected.length, actual_net_pnl_cents: actual, counterfactual_net_pnl_cents: cf, net_delta_cents: cf - actual, avg_delta_per_affected_cents: affected.length ? r((cf - actual) / affected.length, 2) : 0 };
}
function concentration(affected, threshold, field) {
  const deltas = new Map();
  for (const t of affected) deltas.set(t[field] ?? 'missing', (deltas.get(t[field] ?? 'missing') ?? 0) + (n(t.first_minute_close_pnl_cents) - net(t)));
  const rows = [...deltas.entries()].map(([key, delta]) => ({ key, delta_cents: r(delta), pct_of_total_positive_improvement: 0 })).sort((a, b) => b.delta_cents - a.delta_cents);
  const positiveTotal = sum(rows.map((x) => Math.max(0, x.delta_cents)));
  for (const row of rows) row.pct_of_total_positive_improvement = pct(Math.max(0, row.delta_cents), positiveTotal);
  return { field, threshold_cents: threshold, total_positive_improvement_cents: positiveTotal, top1_delta_pct_of_total_positive_improvement: rows[0]?.pct_of_total_positive_improvement ?? 0, top3_delta_pct_of_total_positive_improvement: pct(sum(rows.slice(0, 3).map((x) => Math.max(0, x.delta_cents))), positiveTotal), top_rows: rows.slice(0, 10) };
}
function metricByClass(getter) {
  const out = {};
  for (const [k, rows] of Object.entries(classes)) out[k] = metric(rows.map(getter));
  return out;
}
function classSummaries(input) {
  const out = {};
  for (const [k, rows] of Object.entries(input)) out[k] = { count: rows.length, net_pnl_cents: sum(rows.map(net)), avg_net_pnl_cents: r(avg(rows.map(net)), 2), first_minute_close: metric(rows.map((t) => n(t.first_minute_close_pnl_cents))), first_minute_adverse: metric(rows.map((t) => n(t.first_minute_max_adverse_excursion_cents))), first_minute_favorable: metric(rows.map((t) => n(t.first_minute_max_favorable_excursion_cents))) };
  return out;
}
function affectedContext(threshold) {
  const affected = trades.filter((t) => finite(n(t.first_minute_close_pnl_cents)) && n(t.first_minute_close_pnl_cents) <= threshold);
  return { threshold_cents: threshold, count: affected.length, vix_value: metric(affected.map((t) => n(t.vix_value))), vix_prior_close_percentile: metric(affected.map((t) => n(t.vix_prior_close_percentile))), signed_shock_vwap_value: metric(affected.map((t) => n(t.signed_shock_vwap?.value))), recent_shock_latest: metric(affected.map(recentLatest)), by_exit_class: Object.fromEntries(Object.entries(classify(affected)).map(([k, rows]) => [k, rows.length])) };
}
function decide(best) {
  const delta = best.full_counterfactual.net_delta_cents;
  const targetDamageDominant = best.target_damage_cents > Math.max(0, best.max_adverse_loss_avoided_cents);
  const concentrated = best.concentration.top1_delta_pct_of_total_positive_improvement > 50;
  if (delta < 102600 || targetDamageDominant) return { decision: 'NO_VARIANT_JUSTIFIED', basis: 'best threshold does not clear break-even after full exit-class accounting, or target damage dominates' };
  if (concentrated) return { decision: 'DIAGNOSTIC_REPLAY_JUSTIFIED', basis: 'best threshold clears break-even as a proxy but is session-concentrated and needs replay validation' };
  return { decision: 'DIAGNOSTIC_REPLAY_JUSTIFIED', basis: 'best threshold clears break-even as a diagnostic proxy, but first-minute action changes management semantics and requires replay before variant scope' };
}
function recommendation(decision) {
  if (decision.decision === 'NO_VARIANT_JUSTIFIED') return 'Do not scope a variant; close or gather different evidence.';
  if (decision.decision === 'REGISTERED_INACTIVE_VARIANT_SCOPE_JUSTIFIED') return 'Scope a separate registered-inactive variant ticket, with no authority change.';
  return 'Route a separate diagnostic replay/scoping ticket for a causal first-minute management rule before any implementation.';
}
function markdown(data) {
  const b = data.best_threshold;
  const lines = ['# CYCLE4-R1-V3-FIRST-MINUTE-MANAGEMENT-DIAGNOSTIC-01', '', '## Source', '', `- Source artifact: \`${src}\``, `- SHA-256: \`${sourceSha}\``, '- Counterfactual formula: affected trades use `first_minute_close_pnl_cents`; delta is proxy counterfactual minus actual net PnL.', '', '## Anchor reconciliation', '', `- Status: \`${data.anchor_reconciliation.status}\``, `- Total trades: \`${data.anchor_reconciliation.actual.total_trades}\``, `- Net PnL cents: \`${data.anchor_reconciliation.actual.net_pnl_cents}\``, '', '## Threshold sweep', '', '| Threshold | Affected | Net delta | PF proxy | Target damage | Max-adverse delta | Top1 session concentration |', '|---:|---:|---:|---:|---:|---:|---:|'];
  for (const row of data.threshold_sweep) lines.push(`| ${row.threshold_cents} | ${row.affected_trades} | ${row.full_counterfactual.net_delta_cents} | ${row.full_counterfactual.profit_factor_proxy} | ${row.target_damage_cents} | ${row.max_adverse_loss_avoided_cents} | ${row.concentration.top1_delta_pct_of_total_positive_improvement}% |`);
  lines.push('', '## Best threshold', '', `- Threshold: \`${b.threshold_cents}\``, `- Full-counterfactual proxy net delta: \`${b.full_counterfactual.net_delta_cents}\` cents`, `- Target damage: \`${b.target_damage_cents}\` cents`, `- Top one session concentration: \`${b.concentration.top1_delta_pct_of_total_positive_improvement}%\``, '', '## Decision', '', `- Decision: \`${data.decision_output.decision}\``, `- Basis: ${data.decision_output.basis}`, '', '## Authority caveat', '', data.authority_caveat);
  return lines.join('\n');
}
function exit(t) { if ((t.exits ?? []).length !== 1) throw new Error(`expected one exit for ${t.trade_id}`); return t.exits[0]; }
function reason(t) { return exit(t).management_action_reason; }
function net(t) { return n(t.net_pnl_cents); }
function n(v) { if (v === null || v === undefined) return null; const x = Number(v); return Number.isFinite(x) ? x : null; }
function finite(v) { return typeof v === 'number' && Number.isFinite(v); }
function sum(a) { return a.reduce((x, y) => x + (y ?? 0), 0); }
function avg(a) { const f = a.filter(finite); return f.length ? sum(f) / f.length : null; }
function r(v, d = 0) { if (!finite(v)) return null; const f = 10 ** d; const o = Math.round(v * f) / f; return Object.is(o, -0) ? 0 : o; }
function pct(a, b) { return b ? r((a / b) * 100, 2) : 0; }
function metric(a) { const f = a.filter(finite).sort((x, y) => x - y); return { count: f.length, missing: a.length - f.length, min: f.length ? r(f[0], 4) : null, median: q(f, 0.5), p25: q(f, 0.25), p75: q(f, 0.75), max: f.length ? r(f[f.length - 1], 4) : null, avg: r(avg(f), 4) }; }
function q(a, p) { if (!a.length) return null; const i = (a.length - 1) * p; const lo = Math.floor(i); const hi = Math.ceil(i); return lo === hi ? r(a[lo], 4) : r(a[lo] * (1 - (i - lo)) + a[hi] * (i - lo), 4); }
function recentLatest(t) { const v = (t.signed_shock_vwap_recent_values ?? []).filter(finite); return v.length ? v[v.length - 1] : null; }
function sha(b) { return createHash('sha256').update(b).digest('hex'); }
function sortJson(v) { if (Array.isArray(v)) return v.map(sortJson); if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortJson(v[k])])); return v; }


