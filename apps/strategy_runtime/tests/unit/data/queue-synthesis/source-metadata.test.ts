import { describe, expect, it } from 'vitest';
import { ns } from '../../../../src/contracts/time.js';
import {
  createQueueSynthesisSourceMetadata,
  withQueueSynthesisQualityFlags,
} from '../../../../src/data/queue-synthesis/source-metadata.js';
import {
  QUEUE_SYNTHESIS_QUALITY_FLAGS,
  type QueueStateSnapshot,
} from '../../../../src/data/queue-synthesis/types.js';

/**
 * Module under test: src/data/queue-synthesis/source-metadata.ts and types.ts
 * Ticket: QFA-105 Session 2a
 */

describe('QFA-105 queue synthesis metadata', () => {
  it('deduplicates quality flags without changing confidence or mode', () => {
    const metadata = createQueueSynthesisSourceMetadata({
      mode: 'mbp_proxy',
      corpus_tier: 'B',
      input_schemas: ['mbp-1'],
      confidence: 'medium',
      quality_flags: ['visible_size_proxy', 'visible_size_proxy'],
    });

    expect(metadata.quality_flags).toEqual(['visible_size_proxy']);
    expect(metadata.confidence).toBe('medium');
    expect(metadata.mode).toBe('mbp_proxy');
  });

  it('adds quality flags deterministically', () => {
    const metadata = withQueueSynthesisQualityFlags(
      createQueueSynthesisSourceMetadata({
        mode: 'tbbo_trade_proxy',
        corpus_tier: 'B',
        input_schemas: ['tbbo', 'trades'],
        confidence: 'low',
        quality_flags: ['trade_depletion_only'],
      }),
      ['trade_depletion_only', 'trade_side_unknown'],
    );
    expect(metadata.quality_flags).toEqual(['trade_depletion_only', 'trade_side_unknown']);
  });

  it('allows unknown queue ahead as null instead of coercing to zero', () => {
    const snapshot: QueueStateSnapshot = {
      type: 'queue_state_snapshot',
      ts_ns: ns(1_000n),
      instrument_id: 1,
      raw_symbol: null,
      side: 'bid',
      price: 20_000_000_000n,
      estimated_queue_ahead: null,
      estimated_visible_size: 10n,
      estimated_trade_depletion: 0n,
      estimated_visible_reduction: 0n,
      source_metadata: createQueueSynthesisSourceMetadata({
        mode: 'mbp_proxy',
        corpus_tier: 'B',
        input_schemas: ['mbp-1'],
        confidence: 'unverified',
        quality_flags: ['queue_ahead_unknown'],
      }),
    };

    expect(snapshot.estimated_queue_ahead).toBeNull();
    expect(snapshot.source_metadata.quality_flags).toContain('queue_ahead_unknown');
  });

  it('does not define ohlcv_rejected as an output quality flag', () => {
    expect([...QUEUE_SYNTHESIS_QUALITY_FLAGS]).not.toContain('ohlcv_rejected');
  });
});
