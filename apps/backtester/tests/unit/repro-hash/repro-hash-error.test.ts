import { describe, expect, it } from 'vitest';
import {
  formatReproHashIssues,
  ReproHashInputError,
  type ReproHashIssue,
} from '../../../src/repro-hash/index.js';

describe('QFA-205 ReproHashInputError', () => {
  it('preserves aggregate structured issues', () => {
    const issues: ReproHashIssue[] = [
      {
        path: '$.run_id',
        code: 'invalid_run_id',
        message: 'run_id must be present',
      },
      {
        path: '$.run_spec_hash',
        code: 'invalid_run_spec_hash',
        message: 'run_spec_hash must be sha256',
      },
    ];

    const error = new ReproHashInputError(issues);

    expect(error.name).toBe('ReproHashInputError');
    expect(error.issues).toEqual(issues);
    expect(error.message).toBe(formatReproHashIssues(issues));
    expect(error.message).toContain('invalid_run_id');
    expect(error.message).toContain('invalid_run_spec_hash');
  });
});
