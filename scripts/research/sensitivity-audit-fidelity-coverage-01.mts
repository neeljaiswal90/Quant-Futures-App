import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type HeldOutTrade = {
  readonly exit_reason: string;
  readonly gross_pnl_cents?: string | number;
  readonly net_pnl_cents: string | number;
  readonly queue_ahead_bucket: string;
  readonly regime: string;
  readonly spread_bucket: string;
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
  readonly fidelity_threshold_ppm: number;
  readonly methodology_id: string;
  readonly schema_version: number;
};

type CellCategory = 'clean' | 'low_fidelity' | 'unknown_missing_cell' | 'unknown_zero_probe';

type TradeRecord = {
  readonly category: CellCategory;
  readonly cell: FidelityCell | null;
  readonly key: string;
  readonly trade: HeldOutTrade;
};

type PnlSummary = {
  readonly exit_reason_distribution: { readonly [key: string]: number };
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

const TICKET = 'SENSITIVITY-AUDIT-FIDELITY-COVERAGE-01';
const SUBSTRATE_SHA = '785a5842339ccfd7f9a8675dd2732fdb07cc07e6';
const STRATEGY_ID = 'regime_shock_reversion_short_v2';
const SOURCE_ARTIFACT_PATH =
  'artifacts/held-out-validation/mgmt-bugfix-edge-attribution-02/regime_shock_reversion_short_v2-feb-mar-apr-2026.json';
const FIDELITY_ARTIFACT_PATH = 'artifacts/regime-fidelity/qfa-402c-stratified-cells-v1.json';
const EXPECTED_SOURCE_SHA = 'c9a29e1d6cdb6cc39d07976c2930153342c16ceb59c3145c0e981dd611fde927';
const EXPECTED_FIDELITY_SHA = 'fe17a87886ad7282292d4e1ed9e99fb51bb6c0e8a572475364568715614b8866';
const OUTPUT_JSON_PATH =
  'artifacts/research/sensitivity-audit-fidelity-coverage-01/v2-sensitivity-audit-fidelity-coverage.json';
const OUTPUT_MD_PATH =
  'artifacts/research/sensitivity-audit-fidelity-coverage-01/v2-sensitivity-audit-fidelity-coverage.md';
const MEMO_PATH = 'docs/research/sensitivity-audit-fidelity-coverage-01-memo.md';
const BACKLOG_PATH = 'docs/plan/new_app_v1_ticket_backlog_v6.csv';
const BACKLOG_ROW =
  'SENSITIVITY-AUDIT-FIDELITY-COVERAGE-01,P1,1.0,SIZING-R1-POST-FIX-KELLY-TIERED-REDERIVATION-01,Classify v2 sensitivity-audit failure as fidelity coverage gap versus execution fragility using PR #281 corrected-engine evidence; evidence only no gate or authority change,new_cycle4_v3_research_substrate';

const LOW_FIDELITY_SHARE_PPM = 750_000;
const CONCENTRATION_FRACTION = 0.30;
const EXPECTED_SOURCE_ANCHORS = {
  fail_safe: 17,
  net_pnl_cents: 184_200,
  profit_factor_ppm: 1_241_954,
  session_close: 6,
  stop_loss: 767,
  target: 308,
  trades: 1098,
} as const;

function lfSha256(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function fileLfSha256(path: string): string {
  return lfSha256(readFileSync(path, 'utf8'));
}

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

function parseCents(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`Invalid cents value: ${String(value)}`);
  }
  return parsed;
}

function cellKeyFromParts(regime: string, spreadBucket: string, queueAheadBucket: string): string {
  return `${regime}\u0001${spreadBucket}\u0001${queueAheadBucket}`;
}

function cellKeyFromTrade(trade: HeldOutTrade): string {
  return cellKeyFromParts(trade.regime, trade.spread_bucket, trade.queue_ahead_bucket);
}

function splitKey(key: string): [string, string, string] {
  const parts = key.split('\u0001');
  if (parts.length !== 3) {
    throw new Error(`Invalid cell key: ${key}`);
  }
  return [parts[0] ?? '', parts[1] ?? '', parts[2] ?? ''];
}

function categoryForCell(cell: FidelityCell | undefined): CellCategory {
  if (cell === undefined) {
    return 'unknown_missing_cell';
  }
  if (cell.probe_count === 0) {
    return 'unknown_zero_probe';
  }
  if (cell.share_ppm < LOW_FIDELITY_SHARE_PPM) {
    return 'low_fidelity';
  }
  return 'clean';
}

function categorySortRank(category: string): number {
  switch (category) {
    case 'unknown_missing_cell':
      return 0;
    case 'unknown_zero_probe':
      return 1;
    case 'low_fidelity':
      return 2;
    case 'clean':
      return 3;
    default:
      return 4;
  }
}

function compareCellRows(
  a: { readonly category?: string; readonly regime: string; readonly spread_bucket: string; readonly queue_ahead_bucket: string; readonly trade_count?: number },
  b: { readonly category?: string; readonly regime: string; readonly spread_bucket: string; readonly queue_ahead_bucket: string; readonly trade_count?: number },
): number {
  const categoryDelta = categorySortRank(a.category ?? '') - categorySortRank(b.category ?? '');
  if (categoryDelta !== 0) {
    return categoryDelta;
  }
  const countDelta = (b.trade_count ?? 0) - (a.trade_count ?? 0);
  if (countDelta !== 0) {
    return countDelta;
  }
  return (
    a.regime.localeCompare(b.regime) ||
    a.spread_bucket.localeCompare(b.spread_bucket) ||
    a.queue_ahead_bucket.localeCompare(b.queue_ahead_bucket)
  );
}

function round(value: number, digits = 6): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
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
    exit_reason_distribution: Object.fromEntries(Object.entries(exitReasons).sort(([a], [b]) => a.localeCompare(b))),
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

function canonicalSensitivityAudit(records: readonly TradeRecord[], cells: ReadonlyMap<string, FidelityCell>) {
  const totalTrades = records.length;
  const lowCounts = new Map<string, number>();
  const unknownCounts = new Map<string, number>();
  for (const record of records) {
    if (record.category === 'unknown_missing_cell' || record.category === 'unknown_zero_probe') {
      unknownCounts.set(record.key, (unknownCounts.get(record.key) ?? 0) + 1);
    } else if (record.category === 'low_fidelity') {
      lowCounts.set(record.key, (lowCounts.get(record.key) ?? 0) + 1);
    }
  }
  const unknownCount = [...unknownCounts.values()].reduce((acc, value) => acc + value, 0);
  const lowCount = [...lowCounts.values()].reduce((acc, value) => acc + value, 0);
  const unknownFraction = totalTrades === 0 ? 0 : unknownCount / totalTrades;
  const lowFraction = totalTrades === 0 ? 0 : lowCount / totalTrades;
  const missingFlag = unknownFraction >= CONCENTRATION_FRACTION && totalTrades > 0;
  const lowFlag = lowFraction >= CONCENTRATION_FRACTION && totalTrades > 0;
  const flaggedCells: JsonValue[] = [];
  for (const [status, counts] of [
    ['low_fidelity', lowCounts] as const,
    ['unknown', unknownCounts] as const,
  ]) {
    for (const [key, count] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [regime, spreadBucket, queueAheadBucket] = splitKey(key);
      const cell = cells.get(key);
      flaggedCells.push({
        cell_status: status,
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

function runPythonSensitivityAudit(): JsonValue {
  const script = `
import json
import sys
from pathlib import Path
sys.path.insert(0, "scripts/strategy-selection/_lib")
from sensitivity_audit import compute_sensitivity_audit, load_fidelity_cells
artifact = json.loads(Path("${SOURCE_ARTIFACT_PATH}").read_text(encoding="utf-8"))
cells = load_fidelity_cells("${FIDELITY_ARTIFACT_PATH}")
print(json.dumps(compute_sensitivity_audit(artifact["trades"], cells), sort_keys=True, separators=(",", ":")))
`;
  const result = spawnSync('python', ['-c', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Python qfa-611 sensitivity audit failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as JsonValue;
}

function toJsonSummary(summary: PnlSummary): JsonValue {
  return summary as unknown as JsonValue;
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

function main(): void {
  const sourceText = readFileSync(SOURCE_ARTIFACT_PATH, 'utf8');
  const fidelityText = readFileSync(FIDELITY_ARTIFACT_PATH, 'utf8');
  const sourceSha = lfSha256(sourceText);
  const fidelitySha = lfSha256(fidelityText);
  if (sourceSha !== EXPECTED_SOURCE_SHA) {
    throw new Error(`Source artifact SHA mismatch: expected ${EXPECTED_SOURCE_SHA}, observed ${sourceSha}`);
  }
  if (fidelitySha !== EXPECTED_FIDELITY_SHA) {
    throw new Error(`Fidelity artifact SHA mismatch: expected ${EXPECTED_FIDELITY_SHA}, observed ${fidelitySha}`);
  }
  const source = JSON.parse(sourceText) as HeldOutArtifact;
  const fidelity = JSON.parse(fidelityText) as FidelityArtifact;
  if (source.strategy_id !== STRATEGY_ID || source.schema_version !== 1) {
    throw new Error(`Unexpected held-out artifact identity/schema: ${source.strategy_id} schema ${source.schema_version}`);
  }
  if (fidelity.schema_version !== 1 || fidelity.methodology_id !== 'qfa-402c-cells-v1') {
    throw new Error(`Unexpected fidelity artifact identity/schema: ${fidelity.methodology_id} schema ${fidelity.schema_version}`);
  }
  if (source.trades.length !== EXPECTED_SOURCE_ANCHORS.trades) {
    throw new Error(`Trade count mismatch: expected ${EXPECTED_SOURCE_ANCHORS.trades}, observed ${source.trades.length}`);
  }
  if (parseCents(source.aggregate.net_pnl_cents) !== EXPECTED_SOURCE_ANCHORS.net_pnl_cents) {
    throw new Error('Net PnL anchor mismatch');
  }
  if (source.aggregate.profit_factor_ppm !== EXPECTED_SOURCE_ANCHORS.profit_factor_ppm) {
    throw new Error('PF ppm anchor mismatch');
  }

  const cellMap = new Map<string, FidelityCell>();
  for (const cell of fidelity.cells) {
    const key = cellKeyFromParts(cell.regime, cell.spread_bucket, cell.queue_ahead_bucket);
    if (cellMap.has(key)) {
      throw new Error(`Duplicate fidelity cell key: ${key}`);
    }
    cellMap.set(key, cell);
  }

  const records = source.trades.map((trade): TradeRecord => {
    const key = cellKeyFromTrade(trade);
    const cell = cellMap.get(key);
    return {
      category: categoryForCell(cell),
      cell: cell ?? null,
      key,
      trade,
    };
  });

  const exitCounts = summarize(records, records.length).exit_reason_distribution;
  for (const [reason, expected] of Object.entries({
    fail_safe: EXPECTED_SOURCE_ANCHORS.fail_safe,
    session_close: EXPECTED_SOURCE_ANCHORS.session_close,
    stop_loss: EXPECTED_SOURCE_ANCHORS.stop_loss,
    target: EXPECTED_SOURCE_ANCHORS.target,
  })) {
    if ((exitCounts[reason] ?? 0) !== expected) {
      throw new Error(`Exit reason anchor mismatch for ${reason}: expected ${expected}, observed ${exitCounts[reason] ?? 0}`);
    }
  }

  const categoryRecords = {
    clean: records.filter((record) => record.category === 'clean'),
    low_fidelity: records.filter((record) => record.category === 'low_fidelity'),
    unknown_missing_cell: records.filter((record) => record.category === 'unknown_missing_cell'),
    unknown_zero_probe: records.filter((record) => record.category === 'unknown_zero_probe'),
  } satisfies Record<CellCategory, TradeRecord[]>;
  const unknownRecords = [...categoryRecords.unknown_missing_cell, ...categoryRecords.unknown_zero_probe];
  const categorySummary = {
    clean: summarize(categoryRecords.clean, records.length),
    low_fidelity: summarize(categoryRecords.low_fidelity, records.length),
    unknown_missing_cell: summarize(categoryRecords.unknown_missing_cell, records.length),
    unknown_total: summarize(unknownRecords, records.length),
    unknown_zero_probe: summarize(categoryRecords.unknown_zero_probe, records.length),
  };

  const occupancyByKey = new Map<string, TradeRecord[]>();
  for (const record of records) {
    const bucket = occupancyByKey.get(record.key) ?? [];
    bucket.push(record);
    occupancyByKey.set(record.key, bucket);
  }
  const v2CellOccupancy = [...occupancyByKey.entries()]
    .map(([key, bucket]) => {
      const [regime, spreadBucket, queueAheadBucket] = splitKey(key);
      const cell = cellMap.get(key);
      const summary = summarize(bucket, records.length);
      return {
        category: bucket[0]?.category ?? 'clean',
        probe_count: cell === undefined ? null : cell.probe_count,
        queue_ahead_bucket: queueAheadBucket,
        regime,
        share_ppm: cell === undefined ? null : cell.share_ppm,
        spread_bucket: spreadBucket,
        summary: toJsonSummary(summary),
        trade_count: bucket.length,
      };
    })
    .sort(compareCellRows);

  const cellsByRegime = new Map<string, FidelityCell[]>();
  for (const cell of fidelity.cells) {
    const bucket = cellsByRegime.get(cell.regime) ?? [];
    bucket.push(cell);
    cellsByRegime.set(cell.regime, bucket);
  }
  const fidelityInventoryByRegime = [...cellsByRegime.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([regime, cells]) => ({
      low_fidelity_nonzero_cells: cells.filter(
        (cell) => cell.probe_count > 0 && cell.share_ppm < LOW_FIDELITY_SHARE_PPM,
      ).length,
      nonzero_probe_cells: cells.filter((cell) => cell.probe_count > 0).length,
      regime,
      total_cells: cells.length,
      zero_probe_cells: cells.filter((cell) => cell.probe_count === 0).length,
    }));
  const lowNonzeroCells = fidelity.cells.filter(
    (cell) => cell.probe_count > 0 && cell.share_ppm < LOW_FIDELITY_SHARE_PPM,
  );

  const tsAudit = canonicalSensitivityAudit(records, cellMap);
  const pythonAudit = runPythonSensitivityAudit();
  const canonicalParity = stableJson(tsAudit as unknown as JsonValue) === stableJson(pythonAudit);
  if (!canonicalParity) {
    throw new Error('TypeScript sensitivity audit did not match canonical Python qfa-611 helper');
  }

  const unknownFraction = categorySummary.unknown_total.trade_fraction;
  const lowFraction = categorySummary.low_fidelity.trade_fraction;
  const route =
    unknownFraction >= CONCENTRATION_FRACTION && lowFraction >= CONCENTRATION_FRACTION
      ? 'MIXED_COVERAGE_AND_FRAGILITY'
      : unknownFraction >= CONCENTRATION_FRACTION && lowFraction < CONCENTRATION_FRACTION
        ? 'FIDELITY_COVERAGE_GAP_DOMINANT'
        : lowFraction >= CONCENTRATION_FRACTION
          ? 'EXECUTION_FRAGILITY_DOMINANT'
          : tsAudit.flag
            ? 'AUDIT_LOGIC_INCONSISTENCY'
            : 'AUDIT_CLEAN';
  const recommendedNextTicket =
    route === 'FIDELITY_COVERAGE_GAP_DOMINANT'
      ? 'QFA-402C-FIDELITY-COVERAGE-EXTEND-01'
      : route === 'EXECUTION_FRAGILITY_DOMINANT'
        ? 'EXECUTION-FRAGILITY-DIAGNOSTIC-01'
        : route === 'MIXED_COVERAGE_AND_FRAGILITY'
          ? 'QFA-402C-COVERAGE-AND-FRAGILITY-SPLIT-01'
          : 'SENSITIVITY-AUDIT-LOGIC-RECONCILE-01';

  const output: JsonValue = {
    authority_caveat:
      'Evidence only. The sensitivity audit remains failed until canonical qfa-611 is rerun against an updated substrate. No strategy, gate, roster, paper, broker/live, Phase 6, or ADR authority is changed.',
    category_summary: Object.fromEntries(
      Object.entries(categorySummary).map(([key, summary]) => [key, toJsonSummary(summary)]),
    ),
    fidelity_cell_inventory: {
      by_regime: fidelityInventoryByRegime as unknown as JsonValue,
      low_fidelity_nonzero_cells: lowNonzeroCells.length,
      nonzero_probe_cells: fidelity.cells.filter((cell) => cell.probe_count > 0).length,
      total_cells: fidelity.cells.length,
      zero_probe_cells: fidelity.cells.filter((cell) => cell.probe_count === 0).length,
    },
    flagged_cells: v2CellOccupancy
      .filter((row) => row.category !== 'clean')
      .map((row) => row as unknown as JsonValue),
    qfa611_reproduction: {
      canonical_python_output: pythonAudit,
      canonical_reason_precedence:
        'qfa-611 reports missing_cell_concentration when unknown and low-fidelity flags both exceed threshold; diagnostic route is reported separately.',
      parity: canonicalParity,
      typescript_output: tsAudit as unknown as JsonValue,
    },
    qfa611_sensitivity_thresholds: {
      concentration_fraction: CONCENTRATION_FRACTION,
      low_fidelity_share_ppm: LOW_FIDELITY_SHARE_PPM,
      low_fidelity_definition: 'cell.probe_count > 0 and cell.share_ppm < low_fidelity_share_ppm',
      unknown_definition: 'missing cell key or cell.probe_count == 0',
    },
    recommended_next_ticket: recommendedNextTicket,
    routing: {
      code: route,
      qfa611_reason: tsAudit.reason,
      rationale:
        route === 'FIDELITY_COVERAGE_GAP_DOMINANT'
          ? 'Unknown cell concentration exceeds 30% while low-fidelity concentration is 0%; the failure is dominated by qfa-402c zero-probe coverage, not observed low-fidelity execution.'
          : 'Computed from predeclared route rules.',
    },
    schema_version: 1,
    source_artifacts: {
      qfa402c_fidelity_cells: {
        path: FIDELITY_ARTIFACT_PATH,
        sha256: fidelitySha,
      },
      v2_corrected_engine_held_out: {
        anchors: {
          exit_reasons: exitCounts as unknown as JsonValue,
          net_pnl_cents: parseCents(source.aggregate.net_pnl_cents),
          profit_factor: source.aggregate.profit_factor_ppm / 1_000_000,
          trades: source.trades.length,
        },
        path: SOURCE_ARTIFACT_PATH,
        sha256: sourceSha,
      },
    },
    source_substrate: {
      base: `origin/main@${SUBSTRATE_SHA}`,
      includes_prs: ['#281', '#282'],
    },
    ticket: TICKET,
    v2_cell_occupancy: v2CellOccupancy as unknown as JsonValue,
  };

  const topFlaggedRows = v2CellOccupancy.filter((row) => row.category !== 'clean').slice(0, 10);
  const artifactMarkdown = [
    `# ${TICKET} artifact`,
    '',
    '## Source anchors',
    '',
    markdownTable(
      ['Artifact', 'SHA-256'],
      [
        ['v2 corrected-engine held-out', sourceSha],
        ['qfa-402c fidelity cells', fidelitySha],
      ],
    ),
    '',
    '## qfa-611 sensitivity thresholds',
    '',
    markdownTable(
      ['Threshold', 'Value'],
      [
        ['low_fidelity_share_ppm', LOW_FIDELITY_SHARE_PPM],
        ['concentration_fraction', CONCENTRATION_FRACTION],
      ],
    ),
    '',
    '## Fidelity inventory',
    '',
    markdownTable(
      ['Regime', 'Total cells', 'Zero-probe cells', 'Nonzero cells', 'Low-fidelity nonzero cells'],
      fidelityInventoryByRegime.map((row) => [
        row.regime,
        row.total_cells,
        row.zero_probe_cells,
        row.nonzero_probe_cells,
        row.low_fidelity_nonzero_cells,
      ]),
    ),
    '',
    '## Category summary',
    '',
    markdownTable(
      ['Category', 'Trades', 'Fraction', 'Net PnL', 'PF', 'Win rate', 'Exit reasons'],
      Object.entries(categorySummary).map(([category, summary]) => [
        category,
        summary.trade_count,
        formatPct(summary.trade_fraction),
        formatDollars(summary.net_pnl_cents),
        formatPf(summary),
        formatPct(summary.win_rate),
        Object.entries(summary.exit_reason_distribution)
          .map(([reason, count]) => `${reason}:${count}`)
          .join(', ') || 'none',
      ]),
    ),
    '',
    '## Top flagged cells',
    '',
    markdownTable(
      ['Category', 'Regime', 'Spread', 'Queue', 'Trades', 'Fraction', 'Probe count', 'Share ppm', 'Net PnL'],
      topFlaggedRows.map((row) => [
        row.category,
        row.regime,
        row.spread_bucket,
        row.queue_ahead_bucket,
        row.trade_count,
        formatPct(Number((row.summary as { trade_fraction: number }).trade_fraction)),
        row.probe_count === null ? 'missing' : row.probe_count,
        row.share_ppm === null ? 'missing' : row.share_ppm,
        formatDollars(Number((row.summary as { net_pnl_cents: number }).net_pnl_cents)),
      ]),
    ),
    '',
    '## Determination',
    '',
    `Route: \`${route}\`. qfa-611 canonical reason remains \`${tsAudit.reason}\`.`,
    '',
    `Recommended next ticket: \`${recommendedNextTicket}\`.`,
  ].join('\n');

  const memo = [
    `# ${TICKET} memo`,
    '',
    '## 1. Context',
    '',
    'PR #281 corrected-engine v2 evidence failed two Stage 1 gates: `pf_pass` and `sensitivity_audit_pass`. PR #282 showed sizing evidence is positive but cannot fix PF. This memo classifies the sensitivity-audit failure before PF-improvement research.',
    '',
    '## 2. Source artifacts',
    '',
    markdownTable(
      ['Artifact', 'Path', 'SHA-256'],
      [
        ['v2 corrected-engine held-out', SOURCE_ARTIFACT_PATH, sourceSha],
        ['qfa-402c fidelity cells', FIDELITY_ARTIFACT_PATH, fidelitySha],
      ],
    ),
    '',
    '## 3. qfa-611 sensitivity audit mechanism',
    '',
    'Canonical qfa-611 uses cell key `(regime, spread_bucket, queue_ahead_bucket)`. Unknown means a missing fidelity cell or a defined cell with `probe_count == 0`. Low-fidelity means a nonzero-probe cell with `share_ppm < 750000`. Either unknown or low-fidelity concentration at or above `0.30` flags the audit.',
    '',
    `The extractor reproduced the canonical Python qfa-611 helper exactly: parity = \`${String(canonicalParity)}\`, flag = \`${String(tsAudit.flag)}\`, reason = \`${tsAudit.reason}\`. If both missing and low-fidelity flags were true, qfa-611 reason precedence would still report missing first; this diagnostic route is separate from that canonical reason.`,
    '',
    '## 4. Fidelity cell inventory',
    '',
    markdownTable(
      ['Regime', 'Total cells', 'Zero-probe cells', 'Nonzero cells', 'Low-fidelity nonzero cells'],
      fidelityInventoryByRegime.map((row) => [
        row.regime,
        row.total_cells,
        row.zero_probe_cells,
        row.nonzero_probe_cells,
        row.low_fidelity_nonzero_cells,
      ]),
    ),
    '',
    '## 5. V2 occupancy by cell',
    '',
    `v2 occupies ${v2CellOccupancy.length} fidelity cells across ${source.trades.length} trades. The top flagged cells are tabled in the companion Markdown artifact.`,
    '',
    '## 6. Unknown vs low-fidelity attribution',
    '',
    markdownTable(
      ['Category', 'Trades', 'Fraction', 'Net PnL', 'PF'],
      [
        [
          'unknown_missing_cell',
          categorySummary.unknown_missing_cell.trade_count,
          formatPct(categorySummary.unknown_missing_cell.trade_fraction),
          formatDollars(categorySummary.unknown_missing_cell.net_pnl_cents),
          formatPf(categorySummary.unknown_missing_cell),
        ],
        [
          'unknown_zero_probe',
          categorySummary.unknown_zero_probe.trade_count,
          formatPct(categorySummary.unknown_zero_probe.trade_fraction),
          formatDollars(categorySummary.unknown_zero_probe.net_pnl_cents),
          formatPf(categorySummary.unknown_zero_probe),
        ],
        [
          'low_fidelity',
          categorySummary.low_fidelity.trade_count,
          formatPct(categorySummary.low_fidelity.trade_fraction),
          formatDollars(categorySummary.low_fidelity.net_pnl_cents),
          formatPf(categorySummary.low_fidelity),
        ],
        [
          'clean',
          categorySummary.clean.trade_count,
          formatPct(categorySummary.clean.trade_fraction),
          formatDollars(categorySummary.clean.net_pnl_cents),
          formatPf(categorySummary.clean),
        ],
      ],
    ),
    '',
    '## 7. PnL/exit-reason by category',
    '',
    markdownTable(
      ['Category', 'Exit reasons'],
      Object.entries(categorySummary).map(([category, summary]) => [
        category,
        Object.entries(summary.exit_reason_distribution)
          .map(([reason, count]) => `${reason}:${count}`)
          .join(', ') || 'none',
      ]),
    ),
    '',
    '## 8. Determination',
    '',
    `Route: \`${route}\`. Unknown cell concentration is ${formatPct(unknownFraction)}; low-fidelity concentration is ${formatPct(lowFraction)}. The failure is a fidelity-substrate coverage gap, not observed low-fidelity execution fragility. The qfa-611 gate remains failed until the fidelity substrate is extended and qfa-611 is rerun.`,
    '',
    '## 9. Recommended next ticket',
    '',
    `Recommended next ticket: \`${recommendedNextTicket}\`, scoped to extend or refresh qfa-402c coverage for the zero-probe cells currently occupied by v2 trades. PF-improvement research should not treat the sensitivity-audit failure as execution fragility until coverage is repaired and canonical qfa-611 is rerun.`,
    '',
    '## 10. Verification',
    '',
    'The deterministic extractor writes JSON, Markdown, memo, and backlog outputs; reproduces canonical qfa-611 sensitivity helper output; and preserves source artifact anchors. Required command results are reported in the worker PENDING-REVIEW note.',
    '',
    '## 11. Authority caveat',
    '',
    '`regime_shock_reversion_short_v2` remains REGISTERED_INACTIVE. This work does not change qfa-611, qfa-402c, strategy code, strategy roster, risk/sizing config, held-out artifacts, ADRs, paper observation, broker/live dispatch, or Phase 6 authority.',
  ].join('\n');

  writeDeterministic(OUTPUT_JSON_PATH, stableJson(output));
  writeDeterministic(OUTPUT_MD_PATH, artifactMarkdown);
  writeDeterministic(MEMO_PATH, memo);
  updateBacklog();

  for (const path of [OUTPUT_JSON_PATH, OUTPUT_MD_PATH, MEMO_PATH, BACKLOG_PATH]) {
    console.log(`${path} ${fileLfSha256(path)}`);
  }
  console.log(`unknown_fraction=${unknownFraction}`);
  console.log(`low_fidelity_fraction=${lowFraction}`);
  console.log(
    `category_summary=${JSON.stringify(
      Object.fromEntries(
        Object.entries(categorySummary).map(([key, summary]) => [
          key,
          {
            gross_loss_cents: summary.gross_loss_cents,
            gross_profit_cents: summary.gross_profit_cents,
            net_pnl_cents: summary.net_pnl_cents,
            pf: summary.pf,
            pf_label: summary.pf_label,
            trade_count: summary.trade_count,
            trade_fraction: summary.trade_fraction,
          },
        ]),
      ),
    )}`,
  );
  console.log(
    `top_flagged_cells=${JSON.stringify(
      topFlaggedRows.slice(0, 5).map((row) => ({
        category: row.category,
        net_pnl_cents: (row.summary as { net_pnl_cents: number }).net_pnl_cents,
        probe_count: row.probe_count,
        queue_ahead_bucket: row.queue_ahead_bucket,
        regime: row.regime,
        share_ppm: row.share_ppm,
        spread_bucket: row.spread_bucket,
        trade_count: row.trade_count,
        trade_fraction: (row.summary as { trade_fraction: number }).trade_fraction,
      })),
    )}`,
  );
  console.log(`route=${route}`);
  console.log(`recommended_next_ticket=${recommendedNextTicket}`);
  console.log(`qfa611_reason=${tsAudit.reason}`);
}

main();
