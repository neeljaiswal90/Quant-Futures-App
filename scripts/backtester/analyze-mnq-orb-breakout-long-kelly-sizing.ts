// @ts-nocheck
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const INPUT_TRADES = 'artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-breakout-long-factor-audit-01/orb-breakout-long-factor-trades.csv';
const OUT_ROOT = 'artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-breakout-long-kelly-sizing-research-01';
const DOC_PATH = 'docs/research/qfa-orb-breakout-long-kelly-sizing-research-2026-06-20.md';
const POINT_VALUE_USD = 2;
const INITIAL_EQUITY_USD = 50_000;
const MAX_RISK_FRACTION = 0.0025;
const MIN_PRIOR_TRADES = 100;

type Row = Record<string, string | number | null>;
type ScenarioRow = Row & {
  scenario: string;
  prior_trade_count: number;
  raw_full_kelly_fraction: number | null;
  applied_risk_fraction: number;
  continuous_contract_equivalent: number;
  discrete_contracts: number;
  adjusted_net_usd_continuous: number;
  adjusted_net_usd_discrete: number;
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
  const parsed = Number(value);
  return Number.isFinite(parsed) && value.trim() !== '' ? parsed : value;
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

function round(value: number | null | undefined, digits = 4): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function initialRiskUsd(row: Row): number {
  const riskPoints = numeric(row, 'risk_points') ?? Math.abs((numeric(row, 'entry_price') ?? 0) - (numeric(row, 'stop_price') ?? 0));
  return Math.max(0.01, riskPoints * POINT_VALUE_USD);
}

function rMultiple(row: Row): number {
  return (numeric(row, 'net_usd') ?? 0) / initialRiskUsd(row);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
}

function estimateKellyFraction(rMultiples: number[]): number {
  const values = rMultiples.filter(Number.isFinite);
  if (values.length < MIN_PRIOR_TRADES || mean(values) <= 0) return 0;
  const worstLoss = Math.abs(Math.min(0, ...values));
  if (worstLoss <= 0) return 0;
  const upper = Math.min(1 / worstLoss * 0.999, 1);
  const derivative = (fraction: number): number => {
    let total = 0;
    for (const value of values) {
      const denominator = 1 + fraction * value;
      if (denominator <= 0) return Number.NEGATIVE_INFINITY;
      total += value / denominator;
    }
    return total / values.length;
  };
  if (derivative(0) <= 0) return 0;
  if (derivative(upper) >= 0) return upper;
  let low = 0;
  let high = upper;
  for (let index = 0; index < 80; index += 1) {
    const mid = (low + high) / 2;
    if (derivative(mid) > 0) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return (low + high) / 2;
}

function maxDrawdown(pnl: number[]): number {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const value of pnl) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return maxDd;
}

function summarize(rows: ScenarioRow[], pnlKey: 'adjusted_net_usd_continuous' | 'adjusted_net_usd_discrete'): Record<string, unknown> {
  const pnl = rows.map((row) => Number(row[pnlKey] ?? 0));
  const wins = pnl.filter((value) => value > 0);
  const losses = pnl.filter((value) => value < 0);
  const net = pnl.reduce((sum, value) => sum + value, 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const dd = maxDrawdown(pnl);
  const applied = rows.map((row) => row.applied_risk_fraction).filter(Number.isFinite);
  const raw = rows.map((row) => row.raw_full_kelly_fraction).filter((value): value is number => value !== null && Number.isFinite(value));
  const contracts = rows.map((row) => row.continuous_contract_equivalent).filter(Number.isFinite);
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
    avg_applied_risk_fraction: round(mean(applied), 8),
    avg_raw_full_kelly_fraction: round(mean(raw), 8),
    avg_continuous_contract_equivalent: round(mean(contracts), 6),
    discrete_positive_contract_trades: rows.filter((row) => row.discrete_contracts > 0).length,
  };
}

function makeScenarioRows(rows: Row[], scenario: string, multiplier: number | null, useFixedRisk: boolean, discrete: boolean): ScenarioRow[] {
  const priorRs: number[] = [];
  const out: ScenarioRow[] = [];
  for (const row of rows) {
    const priorTradeCount = priorRs.length;
    const rawKelly = priorTradeCount >= MIN_PRIOR_TRADES ? estimateKellyFraction(priorRs) : null;
    const appliedRiskFraction = useFixedRisk
      ? MAX_RISK_FRACTION
      : rawKelly === null
        ? 0
        : Math.min(MAX_RISK_FRACTION, Math.max(0, rawKelly * (multiplier ?? 0)));
    const riskUsd = initialRiskUsd(row);
    const continuousContractEquivalent = riskUsd > 0 ? (INITIAL_EQUITY_USD * appliedRiskFraction) / riskUsd : 0;
    const discreteContracts = discrete ? Math.floor(continuousContractEquivalent + 1e-12) : 0;
    const actualNet = numeric(row, 'net_usd') ?? 0;
    const continuousNet = actualNet * continuousContractEquivalent;
    const discreteNet = actualNet * discreteContracts;
    out.push({
      ...row,
      scenario,
      prior_trade_count: priorTradeCount,
      raw_full_kelly_fraction: rawKelly === null ? null : round(rawKelly, 8),
      applied_risk_fraction: round(appliedRiskFraction, 8) ?? 0,
      continuous_contract_equivalent: round(continuousContractEquivalent, 6) ?? 0,
      discrete_contracts: discreteContracts,
      adjusted_net_usd_continuous: round(continuousNet, 4) ?? 0,
      adjusted_net_usd_discrete: round(discreteNet, 4) ?? 0,
    });
    priorRs.push(rMultiple(row));
  }
  return out;
}

function byYear(rows: ScenarioRow[], pnlKey: 'adjusted_net_usd_continuous' | 'adjusted_net_usd_discrete'): Array<Record<string, unknown>> {
  const groups = new Map<string, ScenarioRow[]>();
  for (const row of rows) {
    const date = String(row.trading_date ?? '');
    const year = date.slice(0, 4);
    const existing = groups.get(year) ?? [];
    existing.push(row);
    groups.set(year, existing);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([year, bucket]) => ({
    year,
    ...summarize(bucket, pnlKey),
  }));
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

function main(): void {
  mkdirSync(OUT_ROOT, { recursive: true });
  mkdirSync(path.dirname(DOC_PATH), { recursive: true });
  const rows = readCsv(INPUT_TRADES).sort((left, right) => Number(left.signal_ts_ns ?? 0) - Number(right.signal_ts_ns ?? 0));
  const actualRows = rows.map((row) => ({
    ...row,
    scenario: 'one_contract_actual',
    prior_trade_count: 0,
    raw_full_kelly_fraction: null,
    applied_risk_fraction: initialRiskUsd(row) / INITIAL_EQUITY_USD,
    continuous_contract_equivalent: 1,
    discrete_contracts: 1,
    adjusted_net_usd_continuous: numeric(row, 'net_usd') ?? 0,
    adjusted_net_usd_discrete: numeric(row, 'net_usd') ?? 0,
  })) as ScenarioRow[];
  const fixedContinuous = makeScenarioRows(rows, 'fixed_025pct_continuous', null, true, false);
  const fixedDiscrete = makeScenarioRows(rows, 'fixed_025pct_discrete_floor', null, true, true);
  const fullKelly = makeScenarioRows(rows, 'walkforward_full_kelly_capped_025pct_continuous', 1, false, false);
  const quarterKelly = makeScenarioRows(rows, 'walkforward_quarter_kelly_capped_025pct_continuous', 0.25, false, false);
  const eighthKelly = makeScenarioRows(rows, 'walkforward_eighth_kelly_capped_025pct_continuous', 0.125, false, false);
  const quarterDiscrete = makeScenarioRows(rows, 'walkforward_quarter_kelly_capped_025pct_discrete_floor', 0.25, false, true);
  const allScenarioRows = [
    ...actualRows,
    ...fixedContinuous,
    ...fixedDiscrete,
    ...fullKelly,
    ...quarterKelly,
    ...eighthKelly,
    ...quarterDiscrete,
  ];
  const scenarios = [
    { name: 'one_contract_actual', rows: actualRows, key: 'adjusted_net_usd_continuous' as const },
    { name: 'fixed_025pct_continuous', rows: fixedContinuous, key: 'adjusted_net_usd_continuous' as const },
    { name: 'fixed_025pct_discrete_floor', rows: fixedDiscrete, key: 'adjusted_net_usd_discrete' as const },
    { name: 'walkforward_full_kelly_capped_025pct_continuous', rows: fullKelly, key: 'adjusted_net_usd_continuous' as const },
    { name: 'walkforward_quarter_kelly_capped_025pct_continuous', rows: quarterKelly, key: 'adjusted_net_usd_continuous' as const },
    { name: 'walkforward_eighth_kelly_capped_025pct_continuous', rows: eighthKelly, key: 'adjusted_net_usd_continuous' as const },
    { name: 'walkforward_quarter_kelly_capped_025pct_discrete_floor', rows: quarterDiscrete, key: 'adjusted_net_usd_discrete' as const },
  ];
  const summaryRows = scenarios.map((scenario) => ({
    scenario: scenario.name,
    pnl_mode: scenario.key === 'adjusted_net_usd_discrete' ? 'discrete_floor_contracts' : 'continuous_contract_equivalent',
    ...summarize(scenario.rows, scenario.key),
  }));
  const yearRows = scenarios.flatMap((scenario) => byYear(scenario.rows, scenario.key).map((row) => ({ scenario: scenario.name, ...row })));
  const rValues = rows.map(rMultiple);
  const rSummary = {
    trades: rValues.length,
    mean_r: round(mean(rValues), 8),
    variance_r: round(variance(rValues), 8),
    sample_full_kelly_fraction_in_sample_diagnostic: round(estimateKellyFraction(rValues), 8),
    min_r: round(Math.min(...rValues), 8),
    max_r: round(Math.max(...rValues), 8),
  };

  const overlayCsv = path.join(OUT_ROOT, 'orb-breakout-long-kelly-sizing-overlay-trades.csv');
  const summaryCsv = path.join(OUT_ROOT, 'orb-breakout-long-kelly-sizing-summary.csv');
  const yearCsv = path.join(OUT_ROOT, 'orb-breakout-long-kelly-sizing-by-year.csv');
  const reportJson = path.join(OUT_ROOT, 'orb-breakout-long-kelly-sizing-report.json');
  const reportMd = path.join(OUT_ROOT, 'orb-breakout-long-kelly-sizing-report.md');
  const manifestPath = path.join(OUT_ROOT, 'manifest.json');
  writeCsv(overlayCsv, allScenarioRows);
  writeCsv(summaryCsv, summaryRows);
  writeCsv(yearCsv, yearRows);

  const report = {
    generated_at_utc: new Date().toISOString(),
    determination: 'ORB_BREAKOUT_LONG_KELLY_SIZING_RESEARCH_COMPLETE_RUNTIME_UNCHANGED',
    input_trades: INPUT_TRADES,
    assumptions: {
      strategy_id: 'opening_range_box_breakout_long',
      initial_equity_usd: INITIAL_EQUITY_USD,
      point_value_usd: POINT_VALUE_USD,
      max_risk_fraction: MAX_RISK_FRACTION,
      min_prior_trades: MIN_PRIOR_TRADES,
      kelly_estimator: 'expanding prior trades only; numeric log-growth optimum over historical R-multiples',
      r_multiple_basis: 'net_usd / (risk_points * point_value_usd)',
    },
    guardrails: {
      runtime_unchanged: true,
      broker_authority_created: false,
      order_intent_authority_created: false,
      roster_mutated: false,
      full_sample_kelly_used_for_trading: false,
      max_risk_fraction_cap_applied_to_walk_forward_scenarios: true,
    },
    r_summary: rSummary,
    scenario_summary: summaryRows,
    artifact_paths: { overlayCsv, summaryCsv, yearCsv, reportJson, reportMd, manifestPath, docPath: DOC_PATH },
  };
  writeFileSync(reportJson, `${JSON.stringify(report, null, 2)}\n`);
  const md = [
    '# QFA ORB breakout long Kelly sizing research - 2026-06-20',
    '',
    `Determination: \`${report.determination}\``,
    '',
    '## Scope',
    '',
    'Research-only Kelly sizing audit for `opening_range_box_breakout_long`.',
    '',
    'Runtime sizing is unchanged. No broker action, no `ORDER_INTENT`, no paper/live authority, and no roster mutation are authorized.',
    '',
    '## Method',
    '',
    'Kelly is estimated from historical R-multiples:',
    '',
    '```text',
    'R = net_usd / (risk_points * $2 MNQ point value)',
    '```',
    '',
    'The walk-forward estimator uses expanding prior trades only after 100 prior observations. Full-sample Kelly is reported only as an in-sample diagnostic and is not used for walk-forward sizing.',
    '',
    'Applied Kelly fractions are capped at 0.25% equity risk per trade.',
    '',
    '## R-multiple summary',
    '',
    '```json',
    JSON.stringify(rSummary, null, 2),
    '```',
    '',
    '## Scenario summary',
    '',
    ...mdTable(summaryRows, ['scenario', 'pnl_mode', 'trades', 'net_usd', 'profit_factor', 'win_rate', 'avg_trade_usd', 'max_drawdown_usd', 'pnl_to_max_drawdown', 'avg_applied_risk_fraction', 'avg_raw_full_kelly_fraction', 'avg_continuous_contract_equivalent', 'discrete_positive_contract_trades']),
    '',
    '## Interpretation',
    '',
    'The discrete 0.25% cap is usually too small for one MNQ contract when stop distance is large, so the discrete-floor variants mostly skip trades. Continuous Kelly sizing is useful for research, but it is not directly executable at small account size.',
    '',
    'Do not promote Kelly to runtime until the forward shadow stream has enough accepted trades to estimate edge without relying on the same backtest used for selection.',
    '',
    '## Artifacts',
    '',
    `- \`${overlayCsv}\``,
    `- \`${summaryCsv}\``,
    `- \`${yearCsv}\``,
    `- \`${reportJson}\``,
    `- \`${reportMd}\``,
  ].join('\n');
  writeFileSync(reportMd, `${md}\n`);
  writeFileSync(DOC_PATH, `${md}\n`);
  const manifest = {
    generated_at_utc: new Date().toISOString(),
    files: [overlayCsv, summaryCsv, yearCsv, reportJson, reportMd, DOC_PATH].map((file) => ({ path: file, lf_sha256: sha256Lf(file) })),
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

main();
