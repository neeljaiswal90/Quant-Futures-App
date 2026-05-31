import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type HeldOutTrade = {
  readonly entry_quantity: number;
  readonly entry_ts_ns: string;
  readonly exit_quantity: number;
  readonly exit_reason: string;
  readonly first_minute_close_pnl_cents: null | string | number;
  readonly first_minute_max_adverse_excursion_cents: null | string | number;
  readonly first_minute_max_favorable_excursion_cents: null | string | number;
  readonly first_minute_observed: boolean;
  readonly gross_pnl_cents: string | number;
  readonly max_adverse_excursion_cents: string | number;
  readonly max_favorable_excursion_cents: string | number;
  readonly net_pnl_cents: string | number;
  readonly queue_ahead_bucket: string;
  readonly regime: string;
  readonly session_id: string;
  readonly signed_shock_vwap: null | { readonly value?: number };
  readonly signed_shock_vwap_recent_values: readonly number[];
  readonly spread_bucket: string;
  readonly trade_id: string;
  readonly vix_fresh: boolean | null;
  readonly vix_prior_close_percentile: number | null;
  readonly vix_value: number | null;
};

type HeldOutArtifact = {
  readonly aggregate: {
    readonly gross_loss_cents: string | number;
    readonly gross_profit_cents: string | number;
    readonly net_pnl_cents: string | number;
    readonly profit_factor_ppm: number;
    readonly total_trades: number;
  };
  readonly schema_version: number;
  readonly strategy_id: string;
  readonly trades: readonly HeldOutTrade[];
};

type SensitivityArtifact = {
  readonly category_summary: Record<string, unknown>;
  readonly routing: { readonly code: string; readonly qfa611_reason: string };
  readonly schema_version: number;
  readonly ticket: string;
  readonly v2_cell_occupancy: readonly {
    readonly category: string;
    readonly queue_ahead_bucket: string;
    readonly regime: string;
    readonly spread_bucket: string;
    readonly trade_count: number;
  }[];
};

type Trade = HeldOutTrade & {
  readonly entry_hour_utc: number;
  readonly fidelity_category: string;
  readonly signed_shock_bucket: string;
  readonly time_tier: string;
  readonly vix_band: string;
};

type Summary = {
  readonly exit_reason_distribution: Record<string, number>;
  readonly fail_safe_count: number;
  readonly gross_loss_cents: number;
  readonly gross_profit_cents: number;
  readonly net_pnl_cents: number;
  readonly pf: number | null;
  readonly pf_label: string;
  readonly session_close_count: number;
  readonly stop_loss_count: number;
  readonly target_count: number;
  readonly trade_count: number;
  readonly trade_fraction: number;
  readonly win_rate: number;
  readonly winning_trades: number;
};

type Candidate = {
  readonly candidate_id: string;
  readonly description: string;
  readonly family: string;
  readonly ineligibility_reason: string;
  readonly ld_pf5_eligible: boolean;
  readonly observable_timing: 'pre_entry' | 'coverage_dependent' | 'diagnostic_only' | 'outcome_only';
  readonly passes_ld_pf5: boolean;
  readonly remaining: Summary;
  readonly remaining_fidelity_category_summary: Record<string, Summary>;
  readonly removed: Summary;
  readonly removed_fidelity_category_summary: Record<string, Summary>;
  readonly removed_fail_safe_impact: number;
  readonly removed_stop_loss_impact: number;
  readonly removed_target_damage_cents: number;
};

const TICKET = 'V2-PF-IMPROVEMENT-MECHANISM-SCOPE-01';
const SUBSTRATE_SHA = 'a4174bf58695952589ef72a3b33fba699f85a1fd';
const STRATEGY_ID = 'regime_shock_reversion_short_v2';
const SOURCE_ARTIFACT_PATH =
  'artifacts/held-out-validation/mgmt-bugfix-edge-attribution-02/regime_shock_reversion_short_v2-feb-mar-apr-2026.json';
const SENSITIVITY_ARTIFACT_PATH =
  'artifacts/research/sensitivity-audit-fidelity-coverage-01/v2-sensitivity-audit-fidelity-coverage.json';
const EXPECTED_SOURCE_SHA = 'c9a29e1d6cdb6cc39d07976c2930153342c16ceb59c3145c0e981dd611fde927';
const EXPECTED_SENSITIVITY_SHA = 'df20ca571747372a9bf8069ee59f207e73ab0bfb5452310e1a874937c96714ac';
const OUTPUT_JSON_PATH = 'artifacts/research/v2-pf-improvement-mechanism-scope-01/v2-pf-improvement-mechanism-scope.json';
const OUTPUT_MD_PATH = 'artifacts/research/v2-pf-improvement-mechanism-scope-01/v2-pf-improvement-mechanism-scope.md';
const MEMO_PATH = 'docs/research/v2-pf-improvement-mechanism-scope-01-memo.md';
const BACKLOG_PATH = 'docs/plan/new_app_v1_ticket_backlog_v6.csv';
const BACKLOG_ROW =
  'V2-PF-IMPROVEMENT-MECHANISM-SCOPE-01,P1,1.0,SENSITIVITY-AUDIT-FIDELITY-COVERAGE-01,Scope whether corrected-engine v2 has a pre-entry PF-improvement mechanism worth a future registered-inactive variant; evidence only no strategy or authority change,new_cycle4_v3_research_substrate';

const PF_PASS_THRESHOLD = 1.35;
const MIN_TRADES = 300;
const MAX_REMOVED_FRACTION = 0.5;

function stableJson(value: JsonValue): string {
  return `${JSON.stringify(sortJson(value))}\n`;
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJson(entry));
  }
  if (value !== null && typeof value === 'object') {
    const sorted: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJson(value[key]);
    }
    return sorted;
  }
  return value;
}

function writeDeterministic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const normalized = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/\n*$/u, '\n');
  writeFileSync(path, normalized, 'utf8');
}

function lfSha256(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function fileLfSha256(path: string): string {
  return lfSha256(readFileSync(path, 'utf8'));
}

function parseCents(value: string | number | null): number {
  if (value === null) {
    throw new Error('Null cents value');
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`Invalid cents value: ${String(value)}`);
  }
  return parsed;
}

function maybeCents(value: string | number | null): number | null {
  if (value === null) {
    return null;
  }
  return parseCents(value);
}

function round(value: number, digits = 6): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function cellKey(regime: string, spreadBucket: string, queueAheadBucket: string): string {
  return `${regime}\u0001${spreadBucket}\u0001${queueAheadBucket}`;
}

function entryHourUtc(entryTsNs: string): number {
  return new Date(Number(BigInt(entryTsNs) / 1_000_000n)).getUTCHours();
}

function timeTier(hour: number): string {
  if (hour === 13 || hour === 14) return 'A_open';
  if (hour === 15) return 'B_morning';
  if (hour === 16 || hour === 17) return 'C_late_am';
  if (hour === 18 || hour === 19) return 'D_afternoon';
  if (hour === 20) return 'E_close';
  return 'missing_or_outside_predeclared_tiers';
}

function vixBand(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'missing_or_nonfinite';
  if (value < 0.25) return '<0.25';
  if (value < 0.5) return '0.25-0.50';
  if (value < 0.67) return '0.50-0.67';
  if (value < 0.85) return '0.67-0.85';
  return '>=0.85';
}

function signedShockBucket(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return 'missing_or_nonfinite';
  if (value < 1) return '<1';
  if (value < 2) return '1-2';
  if (value < 3) return '2-3';
  return '>=3';
}

function summarize(trades: readonly Trade[], totalTrades: number): Summary {
  let grossProfit = 0;
  let grossLossMagnitude = 0;
  let netPnl = 0;
  let winningTrades = 0;
  const exitReasons: Record<string, number> = {};
  for (const trade of trades) {
    const pnl = parseCents(trade.net_pnl_cents);
    netPnl += pnl;
    if (pnl > 0) {
      grossProfit += pnl;
      winningTrades += 1;
    } else if (pnl < 0) {
      grossLossMagnitude += Math.abs(pnl);
    }
    exitReasons[trade.exit_reason] = (exitReasons[trade.exit_reason] ?? 0) + 1;
  }
  let pf: number | null = null;
  let pfLabel = 'undefined_no_pnl';
  if (grossLossMagnitude > 0) {
    pf = round(grossProfit / grossLossMagnitude, 6);
    pfLabel = 'finite';
  } else if (grossProfit > 0) {
    pfLabel = 'infinite_no_losses';
  }
  return {
    exit_reason_distribution: Object.fromEntries(Object.entries(exitReasons).sort(([a], [b]) => a.localeCompare(b))),
    fail_safe_count: exitReasons.fail_safe ?? 0,
    gross_loss_cents: -grossLossMagnitude,
    gross_profit_cents: grossProfit,
    net_pnl_cents: netPnl,
    pf,
    pf_label: pfLabel,
    session_close_count: exitReasons.session_close ?? 0,
    stop_loss_count: exitReasons.stop_loss ?? 0,
    target_count: exitReasons.target ?? 0,
    trade_count: trades.length,
    trade_fraction: totalTrades === 0 ? 0 : round(trades.length / totalTrades, 10),
    win_rate: trades.length === 0 ? 0 : round(winningTrades / trades.length, 6),
    winning_trades: winningTrades,
  };
}

function groupSummary(trades: readonly Trade[], keyFn: (trade: Trade) => string): JsonValue[] {
  const groups = new Map<string, Trade[]>();
  for (const trade of trades) {
    const key = keyFn(trade);
    const bucket = groups.get(key) ?? [];
    bucket.push(trade);
    groups.set(key, bucket);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, bucket]) => ({ key, ...toJsonSummary(summarize(bucket, trades.length)) }));
}

function cellSummary(trades: readonly Trade[]): JsonValue[] {
  const groups = new Map<string, Trade[]>();
  for (const trade of trades) {
    const key = cellKey(trade.regime, trade.spread_bucket, trade.queue_ahead_bucket);
    const bucket = groups.get(key) ?? [];
    bucket.push(trade);
    groups.set(key, bucket);
  }
  return [...groups.entries()]
    .map(([key, bucket]) => {
      const [regime, spreadBucket, queueAheadBucket] = key.split('\u0001');
      return {
        queue_ahead_bucket: queueAheadBucket ?? '',
        regime: regime ?? '',
        spread_bucket: spreadBucket ?? '',
        ...toJsonSummary(summarize(bucket, trades.length)),
      };
    })
    .sort((a, b) => String(a.regime).localeCompare(String(b.regime)) || String(a.spread_bucket).localeCompare(String(b.spread_bucket)) || String(a.queue_ahead_bucket).localeCompare(String(b.queue_ahead_bucket)));
}

function toJsonSummary(summary: Summary): JsonValue {
  return summary as unknown as JsonValue;
}

function fidelityBreakdown(trades: readonly Trade[], totalTrades: number): Record<string, Summary> {
  const categories = ['clean', 'unknown_zero_probe', 'unknown_missing_cell', 'low_fidelity'];
  return Object.fromEntries(
    categories.map((categoryName) => [
      categoryName,
      summarize(
        trades.filter((trade) => trade.fidelity_category === categoryName),
        totalTrades,
      ),
    ]),
  );
}

function candidate(
  candidateId: string,
  family: string,
  description: string,
  observableTiming: Candidate['observable_timing'],
  trades: readonly Trade[],
  predicate: (trade: Trade) => boolean,
): Candidate {
  const removed = trades.filter(predicate);
  const remaining = trades.filter((trade) => !predicate(trade));
  const removedSummary = summarize(removed, trades.length);
  const remainingSummary = summarize(remaining, trades.length);
  const rawPasses =
    remainingSummary.pf !== null &&
    remainingSummary.pf >= PF_PASS_THRESHOLD &&
    remainingSummary.trade_count >= MIN_TRADES &&
    remainingSummary.net_pnl_cents > 0 &&
    removedSummary.trade_fraction <= MAX_REMOVED_FRACTION;
  const ldEligible = observableTiming === 'pre_entry';
  const passes = rawPasses && ldEligible;
  const reasons: string[] = [];
  if (remainingSummary.pf === null || remainingSummary.pf < PF_PASS_THRESHOLD) reasons.push('pf_below_1_35');
  if (remainingSummary.trade_count < MIN_TRADES) reasons.push('remaining_trades_below_300');
  if (remainingSummary.net_pnl_cents <= 0) reasons.push('remaining_net_not_positive');
  if (removedSummary.trade_fraction > MAX_REMOVED_FRACTION) reasons.push('removes_more_than_50pct');
  if (!ldEligible) reasons.push(`not_ld_pf5_eligible_${observableTiming}`);
  return {
    candidate_id: candidateId,
    description,
    family,
    ineligibility_reason: reasons.join('; ') || 'eligible',
    ld_pf5_eligible: ldEligible,
    observable_timing: observableTiming,
    passes_ld_pf5: passes,
    remaining: remainingSummary,
    remaining_fidelity_category_summary: fidelityBreakdown(remaining, trades.length),
    removed: removedSummary,
    removed_fidelity_category_summary: fidelityBreakdown(removed, trades.length),
    removed_fail_safe_impact: removedSummary.fail_safe_count,
    removed_stop_loss_impact: removedSummary.stop_loss_count,
    removed_target_damage_cents: removedSummary.gross_profit_cents,
  };
}

function formatDollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${Math.abs(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

function formatPct(value: number): string {
  return `${round(value * 100, 3).toFixed(3)}%`;
}

function formatPf(summary: Summary): string {
  return summary.pf === null ? summary.pf_label : summary.pf.toFixed(6);
}

function markdownTable(headers: readonly string[], rows: readonly (readonly (number | string | boolean))[]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function updateBacklog(): void {
  const existing = readFileSync(BACKLOG_PATH, 'utf8').replace(/\r\n/g, '\n');
  const lines = existing.replace(/\n*$/u, '').split('\n');
  const index = lines.findIndex((line) => line.startsWith(`${TICKET},`));
  if (index >= 0) {
    lines[index] = BACKLOG_ROW;
  } else {
    lines.push(BACKLOG_ROW);
  }
  writeDeterministic(BACKLOG_PATH, lines.join('\n'));
}

function main(): void {
  const sourceText = readFileSync(SOURCE_ARTIFACT_PATH, 'utf8');
  const sensitivityText = readFileSync(SENSITIVITY_ARTIFACT_PATH, 'utf8');
  const sourceSha = lfSha256(sourceText);
  const sensitivitySha = lfSha256(sensitivityText);
  if (sourceSha !== EXPECTED_SOURCE_SHA) throw new Error(`Source artifact SHA mismatch: ${sourceSha}`);
  if (sensitivitySha !== EXPECTED_SENSITIVITY_SHA) throw new Error(`Sensitivity artifact SHA mismatch: ${sensitivitySha}`);
  const source = JSON.parse(sourceText) as HeldOutArtifact;
  const sensitivity = JSON.parse(sensitivityText) as SensitivityArtifact;
  if (source.strategy_id !== STRATEGY_ID || source.schema_version !== 1) throw new Error('Unexpected source artifact identity');
  if (sensitivity.schema_version !== 1 || sensitivity.ticket !== 'SENSITIVITY-AUDIT-FIDELITY-COVERAGE-01') throw new Error('Unexpected sensitivity artifact identity');

  const categoryByCell = new Map<string, string>();
  for (const row of sensitivity.v2_cell_occupancy) {
    categoryByCell.set(cellKey(row.regime, row.spread_bucket, row.queue_ahead_bucket), row.category);
  }

  const trades: Trade[] = source.trades.map((trade) => {
    const entryHour = entryHourUtc(trade.entry_ts_ns);
    const category = categoryByCell.get(cellKey(trade.regime, trade.spread_bucket, trade.queue_ahead_bucket));
    if (category === undefined) throw new Error(`Missing PR #283 category for trade cell ${trade.regime}/${trade.spread_bucket}/${trade.queue_ahead_bucket}`);
    return {
      ...trade,
      entry_hour_utc: entryHour,
      fidelity_category: category,
      signed_shock_bucket: signedShockBucket(trade.signed_shock_vwap?.value),
      time_tier: timeTier(entryHour),
      vix_band: vixBand(trade.vix_prior_close_percentile),
    };
  });

  const baseline = summarize(trades, trades.length);
  if (baseline.trade_count !== 1098 || baseline.net_pnl_cents !== 184200 || source.aggregate.profit_factor_ppm !== 1_241_954) {
    throw new Error('Baseline source anchors do not match expected PR #281 values');
  }

  const sensitivityCategoryParity = Object.fromEntries(
    Object.entries(sensitivity.category_summary).map(([key, value]) => {
      const actual = summarize(trades.filter((trade) => {
        if (key === 'unknown_total') return trade.fidelity_category === 'unknown_missing_cell' || trade.fidelity_category === 'unknown_zero_probe';
        return trade.fidelity_category === key;
      }), trades.length);
      const expected = value as { trade_count?: number; net_pnl_cents?: number };
      return [key, actual.trade_count === expected.trade_count && actual.net_pnl_cents === expected.net_pnl_cents];
    }),
  );
  if (Object.values(sensitivityCategoryParity).some((value) => value !== true)) {
    throw new Error('PR #283 category parity failed');
  }

  const grossProfit = parseCents(source.aggregate.gross_profit_cents);
  const grossLossMagnitude = Math.abs(parseCents(source.aggregate.gross_loss_cents));
  const lossReductionForPfPass = grossLossMagnitude - grossProfit / PF_PASS_THRESHOLD;
  const profitIncreaseForPfPass = grossLossMagnitude * PF_PASS_THRESHOLD - grossProfit;

  const candidates: Candidate[] = [];
  const lowRegimeTrades = trades.filter((trade) => trade.regime === 'low');
  const lowRegimeIsCoverageDependent =
    lowRegimeTrades.length > 0 &&
    lowRegimeTrades.every(
      (trade) => trade.fidelity_category === 'unknown_zero_probe' || trade.fidelity_category === 'unknown_missing_cell',
    );
  candidates.push(
    candidate(
      'exclude_regime_low',
      'low_regime_exclusion',
      lowRegimeIsCoverageDependent
        ? 'Exclude all low-regime trades; in this source artifact this is coextensive with PR #283 unknown zero-probe fidelity coverage.'
        : 'Exclude all low-regime trades.',
      lowRegimeIsCoverageDependent ? 'coverage_dependent' : 'pre_entry',
      trades,
      (trade) => trade.regime === 'low',
    ),
  );
  candidates.push(candidate('exclude_unknown_zero_probe', 'fidelity_category_exclusion', 'Exclude PR #283 unknown zero-probe fidelity cells.', 'coverage_dependent', trades, (trade) => trade.fidelity_category === 'unknown_zero_probe'));
  candidates.push(candidate('exclude_unknown_missing_cell', 'fidelity_category_exclusion', 'Exclude PR #283 missing fidelity cells.', 'coverage_dependent', trades, (trade) => trade.fidelity_category === 'unknown_missing_cell'));
  for (const row of sensitivity.v2_cell_occupancy.filter((row) => row.regime === 'low').sort((a, b) => b.trade_count - a.trade_count || a.spread_bucket.localeCompare(b.spread_bucket) || a.queue_ahead_bucket.localeCompare(b.queue_ahead_bucket))) {
    const timing: Candidate['observable_timing'] = row.category === 'unknown_zero_probe' || row.category === 'unknown_missing_cell' ? 'coverage_dependent' : 'pre_entry';
    const id = `exclude_low_${row.spread_bucket}_${row.queue_ahead_bucket}`.replace(/[^a-zA-Z0-9]+/gu, '_').replace(/_$/u, '');
    candidates.push(candidate(id, 'low_regime_spread_queue_cell_exclusion', `Exclude low-regime ${row.spread_bucket} / ${row.queue_ahead_bucket} trades.`, timing, trades, (trade) => trade.regime === row.regime && trade.spread_bucket === row.spread_bucket && trade.queue_ahead_bucket === row.queue_ahead_bucket));
  }
  for (const tier of ['A_open', 'B_morning', 'C_late_am', 'D_afternoon', 'E_close']) {
    candidates.push(candidate(`exclude_time_tier_${tier}`, 'time_tier_exclusion', `Exclude fixed time tier ${tier}.`, 'pre_entry', trades, (trade) => trade.time_tier === tier));
  }
  for (const band of ['<0.25', '0.25-0.50', '0.50-0.67', '0.67-0.85', '>=0.85', 'missing_or_nonfinite']) {
    candidates.push(candidate(`exclude_vix_${band}`.replace(/[^a-zA-Z0-9]+/gu, '_').replace(/_$/u, ''), 'vix_band_exclusion', `Exclude VIX percentile band ${band}.`, 'pre_entry', trades, (trade) => trade.vix_band === band));
  }
  for (const bucket of ['<1', '1-2', '2-3', '>=3', 'missing_or_nonfinite']) {
    candidates.push(candidate(`exclude_signed_shock_${bucket}`.replace(/[^a-zA-Z0-9]+/gu, '_').replace(/_$/u, ''), 'signed_shock_bucket_exclusion', `Exclude signed-shock bucket ${bucket}.`, 'pre_entry', trades, (trade) => trade.signed_shock_bucket === bucket));
  }
  candidates.push(candidate('diagnostic_exit_stop_loss', 'diagnostic_only_outcome_exclusion', 'Outcome-only: exclude stop-loss exits.', 'outcome_only', trades, (trade) => trade.exit_reason === 'stop_loss'));
  candidates.push(candidate('diagnostic_mae_le_minus_2000', 'diagnostic_only_outcome_exclusion', 'Outcome-only: exclude trades with MAE <= -2000 cents.', 'outcome_only', trades, (trade) => parseCents(trade.max_adverse_excursion_cents) <= -2000));
  candidates.push(candidate('diagnostic_first_minute_close_le_minus_400', 'diagnostic_only_early_post_entry', 'Diagnostic-only: exclude observed first-minute close <= -400 cents.', 'diagnostic_only', trades, (trade) => maybeCents(trade.first_minute_close_pnl_cents) !== null && Number(maybeCents(trade.first_minute_close_pnl_cents)) <= -400));

  const sortedCandidates = [...candidates].sort((a, b) => {
    const pfA = a.remaining.pf ?? -1;
    const pfB = b.remaining.pf ?? -1;
    return Number(b.passes_ld_pf5) - Number(a.passes_ld_pf5) || pfB - pfA || b.remaining.net_pnl_cents - a.remaining.net_pnl_cents || a.candidate_id.localeCompare(b.candidate_id);
  });
  const passingEligible = sortedCandidates.filter((candidateRow) => candidateRow.passes_ld_pf5);
  const passingCoverageDependent = sortedCandidates.filter(
    (candidateRow) =>
      candidateRow.observable_timing === 'coverage_dependent' &&
      candidateRow.remaining.pf !== null &&
      candidateRow.remaining.pf >= PF_PASS_THRESHOLD &&
      candidateRow.remaining.trade_count >= MIN_TRADES &&
      candidateRow.remaining.net_pnl_cents > 0 &&
      candidateRow.removed.trade_fraction <= MAX_REMOVED_FRACTION,
  );
  const determination =
    passingEligible.length > 0
      ? 'REGISTERED_INACTIVE_VARIANT_SCOPE_JUSTIFIED'
      : passingCoverageDependent.length > 0
        ? 'FIDELITY_COVERAGE_DEPENDENT_MECHANISM'
        : 'NO_VARIANT_JUSTIFIED';
  const recommendedNextTicket =
    determination === 'FIDELITY_COVERAGE_DEPENDENT_MECHANISM'
      ? 'QFA-402C-FIDELITY-COVERAGE-EXTEND-01'
      : determination === 'REGISTERED_INACTIVE_VARIANT_SCOPE_JUSTIFIED'
        ? 'V2-PF-REGISTERED-INACTIVE-VARIANT-SCOPE-01'
        : 'NO_FURTHER_V2_PF_VARIANT_WORK';

  const featureInventory: JsonValue[] = [
    { field: 'regime', status: 'available', timing: 'pre_entry' },
    { field: 'spread_bucket', status: 'available', timing: 'pre_entry' },
    { field: 'queue_ahead_bucket', status: 'available', timing: 'pre_entry' },
    { field: 'session_id', status: 'available', timing: 'diagnostic_only' },
    { field: 'UTC entry hour / fixed time tier', status: 'derivable', timing: 'pre_entry' },
    { field: 'vix_value', status: 'available', timing: 'pre_entry' },
    { field: 'vix_fresh', status: 'available', timing: 'pre_entry' },
    { field: 'vix_prior_close_percentile', status: 'available', timing: 'pre_entry' },
    { field: 'signed_shock_vwap.value', status: 'available', timing: 'pre_entry' },
    { field: 'signed_shock_vwap_recent_values', status: 'available', timing: 'pre_entry' },
    { field: 'exit_reason / MAE / MFE / final PnL', status: 'available', timing: 'outcome_only' },
    { field: 'first completed post-entry bar fields', status: 'partially_available', timing: 'diagnostic_only' },
  ];

  const output: JsonValue = {
    authority_caveat:
      'Evidence only. v2 remains REGISTERED_INACTIVE; no strategy, roster, paper, broker/live, Phase 6, qfa-611, qfa-402c, risk/sizing, held-out artifact, or ADR authority is changed.',
    baseline: {
      ...toJsonSummary(baseline),
      artifact_profit_factor: source.aggregate.profit_factor_ppm / 1_000_000,
    },
    candidate_mechanisms: sortedCandidates as unknown as JsonValue,
    category_summaries: {
      by_cell: cellSummary(trades),
      by_fidelity_category: groupSummary(trades, (trade) => trade.fidelity_category),
      by_regime: groupSummary(trades, (trade) => trade.regime),
      by_signed_shock_bucket: groupSummary(trades, (trade) => trade.signed_shock_bucket),
      by_time_tier: groupSummary(trades, (trade) => trade.time_tier),
      by_vix_band: groupSummary(trades, (trade) => trade.vix_band),
    },
    determination: {
      code: determination,
      coverage_dependent_precedence:
        'Coverage-dependent candidates cannot justify registered-inactive variants even when they meet numerical PF/trade/net/removal thresholds.',
      best_candidate: sortedCandidates[0] as unknown as JsonValue,
    },
    diagnostic_only_findings: {
      first_minute_close_le_minus_400: sortedCandidates.find((row) => row.candidate_id === 'diagnostic_first_minute_close_le_minus_400') as unknown as JsonValue,
      mae_le_minus_2000: sortedCandidates.find((row) => row.candidate_id === 'diagnostic_mae_le_minus_2000') as unknown as JsonValue,
      stop_loss_exclusion: sortedCandidates.find((row) => row.candidate_id === 'diagnostic_exit_stop_loss') as unknown as JsonValue,
    },
    feature_inventory: featureInventory,
    pf_gap: {
      fixed_gross_loss_profit_increase_cents: round(profitIncreaseForPfPass, 6),
      fixed_gross_profit_loss_reduction_cents: round(lossReductionForPfPass, 6),
      pf_pass_threshold: PF_PASS_THRESHOLD,
    },
    recommended_next_ticket: recommendedNextTicket,
    schema_version: 1,
    source_artifacts: {
      pr281_v2_corrected_engine: { path: SOURCE_ARTIFACT_PATH, sha256: sourceSha },
      pr283_sensitivity_coverage: {
        category_parity: sensitivityCategoryParity as unknown as JsonValue,
        path: SENSITIVITY_ARTIFACT_PATH,
        route: sensitivity.routing.code,
        sha256: sensitivitySha,
      },
    },
    source_substrate: { base: `origin/main@${SUBSTRATE_SHA}`, includes_prs: ['#281', '#282', '#283'] },
    ticket: TICKET,
  };

  const candidateRows = sortedCandidates.slice(0, 12).map((row) => [
    row.candidate_id,
    row.observable_timing,
    row.remaining.trade_count,
    formatPf(row.remaining),
    formatDollars(row.remaining.net_pnl_cents),
    row.removed.trade_count,
    formatPct(row.removed.trade_fraction),
    row.passes_ld_pf5,
    row.ineligibility_reason,
  ]);

  const artifactMarkdown = [
    `# ${TICKET} artifact`,
    '',
    '## Baseline PF gap',
    '',
    markdownTable(
      ['Item', 'Value'],
      [
        ['Trades', baseline.trade_count],
        ['Gross profit', formatDollars(baseline.gross_profit_cents)],
        ['Gross loss', formatDollars(baseline.gross_loss_cents)],
        ['Net PnL', formatDollars(baseline.net_pnl_cents)],
        ['Artifact PF', (source.aggregate.profit_factor_ppm / 1_000_000).toFixed(6)],
        ['Loss reduction to PF 1.35', formatDollars(Math.round(lossReductionForPfPass))],
        ['Profit increase to PF 1.35', formatDollars(Math.round(profitIncreaseForPfPass))],
      ],
    ),
    '',
    '## Candidate mechanism summary',
    '',
    markdownTable(
      ['Candidate', 'Timing', 'Remaining trades', 'Remaining PF', 'Remaining net', 'Removed trades', 'Removed fraction', 'LD-PF-5 pass', 'Reason'],
      candidateRows,
    ),
    '',
    '## Best candidate fidelity-category proof',
    '',
    markdownTable(
      ['Side', 'Fidelity category', 'Trades', 'PF', 'Net PnL'],
      Object.entries(sortedCandidates[0]?.removed_fidelity_category_summary ?? {})
        .map(([categoryName, summary]) => [
          'removed',
          categoryName,
          summary.trade_count,
          formatPf(summary),
          formatDollars(summary.net_pnl_cents),
        ])
        .concat(
          Object.entries(sortedCandidates[0]?.remaining_fidelity_category_summary ?? {}).map(([categoryName, summary]) => [
            'remaining',
            categoryName,
            summary.trade_count,
            formatPf(summary),
            formatDollars(summary.net_pnl_cents),
          ]),
        ),
    ),
    '',
    '## Regime summary',
    '',
    markdownTable(
      ['Regime', 'Trades', 'PF', 'Net PnL'],
      (groupSummary(trades, (trade) => trade.regime) as { key: string; trade_count: number; pf: number | null; pf_label: string; net_pnl_cents: number }[]).map((row) => [
        row.key,
        row.trade_count,
        row.pf === null ? row.pf_label : row.pf.toFixed(6),
        formatDollars(row.net_pnl_cents),
      ]),
    ),
    '',
    '## Fidelity category summary',
    '',
    markdownTable(
      ['Category', 'Trades', 'PF', 'Net PnL'],
      (groupSummary(trades, (trade) => trade.fidelity_category) as { key: string; trade_count: number; pf: number | null; pf_label: string; net_pnl_cents: number }[]).map((row) => [
        row.key,
        row.trade_count,
        row.pf === null ? row.pf_label : row.pf.toFixed(6),
        formatDollars(row.net_pnl_cents),
      ]),
    ),
    '',
    '## Determination',
    '',
    `Determination: \`${determination}\`. Recommended next ticket: \`${recommendedNextTicket}\`.`,
  ].join('\n');

  const memo = [
    `# ${TICKET} memo`,
    '',
    '## 1. Context',
    '',
    'This diagnostic scopes whether corrected-engine v2 has a concrete pre-entry PF-improvement mechanism worth a future registered-inactive variant. It follows PR #281 corrected-engine evidence, PR #282 sizing evidence, and PR #283 sensitivity coverage attribution.',
    '',
    '## 2. Source artifacts',
    '',
    markdownTable(
      ['Artifact', 'Path', 'SHA-256'],
      [
        ['PR #281 v2 held-out', SOURCE_ARTIFACT_PATH, sourceSha],
        ['PR #283 sensitivity coverage', SENSITIVITY_ARTIFACT_PATH, sensitivitySha],
      ],
    ),
    '',
    '## 3. Baseline PF gap',
    '',
    `Baseline PF is ${(source.aggregate.profit_factor_ppm / 1_000_000).toFixed(6)} on ${baseline.trade_count} trades. Holding gross profit fixed, gross loss must fall by about ${formatDollars(Math.round(lossReductionForPfPass))} to reach PF 1.35. Holding gross loss fixed, gross profit must rise by about ${formatDollars(Math.round(profitIncreaseForPfPass))}.`,
    '',
    '## 4. Feature inventory',
    '',
    markdownTable(
      ['Field', 'Status', 'Timing'],
      (featureInventory as { field: string; status: string; timing: string }[]).map((row) => [row.field, row.status, row.timing]),
    ),
    '',
    '## 5. Regime/fidelity/cell attribution',
    '',
    'PR #283 category provenance is used as the authoritative fidelity source and was parity-checked against this trade set. Clean fidelity cells clear PF 1.35, while unknown zero-probe cells sit at PF 1.0. This is analytically useful but remains coverage-dependent.',
    '',
    '## 6. Time/VIX/signed-shock attribution',
    '',
    'The extractor evaluates only fixed packet-defined time tiers, VIX bands, and signed-shock buckets. It does not search arbitrary thresholds or combinations.',
    '',
    '## 7. Candidate mechanism table',
    '',
    markdownTable(
      ['Candidate', 'Timing', 'Remaining trades', 'Remaining PF', 'Removed fraction', 'LD-PF-5 pass', 'Reason'],
      candidateRows.map((row) => [row[0], row[1], row[2], row[3], row[6], row[7], row[8]]),
    ),
    '',
    '## 8. Diagnostic-only outcome findings',
    '',
    'Outcome-only and early-post-entry fields were evaluated for explanation only. They do not justify a pre-entry variant and cannot satisfy LD-PF-5 in this ticket.',
    '',
    '## 9. Determination',
    '',
    `Determination: \`${determination}\`. The best non-coverage-dependent single pre-entry rule is \`${sortedCandidates[0]?.candidate_id ?? 'none'}\`, which passes LD-PF-5 with remaining PF ${sortedCandidates[0]?.remaining.pf ?? 'null'} on ${sortedCandidates[0]?.remaining.trade_count ?? 0} trades. Coverage-dependent low-regime / zero-probe exclusions are explicitly not used as variant justification.`,
    '',
    'Best candidate fidelity-category proof:',
    '',
    markdownTable(
      ['Side', 'Fidelity category', 'Trades', 'PF', 'Net PnL'],
      Object.entries(sortedCandidates[0]?.removed_fidelity_category_summary ?? {})
        .map(([categoryName, summary]) => [
          'removed',
          categoryName,
          summary.trade_count,
          formatPf(summary),
          formatDollars(summary.net_pnl_cents),
        ])
        .concat(
          Object.entries(sortedCandidates[0]?.remaining_fidelity_category_summary ?? {}).map(([categoryName, summary]) => [
            'remaining',
            categoryName,
            summary.trade_count,
            formatPf(summary),
            formatDollars(summary.net_pnl_cents),
          ]),
        ),
    ),
    '',
    '## 10. Recommended next ticket',
    '',
    `Recommended next ticket: \`${recommendedNextTicket}\`. If the operator wants to continue this lane, qfa-402c low-regime zero-probe coverage should be repaired before treating the PF drag as strategy logic.`,
    '',
    '## 11. Verification',
    '',
    'The deterministic extractor writes the JSON artifact, Markdown artifact, memo, and backlog row. Required verification commands and hashes are reported in the worker PENDING-REVIEW note.',
    '',
    '## 12. Authority caveat',
    '',
    '`regime_shock_reversion_short_v2` remains REGISTERED_INACTIVE. This ticket does not implement a variant, mutate v2, change strategy/runtime/qfa/risk/sizing code, alter held-out artifacts, or create paper/live/broker/Phase 6/ADR authority.',
  ].join('\n');

  writeDeterministic(OUTPUT_JSON_PATH, stableJson(output));
  writeDeterministic(OUTPUT_MD_PATH, artifactMarkdown);
  writeDeterministic(MEMO_PATH, memo);
  updateBacklog();

  for (const path of [OUTPUT_JSON_PATH, OUTPUT_MD_PATH, MEMO_PATH, BACKLOG_PATH]) {
    console.log(`${path} ${fileLfSha256(path)}`);
  }
  console.log(`source_sha=${sourceSha}`);
  console.log(`sensitivity_sha=${sensitivitySha}`);
  console.log(`loss_reduction_for_pf_1_35_cents=${round(lossReductionForPfPass, 6)}`);
  console.log(`profit_increase_for_pf_1_35_cents=${round(profitIncreaseForPfPass, 6)}`);
  console.log(`best_candidate=${sortedCandidates[0]?.candidate_id ?? 'none'}`);
  console.log(`best_candidate_remaining_pf=${sortedCandidates[0]?.remaining.pf ?? 'null'}`);
  console.log(
    `best_candidate_fidelity_category_proof=${JSON.stringify({
      remaining: sortedCandidates[0]?.remaining_fidelity_category_summary ?? {},
      removed: sortedCandidates[0]?.removed_fidelity_category_summary ?? {},
    })}`,
  );
  console.log(
    `candidate_table_summary=${JSON.stringify(
      sortedCandidates.slice(0, 8).map((row) => ({
        candidate_id: row.candidate_id,
        ineligibility_reason: row.ineligibility_reason,
        observable_timing: row.observable_timing,
        passes_ld_pf5: row.passes_ld_pf5,
        remaining_net_pnl_cents: row.remaining.net_pnl_cents,
        remaining_pf: row.remaining.pf,
        remaining_trades: row.remaining.trade_count,
        removed_fraction: row.removed.trade_fraction,
        removed_trades: row.removed.trade_count,
      })),
    )}`,
  );
  console.log(`determination=${determination}`);
  console.log(`recommended_next_ticket=${recommendedNextTicket}`);
}

main();
