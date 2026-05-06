import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getCachedRecords } from '../../../../src/data/parquet-cache.js';
import { synthesizeCachedQueue } from '../../../../src/data/queue-synthesis/cache-integration.js';
import type {
  QueueSynthesisOutput,
} from '../../../../src/data/queue-synthesis/types.js';

/**
 * Module under test: src/data/queue-synthesis/cache-integration.ts
 * Ticket: QFA-105 Session 2b
 */

describe('QFA-105 synthesizeCachedQueue integration', () => {
  let cacheRoot: string | null = null;

  afterEach(() => {
    if (cacheRoot !== null) {
      rmSync(cacheRoot, { recursive: true, force: true });
      cacheRoot = null;
    }
  });

  it('uses QFA-103 CachedRecordSource metadata with readCachedRecords to emit queue snapshots', async () => {
    cacheRoot = mkdtempSync(join(tmpdir(), 'qfa-105-cache-'));
    const fixtureRoot = join(process.cwd(), 'apps/strategy_runtime/tests/fixtures/dbn');
    const tbboSource = await getCachedRecords(join(fixtureRoot, 'tbbo-minimal.dbn'), 'tbbo', {
      cacheRoot,
      forceRebuild: true,
    });
    const tradesSource = await getCachedRecords(join(fixtureRoot, 'trades-minimal.dbn'), 'trades', {
      cacheRoot,
      forceRebuild: true,
    });

    const outputs = await collect(
      synthesizeCachedQueue([tbboSource, tradesSource], {
        instrument_root: 'MNQ',
        manifest_symbol: 'MNQH6',
        input_schemas: ['tbbo', 'trades'],
        corpus_tier: 'A',
        mode: 'tbbo_trade_proxy',
        passive_order_quantity: 1n,
        fill_horizon_ns: 1_000n,
        depletion_lookback_ns: 1_000n,
        allow_unverified_identity: true,
      }),
    );

    expect(outputs.some((output) => output.type === 'queue_state_snapshot')).toBe(true);
  });
});

async function collect(iterable: AsyncIterable<QueueSynthesisOutput>): Promise<QueueSynthesisOutput[]> {
  const outputs: QueueSynthesisOutput[] = [];
  for await (const output of iterable) {
    outputs.push(output);
  }
  return outputs;
}
