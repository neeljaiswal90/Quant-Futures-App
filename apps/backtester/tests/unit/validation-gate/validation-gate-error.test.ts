import { describe, expect, it } from 'vitest';

import {
  ValidationGateInputError,
  throwValidationGateIssue,
  throwValidationGateIssues,
} from '../../../src/validation-gate/index.js';

describe('validation gate input errors', () => {
  it('carries structured aggregate issues', () => {
    const issues = [
      {
        path: '$.strategy_id',
        code: 'unknown_strategy_id' as const,
        message: 'unknown strategy',
      },
      {
        path: '$.windows[0]',
        code: 'invalid_window_input' as const,
        message: 'bad window',
      },
    ];

    expect(() => throwValidationGateIssues(issues)).toThrow(ValidationGateInputError);

    try {
      throwValidationGateIssues(issues);
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationGateInputError);
      expect((error as ValidationGateInputError).issues).toEqual(issues);
      expect((error as Error).message).toMatch(/2 issues/u);
    }
  });

  it('supports single-issue throws', () => {
    expect(() =>
      throwValidationGateIssue({
        path: '$.policy',
        code: 'invalid_policy',
        message: 'bad policy',
      }),
    ).toThrow(/invalid_policy/u);
  });
});
