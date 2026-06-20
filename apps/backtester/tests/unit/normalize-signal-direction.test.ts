// Module under test: apps/backtester/src/replay-dataset-input/adapter.ts
// QFA-DATA-LEAK: locks TS labeler direction resolution at parity with the
// canonical Python resolver services/replay/replay/setups.py:_direction.
//
// Background: the setup-deriver (Python) and the forward-return labeler (TS)
// independently resolve a signal's direction. When they disagree, a directional
// setup gets a `neutral_direction` label and is dropped in dataset.py's join.
// The detectors emit `side="short"/"long"` and `side_inferred="*_absorbed"`,
// none of which the old TS resolver recognized — ~70% of directional firings
// were silently excluded from training. These cases MUST resolve identically
// in both languages; if you change one resolver, change the other and this
// table.
import { describe, expect, it } from 'vitest';
import { normalizeSignalDirection } from '../../src/index.js';

describe('normalizeSignalDirection — Python `_direction` parity', () => {
  // (direction, side) -> expected. Mirrors setups.py:_direction exactly for
  // every token observed in real detector output.
  const cases: ReadonlyArray<readonly [string | null, string | null, string]> = [
    // The dominant real-world tokens that the OLD resolver dropped to unknown.
    [null, 'short', 'short'],
    [null, 'long', 'long'],
    [null, 'sell_absorbed', 'long'], // sellers absorbed -> buyers won -> long
    [null, 'buy_absorbed', 'short'], // buyers absorbed -> sellers won -> short
    ['sell_absorbed', null, 'long'],
    ['buy_absorbed', null, 'short'],
    // Absorption tokens must win over the substring "buy"/"sell" they contain.
    ['buy_absorbed', 'buy', 'short'],
    ['sell_absorbed', 'sell', 'long'],
    // Cases the old resolver already handled — must still pass.
    [null, 'bid', 'long'],
    [null, 'ask', 'short'],
    ['long', null, 'long'],
    ['short', null, 'short'],
    ['bullish', null, 'long'],
    ['bearish', null, 'short'],
    // up/down (handled by Python, not by the old TS).
    ['up', null, 'long'],
    ['down', null, 'short'],
    // Explicit neutral / balanced.
    ['neutral', null, 'neutral'],
    ['mixed', null, 'neutral'],
    [null, 'balanced', 'neutral'],
    // Truly unresolvable.
    [null, null, 'unknown'],
    ['', '', 'unknown'],
    ['wat', 'nonsense', 'unknown'],
  ];

  for (const [direction, side, expected] of cases) {
    it(`direction=${JSON.stringify(direction)} side=${JSON.stringify(side)} -> ${expected}`, () => {
      expect(normalizeSignalDirection(direction, side)).toBe(expected);
    });
  }

  it('recovers the formerly-dropped majority tokens (regression guard)', () => {
    // These four accounted for the bulk of the dropped firings in real data.
    expect(normalizeSignalDirection(null, 'short')).not.toBe('unknown');
    expect(normalizeSignalDirection(null, 'long')).not.toBe('unknown');
    expect(normalizeSignalDirection(null, 'sell_absorbed')).not.toBe('unknown');
    expect(normalizeSignalDirection(null, 'buy_absorbed')).not.toBe('unknown');
  });
});
