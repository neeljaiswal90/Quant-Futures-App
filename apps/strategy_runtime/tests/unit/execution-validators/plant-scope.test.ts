import { describe, expect, it } from 'vitest';
import { PlantScopeValidator } from '../../../src/execution/validators/plant-scope.js';
import { completeManifest, event } from './helpers.js';

describe('EXEC-VALIDATOR-05 plant scope', () => {
  it('allows ORDER_PLANT under the QFA-622 execution mask', () => {
    const validator = new PlantScopeValidator();

    expect(
      validator.runOnSessionStart({
        session_manifest: completeManifest({ plant_scope: ['ORDER_PLANT'] }),
      }),
    ).toEqual([]);
  });

  it('rejects PNL_PLANT before live_reconciliation phase', () => {
    const validator = new PlantScopeValidator();
    const issues = validator.runOnSessionStart({
      session_manifest: completeManifest({
        plant_scope: ['PNL_PLANT'],
        execution_phase: 'paper_ordering',
      }),
    });

    expect(issues).toContainEqual(expect.objectContaining({ code: 'pnl_plant_before_live_reconciliation' }));
  });

  it('allows PNL_PLANT at live_reconciliation phase or later', () => {
    const validator = new PlantScopeValidator();

    expect(
      validator.runOnSessionStart({
        session_manifest: completeManifest({
          plant_scope: ['PNL_PLANT'],
          execution_phase: 'live_reconciliation',
        }),
      }),
    ).toEqual([]);
  });

  it('rejects HISTORY_PLANT on events and manifests', () => {
    const validator = new PlantScopeValidator();

    expect(
      validator.runOnEvent(
        event('CONFIG', {
          config_hash: 'a'.repeat(64),
          config_version: 1,
          plant_scope: 'HISTORY_PLANT',
        }),
      ),
    ).toContainEqual(expect.objectContaining({ code: 'history_plant_rejected' }));
  });
});
