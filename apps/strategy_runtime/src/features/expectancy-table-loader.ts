import { existsSync, readFileSync } from 'node:fs';
import {
  EXPECTANCY_BACKOFF_ORDER,
  EXPECTANCY_ENGINE_SCHEMA_VERSION,
  MIN_BUCKET_SAMPLES,
  PULLBACK_RATIO_BIN_EDGES,
  Z_EMA9_BIN_EDGES,
  Z_OFI_BLEND_BIN_EDGES,
  type ExpectancyBucketTable,
} from './expectancy-engine.js';

export type LoadStatus =
  | 'loaded'
  | 'insufficient_data'
  | 'file_missing'
  | 'parse_error'
  | 'schema_version_mismatch'
  | 'dimensions_mismatch'
  | 'backoff_order_mismatch'
  | 'bin_edges_mismatch'
  | 'horizon_mismatch'
  | 'structure_invalid'
  | 'symbol_mismatch';

export const MIN_SOURCE_ROWS = 200;
export const MIN_SIDE_ROWS = 10;
export const MIN_BACKOFF_BUCKET_N = 10;

export interface LoadResult {
  status: LoadStatus;
  path: string;
  table: ExpectancyBucketTable | null;
  detail: string;
  provenance: {
    source_row_count: number | null;
    generated_at: string | null;
    schema_version_on_disk: string | null;
    resolved_bucket_count_full: number | null;
    resolved_bucket_count_backoff_1d: number | null;
    resolved_bucket_count_backoff_2d: number | null;
    side_prior_long_n: number | null;
    side_prior_short_n: number | null;
  };
}

function emptyProvenance(): LoadResult['provenance'] {
  return {
    source_row_count: null,
    generated_at: null,
    schema_version_on_disk: null,
    resolved_bucket_count_full: null,
    resolved_bucket_count_backoff_1d: null,
    resolved_bucket_count_backoff_2d: null,
    side_prior_long_n: null,
    side_prior_short_n: null,
  };
}

function arraysEqualNumeric(a: unknown, b: number[], epsilon = 1e-6): boolean {
  return Array.isArray(a)
    && a.length === b.length
    && a.every((value, index) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value - b[index]!) <= epsilon);
}

function arraysEqualString(a: unknown, b: readonly string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((value, index) => value === b[index]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function loadExpectancyBucketTable(path: string, expectedSymbol?: string): LoadResult {
  if (!existsSync(path)) {
    return {
      status: 'file_missing',
      path,
      table: null,
      detail: `Bucket table file not found at ${path}`,
      provenance: emptyProvenance(),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      status: 'parse_error',
      path,
      table: null,
      detail: `Failed to read or parse bucket table: ${error instanceof Error ? error.message : String(error)}`,
      provenance: emptyProvenance(),
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      status: 'structure_invalid',
      path,
      table: null,
      detail: 'Bucket table root is not a JSON object.',
      provenance: emptyProvenance(),
    };
  }

  const provenance: LoadResult['provenance'] = {
    source_row_count: typeof parsed.source_row_count === 'number' ? parsed.source_row_count : null,
    generated_at: typeof parsed.generated_at === 'string' ? parsed.generated_at : null,
    schema_version_on_disk: typeof parsed.schema_version === 'string' ? parsed.schema_version : null,
    resolved_bucket_count_full: null,
    resolved_bucket_count_backoff_1d: null,
    resolved_bucket_count_backoff_2d: null,
    side_prior_long_n: null,
    side_prior_short_n: null,
  };

  if (expectedSymbol && typeof parsed.symbol_filter === 'string' && parsed.symbol_filter !== expectedSymbol) {
    return {
      status: 'symbol_mismatch',
      path,
      table: null,
      detail: `Bucket table symbol_filter '${parsed.symbol_filter}' does not match expected symbol '${expectedSymbol}'.`,
      provenance,
    };
  }
  if (parsed.schema_version !== EXPECTANCY_ENGINE_SCHEMA_VERSION) {
    return {
      status: 'schema_version_mismatch',
      path,
      table: null,
      detail: `Bucket table schema_version '${String(parsed.schema_version)}' does not match '${EXPECTANCY_ENGINE_SCHEMA_VERSION}'.`,
      provenance,
    };
  }
  if (!arraysEqualString(parsed.dimensions, ['z_ema9', 'pullback_ratio', 'z_ofi_blend'])) {
    return {
      status: 'dimensions_mismatch',
      path,
      table: null,
      detail: 'Bucket table dimensions do not match the runtime engine.',
      provenance,
    };
  }
  if (!arraysEqualString(parsed.backoff_order, EXPECTANCY_BACKOFF_ORDER)) {
    return {
      status: 'backoff_order_mismatch',
      path,
      table: null,
      detail: 'Bucket table backoff order does not match the runtime engine.',
      provenance,
    };
  }
  if (!arraysEqualNumeric(parsed.z_ema9_bin_edges, Z_EMA9_BIN_EDGES)
    || !arraysEqualNumeric(parsed.pullback_ratio_bin_edges, PULLBACK_RATIO_BIN_EDGES)
    || !arraysEqualNumeric(parsed.z_ofi_blend_bin_edges, Z_OFI_BLEND_BIN_EDGES)) {
    return {
      status: 'bin_edges_mismatch',
      path,
      table: null,
      detail: 'Bucket table bin edges do not match the runtime engine.',
      provenance,
    };
  }
  if (parsed.horizon_sec !== 30) {
    return {
      status: 'horizon_mismatch',
      path,
      table: null,
      detail: `Bucket table horizon_sec=${String(parsed.horizon_sec)}, expected 30.`,
      provenance,
    };
  }

  for (const key of ['buckets_full', 'buckets_backoff_1d', 'buckets_backoff_2d', 'side_prior']) {
    if (!isPlainObject(parsed[key])) {
      return {
        status: 'structure_invalid',
        path,
        table: null,
        detail: `Bucket table is missing or has invalid '${key}'.`,
        provenance,
      };
    }
  }

  const full = parsed.buckets_full as Record<string, unknown>;
  const backoff1d = parsed.buckets_backoff_1d as Record<string, unknown>;
  const backoff2d = parsed.buckets_backoff_2d as Record<string, unknown>;
  const sidePrior = parsed.side_prior as Record<string, unknown>;

  provenance.resolved_bucket_count_full = Object.keys(full).length;
  provenance.resolved_bucket_count_backoff_1d = Object.keys(backoff1d).length;
  provenance.resolved_bucket_count_backoff_2d = Object.keys(backoff2d).length;
  provenance.side_prior_long_n = isPlainObject(sidePrior.long) && typeof sidePrior.long.n === 'number'
    ? sidePrior.long.n
    : null;
  provenance.side_prior_short_n = isPlainObject(sidePrior.short) && typeof sidePrior.short.n === 'number'
    ? sidePrior.short.n
    : null;

  const reasons: string[] = [];
  const sourceRows = provenance.source_row_count ?? 0;
  if (sourceRows < MIN_SOURCE_ROWS) reasons.push(`source_row_count=${sourceRows} < ${MIN_SOURCE_ROWS}`);
  if ((provenance.side_prior_long_n ?? 0) < MIN_SIDE_ROWS) reasons.push(`long_side_n=${provenance.side_prior_long_n ?? 0} < ${MIN_SIDE_ROWS}`);
  if ((provenance.side_prior_short_n ?? 0) < MIN_SIDE_ROWS) reasons.push(`short_side_n=${provenance.side_prior_short_n ?? 0} < ${MIN_SIDE_ROWS}`);
  if ((provenance.resolved_bucket_count_full ?? 0) === 0 && allBackoffBucketsTiny(backoff1d, backoff2d)) {
    reasons.push(`no full buckets and all backoff buckets have n < ${MIN_BACKOFF_BUCKET_N}`);
  }

  if (reasons.length > 0) {
    return {
      status: 'insufficient_data',
      path,
      table: parsed as unknown as ExpectancyBucketTable,
      detail: `Bucket table loaded but insufficient for execution: ${reasons.join('; ')}.`,
      provenance,
    };
  }

  return {
    status: 'loaded',
    path,
    table: parsed as unknown as ExpectancyBucketTable,
    detail: `Loaded bucket table: ${sourceRows} training rows, ${(provenance.resolved_bucket_count_full ?? 0)} full buckets, ${(provenance.resolved_bucket_count_backoff_1d ?? 0)} 1d, ${(provenance.resolved_bucket_count_backoff_2d ?? 0)} 2d.`,
    provenance,
  };
}

function allBackoffBucketsTiny(
  backoff1d: Record<string, unknown>,
  backoff2d: Record<string, unknown>,
): boolean {
  const hasLargeBucket = (input: Record<string, unknown>): boolean =>
    Object.values(input).some((value) => isPlainObject(value) && typeof value.n === 'number' && value.n >= MIN_BACKOFF_BUCKET_N);
  return !hasLargeBucket(backoff1d) && !hasLargeBucket(backoff2d);
}
