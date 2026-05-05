import { describe, expect, it } from 'vitest';
import { ns } from '../../../../src/contracts/time.js';
import { deriveBoundaryId } from '../../../../src/data/bar-builder/identity.js';

/**
 * Module under test: src/data/bar-builder/identity.ts
 * Ticket: QFA-104 Session 2a
 */

describe('QFA-104 deriveBoundaryId', () => {
  it('matches the locked grammar', () => {
    expect(
      deriveBoundaryId({
        instrument_root: 'MNQ',
        boundary_ts_ns: ns('1772470800000000000'),
        previous_contract: { instrument_id: 1, raw_symbol: 'MNQH6', expiration: null },
        next_contract: { instrument_id: 2, raw_symbol: 'MNQM6', expiration: null },
      }),
    ).toBe('roll-mnq-mnqh6-mnqm6-1772470800000000000');
  });

  it('falls back to iid tokens when raw_symbol is unavailable', () => {
    expect(
      deriveBoundaryId({
        instrument_root: 'MNQ',
        boundary_ts_ns: ns('1772470800000000000'),
        previous_contract: { instrument_id: 12345, raw_symbol: null, expiration: null },
        next_contract: { instrument_id: 12346, raw_symbol: null, expiration: null },
      }),
    ).toBe('roll-mnq-iid12345-iid12346-1772470800000000000');
  });

  it('supports mixed raw_symbol and iid fallback cases', () => {
    expect(
      deriveBoundaryId({
        instrument_root: 'MNQ',
        boundary_ts_ns: ns('1772470800000000000'),
        previous_contract: { instrument_id: 12345, raw_symbol: 'MNQH6', expiration: null },
        next_contract: { instrument_id: 12346, raw_symbol: null, expiration: null },
      }),
    ).toBe('roll-mnq-mnqh6-iid12346-1772470800000000000');
  });
});
