import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertHeldOutAccessAllowed,
  buildDataSplitSpine,
  writeDataSplitSpine,
} from '../../../../../scripts/strategy-gen/data-split-spine.js';

describe('strategy-gen data split spine', () => {
  it('materializes train and validation partitions from corpus manifest splits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qfa-data-split-'));
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify({
      sessions: [
        { session_id: '2026-02-02-rth', split: 'calibration', status: 'complete' },
        { session_id: '2026-02-03-rth', split: 'validation', status: 'complete' },
        { session_id: '2026-02-04-rth', split: 'calibration', status: 'complete' },
      ],
    }), 'utf8');

    const spine = buildDataSplitSpine({
      generationRunId: 'unit-run',
      searchSpecPath: 'config/strategy-gen/unit.search.yaml',
      manifestPaths: [manifestPath],
      heldOutDir: 'artifacts/held-out-validation/unit-run',
    });

    expect(spine.train.session_count).toBe(2);
    expect(spine.validation.session_count).toBe(1);
    expect(spine.held_out.access_policy).toBe('sealed_until_qfa611_gate');
    expect(spine.paper.access_policy).toBe('human_gated_after_selection');
    expect(spine.leakage_guard.train_validation_loop_must_not_read_held_out).toBe(true);

    const out = join(dir, 'data-split-spine.json');
    writeDataSplitSpine(out, spine);
    expect(readFileSync(out, 'utf8')).toContain('"generation_run_id":"unit-run"');
  });

  it('fails closed when held-out access is attempted without explicit gate authority', () => {
    expect(() => assertHeldOutAccessAllowed({
      purpose: 'qfa611_gate',
      allowHeldOutGate: false,
    })).toThrow('--allow-held-out-gate');
  });

  it('allows explicit held-out gate purposes only when the caller opts in', () => {
    expect(() => assertHeldOutAccessAllowed({
      purpose: 'qfa410b_held_out_replay',
      allowHeldOutGate: true,
    })).not.toThrow();
  });
});
