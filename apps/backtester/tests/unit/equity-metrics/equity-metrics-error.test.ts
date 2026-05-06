import { describe, expect, it } from 'vitest';
import {
  EquityMetricsInputError,
  formatEquityMetricsIssues,
} from '../../../src/equity-metrics/index.js';

describe('QFA-204 EquityMetricsInputError', () => {
  it('aggregates path, code, and message issues', () => {
    const error = new EquityMetricsInputError([
      {
        path: '$.valuation.tick_size',
        code: 'invalid_valuation_spec',
        message: 'tick size is invalid',
      },
      {
        path: '$.price',
        code: 'price_not_tick_aligned',
        message: 'price is off tick',
      },
    ]);

    expect(error.name).toBe('EquityMetricsInputError');
    expect(error.issues).toHaveLength(2);
    expect(error.message).toContain(
      '$.valuation.tick_size invalid_valuation_spec: tick size is invalid',
    );
    expect(error.message).toContain('$.price price_not_tick_aligned: price is off tick');
  });

  it('formats empty issue arrays deterministically', () => {
    expect(formatEquityMetricsIssues([])).toBe('Equity metrics input is invalid');
  });
});
