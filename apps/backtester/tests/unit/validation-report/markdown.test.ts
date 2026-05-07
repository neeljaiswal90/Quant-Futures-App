import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ACTIVE_STRATEGY_IDS } from '../../../../strategy_runtime/src/contracts/strategy-ids.js';
import {
  renderValidationReportMarkdown,
  type ValidationGateResultSet,
} from '../../../src/index.js';

describe('validation report markdown', () => {
  it('renders byte-identical markdown for identical inputs', () => {
    const first = renderValidationReportMarkdown(makeResultSet());
    const second = renderValidationReportMarkdown(makeResultSet());

    expect(second).toBe(first);
  });

  it('uses result set order and supplied check order', () => {
    const markdown = renderValidationReportMarkdown(makeResultSet());

    expect(markdown.indexOf(ACTIVE_STRATEGY_IDS[1]!)).toBeLessThan(
      markdown.indexOf(ACTIVE_STRATEGY_IDS[0]!),
    );
    expect(markdown.indexOf('aggregate_profit_factor')).toBeLessThan(
      markdown.indexOf('aggregate_net_pnl'),
    );
  });

  it('renders fixed required sections with lineage and trial accounting', () => {
    const markdown = renderValidationReportMarkdown(makeResultSet());

    expect(markdown).toContain('## Summary');
    expect(markdown).toContain('## Strategy Results');
    expect(markdown).toContain('## Checks');
    expect(markdown).toContain('## Warnings');
    expect(markdown).toContain('## Reasons');
    expect(markdown).toContain('b'.repeat(64));
    expect(markdown).toContain('max_of_manual_and_distinct_fingerprints');
  });

  it('does not introduce nondeterministic runtime calls in validation-report source', () => {
    const sourceRoot = join(process.cwd(), 'apps/backtester/src/validation-report');
    const forbidden = /Date\.now|Math\.random|randomUUID|new Date\(/u;

    for (const fileName of readdirSync(sourceRoot)) {
      if (!fileName.endsWith('.ts')) continue;
      const source = readFileSync(join(sourceRoot, fileName), 'utf8');
      expect(source, fileName).not.toMatch(forbidden);
    }
  });
});

function makeResultSet(): ValidationGateResultSet {
  return {
    result_set_schema_version: 1,
    policy_version: 1,
    results: [
      {
        result_schema_version: 1,
        strategy_id: ACTIVE_STRATEGY_IDS[1]!,
        status: 'blocked',
        capability_status: 'blocked',
        fingerprint_sha256: 'b'.repeat(64),
        evaluated_test_windows: 8,
        zero_trade_windows: 1,
        aggregate_net_pnl_cents: 10n,
        aggregate_profit_factor_ppm: 1_200_000,
        average_trade_pnl_cents: 2n,
        worst_window_drawdown_ppm: 10_000,
        positive_window_share_ppm: 875_000,
        effective_trial_count: 12,
        trial_accounting_scope: 'campaign',
        trial_accounting_method: 'max_of_manual_and_distinct_fingerprints',
        checks: [
          {
            name: 'aggregate_profit_factor',
            status: 'pass',
            observed: 1_200_000,
            threshold: 1_100_000,
            message: 'profit factor passes',
          },
          {
            name: 'aggregate_net_pnl',
            status: 'pass',
            observed: 10n,
            threshold: 1n,
            message: 'net pnl passes',
          },
        ],
        warnings: [
          {
            code: 'advanced_statistics_disabled',
            message: 'advanced statistics disabled',
          },
        ],
        reasons: ['capability_status_blocked'],
      },
      {
        result_schema_version: 1,
        strategy_id: ACTIVE_STRATEGY_IDS[0]!,
        status: 'pass',
        capability_status: 'ready_for_replay',
        fingerprint_sha256: null,
        evaluated_test_windows: 8,
        zero_trade_windows: 0,
        aggregate_net_pnl_cents: null,
        aggregate_profit_factor_ppm: null,
        average_trade_pnl_cents: null,
        worst_window_drawdown_ppm: null,
        positive_window_share_ppm: null,
        effective_trial_count: null,
        trial_accounting_scope: null,
        trial_accounting_method: null,
        checks: [],
        warnings: [],
        reasons: [],
      },
    ],
  };
}
