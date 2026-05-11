import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../../..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'apps/backtester/tests/fixtures/qfa611-dress-rehearsal');

const REQUIRED_FIXTURES = [
  'dress_rehearsal_advance-feb-mar-apr-2026.json',
  'dress_rehearsal_reject-feb-mar-apr-2026.json',
  'dress_rehearsal_research-feb-mar-apr-2026.json',
  'dress_rehearsal_incomplete-feb-mar-apr-2026.json',
  'lock-manifest.json',
  'expected/run-3strat.json',
  'expected/run-4strat.json',
];

describe('QFA-611 dress rehearsal fixtures', () => {
  it('keeps G1 expected outputs committed for the driver gate', () => {
    for (const fixture of REQUIRED_FIXTURES) {
      expect(existsSync(path.join(FIXTURE_DIR, fixture)), fixture).toBe(true);
    }
  });
});
