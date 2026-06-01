import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type HeldOutTrade = {
  readonly entry_ts_ns: string;
  readonly exit_reason: string;
  readonly net_pnl_cents: string | number;
  readonly queue_ahead_bucket: string;
  readonly regime: string;
  readonly session_id?: string;
  readonly spread_bucket: string;
  readonly vix_prior_close_percentile?: number | null;
};

type HeldOutArtifact = {
  readonly aggregate: {
    readonly net_pnl_cents: string | number;
    readonly profit_factor_ppm: number;
    readonly total_trades: number;
  };
  readonly schema_version: number;
  readonly strategy_id: string;
  readonly trades: readonly HeldOutTrade[];
};

type SelectionArtifact = {
  readonly per_strategy: readonly [{
    readonly sensitivity_audit: SensitivityAudit;
    readonly threshold_results: Record<string, boolean>;
    readonly verdict: string;
    readonly verdict_reason: string;
  }];
  readonly summary: {
    readonly phase_6_dispatch_authorized: boolean;
  };
  readonly thresholds: {
    readonly sensitivity_concentration_fraction: number;
    readonly sensitivity_low_fidelity_share_ppm: number;
  };
};

type PriorAuditArtifact = {
  readonly category_summary: Record<string, PnlSummary>;
  readonly source_artifacts: Record<string, unknown>;
};

type FidelityCell = {
  readonly probe_count: number;
  readonly queue_ahead_bucket: string;
  readonly regime: string;
  readonly share_ppm: number;
  readonly spread_bucket: string;
  readonly within_tolerance_count: number;
};

type FidelityArtifact = {
  readonly cells: readonly FidelityCell[];
  readonly methodology_id: string;
  readonly schema_version: number;
};

type SensitivityAudit = {
  readonly flag: boolean;
  readonly flagged_cells: readonly SensitivityCellRow[];
  readonly low_fidelity_trade_count: number;
  readonly low_fidelity_trade_fraction: number;
  readonly reason: string;
  readonly total_trades: number;
  readonly unknown_cell_trade_count: number;
  readonly unknown_cell_trade_fraction: number;
};

type SensitivityCellRow = {
  readonly cell_status: 'low_fidelity' | 'unknown';
  readonly probe_count: number | null;
  readonly queue_ahead_bucket: string;
  readonly regime: string;
  readonly share_ppm: number | null;
  readonly spread_bucket: string;
  readonly strategy_trade_count: number;
  readonly strategy_trade_fraction: number;
};

type CellCategory = 'clean' | 'low_fidelity' | 'unknown_missing_cell' | 'unknown_zero_probe';

type TradeRecord = {
  readonly category: CellCategory;
  readonly cell: FidelityCell | null;
  readonly key: string;
  readonly trade: HeldOutTrade;
};

type PnlSummary = {
  readonly exit_reason_distribution: Record<string, number>;
  readonly gross_loss_cents: number;
  readonly gross_profit_cents: number;
  readonly net_pnl_cents: number;
  readonly pf: number | null;
  readonly pf_label: string;
  readonly trade_count: number;
  readonly trade_fraction: number;
  readonly win_rate: number;
  readonly winning_trades: number;
};

const TICKET = 'V2-PF-C-LATE-AM-FIDELITY-COVERAGE-RECHECK-01';
const SUBSTRATE_SHA = '7441e73ddf164aeb71fcec41a0597002d632cce3';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';

const HELD_OUT_PATH =
  'artifacts/held-out-validation/v2-pf-c-late-am-registered-inactive-impl-01/regime_shock_reversion_short_v2_utc_16_18_exclusion-feb-mar-apr-2026.json';
const SELECTION_PATH =
  'artifacts/strategy-selection/strategy-selection-v2-pf-c-late-am-registered-inactive-impl-01.json';
const PRIOR_AUDIT_PATH =
  'artifacts/research/sensitivity-audit-fidelity-coverage-01/v2-sensitivity-audit-fidelity-coverage.json';
const FIDELITY_CELLS_PATH = 'artifacts/regime-fidelity/qfa-402c-stratified-cells-v1.json';

const EXPECTED_HELD_OUT_RAW_SHA = 'e77e7eef8b0dc588029fbb4318de399253dd64f1277ed4f0c05c5ba9b5192817';
const EXPECTED_SELECTION_RAW_SHA = '97b2e5dd1bbbfd6faa48762a755b9fe023321096572ac6449034a8c4b3a32e15';
const EXPECTED_PRIOR_AUDIT_LF_SHA = 'df20ca571747372a9bf8069ee59f207e73ab0bfb5452310e1a874937c96714ac';
const EXPECTED_FIDELITY_RAW_SHA = 'fe17a87886ad7282292d4e1ed9e99fb51bb6c0e8a572475364568715614b8866';

const OUTPUT_JSON_PATH =
  'artifacts/research/v2-pf-c-late-am-fidelity-coverage-recheck-01/v2-pf-c-late-am-fidelity-coverage-recheck.json';
const OUTPUT_MD_PATH =
  'artifacts/research/v2-pf-c-late-am-fidelity-coverage-recheck-01/v2-pf-c-late-am-fidelity-coverage-recheck.md';
const MEMO_PATH = 'docs/research/v2-pf-c-late-am-fidelity-coverage-recheck-01-memo.md';
const BACKLOG_PATH = 'docs/plan/new_app_v1_ticket_backlog_v6.csv';
const BACKLOG_ROW =
  'V2-PF-C-LATE-AM-FIDELITY-COVERAGE-RECHECK-01,P1,1.0,V2-PF-C-LATE-AM-REGISTERED-INACTIVE-IMPL-01,Recheck qfa-611 sensitivity failure for the registered-inactive v2 UTC 16-18 exclusion variant and classify missing-cell fidelity coverage versus strategy fragility without behavior or authority change,new_v2_pf_research_substrate';

function rawSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function lfSha256(path: string): string {
  return createHash('sha256')
    .update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'), 'utf8')
    .digest('hex');
}

function stableJson(value: JsonValue): string {
  return `${JSON.stringify(sortJson(value))}\n`;
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJson(entry));
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, JsonValue> = {};
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

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function parseCents(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`Invalid cents value: ${String(value)}`);
  }
  return parsed;
}

function round(value: number, digits = 6): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function cellKeyFromParts(regime: string, spreadBucket: string, queueAheadBucket: string): string {
  return `${regime}\u0001${spreadBucket}\u0001${queueAheadBucket}`;
}

function cellKeyFromTrade(trade: HeldOutTrade): string {
  return cellKeyFromParts(trade.regime, trade.spread_bucket, trade.queue_ahead_bucket);
}

function splitKey(key: string): readonly [string, string, string] {
  const parts = key.split('\u0001');
  if (parts.length !== 3) {
    throw new Error(`Invalid cell key: ${key}`);
  }
  return [parts[0] ?? '', parts[1] ?? '', parts[2] ?? ''];
}

function categoryForCell(cell: FidelityCell | undefined, lowFidelitySharePpm: number): CellCategory {
  if (cell === undefined) {
    return 'unknown_missing_cell';
  }
  if (cell.probe_count === 0) {
    return 'unknown_zero_probe';
  }
  if (cell.share_ppm < lowFidelitySharePpm) {
    return 'low_fidelity';
  }
  return 'clean';
}

function summarize(records: readonly TradeRecord[], totalTrades: number): PnlSummary {
  let grossProfit = 0;
  let grossLossMagnitude = 0;
  let netPnl = 0;
  let winningTrades = 0;
  const exitReasons: Record<string, number> = {};

  for (const record of records) {
    const pnl = parseCents(record.trade.net_pnl_cents);
    netPnl += pnl;
    if (pnl > 0) {
      grossProfit += pnl;
      winningTrades += 1;
    } else if (pnl < 0) {
      grossLossMagnitude += Math.abs(pnl);
    }
    exitReasons[record.trade.exit_reason] = (exitReasons[record.trade.exit_reason] ?? 0) + 1;
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
    exit_reason_distribution: Object.fromEntries(
      Object.entries(exitReasons).sort(([left], [right]) => left.localeCompare(right)),
    ),
    gross_loss_cents: -grossLossMagnitude,
    gross_profit_cents: grossProfit,
    net_pnl_cents: netPnl,
    pf,
    pf_label: pfLabel,
    trade_count: records.length,
    trade_fraction: totalTrades === 0 ? 0 : round(records.length / totalTrades, 10),
    win_rate: records.length === 0 ? 0 : round(winningTrades / records.length, 6),
    winning_trades: winningTrades,
  };
}

function buildSensitivityAudit(
  records: readonly TradeRecord[],
  cells: ReadonlyMap<string, FidelityCell>,
  concentrationFraction: number,
): SensitivityAudit {
  const lowCounts = new Map<string, number>();
  const unknownCounts = new Map<string, number>();
  for (const record of records) {
    if (record.category === 'unknown_missing_cell' || record.category === 'unknown_zero_probe') {
      unknownCounts.set(record.key, (unknownCounts.get(record.key) ?? 0) + 1);
    } else if (record.category === 'low_fidelity') {
      lowCounts.set(record.key, (lowCounts.get(record.key) ?? 0) + 1);
    }
  }

  const totalTrades = records.length;
  const lowCount = [...lowCounts.values()].reduce((acc, count) => acc + count, 0);
  const unknownCount = [...unknownCounts.values()].reduce((acc, count) => acc + count, 0);
  const lowFraction = totalTrades === 0 ? 0 : lowCount / totalTrades;
  const unknownFraction = totalTrades === 0 ? 0 : unknownCount / totalTrades;
  const missingFlag = totalTrades > 0 && unknownFraction >= concentrationFraction;
  const lowFlag = totalTrades > 0 && lowFraction >= concentrationFraction;

  const flaggedCells: SensitivityCellRow[] = [];
  for (const [cellStatus, counts] of [
    ['low_fidelity', lowCounts],
    ['unknown', unknownCounts],
  ] as const) {
    for (const [key, count] of [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const [regime, spreadBucket, queueAheadBucket] = splitKey(key);
      const cell = cells.get(key);
      flaggedCells.push({
        cell_status: cellStatus,
        probe_count: cell === undefined ? null : cell.probe_count,
        queue_ahead_bucket: queueAheadBucket,
        regime,
        share_ppm: cell === undefined ? null : cell.share_ppm,
        spread_bucket: spreadBucket,
        strategy_trade_count: count,
        strategy_trade_fraction: totalTrades === 0 ? 0 : count / totalTrades,
      });
    }
  }

  return {
    flag: missingFlag || lowFlag,
    flagged_cells: flaggedCells,
    low_fidelity_trade_count: lowCount,
    low_fidelity_trade_fraction: lowFraction,
    reason: missingFlag ? 'missing_cell_concentration' : lowFlag ? 'low_fidelity_concentration' : 'clean',
    total_trades: totalTrades,
    unknown_cell_trade_count: unknownCount,
    unknown_cell_trade_fraction: unknownFraction,
  };
}

function sensitivityAuditsMatch(reproduced: SensitivityAudit, expected: SensitivityAudit): boolean {
  if (
    reproduced.flag !== expected.flag
    || reproduced.reason !== expected.reason
    || reproduced.total_trades !== expected.total_trades
    || reproduced.low_fidelity_trade_count !== expected.low_fidelity_trade_count
    || reproduced.unknown_cell_trade_count !== expected.unknown_cell_trade_count
    || !nearlyEqual(reproduced.low_fidelity_trade_fraction, expected.low_fidelity_trade_fraction)
    || !nearlyEqual(reproduced.unknown_cell_trade_fraction, expected.unknown_cell_trade_fraction)
    || reproduced.flagged_cells.length !== expected.flagged_cells.length
  ) {
    return false;
  }

  const sortRows = (rows: readonly SensitivityCellRow[]) => [...rows].sort((left, right) => (
    left.cell_status.localeCompare(right.cell_status)
    || left.regime.localeCompare(right.regime)
    || left.spread_bucket.localeCompare(right.spread_bucket)
    || left.queue_ahead_bucket.localeCompare(right.queue_ahead_bucket)
  ));
  const reproducedRows = sortRows(reproduced.flagged_cells);
  const expectedRows = sortRows(expected.flagged_cells);
  return reproducedRows.every((row, index) => {
    const expectedRow = expectedRows[index]!;
    return (
      row.cell_status === expectedRow.cell_status
      && row.regime === expectedRow.regime
      && row.spread_bucket === expectedRow.spread_bucket
      && row.queue_ahead_bucket === expectedRow.queue_ahead_bucket
      && row.strategy_trade_count === expectedRow.strategy_trade_count
      && row.probe_count === expectedRow.probe_count
      && row.share_ppm === expectedRow.share_ppm
      && nearlyEqual(row.strategy_trade_fraction, expectedRow.strategy_trade_fraction)
    );
  });
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9;
}

function recordsForCategory(records: readonly TradeRecord[], category: CellCategory | 'unknown_total'): readonly TradeRecord[] {
  if (category === 'unknown_total') {
    return records.filter((record) => (
      record.category === 'unknown_missing_cell' || record.category === 'unknown_zero_probe'
    ));
  }
  return records.filter((record) => record.category === category);
}

function summarizeByDimension(
  records: readonly TradeRecord[],
  totalTrades: number,
  dimension: string,
  getValue: (trade: HeldOutTrade) => string,
): readonly JsonValue[] {
  const groups = new Map<string, TradeRecord[]>();
  for (const record of records) {
    const key = getValue(record.trade);
    const bucket = groups.get(key) ?? [];
    bucket.push(record);
    groups.set(key, bucket);
  }
  return [...groups.entries()]
    .map(([value, bucket]) => ({
      dimension,
      value,
      ...summaryForJson(summarize(bucket, totalTrades)),
    }))
    .sort((left, right) => (
      Number(right.trade_count) - Number(left.trade_count)
      || String(left.value).localeCompare(String(right.value))
    )) as JsonValue[];
}

function summaryForJson(summary: PnlSummary): Record<string, JsonValue> {
  return {
    exit_reason_distribution: summary.exit_reason_distribution,
    gross_loss_cents: summary.gross_loss_cents,
    gross_profit_cents: summary.gross_profit_cents,
    net_pnl_cents: summary.net_pnl_cents,
    pf: summary.pf,
    pf_label: summary.pf_label,
    trade_count: summary.trade_count,
    trade_fraction: summary.trade_fraction,
    win_rate: summary.win_rate,
    winning_trades: summary.winning_trades,
  };
}

function utcDateFromNs(ns: string): string {
  return new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().slice(0, 10);
}

function utcHourFromNs(ns: string): string {
  const hourNs = 3_600_000_000_000n;
  const dayNs = 24n * hourNs;
  const normalized = ((BigInt(ns) % dayNs) + dayNs) % dayNs;
  return String(Number(normalized / hourNs)).padStart(2, '0');
}

function vixBand(trade: HeldOutTrade): string {
  const value = trade.vix_prior_close_percentile;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'unavailable';
  }
  if (value < 0.25) return '<0.25';
  if (value < 0.5) return '0.25-0.50';
  if (value < 0.67) return '0.50-0.67';
  if (value < 0.85) return '0.67-0.85';
  return '>=0.85';
}

function formatPct(value: number): string {
  return `${round(value * 100, 3).toFixed(3)}%`;
}

function formatDollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${Math.abs(cents / 100).toLocaleString('en-US', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
}

function formatPf(summary: PnlSummary): string {
  return summary.pf === null ? summary.pf_label : summary.pf.toFixed(6);
}

function markdownTable(headers: readonly string[], rows: readonly (readonly (number | string))[]): string {
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

function assertPreflightHashes(): {
  readonly fidelityRawSha: string;
  readonly heldOutRawSha: string;
  readonly priorAuditLfSha: string;
  readonly priorAuditRawSha: string;
  readonly selectionRawSha: string;
} {
  const heldOutRawSha = rawSha256(HELD_OUT_PATH);
  const selectionRawSha = rawSha256(SELECTION_PATH);
  const priorAuditRawSha = rawSha256(PRIOR_AUDIT_PATH);
  const priorAuditLfSha = lfSha256(PRIOR_AUDIT_PATH);
  const fidelityRawSha = rawSha256(FIDELITY_CELLS_PATH);

  if (heldOutRawSha !== EXPECTED_HELD_OUT_RAW_SHA) {
    throw new Error(`Held-out SHA mismatch: ${heldOutRawSha}`);
  }
  if (selectionRawSha !== EXPECTED_SELECTION_RAW_SHA) {
    throw new Error(`Selection SHA mismatch: ${selectionRawSha}`);
  }
  if (priorAuditLfSha !== EXPECTED_PRIOR_AUDIT_LF_SHA) {
    throw new Error(`PR #283 LF-canonical SHA mismatch: ${priorAuditLfSha}`);
  }
  if (fidelityRawSha !== EXPECTED_FIDELITY_RAW_SHA) {
    throw new Error(`qfa-402c fidelity SHA mismatch: ${fidelityRawSha}`);
  }

  return { fidelityRawSha, heldOutRawSha, priorAuditLfSha, priorAuditRawSha, selectionRawSha };
}

function main(): void {
  const sourceShas = assertPreflightHashes();
  const heldOut = readJson<HeldOutArtifact>(HELD_OUT_PATH);
  const selection = readJson<SelectionArtifact>(SELECTION_PATH);
  const priorAudit = readJson<PriorAuditArtifact>(PRIOR_AUDIT_PATH);
  const fidelity = readJson<FidelityArtifact>(FIDELITY_CELLS_PATH);

  if (heldOut.schema_version !== 1 || heldOut.strategy_id !== STRATEGY_ID) {
    throw new Error(`Unexpected held-out identity: ${heldOut.strategy_id} schema ${heldOut.schema_version}`);
  }
  if (heldOut.trades.length !== 739 || heldOut.aggregate.total_trades !== 739) {
    throw new Error(`Held-out trade anchor mismatch: ${heldOut.trades.length}`);
  }
  if (heldOut.aggregate.profit_factor_ppm !== 1_354_742) {
    throw new Error(`PF anchor mismatch: ${heldOut.aggregate.profit_factor_ppm}`);
  }
  if (parseCents(heldOut.aggregate.net_pnl_cents) !== 178_400) {
    throw new Error(`Net PnL anchor mismatch: ${heldOut.aggregate.net_pnl_cents}`);
  }
  const selected = selection.per_strategy[0];
  if (selected.verdict !== 'RESEARCH_FURTHER') {
    throw new Error(`Unexpected qfa-611 verdict: ${selected.verdict}`);
  }
  if (selection.summary.phase_6_dispatch_authorized !== false) {
    throw new Error('Unexpected phase_6_dispatch_authorized=true');
  }
  if (fidelity.schema_version !== 1 || fidelity.methodology_id !== 'qfa-402c-cells-v1') {
    throw new Error(`Unexpected fidelity artifact: ${fidelity.methodology_id} schema ${fidelity.schema_version}`);
  }

  const lowFidelitySharePpm = selection.thresholds.sensitivity_low_fidelity_share_ppm;
  const concentrationFraction = selection.thresholds.sensitivity_concentration_fraction;
  const cellMap = new Map<string, FidelityCell>();
  for (const cell of fidelity.cells) {
    const key = cellKeyFromParts(cell.regime, cell.spread_bucket, cell.queue_ahead_bucket);
    if (cellMap.has(key)) {
      throw new Error(`Duplicate fidelity cell: ${key}`);
    }
    cellMap.set(key, cell);
  }

  const records = heldOut.trades.map((trade): TradeRecord => {
    const key = cellKeyFromTrade(trade);
    const cell = cellMap.get(key);
    return {
      category: categoryForCell(cell, lowFidelitySharePpm),
      cell: cell ?? null,
      key,
      trade,
    };
  });

  const reproducedAudit = buildSensitivityAudit(records, cellMap, concentrationFraction);
  const parity = sensitivityAuditsMatch(reproducedAudit, selected.sensitivity_audit);
  if (!parity) {
    throw new Error('Reproduced sensitivity audit does not match PR #286 selection JSON');
  }
  if (
    reproducedAudit.unknown_cell_trade_count !== 351
    || reproducedAudit.low_fidelity_trade_count !== 0
  ) {
    throw new Error('Sensitivity count anchors did not reconcile');
  }

  const summaries = {
    clean: summarize(recordsForCategory(records, 'clean'), records.length),
    low_fidelity: summarize(recordsForCategory(records, 'low_fidelity'), records.length),
    unknown_missing_cell: summarize(recordsForCategory(records, 'unknown_missing_cell'), records.length),
    unknown_total: summarize(recordsForCategory(records, 'unknown_total'), records.length),
    unknown_zero_probe: summarize(recordsForCategory(records, 'unknown_zero_probe'), records.length),
  };

  const priorUnknown = priorAudit.category_summary.unknown_total;
  const priorLowFidelity = priorAudit.category_summary.low_fidelity;
  const priorClean = priorAudit.category_summary.clean;
  const priorTradeCount = priorUnknown.trade_count + priorLowFidelity.trade_count + priorClean.trade_count;
  const comparison = {
    low_fidelity_count_delta: summaries.low_fidelity.trade_count - priorLowFidelity.trade_count,
    low_fidelity_fraction_delta: round(summaries.low_fidelity.trade_fraction - priorLowFidelity.trade_fraction, 10),
    prior_low_fidelity_fraction: priorLowFidelity.trade_fraction,
    prior_low_fidelity_trades: priorLowFidelity.trade_count,
    prior_total_trades: priorTradeCount,
    prior_unknown_fraction: priorUnknown.trade_fraction,
    prior_unknown_trades: priorUnknown.trade_count,
    unknown_count_delta: summaries.unknown_total.trade_count - priorUnknown.trade_count,
    unknown_fraction_delta: round(summaries.unknown_total.trade_fraction - priorUnknown.trade_fraction, 10),
    variant_low_fidelity_fraction: summaries.low_fidelity.trade_fraction,
    variant_low_fidelity_trades: summaries.low_fidelity.trade_count,
    variant_total_trades: records.length,
    variant_unknown_fraction: summaries.unknown_total.trade_fraction,
    variant_unknown_trades: summaries.unknown_total.trade_count,
  };

  const determination =
    summaries.low_fidelity.trade_count > 0
      ? 'VARIANT_SPECIFIC_SENSITIVITY_FRAGILITY'
      : summaries.unknown_total.trade_fraction >= concentrationFraction
        ? 'FIDELITY_COVERAGE_GAP_REMAINS_DOMINANT'
        : 'ATTRIBUTION_INSUFFICIENT_CURRENT_SURFACE';
  const recommendedNextTicket =
    determination === 'FIDELITY_COVERAGE_GAP_REMAINS_DOMINANT'
      ? 'QFA-402C-FIDELITY-COVERAGE-EXTEND-01'
      : determination === 'VARIANT_SPECIFIC_SENSITIVITY_FRAGILITY'
        ? 'V2-PF-C-LATE-AM-VARIANT-FRAGILITY-DIAGNOSTIC-01'
        : 'V2-PF-C-LATE-AM-SENSITIVITY-EVIDENCE-SURFACE-EXTEND-01';

  const unknownRecords = recordsForCategory(records, 'unknown_total');
  const concentration = {
    by_regime: summarizeByDimension(unknownRecords, records.length, 'regime', (trade) => trade.regime),
    by_spread_bucket: summarizeByDimension(unknownRecords, records.length, 'spread_bucket', (trade) => trade.spread_bucket),
    by_queue_ahead_bucket: summarizeByDimension(
      unknownRecords,
      records.length,
      'queue_ahead_bucket',
      (trade) => trade.queue_ahead_bucket,
    ),
    by_session_id: summarizeByDimension(
      unknownRecords,
      records.length,
      'session_id',
      (trade) => trade.session_id ?? 'unknown',
    ),
    by_utc_entry_date: summarizeByDimension(unknownRecords, records.length, 'utc_entry_date', (trade) => utcDateFromNs(trade.entry_ts_ns)),
    by_utc_entry_hour: summarizeByDimension(unknownRecords, records.length, 'utc_entry_hour', (trade) => utcHourFromNs(trade.entry_ts_ns)),
    by_vix_prior_close_percentile_band: summarizeByDimension(unknownRecords, records.length, 'vix_prior_close_percentile_band', vixBand),
  };

  const flaggedCellRows = reproducedAudit.flagged_cells.map((row) => {
    const key = cellKeyFromParts(row.regime, row.spread_bucket, row.queue_ahead_bucket);
    const bucket = records.filter((record) => record.key === key);
    return {
      ...row,
      summary: summaryForJson(summarize(bucket, records.length)),
    };
  });

  const output: JsonValue = {
    authority_caveat:
      'Evidence-only diagnostic. Standing qfa-611 verdict remains RESEARCH_FURTHER. No strategy, config, roster, qfa-410b, qfa-611, qfa-402c, paper/live/broker, Phase 6, or ADR authority changed.',
    category_parity: {
      method:
        'Mapped each PR #286 held-out trade to qfa-611 sensitivity cell dimensions (regime, spread_bucket, queue_ahead_bucket), using qfa-402c cell status rules.',
      parity_with_pr286_selection_json: parity,
      reproduced_sensitivity_audit: reproducedAudit as unknown as JsonValue,
      selection_sensitivity_audit: selected.sensitivity_audit as unknown as JsonValue,
    },
    category_summary: {
      clean: summaryForJson(summaries.clean),
      low_fidelity: summaryForJson(summaries.low_fidelity),
      unknown_missing_cell: summaryForJson(summaries.unknown_missing_cell),
      unknown_total: summaryForJson(summaries.unknown_total),
      unknown_zero_probe: summaryForJson(summaries.unknown_zero_probe),
    },
    comparison_against_pr283_base_v2: comparison as unknown as JsonValue,
    determination,
    low_fidelity_confirmation: {
      count: summaries.low_fidelity.trade_count,
      fraction: summaries.low_fidelity.trade_fraction,
      net_pnl_cents: summaries.low_fidelity.net_pnl_cents,
      statement: 'No variant trades map to observed low-fidelity cells.',
    },
    qfa611_recap: {
      phase_6_dispatch_authorized: selection.summary.phase_6_dispatch_authorized,
      sensitivity_audit_pass: selected.threshold_results.sensitivity_audit_pass,
      verdict: selected.verdict,
      verdict_reason: selected.verdict_reason,
    },
    recommended_next_ticket: recommendedNextTicket,
    schema_version: 1,
    source_artifacts: {
      held_out: {
        path: HELD_OUT_PATH,
        raw_sha256: sourceShas.heldOutRawSha,
      },
      pr283_fidelity_coverage_audit: {
        lf_canonical_sha256: sourceShas.priorAuditLfSha,
        path: PRIOR_AUDIT_PATH,
        raw_sha256: sourceShas.priorAuditRawSha,
      },
      qfa402c_fidelity_cells: {
        path: FIDELITY_CELLS_PATH,
        raw_sha256: sourceShas.fidelityRawSha,
      },
      selection: {
        path: SELECTION_PATH,
        raw_sha256: sourceShas.selectionRawSha,
      },
    },
    substrate: {
      origin_main_merge_commit: SUBSTRATE_SHA,
    },
    ticket: TICKET,
    unknown_cell_concentration: concentration,
    unknown_flagged_cells: flaggedCellRows as unknown as JsonValue,
  };

  const artifactMarkdown = buildArtifactMarkdown(
    sourceShas,
    summaries,
    comparison,
    concentration,
    flaggedCellRows,
    determination,
    recommendedNextTicket,
  );
  const memo = buildMemo(sourceShas, selected, reproducedAudit, summaries, comparison, determination, recommendedNextTicket);

  writeDeterministic(OUTPUT_JSON_PATH, stableJson(output));
  writeDeterministic(OUTPUT_MD_PATH, artifactMarkdown);
  writeDeterministic(MEMO_PATH, memo);
  updateBacklog();

  for (const path of [OUTPUT_JSON_PATH, OUTPUT_MD_PATH, MEMO_PATH, BACKLOG_PATH]) {
    console.log(`${path} raw_sha256=${rawSha256(path)} lf_sha256=${lfSha256(path)}`);
  }
  console.log(`unknown_cell_trades=${summaries.unknown_total.trade_count}`);
  console.log(`unknown_cell_fraction=${summaries.unknown_total.trade_fraction}`);
  console.log(`low_fidelity_trades=${summaries.low_fidelity.trade_count}`);
  console.log(`low_fidelity_fraction=${summaries.low_fidelity.trade_fraction}`);
  console.log(`determination=${determination}`);
  console.log(`recommended_next_ticket=${recommendedNextTicket}`);
}

function buildArtifactMarkdown(
  shas: ReturnType<typeof assertPreflightHashes>,
  summaries: Record<string, PnlSummary>,
  comparison: Record<string, number>,
  concentration: Record<string, readonly JsonValue[]>,
  flaggedCells: readonly (SensitivityCellRow & { readonly summary: Record<string, JsonValue> })[],
  determination: string,
  recommendedNextTicket: string,
): string {
  return [
    `# ${TICKET} artifact`,
    '',
    '## Source artifact hashes',
    '',
    markdownTable(
      ['Source', 'Hash convention', 'SHA-256'],
      [
        ['PR #286 held-out', 'raw', shas.heldOutRawSha],
        ['PR #286 qfa-611 selection', 'raw', shas.selectionRawSha],
        ['PR #283 fidelity coverage audit', 'raw', shas.priorAuditRawSha],
        ['PR #283 fidelity coverage audit', 'LF-canonical', shas.priorAuditLfSha],
        ['qfa-402c fidelity cells', 'raw', shas.fidelityRawSha],
      ],
    ),
    '',
    '## Clean vs unknown-cell performance',
    '',
    categoryTable(summaries),
    '',
    '## PR #283 base-v2 comparison',
    '',
    markdownTable(
      ['Metric', 'PR #283 base v2', 'PR #286 variant', 'Delta'],
      [
        ['total trades', comparison.prior_total_trades, comparison.variant_total_trades, comparison.variant_total_trades - comparison.prior_total_trades],
        ['unknown trades', comparison.prior_unknown_trades, comparison.variant_unknown_trades, comparison.unknown_count_delta],
        [
          'unknown fraction',
          formatPct(comparison.prior_unknown_fraction),
          formatPct(comparison.variant_unknown_fraction),
          formatPct(comparison.unknown_fraction_delta),
        ],
        ['low-fidelity trades', comparison.prior_low_fidelity_trades, comparison.variant_low_fidelity_trades, comparison.low_fidelity_count_delta],
        [
          'low-fidelity fraction',
          formatPct(comparison.prior_low_fidelity_fraction),
          formatPct(comparison.variant_low_fidelity_fraction),
          formatPct(comparison.low_fidelity_fraction_delta),
        ],
      ],
    ),
    '',
    '## Unknown-cell concentration',
    '',
    topDimensionTable('Regime', concentration.by_regime),
    '',
    topDimensionTable('Spread bucket', concentration.by_spread_bucket),
    '',
    topDimensionTable('Queue-ahead bucket', concentration.by_queue_ahead_bucket),
    '',
    topDimensionTable('UTC entry hour', concentration.by_utc_entry_hour),
    '',
    topDimensionTable('VIX percentile band', concentration.by_vix_prior_close_percentile_band),
    '',
    '## Flagged cells',
    '',
    markdownTable(
      ['Regime', 'Spread', 'Queue', 'Status', 'Trades', 'Fraction', 'Net PnL', 'PF'],
      flaggedCells.map((row) => [
        row.regime,
        row.spread_bucket,
        row.queue_ahead_bucket,
        row.cell_status,
        row.strategy_trade_count,
        formatPct(row.strategy_trade_fraction),
        formatDollars(Number(row.summary.net_pnl_cents)),
        row.summary.pf === null ? String(row.summary.pf_label) : Number(row.summary.pf).toFixed(6),
      ]),
    ),
    '',
    '## Determination',
    '',
    `Determination: \`${determination}\`.`,
    '',
    `Recommended next ticket: \`${recommendedNextTicket}\`.`,
  ].join('\n');
}

function buildMemo(
  shas: ReturnType<typeof assertPreflightHashes>,
  selected: SelectionArtifact['per_strategy'][number],
  reproducedAudit: SensitivityAudit,
  summaries: Record<string, PnlSummary>,
  comparison: Record<string, number>,
  determination: string,
  recommendedNextTicket: string,
): string {
  return [
    `# ${TICKET} memo`,
    '',
    '## 1. Context',
    '',
    '`regime_shock_reversion_short_v2_utc_16_18_exclusion` reached qfa-611 `RESEARCH_FURTHER` in PR #286. It passed PF and the other stage-1 thresholds except sensitivity, which remained flagged by missing-cell concentration.',
    '',
    '## 2. Source artifact provenance',
    '',
    markdownTable(
      ['Source', 'Hash convention', 'SHA-256'],
      [
        ['PR #286 held-out', 'raw', shas.heldOutRawSha],
        ['PR #286 qfa-611 selection', 'raw', shas.selectionRawSha],
        ['PR #283 fidelity coverage audit', 'raw', shas.priorAuditRawSha],
        ['PR #283 fidelity coverage audit', 'LF-canonical', shas.priorAuditLfSha],
        ['qfa-402c fidelity cells', 'raw', shas.fidelityRawSha],
      ],
    ),
    '',
    '## 3. PR #286 sensitivity failure recap',
    '',
    markdownTable(
      ['Field', 'Value'],
      [
        ['verdict', selected.verdict],
        ['verdict reason', selected.verdict_reason],
        ['sensitivity audit pass', String(selected.threshold_results.sensitivity_audit_pass)],
        ['qfa-611 reason', reproducedAudit.reason],
        ['unknown-cell trades', reproducedAudit.unknown_cell_trade_count],
        ['unknown-cell fraction', formatPct(reproducedAudit.unknown_cell_trade_fraction)],
        ['low-fidelity trades', reproducedAudit.low_fidelity_trade_count],
        ['low-fidelity fraction', formatPct(reproducedAudit.low_fidelity_trade_fraction)],
      ],
    ),
    '',
    '## 4. Category-parity method',
    '',
    'Each PR #286 held-out trade was mapped to qfa-611 sensitivity cell dimensions: `regime`, `spread_bucket`, and `queue_ahead_bucket`. The script then applied the qfa-402c cell rules used by qfa-611: missing cell or `probe_count == 0` is unknown; nonzero-probe `share_ppm < 750000` is low-fidelity; otherwise clean.',
    '',
    'The reproduced category counts match the PR #286 selection JSON exactly: `351` unknown-cell trades and `0` low-fidelity trades.',
    '',
    '## 5. Unknown-cell concentration findings',
    '',
    'All unknown-cell trades are zero-probe qfa-402c cells, not missing cell keys. They are concentrated in low-regime cells and remain above the qfa-611 concentration threshold.',
    '',
    '## 6. Clean vs unknown-cell performance',
    '',
    categoryTable(summaries),
    '',
    '## 7. Comparison against PR #283 base-v2 coverage audit',
    '',
    markdownTable(
      ['Metric', 'PR #283 base v2', 'PR #286 variant', 'Delta'],
      [
        ['total trades', comparison.prior_total_trades, comparison.variant_total_trades, comparison.variant_total_trades - comparison.prior_total_trades],
        ['unknown trades', comparison.prior_unknown_trades, comparison.variant_unknown_trades, comparison.unknown_count_delta],
        [
          'unknown fraction',
          formatPct(comparison.prior_unknown_fraction),
          formatPct(comparison.variant_unknown_fraction),
          formatPct(comparison.unknown_fraction_delta),
        ],
        ['low-fidelity trades', comparison.prior_low_fidelity_trades, comparison.variant_low_fidelity_trades, comparison.low_fidelity_count_delta],
      ],
    ),
    '',
    'The UTC 16-18 exclusion reduces unknown-cell count, but not enough to clear qfa-611 sensitivity coverage. The remaining failure is still missing/zero-probe coverage, not observed low-fidelity fragility.',
    '',
    '## 8. Determination',
    '',
    `Determination: \`${determination}\`.`,
    '',
    'The standing qfa-611 verdict remains `RESEARCH_FURTHER`; this diagnostic does not override qfa-611.',
    '',
    '## 9. Recommended next ticket',
    '',
    `Recommended next ticket: \`${recommendedNextTicket}\`.`,
    '',
    '## 10. Authority caveat',
    '',
    'This is evidence-only. It changes no strategy code, strategy config/YAML, strategy registry, management profile, qfa-410b, qfa-611, qfa-402c, active roster, candidate roster, held-out artifact, selection artifact, ADR, paper/live/broker, or Phase 6 authority.',
  ].join('\n');
}

function categoryTable(summaries: Record<string, PnlSummary>): string {
  return markdownTable(
    ['Category', 'Trades', 'Fraction', 'Net PnL', 'PF', 'Win rate', 'Exit reasons'],
    ['clean', 'unknown_total', 'unknown_zero_probe', 'unknown_missing_cell', 'low_fidelity'].map((category) => {
      const summary = summaries[category]!;
      return [
        category,
        summary.trade_count,
        formatPct(summary.trade_fraction),
        formatDollars(summary.net_pnl_cents),
        formatPf(summary),
        formatPct(summary.win_rate),
        Object.entries(summary.exit_reason_distribution)
          .map(([reason, count]) => `${reason}:${count}`)
          .join(', ') || 'none',
      ];
    }),
  );
}

function topDimensionTable(title: string, rows: readonly JsonValue[]): string {
  const typedRows = rows as readonly Record<string, JsonValue>[];
  return [
    `### ${title}`,
    '',
    markdownTable(
      ['Value', 'Trades', 'Fraction', 'Net PnL', 'PF'],
      typedRows.slice(0, 10).map((row) => [
        String(row.value),
        Number(row.trade_count),
        formatPct(Number(row.trade_fraction)),
        formatDollars(Number(row.net_pnl_cents)),
        row.pf === null ? String(row.pf_label) : Number(row.pf).toFixed(6),
      ]),
    ),
  ].join('\n');
}

main();
