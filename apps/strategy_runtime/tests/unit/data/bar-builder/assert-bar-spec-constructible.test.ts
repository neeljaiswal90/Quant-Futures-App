import { describe, expect, it } from 'vitest';
import { BarBuilderInputError } from '../../../../src/data/bar-builder/bar-builder-input-error.js';
import { parseBarSpec } from '../../../../src/data/bar-builder/bar-spec.js';
import { assertBarSpecConstructible } from '../../../../src/data/bar-builder/capability-gates.js';

/**
 * Module under test: src/data/bar-builder/capability-gates.ts
 * Ticket: QFA-104 Session 2a
 */

describe('QFA-104 assertBarSpecConstructible', () => {
  it('returns ohlcv_passthrough for 1m bars from ohlcv-1m', () => {
    expect(assertBarSpecConstructible(parseBarSpec('1m'), ['ohlcv-1m'])).toBe('ohlcv_passthrough');
  });

  it('returns ohlcv_aggregation for multi-minute bars from ohlcv-1m', () => {
    expect(assertBarSpecConstructible(parseBarSpec('5m'), ['ohlcv-1m'])).toBe('ohlcv_aggregation');
  });

  it('rejects subminute bars from ohlcv-1m', () => {
    expect(() => assertBarSpecConstructible(parseBarSpec('30s'), ['ohlcv-1m'])).toThrow(
      BarBuilderInputError,
    );
    expect(() => assertBarSpecConstructible(parseBarSpec('30s'), ['ohlcv-1m'])).toThrow(
      /subminute_from_ohlcv/,
    );
  });

  it('returns trade_aggregation for time bars from trades', () => {
    expect(assertBarSpecConstructible(parseBarSpec('1m'), ['trades'])).toBe('trade_aggregation');
  });

  it('returns trade_aggregation for tick bars from trades', () => {
    expect(assertBarSpecConstructible(parseBarSpec('tick:ticks:100'), ['trades'])).toBe(
      'trade_aggregation',
    );
  });

  it('returns trade_aggregation for volume bars from tbbo inputs', () => {
    expect(assertBarSpecConstructible(parseBarSpec('tick:volume:500'), ['tbbo'])).toBe(
      'trade_aggregation',
    );
  });

  it('rejects event bars from ohlcv-only inputs', () => {
    expect(() =>
      assertBarSpecConstructible(parseBarSpec('tick:dollar:1000'), ['ohlcv-1m']),
    ).toThrow(/incompatible_input_schema/);
  });

  it('rejects incompatible schema sets', () => {
    expect(() => assertBarSpecConstructible(parseBarSpec('1m'), ['mbo'])).toThrow(
      /incompatible_input_schema/,
    );
  });

  it('rejects roll-unsplittable aggregate cases for tier c ohlcv', () => {
    expect(() =>
      assertBarSpecConstructible(parseBarSpec('5m'), ['ohlcv-1m'], { rollBoundaryExpected: true }),
    ).toThrow(/roll_unsplittable_aggregate/);
  });

  it('prefers trade aggregation when both trades and ohlcv are available', () => {
    expect(assertBarSpecConstructible(parseBarSpec('5m'), ['trades', 'ohlcv-1m'])).toBe(
      'trade_aggregation',
    );
  });
});
