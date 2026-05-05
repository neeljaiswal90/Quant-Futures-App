import { describe, expect, it } from 'vitest';
import { ns } from '../../../../src/contracts/time.js';
import type { TimeBarSpec } from '../../../../src/data/bar-builder/bar-spec.js';
import { deriveTimeBucket } from '../../../../src/data/bar-builder/time-bucket.js';

/**
 * Module under test: src/data/bar-builder/time-bucket.ts
 * Ticket: QFA-104 Session 2a
 */

const oneMinute: TimeBarSpec = { kind: 'time', count: 1, unit: 'm', raw: '1m', token: '1m' };
const fiveMinute: TimeBarSpec = { kind: 'time', count: 5, unit: 'm', raw: '5m', token: '5m' };

describe('QFA-104 deriveTimeBucket', () => {
  it('aligns 1m buckets to UTC wall clock', () => {
    const bucket = deriveTimeBucket(ns('1767365723000000000'), oneMinute);
    expect(bucket).toEqual({
      bucket_start_ts_ns: ns('1767365700000000000'),
      bucket_end_ts_ns: ns('1767365760000000000'),
    });
  });

  it('aligns 5m buckets to UTC wall clock', () => {
    const bucket = deriveTimeBucket(ns('1767365965000000000'), fiveMinute);
    expect(bucket).toEqual({
      bucket_start_ts_ns: ns('1767365700000000000'),
      bucket_end_ts_ns: ns('1767366000000000000'),
    });
  });

  it('bucket calculation is independent of contract identity', () => {
    const oldContractBucket = deriveTimeBucket(ns('1767365965000000000'), fiveMinute);
    const newContractBucket = deriveTimeBucket(ns('1767365965000000000'), fiveMinute);
    expect(oldContractBucket).toEqual(newContractBucket);
  });

  it('handles exact boundary timestamps', () => {
    const bucket = deriveTimeBucket(ns('1767366000000000000'), fiveMinute);
    expect(bucket).toEqual({
      bucket_start_ts_ns: ns('1767366000000000000'),
      bucket_end_ts_ns: ns('1767366300000000000'),
    });
  });
});
