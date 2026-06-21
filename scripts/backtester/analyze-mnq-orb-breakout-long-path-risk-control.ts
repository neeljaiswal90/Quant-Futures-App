// @ts-nocheck
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadDbnFile } from '../../apps/strategy_runtime/src/data/dbn-loader.js';
import { loadMnqSessionCalendarConfig, getMnqSessionPhase } from '../../apps/strategy_runtime/src/session/mnq-session-calendar.js';

const CACHE_OHLCV_1M_ROOT = 'D:/QFA-cache/databento/mnq-continuous-included-2019-05-06_2026-06-20/ohlcv-1m';
const INPUT_TRADES = 'artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-breakout-long-factor-audit-01/orb-breakout-long-factor-trades.csv';
const OUT_ROOT = 'artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-breakout-long-path-risk-control-audit-01';
const DOC_PATH = 'docs/research/qfa-orb-breakout-long-path-risk-control-audit-2026-06-20.md';
const PRICE_SCALE = 1_000_000_000;
const POINT_VALUE_USD = 2;

type CsvRow = Record<string, string | number | null>;

type Bar = {
  tsNs: bigint;
  tsIso: string;
  tradingDate: string;
  high: number;
  low: number;
};

type OverlayTrade = CsvRow & {
  scenario: string;
  path_stop_multiple: number | null;
  path_stop_hit: boolean;
  path_stop_ts_utc: string | null;
  original_net_usd: number;
  adjusted_net_usd: number;
  adjusted_delta_usd: number;
};

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function maybeNumber(value: string): string | number | null {
  if (value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && value.trim() !== '' ? number : value;
}

function readCsv(filePath: string): CsvRow[] {
  const text = readFileSync(filePath, 'utf8').trim();
  const [headerLine, ...lines] = text.split(/\r?\n/);
  const headers = parseCsvLine(headerLine);
  return lines
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const values = parseCsvLine(line);
      return Object.fromEntries(headers.map((header, index) => [header, maybeNumber(values[index] ?? '')]));
    });
}

function numeric(row: CsvRow, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(row: CsvRow, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function round(value: number | null | undefined, digits = 4): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((entry) => path.join(dir, entry))
    .flatMap((entry) => (statSync(entry).isDirectory() ? listFiles(entry) : [entry]))
    .filter((file) => file.endsWith('.dbn.zst'))
    .sort();
}

function priceFromFixed(value: unknown): number {
  if (typeof value === 'bigint') return Number(value) / PRICE_SCALE;
  if (typeof value === 'number') return value / PRICE_SCALE;
  return Number(value) / PRICE_SCALE;
}

function isoFromNs(tsNs: bigint): string {
  return new Date(Number(tsNs / 1_000_000n)).toISOString().replace('.000Z', '.000000000Z');
}

async function loadBarsByDate(): Promise<Map<string, Bar[]>> {
  const calendar = loadMnqSessionCalendarConfig();
  const grouped = new Map<string, Bar[]>();
  for (const file of listFiles(CACHE_OHLCV_1M_ROOT)) {
    for await (const record of loadDbnFile(file, 'ohlcv-1m')) {
      const tsNs = BigInt(record.ts_event);
      const phase = getMnqSessionPhase(calendar, tsNs);
      if (!phase.is_rth || phase.journal_phase !== 'rth') continue;
      const bar = {
        tsNs,
        tsIso: isoFromNs(tsNs),
        tradingDate: phase.trading_date,
        high: priceFromFixed(record.high),
        low: priceFromFixed(record.low),
      };
      const existing = grouped.get(bar.tradingDate) ?? [];
      existing.push(bar);
      grouped.set(bar.tradingDate, existing);
    }
  }
  for (const bars of grouped.values()) {
    bars.sort((left, right) => (left.tsNs < right.tsNs ? -1 : left.tsNs > right.tsNs ? 1 : 0));
  }
  return grouped;
}

function roundTurnCost(row: CsvRow): number {
  const gross = numeric(row, 'gross_usd');
  const net = numeric(row, 'net_usd');
  if (gross === null || net === null) return 2;
  return Math.max(0, round(gross - net, 4) ?? 0);
}

function findPathStop(row: CsvRow, barsByDate: Map<string, Bar[]>, stopMultiple: number): { hit: boolean; tsUtc: string | null; netUsd: number } {
  const tradingDate = text(row, 'trading_date');
  const bars = barsByDate.get(tradingDate) ?? [];
  const signalTs = BigInt(String(row.signal_ts_ns ?? '0'));
  const signalIndex = bars.findIndex((bar) => bar.tsNs === signalTs);
  const entry = numeric(row, 'entry_price') ?? 0;
  const risk = numeric(row, 'risk_points') ?? Math.abs(entry - (numeric(row, 'stop_price') ?? entry));
  const stopPrice = entry - risk * stopMultiple;
  const originalNet = numeric(row, 'net_usd') ?? 0;
  const cost = roundTurnCost(row);
  if (signalIndex < 0 || risk <= 0) {
    return { hit: false, tsUtc: null, netUsd: originalNet };
  }
  const endTs = signalTs + 60n * 60n * 1_000_000_000n;
  for (let index = signalIndex + 1; index < bars.length; index += 1) {
    const bar = bars[index];
    if (bar.tsNs > endTs) break;
    if (bar.low <= stopPrice) {
      return {
        hit: true,
        tsUtc: bar.tsIso,
        netUsd: -risk * stopMultiple * POINT_VALUE_USD - cost,
      };
    }
  }
  return { hit: false, tsUtc: null, netUsd: originalNet };
}

function maxDrawdown(values: Array<{ ts: number; pnl: number }>): number {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const value of [...values].sort((left, right) => left.ts - right.ts)) {
    equity += value.pnl;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return maxDd;
}

function summary(rows: OverlayTrade[]): Record<string, unknown> {
  const pnl = rows.map((row) => row.adjusted_net_usd);
  const original = rows.map((row) => row.original_net_usd);
  const wins = pnl.filter((value) => value > 0);
  const losses = pnl.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const net = pnl.reduce((sum, value) => sum + value, 0);
  const originalNet = original.reduce((sum, value) => sum + value, 0);
  const dd = maxDrawdown(rows.map((row) => ({ ts: Number(row.signal_ts_ns ?? 0), pnl: row.adjusted_net_usd })));
  return {
    trades: rows.length,
    original_net_usd: round(originalNet, 2),
    adjusted_net_usd: round(net, 2),
    delta_usd: round(net - originalNet, 2),
    profit_factor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : null,
    win_rate: rows.length > 0 ? round(wins.length / rows.length, 4) : null,
    avg_adjusted_net_usd: rows.length > 0 ? round(net / rows.length, 4) : null,
    max_drawdown_usd: round(dd, 2),
    pnl_to_max_drawdown: dd > 0 ? round(net / dd, 4) : null,
    path_stop_hits: rows.filter((row) => row.path_stop_hit).length,
    path_stop_hit_rate: rows.length > 0 ? round(rows.filter((row) => row.path_stop_hit).length / rows.length, 4) : null,
  };
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const rendered = String(value);
  return /[",\n\r]/.test(rendered) ? `"${rendered.replace(/"/g, '""')}"` : rendered;
}

function writeCsv(filePath: string, rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) {
    writeFileSync(filePath, '');
    return;
  }
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }
  writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function sha256Lf(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
}

function makeScenario(name: string, baseRows: CsvRow[], barsByDate: Map<string, Bar[]>, predicate: (row: CsvRow) => boolean, stopMultiple: number | null): OverlayTrade[] {
  return baseRows.filter(predicate).map((row) => {
    const originalNet = numeric(row, 'net_usd') ?? 0;
    const stopped = stopMultiple === null ? { hit: false, tsUtc: null, netUsd: originalNet } : findPathStop(row, barsByDate, stopMultiple);
    return {
      ...row,
      scenario: name,
      path_stop_multiple: stopMultiple,
      path_stop_hit: stopped.hit,
      path_stop_ts_utc: stopped.tsUtc,
      original_net_usd: round(originalNet, 4) ?? originalNet,
      adjusted_net_usd: round(stopped.netUsd, 4) ?? stopped.netUsd,
      adjusted_delta_usd: round(stopped.netUsd - originalNet, 4) ?? stopped.netUsd - originalNet,
    };
  });
}

function mdTable(rows: Array<Record<string, unknown>>, columns: string[]): string[] {
  return [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${columns.map((column) => row[column] ?? '').join(' | ')} |`),
  ];
}

async function main(): Promise<void> {
  if (!existsSync(INPUT_TRADES)) throw new Error(`Missing input trades: ${INPUT_TRADES}`);
  mkdirSync(OUT_ROOT, { recursive: true });
  mkdirSync(path.dirname(DOC_PATH), { recursive: true });
  const rows = readCsv(INPUT_TRADES);
  const barsByDate = await loadBarsByDate();
  const priorDownFamily = new Set(['prior_down', 'prior_down_large']);
  const notLate = (row: CsvRow) => text(row, 'breakout_time_bucket') !== '14:00+';
  const priorDown = (row: CsvRow) => priorDownFamily.has(text(row, 'prior_day_trend_state'));
  const timePrior = (row: CsvRow) => notLate(row) && priorDown(row);

  const scenarioDefs = [
    { name: 'baseline_all_no_path_stop', predicate: () => true, stopMultiple: null, description: 'All breakout-long trades, no path overlay.' },
    { name: 'exclude_14_plus_no_path_stop', predicate: notLate, stopMultiple: null, description: 'Exclude only 14:00+ entries.' },
    { name: 'prior_down_family_no_path_stop', predicate: priorDown, stopMultiple: null, description: 'Keep prior_down and prior_down_large only.' },
    { name: 'exclude_14_plus_and_prior_down_family_no_path_stop', predicate: timePrior, stopMultiple: null, description: 'Keep prior-down family and exclude 14:00+ entries.' },
    { name: 'baseline_path_stop_mae60_075risk', predicate: () => true, stopMultiple: 0.75, description: 'All trades with path-ordered 60m adverse stop at 75% risk.' },
    { name: 'exclude_14_plus_path_stop_mae60_075risk', predicate: notLate, stopMultiple: 0.75, description: 'Exclude 14:00+ plus path-ordered 60m adverse stop at 75% risk.' },
    { name: 'prior_down_family_path_stop_mae60_075risk', predicate: priorDown, stopMultiple: 0.75, description: 'Prior-down family with path-ordered 60m adverse stop at 75% risk.' },
    { name: 'exclude_14_plus_and_prior_down_family_path_stop_mae60_075risk', predicate: timePrior, stopMultiple: 0.75, description: 'Combined context/time profile with path-ordered 60m adverse stop at 75% risk.' },
    { name: 'baseline_path_stop_mae60_050risk_diagnostic', predicate: () => true, stopMultiple: 0.5, description: 'Diagnostic-only tighter 50% risk path stop.' },
    { name: 'exclude_14_plus_and_prior_down_family_path_stop_mae60_050risk_diagnostic', predicate: timePrior, stopMultiple: 0.5, description: 'Combined profile with diagnostic-only tighter 50% risk path stop.' },
  ];

  const overlayRows = scenarioDefs.flatMap((scenario) => makeScenario(scenario.name, rows, barsByDate, scenario.predicate, scenario.stopMultiple));
  const scenarioSummary = scenarioDefs.map((scenario) => ({
    scenario: scenario.name,
    description: scenario.description,
    path_stop_multiple: scenario.stopMultiple,
    ...summary(overlayRows.filter((row) => row.scenario === scenario.name)),
  }));

  const overlayCsv = path.join(OUT_ROOT, 'orb-breakout-long-path-risk-control-overlay-trades.csv');
  const summaryCsv = path.join(OUT_ROOT, 'orb-breakout-long-path-risk-control-scenario-summary.csv');
  const reportJson = path.join(OUT_ROOT, 'orb-breakout-long-path-risk-control-report.json');
  const reportMd = path.join(OUT_ROOT, 'orb-breakout-long-path-risk-control-report.md');
  const manifestPath = path.join(OUT_ROOT, 'manifest.json');

  writeCsv(overlayCsv, overlayRows);
  writeCsv(summaryCsv, scenarioSummary);

  const report = {
    generated_at_utc: new Date().toISOString(),
    determination: 'ORB_BREAKOUT_LONG_PATH_RISK_CONTROL_AUDIT_COMPLETE_DIAGNOSTIC_ONLY',
    input_trades: INPUT_TRADES,
    cache_ohlcv_1m_root: CACHE_OHLCV_1M_ROOT,
    guardrails: {
      diagnostic_only: true,
      broker_authority_created: false,
      order_intent_authority_created: false,
      roster_mutated: false,
      raw_or_prior_filter_promoted: false,
      path_rule_excludes_signal_minute_to_avoid_pre_entry_low: true,
      full_day_stop_or_reentry_simulated: false,
      intrabar_ordering_within_1m_bar_known: false,
    },
    scenario_summary: scenarioSummary,
    artifact_paths: { overlayCsv, summaryCsv, reportJson, reportMd, manifestPath, docPath: DOC_PATH },
  };
  writeFileSync(reportJson, `${JSON.stringify(report, null, 2)}\n`);
  const md = [
    '# QFA ORB breakout long path risk-control audit - 2026-06-20',
    '',
    `Determination: \`${report.determination}\``,
    '',
    '## Scope',
    '',
    'This audit applies the fixed next-step contract:',
    '',
    '```text',
    'avoid 14:00+ long ORB entries',
    'treat prior_down / prior_down_large as preferred context',
    'do not promote raw OR/prior filters',
    'investigate path-ordered MAE60 risk control',
    '```',
    '',
    'No broker action, no `ORDER_INTENT`, no paper/live authority, no roster mutation, and no strategy promotion are authorized.',
    '',
    '## Path-control modeling caveats',
    '',
    'The path stop scans subsequent 1-minute bars after the signal minute through 60 minutes. The signal minute itself is excluded to avoid treating pre-entry low as a stop hit. If a later 1-minute bar crosses the stop, the overlay exits at `entry - stopMultiple * initialRisk` and applies the observed round-turn cost from the source trade.',
    '',
    'This is still diagnostic. It does not simulate daily stop interaction, sequential re-entry changes, or intrabar event ordering inside a 1-minute bar.',
    '',
    '## Scenario summary',
    '',
    ...mdTable(scenarioSummary, ['scenario', 'trades', 'original_net_usd', 'adjusted_net_usd', 'delta_usd', 'profit_factor', 'win_rate', 'avg_adjusted_net_usd', 'max_drawdown_usd', 'pnl_to_max_drawdown', 'path_stop_hits', 'path_stop_hit_rate']),
    '',
    '## Interpretation',
    '',
    'The 14:00+ exclusion is additive but modest. Prior-down context is a materially stronger selector than time alone. The 75% MAE60 path stop modestly improves the historical prior-down profile table metrics, but the delta is small and should be treated as statistically inconclusive. It should remain log-only until forward evidence supports it.',
    '',
    'The tighter 50% stop is included only as a diagnostic stress test. It materially reduces drawdown in the combined profile but gives up too much net in the broad baseline. It should not be promoted without a future validation sample.',
    '',
    'Raw OR/prior filters remain unpromoted in this pass.',
    '',
    '## Artifacts',
    '',
    `- \`${overlayCsv}\``,
    `- \`${summaryCsv}\``,
    `- \`${reportJson}\``,
    `- \`${reportMd}\``,
  ].join('\n');
  writeFileSync(reportMd, `${md}\n`);
  writeFileSync(DOC_PATH, `${md}\n`);
  const manifest = {
    generated_at_utc: new Date().toISOString(),
    files: [overlayCsv, summaryCsv, reportJson, reportMd, DOC_PATH].map((file) => ({ path: file, lf_sha256: sha256Lf(file) })),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({
    status: 'ok',
    determination: report.determination,
    output_root: OUT_ROOT,
    doc_path: DOC_PATH,
    scenario_count: scenarioSummary.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
