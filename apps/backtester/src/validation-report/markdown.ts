import { createValidationReport } from './validation-report.js';
import type { ValidationGateResultSet } from '../validation-gate/index.js';
import type {
  ValidationReport,
  ValidationReportStrategyResult,
} from './types.js';

export function renderValidationReportMarkdown(
  resultSet: ValidationGateResultSet,
): string {
  return renderValidationReport(createValidationReport(resultSet));
}

export function renderValidationReport(report: ValidationReport): string {
  const lines: string[] = [
    '# Validation Report',
    '',
    '## Summary',
    '',
    '| Field | Value |',
    '| --- | ---: |',
    `| Report schema version | ${report.report_schema_version} |`,
    `| Source result set schema version | ${report.source_result_set_schema_version} |`,
    `| Policy version | ${report.policy_version} |`,
    `| Total strategies | ${report.summary.total_strategies} |`,
    `| Pass | ${report.summary.pass} |`,
    `| Fail | ${report.summary.fail} |`,
    `| Blocked | ${report.summary.blocked} |`,
    `| Insufficient evidence | ${report.summary.insufficient_evidence} |`,
    `| Warning count | ${report.summary.warning_count} |`,
    `| Reason count | ${report.summary.reason_count} |`,
    '',
    '## Strategy Results',
    '',
    '| Strategy | Status | Capability | Fingerprint SHA-256 | Trial count | Trial scope | Trial method | Test windows | Zero-trade windows | Net PnL cents | Profit factor ppm | Avg trade PnL cents | Worst drawdown ppm | Positive window share ppm |',
    '| --- | --- | --- | --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const result of report.strategy_results) {
    lines.push(renderStrategyResultRow(result));
  }

  lines.push('', '## Checks', '');

  for (const result of report.strategy_results) {
    lines.push(`### ${escapeMarkdownText(result.strategy_id)}`, '');
    lines.push('| Check | Status | Observed | Threshold | Message |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const check of result.checks) {
      lines.push(
        `| ${escapeMarkdownText(check.name)} | ${escapeMarkdownText(check.status)} | ${formatValue(check.observed)} | ${formatValue(check.threshold)} | ${escapeTableCell(check.message)} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Warnings', '');
  for (const result of report.strategy_results) {
    lines.push(`### ${escapeMarkdownText(result.strategy_id)}`, '');
    if (result.warnings.length === 0) {
      lines.push('- None', '');
      continue;
    }
    for (const warning of result.warnings) {
      lines.push(`- ${escapeMarkdownText(warning.code)}: ${escapeMarkdownText(warning.message)}`);
    }
    lines.push('');
  }

  lines.push('## Reasons', '');
  for (const result of report.strategy_results) {
    lines.push(`### ${escapeMarkdownText(result.strategy_id)}`, '');
    if (result.reasons.length === 0) {
      lines.push('- None', '');
      continue;
    }
    for (const reason of result.reasons) {
      lines.push(`- ${escapeMarkdownText(reason)}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function renderStrategyResultRow(result: ValidationReportStrategyResult): string {
  return [
    escapeTableCell(result.strategy_id),
    escapeTableCell(result.status),
    escapeTableCell(result.capability_status),
    escapeTableCell(result.fingerprint_lineage.fingerprint_sha256),
    formatValue(result.trial_accounting.effective_trial_count),
    escapeTableCell(result.trial_accounting.scope),
    escapeTableCell(result.trial_accounting.method),
    formatValue(result.metrics.evaluated_test_windows),
    formatValue(result.metrics.zero_trade_windows),
    formatValue(result.metrics.aggregate_net_pnl_cents),
    formatValue(result.metrics.aggregate_profit_factor_ppm),
    formatValue(result.metrics.average_trade_pnl_cents),
    formatValue(result.metrics.worst_window_drawdown_ppm),
    formatValue(result.metrics.positive_window_share_ppm),
  ].join(' | ').replace(/^/u, '| ').replace(/$/u, ' |');
}

function formatValue(value: string | number | bigint | null): string {
  if (value === null) return 'n/a';
  return escapeTableCell(value);
}

function escapeTableCell(value: string | number | bigint | null): string {
  if (value === null) return 'n/a';
  return escapeMarkdownText(String(value)).replace(/\|/gu, '\\|');
}

function escapeMarkdownText(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/\r?\n/gu, ' ');
}
