import { describe, expect, it } from 'vitest';
import {
  getQueueSchemaPriority,
  QUEUE_SCHEMA_PRIORITY_ORDER,
} from '../../../../src/data/queue-synthesis/schema-priority.js';

/**
 * Module under test: src/data/queue-synthesis/schema-priority.ts
 * Ticket: QFA-105 Session 2a
 */

describe('QFA-105 schema priority', () => {
  it('uses the locked queue merge priority order', () => {
    expect(QUEUE_SCHEMA_PRIORITY_ORDER).toEqual([
      'definition',
      'status',
      'mbo',
      'mbp-10',
      'mbp-1',
      'tbbo',
      'trades',
      'bbo',
      'statistics',
      'ohlcv-1m',
    ]);
  });

  it('assigns lower priority numbers to earlier schemas', () => {
    expect(getQueueSchemaPriority('definition')).toBeLessThan(getQueueSchemaPriority('mbo'));
    expect(getQueueSchemaPriority('tbbo')).toBeLessThan(getQueueSchemaPriority('trades'));
    expect(getQueueSchemaPriority('statistics')).toBeLessThan(getQueueSchemaPriority('ohlcv-1m'));
  });
});
