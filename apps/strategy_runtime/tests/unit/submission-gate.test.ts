import { describe, expect, it } from 'vitest';
import { SubmissionGate } from '../../src/execution/order-lifecycle-state-machine.js';

describe('SubmissionGate', () => {
  it('blocks while any source is active and preserves quarantine behavior', () => {
    const gate = new SubmissionGate();

    expect(gate.acquire()).toEqual({ allowed: true });

    gate.requestBlock('slo_halt');
    expect(gate.acquire()).toEqual({
      allowed: false,
      reason: 'slo_halt_active',
      open_quarantine_count: 0,
      active_block_sources: ['slo_halt'],
    });

    gate.blockFromQuarantine();
    expect(gate.acquire()).toEqual({
      allowed: false,
      reason: 'quarantine_active',
      open_quarantine_count: 1,
      active_block_sources: ['quarantine', 'slo_halt'],
    });

    gate.releaseBlock('slo_halt');
    expect(gate.acquire()).toEqual({
      allowed: false,
      reason: 'quarantine_active',
      open_quarantine_count: 1,
    });

    gate.unblockFromQuarantine();
    expect(gate.acquire()).toEqual({ allowed: true });
  });
});
