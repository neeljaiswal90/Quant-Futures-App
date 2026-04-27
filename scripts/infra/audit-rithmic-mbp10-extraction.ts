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

export const RITHMIC_MBP10_AUDIT_SCHEMA_VERSION = 1 as const;

export type BookSide = 'bid' | 'ask';
export type RithmicMbp10AuditStatus = 'analysis_only' | 'fail';
export type RithmicMbp10AuditClassification =
  | 'null_seed_contamination'
  | 'price_scaling_error_suspected'
  | 'field_semantics_mismatch'
  | 'state_stream_incremental_valid'
  | 'extraction_bug_suspected'
  | 'inconclusive';
export type RithmicMbp10AuditRecommendation =
  | 'disable_null_seed_use'
  | 'adjust_price_scaling_after_manual_review'
  | 'inspect_raw_rithmic_proto_fields'
  | 'require_direct_proto_debug_dump'
  | 'proceed_to_databento_mbp10_parity_only_after_internal_rithmic_l1_mbp10_parity_passes';
export type ReconstructionModeName =
  | 'no_null_seed_rows'
  | 'null_seed_rows_allowed'
  | 'reset_book_on_implausible_seed'
  | 'timestamped_rows_only'
  | 'plausible_l1_range_only';

export interface BookLevel {
  readonly level: number;
  readonly px: number;
  readonly sz: number;
  readonly order_count: number | null;
}

export interface L1QuoteSample {
  readonly record_index: number;
  readonly ts_ns: string;
  readonly bid_px: number;
  readonly ask_px: number;
  readonly bid_sz: number | null;
  readonly ask_sz: number | null;
  readonly mid_px: number;
}

export interface Mbp10Row {
  readonly record_index: number;
  readonly ts_ns: string | null;
  readonly timestamp_source: string | null;
  readonly payload_kind: string | null;
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
  readonly field_names: readonly string[];
}

type TimestampedMbp10Row = Mbp10Row & { readonly ts_ns: string };

export interface ReconstructedBookSample {
  readonly ts_ns: string;
  readonly source_record_index: number;
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
}

export interface ProbeParsingReport {
  readonly total_rows: number;
  readonly l1_quote_rows: number;
  readonly l1_quote_rows_with_exchange_ts: number;
  readonly mbp10_rows: number;
  readonly mbp10_null_exchange_ts_rows: number;
  readonly mbp10_timestamped_rows: number;
  readonly mbp10_rows_with_bids: number;
  readonly mbp10_rows_with_asks: number;
  readonly mbp10_rows_with_both_sides: number;
  readonly mbp10_rows_with_one_side_only: number;
}

export interface NullSeedAnalysis {
  readonly allow_null_seed_default: false;
  readonly null_seed_rows_count: number;
  readonly null_seed_rows_with_levels_count: number;
  readonly implausible_null_seed_rows_count: number;
  readonly first_implausible_null_seed_rows: readonly ImplausiblePriceExample[];
}

export interface PriceSanityReport {
  readonly tick_size: number;
  readonly l1_mid_distance_thresholds_points: readonly number[];
  readonly level_count: number;
  readonly tick_aligned_count: number;
  readonly tick_misaligned_count: number;
  readonly no_l1_reference_count: number;
  readonly distance_over_100_points_count: number;
  readonly distance_over_500_points_count: number;
  readonly distance_over_1000_points_count: number;
  readonly min_price: number | null;
  readonly p50_price: number | null;
  readonly p95_price: number | null;
  readonly p99_price: number | null;
  readonly max_price: number | null;
  readonly first_implausible_prices: readonly ImplausiblePriceExample[];
}

export interface ImplausiblePriceExample {
  readonly record_index: number;
  readonly exchange_event_ts_ns: string | null;
  readonly timestamp_source: string | null;
  readonly payload_kind: string | null;
  readonly side: BookSide;
  readonly level: number;
  readonly px: number;
  readonly sz: number;
  readonly order_count: number | null;
  readonly tick_aligned: boolean;
  readonly distance_from_l1_mid_points: number | null;
  readonly nearby_l1_quote: NearbyL1Quote | null;
}

export interface NearbyL1Quote {
  readonly exchange_event_ts_ns: string;
  readonly bid_px: number;
  readonly ask_px: number;
  readonly mid_px: number;
}

export interface InternalParityReport {
  readonly comparison_rule: string;
  readonly tick_tolerance_points: number;
  readonly reconstructed_sample_count: number;
  readonly compared_sample_count: number;
  readonly missing_l1_quote_count: number;
  readonly missing_mbp10_best_count: number;
  readonly comparable_side_count: number;
  readonly within_1_tick_side_count: number;
  readonly within_1_tick_pct: number | null;
  readonly bid_mismatch_count: number;
  readonly ask_mismatch_count: number;
  readonly first_mismatches: readonly InternalParityMismatch[];
  readonly tolerance_windows: Readonly<Record<string, InternalParityWindowReport>>;
}

export interface InternalParityWindowReport {
  readonly window_ms: number;
  readonly compared_sample_count: number;
  readonly missing_l1_quote_count: number;
  readonly comparable_side_count: number;
  readonly within_1_tick_side_count: number;
  readonly within_1_tick_pct: number | null;
}

export interface InternalParityMismatch {
  readonly mbp10_ts_ns: string;
  readonly l1_ts_ns: string;
  readonly side: BookSide;
  readonly mbp10_px: number;
  readonly l1_px: number;
  readonly delta_points: number;
  readonly source_record_index: number;
}

export interface ReconstructionModeReport {
  readonly mode: ReconstructionModeName;
  readonly allow_null_seed: boolean;
  readonly reset_on_implausible_seed: boolean;
  readonly timestamped_rows_only: boolean;
  readonly plausible_l1_range_only: boolean;
  readonly applied_null_seed_rows_count: number;
  readonly skipped_null_seed_rows_count: number;
  readonly reset_on_implausible_seed_count: number;
  readonly applied_timestamped_update_rows_count: number;
  readonly skipped_implausible_timestamped_level_count: number;
  readonly reconstructed_sample_count: number;
  readonly first_sample_ts_ns: string | null;
  readonly last_sample_ts_ns: string | null;
  readonly internal_l1_mbp10_parity: InternalParityReport;
}

export interface FieldScalingDiagnostics {
  readonly field_names_present: readonly string[];
  readonly level_counts_by_side: Readonly<Record<BookSide, Readonly<Record<string, number>>>>;
  readonly side_values_present: readonly BookSide[];
  readonly price_distribution: {
    readonly count: number;
    readonly min: number | null;
    readonly p50: number | null;
    readonly p95: number | null;
    readonly p99: number | null;
    readonly max: number | null;
  };
  readonly size_distribution: {
    readonly count: number;
    readonly min: number | null;
    readonly p50: number | null;
    readonly p95: number | null;
    readonly p99: number | null;
    readonly max: number | null;
  };
  readonly scale_factor_candidates: readonly ScaleFactorCandidate[];
}

export interface ScaleFactorCandidate {
  readonly divide_price_by: number;
  readonly comparable_level_count: number;
  readonly within_100_points_of_l1_mid_count: number;
  readonly within_100_points_pct: number | null;
  readonly tick_aligned_after_scaling_count: number;
}

export interface RithmicMbp10ExtractionAuditReport {
  readonly schema_version: typeof RITHMIC_MBP10_AUDIT_SCHEMA_VERSION;
  readonly ticket_id: 'DATA-PARITY-04';
  readonly status: RithmicMbp10AuditStatus;
  readonly data01b_eligible: false;
  readonly mbp10_extraction_trusted: boolean;
  readonly data01_status: 'blocked';
  readonly inputs: {
    readonly probe_path: string;
    readonly allow_null_seed: boolean;
    readonly tick_size: number;
    readonly plausible_l1_distance_points: number;
  };
  readonly probe_parsing: ProbeParsingReport;
  readonly null_seed_analysis: NullSeedAnalysis;
  readonly price_sanity: PriceSanityReport;
  readonly internal_l1_mbp10_parity: InternalParityReport;
  readonly reconstruction_modes: Readonly<Record<ReconstructionModeName, ReconstructionModeReport>>;
  readonly best_reconstruction_mode: ReconstructionModeName;
  readonly field_scaling_diagnostics: FieldScalingDiagnostics;
  readonly classification: RithmicMbp10AuditClassification;
  readonly recommendation: RithmicMbp10AuditRecommendation;
  readonly notes: readonly string[];
}

interface CliArgs {
  readonly probe_path: string;
  readonly out_path: string;
  readonly allow_null_seed: boolean;
  readonly plausible_l1_distance_points: number;
}

interface ParsedProbe {
  readonly l1_quotes: readonly L1QuoteSample[];
  readonly mbp10_rows: readonly Mbp10Row[];
  readonly report: ProbeParsingReport;
}

interface BookState {
  // Rithmic OrderBook rows are price-level updates; top-10 depth is derived from sorted prices.
  readonly bids: Map<number, BookLevel>;
  readonly asks: Map<number, BookLevel>;
}

interface ReconstructionModeOptions {
  readonly mode: ReconstructionModeName;
  readonly allow_null_seed: boolean;
  readonly reset_on_implausible_seed: boolean;
  readonly timestamped_rows_only: boolean;
  readonly plausible_l1_range_only: boolean;
}

const DEFAULT_REPORT_PATH = 'reports/infra/rithmic_mbp10_extraction_audit.json';
const MNQ_TICK_SIZE = 0.25;
const DEFAULT_PLAUSIBLE_L1_DISTANCE_POINTS = 100;
const DISTANCE_THRESHOLDS_POINTS = [100, 500, 1000] as const;
const TOLERANCE_WINDOWS_MS = [1, 5, 10, 50, 100, 500] as const;
const PRICE_SCALE_FACTORS = [1, 10, 100, 1_000, 10_000, 1_000_000_000] as const;
const EXAMPLE_LIMIT = 50;
const TRUSTED_INTERNAL_PARITY_THRESHOLD_PCT = 99;

export function auditRithmicMbp10Extraction(options: {
  readonly probe_path: string;
  readonly allow_null_seed?: boolean;
  readonly plausible_l1_distance_points?: number;
}): RithmicMbp10ExtractionAuditReport {
  const probePath = resolve(options.probe_path);
  const allowNullSeed = options.allow_null_seed ?? false;
  const plausibleDistance =
    options.plausible_l1_distance_points ?? DEFAULT_PLAUSIBLE_L1_DISTANCE_POINTS;
  const parsed = parseProbeJsonl(probePath);
  const sortedL1Quotes = sortL1Quotes(parsed.l1_quotes);
  const nullSeedAnalysis = analyzeNullSeeds(parsed.mbp10_rows, sortedL1Quotes, plausibleDistance);
  const priceSanity = analyzePriceSanity(parsed.mbp10_rows, sortedL1Quotes, plausibleDistance);
  const fieldScalingDiagnostics = analyzeFieldScaling(parsed.mbp10_rows, sortedL1Quotes);

  const modes = modeOptions().map((mode) =>
    reconstructAndCompareMode(parsed.mbp10_rows, sortedL1Quotes, plausibleDistance, mode),
  );
  const reconstructionModes = Object.fromEntries(
    modes.map((mode) => [mode.mode, mode]),
  ) as Readonly<Record<ReconstructionModeName, ReconstructionModeReport>>;
  const bestMode = selectBestMode(modes);
  const primaryMode = reconstructionModes[allowNullSeed ? 'null_seed_rows_allowed' : 'no_null_seed_rows'];
  const classification = classifyAudit({
    bestMode,
    nullSeedAnalysis,
    priceSanity,
    fieldScalingDiagnostics,
  });
  const recommendation = recommendationForClassification(classification);
  const trusted =
    classification === 'state_stream_incremental_valid' &&
    (bestMode.internal_l1_mbp10_parity.within_1_tick_pct ?? 0) >=
      TRUSTED_INTERNAL_PARITY_THRESHOLD_PCT;

  return {
    schema_version: RITHMIC_MBP10_AUDIT_SCHEMA_VERSION,
    ticket_id: 'DATA-PARITY-04',
    status: trusted ? 'analysis_only' : 'fail',
    data01b_eligible: false,
    mbp10_extraction_trusted: trusted,
    data01_status: 'blocked',
    inputs: {
      probe_path: probePath,
      allow_null_seed: allowNullSeed,
      tick_size: MNQ_TICK_SIZE,
      plausible_l1_distance_points: plausibleDistance,
    },
    probe_parsing: parsed.report,
    null_seed_analysis: nullSeedAnalysis,
    price_sanity: priceSanity,
    internal_l1_mbp10_parity: primaryMode.internal_l1_mbp10_parity,
    reconstruction_modes: reconstructionModes,
    best_reconstruction_mode: bestMode.mode,
    field_scaling_diagnostics: fieldScalingDiagnostics,
    classification,
    recommendation,
    notes: [
      'This audit is offline evidence only and never unblocks DATA-01B by itself.',
      'Rithmic MBP10 must pass internal L1/MBP10 parity before Databento MBP10 parity can be trusted.',
      'sidecar_recv_ts_ns is not used as canonical time; exchange_event_ts_ns drives timestamped comparisons.',
    ],
  };
}

export function writeRithmicMbp10ExtractionAuditReport(
  report: RithmicMbp10ExtractionAuditReport,
  outPath: string,
): void {
  const resolved = resolve(outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${stableJsonStringify(report as unknown as JsonValue)}\n`, 'utf8');
}

export function formatRithmicMbp10ExtractionAuditSummary(
  report: RithmicMbp10ExtractionAuditReport,
): string {
  const parity = report.internal_l1_mbp10_parity;
  return [
    `Rithmic MBP10 extraction audit: ${report.status}`,
    `mbp10_extraction_trusted=${String(report.mbp10_extraction_trusted)}`,
    `classification=${report.classification}`,
    `recommendation=${report.recommendation}`,
    `mbp10_rows=${report.probe_parsing.mbp10_rows}`,
    `null_seed_rows=${report.null_seed_analysis.null_seed_rows_count}`,
    `implausible_null_seed_rows=${report.null_seed_analysis.implausible_null_seed_rows_count}`,
    `price_distance_over_100_points=${report.price_sanity.distance_over_100_points_count}`,
    `best_mode=${report.best_reconstruction_mode}`,
    `within_1_tick_pct=${parity.within_1_tick_pct ?? 'null'}`,
    'DATA-01B remains blocked.',
    '',
  ].join('\n');
}

function parseProbeJsonl(path: string): ParsedProbe {
  const l1Quotes: L1QuoteSample[] = [];
  const mbp10Rows: Mbp10Row[] = [];
  let totalRows = 0;
  let l1Rows = 0;
  let mbp10RowsCount = 0;
  let nullTsRows = 0;
  let timestampedRows = 0;
  let rowsWithBids = 0;
  let rowsWithAsks = 0;
  let rowsWithBothSides = 0;
  let rowsWithOneSideOnly = 0;

  forEachJsonlLine(path, (trimmed, lineNumber) => {
    totalRows += 1;
    const record = parseJsonLine(trimmed, lineNumber);
    if (!isRecord(record)) {
      throw new Error(`probe line ${lineNumber}: JSON value must be an object`);
    }
    const stream = stringField(record, ['stream', 'stream_id', 'payload_kind']);
    if (stream === 'L1_QUOTE') {
      l1Rows += 1;
      const quote = normalizeL1Quote(record, lineNumber);
      if (quote !== null) {
        l1Quotes.push(quote);
      }
      return;
    }
    if (stream !== 'MBP10') {
      return;
    }

    mbp10RowsCount += 1;
    const row = normalizeMbp10Row(record, lineNumber);
    const hasBids = row.bids.length > 0;
    const hasAsks = row.asks.length > 0;
    if (row.ts_ns === null) {
      nullTsRows += 1;
    } else {
      timestampedRows += 1;
    }
    if (hasBids) rowsWithBids += 1;
    if (hasAsks) rowsWithAsks += 1;
    if (hasBids && hasAsks) rowsWithBothSides += 1;
    if ((hasBids || hasAsks) && !(hasBids && hasAsks)) rowsWithOneSideOnly += 1;
    mbp10Rows.push(row);
  });

  return {
    l1_quotes: l1Quotes,
    mbp10_rows: mbp10Rows,
    report: {
      total_rows: totalRows,
      l1_quote_rows: l1Rows,
      l1_quote_rows_with_exchange_ts: l1Quotes.length,
      mbp10_rows: mbp10RowsCount,
      mbp10_null_exchange_ts_rows: nullTsRows,
      mbp10_timestamped_rows: timestampedRows,
      mbp10_rows_with_bids: rowsWithBids,
      mbp10_rows_with_asks: rowsWithAsks,
      mbp10_rows_with_both_sides: rowsWithBothSides,
      mbp10_rows_with_one_side_only: rowsWithOneSideOnly,
    },
  };
}

function analyzeNullSeeds(
  rows: readonly Mbp10Row[],
  l1Quotes: readonly L1QuoteSample[],
  plausibleDistance: number,
): NullSeedAnalysis {
  const examples: ImplausiblePriceExample[] = [];
  let nullRows = 0;
  let nullRowsWithLevels = 0;
  let implausibleRows = 0;

  for (const row of rows) {
    if (row.ts_ns !== null) {
      continue;
    }
    nullRows += 1;
    const levels = levelsForRow(row);
    if (levels.length === 0) {
      continue;
    }
    nullRowsWithLevels += 1;
    const rowExamples = implausibleLevelsForRow(row, l1Quotes, plausibleDistance);
    if (rowExamples.length > 0) {
      implausibleRows += 1;
      pushLimited(examples, rowExamples, EXAMPLE_LIMIT);
    }
  }

  return {
    allow_null_seed_default: false,
    null_seed_rows_count: nullRows,
    null_seed_rows_with_levels_count: nullRowsWithLevels,
    implausible_null_seed_rows_count: implausibleRows,
    first_implausible_null_seed_rows: examples,
  };
}

function analyzePriceSanity(
  rows: readonly Mbp10Row[],
  l1Quotes: readonly L1QuoteSample[],
  plausibleDistance: number,
): PriceSanityReport {
  const prices: number[] = [];
  let tickAlignedCount = 0;
  let tickMisalignedCount = 0;
  let noL1ReferenceCount = 0;
  let over100 = 0;
  let over500 = 0;
  let over1000 = 0;
  const examples: ImplausiblePriceExample[] = [];

  for (const row of rows) {
    for (const item of levelsForRow(row)) {
      prices.push(item.level.px);
      const tickAligned = isTickAligned(item.level.px);
      if (tickAligned) {
        tickAlignedCount += 1;
      } else {
        tickMisalignedCount += 1;
      }

      const quote = referenceQuoteForRow(row, l1Quotes);
      if (quote === null) {
        noL1ReferenceCount += 1;
      }
      const distance = quote === null ? null : round6(Math.abs(item.level.px - quote.mid_px));
      if (distance !== null && distance > 100) over100 += 1;
      if (distance !== null && distance > 500) over500 += 1;
      if (distance !== null && distance > 1000) over1000 += 1;
      if ((!tickAligned || (distance !== null && distance > plausibleDistance)) && examples.length < EXAMPLE_LIMIT) {
        examples.push(implausibleExample(row, item.side, item.level, quote, tickAligned, distance));
      }
    }
  }

  const sortedPrices = [...prices].sort(compareNumbers);
  return {
    tick_size: MNQ_TICK_SIZE,
    l1_mid_distance_thresholds_points: DISTANCE_THRESHOLDS_POINTS,
    level_count: prices.length,
    tick_aligned_count: tickAlignedCount,
    tick_misaligned_count: tickMisalignedCount,
    no_l1_reference_count: noL1ReferenceCount,
    distance_over_100_points_count: over100,
    distance_over_500_points_count: over500,
    distance_over_1000_points_count: over1000,
    min_price: nullableRound(sortedPrices[0]),
    p50_price: percentile(sortedPrices, 50),
    p95_price: percentile(sortedPrices, 95),
    p99_price: percentile(sortedPrices, 99),
    max_price: nullableRound(sortedPrices[sortedPrices.length - 1]),
    first_implausible_prices: examples,
  };
}

function analyzeFieldScaling(
  rows: readonly Mbp10Row[],
  l1Quotes: readonly L1QuoteSample[],
): FieldScalingDiagnostics {
  const fieldNames = new Set<string>();
  const bidLevelCounts: Record<string, number> = {};
  const askLevelCounts: Record<string, number> = {};
  const prices: number[] = [];
  const sizes: number[] = [];

  for (const row of rows) {
    for (const field of row.field_names) {
      fieldNames.add(field);
    }
    for (const level of row.bids) {
      bidLevelCounts[String(level.level)] = (bidLevelCounts[String(level.level)] ?? 0) + 1;
      prices.push(level.px);
      sizes.push(level.sz);
    }
    for (const level of row.asks) {
      askLevelCounts[String(level.level)] = (askLevelCounts[String(level.level)] ?? 0) + 1;
      prices.push(level.px);
      sizes.push(level.sz);
    }
  }

  return {
    field_names_present: [...fieldNames].sort(compareStrings),
    level_counts_by_side: {
      bid: sortNumberRecord(bidLevelCounts),
      ask: sortNumberRecord(askLevelCounts),
    },
    side_values_present: [
      ...(Object.keys(bidLevelCounts).length > 0 ? (['bid'] as const) : []),
      ...(Object.keys(askLevelCounts).length > 0 ? (['ask'] as const) : []),
    ],
    price_distribution: distribution(prices),
    size_distribution: distribution(sizes),
    scale_factor_candidates: PRICE_SCALE_FACTORS.map((factor) =>
      scaleFactorCandidate(rows, l1Quotes, factor),
    ),
  };
}

function reconstructAndCompareMode(
  rows: readonly Mbp10Row[],
  l1Quotes: readonly L1QuoteSample[],
  plausibleDistance: number,
  options: ReconstructionModeOptions,
): ReconstructionModeReport {
  const state: BookState = { bids: new Map<number, BookLevel>(), asks: new Map<number, BookLevel>() };
  const samples: ReconstructedBookSample[] = [];
  let appliedNullSeedRows = 0;
  let skippedNullSeedRows = 0;
  let resetOnImplausibleSeedCount = 0;
  let appliedTimestampedRows = 0;
  let skippedImplausibleTimestampedLevels = 0;
  const timestampedRows: TimestampedMbp10Row[] = [];

  for (const row of rows) {
    if (row.ts_ns === null) {
      if (!options.allow_null_seed || options.timestamped_rows_only) {
        skippedNullSeedRows += 1;
        continue;
      }
      const examples = implausibleLevelsForRow(row, l1Quotes, plausibleDistance);
      if (options.reset_on_implausible_seed && examples.length > 0) {
        state.bids.clear();
        state.asks.clear();
        resetOnImplausibleSeedCount += 1;
        skippedNullSeedRows += 1;
        continue;
      }
      applyBookUpdate(state, row.bids, row.asks);
      appliedNullSeedRows += 1;
      continue;
    }

    timestampedRows.push({ ...row, ts_ns: row.ts_ns });
  }

  for (const row of timestampedRows.sort(compareMbp10RowsByTimestamp)) {
    const filtered = options.plausible_l1_range_only
      ? plausibleLevels(row, l1Quotes, plausibleDistance)
      : { bids: row.bids, asks: row.asks, skipped_count: 0 };
    skippedImplausibleTimestampedLevels += filtered.skipped_count;
    if (filtered.bids.length === 0 && filtered.asks.length === 0) {
      continue;
    }
    applyBookUpdate(state, filtered.bids, filtered.asks);
    appliedTimestampedRows += 1;
    samples.push(stateToSample(state, row.ts_ns, row.record_index));
  }

  const parity = compareReconstructedBookToL1(samples, l1Quotes);
  const first = samples[0];
  const last = samples[samples.length - 1];
  return {
    mode: options.mode,
    allow_null_seed: options.allow_null_seed,
    reset_on_implausible_seed: options.reset_on_implausible_seed,
    timestamped_rows_only: options.timestamped_rows_only,
    plausible_l1_range_only: options.plausible_l1_range_only,
    applied_null_seed_rows_count: appliedNullSeedRows,
    skipped_null_seed_rows_count: skippedNullSeedRows,
    reset_on_implausible_seed_count: resetOnImplausibleSeedCount,
    applied_timestamped_update_rows_count: appliedTimestampedRows,
    skipped_implausible_timestamped_level_count: skippedImplausibleTimestampedLevels,
    reconstructed_sample_count: samples.length,
    first_sample_ts_ns: first?.ts_ns ?? null,
    last_sample_ts_ns: last?.ts_ns ?? null,
    internal_l1_mbp10_parity: parity,
  };
}

export function compareReconstructedBookToL1(
  samples: readonly ReconstructedBookSample[],
  l1Quotes: readonly L1QuoteSample[],
): InternalParityReport {
  const sortedSamples = [...samples].sort(compareSamples);
  const sortedQuotes = sortL1Quotes(l1Quotes);
  const firstMismatches: InternalParityMismatch[] = [];
  let sampleIndex = -1;
  let comparedSamples = 0;
  let missingL1 = 0;
  let missingBest = 0;
  let comparableSides = 0;
  let withinTickSides = 0;
  let bidMismatchCount = 0;
  let askMismatchCount = 0;
  const windowCounters = new Map<number, MutableWindowCounter>(
    TOLERANCE_WINDOWS_MS.map((window) => [window, emptyWindowCounter(window)]),
  );

  for (const quote of sortedQuotes) {
    while (
      sampleIndex + 1 < sortedSamples.length &&
      compareDecimalIntegerStrings(sortedSamples[sampleIndex + 1]!.ts_ns, quote.ts_ns) <= 0
    ) {
      sampleIndex += 1;
    }

    const sample = sampleIndex < 0 ? null : sortedSamples[sampleIndex]!;
    if (sample === null) {
      missingBest += 1;
      continue;
    }
    const bestBid = findLevel(sample.bids, 0);
    const bestAsk = findLevel(sample.asks, 0);
    if (bestBid === null || bestAsk === null) {
      missingBest += 1;
    } else {
      comparedSamples += 1;
      const bid = compareTopOfBookSide({
        sample,
        quote,
        side: 'bid',
        mbp10Px: bestBid.px,
        l1Px: quote.bid_px,
        firstMismatches,
      });
      const ask = compareTopOfBookSide({
        sample,
        quote,
        side: 'ask',
        mbp10Px: bestAsk.px,
        l1Px: quote.ask_px,
        firstMismatches,
      });
      comparableSides += 2;
      withinTickSides += (bid ? 1 : 0) + (ask ? 1 : 0);
      if (!bid) bidMismatchCount += 1;
      if (!ask) askMismatchCount += 1;
    }

    for (const windowMs of TOLERANCE_WINDOWS_MS) {
      const counter = windowCounters.get(windowMs)!;
      const windowNs = BigInt(windowMs) * 1_000_000n;
      const sampleInWindow =
        sample !== null && absBigInt(BigInt(quote.ts_ns) - BigInt(sample.ts_ns)) <= windowNs;
      if (!sampleInWindow) {
        counter.missing_l1_quote_count += 1;
        continue;
      }
      if (bestBid === null || bestAsk === null) {
        continue;
      }
      counter.compared_sample_count += 1;
      counter.comparable_side_count += 2;
      if (withinTick(bestBid.px, quote.bid_px)) counter.within_1_tick_side_count += 1;
      if (withinTick(bestAsk.px, quote.ask_px)) counter.within_1_tick_side_count += 1;
    }
  }

  return {
    comparison_rule: 'exchange_ordered_mbp10_state_at_rithmic_l1_quote_checkpoints',
    tick_tolerance_points: MNQ_TICK_SIZE,
    reconstructed_sample_count: sortedSamples.length,
    compared_sample_count: comparedSamples,
    missing_l1_quote_count: missingL1,
    missing_mbp10_best_count: missingBest,
    comparable_side_count: comparableSides,
    within_1_tick_side_count: withinTickSides,
    within_1_tick_pct: pct(withinTickSides, comparableSides),
    bid_mismatch_count: bidMismatchCount,
    ask_mismatch_count: askMismatchCount,
    first_mismatches: firstMismatches,
    tolerance_windows: Object.fromEntries(
      [...windowCounters.entries()].map(([windowMs, counter]) => [
        `${windowMs}ms`,
        finalizeWindowCounter(counter),
      ]),
    ),
  };
}

function classifyAudit(args: {
  readonly bestMode: ReconstructionModeReport;
  readonly nullSeedAnalysis: NullSeedAnalysis;
  readonly priceSanity: PriceSanityReport;
  readonly fieldScalingDiagnostics: FieldScalingDiagnostics;
}): RithmicMbp10AuditClassification {
  const bestPct = args.bestMode.internal_l1_mbp10_parity.within_1_tick_pct ?? 0;
  if (bestPct >= TRUSTED_INTERNAL_PARITY_THRESHOLD_PCT) {
    return 'state_stream_incremental_valid';
  }
  const scaleCandidates = args.fieldScalingDiagnostics.scale_factor_candidates;
  const factorOne = scaleCandidates.find((candidate) => candidate.divide_price_by === 1);
  const bestScaled = [...scaleCandidates].sort((left, right) =>
    (right.within_100_points_pct ?? 0) - (left.within_100_points_pct ?? 0),
  )[0];
  if (
    bestScaled !== undefined &&
    bestScaled.divide_price_by !== 1 &&
    (bestScaled.within_100_points_pct ?? 0) > (factorOne?.within_100_points_pct ?? 0) + 25
  ) {
    return 'price_scaling_error_suspected';
  }
  if (
    args.nullSeedAnalysis.implausible_null_seed_rows_count > 0 &&
    args.priceSanity.distance_over_100_points_count <= args.nullSeedAnalysis.first_implausible_null_seed_rows.length
  ) {
    return 'null_seed_contamination';
  }
  if (args.priceSanity.distance_over_100_points_count > 0) {
    return 'extraction_bug_suspected';
  }
  if (args.bestMode.reconstructed_sample_count > 0) {
    return 'field_semantics_mismatch';
  }
  return 'inconclusive';
}

function recommendationForClassification(
  classification: RithmicMbp10AuditClassification,
): RithmicMbp10AuditRecommendation {
  switch (classification) {
    case 'null_seed_contamination':
      return 'disable_null_seed_use';
    case 'price_scaling_error_suspected':
      return 'adjust_price_scaling_after_manual_review';
    case 'field_semantics_mismatch':
      return 'inspect_raw_rithmic_proto_fields';
    case 'extraction_bug_suspected':
      return 'require_direct_proto_debug_dump';
    case 'state_stream_incremental_valid':
      return 'proceed_to_databento_mbp10_parity_only_after_internal_rithmic_l1_mbp10_parity_passes';
    case 'inconclusive':
      return 'inspect_raw_rithmic_proto_fields';
    default:
      return assertNeverClassification(classification);
  }
}

function modeOptions(): readonly ReconstructionModeOptions[] {
  return [
    {
      mode: 'no_null_seed_rows',
      allow_null_seed: false,
      reset_on_implausible_seed: false,
      timestamped_rows_only: false,
      plausible_l1_range_only: false,
    },
    {
      mode: 'null_seed_rows_allowed',
      allow_null_seed: true,
      reset_on_implausible_seed: false,
      timestamped_rows_only: false,
      plausible_l1_range_only: false,
    },
    {
      mode: 'reset_book_on_implausible_seed',
      allow_null_seed: true,
      reset_on_implausible_seed: true,
      timestamped_rows_only: false,
      plausible_l1_range_only: false,
    },
    {
      mode: 'timestamped_rows_only',
      allow_null_seed: false,
      reset_on_implausible_seed: false,
      timestamped_rows_only: true,
      plausible_l1_range_only: false,
    },
    {
      mode: 'plausible_l1_range_only',
      allow_null_seed: false,
      reset_on_implausible_seed: false,
      timestamped_rows_only: true,
      plausible_l1_range_only: true,
    },
  ];
}

function selectBestMode(modes: readonly ReconstructionModeReport[]): ReconstructionModeReport {
  return [...modes].sort((left, right) => {
    const pctDiff =
      (right.internal_l1_mbp10_parity.within_1_tick_pct ?? -1) -
      (left.internal_l1_mbp10_parity.within_1_tick_pct ?? -1);
    if (pctDiff !== 0) return pctDiff;
    return right.internal_l1_mbp10_parity.compared_sample_count -
      left.internal_l1_mbp10_parity.compared_sample_count;
  })[0]!;
}

function normalizeL1Quote(record: Record<string, unknown>, recordIndex: number): L1QuoteSample | null {
  const tsNs = optionalDecimalString(record, ['exchange_event_ts_ns']);
  if (tsNs === null) return null;
  const bidPx = optionalFiniteNumber(record, ['bid_px']);
  const askPx = optionalFiniteNumber(record, ['ask_px']);
  if (bidPx === null || askPx === null) return null;
  return {
    record_index: recordIndex,
    ts_ns: tsNs,
    bid_px: bidPx,
    ask_px: askPx,
    bid_sz: optionalFiniteNumber(record, ['bid_sz', 'bid_qty']),
    ask_sz: optionalFiniteNumber(record, ['ask_sz', 'ask_qty']),
    mid_px: (bidPx + askPx) / 2,
  };
}

function normalizeMbp10Row(record: Record<string, unknown>, recordIndex: number): Mbp10Row {
  return {
    record_index: recordIndex,
    ts_ns: optionalDecimalString(record, ['exchange_event_ts_ns']),
    timestamp_source: typeof record.timestamp_source === 'string' ? record.timestamp_source : null,
    payload_kind: typeof record.payload_kind === 'string' ? record.payload_kind : null,
    bids: normalizeLevels(record.bids, recordIndex, 'bid'),
    asks: normalizeLevels(record.asks, recordIndex, 'ask'),
    field_names: Object.keys(record).sort(compareStrings),
  };
}

function normalizeLevels(value: unknown, recordIndex: number, side: BookSide): readonly BookLevel[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`probe line ${recordIndex}: ${side}s must be an array when present`);
  }
  return value.map((entry, index) => normalizeLevel(entry, recordIndex, side, index));
}

function normalizeLevel(value: unknown, recordIndex: number, side: BookSide, index: number): BookLevel {
  if (!isRecord(value)) {
    throw new Error(`probe line ${recordIndex}: ${side}s[${index}] must be an object`);
  }
  const level = optionalFiniteInteger(value, ['level']);
  const px = optionalFiniteNumber(value, ['px', 'price']);
  const sz = optionalFiniteNumber(value, ['sz', 'size']);
  if (px === null || sz === null) {
    throw new Error(`probe line ${recordIndex}: ${side}s[${index}] requires px and sz`);
  }
  return {
    level: level ?? index,
    px,
    sz,
    order_count: optionalFiniteInteger(value, ['order_count', 'orders', 'count', 'ct']),
  };
}

function implausibleLevelsForRow(
  row: Mbp10Row,
  l1Quotes: readonly L1QuoteSample[],
  plausibleDistance: number,
): readonly ImplausiblePriceExample[] {
  const examples: ImplausiblePriceExample[] = [];
  const quote = referenceQuoteForRow(row, l1Quotes);
  for (const item of levelsForRow(row)) {
    const tickAligned = isTickAligned(item.level.px);
    const distance = quote === null ? null : round6(Math.abs(item.level.px - quote.mid_px));
    if (!tickAligned || (distance !== null && distance > plausibleDistance)) {
      examples.push(implausibleExample(row, item.side, item.level, quote, tickAligned, distance));
    }
  }
  return examples;
}

function plausibleLevels(
  row: Mbp10Row,
  l1Quotes: readonly L1QuoteSample[],
  plausibleDistance: number,
): { readonly bids: readonly BookLevel[]; readonly asks: readonly BookLevel[]; readonly skipped_count: number } {
  const quote = referenceQuoteForRow(row, l1Quotes);
  if (quote === null) {
    return { bids: row.bids, asks: row.asks, skipped_count: 0 };
  }
  let skipped = 0;
  const keep = (level: BookLevel): boolean => {
    if (!isTickAligned(level.px)) {
      skipped += 1;
      return false;
    }
    if (Math.abs(level.px - quote.mid_px) > plausibleDistance) {
      skipped += 1;
      return false;
    }
    return true;
  };
  return {
    bids: row.bids.filter(keep),
    asks: row.asks.filter(keep),
    skipped_count: skipped,
  };
}

function referenceQuoteForRow(
  row: Mbp10Row,
  l1Quotes: readonly L1QuoteSample[],
): L1QuoteSample | null {
  if (l1Quotes.length === 0) return null;
  if (row.ts_ns === null) return l1Quotes[0]!;
  return nearestQuoteWithin(l1Quotes, row.ts_ns, 500_000_000n) ?? priorQuoteAtOrBefore(l1Quotes, row.ts_ns);
}

function scaleFactorCandidate(
  rows: readonly Mbp10Row[],
  l1Quotes: readonly L1QuoteSample[],
  factor: number,
): ScaleFactorCandidate {
  let comparable = 0;
  let within100 = 0;
  let tickAligned = 0;
  for (const row of rows) {
    const quote = referenceQuoteForRow(row, l1Quotes);
    if (quote === null) continue;
    for (const item of levelsForRow(row)) {
      comparable += 1;
      const corrected = item.level.px / factor;
      if (Math.abs(corrected - quote.mid_px) <= 100) within100 += 1;
      if (isTickAligned(corrected)) tickAligned += 1;
    }
  }
  return {
    divide_price_by: factor,
    comparable_level_count: comparable,
    within_100_points_of_l1_mid_count: within100,
    within_100_points_pct: pct(within100, comparable),
    tick_aligned_after_scaling_count: tickAligned,
  };
}

function compareTopOfBookSide(args: {
  readonly sample: ReconstructedBookSample;
  readonly quote: L1QuoteSample;
  readonly side: BookSide;
  readonly mbp10Px: number;
  readonly l1Px: number;
  readonly firstMismatches: InternalParityMismatch[];
}): boolean {
  const ok = withinTick(args.mbp10Px, args.l1Px);
  if (!ok && args.firstMismatches.length < EXAMPLE_LIMIT) {
    args.firstMismatches.push({
      mbp10_ts_ns: args.sample.ts_ns,
      l1_ts_ns: args.quote.ts_ns,
      side: args.side,
      mbp10_px: args.mbp10Px,
      l1_px: args.l1Px,
      delta_points: round6(Math.abs(args.mbp10Px - args.l1Px)),
      source_record_index: args.sample.source_record_index,
    });
  }
  return ok;
}

function applyBookUpdate(
  state: BookState,
  bids: readonly BookLevel[],
  asks: readonly BookLevel[],
): void {
  for (const bid of bids) applyPriceLevelUpdate(state.bids, bid);
  for (const ask of asks) applyPriceLevelUpdate(state.asks, ask);
}

function stateToSample(state: BookState, tsNs: string, sourceRecordIndex: number): ReconstructedBookSample {
  return {
    ts_ns: tsNs,
    source_record_index: sourceRecordIndex,
    bids: levelsFromPriceMap(state.bids, 'bid'),
    asks: levelsFromPriceMap(state.asks, 'ask'),
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
    .slice(0, 10)
    .map((level, index) => ({
      ...level,
      level: index,
    }));
}

function findLevel(levels: readonly BookLevel[], level: number): BookLevel | null {
  return levels.find((item) => item.level === level) ?? null;
}

function levelsForRow(row: Mbp10Row): readonly { readonly side: BookSide; readonly level: BookLevel }[] {
  return [
    ...row.bids.map((level) => ({ side: 'bid' as const, level })),
    ...row.asks.map((level) => ({ side: 'ask' as const, level })),
  ];
}

function implausibleExample(
  row: Mbp10Row,
  side: BookSide,
  level: BookLevel,
  quote: L1QuoteSample | null,
  tickAligned: boolean,
  distance: number | null,
): ImplausiblePriceExample {
  return {
    record_index: row.record_index,
    exchange_event_ts_ns: row.ts_ns,
    timestamp_source: row.timestamp_source,
    payload_kind: row.payload_kind,
    side,
    level: level.level,
    px: level.px,
    sz: level.sz,
    order_count: level.order_count,
    tick_aligned: tickAligned,
    distance_from_l1_mid_points: distance,
    nearby_l1_quote:
      quote === null
        ? null
        : {
            exchange_event_ts_ns: quote.ts_ns,
            bid_px: quote.bid_px,
            ask_px: quote.ask_px,
            mid_px: quote.mid_px,
          },
  };
}

function priorQuoteAtOrBefore(
  quotes: readonly L1QuoteSample[],
  tsNs: string,
): L1QuoteSample | null {
  let candidate: L1QuoteSample | null = null;
  for (const quote of quotes) {
    if (compareDecimalIntegerStrings(quote.ts_ns, tsNs) <= 0) {
      candidate = quote;
      continue;
    }
    break;
  }
  return candidate;
}

function nearestQuoteWithin(
  quotes: readonly L1QuoteSample[],
  tsNs: string,
  toleranceNs: bigint,
): L1QuoteSample | null {
  if (quotes.length === 0) return null;
  const insertion = lowerBoundQuote(quotes, tsNs);
  const candidates = [quotes[insertion], quotes[insertion - 1]].filter(
    (quote): quote is L1QuoteSample => quote !== undefined,
  );
  let best: L1QuoteSample | null = null;
  let bestDelta: bigint | null = null;
  for (const quote of candidates) {
    const delta = absBigInt(BigInt(quote.ts_ns) - BigInt(tsNs));
    if (delta <= toleranceNs && (bestDelta === null || delta < bestDelta)) {
      best = quote;
      bestDelta = delta;
    }
  }
  return best;
}

function lowerBoundQuote(quotes: readonly L1QuoteSample[], tsNs: string): number {
  let low = 0;
  let high = quotes.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareDecimalIntegerStrings(quotes[middle]!.ts_ns, tsNs) < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

interface MutableWindowCounter {
  readonly window_ms: number;
  compared_sample_count: number;
  missing_l1_quote_count: number;
  comparable_side_count: number;
  within_1_tick_side_count: number;
}

function emptyWindowCounter(windowMs: number): MutableWindowCounter {
  return {
    window_ms: windowMs,
    compared_sample_count: 0,
    missing_l1_quote_count: 0,
    comparable_side_count: 0,
    within_1_tick_side_count: 0,
  };
}

function finalizeWindowCounter(counter: MutableWindowCounter): InternalParityWindowReport {
  return {
    window_ms: counter.window_ms,
    compared_sample_count: counter.compared_sample_count,
    missing_l1_quote_count: counter.missing_l1_quote_count,
    comparable_side_count: counter.comparable_side_count,
    within_1_tick_side_count: counter.within_1_tick_side_count,
    within_1_tick_pct: pct(counter.within_1_tick_side_count, counter.comparable_side_count),
  };
}

function parseJsonLine(line: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(
      `probe line ${lineNumber}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

function optionalDecimalString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) continue;
    const value = record[key];
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && /^-?\d+$/.test(value)) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
    if (typeof value === 'bigint') return value.toString();
    throw new Error(`${keys.join('/')} must be a decimal nanosecond string or safe integer`);
  }
  return null;
}

function optionalFiniteNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) continue;
    const value = record[key];
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    throw new Error(`${keys.join('/')} must be a finite number when present`);
  }
  return null;
}

function optionalFiniteInteger(record: Record<string, unknown>, keys: readonly string[]): number | null {
  const value = optionalFiniteNumber(record, keys);
  if (value === null) return null;
  if (!Number.isInteger(value)) {
    throw new Error(`${keys.join('/')} must be an integer when present`);
  }
  return value;
}

function isTickAligned(value: number): boolean {
  const ticks = value / MNQ_TICK_SIZE;
  return Math.abs(ticks - Math.round(ticks)) < 1e-9;
}

function withinTick(left: number, right: number): boolean {
  return Math.abs(left - right) <= MNQ_TICK_SIZE;
}

function pct(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return round6((numerator / denominator) * 100);
}

function percentile(sorted: readonly number[], percentileValue: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return round6(sorted[index]!);
}

function distribution(values: readonly number[]): FieldScalingDiagnostics['price_distribution'] {
  const sorted = [...values].sort(compareNumbers);
  return {
    count: sorted.length,
    min: nullableRound(sorted[0]),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: nullableRound(sorted[sorted.length - 1]),
  };
}

function nullableRound(value: number | undefined): number | null {
  return value === undefined ? null : round6(value);
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function pushLimited<T>(target: T[], items: readonly T[], limit: number): void {
  for (const item of items) {
    if (target.length >= limit) return;
    target.push(item);
  }
}

function sortL1Quotes(quotes: readonly L1QuoteSample[]): readonly L1QuoteSample[] {
  return [...quotes].sort((left, right) => {
    const ts = compareDecimalIntegerStrings(left.ts_ns, right.ts_ns);
    return ts === 0 ? left.record_index - right.record_index : ts;
  });
}

function compareSamples(left: ReconstructedBookSample, right: ReconstructedBookSample): number {
  const ts = compareDecimalIntegerStrings(left.ts_ns, right.ts_ns);
  return ts === 0 ? left.source_record_index - right.source_record_index : ts;
}

function compareMbp10RowsByTimestamp(left: TimestampedMbp10Row, right: TimestampedMbp10Row): number {
  const ts = compareDecimalIntegerStrings(left.ts_ns, right.ts_ns);
  if (ts !== 0) return ts;
  return left.record_index - right.record_index;
}

function compareBookLevels(left: BookLevel, right: BookLevel): number {
  return left.level - right.level;
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sortNumberRecord(record: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => compareStrings(left, right)));
}

function compareDecimalIntegerStrings(left: string, right: string): number {
  const leftBigInt = BigInt(left);
  const rightBigInt = BigInt(right);
  if (leftBigInt === rightBigInt) return 0;
  return leftBigInt < rightBigInt ? -1 : 1;
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function assertNeverClassification(value: never): never {
  throw new Error(`Unhandled MBP10 audit classification: ${String(value)}`);
}

function usage(): string {
  return [
    'Usage: npm run infra:audit-rithmic-mbp10 -- --probe <probe-parity.jsonl> --out <report.json> [--allow-null-seed true|false]',
    '',
    `Default --out: ${DEFAULT_REPORT_PATH}`,
    '',
    'Audits Rithmic MBP10 extraction against Rithmic L1_QUOTE before Databento MBP10 parity is trusted.',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): CliArgs {
  let probePath: string | undefined;
  let outPath: string | undefined;
  let allowNullSeed = false;
  let plausibleL1DistancePoints = DEFAULT_PLAUSIBLE_L1_DISTANCE_POINTS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      throw new RithmicMbp10AuditHelpRequested();
    }
    if (arg === '--probe') {
      probePath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--out') {
      outPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--allow-null-seed') {
      const value = argv[index + 1];
      if (value !== 'true' && value !== 'false') {
        throw new Error('--allow-null-seed requires true or false');
      }
      allowNullSeed = value === 'true';
      index += 1;
      continue;
    }
    if (arg === '--plausible-l1-distance-points') {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--plausible-l1-distance-points requires a positive number');
      }
      plausibleL1DistancePoints = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }

  if (!probePath) {
    throw new Error(`--probe is required\n${usage()}`);
  }
  return {
    probe_path: probePath,
    out_path: outPath ?? DEFAULT_REPORT_PATH,
    allow_null_seed: allowNullSeed,
    plausible_l1_distance_points: plausibleL1DistancePoints,
  };
}

class RithmicMbp10AuditHelpRequested extends Error {
  constructor() {
    super('Rithmic MBP10 audit help requested');
  }
}

function main(): void {
  try {
    const args = parseArgs(processArgv.slice(2));
    const report = auditRithmicMbp10Extraction({
      probe_path: args.probe_path,
      allow_null_seed: args.allow_null_seed,
      plausible_l1_distance_points: args.plausible_l1_distance_points,
    });
    writeRithmicMbp10ExtractionAuditReport(report, args.out_path);
    processStdout.write(formatRithmicMbp10ExtractionAuditSummary(report));
    processExit(report.status === 'fail' ? 2 : 0);
  } catch (error) {
    if (error instanceof RithmicMbp10AuditHelpRequested) {
      processStdout.write(`${usage()}\n`);
      processExit(0);
      return;
    }
    processStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    processExit(3);
  }
}

if (processArgv[1] !== undefined && resolve(processArgv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
