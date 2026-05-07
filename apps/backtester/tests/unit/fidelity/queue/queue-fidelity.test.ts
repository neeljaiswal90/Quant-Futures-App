import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ns } from '../../../../../strategy_runtime/src/contracts/time.js';
import type { DbnMbp1Record } from '../../../../../strategy_runtime/src/data/dbn-types.js';
import {
  buildQueueFidelityResult,
  compareQueueFidelityProbe,
  computeSynthesizedFillEstimate,
  DEFAULT_QUEUE_FIDELITY_POLICY_V1,
  summarizeQueueFidelityRegime,
  type QueueFidelityProbe,
  type QueueFidelityProbeResult,
} from '../../../../src/fidelity/queue/index.js';

describe('QFA-402 queue fidelity comparison', () => {
  it('uses QFA-105 mbp_proxy output for the synthesized path', async () => {
    const result = await computeSynthesizedFillEstimate(probe(), [mbp1(900n)]);

    expect(result.synthesized_source_mode).toBe('mbp_proxy');
    expect(result.synthesized_fill_probability_ppm).toBe(0);
  });

  it('keeps the synthesized adapter wired to synthesizeQueue rather than local probability math', () => {
    const source = readFileSync('apps/backtester/src/fidelity/queue/synthesized-queue.ts', 'utf8');

    expect(source).toContain('synthesizeQueue(');
    expect(source).toContain("mode: 'mbp_proxy'");
    expect(source).toContain("input_schemas: ['mbp-1']");
  });

  it('computes absolute_error_ppm correctly', () => {
    const result = compareQueueFidelityProbe(reference(600_000), synthesized(450_000));

    expect(result.absolute_error_ppm).toBe(150_000);
  });

  it('marks probes within tolerance at <=100_000 ppm', () => {
    const result = compareQueueFidelityProbe(reference(600_000), synthesized(500_000));

    expect(result.within_tolerance).toBe(true);
  });

  it('marks probes outside tolerance above 100_000 ppm', () => {
    const result = compareQueueFidelityProbe(reference(600_000), synthesized(499_999));

    expect(result.within_tolerance).toBe(false);
  });

  it('handles reference unavailable and synthesized unavailable statuses', () => {
    expect(compareQueueFidelityProbe(reference(null), synthesized(0)).status).toBe('reference_unavailable');
    expect(compareQueueFidelityProbe(reference(0), synthesized(null)).status).toBe('synthesized_unavailable');
  });

  it('passes a regime at >=800_000 ppm within-tolerance share', () => {
    const results = [
      compared(true),
      compared(true),
      compared(true),
      compared(true),
      compared(false),
    ];
    const policy = {
      ...DEFAULT_QUEUE_FIDELITY_POLICY_V1,
      min_comparable_probes: 5,
    };

    expect(summarizeQueueFidelityRegime('baseline', results, policy)).toMatchObject({
      status: 'pass',
      within_tolerance_share_ppm: 800_000,
    });
  });

  it('fails a regime below 800_000 ppm within-tolerance share', () => {
    const results = [
      compared(true),
      compared(true),
      compared(true),
      compared(false),
      compared(false),
    ];
    const policy = {
      ...DEFAULT_QUEUE_FIDELITY_POLICY_V1,
      min_comparable_probes: 5,
    };

    expect(summarizeQueueFidelityRegime('stress', results, policy)).toMatchObject({
      status: 'fail',
      within_tolerance_share_ppm: 600_000,
    });
  });

  it('returns insufficient_data when comparable probe count is below policy minimum', () => {
    expect(summarizeQueueFidelityRegime('baseline', [compared(true)])).toMatchObject({
      status: 'insufficient_data',
      comparable_probes: 1,
    });
  });

  it('builds deterministic baseline/stress result sets', () => {
    const input = [
      { regime: 'baseline', probe_results: [compared(true)] },
      { regime: 'stress', probe_results: [compared(false)] },
    ];
    const policy = {
      ...DEFAULT_QUEUE_FIDELITY_POLICY_V1,
      min_comparable_probes: 1,
    };

    expect(buildQueueFidelityResult(input, policy)).toEqual(buildQueueFidelityResult(input, policy));
  });
});

function probe(): QueueFidelityProbe {
  return {
    probe_id: 'probe-1',
    ts_ns: ns(1_000n),
    instrument_id: 1,
    raw_symbol: 'MNQH6',
    side: 'buy',
    limit_price: 100n,
    quantity: 1n,
    fill_horizon_ns: 5_000n,
    depletion_lookback_ns: 30_000n,
  };
}

function reference(ppm: number | null): QueueFidelityProbeResult {
  return {
    ...baseResult(),
    reference_fill_probability_ppm: ppm,
    synthesized_fill_probability_ppm: null,
    status: ppm === null ? 'reference_unavailable' : 'compared',
  };
}

function synthesized(ppm: number | null): QueueFidelityProbeResult {
  return {
    ...baseResult(),
    reference_fill_probability_ppm: null,
    synthesized_fill_probability_ppm: ppm,
    status: ppm === null ? 'synthesized_unavailable' : 'compared',
    synthesized_source_mode: 'mbp_proxy',
  };
}

function compared(withinTolerance: boolean): QueueFidelityProbeResult {
  return {
    ...baseResult(),
    reference_fill_probability_ppm: withinTolerance ? 500_000 : 700_001,
    synthesized_fill_probability_ppm: 600_000,
    absolute_error_ppm: withinTolerance ? 100_000 : 100_001,
    within_tolerance: withinTolerance,
    status: 'compared',
    synthesized_source_mode: 'mbp_proxy',
  };
}

function baseResult(): QueueFidelityProbeResult {
  const baseProbe = probe();
  return {
    probe_id: baseProbe.probe_id,
    ts_ns: baseProbe.ts_ns,
    side: baseProbe.side,
    limit_price: baseProbe.limit_price,
    quantity: baseProbe.quantity,
    reference_fill_probability_ppm: null,
    synthesized_fill_probability_ppm: null,
    absolute_error_ppm: null,
    within_tolerance: null,
    status: 'compared',
    synthesized_source_mode: null,
  };
}

function mbp1(ts: bigint): DbnMbp1Record {
  return {
    schema: 'mbp-1',
    ts_event: ns(ts),
    ts_recv: ns(ts),
    instrument_id: 1,
    action: 'A',
    side: 'B',
    price: 100n,
    size: 1,
    levels: [
      {
        bid_px: 100n,
        bid_sz: 10,
        bid_ct: 1,
        ask_px: 101n,
        ask_sz: 12,
        ask_ct: 1,
      },
    ],
  };
}
