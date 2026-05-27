import { describe, expect, it } from 'vitest';

import type { StrategyId } from '../../../../strategy_runtime/src/contracts/strategy-ids.js';
import {
  DEFAULT_VALIDATION_GATE_POLICY_V1,
  computeEffectiveTrialCount,
  validateTrialAccounting,
  type ValidationTrialAccounting,
} from '../../../src/validation-gate/index.js';

const EXPLICIT_REPLAY_STRATEGY_ID = 'vwap_overnight_reversal_long' as const satisfies StrategyId;

describe('validation trial accounting', () => {
  it('computes effective trial count from max manual/fingerprint method', () => {
    expect(computeEffectiveTrialCount(makeTrialAccounting({ manual: 7, distinct: 11 }))).toBe(11);
    expect(computeEffectiveTrialCount(makeTrialAccounting({ manual: 13, distinct: 11 }))).toBe(13);
  });

  it('reports invalid trial accounting deterministically', () => {
    const issues = validateTrialAccounting(
      EXPLICIT_REPLAY_STRATEGY_ID,
      {
        ...makeTrialAccounting({ manual: 7, distinct: 11 }),
        effective_trial_count: 7,
      },
      DEFAULT_VALIDATION_GATE_POLICY_V1,
      '$.trial_accounting',
    );

    expect(issues.map((issue) => issue.code)).toEqual(['invalid_trial_accounting']);
    expect(issues[0]?.path).toBe('$.trial_accounting.effective_trial_count');
  });
});

function makeTrialAccounting(input: {
  readonly manual: number;
  readonly distinct: number;
}): ValidationTrialAccounting {
  return {
    trial_accounting_schema_version: 1,
    strategy_id: EXPLICIT_REPLAY_STRATEGY_ID,
    campaign_id: 'campaign-qfa310',
    raw_research_trials: 20,
    excluded_determinism_reruns: 0,
    manual_declared_effective_trials: input.manual,
    distinct_window_fingerprint_tuples: input.distinct,
    effective_trial_count: Math.max(input.manual, input.distinct),
    effective_trial_scope: 'campaign',
    effective_trial_method: 'max_of_manual_and_distinct_fingerprints',
  };
}
