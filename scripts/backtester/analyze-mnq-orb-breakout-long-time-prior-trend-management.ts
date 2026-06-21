// @ts-nocheck
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const INPUT_TRADES = 'artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-breakout-long-factor-audit-01/orb-breakout-long-factor-trades.csv';
const OUT_ROOT = 'artifacts/backtests/mnq-included-2019-05-06_2026-06-20-orb-breakout-long-time-prior-trend-management-audit-01';
const DOC_PATH = 'docs/research/qfa-orb-breakout-long-time-prior-trend-management-audit-2026-06-20.md';
const POINT_VALUE_USD = 2;

type Row = Record<string, string | number | null>;

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

function round(value: number | null | undefined, digits = 4): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function numeric(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(row: Row, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function maxDrawdown(rows: Row[]): number {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const row of [...rows].sort((left, right) => Number(left.signal_ts_ns ?? 0) - Number(right.signal_ts_ns ?? 0))) {
    equity += numeric(row, 'net_usd') ?? 0;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return maxDd;
}

function average(rows: Row[], key: string): number | null {
  const values = rows.map((row) => numeric(row, key)).filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summary(rows: Row[]): Record<string, unknown> {
  const pnl = rows.map((row) => numeric(row, 'net_usd') ?? 0);
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
    avg_net_usd: rows.length > 0 ? round(net / rows.length, 4) : null,
    max_drawdown_usd: round(dd, 2),
    pnl_to_max_drawdown: dd > 0 ? round(net / dd, 4) : null,
    avg_mfe_30m_to_risk: round(average(rows, 'mfe_30m') === null || average(rows, 'risk_points') === null ? null : average(rows, 'mfe_30m')! / average(rows, 'risk_points')!, 6),
    avg_mae_30m_to_risk: round(average(rows, 'mae_30m') === null || average(rows, 'risk_points') === null ? null : average(rows, 'mae_30m')! / average(rows, 'risk_points')!, 6),
    avg_mfe_60m_to_risk: round(average(rows, 'mfe_60m_to_risk'), 6),
    avg_mae_60m_to_risk: round(average(rows, 'mae_60m_to_risk'), 6),
    avg_mfe_120m_to_risk: round(average(rows, 'mfe_120m') === null || average(rows, 'risk_points') === null ? null : average(rows, 'mfe_120m')! / average(rows, 'risk_points')!, 6),
    avg_mae_120m_to_risk: round(average(rows, 'mae_120m') === null || average(rows, 'risk_points') === null ? null : average(rows, 'mae_120m')! / average(rows, 'risk_points')!, 6),
  };
}

function scenarioSummary(allRows: Row[], name: string, description: string, predicate: (row: Row) => boolean): Record<string, unknown> {
  const selected = allRows.filter(predicate);
  const removed = allRows.filter((row) => !predicate(row));
  return {
    scenario: name,
    description,
    selected_trades: selected.length,
    removed_trades: removed.length,
    removed_net_usd: round(removed.reduce((sum, row) => sum + (numeric(row, 'net_usd') ?? 0), 0), 2),
    ...summary(selected),
  };
}

function groupSummary(rows: Row[], factor: string, selector: (row: Row) => string): Record<string, unknown>[] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = selector(row);
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([bucket, bucketRows]) => ({ factor, bucket, ...summary(bucketRows) }));
}

function managementDiagnostic(rows: Row[], name: string, description: string, predicate: (row: Row) => boolean): Record<string, unknown> {
  const flagged = rows.filter(predicate);
  const notFlagged = rows.filter((row) => !predicate(row));
  const wins = rows.filter((row) => (numeric(row, 'net_usd') ?? 0) > 0);
  const losses = rows.filter((row) => (numeric(row, 'net_usd') ?? 0) < 0);
  const flaggedWins = flagged.filter((row) => (numeric(row, 'net_usd') ?? 0) > 0);
  const flaggedLosses = flagged.filter((row) => (numeric(row, 'net_usd') ?? 0) < 0);
  return {
    diagnostic: name,
    description,
    flagged_trades: flagged.length,
    not_flagged_trades: notFlagged.length,
    flagged_net_usd: round(flagged.reduce((sum, row) => sum + (numeric(row, 'net_usd') ?? 0), 0), 2),
    not_flagged_net_usd: round(notFlagged.reduce((sum, row) => sum + (numeric(row, 'net_usd') ?? 0), 0), 2),
    flagged_avg_net_usd: flagged.length > 0 ? round(flagged.reduce((sum, row) => sum + (numeric(row, 'net_usd') ?? 0), 0) / flagged.length, 4) : null,
    not_flagged_avg_net_usd: notFlagged.length > 0 ? round(notFlagged.reduce((sum, row) => sum + (numeric(row, 'net_usd') ?? 0), 0) / notFlagged.length, 4) : null,
    loss_capture_rate: losses.length > 0 ? round(flaggedLosses.length / losses.length, 4) : null,
    win_false_positive_rate: wins.length > 0 ? round(flaggedWins.length / wins.length, 4) : null,
    flagged_profit_factor: summary(flagged).profit_factor,
    not_flagged_profit_factor: summary(notFlagged).profit_factor,
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

function mdTable(rows: Array<Record<string, unknown>>, columns: string[]): string[] {
  return [
    `| ${columns.join(' |')} |`,
    `| ${columns.map(() => '---').join(' |')} |`,
    ...rows.map((row) => `| ${columns.map((column) => row[column] ?? '').join(' |')} |`),
  ];
}

function main(): void {
  if (!existsSync(INPUT_TRADES)) {
    throw new Error(`Missing input factor trades: ${INPUT_TRADES}`);
  }
  mkdirSync(OUT_ROOT, { recursive: true });
  mkdirSync(path.dirname(DOC_PATH), { recursive: true });
  const rows = readCsv(INPUT_TRADES);
  const priorDownFamily = new Set(['prior_down', 'prior_down_large']);
  const priorUpFamily = new Set(['prior_up', 'prior_up_large']);

  const scenarios = [
    scenarioSummary(rows, 'baseline_all_breakout_long', 'All opening_range_box_breakout_long trades from the expanded-cache baseline ledger.', () => true),
    scenarioSummary(rows, 'exclude_14_plus', 'Exclude signal time bucket 14:00+ only. This is the predeclared late-chase avoid-zone test.', (row) => text(row, 'breakout_time_bucket') !== '14:00+'),
    scenarioSummary(rows, 'exclude_late_chase_13_plus', 'Diagnostic only: exclude the broader late_chase label, which starts at 13:00 in the factor audit.', (row) => text(row, 'early_continuation_vs_late_chase') !== 'late_chase'),
    scenarioSummary(rows, 'prior_down_family_only', 'Keep prior_down and prior_down_large only; broad prior-session weakness conditioning test.', (row) => priorDownFamily.has(text(row, 'prior_day_trend_state'))),
    scenarioSummary(rows, 'prior_up_family_only_contrast', 'Keep prior_up and prior_up_large only; contrast set, not a promotion candidate.', (row) => priorUpFamily.has(text(row, 'prior_day_trend_state'))),
    scenarioSummary(rows, 'exclude_or_prior_gt_075', 'Exclude only very-large opening ranges above 0.75 of prior range; broad OR-size stress test.', (row) => text(row, 'opening_range_size_bucket') !== '>0.75'),
  ];

  const factorRows = [
    ...groupSummary(rows, 'breakout_time_bucket', (row) => text(row, 'breakout_time_bucket')),
    ...groupSummary(rows, 'prior_day_trend_state', (row) => text(row, 'prior_day_trend_state')),
    ...groupSummary(rows, 'opening_range_size_to_prior_range', (row) => text(row, 'opening_range_size_bucket')),
    ...groupSummary(rows, 'early_continuation_vs_late_chase', (row) => text(row, 'early_continuation_vs_late_chase')),
  ];

  const diagnostics = [
    managementDiagnostic(rows, 'mae30_ge_050_risk', 'Flag trades whose first 30m MAE reaches at least 50% of initial risk. Ex-post path diagnostic, not executable stop proof.', (row) => {
      const mae = numeric(row, 'mae_30m');
      const risk = numeric(row, 'risk_points');
      return mae !== null && risk !== null && risk > 0 && mae / risk >= 0.5;
    }),
    managementDiagnostic(rows, 'mae30_ge_075_risk', 'Flag trades whose first 30m MAE reaches at least 75% of initial risk. Ex-post path diagnostic, not executable stop proof.', (row) => {
      const mae = numeric(row, 'mae_30m');
      const risk = numeric(row, 'risk_points');
      return mae !== null && risk !== null && risk > 0 && mae / risk >= 0.75;
    }),
    managementDiagnostic(rows, 'mae60_ge_050_risk', 'Flag trades whose first 60m MAE reaches at least 50% of initial risk. Ex-post path diagnostic, not executable stop proof.', (row) => (numeric(row, 'mae_60m_to_risk') ?? -Infinity) >= 0.5),
    managementDiagnostic(rows, 'mae60_ge_075_risk', 'Flag trades whose first 60m MAE reaches at least 75% of initial risk. Ex-post path diagnostic, not executable stop proof.', (row) => (numeric(row, 'mae_60m_to_risk') ?? -Infinity) >= 0.75),
    managementDiagnostic(rows, 'mfe60_lt_025_risk', 'Flag trades with less than 25% risk-equivalent favorable excursion during first 60m. Continuation-failure diagnostic.', (row) => (numeric(row, 'mfe_60m_to_risk') ?? Infinity) < 0.25),
    managementDiagnostic(rows, 'mfe60_lt_050_risk', 'Flag trades with less than 50% risk-equivalent favorable excursion during first 60m. Continuation-failure diagnostic.', (row) => (numeric(row, 'mfe_60m_to_risk') ?? Infinity) < 0.5),
    managementDiagnostic(rows, 'early_failure_mae60_ge050_mfe60_lt050', 'Flag trades with first 60m MAE >= 50% risk and MFE < 50% risk. Combined broad early-failure diagnostic.', (row) => (numeric(row, 'mae_60m_to_risk') ?? -Infinity) >= 0.5 && (numeric(row, 'mfe_60m_to_risk') ?? Infinity) < 0.5),
  ];

  const scenarioCsv = path.join(OUT_ROOT, 'orb-breakout-long-scenario-summary.csv');
  const factorCsv = path.join(OUT_ROOT, 'orb-breakout-long-factor-summary.csv');
  const managementCsv = path.join(OUT_ROOT, 'orb-breakout-long-management-diagnostic-summary.csv');
  const reportJson = path.join(OUT_ROOT, 'orb-breakout-long-time-prior-trend-management-report.json');
  const reportMd = path.join(OUT_ROOT, 'orb-breakout-long-time-prior-trend-management-report.md');
  const manifestPath = path.join(OUT_ROOT, 'manifest.json');

  writeCsv(scenarioCsv, scenarios);
  writeCsv(factorCsv, factorRows);
  writeCsv(managementCsv, diagnostics);

  const report = {
    generated_at_utc: new Date().toISOString(),
    determination: 'ORB_BREAKOUT_LONG_TIME_PRIOR_TREND_MANAGEMENT_AUDIT_COMPLETE_DIAGNOSTIC_ONLY',
    input_trades: INPUT_TRADES,
    guardrails: {
      diagnostic_only: true,
      broker_authority_created: false,
      order_intent_authority_created: false,
      roster_mutated: false,
      threshold_optimization_performed: false,
      narrow_boundary_tuning_performed: false,
      management_diagnostics_are_ex_post_path_statistics: true,
    },
    assumptions: {
      point_value_usd: POINT_VALUE_USD,
      strategy_id: 'opening_range_box_breakout_long',
      fixed_tests: [
        'exclude_14_plus',
        'prior_down_family_only',
        'broad opening_range_size_to_prior_range buckets',
        '30/60/120m MFE/MAE diagnostics',
      ],
    },
    scenarios,
    management_diagnostics: diagnostics,
    artifact_paths: { scenarioCsv, factorCsv, managementCsv, reportJson, reportMd, manifestPath, docPath: DOC_PATH },
  };
  writeFileSync(reportJson, `${JSON.stringify(report, null, 2)}\n`);

  const md = [
    '# QFA ORB breakout long time, trend, and management audit - 2026-06-20',
    '',
    `Determination: \`${report.determination}\``,
    '',
    '## Scope and guardrails',
    '',
    'This is a diagnostic-only pass for `opening_range_box_breakout_long` over the expanded cache trade-level factor artifact.',
    '',
    'No broker action, no `ORDER_INTENT`, no paper/live authority, no roster mutation, and no strategy promotion are authorized by this report.',
    '',
    'The scenario set was fixed before running this pass:',
    '',
    '```text',
    'exclude 14:00+ breakout entries',
    'test prior-day trend conditioning',
    'inspect broad OR/prior buckets',
    'audit 30/60/120m MFE/MAE management diagnostics',
    '```',
    '',
    'Management diagnostics are ex-post path statistics. They do not prove an executable intrabar stop or exit without a later path-ordered simulation.',
    '',
    '## Scenario summary',
    '',
    ...mdTable(scenarios, ['scenario', 'selected_trades', 'removed_trades', 'removed_net_usd', 'net_usd', 'profit_factor', 'win_rate', 'avg_net_usd', 'max_drawdown_usd', 'pnl_to_max_drawdown']),
    '',
    '## Management diagnostics',
    '',
    ...mdTable(diagnostics, ['diagnostic', 'flagged_trades', 'flagged_net_usd', 'flagged_avg_net_usd', 'not_flagged_net_usd', 'not_flagged_avg_net_usd', 'loss_capture_rate', 'win_false_positive_rate', 'flagged_profit_factor', 'not_flagged_profit_factor']),
    '',
    '## Interpretation',
    '',
    'The most defensible entry-side finding is the `14:00+` avoid-zone. It removes a negative subset without using a narrow price/risk boundary.',
    '',
    'Prior-day trend conditioning is materially stronger after prior-session weakness. Treat this as a broad contextual feature, not a standalone promotion rule until it is validated forward.',
    '',
    'The management diagnostics show that early adverse excursion and continuation failure are meaningful separators, but the current artifact does not preserve path ordering inside the 30/60/120m windows. A later executable management test must use minute-by-minute path ordering before claiming live stop/exit feasibility.',
    '',
    '## Artifacts',
    '',
    `- \`${scenarioCsv}\``,
    `- \`${factorCsv}\``,
    `- \`${managementCsv}\``,
    `- \`${reportJson}\``,
    `- \`${reportMd}\``,
  ].join('\n');
  writeFileSync(reportMd, `${md}\n`);
  writeFileSync(DOC_PATH, `${md}\n`);

  const manifest = {
    generated_at_utc: new Date().toISOString(),
    files: [scenarioCsv, factorCsv, managementCsv, reportJson, reportMd, DOC_PATH].map((file) => ({
      path: file,
      lf_sha256: sha256Lf(file),
    })),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(JSON.stringify({
    status: 'ok',
    determination: report.determination,
    output_root: OUT_ROOT,
    doc_path: DOC_PATH,
    scenario_count: scenarios.length,
    management_diagnostic_count: diagnostics.length,
  }, null, 2));
}

main();
