import { describe, expect, it } from 'vitest';
import {
  assertQueueSynthesisOptions,
  resolveQueueSynthesisMode,
} from '../../../../src/data/queue-synthesis/capability-gates.js';
import { QueueSynthesisInputError } from '../../../../src/data/queue-synthesis/queue-synthesis-input-error.js';
import type { QueueSynthesisOptions } from '../../../../src/data/queue-synthesis/types.js';

/**
 * Module under test: src/data/queue-synthesis/capability-gates.ts
 * Ticket: QFA-105 Session 2a
 */

describe('QFA-105 resolveQueueSynthesisMode', () => {
  it('auto selects mbo_reconstruction when mbo is present', () => {
    expect(resolveQueueSynthesisMode(['trades', 'mbo'], 'auto')).toBe('mbo_reconstruction');
  });

  it('auto selects mbp_proxy when mbp is present and mbo is absent', () => {
    expect(resolveQueueSynthesisMode(['mbp-10', 'trades'], 'auto')).toBe('mbp_proxy');
    expect(resolveQueueSynthesisMode(['mbp-1'], 'auto')).toBe('mbp_proxy');
  });

  it('auto selects tbbo_trade_proxy when tbbo and trades are present', () => {
    expect(resolveQueueSynthesisMode(['tbbo', 'trades'], 'auto')).toBe('tbbo_trade_proxy');
  });

  it('rejects ohlcv-only inputs', () => {
    expect(() => resolveQueueSynthesisMode(['ohlcv-1m'], 'auto')).toThrow(
      /ohlcv_queue_synthesis_forbidden/,
    );
  });

  it('rejects bbo-only inputs', () => {
    expect(() => resolveQueueSynthesisMode(['bbo'], 'auto')).toThrow(
      /bbo_only_queue_synthesis_forbidden/,
    );
  });

  it('rejects definition, status, and statistics-only inputs', () => {
    expect(() => resolveQueueSynthesisMode(['definition', 'status', 'statistics'], 'auto')).toThrow(
      /insufficient_queue_evidence/,
    );
  });

  it('rejects explicit modes unsupported by the input schemas', () => {
    expect(() => resolveQueueSynthesisMode(['trades', 'tbbo'], 'mbp_proxy')).toThrow(
      /unsupported_input_schema/,
    );
  });

  it('validates complete queue synthesis options and returns the resolved mode', () => {
    expect(assertQueueSynthesisOptions(makeOptions())).toBe('mbo_reconstruction');
  });

  it('aggregates invalid option issues', () => {
    expect(() =>
      assertQueueSynthesisOptions(
        makeOptions({
          input_schemas: [],
          passive_order_quantity: 0n,
          fill_horizon_ns: 0n,
          depletion_lookback_ns: -1n,
        }),
      ),
    ).toThrow(QueueSynthesisInputError);
  });
});

function makeOptions(overrides: Partial<QueueSynthesisOptions> = {}): QueueSynthesisOptions {
  return {
    instrument_root: 'MNQ',
    manifest_symbol: 'MNQH6',
    input_schemas: ['mbo'],
    corpus_tier: 'A',
    mode: 'auto',
    passive_order_quantity: 1n,
    fill_horizon_ns: 1_000n,
    depletion_lookback_ns: 1_000n,
    allow_unverified_identity: true,
    ...overrides,
  };
}
