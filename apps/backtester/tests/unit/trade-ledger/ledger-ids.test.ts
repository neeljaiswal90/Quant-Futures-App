import { describe, expect, it } from 'vitest';
import {
  deriveLedgerExecutionId,
  deriveLedgerPositionId,
  deriveLedgerTradeId,
} from '../../../src/trade-ledger/index.js';

describe('QFA-203 ledger ids', () => {
  it('derives execution ids from source event ids', () => {
    expect(deriveLedgerExecutionId('sim-fill-fill-1')).toBe('execution-sim-fill-fill-1');
  });

  it('derives deterministic trade ids from run id and sequence', () => {
    expect(deriveLedgerTradeId('run-alpha', 7)).toBe('trade-run-alpha-7');
  });

  it('derives deterministic position ids with unknown strategy fallback', () => {
    expect(deriveLedgerPositionId(12345, null, 2)).toBe(
      'position-12345-unknown_strategy-2',
    );
  });
});
