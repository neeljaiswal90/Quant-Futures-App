import { describe, expect, it } from 'vitest';
import {
  QueueSynthesisInputError,
  type QueueSynthesisErrorCode,
} from '../../../../src/data/queue-synthesis/queue-synthesis-input-error.js';

/**
 * Module under test: src/data/queue-synthesis/queue-synthesis-input-error.ts
 * Ticket: QFA-105 Session 2a
 */

describe('QFA-105 QueueSynthesisInputError', () => {
  it('aggregates path, code, and message issues', () => {
    const error = new QueueSynthesisInputError([
      { path: '$.input_schemas', code: 'insufficient_queue_evidence', message: 'missing evidence' },
      { path: '$.probe', code: 'invalid_passive_probe', message: 'bad probe' },
    ]);
    expect(error.issues).toHaveLength(2);
    expect(error.message).toContain('$.input_schemas [insufficient_queue_evidence]: missing evidence');
    expect(error.message).toContain('$.probe [invalid_passive_probe]: bad probe');
  });

  it('covers all declared error codes', () => {
    const codes: readonly QueueSynthesisErrorCode[] = [
      'unsupported_input_schema',
      'insufficient_queue_evidence',
      'ohlcv_queue_synthesis_forbidden',
      'bbo_only_queue_synthesis_forbidden',
      'missing_price_or_quantity',
      'invalid_passive_probe',
      'invalid_probability_ppm',
      'non_monotonic_source',
      'nondeterministic_merge_order',
      'future_leakage_forbidden',
    ];
    expect(codes).toHaveLength(10);
  });
});
