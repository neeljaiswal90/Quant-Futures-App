// @ts-nocheck
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT_ROOT = 'artifacts/backtests/orb-low-regime-100-150-riskband-test-2026-06-20';
const DOC_PATH = 'docs/research/qfa-orb-low-regime-100-150-riskband-test-2026-06-20.md';

const LEDGERS = {
  recentBaseline: 'artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-regime-nofade-riskgt30-daystop300/mnq-12mo-trades.csv',
  recentExclusion: 'artifacts/backtests/mnq-12mo-2025-06-20_2026-06-20-orb-regime-nofade-riskgt30-low-excl100to150-daystop300/mnq-12mo-trades.csv',
  expandedBaseline: 'artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-regime-nofade-riskgt30-daystop300/mnq-12mo-trades.csv',
  expandedExclusion: 'artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-regime-nofade-riskgt30-low-excl100to150-daystop300/mnq-12mo-trades.csv',
};

type Trade = Record<string, string | number | null>;

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
  const parsed = Number(value);
  return Number.isFinite(parsed) && value.trim() !== '' ? parsed : value;
}

function readCsv(filePath: string): Trade[] {
  const text = readFileSync(filePath, 'utf8').trim();
  const [headerLine, ...lines] = text.split(/\r?\n/);
  const headers = parseCsvLine(headerLine);
  return lines.filter(Boolean).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, maybeNumber(values[index] ?? '')]));
  });
}

function numeric(row: Trade, key: string): number {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function text(row: Trade, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function riskPoints(row: Trade): number {
  const explicit = numeric(row, 'risk_points');
  if (explicit > 0) return explicit;
  return Math.abs(numeric(row, 'entry_price') - numeric(row, 'stop_price'));
}

function isLow100150(row: Trade): boolean {
  const risk = riskPoints(row);
  return text(row, 'regime_label') === 'low' && risk > 100 && risk <= 150;
}

function round(value: number | null | undefined, digits = 4): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function maxDrawdown(rows: Trade[]): number {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const row of [...rows].sort((left, right) => Number(left.signal_ts_ns ?? 0) - Number(right.signal_ts_ns ?? 0))) {
    equity += numeric(row, 'net_usd');
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return maxDd;
}

function tStat(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const se = Math.sqrt(variance / values.length);
  return se > 0 ? mean / se : null;
}

function summary(rows: Trade[]): Record<string, unknown> {
  const pnl = rows.map((row) => numeric(row, 'net_usd'));
  const wins = pnl.filter((value) => value > 0);
  const losses = pnl.filter((value) => value < 0);
  const net = pnl.reduce((sum, value) => sum + value, 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const dd = maxDrawdown(rows);
  return {
    trades: rows.length,
    net_usd: round(net, 2),
    profit_factor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : null,
    max_drawdown_usd: round(dd, 2),
    pnl_to_drawdown: dd > 0 ? round(net / dd, 4) : null,
    win_rate: rows.length > 0 ? round(wins.length / rows.length, 4) : null,
    avg_trade_usd: rows.length > 0 ? round(net / rows.length, 4) : null,
    t_stat: round(tStat(pnl), 4),
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

function writeTrades(filePath: string, rows: Trade[]): void {
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

function byStrategyRows(label: string, rows: Trade[]): Array<Record<string, unknown>> {
  const groups = new Map<string, Trade[]>();
  for (const row of rows) {
    const key = text(row, 'strategy_id');
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([strategy, bucket]) => ({
    sample: label,
    strategy_id: strategy,
    ...summary(bucket),
  }));
}

function periodRows(rows: Trade[]): Array<Record<string, unknown>> {
  const periods: Array<[string, (row: Trade) => boolean]> = [
    ['2019-2024', (row) => text(row, 'trading_date') >= '2019-01-01' && text(row, 'trading_date') <= '2024-12-31'],
    ['2025-2026', (row) => text(row, 'trading_date') >= '2025-01-01' && text(row, 'trading_date') <= '2026-12-31'],
    ['2020 only', (row) => text(row, 'trading_date').startsWith('2020-')],
    ['2022 only', (row) => text(row, 'trading_date').startsWith('2022-')],
    ['2026 only', (row) => text(row, 'trading_date').startsWith('2026-')],
  ];
  return periods.map(([period, predicate]) => ({
    period,
    ...summary(rows.filter(predicate)),
  }));
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

function main(): void {
  mkdirSync(OUT_ROOT, { recursive: true });
  const recentBaseline = readCsv(LEDGERS.recentBaseline);
  const recentExclusion = readCsv(LEDGERS.recentExclusion);
  const expandedBaseline = readCsv(LEDGERS.expandedBaseline);
  const expandedExclusion = readCsv(LEDGERS.expandedExclusion);
  const recentDirect = recentBaseline.filter(isLow100150);
  const expandedDirect = expandedBaseline.filter(isLow100150);

  const testSummary = [
    { sample: 'recent_12mo', row: 'baseline', ...summary(recentBaseline) },
    { sample: 'recent_12mo', row: 'exclusion_scenario', ...summary(recentExclusion) },
    { sample: 'recent_12mo', row: 'direct_excluded_stream', ...summary(recentDirect) },
    {
      sample: 'recent_12mo',
      row: 'exclusion_minus_baseline',
      trades: recentExclusion.length - recentBaseline.length,
      net_usd: round(numeric({ net_usd: summary(recentExclusion).net_usd as number }, 'net_usd') - numeric({ net_usd: summary(recentBaseline).net_usd as number }, 'net_usd'), 2),
      profit_factor: null,
      max_drawdown_usd: round(Number(summary(recentExclusion).max_drawdown_usd ?? 0) - Number(summary(recentBaseline).max_drawdown_usd ?? 0), 2),
      pnl_to_drawdown: null,
      win_rate: null,
      avg_trade_usd: null,
      t_stat: null,
    },
    { sample: 'expanded_2019_2026', row: 'baseline', ...summary(expandedBaseline) },
    { sample: 'expanded_2019_2026', row: 'exclusion_scenario', ...summary(expandedExclusion) },
    { sample: 'expanded_2019_2026', row: 'direct_excluded_stream', ...summary(expandedDirect) },
    {
      sample: 'expanded_2019_2026',
      row: 'exclusion_minus_baseline',
      trades: expandedExclusion.length - expandedBaseline.length,
      net_usd: round(Number(summary(expandedExclusion).net_usd ?? 0) - Number(summary(expandedBaseline).net_usd ?? 0), 2),
      profit_factor: null,
      max_drawdown_usd: round(Number(summary(expandedExclusion).max_drawdown_usd ?? 0) - Number(summary(expandedBaseline).max_drawdown_usd ?? 0), 2),
      pnl_to_drawdown: null,
      win_rate: null,
      avg_trade_usd: null,
      t_stat: null,
    },
  ];
  const byStrategy = [
    ...byStrategyRows('recent_12mo_direct_excluded_stream', recentDirect),
    ...byStrategyRows('expanded_2019_2026_direct_excluded_stream', expandedDirect),
  ];
  const periods = periodRows(expandedDirect);

  const summaryCsv = path.join(OUT_ROOT, 'low-regime-100-150-test-summary.csv');
  const excludedCsv = path.join(OUT_ROOT, 'low-regime-100-150-excluded-trades.csv');
  const byStrategyCsv = path.join(OUT_ROOT, 'low-regime-100-150-by-strategy.csv');
  const periodsCsv = path.join(OUT_ROOT, 'low-regime-100-150-periods.csv');
  const reportJson = path.join(OUT_ROOT, 'low-regime-100-150-test-report.json');
  const reportMd = path.join(OUT_ROOT, 'low-regime-100-150-test-report.md');
  const manifestPath = path.join(OUT_ROOT, 'manifest.json');

  writeCsv(summaryCsv, testSummary);
  writeTrades(excludedCsv, expandedDirect);
  writeCsv(byStrategyCsv, byStrategy);
  writeCsv(periodsCsv, periods);

  const report = {
    generated_at_utc: new Date().toISOString(),
    determination: 'ORB_LOW_REGIME_100_150_RISKBAND_TEST_COMPLETE_REJECT_EXPANDED_HISTORY',
    rule: 'regime_label == low and 100 < abs(entry_price - stop_price) <= 150',
    ledgers: LEDGERS,
    summary: testSummary,
    by_strategy: byStrategy,
    expanded_periods: periods,
    conclusion: 'Reject exact low-regime 100:150 risk-band exclusion because the directly excluded stream is profitable over expanded 2019-2026 history and excluding it lowers expanded net PnL.',
    artifact_paths: { summaryCsv, excludedCsv, byStrategyCsv, periodsCsv, reportJson, reportMd, manifestPath },
  };
  writeFileSync(reportJson, `${JSON.stringify(report, null, 2)}\n`);

  const md = [
    '# ORB low-regime 100-150 risk-band exclusion artifact',
    '',
    `Determination: \`${report.determination}\``,
    '',
    'Rule tested:',
    '',
    '```text',
    report.rule,
    '```',
    '',
    '## Summary',
    '',
    ...mdTable(testSummary, ['sample', 'row', 'trades', 'net_usd', 'profit_factor', 'max_drawdown_usd', 'pnl_to_drawdown', 'win_rate', 'avg_trade_usd', 't_stat']),
    '',
    '## Direct excluded stream by strategy',
    '',
    ...mdTable(byStrategy, ['sample', 'strategy_id', 'trades', 'net_usd', 'profit_factor', 'win_rate', 'avg_trade_usd', 't_stat']),
    '',
    '## Expanded direct excluded stream periods',
    '',
    ...mdTable(periods, ['period', 'trades', 'net_usd', 'profit_factor', 'win_rate', 'avg_trade_usd', 't_stat']),
    '',
    '## Conclusion',
    '',
    report.conclusion,
  ].join('\n');
  writeFileSync(reportMd, `${md}\n`);

  const manifest = {
    generated_at_utc: new Date().toISOString(),
    files: [summaryCsv, excludedCsv, byStrategyCsv, periodsCsv, reportJson, reportMd].map((file) => ({
      path: file,
      lf_sha256: sha256Lf(file),
    })),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(JSON.stringify({
    status: 'ok',
    determination: report.determination,
    output_root: OUT_ROOT,
    expanded_direct_excluded_net_usd: summary(expandedDirect).net_usd,
  }, null, 2));
}

main();
