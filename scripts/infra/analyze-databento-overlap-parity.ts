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
  };
  readonly rithmic_mbp10_reconstruction: RithmicMbp10ReconstructionReport;
  readonly databento_mbp10_samples: DatabentoMbp10NormalizationReport;
  readonly mbp10_parity: Mbp10ParityComparisonReport;
  readonly mbp10_component_parity: Mbp10ComponentParityReport;
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

interface CliArgs {
  readonly rithmic_probe_path: string;
  readonly databento_mbp10_path: string;
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

interface StreamingDatabentoMbp10ParityResult {
  readonly databento_report: DatabentoMbp10NormalizationReport;
  readonly parity_report: Mbp10ParityComparisonReport;
  readonly component_report: Mbp10ComponentParityReport;
}

const DEFAULT_REPORT_PATH = 'reports/infra/databento_overlap_parity_report.json';
const MAX_DEPTH_LEVEL = 9;
const MISMATCH_LIMIT = 50;
const MNQ_TICK_SIZE = 0.25;

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
}): DatabentoOverlapParityReport {
  const rithmicPath = resolve(options.rithmic_probe_path);
  const databentoPath = resolve(options.databento_mbp10_path);
  const rithmic = readRithmicMbp10Updates(rithmicPath);
  const databento = compareDatabentoMbp10JsonlWithRithmicUpdates(databentoPath, rithmic);

  return {
    schema_version: DATABENTO_OVERLAP_PARITY_SCHEMA_VERSION,
    ticket_id: 'DATABENTO-OVERLAP-PARITY',
    status: 'analysis_only',
    data01_eligible: false,
    data01_route: 'blocked_pending_infra01_verification',
    inputs: {
      rithmic_probe_path: rithmicPath,
      databento_mbp10_path: databentoPath,
    },
    rithmic_mbp10_reconstruction: rithmic.report,
    databento_mbp10_samples: databento.databento_report,
    mbp10_parity: databento.parity_report,
    mbp10_component_parity: databento.component_report,
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
    'Usage: npm run infra:analyze-databento-parity -- --rithmic-probe <probe.jsonl> --databento-mbp10 <mbp10.jsonl> --out <report.json>',
    '',
    `Default --out: ${DEFAULT_REPORT_PATH}`,
    '',
    'Databento input must be normalized JSONL with decimal-ns ts_event_ns and MBP10 levels.',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): CliArgs {
  let rithmicProbePath: string | undefined;
  let databentoMbp10Path: string | undefined;
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
    out_path: outPath ?? DEFAULT_REPORT_PATH,
  };
}

function main(): void {
  try {
    const args = parseArgs(processArgv.slice(2));
    const report = analyzeDatabentoOverlapParity({
      rithmic_probe_path: args.rithmic_probe_path,
      databento_mbp10_path: args.databento_mbp10_path,
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
