import { describe, expect, it } from 'vitest';
import { ns } from '../../../../../strategy_runtime/src/contracts/time.js';
import {
  alignOfiBuckets,
  computeOfiFidelity,
  DEFAULT_OFI_FIDELITY_POLICY_V1,
  pearsonToPpm,
} from '../../../../src/fidelity/ofi/index.js';
import type { AlignedOfiBucket, OfiBucket, OfiFidelityPolicy } from '../../../../src/fidelity/ofi/index.js';

const BASE_TS = 1_770_000_000_000_000_000n;
const TEST_POLICY: OfiFidelityPolicy = {
  ...DEFAULT_OFI_FIDELITY_POLICY_V1,
  min_bucket_count: 3,
};

function bucket(second: number, ofi: bigint): OfiBucket {
  const start = BASE_TS + BigInt(second) * 1_000_000_000n;
  return {
    bucket_start_ts_ns: ns(start),
    bucket_end_ts_ns: ns(start + 1_000_000_000n),
    ofi,
    event_count: 1,
    missing_depth_level_count: 0,
    unknown_trade_side_count: 0,
  };
}

function aligned(reference: readonly bigint[], synthesized: readonly bigint[]): readonly AlignedOfiBucket[] {
  return reference.map((value, index) => ({
    bucket_start_ts_ns: ns(BASE_TS + BigInt(index) * 1_000_000_000n),
    reference_ofi: value,
    synthesized_ofi: synthesized[index]!,
  }));
}

describe('QFA-401 OFI statistics', () => {
  it('aligns buckets by intersection only without zero padding', () => {
    const result = alignOfiBuckets(
      [bucket(0, 10n), bucket(1, 20n), bucket(3, 30n)],
      [bucket(1, 200n), bucket(2, 999n), bucket(3, 300n)],
    );

    expect(result.map((item) => item.bucket_start_ts_ns)).toEqual([ns(BASE_TS + 1_000_000_000n), ns(BASE_TS + 3_000_000_000n)]);
    expect(result.map((item) => item.reference_ofi)).toEqual([20n, 30n]);
    expect(result.map((item) => item.synthesized_ofi)).toEqual([200n, 300n]);
  });

  it('insufficient bucket count fails closed as insufficient_data', () => {
    const result = computeOfiFidelity(aligned([1n, 2n], [1n, 2n]), TEST_POLICY, 'baseline');
    expect(result.status).toBe('insufficient_data');
    expect(result.pearson_r_ppm).toBeNull();
  });

  it('zero variance fails closed as insufficient_variance', () => {
    const result = computeOfiFidelity(aligned([1n, 1n, 1n], [1n, 2n, 3n]), TEST_POLICY, 'baseline');
    expect(result.status).toBe('insufficient_variance');
    expect(result.pearson_r_ppm).toBeNull();
  });

  it('perfect positive correlation produces 1_000_000 ppm', () => {
    const result = computeOfiFidelity(aligned([1n, 2n, 3n], [2n, 4n, 6n]), TEST_POLICY, 'baseline');
    expect(result.pearson_r_ppm).toBe(1_000_000);
  });

  it('perfect negative correlation produces -1_000_000 ppm', () => {
    const result = computeOfiFidelity(aligned([1n, 2n, 3n], [-1n, -2n, -3n]), TEST_POLICY, 'baseline');
    expect(result.pearson_r_ppm).toBe(-1_000_000);
  });

  it('threshold r >= 850_000 passes', () => {
    const result = computeOfiFidelity(aligned([1n, 2n, 3n, 4n], [1n, 2n, 3n, 5n]), TEST_POLICY, 'baseline');
    expect(result.pearson_r_ppm).toBeGreaterThanOrEqual(850_000);
    expect(result.status).toBe('pass');
  });

  it('threshold r < 850_000 fails', () => {
    const result = computeOfiFidelity(aligned([1n, 2n, 3n, 4n], [4n, 1n, 3n, 2n]), TEST_POLICY, 'stress');
    expect(result.pearson_r_ppm).toBeLessThan(850_000);
    expect(result.status).toBe('fail');
  });

  it('ppm conversion clamps only tiny floating-point overshoot', () => {
    expect(pearsonToPpm(1.0000000001)).toBe(1_000_000);
    expect(() => pearsonToPpm(1.01)).toThrow(/outside/);
  });
});
