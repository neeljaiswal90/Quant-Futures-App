import { describe, expect, it } from 'vitest';
import {
  EquityMetricsInputError,
  decimalStringToScaledInt,
  priceToTicks,
  usdNumberToCents,
  validateEquityMetricsOptions,
} from '../../../src/equity-metrics/index.js';

describe('QFA-204 price and money units', () => {
  it('parses decimal strings to scaled integers', () => {
    expect(decimalStringToScaledInt('100.25')).toEqual({
      value: 10025n,
      scale: 100n,
    });
  });

  it('converts exact tick-aligned prices', () => {
    expect(priceToTicks(100.25, '0.25')).toBe(401n);
    expect(priceToTicks(2.5, '0.5')).toBe(5n);
  });

  it('rejects non-tick-aligned prices', () => {
    expect(() => priceToTicks(100.1, '0.25')).toThrow(EquityMetricsInputError);
    expect(() => priceToTicks(100.1, '0.25')).toThrow('price_not_tick_aligned');
  });

  it('rejects NaN and Infinity prices', () => {
    expect(() => priceToTicks(Number.NaN, '0.25')).toThrow('invalid_price');
    expect(() => priceToTicks(Number.POSITIVE_INFINITY, '0.25')).toThrow(
      'invalid_price',
    );
  });

  it('converts exact USD cents', () => {
    expect(usdNumberToCents(1.23)).toBe(123n);
    expect(usdNumberToCents(0)).toBe(0n);
  });

  it('rejects sub-cent fee values', () => {
    expect(() => usdNumberToCents(0.001)).toThrow('invalid_fee');
  });

  it('rejects invalid valuation spec and initial equity', () => {
    expect(() =>
      validateEquityMetricsOptions({
        initial_equity_cents: 0n,
        valuation: {
          instrument_root: 'MNQ',
          tick_size: '0.25',
          tick_value_usd_cents: 50n,
        },
      }),
    ).toThrow('invalid_initial_equity');

    expect(() =>
      validateEquityMetricsOptions({
        initial_equity_cents: 100_000n,
        valuation: {
          instrument_root: 'MNQ',
          tick_size: '0',
          tick_value_usd_cents: 50n,
        },
      }),
    ).toThrow('invalid_valuation_spec');
  });

  it('rejects non-positive tick value cents', () => {
    expect(() =>
      validateEquityMetricsOptions({
        initial_equity_cents: 100_000n,
        valuation: {
          instrument_root: 'MNQ',
          tick_size: '0.25',
          tick_value_usd_cents: 0n,
        },
      }),
    ).toThrow('invalid_valuation_spec');
  });
});
