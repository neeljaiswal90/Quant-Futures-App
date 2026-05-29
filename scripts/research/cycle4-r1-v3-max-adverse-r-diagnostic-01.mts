import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveManagementProfile } from '../../apps/strategy_runtime/src/management/index.js';
import type { StrategyId } from '../../apps/strategy_runtime/src/contracts/strategy-ids.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type ClassKey = 'max_adverse_r' | 'spread_fail_safe' | 'target' | 'stop_loss';

interface ArtifactExit {
  readonly exit_ts_ns: string;
  readonly exit_quantity: number;
  readonly management_action_reason: string | null;
  readonly management_action_type: string | null;
  readonly target_label: string | null;
  readonly fail_safe_context: FailSafeContext | null;
}

interface FailSafeContext {
  readonly market_authority: string | null;
  readonly market_is_stale: boolean | null;
  readonly mark_price: number | null;
  readonly bid_px: number | null;
  readonly ask_px: number | null;
  readonly active_stop_price: number | null;
  readonly remaining_quantity: number | null;
  readonly position_profile_id: string | null;
  readonly position_profile_version: number | null;
  readonly management_profile_id: string | null;
  readonly management_profile_version: number | null;
  readonly validation_path: string | null;
}

interface ArtifactTrade {
  readonly trade_id: string;
  readonly session_id: string;
  readonly entry_ts_ns: string;
  readonly exit_ts_ns: string;
  readonly side: 'long' | 'short';
  readonly regime: string;
  readonly vix_prior_close_percentile: number | null;
  readonly spread_bucket: string;
  readonly queue_ahead_bucket: string;
  readonly entry_price: number;
  readonly exit_price: number;
  readonly gross_pnl_cents: string;
  readonly net_pnl_cents: string;
  readonly entry_quantity: number;
  readonly exit_quantity: number;
  readonly management_profile_id: string;
  readonly time_stop_at_deadline_extension: string;
  readonly exits: readonly ArtifactExit[];
  readonly exit_reason: string;
  readonly exit_bar_index: number;
  readonly max_favorable_excursion_cents: string;
  readonly max_adverse_excursion_cents: string;
}

interface HeldOutArtifact {
  readonly schema_version: 1;
  readonly strategy_id: string;
  readonly trades: readonly ArtifactTrade[];
  readonly aggregate: {
    readonly total_trades: number;
    readonly net_pnl_cents: string;
    readonly gross_profit_cents: string;
    readonly gross_loss_cents: string;
    readonly profit_factor_ppm: number | null;
  };
}

interface Stats {
  readonly count: number;
  readonly gross_pnl_cents: number;
  readonly net_pnl_cents: number;
  readonly avg_net_pnl_cents: number | null;
  readonly median_net_pnl_cents: number | null;
  readonly p10_net_pnl_cents: number | null;
  readonly p25_net_pnl_cents: number | null;
  readonly p75_net_pnl_cents: number | null;
  readonly p90_net_pnl_cents: number | null;
  readonly avg_hold_minutes: number | null;
  readonly median_hold_minutes: number | null;
  readonly avg_mfe_cents: number | null;
  readonly median_mfe_cents: number | null;
  readonly avg_mae_cents: number | null;
  readonly median_mae_cents: number | null;
  readonly avg_short_price_delta_points: number | null;
  readonly median_short_price_delta_points: number | null;
}

const SOURCE_ARTIFACT = 'artifacts/held-out-validation/cycle4-r1-v3-failsafe-forensics-02/regime_shock_reversion_short_v3-feb-mar-apr-2026.json';
const SOURCE_FORENSICS = 'artifacts/research/cycle4-r1-v3-failsafe-forensics-02/v3-failsafe-trade-forensics.json';
const JSON_OUT = 'artifacts/research/cycle4-r1-v3-max-adverse-r-diagnostic-01/v3-max-adverse-r-diagnostic.json';
const MD_OUT = 'artifacts/research/cycle4-r1-v3-max-adverse-r-diagnostic-01/v3-max-adverse-r-diagnostic.md';
const STRATEGY_ID = 'regime_shock_reversion_short_v3' as StrategyId;

const EXPECTED = Object.freeze({
  totalTrades: 889,
  failSafeTrades: 262,
  maxAdverseTrades: 245,
  maxAdverseNetPnlCents: -580100,
  spreadFailSafeTrades: 17,
  spreadFailSafeNetPnlCents: 47650,
  totalNetPnlCents: -102600,
});

const ZERO_FAIL_SAFE_REASON_PREFIXES = [
  'fail_safe:stale_market',
  'fail_safe:profile_mismatch',
  'fail_safe:invalid_market_price',
  'fail_safe:missing_stop',
  'fail_safe:invalid_quantity',
  'fail_safe:invalid_target_position:',
] as const;

function main(): void {
  const sourceBytes = readFileSync(SOURCE_ARTIFACT);
  const sourceSha = createHash('sha256').update(sourceBytes).digest('hex');
  const sourceForensicsSha = createHash('sha256').update(readFileSync(SOURCE_FORENSICS)).digest('hex');
  const artifact = JSON.parse(sourceBytes.toString('utf8')) as HeldOutArtifact;
  const profile = resolveManagementProfile(STRATEGY_ID, { allow_fallback: false }).profile;
  const maxAdverseR = profile.fail_safe.max_adverse_r;

  assertArtifact(artifact, maxAdverseR);

  const classes = classifyTrades(artifact.trades);
  const maxAdverse = classes.max_adverse_r;
  const target = classes.target;
  const stopLoss = classes.stop_loss;
  const spreadFailSafe = classes.spread_fail_safe;

  const result = {
    schema_version: 1,
    ticket: 'CYCLE4-R1-V3-MAX-ADVERSE-R-DIAGNOSTIC-01',
    source_artifacts: {
      held_out_artifact: {
        path: SOURCE_ARTIFACT,
        sha256: sourceSha,
        strategy_id: artifact.strategy_id,
        schema_version: artifact.schema_version,
      },
      prior_forensics_json: {
        path: SOURCE_FORENSICS,
        sha256: sourceForensicsSha,
      },
    },
    anchor_reconciliation: {
      total_trades: artifact.trades.length,
      fail_safe_exits: countByReason(artifact.trades, 'fail_safe'),
      max_adverse_r_fail_safes: maxAdverse.length,
      max_adverse_r_net_pnl_cents: sum(maxAdverse.map(netPnl)),
      spread_fail_safes: spreadFailSafe.length,
      spread_fail_safe_net_pnl_cents: sum(spreadFailSafe.map(netPnl)),
      total_net_pnl_cents: sum(artifact.trades.map(netPnl)),
      zero_count_non_implicated_classes: zeroReasonCounts(artifact.trades),
      single_contract_replay: true,
      status: 'matched',
    },
    class_definitions: {
      primary_negative_class: 'exit_reason=fail_safe and exits[].management_action_reason=fail_safe:max_adverse_r_exceeded',
      comparison_classes: [
        'target exits',
        'stop_loss exits',
        'fail_safe:max_spread_ticks_exceeded exits',
      ],
      v3_fail_safe_max_adverse_r_threshold: maxAdverseR,
    },
    class_summaries: classSummaries(classes),
    hold_time_analysis: classMetricSummary(classes, holdMinutes),
    mfe_mae_analysis: {
      mfe_cents: classMetricSummary(classes, (trade) => cents(trade.max_favorable_excursion_cents)),
      mae_cents: classMetricSummary(classes, (trade) => cents(trade.max_adverse_excursion_cents)),
    },
    price_movement_analysis: classMetricSummary(classes, shortPriceDeltaPoints),
    vix_percentile_analysis: groupedByClass(classes, (trade) => vixBucket(trade.vix_prior_close_percentile)),
    session_analysis: topGroupedByClass(classes, (trade) => trade.session_id, 12),
    spread_queue_analysis: {
      spread_bucket: groupedByClass(classes, (trade) => trade.spread_bucket),
      queue_ahead_bucket: groupedByClass(classes, (trade) => trade.queue_ahead_bucket),
    },
    regime_analysis: groupedByClass(classes, (trade) => trade.regime),
    worst_trades: tradeRows(maxAdverse.slice().sort((a, b) => netPnl(a) - netPnl(b)).slice(0, 20)),
    least_bad_trades: tradeRows(maxAdverse.slice().sort((a, b) => netPnl(b) - netPnl(a)).slice(0, 20)),
    candidate_separators: candidateSeparators(classes),
    evidence_gaps: [
      'per-trade signed_shock_vwap remains unavailable',
      'per-trade signed_shock_vwap_recent_values remains unavailable',
      'per-trade vix_value and vix_fresh remain unavailable',
      'per-trade primary_percentile and vxn_percentile remain unavailable',
      'per-trade window_id remains unavailable; overlapping walk-forward windows prevent unambiguous fail-safe window attribution',
      'adverse-R at exit is inferred from reason/MAE context; exact adverse-R scalar is not serialized per trade',
    ],
    recommendations: [
      'Proceed with a diagnostic focused on early adverse movement / max-adverse-R threshold behavior, not spread-threshold tuning.',
      'Do not relax max_spread_ticks based on this evidence; spread fail-safes are net-positive and appear protective.',
      'If a future entry-quality diagnostic requires signed-shock or recent-shock separators, route an evidence-surface extension before tuning.',
      'No activation, paper observation, broker/live dispatch, or Phase 6 authority follows from this diagnostic.',
    ],
  } satisfies JsonValue;

  writeJson(JSON_OUT, result);
  writeMarkdown(MD_OUT, result);
  process.stdout.write(JSON.stringify({
    source_sha: sourceSha,
    max_adverse_r_threshold: maxAdverseR,
    total_trades: artifact.trades.length,
    max_adverse_trades: maxAdverse.length,
    max_adverse_net_pnl_cents: sum(maxAdverse.map(netPnl)),
    spread_fail_safe_trades: spreadFailSafe.length,
    spread_fail_safe_net_pnl_cents: sum(spreadFailSafe.map(netPnl)),
    json_out: JSON_OUT,
    md_out: MD_OUT,
  }) + '\n');
}

function assertArtifact(artifact: HeldOutArtifact, maxAdverseR: number): void {
  if (artifact.schema_version !== 1) throw new Error(`expected schema_version 1, got ${artifact.schema_version}`);
  if (artifact.strategy_id !== STRATEGY_ID) throw new Error(`expected strategy ${STRATEGY_ID}, got ${artifact.strategy_id}`);
  if (!Number.isFinite(maxAdverseR) || maxAdverseR <= 0) throw new Error(`invalid max_adverse_r ${maxAdverseR}`);
  if (artifact.trades.length !== EXPECTED.totalTrades) throw new Error(`expected ${EXPECTED.totalTrades} trades, got ${artifact.trades.length}`);
  if (sum(artifact.trades.map(netPnl)) !== EXPECTED.totalNetPnlCents) throw new Error('total net pnl anchor mismatch');
  for (const [index, trade] of artifact.trades.entries()) {
    if (trade.entry_quantity !== 1 || trade.exit_quantity !== 1 || trade.exits.length !== 1) {
      throw new Error(`expected single-contract/single-exit trade at trades[${index}]`);
    }
    if (typeof trade.trade_id !== 'string' || trade.trade_id.length === 0) throw new Error(`missing trade_id at ${index}`);
    if (typeof trade.session_id !== 'string' || trade.session_id.length === 0) throw new Error(`missing session_id at ${index}`);
    if (!Number.isFinite(trade.entry_price) || !Number.isFinite(trade.exit_price)) throw new Error(`invalid prices at ${index}`);
  }
  const classes = classifyTrades(artifact.trades);
  const failSafe = countByReason(artifact.trades, 'fail_safe');
  if (failSafe !== EXPECTED.failSafeTrades) throw new Error(`expected ${EXPECTED.failSafeTrades} fail-safe trades, got ${failSafe}`);
  if (classes.max_adverse_r.length !== EXPECTED.maxAdverseTrades) throw new Error('max-adverse count mismatch');
  if (sum(classes.max_adverse_r.map(netPnl)) !== EXPECTED.maxAdverseNetPnlCents) throw new Error('max-adverse pnl mismatch');
  if (classes.spread_fail_safe.length !== EXPECTED.spreadFailSafeTrades) throw new Error('spread fail-safe count mismatch');
  if (sum(classes.spread_fail_safe.map(netPnl)) !== EXPECTED.spreadFailSafeNetPnlCents) throw new Error('spread fail-safe pnl mismatch');
  const zeroCounts = zeroReasonCounts(artifact.trades);
  for (const item of zeroCounts) {
    if (item.count !== 0) throw new Error(`non-implicated fail-safe class ${item.reason_class} has ${item.count} trades`);
  }
}

function classifyTrades(trades: readonly ArtifactTrade[]): Record<ClassKey, ArtifactTrade[]> {
  return {
    max_adverse_r: trades.filter((trade) => onlyExit(trade).management_action_reason === 'fail_safe:max_adverse_r_exceeded'),
    spread_fail_safe: trades.filter((trade) => onlyExit(trade).management_action_reason === 'fail_safe:max_spread_ticks_exceeded'),
    target: trades.filter((trade) => trade.exit_reason === 'target'),
    stop_loss: trades.filter((trade) => trade.exit_reason === 'stop_loss'),
  };
}

function zeroReasonCounts(trades: readonly ArtifactTrade[]): { readonly reason_class: string; readonly count: number }[] {
  return ZERO_FAIL_SAFE_REASON_PREFIXES.map((prefix) => ({
    reason_class: prefix.endsWith(':') ? `${prefix}*` : prefix,
    count: trades.filter((trade) => onlyExit(trade).management_action_reason?.startsWith(prefix) === true).length,
  }));
}

function classSummaries(classes: Record<ClassKey, readonly ArtifactTrade[]>): JsonValue[] {
  return classEntries(classes).map(([key, trades]) => ({ class: key, ...stats(trades) }));
}

function candidateSeparators(classes: Record<ClassKey, readonly ArtifactTrade[]>): JsonValue[] {
  const maxAdverse = classes.max_adverse_r;
  const target = classes.target;
  const stopLoss = classes.stop_loss;
  const spread = classes.spread_fail_safe;
  const maxShortHoldPct = fraction(maxAdverse.filter((trade) => holdMinutes(trade) < 2).length, maxAdverse.length);
  const targetShortHoldPct = fraction(target.filter((trade) => holdMinutes(trade) < 2).length, target.length);
  const maxMedianMae = median(maxAdverse.map((trade) => cents(trade.max_adverse_excursion_cents)).sort((a, b) => a - b));
  const targetMedianMae = median(target.map((trade) => cents(trade.max_adverse_excursion_cents)).sort((a, b) => a - b));
  const maxVixHighPct = fraction(maxAdverse.filter((trade) => (trade.vix_prior_close_percentile ?? -1) >= 0.85).length, maxAdverse.length);
  const targetVixHighPct = fraction(target.filter((trade) => (trade.vix_prior_close_percentile ?? -1) >= 0.85).length, target.length);
  return [
    {
      feature: 'hold_time_lt_2_minutes',
      observed_separation: `max_adverse=${percent(maxShortHoldPct)}, target=${percent(targetShortHoldPct)}`,
      likely_usefulness: maxShortHoldPct > targetShortHoldPct + 0.15 ? 'high diagnostic value' : 'limited standalone value',
      evidence_confidence: 'medium',
      risk_of_filtering_winners: targetShortHoldPct > 0.2 ? 'material' : 'lower',
      notes: 'Cross-checks CYCLE4-R2 sub-2-minute chop-flip hypothesis.',
    },
    {
      feature: 'max_adverse_excursion_cents',
      observed_separation: `max_adverse median MAE=${maxMedianMae}, target median MAE=${targetMedianMae}`,
      likely_usefulness: 'high diagnostic value',
      evidence_confidence: 'high',
      risk_of_filtering_winners: 'depends on whether pre-entry proxy can predict MAE',
      notes: 'MAE is outcome evidence, not a pre-entry filter by itself.',
    },
    {
      feature: 'vix_prior_close_percentile_ge_0_85',
      observed_separation: `max_adverse=${percent(maxVixHighPct)}, target=${percent(targetVixHighPct)}`,
      likely_usefulness: 'mixed',
      evidence_confidence: 'medium',
      risk_of_filtering_winners: 'high because targets also cluster in high VIX bucket',
      notes: 'Does not support a simple high-VIX exclusion.',
    },
    {
      feature: 'spread_fail_safe_comparison',
      observed_separation: `spread fail-safes net=${sum(spread.map(netPnl))} cents across ${spread.length} trades`,
      likely_usefulness: 'avoid relaxing spread guard',
      evidence_confidence: 'high',
      risk_of_filtering_winners: 'relaxing guard could leak captured profit',
      notes: 'Spread fail-safes are profitable comparison class, not the loss class.',
    },
    {
      feature: 'stop_loss_comparison',
      observed_separation: `stop_loss avg=${stats(stopLoss).avg_net_pnl_cents}, max_adverse avg=${stats(maxAdverse).avg_net_pnl_cents}`,
      likely_usefulness: 'management-threshold diagnostic value',
      evidence_confidence: 'high',
      risk_of_filtering_winners: 'requires threshold sensitivity replay before any change',
      notes: 'Max-adverse exits are materially worse than ordinary stop losses.',
    },
  ];
}

function classMetricSummary(classes: Record<ClassKey, readonly ArtifactTrade[]>, metric: (trade: ArtifactTrade) => number): JsonValue[] {
  return classEntries(classes).map(([key, trades]) => {
    const values = trades.map(metric).sort((a, b) => a - b);
    return {
      class: key,
      count: trades.length,
      avg: trades.length === 0 ? null : round(sum(values) / trades.length, 4),
      median: median(values),
      p10: percentile(values, 0.1),
      p25: percentile(values, 0.25),
      p75: percentile(values, 0.75),
      p90: percentile(values, 0.9),
    };
  });
}

function groupedByClass(classes: Record<ClassKey, readonly ArtifactTrade[]>, keyFn: (trade: ArtifactTrade) => string): JsonValue[] {
  return classEntries(classes).map(([className, trades]) => ({
    class: className,
    groups: groupStats(trades, keyFn),
  }));
}

function topGroupedByClass(classes: Record<ClassKey, readonly ArtifactTrade[]>, keyFn: (trade: ArtifactTrade) => string, limit: number): JsonValue[] {
  return classEntries(classes).map(([className, trades]) => ({
    class: className,
    groups: groupStats(trades, keyFn).slice(0, limit),
  }));
}

function groupStats(trades: readonly ArtifactTrade[], keyFn: (trade: ArtifactTrade) => string): JsonValue[] {
  const groups = new Map<string, ArtifactTrade[]>();
  for (const trade of trades) {
    const key = keyFn(trade);
    groups.set(key, [...(groups.get(key) ?? []), trade]);
  }
  return [...groups.entries()]
    .map(([key, grouped]) => ({ key, ...stats(grouped) }))
    .sort((left, right) => Number(right.count) - Number(left.count) || String(left.key).localeCompare(String(right.key)));
}

function stats(trades: readonly ArtifactTrade[]): Stats {
  const netValues = trades.map(netPnl).sort((a, b) => a - b);
  const mfeValues = trades.map((trade) => cents(trade.max_favorable_excursion_cents)).sort((a, b) => a - b);
  const maeValues = trades.map((trade) => cents(trade.max_adverse_excursion_cents)).sort((a, b) => a - b);
  const holdValues = trades.map(holdMinutes).sort((a, b) => a - b);
  const priceValues = trades.map(shortPriceDeltaPoints).sort((a, b) => a - b);
  return {
    count: trades.length,
    gross_pnl_cents: sum(trades.map((trade) => cents(trade.gross_pnl_cents))),
    net_pnl_cents: sum(netValues),
    avg_net_pnl_cents: average(netValues, 2),
    median_net_pnl_cents: median(netValues),
    p10_net_pnl_cents: percentile(netValues, 0.1),
    p25_net_pnl_cents: percentile(netValues, 0.25),
    p75_net_pnl_cents: percentile(netValues, 0.75),
    p90_net_pnl_cents: percentile(netValues, 0.9),
    avg_hold_minutes: average(holdValues, 2),
    median_hold_minutes: median(holdValues),
    avg_mfe_cents: average(mfeValues, 2),
    median_mfe_cents: median(mfeValues),
    avg_mae_cents: average(maeValues, 2),
    median_mae_cents: median(maeValues),
    avg_short_price_delta_points: average(priceValues, 4),
    median_short_price_delta_points: median(priceValues),
  };
}

function tradeRows(trades: readonly ArtifactTrade[]): JsonValue[] {
  return trades.map((trade) => ({
    trade_id: trade.trade_id,
    session_id: trade.session_id,
    net_pnl_cents: netPnl(trade),
    hold_minutes: holdMinutes(trade),
    mfe_cents: cents(trade.max_favorable_excursion_cents),
    mae_cents: cents(trade.max_adverse_excursion_cents),
    short_price_delta_points: shortPriceDeltaPoints(trade),
    vix_prior_close_percentile: trade.vix_prior_close_percentile,
    spread_bucket: trade.spread_bucket,
    queue_ahead_bucket: trade.queue_ahead_bucket,
    reason: onlyExit(trade).management_action_reason,
    mark_price: onlyExit(trade).fail_safe_context?.mark_price ?? null,
    active_stop_price: onlyExit(trade).fail_safe_context?.active_stop_price ?? null,
  }));
}

function onlyExit(trade: ArtifactTrade): ArtifactExit {
  const exit = trade.exits[0];
  if (exit === undefined) throw new Error(`missing exit for ${trade.trade_id}`);
  return exit;
}

function classEntries(classes: Record<ClassKey, readonly ArtifactTrade[]>): [ClassKey, readonly ArtifactTrade[]][] {
  return [
    ['max_adverse_r', classes.max_adverse_r],
    ['target', classes.target],
    ['stop_loss', classes.stop_loss],
    ['spread_fail_safe', classes.spread_fail_safe],
  ];
}

function countByReason(trades: readonly ArtifactTrade[], reason: string): number {
  return trades.filter((trade) => trade.exit_reason === reason).length;
}

function netPnl(trade: ArtifactTrade): number {
  return cents(trade.net_pnl_cents);
}

function cents(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid cents ${value}`);
  return parsed;
}

function holdMinutes(trade: ArtifactTrade): number {
  return round(Number(BigInt(trade.exit_ts_ns) - BigInt(trade.entry_ts_ns)) / 60_000_000_000, 4);
}

function shortPriceDeltaPoints(trade: ArtifactTrade): number {
  return round(trade.side === 'short' ? trade.entry_price - trade.exit_price : trade.exit_price - trade.entry_price, 4);
}

function vixBucket(value: number | null): string {
  if (value === null) return 'null';
  if (value < 0.25) return '<0.25';
  if (value < 0.5) return '0.25-0.50';
  if (value < 0.67) return '0.50-0.67';
  if (value < 0.85) return '0.67-0.85';
  return '>=0.85';
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: readonly number[], places: number): number | null {
  return values.length === 0 ? null : round(sum(values) / values.length, places);
}

function median(sorted: readonly number[]): number | null {
  return percentile(sorted, 0.5);
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index] ?? null;
}

function fraction(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percent(value: number): string {
  return `${round(value * 100, 2)}%`;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function writeJson(path: string, value: JsonValue): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stableStringify(value) + '\n', 'utf8');
}

function stableStringify(value: JsonValue): string {
  return JSON.stringify(stable(value));
}

function stable(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key] as JsonValue)]));
  }
  return value;
}

function writeMarkdown(path: string, result: JsonValue): void {
  mkdirSync(dirname(path), { recursive: true });
  const r = result as Record<string, JsonValue>;
  const lines: string[] = [];
  lines.push('# CYCLE4-R1-V3-MAX-ADVERSE-R-DIAGNOSTIC-01 Artifact');
  lines.push('');
  lines.push('## Class summaries');
  table(lines, r.class_summaries as JsonValue[], ['class', 'count', 'net_pnl_cents', 'avg_net_pnl_cents', 'avg_hold_minutes', 'avg_mae_cents']);
  lines.push('');
  lines.push('## Candidate separators');
  table(lines, r.candidate_separators as JsonValue[], ['feature', 'observed_separation', 'likely_usefulness', 'evidence_confidence', 'risk_of_filtering_winners']);
  lines.push('');
  lines.push('## Worst max-adverse-R trades');
  table(lines, r.worst_trades as JsonValue[], ['trade_id', 'session_id', 'net_pnl_cents', 'hold_minutes', 'mae_cents', 'vix_prior_close_percentile', 'spread_bucket', 'queue_ahead_bucket']);
  lines.push('');
  lines.push('## Least-bad max-adverse-R trades');
  table(lines, r.least_bad_trades as JsonValue[], ['trade_id', 'session_id', 'net_pnl_cents', 'hold_minutes', 'mae_cents', 'vix_prior_close_percentile', 'spread_bucket', 'queue_ahead_bucket']);
  lines.push('');
  lines.push('## Evidence gaps');
  for (const gap of r.evidence_gaps as JsonValue[]) lines.push(`- ${String(gap)}`);
  lines.push('');
  writeFileSync(path, lines.join('\n'), 'utf8');
}

function table(lines: string[], rows: JsonValue[], columns: string[]): void {
  lines.push(`| ${columns.join(' | ')} |`);
  lines.push(`| ${columns.map(() => '---').join(' | ')} |`);
  for (const row of rows as Record<string, JsonValue>[]) {
    lines.push(`| ${columns.map((column) => formatCell(row[column])).join(' | ')} |`);
  }
}

function formatCell(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return '';
  return String(value).replaceAll('|', '\\|');
}

main();