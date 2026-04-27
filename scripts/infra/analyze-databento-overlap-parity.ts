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

const DEFAULT_REPORT_PATH = 'reports/infra/databento_overlap_parity_report.json';
const MAX_DEPTH_LEVEL = 9;
const MISMATCH_LIMIT = 50;

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
  const rithmicRecords = readJsonl(rithmicPath, 'Rithmic probe');
  const databentoRecords = readJsonl(databentoPath, 'Databento MBP10');
  const rithmic = reconstructRithmicMbp10FromRecords(rithmicRecords);
  const databento = normalizeDatabentoMbp10FromRecords(databentoRecords);
  const parity = compareMbp10Samples(rithmic.samples, databento.samples);

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
    databento_mbp10_samples: databento.report,
    mbp10_parity: parity,
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

function normalizeRithmicMbp10Row(record: Record<string, unknown>, recordIndex: number): ParsedRithmicMbp10Row {
  return {
    record_index: recordIndex,
    ts_ns: optionalDecimalString(record, ['exchange_event_ts_ns']),
    bids: normalizeLevelsArray(record.bids, recordIndex, 'bid'),
    asks: normalizeLevelsArray(record.asks, recordIndex, 'ask'),
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
