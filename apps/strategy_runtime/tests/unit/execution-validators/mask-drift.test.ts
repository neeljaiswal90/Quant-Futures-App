import { describe, expect, it, vi } from 'vitest';
import { buildExecutionCapabilityMask } from '../../../src/execution/execution-capability-mask.js';
import { MaskDriftValidator } from '../../../src/execution/validators/mask-drift.js';

describe('EXEC-VALIDATOR-07 mask drift', () => {
  it('accepts matching live and artifact execution masks', () => {
    const validator = new MaskDriftValidator({
      artifactMaskLoader: () => buildExecutionCapabilityMask(),
    });

    expect(
      validator.runOnPeriodicCadence({
        execution_mask: buildExecutionCapabilityMask(),
      }),
    ).toEqual([]);
  });

  it('emits an alert issue and blocks an injected submission gate on drift', () => {
    const setBlocked = vi.fn();
    const validator = new MaskDriftValidator({
      artifactMaskLoader: () => buildExecutionCapabilityMask(),
      submissionGate: { setBlocked },
    });

    const issues = validator.runOnPeriodicCadence({
      execution_mask: { ...buildExecutionCapabilityMask(), mask_hash: 'sha256:drift' },
    });

    expect(issues).toContainEqual(expect.objectContaining({ code: 'execution_mask_drift' }));
    expect(setBlocked).toHaveBeenCalledWith(true, 'EXEC-VALIDATOR-07:execution_mask_drift');
  });

  it('reports artifact loader failures as validator issues', () => {
    const validator = new MaskDriftValidator({
      artifactMaskLoader: () => {
        throw new Error('artifact missing');
      },
    });

    expect(validator.runOnPeriodicCadence({ execution_mask: buildExecutionCapabilityMask() })).toContainEqual(
      expect.objectContaining({ code: 'execution_mask_artifact_unavailable' }),
    );
  });
});
