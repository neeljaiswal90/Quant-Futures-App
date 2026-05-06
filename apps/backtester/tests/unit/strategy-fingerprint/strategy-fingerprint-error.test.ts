import { describe, expect, it } from 'vitest';

import {
  StrategyFingerprintInputError,
  throwStrategyFingerprintIssue,
  throwStrategyFingerprintIssues,
} from '../../../src/strategy-fingerprint/index.js';

describe('strategy fingerprint input errors', () => {
  it('carries structured aggregate issues', () => {
    const issues = [
      {
        path: '$.strategy_id',
        code: 'unknown_strategy_id' as const,
        message: 'unknown strategy',
      },
      {
        path: '$.bar_id',
        code: 'missing_bar_id' as const,
        message: 'missing bar',
      },
    ];

    expect(() => throwStrategyFingerprintIssues(issues)).toThrow(
      StrategyFingerprintInputError,
    );

    try {
      throwStrategyFingerprintIssues(issues);
    } catch (error) {
      expect(error).toBeInstanceOf(StrategyFingerprintInputError);
      expect((error as StrategyFingerprintInputError).issues).toEqual(issues);
      expect((error as Error).message).toMatch(/2 issues/u);
    }
  });

  it('supports single-issue throws', () => {
    expect(() =>
      throwStrategyFingerprintIssue({
        path: '$.score',
        code: 'non_finite_score',
        message: 'bad score',
      }),
    ).toThrow(/non_finite_score/u);
  });
});
