// @ts-nocheck
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadDbnFile } from '../../apps/strategy_runtime/src/data/dbn-loader.js';
import { loadMnqSessionCalendarConfig, getMnqSessionPhase } from '../../apps/strategy_runtime/src/session/mnq-session-calendar.js';

const CACHE_OHLCV_1M_ROOT = 'D:/QFA-cache/databento/mnq-continuous-included-2019-05-06_2026-06-20/ohlcv-1m';
const INPUT_TRADES = 'artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-breakout-long-factor-audit-01/orb-breakout-long-factor-trades.csv';
const OUT_ROOT = 'artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-breakout-long-dynamic-pt-2contract-01';
const DOC_PATH = 'docs/research/qfa-orb-breakout-long-dynamic-pt-2contract-2026-06-20.md';
const PRICE_SCALE = 1_000_000_000;
const POINT_VALUE_USD = 2;
const CONTRACTS = 2;
const MIN_PRIOR_TRADES = 100;

type Row = Record<string, string | number | null>;

type Bar = {
  tsNs: bigint;
  tsIso: string;
  tradingDate: string;
  high: number;
  low: number;
};

type ScenarioTrade = Row & {
  universe: string;
  management: string;
  prior_trade_count: number;
  pt_single_r: number | null;
  pt1_r: number | null;
  pt2_r: number | null;
  contracts: number;
  adjusted_net_usd: number;
  adjusted_exit_reason: string;
  pt1_hit: boolean;
  pt2_hit: boolean;
  stop_hit: boolean;
  first_management_ts_utc: string | null;
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

function readCsv(filePath: string): Row[] {
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

function numeric(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(row: Row, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function round(value: number | null | undefined, digits = 4): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function listFiles(dir: string): string[] {
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

function quantile(values: number[], q: number): number | null {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return null;
  const index = (finite.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return finite[lower];
  const weight = index - lower;
  return finite[lower] * (1 - weight) + finite[upper] * weight;
}

function riskPoints(row: Row): number {
  return numeric(row, 'risk_points') ?? Math.abs((numeric(row, 'entry_price') ?? 0) - (numeric(row, 'stop_price') ?? 0));
}

function costPerContract(row: Row): number {
  const gross = numeric(row, 'gross_usd');
  const net = numeric(row, 'net_usd');
  if (gross === null || net === null) return 2;
  return Math.max(0, gross - net);
}

function mfeR(row: Row, key: string): number | null {
  const risk = riskPoints(row);
  const mfe = numeric(row, key);
  if (mfe === null || risk <= 0) return null;
  return mfe / risk;
}

function estimateTargets(priorRows: Row[]): { single: number | null; pt1: number | null; pt2: number | null } {
  if (priorRows.length < MIN_PRIOR_TRADES) return { single: null, pt1: null, pt2: null };
  const winningRows = priorRows.filter((row) => (numeric(row, 'net_usd') ?? 0) > 0);
  const mfe60 = winningRows.map((row) => mfeR(row, 'mfe_60m')).filter((value): value is number => value !== null);
  const mfe120 = winningRows.map((row) => mfeR(row, 'mfe_120m')).filter((value): value is number => value !== null);
  return {
    single: quantile(mfe120, 0.6),
    pt1: quantile(mfe60, 0.5),
    pt2: quantile(mfe120, 0.75),
  };
}

function pathBarsForTrade(row: Row, barsByDate: Map<string, Bar[]>): Bar[] {
  const bars = barsByDate.get(text(row, 'trading_date')) ?? [];
  const signalTs = BigInt(String(row.signal_ts_ns ?? '0'));
  const startIndex = bars.findIndex((bar) => bar.tsNs === signalTs);
  if (startIndex < 0) return [];
  return bars.slice(startIndex + 1);
}

function simulateSinglePt(row: Row, barsByDate: Map<string, Bar[]>, ptR: number): Pick<ScenarioTrade, 'adjusted_net_usd' | 'adjusted_exit_reason' | 'pt1_hit' | 'pt2_hit' | 'stop_hit' | 'first_management_ts_utc'> {
  const entry = numeric(row, 'entry_price') ?? 0;
  const risk = riskPoints(row);
  const stop = entry - risk;
  const target = entry + risk * ptR;
  const cost = costPerContract(row);
  const originalNet = numeric(row, 'net_usd') ?? 0;
  for (const bar of pathBarsForTrade(row, barsByDate)) {
    if (bar.low <= stop) {
      return {
        adjusted_net_usd: round(CONTRACTS * (-risk * POINT_VALUE_USD - cost), 4) ?? 0,
        adjusted_exit_reason: 'single_pt_stop_first',
        pt1_hit: false,
        pt2_hit: false,
        stop_hit: true,
        first_management_ts_utc: bar.tsIso,
      };
    }
    if (bar.high >= target) {
      return {
        adjusted_net_usd: round(CONTRACTS * (risk * ptR * POINT_VALUE_USD - cost), 4) ?? 0,
        adjusted_exit_reason: 'single_pt_hit',
        pt1_hit: true,
        pt2_hit: false,
        stop_hit: false,
        first_management_ts_utc: bar.tsIso,
      };
    }
  }
  return {
    adjusted_net_usd: round(CONTRACTS * originalNet, 4) ?? 0,
    adjusted_exit_reason: 'source_exit_no_pt_or_stop',
    pt1_hit: false,
    pt2_hit: false,
    stop_hit: false,
    first_management_ts_utc: null,
  };
}

function simulateTwoPt(row: Row, barsByDate: Map<string, Bar[]>, pt1R: number, pt2R: number): Pick<ScenarioTrade, 'adjusted_net_usd' | 'adjusted_exit_reason' | 'pt1_hit' | 'pt2_hit' | 'stop_hit' | 'first_management_ts_utc'> {
  const entry = numeric(row, 'entry_price') ?? 0;
  const risk = riskPoints(row);
  const stop = entry - risk;
  const target1 = entry + risk * pt1R;
  const target2 = entry + risk * pt2R;
  const cost = costPerContract(row);
  const originalNet = numeric(row, 'net_usd') ?? 0;
  let remaining = CONTRACTS;
  let pnl = 0;
  let pt1Hit = false;
  let pt2Hit = false;
  let firstTs: string | null = null;
  for (const bar of pathBarsForTrade(row, barsByDate)) {
    if (bar.low <= stop) {
      pnl += remaining * (-risk * POINT_VALUE_USD - cost);
      return {
        adjusted_net_usd: round(pnl, 4) ?? 0,
        adjusted_exit_reason: pt1Hit ? 'two_pt_pt1_then_stop' : 'two_pt_stop_first',
        pt1_hit: pt1Hit,
        pt2_hit: pt2Hit,
        stop_hit: true,
        first_management_ts_utc: firstTs ?? bar.tsIso,
      };
    }
    if (!pt1Hit && bar.high >= target1) {
      pnl += risk * pt1R * POINT_VALUE_USD - cost;
      remaining -= 1;
      pt1Hit = true;
      firstTs = firstTs ?? bar.tsIso;
    }
    if (remaining > 0 && bar.high >= target2) {
      pnl += risk * pt2R * POINT_VALUE_USD - cost;
      remaining -= 1;
      pt2Hit = true;
      firstTs = firstTs ?? bar.tsIso;
      return {
        adjusted_net_usd: round(pnl, 4) ?? 0,
        adjusted_exit_reason: pt1Hit ? 'two_pt_both_targets_hit' : 'two_pt_pt2_hit_without_pt1',
        pt1_hit: pt1Hit,
        pt2_hit: pt2Hit,
        stop_hit: false,
        first_management_ts_utc: firstTs,
      };
    }
  }
  pnl += remaining * originalNet;
  return {
    adjusted_net_usd: round(pnl, 4) ?? 0,
    adjusted_exit_reason: pt1Hit ? 'two_pt_partial_then_source_exit' : 'source_exit_no_pt_or_stop',
    pt1_hit: pt1Hit,
    pt2_hit: pt2Hit,
    stop_hit: false,
    first_management_ts_utc: firstTs,
  };
}

function maxDrawdown(rows: ScenarioTrade[]): number {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const row of rows) {
    equity += row.adjusted_net_usd;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return maxDd;
}

function summary(rows: ScenarioTrade[]): Record<string, unknown> {
  const pnl = rows.map((row) => row.adjusted_net_usd);
  const wins = pnl.filter((value) => value > 0);
  const losses = pnl.filter((value) => value < 0);
  const net = pnl.reduce((sum, value) => sum + value, 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const dd = maxDrawdown(rows);
  return {
    trades: rows.length,
    net_usd: round(net, 2),
    gross_profit_usd: round(grossProfit, 2),
    gross_loss_usd: round(grossLoss, 2),
    profit_factor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : null,
    win_rate: rows.length > 0 ? round(wins.length / rows.length, 4) : null,
    avg_trade_usd: rows.length > 0 ? round(net / rows.length, 4) : null,
    max_drawdown_usd: round(dd, 2),
    pnl_to_max_drawdown: dd > 0 ? round(net / dd, 4) : null,
    stop_hit_count: rows.filter((row) => row.stop_hit).length,
    pt1_hit_count: rows.filter((row) => row.pt1_hit).length,
    pt2_hit_count: rows.filter((row) => row.pt2_hit).length,
    avg_pt_single_r: round(mean(rows.map((row) => row.pt_single_r).filter((value): value is number => value !== null)), 6),
    avg_pt1_r: round(mean(rows.map((row) => row.pt1_r).filter((value): value is number => value !== null)), 6),
    avg_pt2_r: round(mean(rows.map((row) => row.pt2_r).filter((value): value is number => value !== null)), 6),
  };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function makeUniverseRows(name: string, rows: Row[], predicate: (row: Row) => boolean, barsByDate: Map<string, Bar[]>): ScenarioTrade[] {
  const selected = rows.filter(predicate);
  const prior: Row[] = [];
  const scenarioRows: ScenarioTrade[] = [];
  for (const row of selected) {
    const targets = estimateTargets(prior);
    if (targets.single !== null && targets.pt1 !== null && targets.pt2 !== null) {
      const original = {
        adjusted_net_usd: round(CONTRACTS * (numeric(row, 'net_usd') ?? 0), 4) ?? 0,
        adjusted_exit_reason: 'source_exit_2contract_scaled',
        pt1_hit: false,
        pt2_hit: false,
        stop_hit: false,
        first_management_ts_utc: null,
      };
      const single = simulateSinglePt(row, barsByDate, targets.single);
      const two = simulateTwoPt(row, barsByDate, targets.pt1, targets.pt2);
      scenarioRows.push({
        ...row,
        universe: name,
        management: 'original_2contract_scaled_after_warmup',
        prior_trade_count: prior.length,
        pt_single_r: round(targets.single, 6),
        pt1_r: round(targets.pt1, 6),
        pt2_r: round(targets.pt2, 6),
        contracts: CONTRACTS,
        ...original,
      });
      scenarioRows.push({
        ...row,
        universe: name,
        management: 'single_dynamic_pt_2contracts',
        prior_trade_count: prior.length,
        pt_single_r: round(targets.single, 6),
        pt1_r: null,
        pt2_r: null,
        contracts: CONTRACTS,
        ...single,
      });
      scenarioRows.push({
        ...row,
        universe: name,
        management: 'two_dynamic_pt_1contract_each',
        prior_trade_count: prior.length,
        pt_single_r: null,
        pt1_r: round(targets.pt1, 6),
        pt2_r: round(targets.pt2, 6),
        contracts: CONTRACTS,
        ...two,
      });
    }
    prior.push(row);
  }
  return scenarioRows;
}

function groupSummary(rows: ScenarioTrade[]): Array<Record<string, unknown>> {
  const groups = new Map<string, ScenarioTrade[]>();
  for (const row of rows) {
    const key = `${row.universe}|${row.management}`;
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }
  return [...groups.entries()].map(([key, bucket]) => {
    const [universe, management] = key.split('|');
    return {
      universe,
      management,
      ...summary(bucket),
    };
  });
}

function byYear(rows: ScenarioTrade[]): Array<Record<string, unknown>> {
  const groups = new Map<string, ScenarioTrade[]>();
  for (const row of rows) {
    const year = text(row, 'trading_date').slice(0, 4);
    const key = `${row.universe}|${row.management}|${year}`;
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, bucket]) => {
    const [universe, management, year] = key.split('|');
    return { universe, management, year, ...summary(bucket) };
  });
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

function mdTable(rows: Array<Record<string, unknown>>, columns: string[]): string[] {
  return [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${columns.map((column) => row[column] ?? '').join(' | ')} |`),
  ];
}

async function main(): Promise<void> {
  mkdirSync(OUT_ROOT, { recursive: true });
  mkdirSync(path.dirname(DOC_PATH), { recursive: true });
  const rows = readCsv(INPUT_TRADES).sort((left, right) => Number(left.signal_ts_ns ?? 0) - Number(right.signal_ts_ns ?? 0));
  const barsByDate = await loadBarsByDate();
  const priorDown = new Set(['prior_down', 'prior_down_large']);
  const allRows = makeUniverseRows('all_breakout_long', rows, () => true, barsByDate);
  const candidateRows = makeUniverseRows(
    'prior_down_no_14_plus',
    rows,
    (row) => priorDown.has(text(row, 'prior_day_trend_state')) && text(row, 'breakout_time_bucket') !== '14:00+',
    barsByDate,
  );
  const scenarioRows = [...allRows, ...candidateRows];
  const summaryRows = groupSummary(scenarioRows);
  const yearRows = byYear(scenarioRows);
  const tradesCsv = path.join(OUT_ROOT, 'orb-breakout-long-dynamic-pt-2contract-trades.csv');
  const summaryCsv = path.join(OUT_ROOT, 'orb-breakout-long-dynamic-pt-2contract-summary.csv');
  const yearCsv = path.join(OUT_ROOT, 'orb-breakout-long-dynamic-pt-2contract-by-year.csv');
  const reportJson = path.join(OUT_ROOT, 'orb-breakout-long-dynamic-pt-2contract-report.json');
  const reportMd = path.join(OUT_ROOT, 'orb-breakout-long-dynamic-pt-2contract-report.md');
  const manifestPath = path.join(OUT_ROOT, 'manifest.json');
  writeCsv(tradesCsv, scenarioRows);
  writeCsv(summaryCsv, summaryRows);
  writeCsv(yearCsv, yearRows);
  const report = {
    generated_at_utc: new Date().toISOString(),
    determination: 'ORB_BREAKOUT_LONG_DYNAMIC_PT_2CONTRACT_BACKTEST_COMPLETE_DIAGNOSTIC_ONLY',
    input_trades: INPUT_TRADES,
    cache_ohlcv_1m_root: CACHE_OHLCV_1M_ROOT,
    assumptions: {
      contracts: CONTRACTS,
      min_prior_trades: MIN_PRIOR_TRADES,
      single_pt: 'prior 60th percentile of winning-trade MFE120/R',
      two_pt_1: 'prior median of winning-trade MFE60/R',
      two_pt_2: 'prior 75th percentile of winning-trade MFE120/R',
      same_bar_stop_target_ordering: 'stop_first_conservative',
      signal_minute_excluded_from_path: true,
    },
    guardrails: {
      diagnostic_only: true,
      runtime_unchanged: true,
      broker_authority_created: false,
      order_intent_authority_created: false,
      roster_mutated: false,
      full_sample_target_estimation_used: false,
    },
    summary: summaryRows,
    artifact_paths: { tradesCsv, summaryCsv, yearCsv, reportJson, reportMd, manifestPath, docPath: DOC_PATH },
  };
  writeFileSync(reportJson, `${JSON.stringify(report, null, 2)}\n`);
  const md = [
    '# QFA ORB breakout long dynamic PT 2-contract backtest - 2026-06-20',
    '',
    `Determination: \`${report.determination}\``,
    '',
    '## Scope',
    '',
    'Research-only 2-contract management backtest for `opening_range_box_breakout_long`.',
    '',
    'No broker action, no `ORDER_INTENT`, no runtime change, no paper/live authority, and no roster mutation are authorized.',
    '',
    '## Dynamic target definitions',
    '',
    'Targets are estimated walk-forward from prior trades only after 100 prior observations in the relevant universe.',
    '',
    '```text',
    'single PT = prior 60th percentile of winning-trade MFE120/R',
    'PT1 = prior median of winning-trade MFE60/R',
    'PT2 = prior 75th percentile of winning-trade MFE120/R',
    '```',
    '',
    'Path logic uses subsequent 1-minute bars after the signal minute. If stop and target are both touched in the same bar, the stop is counted first.',
    '',
    '## Summary',
    '',
    ...mdTable(summaryRows, ['universe', 'management', 'trades', 'net_usd', 'profit_factor', 'win_rate', 'avg_trade_usd', 'max_drawdown_usd', 'pnl_to_max_drawdown', 'stop_hit_count', 'pt1_hit_count', 'pt2_hit_count', 'avg_pt_single_r', 'avg_pt1_r', 'avg_pt2_r']),
    '',
    '## Interpretation',
    '',
    'This is a management-only diagnostic. Dynamic targets are not fitted on the full sample. The preferred universe remains the prior-down/no-14:00+ subset if it remains superior after the management overlay.',
    '',
    '## Artifacts',
    '',
    `- \`${tradesCsv}\``,
    `- \`${summaryCsv}\``,
    `- \`${yearCsv}\``,
    `- \`${reportJson}\``,
    `- \`${reportMd}\``,
  ].join('\n');
  writeFileSync(reportMd, `${md}\n`);
  writeFileSync(DOC_PATH, `${md}\n`);
  const manifest = {
    generated_at_utc: new Date().toISOString(),
    files: [tradesCsv, summaryCsv, yearCsv, reportJson, reportMd, DOC_PATH].map((file) => ({ path: file, lf_sha256: sha256Lf(file) })),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({
    status: 'ok',
    determination: report.determination,
    output_root: OUT_ROOT,
    doc_path: DOC_PATH,
    scenario_count: summaryRows.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
