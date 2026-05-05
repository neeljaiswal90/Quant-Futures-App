import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCachedBars } from '../../../../src/data/bar-builder/bar-builder.js';
import { DEFAULT_MNQ_ROLL_POLICY } from '../../../../src/data/bar-builder/roll-policy.js';
import { getCachedRecords } from '../../../../src/data/parquet-cache.js';

describe('QFA-104 Session 2b cache integration', () => {
  it('reads cached records through the merged QFA-103 API and emits bars', async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'qfa-104-cache-'));
    try {
      const source = await getCachedRecords(
        'apps/strategy_runtime/tests/fixtures/dbn/trades-minimal.dbn',
        'trades',
        { cacheRoot, forceRebuild: true },
      );

      const outputs = [];
      for await (const output of buildCachedBars(source, {
        bar_spec: '1m',
        manifest_symbol: 'MNQ',
        roll_policy: DEFAULT_MNQ_ROLL_POLICY,
        input_schemas: ['trades'],
        corpus_tier: 'B',
      })) {
        outputs.push(output);
      }

      expect(source.schema).toBe('trades');
      expect(source.recordCount).toBeGreaterThan(0);
      expect(outputs.length).toBeGreaterThan(0);
      expect(outputs.every((output) => output.type === 'bar' || output.type === 'contract_roll_boundary')).toBe(true);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});
