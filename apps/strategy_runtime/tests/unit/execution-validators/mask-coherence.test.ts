import { describe, expect, it } from 'vitest';
import { buildExecutionCapabilityMask } from '../../../src/execution/execution-capability-mask.js';
import { MaskCoherenceValidator } from '../../../src/execution/validators/mask-coherence.js';

describe('EXEC-VALIDATOR-01 mask coherence', () => {
  it('accepts the current QFA-622 execution capability mask', () => {
    const validator = new MaskCoherenceValidator();

    expect(
      validator.runOnSessionStart({
        session_id: 'session-1',
        session_family_id: 'family-1',
        execution_mask: buildExecutionCapabilityMask(),
      }),
    ).toEqual([]);
  });

  it('flags a recomputed hash mismatch', () => {
    const validator = new MaskCoherenceValidator();
    const mask = { ...buildExecutionCapabilityMask(), mask_hash: 'sha256:bad' };

    const issues = validator.runOnSessionStart({
      session_id: 'session-1',
      execution_mask: mask,
    });

    expect(issues.map((issue) => issue.code)).toContain('execution_mask_hash_mismatch');
  });

  it('flags mask version regression within a session family', () => {
    const validator = new MaskCoherenceValidator();
    expect(
      validator.runOnSessionStart({
        session_id: 'session-1',
        session_family_id: 'family-1',
        execution_mask: buildExecutionCapabilityMask(),
      }),
    ).toEqual([]);

    const issues = validator.runOnSessionStart({
      session_id: 'session-2',
      session_family_id: 'family-1',
      execution_mask: { ...buildExecutionCapabilityMask(), mask_version: 0 },
    });

    expect(issues.map((issue) => issue.code)).toContain('execution_mask_version_regression');
  });
});
