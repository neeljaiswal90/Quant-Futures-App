import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ADR0016_RISK_BUDGETS,
  ADR0016_STAGE1_THRESHOLDS,
  ADR0016_STAGE2_THRESHOLDS,
  QFA611_STAT_CORE_VERSION,
} from '../../../src/validation-gate/index.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../../..');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

describe('QFA-611 ADR-0016 threshold mirror', () => {
  it('matches the Python threshold source of truth exactly', () => {
    const script = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'scripts/strategy-selection/_lib'))})`,
      'from thresholds import ADR0016_STAGE1_THRESHOLDS, ADR0016_STAGE2_THRESHOLDS, ADR0016_RISK_BUDGETS',
      'print(json.dumps({"stage1": ADR0016_STAGE1_THRESHOLDS, "stage2": ADR0016_STAGE2_THRESHOLDS, "risk": ADR0016_RISK_BUDGETS}, sort_keys=True, separators=(",", ":")))',
    ].join('; ');
    const output = execFileSync(PYTHON, ['-c', script], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const parsed = JSON.parse(output) as unknown;
    expect(parsed).toEqual({
      stage1: ADR0016_STAGE1_THRESHOLDS,
      stage2: ADR0016_STAGE2_THRESHOLDS,
      risk: ADR0016_RISK_BUDGETS,
    });
  });

  it('runs the Python stat-core unittest suite in CI', () => {
    const output = execFileSync(
      PYTHON,
      ['-m', 'unittest', 'discover', 'scripts/strategy-selection/_lib/tests'],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15_000 },
    );
    expect(output).toContain('');
  }, 15_000);

  it('keeps load-bearing field names separate', () => {
    expect(QFA611_STAT_CORE_VERSION).toBe('qfa611_stats_v1');
    expect(ADR0016_STAGE1_THRESHOLDS).toMatchObject({
      annualized_return_min_decimal: 0.12,
      annualized_sharpe_min: 1,
      dsr_statistic_min: 0,
      psr_zero_null_min: 0.8,
      max_drawdown_max_decimal: 0.08,
      profit_factor_min: 1.35,
      total_trades_min: 300,
    });
    expect(ADR0016_RISK_BUDGETS).toMatchObject({
      max_risk_per_trade_pct: 0.25,
      max_daily_loss_pct: 1,
    });
  });
});
