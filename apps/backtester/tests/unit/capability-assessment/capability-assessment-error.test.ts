import { describe, expect, it } from 'vitest';

import {
  CapabilityAssessmentInputError,
  throwCapabilityAssessmentIssue,
  throwCapabilityAssessmentIssues,
} from '../../../src/capability-assessment/index.js';

describe('capability assessment input errors', () => {
  it('carries structured aggregate issues', () => {
    const issues = [
      {
        path: '$.strategy_order[0]',
        code: 'unknown_strategy_id' as const,
        message: 'unknown strategy',
      },
      {
        path: '$.strategy_order[1]',
        code: 'duplicate_strategy_id' as const,
        message: 'duplicate strategy',
      },
    ];

    expect(() => throwCapabilityAssessmentIssues(issues)).toThrow(
      CapabilityAssessmentInputError,
    );

    try {
      throwCapabilityAssessmentIssues(issues);
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityAssessmentInputError);
      expect((error as CapabilityAssessmentInputError).issues).toEqual(issues);
      expect((error as Error).message).toMatch(/2 issues/u);
    }
  });

  it('supports single-issue throws', () => {
    expect(() =>
      throwCapabilityAssessmentIssue({
        path: '$.fingerprints',
        code: 'missing_fingerprint_set',
        message: 'missing fingerprints',
      }),
    ).toThrow(/missing_fingerprint_set/u);
  });
});
