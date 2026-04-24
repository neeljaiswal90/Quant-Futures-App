import type { CandidateSetup, EntryStateVector } from '../contracts/candidate.js';
import type { EntryStateOfiReliability } from '../contracts/market.js';

export const MIN_BUCKET_SAMPLES = 30;
export const Z_EMA9_BIN_EDGES = [0.15, 0.425, 0.7, 0.975, 1.25];
export const PULLBACK_RATIO_BIN_EDGES = [0.25, 0.3425, 0.435, 0.5275, 0.62];
export const Z_OFI_BLEND_BIN_EDGES = [-3, -1, 0, 1, 3];
export const EXPECTANCY_ENGINE_SCHEMA_VERSION = '0.1.0';
export const DEFAULT_SIDE_PRIOR_MIN_EXPECTED_R = 0.2;

export type ExpectancyDimension = 'z_ema9' | 'pullback_ratio' | 'z_ofi_blend';
export type BucketSource = 'full' | 'backoff_1d' | 'backoff_2d' | 'side_prior';

export const EXPECTANCY_BACKOFF_ORDER: ExpectancyDimension[] = [
  'z_ofi_blend',
  'pullback_ratio',
  'z_ema9',
];

export interface BucketStats {
  n: number;
  mean_r_raw: number;
  win_prob: number;
  std_r_raw: number;
}

export interface SidePriorStats extends BucketStats {
  direction: 'long' | 'short';
}

export interface ExpectancyBucketTable {
  schema_version: string;
  generated_at: string;
  source_row_count: number;
  min_bucket_samples: number;
  horizon_sec: 30;
  dimensions: ExpectancyDimension[];
  backoff_order: ExpectancyDimension[];
  z_ema9_bin_edges: number[];
  pullback_ratio_bin_edges: number[];
  z_ofi_blend_bin_edges: number[];
  buckets_full: Record<string, BucketStats>;
  buckets_backoff_1d: Record<string, BucketStats>;
  buckets_backoff_2d: Record<string, BucketStats>;
  side_prior: { long: SidePriorStats | null; short: SidePriorStats | null };
}

export function binIndex(value: number | null | undefined, edges: number[]): number | null {
  if (value == null || !Number.isFinite(value) || edges.length < 2) return null;
  const lastBin = edges.length - 2;
  if (value < edges[0]!) return 0;
  if (value >= edges[edges.length - 1]!) return lastBin;
  for (let i = 0; i < lastBin; i++) {
    if (value >= edges[i]! && value < edges[i + 1]!) return i;
  }
  return lastBin;
}

export function buildBucketKey(
  direction: 'long' | 'short',
  dims: Partial<Record<ExpectancyDimension, number>>,
): string {
  const parts: string[] = [direction];
  for (const dim of ['pullback_ratio', 'z_ema9', 'z_ofi_blend'] as const) {
    if (dims[dim] !== undefined) parts.push(`${dim}=${dims[dim]}`);
  }
  return parts.join('|');
}

export function binStateVector(
  vector: EntryStateVector,
): { z_ema9: number | null; pullback_ratio: number | null; z_ofi_blend: number | null } {
  return {
    z_ema9: binIndex(vector.z_ema9, Z_EMA9_BIN_EDGES),
    pullback_ratio: binIndex(vector.pullback_ratio, PULLBACK_RATIO_BIN_EDGES),
    z_ofi_blend: binIndex(vector.z_ofi_blend, Z_OFI_BLEND_BIN_EDGES),
  };
}

export interface ExpectancyLookupInput {
  direction: 'long' | 'short';
  vector: EntryStateVector;
  cost_r: number;
  min_n?: number;
  side_prior_min_expected_r?: number;
  min_expected_r_primary?: number;
}

export type ExpectancyShadowRejectReason =
  | 'rejected_by_bucket_sparsity'
  | 'rejected_by_expectancy_below_threshold';

export interface ExpectancyEstimate {
  expected_r_30s_post_cost: number | null;
  expected_r_30s_raw: number | null;
  win_prob_30s: number | null;
  quality_band: 'A' | 'B' | 'C' | 'D';
  bucket_source: BucketSource | null;
  bucket_id: string | null;
  bucket_sample_count: number | null;
  sparse_ofi_forced: boolean;
  shadow_reject_reason: ExpectancyShadowRejectReason | null;
}

export function computeQualityBand(
  expectedRPostCost: number | null,
  winProb: number | null,
): 'A' | 'B' | 'C' | 'D' {
  if (expectedRPostCost === null || winProb === null) return 'D';
  if (expectedRPostCost >= 0.3 && winProb >= 0.6) return 'A';
  if (expectedRPostCost >= 0.15 && winProb >= 0.55) return 'B';
  if (expectedRPostCost >= 0.05 && winProb >= 0.5) return 'C';
  return 'D';
}

export function lookupExpectancy(
  table: ExpectancyBucketTable | null,
  input: ExpectancyLookupInput,
): ExpectancyEstimate {
  const minN = input.min_n ?? MIN_BUCKET_SAMPLES;
  const sidePriorMin = input.side_prior_min_expected_r ?? DEFAULT_SIDE_PRIOR_MIN_EXPECTED_R;
  const primaryMin = input.min_expected_r_primary ?? 0;
  if (!table) {
    return {
      expected_r_30s_post_cost: null,
      expected_r_30s_raw: null,
      win_prob_30s: null,
      quality_band: 'D',
      bucket_source: null,
      bucket_id: null,
      bucket_sample_count: null,
      sparse_ofi_forced: false,
      shadow_reject_reason: null,
    };
  }

  const sparseOfi = input.vector.ofi_reliability === ('sparse' satisfies EntryStateOfiReliability);
  const bins = binStateVector(input.vector);
  const startLevel = sparseOfi ? 1 : 0;

  const makeKeyAtLevel = (level: number) => {
    const dropped = new Set(EXPECTANCY_BACKOFF_ORDER.slice(0, level));
    const dims: Partial<Record<ExpectancyDimension, number>> = {};
    for (const dim of ['z_ema9', 'pullback_ratio', 'z_ofi_blend'] as const) {
      if (dropped.has(dim)) continue;
      const bin = bins[dim];
      if (bin === null) return null;
      dims[dim] = bin;
    }
    return { key: buildBucketKey(input.direction, dims) };
  };

  const levels: Array<{ level: number; dict: Record<string, BucketStats>; source: BucketSource }> = [
    { level: 0, dict: table.buckets_full, source: 'full' },
    { level: 1, dict: table.buckets_backoff_1d, source: 'backoff_1d' },
    { level: 2, dict: table.buckets_backoff_2d, source: 'backoff_2d' },
  ];

  for (const entry of levels) {
    if (entry.level < startLevel) continue;
    const key = makeKeyAtLevel(entry.level);
    if (!key) continue;
    const stats = entry.dict[key.key];
    if (!stats || stats.n < minN) continue;
    return buildEstimate(stats, entry.source, key.key, input.cost_r, sparseOfi, sidePriorMin, primaryMin, false);
  }

  const prior = input.direction === 'long' ? table.side_prior.long : table.side_prior.short;
  if (prior && prior.n >= minN) {
    return buildEstimate(prior, 'side_prior', `${input.direction}|side_prior`, input.cost_r, sparseOfi, sidePriorMin, primaryMin, true);
  }

  return {
    expected_r_30s_post_cost: null,
    expected_r_30s_raw: null,
    win_prob_30s: null,
    quality_band: 'D',
    bucket_source: null,
    bucket_id: null,
    bucket_sample_count: null,
    sparse_ofi_forced: sparseOfi,
    shadow_reject_reason: null,
  };
}

function buildEstimate(
  stats: BucketStats,
  source: BucketSource,
  key: string,
  costR: number,
  sparseOfi: boolean,
  sidePriorMin: number,
  primaryMin: number,
  isSidePrior: boolean,
): ExpectancyEstimate {
  const rawR = stats.mean_r_raw;
  const postR = round4(rawR - costR);
  let shadowReject: ExpectancyShadowRejectReason | null = null;
  if (isSidePrior) {
    if (postR < sidePriorMin) shadowReject = 'rejected_by_bucket_sparsity';
  } else if (postR < primaryMin) {
    shadowReject = 'rejected_by_expectancy_below_threshold';
  }
  return {
    expected_r_30s_post_cost: postR,
    expected_r_30s_raw: round4(rawR),
    win_prob_30s: round4(stats.win_prob),
    quality_band: computeQualityBand(postR, stats.win_prob),
    bucket_source: source,
    bucket_id: key,
    bucket_sample_count: stats.n,
    sparse_ofi_forced: sparseOfi,
    shadow_reject_reason: shadowReject,
  };
}

export function attachQuantExpectancy(
  setup: CandidateSetup,
  estimate: ExpectancyEstimate,
): void {
  setup.expected_r_30s_quant = estimate.expected_r_30s_post_cost;
  setup.win_prob_30s_quant = estimate.win_prob_30s;
  setup.quality_band_quant = estimate.bucket_source === null ? null : estimate.quality_band;
  setup.bucket_id_quant = estimate.bucket_id;
  setup.bucket_sample_count_quant = estimate.bucket_sample_count;
  if (estimate.bucket_source !== null) {
    setup.bucket_source_quant = estimate.bucket_source;
  }
  setup.quant_shadow_reject_reason = estimate.shadow_reject_reason;
  setup.bucket_lookup_status = estimate.bucket_source === null
    ? 'cold_start_no_match'
    : estimate.bucket_source === 'full'
      ? 'full_match'
      : estimate.bucket_source;
}

export interface ExpectancyTrainingRow {
  direction: 'long' | 'short';
  z_ema9: number | null;
  pullback_ratio: number | null;
  z_ofi_blend: number | null;
  ofi_reliability?: EntryStateOfiReliability | null;
  realized_r_30s: number;
}

export interface BuildBucketTableOptions {
  min_n?: number;
  horizon_sec?: 30;
}

export function buildBucketTableFromRows(
  rows: ExpectancyTrainingRow[],
  options: BuildBucketTableOptions = {},
): ExpectancyBucketTable {
  const minN = options.min_n ?? MIN_BUCKET_SAMPLES;
  const accFull: Record<string, Accumulator> = {};
  const acc1d: Record<string, Accumulator> = {};
  const acc2d: Record<string, Accumulator> = {};
  const accSide: Record<'long' | 'short', Accumulator> = {
    long: emptyAcc(),
    short: emptyAcc(),
  };

  let usedRows = 0;
  for (const row of rows) {
    if ((row.direction !== 'long' && row.direction !== 'short') || !Number.isFinite(row.realized_r_30s)) continue;
    usedRows += 1;
    const bins = {
      z_ema9: binIndex(row.z_ema9, Z_EMA9_BIN_EDGES),
      pullback_ratio: binIndex(row.pullback_ratio, PULLBACK_RATIO_BIN_EDGES),
      z_ofi_blend: binIndex(row.z_ofi_blend, Z_OFI_BLEND_BIN_EDGES),
    };
    pushStat(accSide[row.direction], row.realized_r_30s);

    const isSparse = row.ofi_reliability === 'sparse';
    if (!isSparse && bins.z_ema9 !== null && bins.pullback_ratio !== null && bins.z_ofi_blend !== null) {
      const key = buildBucketKey(row.direction, {
        z_ema9: bins.z_ema9,
        pullback_ratio: bins.pullback_ratio,
        z_ofi_blend: bins.z_ofi_blend,
      });
      pushStat((accFull[key] ??= emptyAcc()), row.realized_r_30s);
    }

    const oneKey = buildPartialKey(row.direction, bins, new Set([EXPECTANCY_BACKOFF_ORDER[0]!]));
    if (oneKey) pushStat((acc1d[oneKey] ??= emptyAcc()), row.realized_r_30s);
    const twoKey = buildPartialKey(row.direction, bins, new Set([EXPECTANCY_BACKOFF_ORDER[0]!, EXPECTANCY_BACKOFF_ORDER[1]!]));
    if (twoKey) pushStat((acc2d[twoKey] ??= emptyAcc()), row.realized_r_30s);
  }

  return {
    schema_version: EXPECTANCY_ENGINE_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    source_row_count: usedRows,
    min_bucket_samples: minN,
    horizon_sec: 30,
    dimensions: ['z_ema9', 'pullback_ratio', 'z_ofi_blend'],
    backoff_order: EXPECTANCY_BACKOFF_ORDER,
    z_ema9_bin_edges: Z_EMA9_BIN_EDGES,
    pullback_ratio_bin_edges: PULLBACK_RATIO_BIN_EDGES,
    z_ofi_blend_bin_edges: Z_OFI_BLEND_BIN_EDGES,
    buckets_full: finalizeBuckets(accFull),
    buckets_backoff_1d: finalizeBuckets(acc1d),
    buckets_backoff_2d: finalizeBuckets(acc2d),
    side_prior: {
      long: accSide.long.n > 0 ? { ...finalizeOne(accSide.long), direction: 'long' } : null,
      short: accSide.short.n > 0 ? { ...finalizeOne(accSide.short), direction: 'short' } : null,
    },
  };
}

interface Accumulator {
  sum: number;
  sumSq: number;
  wins: number;
  n: number;
}

function emptyAcc(): Accumulator {
  return { sum: 0, sumSq: 0, wins: 0, n: 0 };
}

function pushStat(acc: Accumulator, value: number): void {
  acc.sum += value;
  acc.sumSq += value * value;
  if (value > 0) acc.wins += 1;
  acc.n += 1;
}

function finalizeOne(acc: Accumulator): BucketStats {
  const mean = acc.n > 0 ? acc.sum / acc.n : 0;
  const variance = acc.n > 0 ? acc.sumSq / acc.n - mean * mean : 0;
  return {
    n: acc.n,
    mean_r_raw: round4(mean),
    win_prob: round4(acc.n > 0 ? acc.wins / acc.n : 0),
    std_r_raw: round4(Math.sqrt(Math.max(0, variance))),
  };
}

function finalizeBuckets(acc: Record<string, Accumulator>): Record<string, BucketStats> {
  const output: Record<string, BucketStats> = {};
  for (const [key, value] of Object.entries(acc)) {
    output[key] = finalizeOne(value);
  }
  return output;
}

function buildPartialKey(
  direction: 'long' | 'short',
  bins: Record<ExpectancyDimension, number | null>,
  dropped: Set<ExpectancyDimension>,
): string | null {
  const dims: Partial<Record<ExpectancyDimension, number>> = {};
  for (const dim of ['z_ema9', 'pullback_ratio', 'z_ofi_blend'] as const) {
    if (dropped.has(dim)) continue;
    const bin = bins[dim];
    if (bin === null) return null;
    dims[dim] = bin;
  }
  return buildBucketKey(direction, dims);
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
