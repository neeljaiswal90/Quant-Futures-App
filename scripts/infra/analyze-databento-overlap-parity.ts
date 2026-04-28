#!/usr/bin/env tsx

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  argv as processArgv,
  exit as processExit,
  stderr as processStderr,
  stdout as processStdout,
} from 'node:process';
import { fileURLToPath } from 'node:url';
import { stableJsonStringify, type JsonValue } from '../../apps/strategy_runtime/src/contracts/index.js';
import { forEachJsonlLine } from './jsonl.js';

export const DATABENTO_OVERLAP_PARITY_SCHEMA_VERSION = 1 as const;

export type BookSide = 'bid' | 'ask';

export interface BookLevel {
  readonly level: number;
  readonly px: number;
  readonly sz: number;
  readonly order_count: number | null;
}

export interface BookSample {
  readonly ts_ns: string;
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
  readonly source_record_index: number;
}

export interface RithmicMbp10ReconstructionResult {
  readonly samples: readonly BookSample[];
  readonly report: RithmicMbp10ReconstructionReport;
}

export interface RithmicMbp10ReconstructionReport {
  readonly row_count: number;
  readonly mbp10_row_count: number;
  readonly null_timestamp_rows_count: number;
  readonly null_timestamp_seed_rows_count: number;
  readonly null_timestamp_non_seed_rows_count: number;
  readonly timestamped_update_rows_count: number;
  readonly incremental_update_rows_count: number;
  readonly bid_only_update_rows_count: number;
  readonly ask_only_update_rows_count: number;
  readonly both_sides_update_rows_count: number;
  readonly no_level_update_rows_count: number;
  readonly reconstructed_book_sample_count: number;
  readonly first_sample_ts_ns: string | null;
  readonly last_sample_ts_ns: string | null;
}

export interface DatabentoMbp10NormalizationResult {
  readonly samples: readonly BookSample[];
  readonly report: DatabentoMbp10NormalizationReport;
}

export interface DatabentoMbp10NormalizationReport {
  readonly row_count: number;
  readonly valid_sample_count: number;
  readonly missing_timestamp_rows_count: number;
  readonly no_level_rows_count: number;
  readonly first_sample_ts_ns: string | null;
  readonly last_sample_ts_ns: string | null;
}

export interface DatabentoOverlapParityReport {
  readonly schema_version: typeof DATABENTO_OVERLAP_PARITY_SCHEMA_VERSION;
  readonly ticket_id: 'DATABENTO-OVERLAP-PARITY';
  readonly status: 'analysis_only';
  readonly data01_eligible: false;
  readonly data01_route: 'blocked_pending_infra01_verification';
  readonly inputs: {
    readonly rithmic_probe_path: string;
    readonly databento_mbp10_path: string;
    readonly databento_mbp1_path: string | null;
  };
  readonly rithmic_mbp10_reconstruction: RithmicMbp10ReconstructionReport;
  readonly databento_mbp10_samples: DatabentoMbp10NormalizationReport;
  readonly mbp10_parity: Mbp10ParityComparisonReport;
  readonly mbp10_component_parity: Mbp10ComponentParityReport;
  readonly mbp10_temporal_alignment: Mbp10TemporalAlignmentReport;
  readonly bbo_triangulation: BboTriangulationReport;
  readonly recommendation: {
    readonly summary: string;
    readonly requires_reviewer_decision: true;
    readonly databento_parity_status_for_infra01b: 'pending';
    readonly notes: readonly string[];
  };
}

export interface Mbp10ParityComparisonReport {
  readonly comparison_rule: 'latest_rithmic_state_at_or_before_databento_ts_event';
  readonly databento_sample_count: number;
  readonly compared_sample_count: number;
  readonly unmatched_databento_sample_count: number;
  readonly top_of_book: FieldParitySummary;
  readonly depth_levels: FieldParitySummary;
  readonly mismatches_by_side_level: Readonly<Record<string, number>>;
  readonly first_mismatches: readonly BookMismatch[];
  readonly mismatches_truncated: boolean;
}

export interface FieldParitySummary {
  readonly comparable_field_count: number;
  readonly matching_field_count: number;
  readonly mismatch_count: number;
  readonly missing_rithmic_level_count: number;
  readonly missing_databento_level_count: number;
}

export interface BookMismatch {
  readonly databento_ts_ns: string;
  readonly rithmic_ts_ns: string;
  readonly side: BookSide;
  readonly level: number;
  readonly field: 'px' | 'sz' | 'order_count';
  readonly rithmic_value: number | null;
  readonly databento_value: number | null;
}

export type Mbp10ComponentParityClassification =
  | 'size_order_count_semantics_mismatch'
  | 'price_level_reconstruction_mismatch'
  | 'book_depth_presence_mismatch'
  | 'mbp10_parity_component_pass'
  | 'inconclusive_component_mismatch';

export interface Mbp10ComponentParityReport {
  readonly compared_samples: number;
  readonly top_of_book: Mbp10TopOfBookComponentParity;
  readonly depth_by_level: readonly Mbp10DepthLevelComponentParity[];
  readonly mismatch_breakdown: Mbp10ComponentMismatchBreakdown;
  readonly first_mismatches: Mbp10ComponentFirstMismatches;
  readonly classification: Mbp10ComponentParityClassification;
  readonly recommendation: string;
}

export interface Mbp10TopOfBookComponentParity {
  readonly bid_price_within_1_tick_pct: number | null;
  readonly ask_price_within_1_tick_pct: number | null;
  readonly both_sides_price_within_1_tick_pct: number | null;
  readonly bid_size_exact_match_pct: number | null;
  readonly ask_size_exact_match_pct: number | null;
  readonly bid_order_count_exact_match_pct: number | null;
  readonly ask_order_count_exact_match_pct: number | null;
  readonly bid_missing_order_count_count: number;
  readonly ask_missing_order_count_count: number;
  readonly top_bid_size_abs_delta: DeltaDistributionSummary;
  readonly top_ask_size_abs_delta: DeltaDistributionSummary;
}

export interface Mbp10DepthLevelComponentParity {
  readonly level: number;
  readonly side: BookSide;
  readonly compared_count: number;
  readonly both_present_count: number;
  readonly price_within_1_tick_pct: number | null;
  readonly exact_price_match_pct: number | null;
  readonly size_exact_match_pct: number | null;
  readonly size_abs_delta_p50: number | null;
  readonly size_abs_delta_p95: number | null;
  readonly size_abs_delta_p99: number | null;
  readonly size_relative_delta_p50: number | null;
  readonly size_relative_delta_p95: number | null;
  readonly size_relative_delta_p99: number | null;
  readonly order_count_exact_match_pct: number | null;
  readonly order_count_abs_delta_p50: number | null;
  readonly order_count_abs_delta_p95: number | null;
  readonly order_count_abs_delta_p99: number | null;
  readonly missing_order_count_count: number;
  readonly presence_match_pct: number | null;
}

export interface DeltaDistributionSummary {
  readonly count: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
}

export interface Mbp10ComponentMismatchBreakdown {
  readonly price_only_mismatch_count: number;
  readonly size_only_mismatch_count: number;
  readonly order_count_only_mismatch_count: number;
  readonly price_and_size_mismatch_count: number;
  readonly missing_level_count: number;
  readonly mixed_component_mismatch_count: number;
}

export interface Mbp10ComponentFirstMismatches {
  readonly price_mismatches: readonly Mbp10ComponentMismatchExample[];
  readonly size_mismatches: readonly Mbp10ComponentMismatchExample[];
  readonly order_count_mismatches: readonly Mbp10ComponentMismatchExample[];
  readonly level_presence_mismatches: readonly Mbp10ComponentMismatchExample[];
}

export interface Mbp10ComponentMismatchExample {
  readonly exchange_event_ts_ns: string;
  readonly rithmic_ts_ns: string;
  readonly side: BookSide;
  readonly level: number;
  readonly rithmic_px: number | null;
  readonly rithmic_size: number | null;
  readonly rithmic_order_count: number | null;
  readonly databento_px: number | null;
  readonly databento_size: number | null;
  readonly databento_order_count: number | null;
  readonly price_delta: number | null;
  readonly size_delta: number | null;
  readonly order_count_delta: number | null;
  readonly nearest_l1_quote: null;
  readonly classification:
    | 'price_mismatch'
    | 'size_mismatch'
    | 'order_count_mismatch'
    | 'level_presence_mismatch';
}

export type Mbp10LookupPolicy = 'previous_or_equal' | 'nearest' | 'next_or_equal' | 'midpoint_bucketed';

export type Mbp10TimestampBasis = 'ts_event' | 'ts_recv' | 'unavailable';

export type Mbp10TemporalAlignmentClassification =
  | 'temporal_alignment_offset_required'
  | 'sampling_policy_mismatch'
  | 'timestamp_basis_mismatch'
  | 'persistent_price_level_reconstruction_mismatch';

export interface Mbp10TemporalAlignmentReport {
  readonly lookup_policy_scores: Readonly<Record<Mbp10LookupPolicy, Mbp10TemporalPolicyScore>>;
  readonly lag_scan_scores: readonly Mbp10LagScanScore[];
  readonly timestamp_basis_scores: {
    readonly ts_event: Mbp10TemporalPolicyScore;
    readonly ts_recv: Mbp10TemporalPolicyScore | null;
    readonly ts_recv_available: boolean;
  };
  readonly best_offset_ms: number;
  readonly best_lookup_policy: Mbp10LookupPolicy;
  readonly best_timestamp_basis: Mbp10TimestampBasis;
  readonly mismatch_clusters: Mbp10MismatchClusterReport;
  readonly bbo_cross_checks: Mbp10BboCrossCheckReport;
  readonly classification: Mbp10TemporalAlignmentClassification;
  readonly recommendation: string;
}

export interface Mbp10TemporalPolicyScore {
  readonly lookup_policy: Mbp10LookupPolicy;
  readonly timestamp_basis: Mbp10TimestampBasis;
  readonly offset_ms: number;
  readonly compared_samples: number;
  readonly unmatched_samples: number;
  readonly bid_top_price_within_1_tick_pct: number | null;
  readonly ask_top_price_within_1_tick_pct: number | null;
  readonly both_sides_top_price_within_1_tick_pct: number | null;
  readonly depth_price_within_1_tick_pct: number | null;
  readonly bid_top_size_exact_match_pct: number | null;
  readonly ask_top_size_exact_match_pct: number | null;
  readonly bid_top_order_count_exact_match_pct: number | null;
  readonly ask_top_order_count_exact_match_pct: number | null;
}

export interface Mbp10LagScanScore extends Mbp10TemporalPolicyScore {
  readonly offset_ms: number;
}

export interface Mbp10MismatchClusterReport {
  readonly basis: 'previous_or_equal_ts_event_offset_0';
  readonly price_mismatch_sample_count: number;
  readonly price_match_sample_count: number;
  readonly max_consecutive_mismatch_run: number;
  readonly first_clusters: readonly Mbp10MismatchCluster[];
  readonly mismatch_rate_per_minute: readonly Mbp10MinuteMismatchRate[];
  readonly volatile_period_correlation: {
    readonly status: 'not_available';
    readonly reason: string;
  };
}

export interface Mbp10MismatchCluster {
  readonly start_ts_ns: string;
  readonly end_ts_ns: string;
  readonly sample_count: number;
}

export interface Mbp10MinuteMismatchRate {
  readonly bucket_start_ts_ns: string;
  readonly compared_samples: number;
  readonly price_mismatch_samples: number;
  readonly mismatch_rate_pct: number | null;
}

export interface Mbp10BboCrossCheckReport {
  readonly rithmic_l1_quote_vs_databento_mbp1: UnavailableCrossCheck | Mbp10TemporalPolicyScore;
  readonly rithmic_mbp10_top_vs_databento_mbp1: UnavailableCrossCheck | Mbp10TemporalPolicyScore;
  readonly rithmic_mbp10_top_vs_databento_mbp10: Mbp10TemporalPolicyScore;
}

export interface UnavailableCrossCheck {
  readonly status: 'not_available';
  readonly reason: string;
}

export type BboTriangulationClassification =
  | 'rithmic_mbp10_extraction_issue'
  | 'databento_mbp10_normalization_issue'
  | 'l1_cross_source_alignment_issue'
  | 'mbp10_depth_semantics_issue'
  | 'inconclusive';

export type BboComparisonId =
  | 'rithmic_l1_quote_vs_databento_mbp1'
  | 'rithmic_mbp10_top_vs_rithmic_l1_quote'
  | 'databento_mbp10_top_vs_databento_mbp1'
  | 'rithmic_mbp10_top_vs_databento_mbp10';

export interface BboTriangulationReport {
  readonly status: 'analysis_only';
  readonly data01b_eligible: false;
  readonly comparisons: Readonly<Record<BboComparisonId, BboTriangulationComparisonReport | UnavailableCrossCheck>>;
  readonly classification: BboTriangulationClassification;
  readonly recommendation: string;
}

export interface BboTriangulationComparisonReport {
  readonly status: 'available';
  readonly comparison: BboComparisonId;
  readonly source: string;
  readonly target: string;
  readonly best_lookup_policy: Mbp10LookupPolicy;
  readonly compared_samples: number;
  readonly unmatched_samples: number;
  readonly bid_price_within_1_tick_pct: number | null;
  readonly ask_price_within_1_tick_pct: number | null;
  readonly both_sides_within_1_tick_pct: number | null;
  readonly bid_size_exact_match_pct: number | null;
  readonly ask_size_exact_match_pct: number | null;
  readonly lookup_policy_scores: Readonly<Record<Mbp10LookupPolicy, BboTriangulationScore>>;
  readonly first_mismatches: readonly BboTriangulationMismatchExample[];
  readonly mismatch_rate_by_minute: readonly BboTriangulationMinuteMismatchRate[];
}

export interface BboTriangulationScore {
  readonly lookup_policy: Mbp10LookupPolicy;
  readonly compared_samples: number;
  readonly unmatched_samples: number;
  readonly bid_price_within_1_tick_pct: number | null;
  readonly ask_price_within_1_tick_pct: number | null;
  readonly both_sides_within_1_tick_pct: number | null;
  readonly bid_size_exact_match_pct: number | null;
  readonly ask_size_exact_match_pct: number | null;
}

export interface BboTriangulationMismatchExample {
  readonly exchange_event_ts_ns: string;
  readonly source_ts_ns: string;
  readonly side: BookSide;
  readonly source_px: number | null;
  readonly source_size: number | null;
  readonly source_order_count: number | null;
  readonly target_px: number | null;
  readonly target_size: number | null;
  readonly target_order_count: number | null;
  readonly price_delta: number | null;
  readonly size_delta: number | null;
  readonly order_count_delta: number | null;
  readonly classification: 'price_mismatch' | 'size_mismatch' | 'order_count_mismatch' | 'missing_side';
}

export interface BboTriangulationMinuteMismatchRate {
  readonly bucket_start_ts_ns: string;
  readonly compared_samples: number;
  readonly price_mismatch_samples: number;
  readonly mismatch_rate_pct: number | null;
}

interface CliArgs {
  readonly rithmic_probe_path: string;
  readonly databento_mbp10_path: string;
  readonly databento_mbp1_path: string | null;
  readonly out_path: string;
}

interface BookState {
  // Rithmic OrderBook updates are keyed by price level; depth level is derived after sorting.
  readonly bids: Map<number, BookLevel>;
  readonly asks: Map<number, BookLevel>;
}

interface ParsedRithmicMbp10Row {
  readonly record_index: number;
  readonly ts_ns: string | null;
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
}

type TimestampedParsedRithmicMbp10Row = ParsedRithmicMbp10Row & { readonly ts_ns: string };

interface RithmicMbp10UpdateSet {
  readonly seed_state: BookState;
  readonly updates: readonly TimestampedParsedRithmicMbp10Row[];
  readonly report: RithmicMbp10ReconstructionReport;
}

interface RithmicTopOfBookSnapshotIndex {
  readonly ts_ns: BigInt64Array;
  readonly bid_px: Float64Array;
  readonly ask_px: Float64Array;
  readonly bid_sz: Int32Array;
  readonly ask_sz: Int32Array;
  readonly bid_order_count: Int32Array;
  readonly ask_order_count: Int32Array;
}

interface BboSnapshotIndex {
  readonly ts_ns: BigInt64Array;
  readonly bid_px: Float64Array;
  readonly ask_px: Float64Array;
  readonly bid_sz: Int32Array;
  readonly ask_sz: Int32Array;
  readonly bid_order_count: Int32Array;
  readonly ask_order_count: Int32Array;
}

interface StreamingDatabentoMbp10ParityResult {
  readonly databento_report: DatabentoMbp10NormalizationReport;
  readonly parity_report: Mbp10ParityComparisonReport;
  readonly component_report: Mbp10ComponentParityReport;
  readonly temporal_report: Mbp10TemporalAlignmentReport;
}

const DEFAULT_REPORT_PATH = 'reports/infra/databento_overlap_parity_report.json';
const MAX_DEPTH_LEVEL = 9;
const MISMATCH_LIMIT = 50;
const MNQ_TICK_SIZE = 0.25;
const TEMPORAL_LAG_SCAN_OFFSETS_MS = [-500, -250, -100, -50, -25, -10, -5, 0, 5, 10, 25, 50, 100, 250, 500] as const;

export function reconstructRithmicMbp10FromRecords(
  records: readonly unknown[],
): RithmicMbp10ReconstructionResult {
  const state: BookState = {
    bids: new Map<number, BookLevel>(),
    asks: new Map<number, BookLevel>(),
  };
  const samples: BookSample[] = [];
  let mbp10RowCount = 0;
  let nullTimestampRowsCount = 0;
  let nullTimestampSeedRowsCount = 0;
  let timestampedUpdateRowsCount = 0;
  let incrementalUpdateRowsCount = 0;
  let bidOnlyUpdateRowsCount = 0;
  let askOnlyUpdateRowsCount = 0;
  let bothSidesUpdateRowsCount = 0;
  let noLevelUpdateRowsCount = 0;
  const timestampedRows: TimestampedParsedRithmicMbp10Row[] = [];

  records.forEach((record, index) => {
    if (!isMbp10Record(record)) {
      return;
    }

    mbp10RowCount += 1;
    const row = normalizeRithmicMbp10Row(record, index + 1);
    const hasBidLevels = row.bids.length > 0;
    const hasAskLevels = row.asks.length > 0;
    const hasAnyLevel = hasBidLevels || hasAskLevels;

    if (row.ts_ns === null) {
      nullTimestampRowsCount += 1;
      if (hasAnyLevel) {
        nullTimestampSeedRowsCount += 1;
        applyBookUpdate(state, row);
      }
      return;
    }

    timestampedUpdateRowsCount += 1;
    if (!hasAnyLevel) {
      noLevelUpdateRowsCount += 1;
      return;
    }

    incrementalUpdateRowsCount += 1;
    if (hasBidLevels && hasAskLevels) {
      bothSidesUpdateRowsCount += 1;
    } else if (hasBidLevels) {
      bidOnlyUpdateRowsCount += 1;
    } else {
      askOnlyUpdateRowsCount += 1;
    }

    timestampedRows.push({ ...row, ts_ns: row.ts_ns });
  });

  for (const row of timestampedRows.sort(compareParsedRithmicRowsByTimestamp)) {
    applyBookUpdate(state, row);
    samples.push(stateToSample(state, row.ts_ns, row.record_index));
  }

  const firstSample = samples[0];
  const lastSample = samples[samples.length - 1];

  return {
    samples,
    report: {
      row_count: records.length,
      mbp10_row_count: mbp10RowCount,
      null_timestamp_rows_count: nullTimestampRowsCount,
      null_timestamp_seed_rows_count: nullTimestampSeedRowsCount,
      null_timestamp_non_seed_rows_count: nullTimestampRowsCount - nullTimestampSeedRowsCount,
      timestamped_update_rows_count: timestampedUpdateRowsCount,
      incremental_update_rows_count: incrementalUpdateRowsCount,
      bid_only_update_rows_count: bidOnlyUpdateRowsCount,
      ask_only_update_rows_count: askOnlyUpdateRowsCount,
      both_sides_update_rows_count: bothSidesUpdateRowsCount,
      no_level_update_rows_count: noLevelUpdateRowsCount,
      reconstructed_book_sample_count: samples.length,
      first_sample_ts_ns: firstSample?.ts_ns ?? null,
      last_sample_ts_ns: lastSample?.ts_ns ?? null,
    },
  };
}

function compareParsedRithmicRowsByTimestamp(
  left: TimestampedParsedRithmicMbp10Row,
  right: TimestampedParsedRithmicMbp10Row,
): number {
  const ts = compareDecimalIntegerStrings(left.ts_ns, right.ts_ns);
  if (ts !== 0) return ts;
  return left.record_index - right.record_index;
}

export function normalizeDatabentoMbp10FromRecords(
  records: readonly unknown[],
): DatabentoMbp10NormalizationResult {
  const samples: BookSample[] = [];
  let missingTimestampRowsCount = 0;
  let noLevelRowsCount = 0;

  records.forEach((record, index) => {
    if (!isRecord(record)) {
      throw new Error(`Databento line ${index + 1}: JSON value must be an object`);
    }

    const tsNs = optionalDecimalString(record, ['ts_event_ns', 'ts_event', 'exchange_event_ts_ns']);
    if (tsNs === null) {
      missingTimestampRowsCount += 1;
      return;
    }

    const bids = normalizeDatabentoSide(record, 'bid');
    const asks = normalizeDatabentoSide(record, 'ask');
    if (bids.length === 0 && asks.length === 0) {
      noLevelRowsCount += 1;
      return;
    }

    samples.push({
      ts_ns: tsNs,
      bids,
      asks,
      source_record_index: index + 1,
    });
  });

  const sortedSamples = sortSamplesByTimestamp(samples);
  const firstSample = sortedSamples[0];
  const lastSample = sortedSamples[sortedSamples.length - 1];

  return {
    samples: sortedSamples,
    report: {
      row_count: records.length,
      valid_sample_count: sortedSamples.length,
      missing_timestamp_rows_count: missingTimestampRowsCount,
      no_level_rows_count: noLevelRowsCount,
      first_sample_ts_ns: firstSample?.ts_ns ?? null,
      last_sample_ts_ns: lastSample?.ts_ns ?? null,
    },
  };
}

export function compareMbp10Samples(
  rithmicSamples: readonly BookSample[],
  databentoSamples: readonly BookSample[],
): Mbp10ParityComparisonReport {
  const sortedRithmic = sortSamplesByTimestamp(rithmicSamples);
  const sortedDatabento = sortSamplesByTimestamp(databentoSamples);
  const topOfBook = emptyFieldParitySummary();
  const depthLevels = emptyFieldParitySummary();
  const mismatchesBySideLevel: Record<string, number> = {};
  const firstMismatches: BookMismatch[] = [];
  let comparedSampleCount = 0;
  let unmatchedDatabentoSampleCount = 0;
  let rithmicIndex = -1;

  for (const databentoSample of sortedDatabento) {
    while (
      rithmicIndex + 1 < sortedRithmic.length &&
      compareDecimalIntegerStrings(sortedRithmic[rithmicIndex + 1]!.ts_ns, databentoSample.ts_ns) <= 0
    ) {
      rithmicIndex += 1;
    }

    if (rithmicIndex < 0) {
      unmatchedDatabentoSampleCount += 1;
      continue;
    }

    comparedSampleCount += 1;
    const rithmicSample = sortedRithmic[rithmicIndex]!;
    compareSamplePair({
      rithmicSample,
      databentoSample,
      topOfBook,
      depthLevels,
      mismatchesBySideLevel,
      firstMismatches,
    });
  }

  return {
    comparison_rule: 'latest_rithmic_state_at_or_before_databento_ts_event',
    databento_sample_count: sortedDatabento.length,
    compared_sample_count: comparedSampleCount,
    unmatched_databento_sample_count: unmatchedDatabentoSampleCount,
    top_of_book: finalizeFieldParitySummary(topOfBook),
    depth_levels: finalizeFieldParitySummary(depthLevels),
    mismatches_by_side_level: sortRecordByKey(mismatchesBySideLevel),
    first_mismatches: firstMismatches,
    mismatches_truncated: totalMismatchCount(mismatchesBySideLevel) > firstMismatches.length,
  };
}

export function analyzeDatabentoOverlapParity(options: {
  readonly rithmic_probe_path: string;
  readonly databento_mbp10_path: string;
  readonly databento_mbp1_path?: string | null;
}): DatabentoOverlapParityReport {
  const rithmicPath = resolve(options.rithmic_probe_path);
  const databentoPath = resolve(options.databento_mbp10_path);
  const databentoMbp1Path = options.databento_mbp1_path ? resolve(options.databento_mbp1_path) : null;
  const rithmic = readRithmicMbp10Updates(rithmicPath);
  const databento = compareDatabentoMbp10JsonlWithRithmicUpdates(databentoPath, rithmic);
  const bboTriangulation = databentoMbp1Path === null
    ? unavailableBboTriangulation('No normalized Databento MBP-1 input path was provided.')
    : analyzeBboTriangulation({
      rithmic_probe_path: rithmicPath,
      databento_mbp10_path: databentoPath,
      databento_mbp1_path: databentoMbp1Path,
      rithmic,
    });

  return {
    schema_version: DATABENTO_OVERLAP_PARITY_SCHEMA_VERSION,
    ticket_id: 'DATABENTO-OVERLAP-PARITY',
    status: 'analysis_only',
    data01_eligible: false,
    data01_route: 'blocked_pending_infra01_verification',
    inputs: {
      rithmic_probe_path: rithmicPath,
      databento_mbp10_path: databentoPath,
      databento_mbp1_path: databentoMbp1Path,
    },
    rithmic_mbp10_reconstruction: rithmic.report,
    databento_mbp10_samples: databento.databento_report,
    mbp10_parity: databento.parity_report,
    mbp10_component_parity: databento.component_report,
    mbp10_temporal_alignment: databento.temporal_report,
    bbo_triangulation: bboTriangulation,
    recommendation: {
      summary:
        'Use reconstructed Rithmic MBP10 state for Databento MBP10 comparison; keep DATA-01 blocked until parity is reviewed and INFRA-01 verification explicitly routes to DATA-01.',
      requires_reviewer_decision: true,
      databento_parity_status_for_infra01b: 'pending',
      notes: [
        'Rithmic MBP10 rows are treated as incremental level updates, not full snapshots.',
        'Rows with null exchange_event_ts_ns are excluded from timestamp parity and counted separately; usable book rows may seed state.',
        'This analysis is evidence only and does not modify the INFRA-01B pass/fail gate.',
      ],
    },
  };
}

function readRithmicMbp10Updates(path: string): RithmicMbp10UpdateSet {
  const seedState: BookState = emptyBookState();
  const updates: TimestampedParsedRithmicMbp10Row[] = [];
  let rowCount = 0;
  let mbp10RowCount = 0;
  let nullTimestampRowsCount = 0;
  let nullTimestampSeedRowsCount = 0;
  let timestampedUpdateRowsCount = 0;
  let incrementalUpdateRowsCount = 0;
  let bidOnlyUpdateRowsCount = 0;
  let askOnlyUpdateRowsCount = 0;
  let bothSidesUpdateRowsCount = 0;
  let noLevelUpdateRowsCount = 0;

  forEachJsonlLine(path, (trimmed, lineNumber) => {
    rowCount += 1;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `Rithmic probe line ${lineNumber}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!isMbp10Record(record)) {
      return;
    }

    mbp10RowCount += 1;
    const row = normalizeRithmicMbp10Row(record, lineNumber);
    const hasBidLevels = row.bids.length > 0;
    const hasAskLevels = row.asks.length > 0;
    const hasAnyLevel = hasBidLevels || hasAskLevels;

    if (row.ts_ns === null) {
      nullTimestampRowsCount += 1;
      if (hasAnyLevel) {
        nullTimestampSeedRowsCount += 1;
        applyBookUpdate(seedState, row);
      }
      return;
    }

    timestampedUpdateRowsCount += 1;
    if (!hasAnyLevel) {
      noLevelUpdateRowsCount += 1;
      return;
    }

    incrementalUpdateRowsCount += 1;
    if (hasBidLevels && hasAskLevels) {
      bothSidesUpdateRowsCount += 1;
    } else if (hasBidLevels) {
      bidOnlyUpdateRowsCount += 1;
    } else {
      askOnlyUpdateRowsCount += 1;
    }

    updates.push({ ...row, ts_ns: row.ts_ns });
  });

  updates.sort(compareParsedRithmicRowsByTimestamp);
  const firstUpdate = updates[0];
  const lastUpdate = updates[updates.length - 1];

  return {
    seed_state: seedState,
    updates,
    report: {
      row_count: rowCount,
      mbp10_row_count: mbp10RowCount,
      null_timestamp_rows_count: nullTimestampRowsCount,
      null_timestamp_seed_rows_count: nullTimestampSeedRowsCount,
      null_timestamp_non_seed_rows_count: nullTimestampRowsCount - nullTimestampSeedRowsCount,
      timestamped_update_rows_count: timestampedUpdateRowsCount,
      incremental_update_rows_count: incrementalUpdateRowsCount,
      bid_only_update_rows_count: bidOnlyUpdateRowsCount,
      ask_only_update_rows_count: askOnlyUpdateRowsCount,
      both_sides_update_rows_count: bothSidesUpdateRowsCount,
      no_level_update_rows_count: noLevelUpdateRowsCount,
      reconstructed_book_sample_count: updates.length,
      first_sample_ts_ns: firstUpdate?.ts_ns ?? null,
      last_sample_ts_ns: lastUpdate?.ts_ns ?? null,
    },
  };
}

function compareDatabentoMbp10JsonlWithRithmicUpdates(
  path: string,
  rithmic: RithmicMbp10UpdateSet,
): StreamingDatabentoMbp10ParityResult {
  const temporal = analyzeTemporalAlignment(path, rithmic);
  const rithmicState = cloneBookState(rithmic.seed_state);
  const topOfBook = emptyFieldParitySummary();
  const depthLevels = emptyFieldParitySummary();
  const mismatchesBySideLevel: Record<string, number> = {};
  const firstMismatches: BookMismatch[] = [];
  const componentParity = createComponentParityAccumulator();
  let rithmicIndex = -1;
  let latestRithmicTsNs: string | null = null;
  let latestRithmicSourceRecordIndex = 0;
  let databentoRowCount = 0;
  let validDatabentoSampleCount = 0;
  let missingTimestampRowsCount = 0;
  let noLevelRowsCount = 0;
  let comparedSampleCount = 0;
  let unmatchedDatabentoSampleCount = 0;
  let firstDatabentoSampleTsNs: string | null = null;
  let lastDatabentoSampleTsNs: string | null = null;

  forEachJsonlLine(path, (trimmed, lineNumber) => {
    databentoRowCount += 1;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `Databento MBP10 line ${lineNumber}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!isRecord(record)) {
      throw new Error(`Databento line ${lineNumber}: JSON value must be an object`);
    }

    const databentoSample = normalizeDatabentoMbp10Record(record, lineNumber);
    if (databentoSample === null) {
      if (optionalDecimalString(record, ['ts_event_ns', 'ts_event', 'exchange_event_ts_ns']) === null) {
        missingTimestampRowsCount += 1;
      } else {
        noLevelRowsCount += 1;
      }
      return;
    }

    validDatabentoSampleCount += 1;
    firstDatabentoSampleTsNs ??= databentoSample.ts_ns;
    lastDatabentoSampleTsNs = databentoSample.ts_ns;

    while (
      rithmicIndex + 1 < rithmic.updates.length &&
      compareDecimalIntegerStrings(rithmic.updates[rithmicIndex + 1]!.ts_ns, databentoSample.ts_ns) <= 0
    ) {
      rithmicIndex += 1;
      const update = rithmic.updates[rithmicIndex]!;
      applyBookUpdate(rithmicState, update);
      latestRithmicTsNs = update.ts_ns;
      latestRithmicSourceRecordIndex = update.record_index;
    }

    if (latestRithmicTsNs === null) {
      unmatchedDatabentoSampleCount += 1;
      return;
    }

    comparedSampleCount += 1;
    const rithmicSample = stateToSample(rithmicState, latestRithmicTsNs, latestRithmicSourceRecordIndex);
    compareSamplePair({
      rithmicSample,
      databentoSample,
      topOfBook,
      depthLevels,
      mismatchesBySideLevel,
      firstMismatches,
    });
    updateComponentParity(componentParity, rithmicSample, databentoSample);
  });

  return {
    databento_report: {
      row_count: databentoRowCount,
      valid_sample_count: validDatabentoSampleCount,
      missing_timestamp_rows_count: missingTimestampRowsCount,
      no_level_rows_count: noLevelRowsCount,
      first_sample_ts_ns: firstDatabentoSampleTsNs,
      last_sample_ts_ns: lastDatabentoSampleTsNs,
    },
    parity_report: {
      comparison_rule: 'latest_rithmic_state_at_or_before_databento_ts_event',
      databento_sample_count: validDatabentoSampleCount,
      compared_sample_count: comparedSampleCount,
      unmatched_databento_sample_count: unmatchedDatabentoSampleCount,
      top_of_book: finalizeFieldParitySummary(topOfBook),
      depth_levels: finalizeFieldParitySummary(depthLevels),
      mismatches_by_side_level: sortRecordByKey(mismatchesBySideLevel),
      first_mismatches: firstMismatches,
      mismatches_truncated: totalMismatchCount(mismatchesBySideLevel) > firstMismatches.length,
    },
    component_report: finalizeComponentParity(componentParity),
    temporal_report: temporal,
  };
}

export function writeDatabentoOverlapParityReport(
  report: DatabentoOverlapParityReport,
  outPath: string,
): void {
  const resolved = resolve(outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${stableJsonStringify(report as unknown as JsonValue)}\n`, 'utf8');
}

export function formatDatabentoOverlapParitySummary(report: DatabentoOverlapParityReport): string {
  return [
    'Databento overlap parity analysis: analysis_only',
    `rithmic_mbp10_samples=${report.rithmic_mbp10_reconstruction.reconstructed_book_sample_count}`,
    `rithmic_seed_rows=${report.rithmic_mbp10_reconstruction.null_timestamp_seed_rows_count}`,
    `databento_mbp10_samples=${report.databento_mbp10_samples.valid_sample_count}`,
    `compared_samples=${report.mbp10_parity.compared_sample_count}`,
    `top_of_book_mismatches=${report.mbp10_parity.top_of_book.mismatch_count}`,
    `depth_mismatches=${report.mbp10_parity.depth_levels.mismatch_count}`,
    `component_classification=${report.mbp10_component_parity.classification}`,
    `top_both_sides_price_within_1_tick_pct=${report.mbp10_component_parity.top_of_book.both_sides_price_within_1_tick_pct}`,
    `top_bid_size_exact_match_pct=${report.mbp10_component_parity.top_of_book.bid_size_exact_match_pct}`,
    `top_ask_size_exact_match_pct=${report.mbp10_component_parity.top_of_book.ask_size_exact_match_pct}`,
    `temporal_classification=${report.mbp10_temporal_alignment.classification}`,
    `best_lookup_policy=${report.mbp10_temporal_alignment.best_lookup_policy}`,
    `best_offset_ms=${report.mbp10_temporal_alignment.best_offset_ms}`,
    `best_timestamp_basis=${report.mbp10_temporal_alignment.best_timestamp_basis}`,
    `bbo_triangulation_classification=${report.bbo_triangulation.classification}`,
    'DATA-01 remains blocked pending INFRA-01 verification.',
    '',
  ].join('\n');
}

function compareSamplePair(args: {
  readonly rithmicSample: BookSample;
  readonly databentoSample: BookSample;
  readonly topOfBook: MutableFieldParitySummary;
  readonly depthLevels: MutableFieldParitySummary;
  readonly mismatchesBySideLevel: Record<string, number>;
  readonly firstMismatches: BookMismatch[];
}): void {
  for (const side of ['bid', 'ask'] as const) {
    for (let level = 0; level <= MAX_DEPTH_LEVEL; level += 1) {
      const rithmicLevel = findLevel(args.rithmicSample, side, level);
      const databentoLevel = findLevel(args.databentoSample, side, level);
      compareLevel({
        rithmicSample: args.rithmicSample,
        databentoSample: args.databentoSample,
        side,
        level,
        rithmicLevel,
        databentoLevel,
        summary: args.depthLevels,
        mismatchesBySideLevel: args.mismatchesBySideLevel,
        firstMismatches: args.firstMismatches,
        recordMismatchDetails: true,
      });
      if (level === 0) {
        compareLevel({
          rithmicSample: args.rithmicSample,
          databentoSample: args.databentoSample,
          side,
          level,
          rithmicLevel,
          databentoLevel,
          summary: args.topOfBook,
          mismatchesBySideLevel: args.mismatchesBySideLevel,
          firstMismatches: args.firstMismatches,
          recordMismatchDetails: false,
        });
      }
    }
  }
}

function compareLevel(args: {
  readonly rithmicSample: BookSample;
  readonly databentoSample: BookSample;
  readonly side: BookSide;
  readonly level: number;
  readonly rithmicLevel: BookLevel | null;
  readonly databentoLevel: BookLevel | null;
  readonly summary: MutableFieldParitySummary;
  readonly mismatchesBySideLevel: Record<string, number>;
  readonly firstMismatches: BookMismatch[];
  readonly recordMismatchDetails: boolean;
}): void {
  if (args.rithmicLevel === null && args.databentoLevel === null) {
    return;
  }
  if (args.rithmicLevel === null) {
    args.summary.missing_rithmic_level_count += 1;
    return;
  }
  if (args.databentoLevel === null) {
    args.summary.missing_databento_level_count += 1;
    return;
  }

  compareField(args, 'px', args.rithmicLevel.px, args.databentoLevel.px);
  compareField(args, 'sz', args.rithmicLevel.sz, args.databentoLevel.sz);
  if (args.rithmicLevel.order_count !== null && args.databentoLevel.order_count !== null) {
    compareField(args, 'order_count', args.rithmicLevel.order_count, args.databentoLevel.order_count);
  }
}

function compareField(
  args: {
    readonly rithmicSample: BookSample;
    readonly databentoSample: BookSample;
    readonly side: BookSide;
    readonly level: number;
    readonly summary: MutableFieldParitySummary;
    readonly mismatchesBySideLevel: Record<string, number>;
    readonly firstMismatches: BookMismatch[];
    readonly recordMismatchDetails: boolean;
  },
  field: BookMismatch['field'],
  rithmicValue: number,
  databentoValue: number,
): void {
  args.summary.comparable_field_count += 1;
  if (rithmicValue === databentoValue) {
    args.summary.matching_field_count += 1;
    return;
  }

  args.summary.mismatch_count += 1;
  if (!args.recordMismatchDetails) {
    return;
  }

  const key = `${args.side}_${args.level}`;
  args.mismatchesBySideLevel[key] = (args.mismatchesBySideLevel[key] ?? 0) + 1;
  if (args.firstMismatches.length < MISMATCH_LIMIT) {
    args.firstMismatches.push({
      databento_ts_ns: args.databentoSample.ts_ns,
      rithmic_ts_ns: args.rithmicSample.ts_ns,
      side: args.side,
      level: args.level,
      field,
      rithmic_value: rithmicValue,
      databento_value: databentoValue,
    });
  }
}

interface ComponentParityAccumulator {
  compared_samples: number;
  top_both_sides_price_comparable_count: number;
  top_both_sides_price_within_one_tick_count: number;
  readonly level_stats: Map<string, MutableComponentLevelStats>;
  readonly mismatch_breakdown: MutableComponentMismatchBreakdown;
  readonly first_mismatches: MutableComponentFirstMismatches;
}

interface MutableComponentLevelStats {
  readonly level: number;
  readonly side: BookSide;
  compared_count: number;
  both_present_count: number;
  both_missing_count: number;
  missing_rithmic_count: number;
  missing_databento_count: number;
  price_comparable_count: number;
  price_within_one_tick_count: number;
  exact_price_match_count: number;
  size_comparable_count: number;
  size_exact_match_count: number;
  order_count_comparable_count: number;
  order_count_exact_match_count: number;
  missing_order_count_count: number;
  readonly size_abs_delta: DeltaHistogram;
  readonly size_relative_delta: DeltaHistogram;
  readonly order_count_abs_delta: DeltaHistogram;
}

interface MutableComponentMismatchBreakdown {
  price_only_mismatch_count: number;
  size_only_mismatch_count: number;
  order_count_only_mismatch_count: number;
  price_and_size_mismatch_count: number;
  missing_level_count: number;
  mixed_component_mismatch_count: number;
}

interface MutableComponentFirstMismatches {
  readonly price_mismatches: Mbp10ComponentMismatchExample[];
  readonly size_mismatches: Mbp10ComponentMismatchExample[];
  readonly order_count_mismatches: Mbp10ComponentMismatchExample[];
  readonly level_presence_mismatches: Mbp10ComponentMismatchExample[];
}

class DeltaHistogram {
  private readonly counts = new Map<number, number>();
  private total = 0;

  record(value: number): void {
    const normalized = normalizeDeltaKey(value);
    this.counts.set(normalized, (this.counts.get(normalized) ?? 0) + 1);
    this.total += 1;
  }

  summary(): DeltaDistributionSummary {
    return {
      count: this.total,
      p50: this.quantile(0.5),
      p95: this.quantile(0.95),
      p99: this.quantile(0.99),
    };
  }

  quantile(q: number): number | null {
    if (this.total === 0) {
      return null;
    }
    const target = Math.max(1, Math.ceil(this.total * q));
    let cumulative = 0;
    for (const [value, count] of [...this.counts.entries()].sort(([left], [right]) => left - right)) {
      cumulative += count;
      if (cumulative >= target) {
        return value;
      }
    }
    return null;
  }
}

function createComponentParityAccumulator(): ComponentParityAccumulator {
  const levelStats = new Map<string, MutableComponentLevelStats>();
  for (const side of ['bid', 'ask'] as const) {
    for (let level = 0; level <= MAX_DEPTH_LEVEL; level += 1) {
      levelStats.set(componentLevelKey(side, level), {
        level,
        side,
        compared_count: 0,
        both_present_count: 0,
        both_missing_count: 0,
        missing_rithmic_count: 0,
        missing_databento_count: 0,
        price_comparable_count: 0,
        price_within_one_tick_count: 0,
        exact_price_match_count: 0,
        size_comparable_count: 0,
        size_exact_match_count: 0,
        order_count_comparable_count: 0,
        order_count_exact_match_count: 0,
        missing_order_count_count: 0,
        size_abs_delta: new DeltaHistogram(),
        size_relative_delta: new DeltaHistogram(),
        order_count_abs_delta: new DeltaHistogram(),
      });
    }
  }

  return {
    compared_samples: 0,
    top_both_sides_price_comparable_count: 0,
    top_both_sides_price_within_one_tick_count: 0,
    level_stats: levelStats,
    mismatch_breakdown: {
      price_only_mismatch_count: 0,
      size_only_mismatch_count: 0,
      order_count_only_mismatch_count: 0,
      price_and_size_mismatch_count: 0,
      missing_level_count: 0,
      mixed_component_mismatch_count: 0,
    },
    first_mismatches: {
      price_mismatches: [],
      size_mismatches: [],
      order_count_mismatches: [],
      level_presence_mismatches: [],
    },
  };
}

function analyzeTemporalAlignment(path: string, rithmic: RithmicMbp10UpdateSet): Mbp10TemporalAlignmentReport {
  const snapshotIndex = buildRithmicTopOfBookSnapshotIndex(rithmic);
  const lookupAccumulators = {
    previous_or_equal: createTemporalScoreAccumulator('previous_or_equal', 'ts_event', 0),
    nearest: createTemporalScoreAccumulator('nearest', 'ts_event', 0),
    next_or_equal: createTemporalScoreAccumulator('next_or_equal', 'ts_event', 0),
    midpoint_bucketed: createTemporalScoreAccumulator('midpoint_bucketed', 'ts_event', 0),
  } satisfies Record<Mbp10LookupPolicy, TemporalScoreAccumulator>;
  const lagAccumulators = TEMPORAL_LAG_SCAN_OFFSETS_MS.map((offsetMs) =>
    createTemporalScoreAccumulator('previous_or_equal', 'ts_event', offsetMs),
  );
  const tsRecvAccumulator = createTemporalScoreAccumulator('previous_or_equal', 'ts_recv', 0);
  const clusterAccumulator = createMismatchClusterAccumulator();
  let tsRecvAvailable = false;

  forEachJsonlLine(path, (trimmed, lineNumber) => {
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `Databento MBP10 line ${lineNumber}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isRecord(record)) {
      throw new Error(`Databento line ${lineNumber}: JSON value must be an object`);
    }
    const databentoSample = normalizeDatabentoMbp10Record(record, lineNumber);
    if (databentoSample === null) {
      return;
    }

    for (const policy of Object.keys(lookupAccumulators) as Mbp10LookupPolicy[]) {
      updateTemporalScoreWithLookup({
        accumulator: lookupAccumulators[policy],
        snapshotIndex,
        databentoSample,
        lookupPolicy: policy,
        targetTsNs: BigInt(databentoSample.ts_ns),
      });
    }

    for (const accumulator of lagAccumulators) {
      updateTemporalScoreWithLookup({
        accumulator,
        snapshotIndex,
        databentoSample,
        lookupPolicy: 'previous_or_equal',
        targetTsNs: BigInt(databentoSample.ts_ns) + BigInt(accumulator.offset_ms) * 1_000_000n,
      });
    }

    const baseSelectedIndex = selectSnapshotIndex(snapshotIndex, BigInt(databentoSample.ts_ns), 'previous_or_equal');
    updateMismatchClusters(clusterAccumulator, snapshotIndex, databentoSample, baseSelectedIndex);

    const tsRecvNs = optionalDecimalString(record, ['ts_recv_ns', 'ts_recv', 'receive_ts_ns', 'databento_recv_ts_ns']);
    if (tsRecvNs !== null) {
      tsRecvAvailable = true;
      updateTemporalScoreWithLookup({
        accumulator: tsRecvAccumulator,
        snapshotIndex,
        databentoSample,
        lookupPolicy: 'previous_or_equal',
        targetTsNs: BigInt(tsRecvNs),
      });
    }
  });

  const lookupPolicyScores = {
    previous_or_equal: finalizeTemporalScore(lookupAccumulators.previous_or_equal),
    nearest: finalizeTemporalScore(lookupAccumulators.nearest),
    next_or_equal: finalizeTemporalScore(lookupAccumulators.next_or_equal),
    midpoint_bucketed: finalizeTemporalScore(lookupAccumulators.midpoint_bucketed),
  } satisfies Record<Mbp10LookupPolicy, Mbp10TemporalPolicyScore>;
  const lagScanScores = lagAccumulators.map(finalizeTemporalScore) as Mbp10LagScanScore[];
  const timestampBasisScores = {
    ts_event: lookupPolicyScores.previous_or_equal,
    ts_recv: tsRecvAvailable ? finalizeTemporalScore(tsRecvAccumulator) : null,
    ts_recv_available: tsRecvAvailable,
  };
  const bestPolicy = bestLookupPolicy(lookupPolicyScores);
  const bestLag = bestLagScore(lagScanScores);
  const bestTimestampBasis = bestTimestampBasisName(timestampBasisScores);
  const classification = classifyTemporalAlignment({
    lookupPolicyScores,
    timestampBasisScores,
    bestPolicy,
    bestLag,
    bestTimestampBasis,
  });

  return {
    lookup_policy_scores: lookupPolicyScores,
    lag_scan_scores: lagScanScores,
    timestamp_basis_scores: timestampBasisScores,
    best_offset_ms: bestLag.offset_ms,
    best_lookup_policy: bestPolicy,
    best_timestamp_basis: bestTimestampBasis,
    mismatch_clusters: finalizeMismatchClusters(clusterAccumulator),
    bbo_cross_checks: {
      rithmic_l1_quote_vs_databento_mbp1: {
        status: 'not_available',
        reason: 'No normalized Databento MBP-1 input path is provided to this analyzer.',
      },
      rithmic_mbp10_top_vs_databento_mbp1: {
        status: 'not_available',
        reason: 'No normalized Databento MBP-1 input path is provided to this analyzer.',
      },
      rithmic_mbp10_top_vs_databento_mbp10: lookupPolicyScores.previous_or_equal,
    },
    classification,
    recommendation: recommendationForTemporalClassification(classification),
  };
}

function analyzeBboTriangulation(args: {
  readonly rithmic_probe_path: string;
  readonly databento_mbp10_path: string;
  readonly databento_mbp1_path: string | null;
  readonly rithmic: RithmicMbp10UpdateSet;
}): BboTriangulationReport {
  const rithmicMbp10Top = buildRithmicMbp10BboSnapshotIndex(args.rithmic);
  const rithmicL1 = buildRithmicL1BboSnapshotIndex(args.rithmic_probe_path);
  const databentoMbp10Top = buildDatabentoMbp10BboSnapshotIndex(args.databento_mbp10_path);
  const databentoMbp1 = args.databento_mbp1_path === null
    ? null
    : buildDatabentoMbp1BboSnapshotIndex(args.databento_mbp1_path);

  const comparisons = {
    rithmic_l1_quote_vs_databento_mbp1: databentoMbp1 === null
      ? {
        status: 'not_available',
        reason: 'No normalized Databento MBP-1 input path was provided.',
      }
      : compareBboSnapshotIndexes({
        comparison: 'rithmic_l1_quote_vs_databento_mbp1',
        source: 'Rithmic reconstructed L1_QUOTE BBO',
        target: 'Databento normalized MBP-1 BBO',
        sourceIndex: rithmicL1,
        targetIndex: databentoMbp1,
      }),
    rithmic_mbp10_top_vs_rithmic_l1_quote: compareBboSnapshotIndexes({
      comparison: 'rithmic_mbp10_top_vs_rithmic_l1_quote',
      source: 'Rithmic reconstructed MBP10 top-of-book',
      target: 'Rithmic reconstructed L1_QUOTE BBO',
      sourceIndex: rithmicMbp10Top,
      targetIndex: rithmicL1,
    }),
    databento_mbp10_top_vs_databento_mbp1: databentoMbp1 === null
      ? {
        status: 'not_available',
        reason: 'No normalized Databento MBP-1 input path was provided.',
      }
      : compareBboSnapshotIndexes({
        comparison: 'databento_mbp10_top_vs_databento_mbp1',
        source: 'Databento normalized MBP-10 top-of-book',
        target: 'Databento normalized MBP-1 BBO',
        sourceIndex: databentoMbp10Top,
        targetIndex: databentoMbp1,
      }),
    rithmic_mbp10_top_vs_databento_mbp10: compareBboSnapshotIndexes({
      comparison: 'rithmic_mbp10_top_vs_databento_mbp10',
      source: 'Rithmic reconstructed MBP10 top-of-book',
      target: 'Databento normalized MBP-10 top-of-book',
      sourceIndex: rithmicMbp10Top,
      targetIndex: databentoMbp10Top,
    }),
  } satisfies Readonly<Record<BboComparisonId, BboTriangulationComparisonReport | UnavailableCrossCheck>>;

  const classification = classifyBboTriangulation(comparisons);
  return {
    status: 'analysis_only',
    data01b_eligible: false,
    comparisons,
    classification,
    recommendation: recommendationForBboTriangulation(classification),
  };
}

function unavailableBboTriangulation(reason: string): BboTriangulationReport {
  const unavailable: UnavailableCrossCheck = {
    status: 'not_available',
    reason,
  };
  return {
    status: 'analysis_only',
    data01b_eligible: false,
    comparisons: {
      rithmic_l1_quote_vs_databento_mbp1: unavailable,
      rithmic_mbp10_top_vs_rithmic_l1_quote: unavailable,
      databento_mbp10_top_vs_databento_mbp1: unavailable,
      rithmic_mbp10_top_vs_databento_mbp10: unavailable,
    },
    classification: 'inconclusive',
    recommendation: 'BBO triangulation was not run; provide normalized Databento MBP-1 input and keep DATA-01B blocked.',
  };
}

export function analyzeBboTriangulationFromPaths(options: {
  readonly rithmic_probe_path: string;
  readonly databento_mbp10_path: string;
  readonly databento_mbp1_path: string;
}): BboTriangulationReport {
  const rithmicPath = resolve(options.rithmic_probe_path);
  const databentoMbp10Path = resolve(options.databento_mbp10_path);
  const databentoMbp1Path = resolve(options.databento_mbp1_path);
  const rithmic = readRithmicMbp10Updates(rithmicPath);
  return analyzeBboTriangulation({
    rithmic_probe_path: rithmicPath,
    databento_mbp10_path: databentoMbp10Path,
    databento_mbp1_path: databentoMbp1Path,
    rithmic,
  });
}

function buildRithmicMbp10BboSnapshotIndex(rithmic: RithmicMbp10UpdateSet): BboSnapshotIndex {
  const builder = createBboSnapshotBuilder();
  const state = cloneBookState(rithmic.seed_state);
  for (const update of rithmic.updates) {
    applyBookUpdate(state, update);
    const sample = stateToSample(state, update.ts_ns, update.record_index);
    appendBookSampleTopToBboBuilder(builder, sample);
  }
  return finalizeBboSnapshotBuilder(builder);
}

function buildRithmicL1BboSnapshotIndex(path: string): BboSnapshotIndex {
  const builder = createBboSnapshotBuilder();
  let bid: { px: number; sz: number; order_count: number | null } | null = null;
  let ask: { px: number; sz: number; order_count: number | null } | null = null;

  forEachJsonlLine(path, (trimmed, lineNumber) => {
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `Rithmic probe line ${lineNumber}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isL1QuoteRecord(record)) {
      return;
    }
    const tsNs = optionalDecimalString(record, ['exchange_event_ts_ns']);
    if (tsNs === null) {
      return;
    }
    const bidUpdate = normalizeBboSideFromRecord(record, 'bid');
    const askUpdate = normalizeBboSideFromRecord(record, 'ask');
    if (bidUpdate !== null) {
      bid = bidUpdate;
    }
    if (askUpdate !== null) {
      ask = askUpdate;
    }
    if (bid === null || ask === null) {
      return;
    }
    appendBboPoint(builder, {
      ts_ns: tsNs,
      bid_px: bid.px,
      ask_px: ask.px,
      bid_sz: bid.sz,
      ask_sz: ask.sz,
      bid_order_count: bid.order_count,
      ask_order_count: ask.order_count,
    });
  });

  return finalizeBboSnapshotBuilder(builder);
}

function buildDatabentoMbp10BboSnapshotIndex(path: string): BboSnapshotIndex {
  const builder = createBboSnapshotBuilder();
  forEachJsonlLine(path, (trimmed, lineNumber) => {
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `Databento MBP10 line ${lineNumber}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isRecord(record)) {
      throw new Error(`Databento MBP10 line ${lineNumber}: JSON value must be an object`);
    }
    const sample = normalizeDatabentoMbp10Record(record, lineNumber);
    if (sample === null) {
      return;
    }
    appendBookSampleTopToBboBuilder(builder, sample);
  });
  return finalizeBboSnapshotBuilder(builder);
}

function buildDatabentoMbp1BboSnapshotIndex(path: string): BboSnapshotIndex {
  const builder = createBboSnapshotBuilder();
  forEachJsonlLine(path, (trimmed, lineNumber) => {
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `Databento MBP1 line ${lineNumber}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isRecord(record)) {
      throw new Error(`Databento MBP1 line ${lineNumber}: JSON value must be an object`);
    }
    const tsNs = optionalDecimalString(record, ['ts_event_ns', 'ts_event', 'exchange_event_ts_ns']);
    if (tsNs === null) {
      return;
    }
    const bid = normalizeBboSideFromRecord(record, 'bid');
    const ask = normalizeBboSideFromRecord(record, 'ask');
    if (bid === null && ask === null) {
      return;
    }
    appendBboPoint(builder, {
      ts_ns: tsNs,
      bid_px: bid?.px ?? null,
      ask_px: ask?.px ?? null,
      bid_sz: bid?.sz ?? null,
      ask_sz: ask?.sz ?? null,
      bid_order_count: bid?.order_count ?? null,
      ask_order_count: ask?.order_count ?? null,
    });
  });
  return finalizeBboSnapshotBuilder(builder);
}

function appendBookSampleTopToBboBuilder(builder: MutableBboSnapshotBuilder, sample: BookSample): void {
  const bid = findLevel(sample, 'bid', 0);
  const ask = findLevel(sample, 'ask', 0);
  appendBboPoint(builder, {
    ts_ns: sample.ts_ns,
    bid_px: bid?.px ?? null,
    ask_px: ask?.px ?? null,
    bid_sz: bid?.sz ?? null,
    ask_sz: ask?.sz ?? null,
    bid_order_count: bid?.order_count ?? null,
    ask_order_count: ask?.order_count ?? null,
  });
}

interface MutableBboSnapshotBuilder {
  readonly ts_ns: bigint[];
  readonly bid_px: number[];
  readonly ask_px: number[];
  readonly bid_sz: number[];
  readonly ask_sz: number[];
  readonly bid_order_count: number[];
  readonly ask_order_count: number[];
  needs_sort: boolean;
  last_ts_ns: bigint | null;
}

function createBboSnapshotBuilder(): MutableBboSnapshotBuilder {
  return {
    ts_ns: [],
    bid_px: [],
    ask_px: [],
    bid_sz: [],
    ask_sz: [],
    bid_order_count: [],
    ask_order_count: [],
    needs_sort: false,
    last_ts_ns: null,
  };
}

function appendBboPoint(
  builder: MutableBboSnapshotBuilder,
  point: {
    readonly ts_ns: string;
    readonly bid_px: number | null;
    readonly ask_px: number | null;
    readonly bid_sz: number | null;
    readonly ask_sz: number | null;
    readonly bid_order_count: number | null;
    readonly ask_order_count: number | null;
  },
): void {
  const tsNs = BigInt(point.ts_ns);
  if (builder.last_ts_ns !== null && tsNs < builder.last_ts_ns) {
    builder.needs_sort = true;
  }
  builder.last_ts_ns = tsNs;
  builder.ts_ns.push(tsNs);
  builder.bid_px.push(point.bid_px ?? Number.NaN);
  builder.ask_px.push(point.ask_px ?? Number.NaN);
  builder.bid_sz.push(point.bid_sz ?? -1);
  builder.ask_sz.push(point.ask_sz ?? -1);
  builder.bid_order_count.push(point.bid_order_count ?? -1);
  builder.ask_order_count.push(point.ask_order_count ?? -1);
}

function finalizeBboSnapshotBuilder(builder: MutableBboSnapshotBuilder): BboSnapshotIndex {
  const order = builder.needs_sort
    ? builder.ts_ns.map((_, index) => index).sort((left, right) => {
      const ts = compareBigInt(builder.ts_ns[left]!, builder.ts_ns[right]!);
      if (ts !== 0) return ts;
      return left - right;
    })
    : builder.ts_ns.map((_, index) => index);

  const length = order.length;
  const tsNs = new BigInt64Array(length);
  const bidPx = new Float64Array(length);
  const askPx = new Float64Array(length);
  const bidSz = new Int32Array(length);
  const askSz = new Int32Array(length);
  const bidOrderCount = new Int32Array(length);
  const askOrderCount = new Int32Array(length);

  for (let outputIndex = 0; outputIndex < order.length; outputIndex += 1) {
    const inputIndex = order[outputIndex]!;
    tsNs[outputIndex] = builder.ts_ns[inputIndex]!;
    bidPx[outputIndex] = builder.bid_px[inputIndex]!;
    askPx[outputIndex] = builder.ask_px[inputIndex]!;
    bidSz[outputIndex] = builder.bid_sz[inputIndex]!;
    askSz[outputIndex] = builder.ask_sz[inputIndex]!;
    bidOrderCount[outputIndex] = builder.bid_order_count[inputIndex]!;
    askOrderCount[outputIndex] = builder.ask_order_count[inputIndex]!;
  }

  return {
    ts_ns: tsNs,
    bid_px: bidPx,
    ask_px: askPx,
    bid_sz: bidSz,
    ask_sz: askSz,
    bid_order_count: bidOrderCount,
    ask_order_count: askOrderCount,
  };
}

function compareBboSnapshotIndexes(args: {
  readonly comparison: BboComparisonId;
  readonly source: string;
  readonly target: string;
  readonly sourceIndex: BboSnapshotIndex;
  readonly targetIndex: BboSnapshotIndex;
}): BboTriangulationComparisonReport {
  const accumulators = {
    previous_or_equal: createBboComparisonAccumulator('previous_or_equal'),
    nearest: createBboComparisonAccumulator('nearest'),
    next_or_equal: createBboComparisonAccumulator('next_or_equal'),
    midpoint_bucketed: createBboComparisonAccumulator('midpoint_bucketed'),
  } satisfies Record<Mbp10LookupPolicy, BboComparisonAccumulator>;

  let nextCursor = 0;
  for (let targetIndex = 0; targetIndex < args.targetIndex.ts_ns.length; targetIndex += 1) {
    const targetTsNs = args.targetIndex.ts_ns[targetIndex]!;
    while (nextCursor < args.sourceIndex.ts_ns.length && args.sourceIndex.ts_ns[nextCursor]! < targetTsNs) {
      nextCursor += 1;
    }

    const nextOrEqual = nextCursor < args.sourceIndex.ts_ns.length ? nextCursor : -1;
    let previousOrEqual = nextCursor - 1;
    let scanCursor = nextCursor;
    while (scanCursor < args.sourceIndex.ts_ns.length && args.sourceIndex.ts_ns[scanCursor]! === targetTsNs) {
      previousOrEqual = scanCursor;
      scanCursor += 1;
    }
    const nearest = selectNearestBboSnapshotIndexFromBounds(args.sourceIndex, targetTsNs, previousOrEqual, nextOrEqual);
    const selectedByPolicy = {
      previous_or_equal: previousOrEqual,
      nearest,
      next_or_equal: nextOrEqual,
      midpoint_bucketed: nearest,
    } satisfies Record<Mbp10LookupPolicy, number>;

    for (const policy of Object.keys(accumulators) as Mbp10LookupPolicy[]) {
      updateBboComparisonAccumulator({
        accumulator: accumulators[policy],
        sourceIndex: args.sourceIndex,
        targetIndex: args.targetIndex,
        sourceSnapshotIndex: selectedByPolicy[policy],
        targetSnapshotIndex: targetIndex,
      });
    }
  }

  const lookupPolicyScores = {
    previous_or_equal: finalizeBboTriangulationScore(accumulators.previous_or_equal),
    nearest: finalizeBboTriangulationScore(accumulators.nearest),
    next_or_equal: finalizeBboTriangulationScore(accumulators.next_or_equal),
    midpoint_bucketed: finalizeBboTriangulationScore(accumulators.midpoint_bucketed),
  } satisfies Record<Mbp10LookupPolicy, BboTriangulationScore>;
  const bestPolicy = bestBboLookupPolicy(lookupPolicyScores);
  const bestAccumulator = accumulators[bestPolicy];
  const bestScore = lookupPolicyScores[bestPolicy];

  return {
    status: 'available',
    comparison: args.comparison,
    source: args.source,
    target: args.target,
    best_lookup_policy: bestPolicy,
    compared_samples: bestScore.compared_samples,
    unmatched_samples: bestScore.unmatched_samples,
    bid_price_within_1_tick_pct: bestScore.bid_price_within_1_tick_pct,
    ask_price_within_1_tick_pct: bestScore.ask_price_within_1_tick_pct,
    both_sides_within_1_tick_pct: bestScore.both_sides_within_1_tick_pct,
    bid_size_exact_match_pct: bestScore.bid_size_exact_match_pct,
    ask_size_exact_match_pct: bestScore.ask_size_exact_match_pct,
    lookup_policy_scores: lookupPolicyScores,
    first_mismatches: bestAccumulator.first_mismatches,
    mismatch_rate_by_minute: finalizeBboMinuteRates(bestAccumulator),
  };
}

interface BboComparisonAccumulator {
  readonly lookup_policy: Mbp10LookupPolicy;
  compared_samples: number;
  unmatched_samples: number;
  bid_price_comparable_count: number;
  bid_price_within_one_tick_count: number;
  ask_price_comparable_count: number;
  ask_price_within_one_tick_count: number;
  both_sides_comparable_count: number;
  both_sides_within_one_tick_count: number;
  bid_size_comparable_count: number;
  bid_size_exact_match_count: number;
  ask_size_comparable_count: number;
  ask_size_exact_match_count: number;
  readonly first_mismatches: BboTriangulationMismatchExample[];
  readonly minute_buckets: Map<string, { compared_samples: number; price_mismatch_samples: number }>;
}

function createBboComparisonAccumulator(lookupPolicy: Mbp10LookupPolicy): BboComparisonAccumulator {
  return {
    lookup_policy: lookupPolicy,
    compared_samples: 0,
    unmatched_samples: 0,
    bid_price_comparable_count: 0,
    bid_price_within_one_tick_count: 0,
    ask_price_comparable_count: 0,
    ask_price_within_one_tick_count: 0,
    both_sides_comparable_count: 0,
    both_sides_within_one_tick_count: 0,
    bid_size_comparable_count: 0,
    bid_size_exact_match_count: 0,
    ask_size_comparable_count: 0,
    ask_size_exact_match_count: 0,
    first_mismatches: [],
    minute_buckets: new Map<string, { compared_samples: number; price_mismatch_samples: number }>(),
  };
}

function updateBboComparisonAccumulator(args: {
  readonly accumulator: BboComparisonAccumulator;
  readonly sourceIndex: BboSnapshotIndex;
  readonly targetIndex: BboSnapshotIndex;
  readonly sourceSnapshotIndex: number;
  readonly targetSnapshotIndex: number;
}): void {
  if (args.sourceSnapshotIndex < 0) {
    args.accumulator.unmatched_samples += 1;
    return;
  }

  args.accumulator.compared_samples += 1;
  const targetTsNs = args.targetIndex.ts_ns[args.targetSnapshotIndex]!.toString();
  const bidWithin = updateBboSideComparison(args, 'bid');
  const askWithin = updateBboSideComparison(args, 'ask');
  const priceMismatch = bidWithin !== true || askWithin !== true;

  const bucketKey = minuteBucketStartTsNs(targetTsNs);
  const bucket = args.accumulator.minute_buckets.get(bucketKey) ?? {
    compared_samples: 0,
    price_mismatch_samples: 0,
  };
  bucket.compared_samples += 1;
  if (priceMismatch) {
    bucket.price_mismatch_samples += 1;
  }
  args.accumulator.minute_buckets.set(bucketKey, bucket);

  if (bidWithin !== null && askWithin !== null) {
    args.accumulator.both_sides_comparable_count += 1;
    if (bidWithin && askWithin) {
      args.accumulator.both_sides_within_one_tick_count += 1;
    }
  }
}

function updateBboSideComparison(
  args: {
    readonly accumulator: BboComparisonAccumulator;
    readonly sourceIndex: BboSnapshotIndex;
    readonly targetIndex: BboSnapshotIndex;
    readonly sourceSnapshotIndex: number;
    readonly targetSnapshotIndex: number;
  },
  side: BookSide,
): boolean | null {
  const sourcePx = getBboPrice(args.sourceIndex, args.sourceSnapshotIndex, side);
  const targetPx = getBboPrice(args.targetIndex, args.targetSnapshotIndex, side);
  const sourceSize = getBboSize(args.sourceIndex, args.sourceSnapshotIndex, side);
  const targetSize = getBboSize(args.targetIndex, args.targetSnapshotIndex, side);
  const sourceOrderCount = getBboOrderCount(args.sourceIndex, args.sourceSnapshotIndex, side);
  const targetOrderCount = getBboOrderCount(args.targetIndex, args.targetSnapshotIndex, side);
  const targetTsNs = args.targetIndex.ts_ns[args.targetSnapshotIndex]!.toString();
  const sourceTsNs = args.sourceIndex.ts_ns[args.sourceSnapshotIndex]!.toString();

  if (sourcePx === null || targetPx === null) {
    pushBboMismatch(args.accumulator.first_mismatches, {
      exchange_event_ts_ns: targetTsNs,
      source_ts_ns: sourceTsNs,
      side,
      source_px: sourcePx,
      source_size: sourceSize,
      source_order_count: sourceOrderCount,
      target_px: targetPx,
      target_size: targetSize,
      target_order_count: targetOrderCount,
      price_delta: null,
      size_delta: sourceSize === null || targetSize === null ? null : sourceSize - targetSize,
      order_count_delta: sourceOrderCount === null || targetOrderCount === null ? null : sourceOrderCount - targetOrderCount,
      classification: 'missing_side',
    });
    return null;
  }

  const priceWithinOneTick = Math.abs(sourcePx - targetPx) <= MNQ_TICK_SIZE;
  if (side === 'bid') {
    args.accumulator.bid_price_comparable_count += 1;
    if (priceWithinOneTick) args.accumulator.bid_price_within_one_tick_count += 1;
    if (sourceSize !== null && targetSize !== null) {
      args.accumulator.bid_size_comparable_count += 1;
      if (sourceSize === targetSize) args.accumulator.bid_size_exact_match_count += 1;
    }
  } else {
    args.accumulator.ask_price_comparable_count += 1;
    if (priceWithinOneTick) args.accumulator.ask_price_within_one_tick_count += 1;
    if (sourceSize !== null && targetSize !== null) {
      args.accumulator.ask_size_comparable_count += 1;
      if (sourceSize === targetSize) args.accumulator.ask_size_exact_match_count += 1;
    }
  }

  const sizeMismatch = sourceSize !== null && targetSize !== null && sourceSize !== targetSize;
  const orderCountMismatch = sourceOrderCount !== null && targetOrderCount !== null && sourceOrderCount !== targetOrderCount;
  if (!priceWithinOneTick || sizeMismatch || orderCountMismatch) {
    pushBboMismatch(args.accumulator.first_mismatches, {
      exchange_event_ts_ns: targetTsNs,
      source_ts_ns: sourceTsNs,
      side,
      source_px: sourcePx,
      source_size: sourceSize,
      source_order_count: sourceOrderCount,
      target_px: targetPx,
      target_size: targetSize,
      target_order_count: targetOrderCount,
      price_delta: sourcePx - targetPx,
      size_delta: sourceSize === null || targetSize === null ? null : sourceSize - targetSize,
      order_count_delta: sourceOrderCount === null || targetOrderCount === null ? null : sourceOrderCount - targetOrderCount,
      classification: !priceWithinOneTick
        ? 'price_mismatch'
        : sizeMismatch
          ? 'size_mismatch'
          : 'order_count_mismatch',
    });
  }

  return priceWithinOneTick;
}

function pushBboMismatch(
  collection: BboTriangulationMismatchExample[],
  mismatch: BboTriangulationMismatchExample,
): void {
  if (collection.length < 20) {
    collection.push(mismatch);
  }
}

function finalizeBboTriangulationScore(accumulator: BboComparisonAccumulator): BboTriangulationScore {
  return {
    lookup_policy: accumulator.lookup_policy,
    compared_samples: accumulator.compared_samples,
    unmatched_samples: accumulator.unmatched_samples,
    bid_price_within_1_tick_pct: pct(
      accumulator.bid_price_within_one_tick_count,
      accumulator.bid_price_comparable_count,
    ),
    ask_price_within_1_tick_pct: pct(
      accumulator.ask_price_within_one_tick_count,
      accumulator.ask_price_comparable_count,
    ),
    both_sides_within_1_tick_pct: pct(
      accumulator.both_sides_within_one_tick_count,
      accumulator.both_sides_comparable_count,
    ),
    bid_size_exact_match_pct: pct(accumulator.bid_size_exact_match_count, accumulator.bid_size_comparable_count),
    ask_size_exact_match_pct: pct(accumulator.ask_size_exact_match_count, accumulator.ask_size_comparable_count),
  };
}

function finalizeBboMinuteRates(
  accumulator: BboComparisonAccumulator,
): readonly BboTriangulationMinuteMismatchRate[] {
  return [...accumulator.minute_buckets.entries()]
    .sort(([left], [right]) => compareDecimalIntegerStrings(left, right))
    .map(([bucketStartTsNs, bucket]) => ({
      bucket_start_ts_ns: bucketStartTsNs,
      compared_samples: bucket.compared_samples,
      price_mismatch_samples: bucket.price_mismatch_samples,
      mismatch_rate_pct: pct(bucket.price_mismatch_samples, bucket.compared_samples),
    }));
}

function bestBboLookupPolicy(scores: Readonly<Record<Mbp10LookupPolicy, BboTriangulationScore>>): Mbp10LookupPolicy {
  return (Object.keys(scores) as Mbp10LookupPolicy[]).sort((left, right) => {
    const scoreComparison = compareNullablePct(
      scores[right]!.both_sides_within_1_tick_pct,
      scores[left]!.both_sides_within_1_tick_pct,
    );
    if (scoreComparison !== 0) return scoreComparison;
    return bboPolicyRank(left) - bboPolicyRank(right);
  })[0]!;
}

function bboPolicyRank(policy: Mbp10LookupPolicy): number {
  if (policy === 'previous_or_equal') return 0;
  if (policy === 'nearest') return 1;
  if (policy === 'next_or_equal') return 2;
  return 3;
}

function classifyBboTriangulation(
  comparisons: Readonly<Record<BboComparisonId, BboTriangulationComparisonReport | UnavailableCrossCheck>>,
): BboTriangulationClassification {
  const rithmicInternal = availableBboComparison(comparisons.rithmic_mbp10_top_vs_rithmic_l1_quote);
  const databentoInternal = availableBboComparison(comparisons.databento_mbp10_top_vs_databento_mbp1);
  const l1CrossSource = availableBboComparison(comparisons.rithmic_l1_quote_vs_databento_mbp1);
  const mbp10CrossSource = availableBboComparison(comparisons.rithmic_mbp10_top_vs_databento_mbp10);

  if (rithmicInternal !== null && bboComparisonScore(rithmicInternal) < 99) {
    return 'rithmic_mbp10_extraction_issue';
  }
  if (databentoInternal !== null && bboComparisonScore(databentoInternal) < 99) {
    return 'databento_mbp10_normalization_issue';
  }
  if (l1CrossSource !== null && bboComparisonScore(l1CrossSource) < 99) {
    return 'l1_cross_source_alignment_issue';
  }
  if (mbp10CrossSource !== null && bboComparisonScore(mbp10CrossSource) < 99) {
    return 'mbp10_depth_semantics_issue';
  }
  return 'inconclusive';
}

function recommendationForBboTriangulation(classification: BboTriangulationClassification): string {
  if (classification === 'rithmic_mbp10_extraction_issue') {
    return 'Rithmic MBP10 disagrees with reconstructed Rithmic L1; keep DATA-01B blocked and revisit the Rithmic MBP10 extractor/reconstructor before cross-vendor parity.';
  }
  if (classification === 'databento_mbp10_normalization_issue') {
    return 'Databento MBP-10 top-of-book disagrees with Databento MBP-1; keep DATA-01B blocked and inspect the Databento normalizer or schema semantics before judging Rithmic.';
  }
  if (classification === 'l1_cross_source_alignment_issue') {
    return 'Rithmic L1 and Databento MBP-1 disagree; keep DATA-01B blocked and review cross-source BBO alignment before interpreting MBP10 depth parity.';
  }
  if (classification === 'mbp10_depth_semantics_issue') {
    return 'Both L1/internal checks are strong but cross-source MBP10 still disagrees; keep DATA-01B blocked and review depth aggregation/implied-liquidity semantics.';
  }
  return 'Triangulation is inconclusive; keep DATA-01B blocked until reviewer accepts a narrower parity scope or adds more normalized inputs.';
}

function availableBboComparison(
  comparison: BboTriangulationComparisonReport | UnavailableCrossCheck,
): BboTriangulationComparisonReport | null {
  return comparison.status === 'available' ? comparison : null;
}

function bboComparisonScore(comparison: BboTriangulationComparisonReport): number {
  return comparison.both_sides_within_1_tick_pct ?? -1;
}

function normalizeBboSideFromRecord(
  record: Record<string, unknown>,
  side: BookSide,
): { px: number; sz: number; order_count: number | null } | null {
  const px = optionalFiniteNumber(record, [
    `${side}_px`,
    `${side}_px_00`,
    `${side}_px_0`,
    `${side}_price`,
    `${side}_price_00`,
    `${side}_price_0`,
  ]);
  const sz = optionalFiniteNumber(record, [
    `${side}_sz`,
    `${side}_sz_00`,
    `${side}_sz_0`,
    `${side}_size`,
    `${side}_size_00`,
    `${side}_size_0`,
    `${side}_qty`,
    `${side}_qty_00`,
    `${side}_qty_0`,
  ]);
  const orderCount = optionalFiniteInteger(record, [
    `${side}_orders`,
    `${side}_order_count`,
    `${side}_order_count_00`,
    `${side}_order_count_0`,
    `${side}_ct`,
    `${side}_ct_00`,
    `${side}_ct_0`,
    `${side}_count`,
    `${side}_count_00`,
    `${side}_count_0`,
  ]);
  if (px === null || sz === null) {
    return null;
  }
  return {
    px,
    sz,
    order_count: orderCount,
  };
}

function isL1QuoteRecord(record: unknown): record is Record<string, unknown> {
  if (!isRecord(record)) {
    return false;
  }
  const stream = firstField(record, ['stream', 'stream_id', 'payload_kind']);
  return stream === 'L1_QUOTE';
}

function selectBboSnapshotIndex(
  snapshotIndex: BboSnapshotIndex,
  targetTsNs: bigint,
  lookupPolicy: Mbp10LookupPolicy,
): number {
  if (snapshotIndex.ts_ns.length === 0) {
    return -1;
  }
  const previous = findPreviousSnapshotIndex(snapshotIndex.ts_ns, targetTsNs);
  if (lookupPolicy === 'previous_or_equal') {
    return previous;
  }
  const next = findNextSnapshotIndex(snapshotIndex.ts_ns, targetTsNs);
  if (lookupPolicy === 'next_or_equal') {
    return next;
  }
  if (previous < 0) {
    return next;
  }
  if (next < 0) {
    return previous;
  }
  const previousDelta = targetTsNs - snapshotIndex.ts_ns[previous]!;
  const nextDelta = snapshotIndex.ts_ns[next]! - targetTsNs;
  return previousDelta <= nextDelta ? previous : next;
}

function selectNearestBboSnapshotIndexFromBounds(
  snapshotIndex: BboSnapshotIndex,
  targetTsNs: bigint,
  previous: number,
  next: number,
): number {
  if (previous < 0) {
    return next;
  }
  if (next < 0) {
    return previous;
  }
  const previousDelta = targetTsNs - snapshotIndex.ts_ns[previous]!;
  const nextDelta = snapshotIndex.ts_ns[next]! - targetTsNs;
  return previousDelta <= nextDelta ? previous : next;
}

function getBboPrice(snapshotIndex: BboSnapshotIndex, index: number, side: BookSide): number | null {
  const value = side === 'bid' ? snapshotIndex.bid_px[index]! : snapshotIndex.ask_px[index]!;
  return Number.isNaN(value) ? null : value;
}

function getBboSize(snapshotIndex: BboSnapshotIndex, index: number, side: BookSide): number | null {
  const value = side === 'bid' ? snapshotIndex.bid_sz[index]! : snapshotIndex.ask_sz[index]!;
  return value < 0 ? null : value;
}

function getBboOrderCount(snapshotIndex: BboSnapshotIndex, index: number, side: BookSide): number | null {
  const value = side === 'bid' ? snapshotIndex.bid_order_count[index]! : snapshotIndex.ask_order_count[index]!;
  return value < 0 ? null : value;
}

function buildRithmicTopOfBookSnapshotIndex(rithmic: RithmicMbp10UpdateSet): RithmicTopOfBookSnapshotIndex {
  const updateCount = rithmic.updates.length;
  const tsNs = new BigInt64Array(updateCount);
  const bidPx = new Float64Array(updateCount * (MAX_DEPTH_LEVEL + 1));
  const askPx = new Float64Array(updateCount * (MAX_DEPTH_LEVEL + 1));
  const bidSz = new Int32Array(updateCount * (MAX_DEPTH_LEVEL + 1));
  const askSz = new Int32Array(updateCount * (MAX_DEPTH_LEVEL + 1));
  const bidOrderCount = new Int32Array(updateCount * (MAX_DEPTH_LEVEL + 1));
  const askOrderCount = new Int32Array(updateCount * (MAX_DEPTH_LEVEL + 1));
  bidPx.fill(Number.NaN);
  askPx.fill(Number.NaN);
  bidSz.fill(-1);
  askSz.fill(-1);
  bidOrderCount.fill(-1);
  askOrderCount.fill(-1);

  const state = cloneBookState(rithmic.seed_state);
  rithmic.updates.forEach((update, updateIndex) => {
    applyBookUpdate(state, update);
    const sample = stateToSample(state, update.ts_ns, update.record_index);
    tsNs[updateIndex] = BigInt(update.ts_ns);
    writeSnapshotSide({ updateIndex, levels: sample.bids, px: bidPx, sz: bidSz, orderCount: bidOrderCount });
    writeSnapshotSide({ updateIndex, levels: sample.asks, px: askPx, sz: askSz, orderCount: askOrderCount });
  });

  return {
    ts_ns: tsNs,
    bid_px: bidPx,
    ask_px: askPx,
    bid_sz: bidSz,
    ask_sz: askSz,
    bid_order_count: bidOrderCount,
    ask_order_count: askOrderCount,
  };
}

function writeSnapshotSide(args: {
  readonly updateIndex: number;
  readonly levels: readonly BookLevel[];
  readonly px: Float64Array;
  readonly sz: Int32Array;
  readonly orderCount: Int32Array;
}): void {
  for (const level of args.levels) {
    if (level.level < 0 || level.level > MAX_DEPTH_LEVEL) {
      continue;
    }
    const index = snapshotArrayIndex(args.updateIndex, level.level);
    args.px[index] = level.px;
    args.sz[index] = level.sz;
    args.orderCount[index] = level.order_count ?? -1;
  }
}

interface TemporalScoreAccumulator {
  readonly lookup_policy: Mbp10LookupPolicy;
  readonly timestamp_basis: Mbp10TimestampBasis;
  readonly offset_ms: number;
  compared_samples: number;
  unmatched_samples: number;
  bid_top_price_comparable_count: number;
  bid_top_price_within_one_tick_count: number;
  ask_top_price_comparable_count: number;
  ask_top_price_within_one_tick_count: number;
  both_sides_top_price_comparable_count: number;
  both_sides_top_price_within_one_tick_count: number;
  depth_price_comparable_count: number;
  depth_price_within_one_tick_count: number;
  bid_top_size_comparable_count: number;
  bid_top_size_exact_match_count: number;
  ask_top_size_comparable_count: number;
  ask_top_size_exact_match_count: number;
  bid_top_order_count_comparable_count: number;
  bid_top_order_count_exact_match_count: number;
  ask_top_order_count_comparable_count: number;
  ask_top_order_count_exact_match_count: number;
}

function createTemporalScoreAccumulator(
  lookupPolicy: Mbp10LookupPolicy,
  timestampBasis: Mbp10TimestampBasis,
  offsetMs: number,
): TemporalScoreAccumulator {
  return {
    lookup_policy: lookupPolicy,
    timestamp_basis: timestampBasis,
    offset_ms: offsetMs,
    compared_samples: 0,
    unmatched_samples: 0,
    bid_top_price_comparable_count: 0,
    bid_top_price_within_one_tick_count: 0,
    ask_top_price_comparable_count: 0,
    ask_top_price_within_one_tick_count: 0,
    both_sides_top_price_comparable_count: 0,
    both_sides_top_price_within_one_tick_count: 0,
    depth_price_comparable_count: 0,
    depth_price_within_one_tick_count: 0,
    bid_top_size_comparable_count: 0,
    bid_top_size_exact_match_count: 0,
    ask_top_size_comparable_count: 0,
    ask_top_size_exact_match_count: 0,
    bid_top_order_count_comparable_count: 0,
    bid_top_order_count_exact_match_count: 0,
    ask_top_order_count_comparable_count: 0,
    ask_top_order_count_exact_match_count: 0,
  };
}

function updateTemporalScoreWithLookup(args: {
  readonly accumulator: TemporalScoreAccumulator;
  readonly snapshotIndex: RithmicTopOfBookSnapshotIndex;
  readonly databentoSample: BookSample;
  readonly lookupPolicy: Mbp10LookupPolicy;
  readonly targetTsNs: bigint;
}): void {
  const selectedIndex = selectSnapshotIndex(args.snapshotIndex, args.targetTsNs, args.lookupPolicy);
  updateTemporalScore(args.accumulator, args.snapshotIndex, args.databentoSample, selectedIndex);
}

function updateTemporalScore(
  accumulator: TemporalScoreAccumulator,
  snapshotIndex: RithmicTopOfBookSnapshotIndex,
  databentoSample: BookSample,
  selectedIndex: number,
): void {
  if (selectedIndex < 0) {
    accumulator.unmatched_samples += 1;
    return;
  }

  accumulator.compared_samples += 1;
  const bidTopWithin = updateTemporalTopSide(accumulator, snapshotIndex, databentoSample, selectedIndex, 'bid');
  const askTopWithin = updateTemporalTopSide(accumulator, snapshotIndex, databentoSample, selectedIndex, 'ask');
  if (bidTopWithin !== null && askTopWithin !== null) {
    accumulator.both_sides_top_price_comparable_count += 1;
    if (bidTopWithin && askTopWithin) {
      accumulator.both_sides_top_price_within_one_tick_count += 1;
    }
  }

  for (const side of ['bid', 'ask'] as const) {
    for (let level = 0; level <= MAX_DEPTH_LEVEL; level += 1) {
      const rithmicPx = getSnapshotPrice(snapshotIndex, selectedIndex, side, level);
      const databentoLevel = findLevel(databentoSample, side, level);
      if (rithmicPx === null || databentoLevel === null) {
        continue;
      }
      accumulator.depth_price_comparable_count += 1;
      if (Math.abs(rithmicPx - databentoLevel.px) <= MNQ_TICK_SIZE) {
        accumulator.depth_price_within_one_tick_count += 1;
      }
    }
  }
}

function updateTemporalTopSide(
  accumulator: TemporalScoreAccumulator,
  snapshotIndex: RithmicTopOfBookSnapshotIndex,
  databentoSample: BookSample,
  selectedIndex: number,
  side: BookSide,
): boolean | null {
  const rithmicPx = getSnapshotPrice(snapshotIndex, selectedIndex, side, 0);
  const rithmicSize = getSnapshotSize(snapshotIndex, selectedIndex, side, 0);
  const rithmicOrderCount = getSnapshotOrderCount(snapshotIndex, selectedIndex, side, 0);
  const databentoLevel = findLevel(databentoSample, side, 0);
  if (rithmicPx === null || databentoLevel === null) {
    return null;
  }

  const priceWithinOneTick = Math.abs(rithmicPx - databentoLevel.px) <= MNQ_TICK_SIZE;
  if (side === 'bid') {
    accumulator.bid_top_price_comparable_count += 1;
    if (priceWithinOneTick) accumulator.bid_top_price_within_one_tick_count += 1;
    if (rithmicSize !== null) {
      accumulator.bid_top_size_comparable_count += 1;
      if (rithmicSize === databentoLevel.sz) accumulator.bid_top_size_exact_match_count += 1;
    }
    if (rithmicOrderCount !== null && databentoLevel.order_count !== null) {
      accumulator.bid_top_order_count_comparable_count += 1;
      if (rithmicOrderCount === databentoLevel.order_count) {
        accumulator.bid_top_order_count_exact_match_count += 1;
      }
    }
  } else {
    accumulator.ask_top_price_comparable_count += 1;
    if (priceWithinOneTick) accumulator.ask_top_price_within_one_tick_count += 1;
    if (rithmicSize !== null) {
      accumulator.ask_top_size_comparable_count += 1;
      if (rithmicSize === databentoLevel.sz) accumulator.ask_top_size_exact_match_count += 1;
    }
    if (rithmicOrderCount !== null && databentoLevel.order_count !== null) {
      accumulator.ask_top_order_count_comparable_count += 1;
      if (rithmicOrderCount === databentoLevel.order_count) {
        accumulator.ask_top_order_count_exact_match_count += 1;
      }
    }
  }
  return priceWithinOneTick;
}

function finalizeTemporalScore(accumulator: TemporalScoreAccumulator): Mbp10TemporalPolicyScore {
  return {
    lookup_policy: accumulator.lookup_policy,
    timestamp_basis: accumulator.timestamp_basis,
    offset_ms: accumulator.offset_ms,
    compared_samples: accumulator.compared_samples,
    unmatched_samples: accumulator.unmatched_samples,
    bid_top_price_within_1_tick_pct: pct(
      accumulator.bid_top_price_within_one_tick_count,
      accumulator.bid_top_price_comparable_count,
    ),
    ask_top_price_within_1_tick_pct: pct(
      accumulator.ask_top_price_within_one_tick_count,
      accumulator.ask_top_price_comparable_count,
    ),
    both_sides_top_price_within_1_tick_pct: pct(
      accumulator.both_sides_top_price_within_one_tick_count,
      accumulator.both_sides_top_price_comparable_count,
    ),
    depth_price_within_1_tick_pct: pct(
      accumulator.depth_price_within_one_tick_count,
      accumulator.depth_price_comparable_count,
    ),
    bid_top_size_exact_match_pct: pct(
      accumulator.bid_top_size_exact_match_count,
      accumulator.bid_top_size_comparable_count,
    ),
    ask_top_size_exact_match_pct: pct(
      accumulator.ask_top_size_exact_match_count,
      accumulator.ask_top_size_comparable_count,
    ),
    bid_top_order_count_exact_match_pct: pct(
      accumulator.bid_top_order_count_exact_match_count,
      accumulator.bid_top_order_count_comparable_count,
    ),
    ask_top_order_count_exact_match_pct: pct(
      accumulator.ask_top_order_count_exact_match_count,
      accumulator.ask_top_order_count_comparable_count,
    ),
  };
}

function selectSnapshotIndex(
  snapshotIndex: RithmicTopOfBookSnapshotIndex,
  targetTsNs: bigint,
  lookupPolicy: Mbp10LookupPolicy,
): number {
  if (snapshotIndex.ts_ns.length === 0) {
    return -1;
  }
  const previous = findPreviousSnapshotIndex(snapshotIndex.ts_ns, targetTsNs);
  if (lookupPolicy === 'previous_or_equal') {
    return previous;
  }
  const next = findNextSnapshotIndex(snapshotIndex.ts_ns, targetTsNs);
  if (lookupPolicy === 'next_or_equal') {
    return next;
  }
  if (previous < 0) {
    return next;
  }
  if (next < 0) {
    return previous;
  }
  const previousDelta = targetTsNs - snapshotIndex.ts_ns[previous]!;
  const nextDelta = snapshotIndex.ts_ns[next]! - targetTsNs;
  return previousDelta <= nextDelta ? previous : next;
}

function findPreviousSnapshotIndex(values: BigInt64Array, target: bigint): number {
  let low = 0;
  let high = values.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle]! <= target) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function findNextSnapshotIndex(values: BigInt64Array, target: bigint): number {
  let low = 0;
  let high = values.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle]! >= target) {
      result = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return result;
}

function getSnapshotPrice(
  snapshotIndex: RithmicTopOfBookSnapshotIndex,
  updateIndex: number,
  side: BookSide,
  level: number,
): number | null {
  const value = side === 'bid'
    ? snapshotIndex.bid_px[snapshotArrayIndex(updateIndex, level)]!
    : snapshotIndex.ask_px[snapshotArrayIndex(updateIndex, level)]!;
  return Number.isNaN(value) ? null : value;
}

function getSnapshotSize(
  snapshotIndex: RithmicTopOfBookSnapshotIndex,
  updateIndex: number,
  side: BookSide,
  level: number,
): number | null {
  const value = side === 'bid'
    ? snapshotIndex.bid_sz[snapshotArrayIndex(updateIndex, level)]!
    : snapshotIndex.ask_sz[snapshotArrayIndex(updateIndex, level)]!;
  return value < 0 ? null : value;
}

function getSnapshotOrderCount(
  snapshotIndex: RithmicTopOfBookSnapshotIndex,
  updateIndex: number,
  side: BookSide,
  level: number,
): number | null {
  const value = side === 'bid'
    ? snapshotIndex.bid_order_count[snapshotArrayIndex(updateIndex, level)]!
    : snapshotIndex.ask_order_count[snapshotArrayIndex(updateIndex, level)]!;
  return value < 0 ? null : value;
}

function snapshotArrayIndex(updateIndex: number, level: number): number {
  return updateIndex * (MAX_DEPTH_LEVEL + 1) + level;
}

interface MismatchClusterAccumulator {
  price_mismatch_sample_count: number;
  price_match_sample_count: number;
  max_consecutive_mismatch_run: number;
  current_cluster_start_ts_ns: string | null;
  current_cluster_end_ts_ns: string | null;
  current_cluster_sample_count: number;
  readonly first_clusters: Mbp10MismatchCluster[];
  readonly minute_buckets: Map<string, { compared_samples: number; price_mismatch_samples: number }>;
}

function createMismatchClusterAccumulator(): MismatchClusterAccumulator {
  return {
    price_mismatch_sample_count: 0,
    price_match_sample_count: 0,
    max_consecutive_mismatch_run: 0,
    current_cluster_start_ts_ns: null,
    current_cluster_end_ts_ns: null,
    current_cluster_sample_count: 0,
    first_clusters: [],
    minute_buckets: new Map<string, { compared_samples: number; price_mismatch_samples: number }>(),
  };
}

function updateMismatchClusters(
  accumulator: MismatchClusterAccumulator,
  snapshotIndex: RithmicTopOfBookSnapshotIndex,
  databentoSample: BookSample,
  selectedIndex: number,
): void {
  if (selectedIndex < 0) {
    return;
  }
  const bidWithin = topPriceWithinOneTick(snapshotIndex, databentoSample, selectedIndex, 'bid');
  const askWithin = topPriceWithinOneTick(snapshotIndex, databentoSample, selectedIndex, 'ask');
  if (bidWithin === null || askWithin === null) {
    return;
  }
  const isMismatch = !(bidWithin && askWithin);
  const bucketKey = minuteBucketStartTsNs(databentoSample.ts_ns);
  const bucket = accumulator.minute_buckets.get(bucketKey) ?? {
    compared_samples: 0,
    price_mismatch_samples: 0,
  };
  bucket.compared_samples += 1;
  if (isMismatch) {
    bucket.price_mismatch_samples += 1;
  }
  accumulator.minute_buckets.set(bucketKey, bucket);

  if (isMismatch) {
    accumulator.price_mismatch_sample_count += 1;
    if (accumulator.current_cluster_start_ts_ns === null) {
      accumulator.current_cluster_start_ts_ns = databentoSample.ts_ns;
      accumulator.current_cluster_sample_count = 0;
    }
    accumulator.current_cluster_end_ts_ns = databentoSample.ts_ns;
    accumulator.current_cluster_sample_count += 1;
    accumulator.max_consecutive_mismatch_run = Math.max(
      accumulator.max_consecutive_mismatch_run,
      accumulator.current_cluster_sample_count,
    );
  } else {
    accumulator.price_match_sample_count += 1;
    closeCurrentMismatchCluster(accumulator);
  }
}

function closeCurrentMismatchCluster(accumulator: MismatchClusterAccumulator): void {
  if (accumulator.current_cluster_start_ts_ns === null || accumulator.current_cluster_end_ts_ns === null) {
    return;
  }
  if (accumulator.first_clusters.length < 20) {
    accumulator.first_clusters.push({
      start_ts_ns: accumulator.current_cluster_start_ts_ns,
      end_ts_ns: accumulator.current_cluster_end_ts_ns,
      sample_count: accumulator.current_cluster_sample_count,
    });
  }
  accumulator.current_cluster_start_ts_ns = null;
  accumulator.current_cluster_end_ts_ns = null;
  accumulator.current_cluster_sample_count = 0;
}

function finalizeMismatchClusters(accumulator: MismatchClusterAccumulator): Mbp10MismatchClusterReport {
  closeCurrentMismatchCluster(accumulator);
  return {
    basis: 'previous_or_equal_ts_event_offset_0',
    price_mismatch_sample_count: accumulator.price_mismatch_sample_count,
    price_match_sample_count: accumulator.price_match_sample_count,
    max_consecutive_mismatch_run: accumulator.max_consecutive_mismatch_run,
    first_clusters: accumulator.first_clusters,
    mismatch_rate_per_minute: [...accumulator.minute_buckets.entries()]
      .sort(([left], [right]) => compareDecimalIntegerStrings(left, right))
      .map(([bucketStartTsNs, bucket]) => ({
        bucket_start_ts_ns: bucketStartTsNs,
        compared_samples: bucket.compared_samples,
        price_mismatch_samples: bucket.price_mismatch_samples,
        mismatch_rate_pct: pct(bucket.price_mismatch_samples, bucket.compared_samples),
      })),
    volatile_period_correlation: {
      status: 'not_available',
      reason: 'No normalized trade input path is provided to this analyzer.',
    },
  };
}

function topPriceWithinOneTick(
  snapshotIndex: RithmicTopOfBookSnapshotIndex,
  databentoSample: BookSample,
  selectedIndex: number,
  side: BookSide,
): boolean | null {
  const rithmicPx = getSnapshotPrice(snapshotIndex, selectedIndex, side, 0);
  const databentoLevel = findLevel(databentoSample, side, 0);
  if (rithmicPx === null || databentoLevel === null) {
    return null;
  }
  return Math.abs(rithmicPx - databentoLevel.px) <= MNQ_TICK_SIZE;
}

function minuteBucketStartTsNs(tsNs: string): string {
  const minuteNs = 60_000_000_000n;
  return ((BigInt(tsNs) / minuteNs) * minuteNs).toString();
}

function bestLookupPolicy(scores: Readonly<Record<Mbp10LookupPolicy, Mbp10TemporalPolicyScore>>): Mbp10LookupPolicy {
  return (Object.keys(scores) as Mbp10LookupPolicy[]).sort((left, right) => {
    const scoreComparison = compareNullablePct(
      scores[right]!.both_sides_top_price_within_1_tick_pct,
      scores[left]!.both_sides_top_price_within_1_tick_pct,
    );
    if (scoreComparison !== 0) return scoreComparison;
    return compareStrings(left, right);
  })[0]!;
}

function bestLagScore(scores: readonly Mbp10LagScanScore[]): Mbp10LagScanScore {
  return [...scores].sort((left, right) => {
    const scoreComparison = compareNullablePct(
      right.both_sides_top_price_within_1_tick_pct,
      left.both_sides_top_price_within_1_tick_pct,
    );
    if (scoreComparison !== 0) return scoreComparison;
    return Math.abs(left.offset_ms) - Math.abs(right.offset_ms) || left.offset_ms - right.offset_ms;
  })[0]!;
}

function bestTimestampBasisName(scores: {
  readonly ts_event: Mbp10TemporalPolicyScore;
  readonly ts_recv: Mbp10TemporalPolicyScore | null;
}): Mbp10TimestampBasis {
  if (scores.ts_recv === null) {
    return 'ts_event';
  }
  return compareNullablePct(
    scores.ts_recv.both_sides_top_price_within_1_tick_pct,
    scores.ts_event.both_sides_top_price_within_1_tick_pct,
  ) > 0
    ? 'ts_recv'
    : 'ts_event';
}

function classifyTemporalAlignment(args: {
  readonly lookupPolicyScores: Readonly<Record<Mbp10LookupPolicy, Mbp10TemporalPolicyScore>>;
  readonly bestPolicy: Mbp10LookupPolicy;
  readonly bestLag: Mbp10LagScanScore;
  readonly bestTimestampBasis: Mbp10TimestampBasis;
  readonly timestampBasisScores: {
    readonly ts_event: Mbp10TemporalPolicyScore;
    readonly ts_recv: Mbp10TemporalPolicyScore | null;
  };
}): Mbp10TemporalAlignmentClassification {
  const previousScore = scoreValue(args.lookupPolicyScores.previous_or_equal);
  const bestPolicyScore = scoreValue(args.lookupPolicyScores[args.bestPolicy]);
  const bestLagScoreValue = scoreValue(args.bestLag);
  const tsRecvScore = args.timestampBasisScores.ts_recv === null ? null : scoreValue(args.timestampBasisScores.ts_recv);
  if (args.bestLag.offset_ms !== 0 && bestLagScoreValue >= 99) {
    return 'temporal_alignment_offset_required';
  }
  if (args.bestPolicy !== 'previous_or_equal' && bestPolicyScore >= 99 && bestPolicyScore > previousScore + 1) {
    return 'sampling_policy_mismatch';
  }
  if (
    args.bestTimestampBasis === 'ts_recv' &&
    tsRecvScore !== null &&
    tsRecvScore >= 99 &&
    tsRecvScore > previousScore + 1
  ) {
    return 'timestamp_basis_mismatch';
  }
  return 'persistent_price_level_reconstruction_mismatch';
}

function recommendationForTemporalClassification(classification: Mbp10TemporalAlignmentClassification): string {
  if (classification === 'temporal_alignment_offset_required') {
    return 'A nonzero lag offset lifts price parity above threshold; document the offset sign and validate timestamp semantics before using Databento MBP10 parity as gate evidence.';
  }
  if (classification === 'sampling_policy_mismatch') {
    return 'Nearest/next-state lookup materially improves price parity; review whether Databento samples represent post-update state while Rithmic comparison is using previous-state sampling.';
  }
  if (classification === 'timestamp_basis_mismatch') {
    return 'Timestamp basis changes materially improve parity; inspect Databento ts_event vs ts_recv semantics before revising INFRA-01 policy.';
  }
  return 'No tested lookup policy, lag offset, or timestamp basis lifts price parity above threshold; keep DATA-01B blocked and inspect reconstruction/alignment assumptions further.';
}

function scoreValue(score: Mbp10TemporalPolicyScore): number {
  return score.both_sides_top_price_within_1_tick_pct ?? -1;
}

function compareNullablePct(left: number | null, right: number | null): number {
  return (left ?? -1) - (right ?? -1);
}

function updateComponentParity(
  accumulator: ComponentParityAccumulator,
  rithmicSample: BookSample,
  databentoSample: BookSample,
): void {
  accumulator.compared_samples += 1;
  let topBidWithinOneTick: boolean | null = null;
  let topAskWithinOneTick: boolean | null = null;

  for (const side of ['bid', 'ask'] as const) {
    for (let level = 0; level <= MAX_DEPTH_LEVEL; level += 1) {
      const rithmicLevel = findLevel(rithmicSample, side, level);
      const databentoLevel = findLevel(databentoSample, side, level);
      const stats = mustGetLevelStats(accumulator.level_stats, side, level);
      const result = updateComponentLevelStats({
        stats,
        accumulator,
        rithmicSample,
        databentoSample,
        side,
        level,
        rithmicLevel,
        databentoLevel,
      });

      if (level === 0) {
        if (side === 'bid') {
          topBidWithinOneTick = result.priceWithinOneTick;
        } else {
          topAskWithinOneTick = result.priceWithinOneTick;
        }
      }
    }
  }

  if (topBidWithinOneTick !== null && topAskWithinOneTick !== null) {
    accumulator.top_both_sides_price_comparable_count += 1;
    if (topBidWithinOneTick && topAskWithinOneTick) {
      accumulator.top_both_sides_price_within_one_tick_count += 1;
    }
  }
}

function updateComponentLevelStats(args: {
  readonly stats: MutableComponentLevelStats;
  readonly accumulator: ComponentParityAccumulator;
  readonly rithmicSample: BookSample;
  readonly databentoSample: BookSample;
  readonly side: BookSide;
  readonly level: number;
  readonly rithmicLevel: BookLevel | null;
  readonly databentoLevel: BookLevel | null;
}): { readonly priceWithinOneTick: boolean | null } {
  args.stats.compared_count += 1;

  if (args.rithmicLevel === null && args.databentoLevel === null) {
    args.stats.both_missing_count += 1;
    return { priceWithinOneTick: null };
  }
  if (args.rithmicLevel === null || args.databentoLevel === null) {
    if (args.rithmicLevel === null) {
      args.stats.missing_rithmic_count += 1;
    } else {
      args.stats.missing_databento_count += 1;
    }
    args.accumulator.mismatch_breakdown.missing_level_count += 1;
    pushLimitedMismatch(args.accumulator.first_mismatches.level_presence_mismatches, {
      rithmicSample: args.rithmicSample,
      databentoSample: args.databentoSample,
      side: args.side,
      level: args.level,
      rithmicLevel: args.rithmicLevel,
      databentoLevel: args.databentoLevel,
      classification: 'level_presence_mismatch',
    });
    return { priceWithinOneTick: null };
  }

  args.stats.both_present_count += 1;
  args.stats.price_comparable_count += 1;
  args.stats.size_comparable_count += 1;
  const priceDelta = Math.abs(args.rithmicLevel.px - args.databentoLevel.px);
  const priceWithinOneTick = priceDelta <= MNQ_TICK_SIZE;
  const exactPriceMatch = args.rithmicLevel.px === args.databentoLevel.px;
  const sizeDelta = Math.abs(args.rithmicLevel.sz - args.databentoLevel.sz);
  const sizeMatches = sizeDelta === 0;

  if (priceWithinOneTick) {
    args.stats.price_within_one_tick_count += 1;
  }
  if (exactPriceMatch) {
    args.stats.exact_price_match_count += 1;
  }
  if (sizeMatches) {
    args.stats.size_exact_match_count += 1;
  }
  args.stats.size_abs_delta.record(sizeDelta);
  args.stats.size_relative_delta.record(relativeDelta(sizeDelta, args.databentoLevel.sz));

  const hasComparableOrderCount =
    args.rithmicLevel.order_count !== null && args.databentoLevel.order_count !== null;
  let orderCountMismatch = false;
  if (hasComparableOrderCount) {
    args.stats.order_count_comparable_count += 1;
    const orderCountDelta = Math.abs(args.rithmicLevel.order_count! - args.databentoLevel.order_count!);
    orderCountMismatch = orderCountDelta !== 0;
    if (!orderCountMismatch) {
      args.stats.order_count_exact_match_count += 1;
    }
    args.stats.order_count_abs_delta.record(orderCountDelta);
  } else {
    args.stats.missing_order_count_count += 1;
  }

  const priceMismatch = !priceWithinOneTick;
  const sizeMismatch = !sizeMatches;
  recordComponentMismatchBreakdown(args.accumulator.mismatch_breakdown, {
    priceMismatch,
    sizeMismatch,
    orderCountMismatch,
  });

  if (priceMismatch) {
    pushLimitedMismatch(args.accumulator.first_mismatches.price_mismatches, {
      rithmicSample: args.rithmicSample,
      databentoSample: args.databentoSample,
      side: args.side,
      level: args.level,
      rithmicLevel: args.rithmicLevel,
      databentoLevel: args.databentoLevel,
      classification: 'price_mismatch',
    });
  }
  if (sizeMismatch) {
    pushLimitedMismatch(args.accumulator.first_mismatches.size_mismatches, {
      rithmicSample: args.rithmicSample,
      databentoSample: args.databentoSample,
      side: args.side,
      level: args.level,
      rithmicLevel: args.rithmicLevel,
      databentoLevel: args.databentoLevel,
      classification: 'size_mismatch',
    });
  }
  if (orderCountMismatch) {
    pushLimitedMismatch(args.accumulator.first_mismatches.order_count_mismatches, {
      rithmicSample: args.rithmicSample,
      databentoSample: args.databentoSample,
      side: args.side,
      level: args.level,
      rithmicLevel: args.rithmicLevel,
      databentoLevel: args.databentoLevel,
      classification: 'order_count_mismatch',
    });
  }

  return { priceWithinOneTick };
}

function finalizeComponentParity(accumulator: ComponentParityAccumulator): Mbp10ComponentParityReport {
  const bidTop = mustGetLevelStats(accumulator.level_stats, 'bid', 0);
  const askTop = mustGetLevelStats(accumulator.level_stats, 'ask', 0);
  const depthByLevel = [...accumulator.level_stats.values()]
    .sort((left, right) => left.level - right.level || compareStrings(left.side, right.side))
    .map(finalizeComponentLevelStats);

  const topOfBook: Mbp10TopOfBookComponentParity = {
    bid_price_within_1_tick_pct: pct(bidTop.price_within_one_tick_count, bidTop.price_comparable_count),
    ask_price_within_1_tick_pct: pct(askTop.price_within_one_tick_count, askTop.price_comparable_count),
    both_sides_price_within_1_tick_pct: pct(
      accumulator.top_both_sides_price_within_one_tick_count,
      accumulator.top_both_sides_price_comparable_count,
    ),
    bid_size_exact_match_pct: pct(bidTop.size_exact_match_count, bidTop.size_comparable_count),
    ask_size_exact_match_pct: pct(askTop.size_exact_match_count, askTop.size_comparable_count),
    bid_order_count_exact_match_pct: pct(
      bidTop.order_count_exact_match_count,
      bidTop.order_count_comparable_count,
    ),
    ask_order_count_exact_match_pct: pct(
      askTop.order_count_exact_match_count,
      askTop.order_count_comparable_count,
    ),
    bid_missing_order_count_count: bidTop.missing_order_count_count,
    ask_missing_order_count_count: askTop.missing_order_count_count,
    top_bid_size_abs_delta: bidTop.size_abs_delta.summary(),
    top_ask_size_abs_delta: askTop.size_abs_delta.summary(),
  };

  const presenceMatchPct = pct(
    sumLevelStats(accumulator.level_stats, (stats) => stats.both_present_count + stats.both_missing_count),
    sumLevelStats(accumulator.level_stats, (stats) => stats.compared_count),
  );
  const classification = classifyComponentParity({
    topOfBook,
    presenceMatchPct,
  });

  return {
    compared_samples: accumulator.compared_samples,
    top_of_book: topOfBook,
    depth_by_level: depthByLevel,
    mismatch_breakdown: { ...accumulator.mismatch_breakdown },
    first_mismatches: {
      price_mismatches: accumulator.first_mismatches.price_mismatches,
      size_mismatches: accumulator.first_mismatches.size_mismatches,
      order_count_mismatches: accumulator.first_mismatches.order_count_mismatches,
      level_presence_mismatches: accumulator.first_mismatches.level_presence_mismatches,
    },
    classification,
    recommendation: recommendationForComponentClassification(classification),
  };
}

function finalizeComponentLevelStats(stats: MutableComponentLevelStats): Mbp10DepthLevelComponentParity {
  const sizeSummary = stats.size_abs_delta.summary();
  const relativeSizeSummary = stats.size_relative_delta.summary();
  const orderCountSummary = stats.order_count_abs_delta.summary();
  return {
    level: stats.level,
    side: stats.side,
    compared_count: stats.compared_count,
    both_present_count: stats.both_present_count,
    price_within_1_tick_pct: pct(stats.price_within_one_tick_count, stats.price_comparable_count),
    exact_price_match_pct: pct(stats.exact_price_match_count, stats.price_comparable_count),
    size_exact_match_pct: pct(stats.size_exact_match_count, stats.size_comparable_count),
    size_abs_delta_p50: sizeSummary.p50,
    size_abs_delta_p95: sizeSummary.p95,
    size_abs_delta_p99: sizeSummary.p99,
    size_relative_delta_p50: relativeSizeSummary.p50,
    size_relative_delta_p95: relativeSizeSummary.p95,
    size_relative_delta_p99: relativeSizeSummary.p99,
    order_count_exact_match_pct: pct(
      stats.order_count_exact_match_count,
      stats.order_count_comparable_count,
    ),
    order_count_abs_delta_p50: orderCountSummary.p50,
    order_count_abs_delta_p95: orderCountSummary.p95,
    order_count_abs_delta_p99: orderCountSummary.p99,
    missing_order_count_count: stats.missing_order_count_count,
    presence_match_pct: pct(stats.both_present_count + stats.both_missing_count, stats.compared_count),
  };
}

function classifyComponentParity(args: {
  readonly topOfBook: Mbp10TopOfBookComponentParity;
  readonly presenceMatchPct: number | null;
}): Mbp10ComponentParityClassification {
  const pricePct = args.topOfBook.both_sides_price_within_1_tick_pct ?? 0;
  const presencePct = args.presenceMatchPct ?? 0;
  const bidSizePct = args.topOfBook.bid_size_exact_match_pct ?? 0;
  const askSizePct = args.topOfBook.ask_size_exact_match_pct ?? 0;
  const bidOrderCountPct = args.topOfBook.bid_order_count_exact_match_pct ?? 0;
  const askOrderCountPct = args.topOfBook.ask_order_count_exact_match_pct ?? 0;
  const sizeOrderPct = Math.min(bidSizePct, askSizePct, bidOrderCountPct, askOrderCountPct);

  if (presencePct < 95) {
    return 'book_depth_presence_mismatch';
  }
  if (pricePct < 99) {
    return 'price_level_reconstruction_mismatch';
  }
  if (pricePct >= 99 && sizeOrderPct < 99) {
    return 'size_order_count_semantics_mismatch';
  }
  if (pricePct >= 99 && sizeOrderPct >= 99 && presencePct >= 99) {
    return 'mbp10_parity_component_pass';
  }
  return 'inconclusive_component_mismatch';
}

function recommendationForComponentClassification(classification: Mbp10ComponentParityClassification): string {
  if (classification === 'size_order_count_semantics_mismatch') {
    return 'Price parity is strong while size/order-count mismatches dominate; review Rithmic vs Databento size and order-count semantics before failing market-state parity.';
  }
  if (classification === 'price_level_reconstruction_mismatch') {
    return 'Price parity is below threshold; revisit Rithmic and Databento book reconstruction before treating size or order-count scores as meaningful.';
  }
  if (classification === 'book_depth_presence_mismatch') {
    return 'Level presence parity is weak; compare sampling alignment, depth availability, and update application rules before interpreting component mismatches.';
  }
  if (classification === 'mbp10_parity_component_pass') {
    return 'Component parity is strong; reviewer may use this as parity evidence, but DATA-01 still requires explicit INFRA-01 verification.';
  }
  return 'Component results are mixed; inspect first mismatch examples and side/level summaries before making an INFRA-01 policy decision.';
}

function recordComponentMismatchBreakdown(
  breakdown: MutableComponentMismatchBreakdown,
  flags: {
    readonly priceMismatch: boolean;
    readonly sizeMismatch: boolean;
    readonly orderCountMismatch: boolean;
  },
): void {
  const mismatchCount =
    Number(flags.priceMismatch) + Number(flags.sizeMismatch) + Number(flags.orderCountMismatch);
  if (mismatchCount === 0) {
    return;
  }
  if (flags.priceMismatch && !flags.sizeMismatch && !flags.orderCountMismatch) {
    breakdown.price_only_mismatch_count += 1;
  } else if (!flags.priceMismatch && flags.sizeMismatch && !flags.orderCountMismatch) {
    breakdown.size_only_mismatch_count += 1;
  } else if (!flags.priceMismatch && !flags.sizeMismatch && flags.orderCountMismatch) {
    breakdown.order_count_only_mismatch_count += 1;
  } else if (flags.priceMismatch && flags.sizeMismatch) {
    breakdown.price_and_size_mismatch_count += 1;
  } else {
    breakdown.mixed_component_mismatch_count += 1;
  }
}

function pushLimitedMismatch(
  collection: Mbp10ComponentMismatchExample[],
  args: {
    readonly rithmicSample: BookSample;
    readonly databentoSample: BookSample;
    readonly side: BookSide;
    readonly level: number;
    readonly rithmicLevel: BookLevel | null;
    readonly databentoLevel: BookLevel | null;
    readonly classification: Mbp10ComponentMismatchExample['classification'];
  },
): void {
  if (collection.length >= 20) {
    return;
  }
  collection.push({
    exchange_event_ts_ns: args.databentoSample.ts_ns,
    rithmic_ts_ns: args.rithmicSample.ts_ns,
    side: args.side,
    level: args.level,
    rithmic_px: args.rithmicLevel?.px ?? null,
    rithmic_size: args.rithmicLevel?.sz ?? null,
    rithmic_order_count: args.rithmicLevel?.order_count ?? null,
    databento_px: args.databentoLevel?.px ?? null,
    databento_size: args.databentoLevel?.sz ?? null,
    databento_order_count: args.databentoLevel?.order_count ?? null,
    price_delta:
      args.rithmicLevel !== null && args.databentoLevel !== null
        ? normalizeDeltaKey(args.rithmicLevel.px - args.databentoLevel.px)
        : null,
    size_delta:
      args.rithmicLevel !== null && args.databentoLevel !== null
        ? normalizeDeltaKey(args.rithmicLevel.sz - args.databentoLevel.sz)
        : null,
    order_count_delta:
      args.rithmicLevel?.order_count !== null &&
      args.rithmicLevel?.order_count !== undefined &&
      args.databentoLevel?.order_count !== null &&
      args.databentoLevel?.order_count !== undefined
        ? normalizeDeltaKey(args.rithmicLevel.order_count - args.databentoLevel.order_count)
        : null,
    nearest_l1_quote: null,
    classification: args.classification,
  });
}

function mustGetLevelStats(
  stats: ReadonlyMap<string, MutableComponentLevelStats>,
  side: BookSide,
  level: number,
): MutableComponentLevelStats {
  const value = stats.get(componentLevelKey(side, level));
  if (value === undefined) {
    throw new Error(`Missing component stats bucket for ${side} ${level}`);
  }
  return value;
}

function componentLevelKey(side: BookSide, level: number): string {
  return `${side}_${level}`;
}

function pct(numerator: number, denominator: number): number | null {
  if (denominator === 0) {
    return null;
  }
  return normalizeDeltaKey((numerator / denominator) * 100);
}

function normalizeDeltaKey(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function relativeDelta(absDelta: number, referenceValue: number): number {
  if (referenceValue === 0) {
    return absDelta === 0 ? 0 : 1;
  }
  return normalizeDeltaKey(absDelta / Math.abs(referenceValue));
}

function sumLevelStats(
  stats: ReadonlyMap<string, MutableComponentLevelStats>,
  select: (stats: MutableComponentLevelStats) => number,
): number {
  let total = 0;
  for (const value of stats.values()) {
    total += select(value);
  }
  return total;
}

function normalizeRithmicMbp10Row(record: Record<string, unknown>, recordIndex: number): ParsedRithmicMbp10Row {
  return {
    record_index: recordIndex,
    ts_ns: optionalDecimalString(record, ['exchange_event_ts_ns']),
    bids: normalizeLevelsArray(record.bids, recordIndex, 'bid'),
    asks: normalizeLevelsArray(record.asks, recordIndex, 'ask'),
  };
}

function normalizeDatabentoMbp10Record(record: Record<string, unknown>, recordIndex: number): BookSample | null {
  const tsNs = optionalDecimalString(record, ['ts_event_ns', 'ts_event', 'exchange_event_ts_ns']);
  if (tsNs === null) {
    return null;
  }

  const bids = normalizeDatabentoSide(record, 'bid');
  const asks = normalizeDatabentoSide(record, 'ask');
  if (bids.length === 0 && asks.length === 0) {
    return null;
  }

  return {
    ts_ns: tsNs,
    bids,
    asks,
    source_record_index: recordIndex,
  };
}

function normalizeDatabentoSide(record: Record<string, unknown>, side: BookSide): readonly BookLevel[] {
  if (Array.isArray(record[`${side}s`])) {
    return normalizeLevelsArray(record[`${side}s`], 0, side);
  }

  const levels: BookLevel[] = [];
  for (let level = 0; level <= MAX_DEPTH_LEVEL; level += 1) {
    const suffix = String(level).padStart(2, '0');
    const px = optionalFiniteNumber(record, [`${side}_px_${suffix}`, `${side}_px_${level}`]);
    const sz = optionalFiniteNumber(record, [`${side}_sz_${suffix}`, `${side}_sz_${level}`]);
    const orderCount = optionalFiniteInteger(record, [
      `${side}_ct_${suffix}`,
      `${side}_ct_${level}`,
      `${side}_count_${suffix}`,
      `${side}_count_${level}`,
      `${side}_order_count_${suffix}`,
      `${side}_order_count_${level}`,
    ]);
    if (px !== null && sz !== null) {
      levels.push({
        level,
        px,
        sz,
        order_count: orderCount,
      });
    }
  }
  return levels;
}

function normalizeLevelsArray(value: unknown, recordIndex: number, side: BookSide): readonly BookLevel[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`record ${recordIndex}: ${side}s must be an array when present`);
  }

  return value
    .map((entry, index) => normalizeLevel(entry, recordIndex, side, index))
    .filter((level): level is BookLevel => level !== null)
    .sort((left, right) => left.level - right.level);
}

function normalizeLevel(
  value: unknown,
  recordIndex: number,
  side: BookSide,
  arrayIndex: number,
): BookLevel | null {
  if (!isRecord(value)) {
    throw new Error(`record ${recordIndex}: ${side}s[${arrayIndex}] must be an object`);
  }

  const level = optionalFiniteInteger(value, ['level']);
  const px = optionalFiniteNumber(value, ['px', 'price']);
  const sz = optionalFiniteNumber(value, ['sz', 'size']);
  const orderCount = optionalFiniteInteger(value, ['order_count', 'orders', 'ct', 'count']);

  if (px === null || sz === null) {
    return null;
  }

  return {
    level: level ?? arrayIndex,
    px,
    sz,
    order_count: orderCount,
  };
}

function isMbp10Record(record: unknown): record is Record<string, unknown> {
  if (!isRecord(record)) {
    return false;
  }
  const stream = firstField(record, ['stream', 'stream_id', 'payload_kind']);
  return stream === 'MBP10';
}

function emptyBookState(): BookState {
  return {
    bids: new Map<number, BookLevel>(),
    asks: new Map<number, BookLevel>(),
  };
}

function cloneBookState(state: BookState): BookState {
  return {
    bids: new Map<number, BookLevel>(state.bids),
    asks: new Map<number, BookLevel>(state.asks),
  };
}

function applyBookUpdate(state: BookState, row: ParsedRithmicMbp10Row): void {
  for (const level of row.bids) {
    applyPriceLevelUpdate(state.bids, level);
  }
  for (const level of row.asks) {
    applyPriceLevelUpdate(state.asks, level);
  }
}

function stateToSample(state: BookState, tsNs: string, sourceRecordIndex: number): BookSample {
  return {
    ts_ns: tsNs,
    bids: levelsFromPriceMap(state.bids, 'bid'),
    asks: levelsFromPriceMap(state.asks, 'ask'),
    source_record_index: sourceRecordIndex,
  };
}

function applyPriceLevelUpdate(levels: Map<number, BookLevel>, level: BookLevel): void {
  if (level.sz <= 0) {
    levels.delete(level.px);
    return;
  }
  levels.set(level.px, level);
}

function levelsFromPriceMap(levels: ReadonlyMap<number, BookLevel>, side: BookSide): readonly BookLevel[] {
  return [...levels.values()]
    .filter((level) => level.px > 0 && level.sz > 0)
    .sort((left, right) => (side === 'bid' ? right.px - left.px : left.px - right.px))
    .slice(0, MAX_DEPTH_LEVEL + 1)
    .map((level, index) => ({
      ...level,
      level: index,
    }));
}

function findLevel(sample: BookSample, side: BookSide, level: number): BookLevel | null {
  const levels = side === 'bid' ? sample.bids : sample.asks;
  return levels.find((item) => item.level === level) ?? null;
}

interface MutableFieldParitySummary {
  comparable_field_count: number;
  matching_field_count: number;
  mismatch_count: number;
  missing_rithmic_level_count: number;
  missing_databento_level_count: number;
}

function emptyFieldParitySummary(): MutableFieldParitySummary {
  return {
    comparable_field_count: 0,
    matching_field_count: 0,
    mismatch_count: 0,
    missing_rithmic_level_count: 0,
    missing_databento_level_count: 0,
  };
}

function finalizeFieldParitySummary(summary: MutableFieldParitySummary): FieldParitySummary {
  return { ...summary };
}

function sortSamplesByTimestamp(samples: readonly BookSample[]): readonly BookSample[] {
  return [...samples].sort((left, right) => {
    const tsComparison = compareDecimalIntegerStrings(left.ts_ns, right.ts_ns);
    if (tsComparison !== 0) {
      return tsComparison;
    }
    return left.source_record_index - right.source_record_index;
  });
}

function readJsonl(path: string, label: string): readonly unknown[] {
  const records: unknown[] = [];
  forEachJsonlLine(path, (trimmed, lineNumber) => {
    try {
      records.push(JSON.parse(trimmed));
    } catch (error) {
      throw new Error(
        `${label} line ${lineNumber}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  return records;
}

function optionalDecimalString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  const value = firstField(record, keys);
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  throw new Error(`${keys.join('/')} must be a decimal nanosecond string or safe integer`);
}

function optionalFiniteNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  const value = firstField(record, keys);
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error(`${keys.join('/')} must be a finite number when present`);
}

function optionalFiniteInteger(record: Record<string, unknown>, keys: readonly string[]): number | null {
  const value = optionalFiniteNumber(record, keys);
  if (value === null) {
    return null;
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${keys.join('/')} must be an integer when present`);
  }
  return value;
}

function firstField(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(record, key)) {
      return record[key];
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareDecimalIntegerStrings(left: string, right: string): number {
  const leftNegative = left.startsWith('-');
  const rightNegative = right.startsWith('-');
  if (leftNegative !== rightNegative) {
    return leftNegative ? -1 : 1;
  }
  const leftAbs = trimInteger(leftNegative ? left.slice(1) : left);
  const rightAbs = trimInteger(rightNegative ? right.slice(1) : right);
  const absComparison = comparePositiveIntegerStrings(leftAbs, rightAbs);
  return leftNegative ? -absComparison : absComparison;
}

function compareBigInt(left: bigint, right: bigint): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function comparePositiveIntegerStrings(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length < right.length ? -1 : 1;
  }
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function trimInteger(value: string): string {
  const trimmed = value.replace(/^0+/, '');
  return trimmed === '' ? '0' : trimmed;
}

function sortRecordByKey(record: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => compareStrings(left, right)));
}

function totalMismatchCount(record: Readonly<Record<string, number>>): number {
  return Object.values(record).reduce((total, value) => total + value, 0);
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function usage(): string {
  return [
    'Usage: npm run infra:analyze-databento-parity -- --rithmic-probe <probe.jsonl> --databento-mbp10 <mbp10.jsonl> [--databento-mbp1 <mbp1.jsonl>] --out <report.json>',
    '',
    `Default --out: ${DEFAULT_REPORT_PATH}`,
    '',
    'Databento inputs must be normalized JSONL with decimal-ns ts_event_ns and BBO/MBP10 levels.',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): CliArgs {
  let rithmicProbePath: string | undefined;
  let databentoMbp10Path: string | undefined;
  let databentoMbp1Path: string | undefined;
  let outPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      throw new Error(usage());
    }
    if (arg === '--rithmic-probe') {
      rithmicProbePath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--databento-mbp10') {
      databentoMbp10Path = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--databento-mbp1') {
      databentoMbp1Path = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--out') {
      outPath = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }

  if (!rithmicProbePath) {
    throw new Error(`--rithmic-probe is required\n${usage()}`);
  }
  if (!databentoMbp10Path) {
    throw new Error(`--databento-mbp10 is required\n${usage()}`);
  }

  return {
    rithmic_probe_path: rithmicProbePath,
    databento_mbp10_path: databentoMbp10Path,
    databento_mbp1_path: databentoMbp1Path ?? null,
    out_path: outPath ?? DEFAULT_REPORT_PATH,
  };
}

function main(): void {
  try {
    const args = parseArgs(processArgv.slice(2));
    const report = analyzeDatabentoOverlapParity({
      rithmic_probe_path: args.rithmic_probe_path,
      databento_mbp10_path: args.databento_mbp10_path,
      databento_mbp1_path: args.databento_mbp1_path,
    });
    writeDatabentoOverlapParityReport(report, args.out_path);
    processStdout.write(formatDatabentoOverlapParitySummary(report));
    processExit(0);
  } catch (error) {
    processStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    processExit(3);
  }
}

if (processArgv[1] !== undefined && resolve(processArgv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
