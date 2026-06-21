import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildDataSplitSpine } from '../../../../../scripts/strategy-gen/data-split-spine.js';
import {
  buildNestedValidationManifest,
  writeNestedValidationManifest,
} from '../../../../../scripts/strategy-gen/nested-validation.js';

function spineWithValidationSessions(count: number) {
  const dir = mkdtempSync(join(tmpdir(), 'qfa-nested-cv-'));
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({
    sessions: [
      { session_id: '2026-02-01-rth', split: 'calibration', status: 'complete' },
      ...Array.from({ length: count }, (_, index) => ({
        session_id: `2026-02-${String(index + 2).padStart(2, '0')}-rth`,
        split: 'validation',
        status: 'complete',
      })),
    ],
  }), 'utf8');
  return {
    dir,
    spine: buildDataSplitSpine({
      generationRunId: 'unit-run',
      searchSpecPath: 'config/strategy-gen/unit.search.yaml',
      manifestPaths: [manifestPath],
      heldOutDir: 'artifacts/held-out-validation/unit-run',
    }),
  };
}

describe('strategy-gen nested validation manifest', () => {
  it('creates deterministic round-robin validation folds', () => {
    const { dir, spine } = spineWithValidationSessions(5);
    const manifest = buildNestedValidationManifest({ spine, foldCount: 3 });

    expect(manifest.fold_count).toBe(3);
    expect(manifest.validation_session_count).toBe(5);
    expect(manifest.folds.map((fold) => fold.session_count)).toEqual([2, 2, 1]);

    writeNestedValidationManifest(join(dir, 'nested-validation.json'), manifest);
  });

  it('fails closed when there are fewer validation sessions than folds', () => {
    const { spine } = spineWithValidationSessions(1);
    expect(() => buildNestedValidationManifest({ spine, foldCount: 2 }))
      .toThrow('one validation session per fold');
  });
});
