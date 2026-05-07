import { describe, expect, it } from 'vitest';
import { ns } from '../../../../../strategy_runtime/src/contracts/time.js';
import {
  buildOfiFidelityResult,
  DEFAULT_OFI_FIDELITY_POLICY_V1,
} from '../../../../src/fidelity/ofi/index.js';
import type { OfiBucket, OfiFidelityPolicy } from '../../../../src/fidelity/ofi/index.js';

const BASE_TS = 1_770_000_000_000_000_000n;
const POLICY: OfiFidelityPolicy = {
  ...DEFAULT_OFI_FIDELITY_POLICY_V1,
  min_bucket_count: 3,
};

function bucket(index: number, ofi: bigint, extra: Partial<OfiBucket> = {}): OfiBucket {
  const start = BASE_TS + BigInt(index) * 1_000_000_000n;
  return {
    bucket_start_ts_ns: ns(start),
    bucket_end_ts_ns: ns(start + 1_000_000_000n),
    ofi,
    event_count: 1,
    missing_depth_level_count: extra.missing_depth_level_count ?? 0,
    unknown_trade_side_count: extra.unknown_trade_side_count ?? 0,
  };
}

describe('QFA-401 OFI fidelity result', () => {
  it('supports baseline and stress regime summaries', () => {
    const result = buildOfiFidelityResult([
      {
        regime: 'baseline',
        reference: [bucket(0, 1n), bucket(1, 2n), bucket(2, 3n)],
        synthesized: [bucket(0, 2n), bucket(1, 4n), bucket(2, 6n)],
      },
      {
        regime: 'stress',
        reference: [bucket(0, 1n), bucket(1, 2n), bucket(2, 3n)],
        synthesized: [bucket(0, -1n), bucket(1, -2n), bucket(2, -3n)],
      },
    ], POLICY);

    expect(result.result_schema_version).toBe(1);
    expect(result.regimes.map((regime) => regime.regime)).toEqual(['baseline', 'stress']);
    expect(result.regimes.map((regime) => regime.status)).toEqual(['pass', 'fail']);
  });

  it('carries missing-depth and unknown-side evidence into regime results', () => {
    const result = buildOfiFidelityResult([
      {
        regime: 'baseline',
        reference: [bucket(0, 1n, { missing_depth_level_count: 2 }), bucket(1, 2n), bucket(2, 3n)],
        synthesized: [bucket(0, 2n), bucket(1, 4n, { unknown_trade_side_count: 1 }), bucket(2, 6n)],
      },
    ], POLICY);

    expect(result.regimes[0]?.missing_depth_level_count).toBe(2);
    expect(result.regimes[0]?.unknown_trade_side_count).toBe(1);
  });

  it('identical synthetic fixture result is deterministic', () => {
    const input = [{
      regime: 'baseline',
      reference: [bucket(0, 1n), bucket(1, 2n), bucket(2, 3n)],
      synthesized: [bucket(0, 2n), bucket(1, 4n), bucket(2, 6n)],
    }];

    expect(buildOfiFidelityResult(input, POLICY)).toEqual(buildOfiFidelityResult(input, POLICY));
  });
});
