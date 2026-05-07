import type {
  AlignedOfiBucket,
  OfiBucket,
  OfiFidelityPolicy,
  OfiFidelityRegimeInput,
  OfiFidelityRegimeResult,
  OfiFidelityResult,
  OfiRegime,
} from './types.js';
import {
  alignOfiBuckets,
  computeOfiSeriesStats,
  pearsonFromZscores,
  pearsonToPpm,
  zscore,
} from './ofi-statistics.js';

export const DEFAULT_OFI_FIDELITY_POLICY_V1: OfiFidelityPolicy = Object.freeze({
  policy_schema_version: 1,
  bucket: '1s',
  min_bucket_count: 300,
  min_pearson_r_ppm: 850_000,
  zscore_epsilon_ppm: 0,
  reference_depth_levels: 10,
  reference_mode: 'mbp10_unweighted_depth_sum',
  synthesized_mode: 'mbp1_trades_imbalance',
} as const satisfies OfiFidelityPolicy);

export function computeOfiFidelity(
  aligned: readonly AlignedOfiBucket[],
  policy: OfiFidelityPolicy = DEFAULT_OFI_FIDELITY_POLICY_V1,
  regime: OfiRegime = 'overall',
  evidence: {
    readonly missing_depth_level_count?: number;
    readonly unknown_trade_side_count?: number;
  } = {},
): OfiFidelityRegimeResult {
  const referenceValues = aligned.map((bucket) => bucket.reference_ofi);
  const synthesizedValues = aligned.map((bucket) => bucket.synthesized_ofi);
  const referenceStats = computeOfiSeriesStats(referenceValues);
  const synthesizedStats = computeOfiSeriesStats(synthesizedValues);

  if (aligned.length < policy.min_bucket_count) {
    return result({
      regime,
      status: 'insufficient_data',
      bucketCount: aligned.length,
      policy,
      referenceStats,
      synthesizedStats,
      pearsonRppm: null,
      evidence,
    });
  }

  if (
    referenceStats === null ||
    synthesizedStats === null ||
    referenceStats.std <= policy.zscore_epsilon_ppm / 1_000_000 ||
    synthesizedStats.std <= policy.zscore_epsilon_ppm / 1_000_000
  ) {
    return result({
      regime,
      status: 'insufficient_variance',
      bucketCount: aligned.length,
      policy,
      referenceStats,
      synthesizedStats,
      pearsonRppm: null,
      evidence,
    });
  }

  const pearsonRppm = pearsonToPpm(
    pearsonFromZscores(
      zscore(referenceValues, referenceStats),
      zscore(synthesizedValues, synthesizedStats),
    ),
  );

  return result({
    regime,
    status: pearsonRppm >= policy.min_pearson_r_ppm ? 'pass' : 'fail',
    bucketCount: aligned.length,
    policy,
    referenceStats,
    synthesizedStats,
    pearsonRppm,
    evidence,
  });
}

export function buildOfiFidelityResult(
  inputs: readonly OfiFidelityRegimeInput[],
  policy: OfiFidelityPolicy = DEFAULT_OFI_FIDELITY_POLICY_V1,
): OfiFidelityResult {
  return Object.freeze({
    result_schema_version: 1,
    policy: { ...policy },
    regimes: inputs.map((input) => {
      const aligned = alignOfiBuckets(input.reference, input.synthesized);
      return computeOfiFidelity(aligned, policy, input.regime, {
        missing_depth_level_count: sum(input.reference, 'missing_depth_level_count'),
        unknown_trade_side_count: sum(input.synthesized, 'unknown_trade_side_count'),
      });
    }),
  });
}

function result(input: {
  readonly regime: OfiRegime;
  readonly status: OfiFidelityRegimeResult['status'];
  readonly bucketCount: number;
  readonly policy: OfiFidelityPolicy;
  readonly referenceStats: ReturnType<typeof computeOfiSeriesStats>;
  readonly synthesizedStats: ReturnType<typeof computeOfiSeriesStats>;
  readonly pearsonRppm: number | null;
  readonly evidence: {
    readonly missing_depth_level_count?: number;
    readonly unknown_trade_side_count?: number;
  };
}): OfiFidelityRegimeResult {
  return Object.freeze({
    regime: input.regime,
    status: input.status,
    bucket_count: input.bucketCount,
    pearson_r_ppm: input.pearsonRppm,
    threshold_ppm: input.policy.min_pearson_r_ppm,
    reference_mean: input.referenceStats?.mean ?? null,
    synthesized_mean: input.synthesizedStats?.mean ?? null,
    reference_std: input.referenceStats?.std ?? null,
    synthesized_std: input.synthesizedStats?.std ?? null,
    missing_depth_level_count: input.evidence.missing_depth_level_count ?? 0,
    unknown_trade_side_count: input.evidence.unknown_trade_side_count ?? 0,
  });
}

function sum(buckets: readonly OfiBucket[], key: 'missing_depth_level_count' | 'unknown_trade_side_count'): number {
  return buckets.reduce((total, bucket) => total + bucket[key], 0);
}
