import { describe, expect, it } from 'vitest';
import { createExecutionAdapter, SimulatedExecutionAdapter } from '../../src/execution/simulated-execution.js';
import { getContractSpec } from '../../src/risk/contracts.js';

const contract = getContractSpec('MNQ1!');

describe('Simulated execution', () => {
  it('fills entries and exits deterministically with slippage hooks', async () => {
    const adapter = new SimulatedExecutionAdapter(contract, { slippage_ticks: 2, commission_per_contract: 0.4 });
    const entry = await adapter.placeEntry({
      candidate: {
        direction: 'long',
        setup_type: 'trend_pullback_long',
        entry_low: 20_000,
        entry_high: 20_001,
        stop: 19_990,
        target_1: 20_010,
        target_2: 20_020,
        target_3: null,
        risk_pts: 10,
        rr_t1: 1,
        rr_t2: 2,
        confidence: 8,
        confidence_factors: ['fixture'],
        reason: 'fixture',
      },
      quantity: 2,
      reference_price: 20_000,
    });
    const exit = await adapter.placeExit({
      side: 'long',
      quantity: 2,
      reference_price: 20_010,
      reason: 'target_1',
    });

    expect(entry.fill_price).toBeGreaterThan(20_000);
    expect(exit.fill_price).toBeLessThan(20_010);
    expect(entry.fee_usd).toBe(0.8);
  });

  it('refuses to create a live adapter in the sim-only runtime', () => {
    expect(() => createExecutionAdapter('live', contract)).toThrow(/disabled/i);
  });
});
