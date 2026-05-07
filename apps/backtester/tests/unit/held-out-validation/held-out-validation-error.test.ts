import { describe, expect, it } from 'vitest';
import {
  HeldOutValidationInputError,
  formatHeldOutValidationIssues,
} from '../../../src/held-out-validation/index.js';

describe('QFA-410 held-out validation errors', () => {
  it('formats aggregate issues deterministically', () => {
    const issues = [
      {
        path: '$.run_id',
        code: 'missing_run_id' as const,
        message: 'run_id must be a non-empty string',
      },
      {
        path: '$.strategy_order[1]',
        code: 'duplicate_strategy_id' as const,
        message: 'duplicate strategy_id: trend_pullback_long',
      },
    ];

    expect(formatHeldOutValidationIssues(issues)).toBe(
      '$.run_id: missing_run_id: run_id must be a non-empty string\n' +
        '$.strategy_order[1]: duplicate_strategy_id: duplicate strategy_id: trend_pullback_long',
    );
    expect(new HeldOutValidationInputError(issues).issues).toEqual(issues);
  });
});
