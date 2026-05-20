import { describe, expect, it } from 'vitest';
import { SessionManifestValidator } from '../../../src/execution/validators/session-manifest.js';
import { completeManifest } from './helpers.js';

describe('EXEC-VALIDATOR-06 session manifest completeness', () => {
  it('accepts a complete execution session manifest', () => {
    const validator = new SessionManifestValidator();

    expect(
      validator.runOnSessionStart({
        session_id: 'session-1',
        session_manifest: completeManifest(),
      }),
    ).toEqual([]);
  });

  it('flags a missing manifest', () => {
    const validator = new SessionManifestValidator();

    expect(validator.runOnSessionStart({ session_id: 'session-1' })).toContainEqual(
      expect.objectContaining({ code: 'session_manifest_missing' }),
    );
  });

  it('flags all missing required manifest fields', () => {
    const validator = new SessionManifestValidator();
    const issues = validator.runOnSessionStart({
      session_id: 'session-1',
      session_manifest: {},
    });

    expect(issues).toHaveLength(7);
    expect(issues.map((issue) => issue.details?.field)).toEqual([
      'mask_id',
      'mask_version',
      'mask_hash',
      'reconnect_policy_config',
      'plant_scope',
      'mode',
      'timestamp_anchor',
    ]);
  });
});
