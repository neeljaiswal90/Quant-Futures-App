import { describe, expect, it } from 'vitest';

import {
  makeSessionDateRange,
  parseSessionKeyConvention,
  validateSessionList,
  WalkForwardInputError,
} from '../../../src/walk-forward/index.js';

describe('walk-forward session ranges', () => {
  const sessions = [
    '2026-02-02',
    '2026-02-03',
    '2026-02-04',
    '2026-02-05',
  ] as const;

  it('validates sorted unique YYYY-MM-DD sessions', () => {
    expect(() => validateSessionList(sessions)).not.toThrow();
  });

  it('validates sorted unique YYYY-MM-DD-rth sessions', () => {
    expect(() =>
      validateSessionList([
        '2026-02-02-rth',
        '2026-02-03-rth',
        '2026-02-04-rth',
      ]),
    ).not.toThrow();
  });

  it('rejects an empty session list', () => {
    expect(() => validateSessionList([])).toThrow(WalkForwardInputError);
  });

  it('rejects duplicate sessions', () => {
    expect(() =>
      validateSessionList(['2026-02-02', '2026-02-03', '2026-02-03']),
    ).toThrow(/duplicate_session/u);
  });

  it('rejects unsorted sessions', () => {
    expect(() =>
      validateSessionList(['2026-02-02', '2026-02-04', '2026-02-03']),
    ).toThrow(/unsorted_sessions/u);
  });

  it('rejects malformed session strings', () => {
    expect(() => validateSessionList(['2026-02-30'])).toThrow(/invalid_session_id/u);
    expect(() => validateSessionList(['02-02-2026'])).toThrow(/invalid_session_id/u);
  });

  it('rejects mixed session-key conventions', () => {
    expect(() =>
      validateSessionList(['2026-02-02', '2026-02-03-rth']),
    ).toThrow(/one convention/u);
  });

  it('parses supported session-key conventions deterministically', () => {
    expect(parseSessionKeyConvention('2026-02-02')).toBe('date');
    expect(parseSessionKeyConvention('2026-02-02-rth')).toBe('date-rth');
    expect(parseSessionKeyConvention('2026-02-30-rth')).toBeNull();
  });

  it('creates half-open ranges from explicit session boundaries', () => {
    expect(makeSessionDateRange(sessions, 1, 3)).toEqual({
      start_session: '2026-02-03',
      end_session: '2026-02-05',
    });
  });

  it('requires an explicit exclusive end-session boundary', () => {
    expect(() => makeSessionDateRange(sessions, 2, 4)).toThrow(
      /exclusive end-session boundary/u,
    );
  });
});
