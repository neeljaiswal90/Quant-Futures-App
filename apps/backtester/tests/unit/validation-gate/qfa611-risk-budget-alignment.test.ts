import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RISK_POLICY,
  loadRiskPolicyConfig,
} from '../../../../strategy_runtime/src/risk/index.js';
import { ADR0016_RISK_BUDGETS } from '../../../src/validation-gate/index.js';

describe('QFA-611 ADR-0016 risk-budget alignment', () => {
  it('keeps runtime defaults aligned to ADR-0016 LD-611-6 risk budgets', () => {
    expect(DEFAULT_RISK_POLICY.max_risk_per_trade_pct).toBe(
      ADR0016_RISK_BUDGETS.max_risk_per_trade_pct,
    );
    expect(DEFAULT_RISK_POLICY.max_daily_loss_pct).toBe(
      ADR0016_RISK_BUDGETS.max_daily_loss_pct,
    );
  });

  it('keeps committed risk YAML aligned to ADR-0016 LD-611-6 risk budgets', () => {
    const loaded = loadRiskPolicyConfig({
      cwd: process.cwd(),
      path: 'config/risk/risk-policy.yaml',
      required: true,
    });

    expect(loaded.policy.max_risk_per_trade_pct).toBe(
      ADR0016_RISK_BUDGETS.max_risk_per_trade_pct,
    );
    expect(loaded.policy.max_daily_loss_pct).toBe(
      ADR0016_RISK_BUDGETS.max_daily_loss_pct,
    );
    expect(loaded.policy.session.max_daily_realized_loss_usd).toBe(
      loaded.policy.account_equity_usd * (ADR0016_RISK_BUDGETS.max_daily_loss_pct / 100),
    );
  });
});