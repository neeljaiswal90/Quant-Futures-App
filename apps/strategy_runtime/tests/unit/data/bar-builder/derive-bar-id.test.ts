import { describe, expect, it } from 'vitest';
import { ns } from '../../../../src/contracts/time.js';
import { deriveBarId } from '../../../../src/data/bar-builder/identity.js';

/**
 * Module under test: src/data/bar-builder/identity.ts
 * Ticket: QFA-104 Session 2a
 */

describe('QFA-104 deriveBarId', () => {
  it('matches the locked grammar for time bars', () => {
    expect(
      deriveBarId({
        instrument_root: 'MNQ',
        raw_symbol: 'MNQH6',
        instrument_id: 123,
        bar_spec_token: '1m',
        bucket_start_ts_ns: ns('1767365700000000000'),
        first_record_ts_ns: ns('1767365723000000000'),
        seq: 0,
      }),
    ).toBe('bar-mnq-mnqh6-1m-20260102T145500Z-0');
  });

  it('matches the locked grammar for event bars', () => {
    expect(
      deriveBarId({
        instrument_root: 'MNQ',
        raw_symbol: 'MNQH6',
        instrument_id: 123,
        bar_spec_token: 'tick100',
        bucket_start_ts_ns: null,
        first_record_ts_ns: ns('1767365723000000000'),
        seq: 0,
      }),
    ).toBe('bar-mnq-mnqh6-tick100-20260102T145523Z-0');
  });

  it('produces distinct ids for different concrete contracts in the same bucket', () => {
    const oldContract = deriveBarId({
      instrument_root: 'MNQ',
      raw_symbol: 'MNQH6',
      instrument_id: 1,
      bar_spec_token: '1m',
      bucket_start_ts_ns: ns('1767365700000000000'),
      first_record_ts_ns: ns('1767365723000000000'),
      seq: 0,
    });
    const newContract = deriveBarId({
      instrument_root: 'MNQ',
      raw_symbol: 'MNQM6',
      instrument_id: 2,
      bar_spec_token: '1m',
      bucket_start_ts_ns: ns('1767365700000000000'),
      first_record_ts_ns: ns('1767365723000000000'),
      seq: 1,
    });
    expect(oldContract).not.toBe(newContract);
  });

  it('lowercases instrument tokens', () => {
    expect(
      deriveBarId({
        instrument_root: 'MNQ',
        raw_symbol: 'MNQH6',
        instrument_id: 123,
        bar_spec_token: 'vol500',
        bucket_start_ts_ns: null,
        first_record_ts_ns: ns('1767365723000000000'),
        seq: 0,
      }),
    ).toContain('bar-mnq-mnqh6-vol500-');
  });

  it('uses iid fallback when raw_symbol is null', () => {
    expect(
      deriveBarId({
        instrument_root: 'MNQ',
        raw_symbol: null,
        instrument_id: 12345,
        bar_spec_token: '1m',
        bucket_start_ts_ns: ns('1767365700000000000'),
        first_record_ts_ns: ns('1767365723000000000'),
        seq: 0,
      }),
    ).toContain('bar-mnq-iid12345-1m-');
  });

  it('uses compact iso format without fractional seconds', () => {
    expect(
      deriveBarId({
        instrument_root: 'MNQ',
        raw_symbol: 'MNQH6',
        instrument_id: 1,
        bar_spec_token: '1m',
        bucket_start_ts_ns: ns('1767365700123456789'),
        first_record_ts_ns: ns('1767365723123456789'),
        seq: 0,
      }),
    ).toBe('bar-mnq-mnqh6-1m-20260102T145500Z-0');
  });
});
