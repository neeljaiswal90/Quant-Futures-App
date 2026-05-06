import { describe, expect, it } from 'vitest';
import {
  TradeLedgerInputError,
  formatTradeLedgerIssues,
} from '../../../src/trade-ledger/index.js';

describe('QFA-203 TradeLedgerInputError', () => {
  it('aggregates path, code, and message issues', () => {
    const error = new TradeLedgerInputError([
      {
        path: '$.payload.price',
        code: 'missing_price',
        message: 'price is required',
      },
      {
        path: '$.payload.quantity',
        code: 'missing_quantity',
        message: 'quantity is required',
      },
    ]);

    expect(error.name).toBe('TradeLedgerInputError');
    expect(error.issues).toHaveLength(2);
    expect(error.message).toContain('$.payload.price missing_price: price is required');
    expect(error.message).toContain(
      '$.payload.quantity missing_quantity: quantity is required',
    );
  });

  it('formats empty issue arrays deterministically', () => {
    expect(formatTradeLedgerIssues([])).toBe('Trade ledger input is invalid');
  });
});
