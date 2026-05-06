import { describe, expect, it } from 'vitest';

import {
  WalkForwardInputError,
  type WalkForwardIssue,
} from '../../../src/walk-forward/index.js';

describe('WalkForwardInputError', () => {
  it('retains structured issues and formats a compact message', () => {
    const issues: readonly WalkForwardIssue[] = [
      {
        path: 'policy.train_sessions',
        code: 'invalid_policy',
        message: 'value must be a positive safe integer',
      },
    ];

    const error = new WalkForwardInputError(issues);

    expect(error.name).toBe('WalkForwardInputError');
    expect(error.issues).toEqual(issues);
    expect(error.message).toContain('policy.train_sessions');
    expect(error.message).toContain('invalid_policy');
  });
});
