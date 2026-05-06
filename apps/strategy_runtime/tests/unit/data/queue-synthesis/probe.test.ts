import { describe, expect, it } from 'vitest';
import { ns } from '../../../../src/contracts/time.js';
import {
  assertFillProbabilityPpm,
  createQueueStateUnavailableEstimate,
  deriveEffectiveProbeTs,
  validatePassiveOrderProbe,
} from '../../../../src/data/queue-synthesis/probe.js';
import type {
  PassiveOrderProbe,
  QueueSynthesisSourceMetadata,
} from '../../../../src/data/queue-synthesis/types.js';

/**
 * Module under test: src/data/queue-synthesis/probe.ts
 * Ticket: QFA-105 Session 2a
 */

describe('QFA-105 passive probe validation', () => {
  it('accepts a valid passive order probe', () => {
    expect(() => validatePassiveOrderProbe(makeProbe())).not.toThrow();
  });

  it('rejects zero quantity', () => {
    expect(() => validatePassiveOrderProbe(makeProbe({ order_quantity: 0n }))).toThrow(
      /invalid_passive_probe/,
    );
  });

  it('rejects negative latency', () => {
    expect(() => validatePassiveOrderProbe(makeProbe({ latency_ns: -1n }))).toThrow(
      /invalid_passive_probe/,
    );
  });

  it('rejects zero or negative limit price', () => {
    expect(() => validatePassiveOrderProbe(makeProbe({ limit_price: 0n }))).toThrow(
      /invalid_passive_probe/,
    );
    expect(() => validatePassiveOrderProbe(makeProbe({ limit_price: -1n }))).toThrow(
      /invalid_passive_probe/,
    );
  });

  it('rejects invalid instrument ids', () => {
    expect(() => validatePassiveOrderProbe(makeProbe({ instrument_id: 0 }))).toThrow(
      /invalid_passive_probe/,
    );
    expect(() => validatePassiveOrderProbe(makeProbe({ instrument_id: 1.5 }))).toThrow(
      /invalid_passive_probe/,
    );
  });

  it('accepts the ppm probability bounds', () => {
    expect(() => assertFillProbabilityPpm(0)).not.toThrow();
    expect(() => assertFillProbabilityPpm(500_000)).not.toThrow();
    expect(() => assertFillProbabilityPpm(1_000_000)).not.toThrow();
  });

  it('rejects invalid ppm probability values', () => {
    for (const value of [-1, 1_000_001, 0.5, Number.NaN]) {
      expect(() => assertFillProbabilityPpm(value)).toThrow(/invalid_probability_ppm/);
    }
  });

  it('derives the effective timestamp deterministically', () => {
    expect(deriveEffectiveProbeTs(makeProbe({ ts_ns: ns(100n), latency_ns: 25n }))).toBe(ns(125n));
  });

  it('creates a warmup placeholder estimate when queue state is unavailable', () => {
    const estimate = createQueueStateUnavailableEstimate(makeProbe(), makeMetadata());
    expect(estimate.estimated_fill_probability_ppm).toBe(0);
    expect(estimate.estimated_fill_quantity).toBe(0n);
    expect(estimate.source_metadata.confidence).toBe('unverified');
    expect(estimate.source_metadata.quality_flags).toContain('queue_state_unavailable');
  });
});

function makeProbe(overrides: Partial<PassiveOrderProbe> = {}): PassiveOrderProbe {
  return {
    ts_ns: ns(1_000n),
    instrument_id: 123,
    raw_symbol: 'MNQH6',
    side: 'buy',
    limit_price: 20_000_000_000n,
    order_quantity: 2n,
    latency_ns: 10n,
    ...overrides,
  };
}

function makeMetadata(): QueueSynthesisSourceMetadata {
  return {
    mode: 'mbo_reconstruction',
    corpus_tier: 'A',
    input_schemas: ['mbo'],
    confidence: 'high',
    quality_flags: [],
  };
}
