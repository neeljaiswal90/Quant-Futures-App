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

export const MBO_PARITY_SCHEMA_VERSION = 1 as const;

type MboAction = 'add' | 'modify' | 'cancel' | 'trade' | 'clear' | 'unknown';
type MboSide = 'bid' | 'ask' | 'unknown';
type MboProvider = 'rithmic' | 'databento';
type SignatureModeName =
  | 'strict_all_actions'
  | 'exclude_unknown'
  | 'exclude_trade'
  | 'exclude_trade_and_unknown'
  | 'structural_book_actions_only';
type TimestampWindowName = 'exact' | 'plus_minus_1ms' | 'plus_minus_5ms' | 'plus_minus_10ms' | 'plus_minus_50ms' | 'plus_minus_100ms';

export type MboParityClassification =
  | 'mbo_event_semantics_aligned'
  | 'mbo_action_side_mismatch'
  | 'mbo_price_size_mismatch'
  | 'mbo_sequence_semantics_mismatch'
  | 'mbo_order_id_semantics_incompatible'
  | 'inconclusive';

export type MboActionTaxonomyClassification =
  | 'action_taxonomy_mismatch'
  | 'trade_action_semantics_mismatch'
  | 'unknown_action_mapping_required'
  | 'book_action_parity_pass_trade_excluded'
  | 'structural_mbo_parity_failure'
  | 'inconclusive_mbo_taxonomy';

export interface MboParityReport {
  readonly schema_version: typeof MBO_PARITY_SCHEMA_VERSION;
  readonly ticket_id: 'DATA-PARITY-10';
  readonly status: 'analysis_only';
  readonly data01b_full_eligible: false;
  readonly mbo_policy_decision: 'pending';
  readonly inputs: {
    readonly rithmic_probe_path: string;
    readonly databento_mbo_path: string;
  };
  readonly rithmic_mbo: MboProviderSummary;
  readonly databento_mbo: MboProviderSummary;
  readonly cross_source: MboCrossSourceSummary;
  readonly mbo_action_taxonomy: MboActionTaxonomyReport;
  readonly classification: MboParityClassification;
  readonly recommendation: string;
  readonly remaining_blocks: readonly [
    'MBO_POLICY_REVIEW_PENDING',
    'MBO_DERIVED_FEATURES_BLOCKED',
    'QUEUE_POSITION_FEATURES_BLOCKED',
    'FULL_DATA01B_REQUIRES_MBO_ACCEPTANCE',
  ];
}

export interface MboProviderSummary {
  readonly event_count: number;
  readonly first_ts_ns: string | null;
  readonly last_ts_ns: string | null;
  readonly timestamp_coverage_pct: number | null;
  readonly action_distribution: Readonly<Record<MboAction, number>>;
  readonly side_distribution: Readonly<Record<MboSide, number>>;
  readonly price_sanity: {
    readonly priced_event_count: number;
    readonly tick_aligned_count: number;
    readonly tick_aligned_pct: number | null;
    readonly min_price: number | null;
    readonly max_price: number | null;
  };
  readonly size_distribution: {
    readonly sized_event_count: number;
    readonly p50: number | null;
    readonly p95: number | null;
    readonly p99: number | null;
  };
  readonly order_id_coverage_pct: number | null;
  readonly sequence_analysis: {
    readonly sequence_coverage_pct: number | null;
    readonly non_decreasing: boolean;
    readonly decreased_count: number;
    readonly gap_count: number;
  };
}

export interface MboCrossSourceSummary {
  readonly signature_bucket: '1s_action_side_price_size';
  readonly rithmic_event_count: number;
  readonly databento_event_count: number;
  readonly event_count_ratio_databento_to_rithmic: number | null;
  readonly signature_match_count: number;
  readonly signature_match_pct_of_databento: number | null;
  readonly unmatched_databento_signature_count: number;
  readonly unmatched_rithmic_signature_count: number;
  readonly action_distribution_delta_pct: Readonly<Record<MboAction, number | null>>;
  readonly side_distribution_delta_pct: Readonly<Record<MboSide, number | null>>;
  readonly first_mismatches: readonly MboSignatureMismatch[];
}

export interface MboActionTaxonomyReport {
  readonly ticket_id: 'DATA-PARITY-11';
  readonly status: 'analysis_only';
  readonly data01b_eligible: false;
  readonly action_counts: Readonly<Record<MboProvider, MboActionCountsReport>>;
  readonly action_mapping: readonly MboActionMappingEntry[];
  readonly alternate_signature_modes: Readonly<Record<SignatureModeName, AlternateSignatureModeReport>>;
  readonly event_semantics_decomposition: EventSemanticsDecompositionReport;
  readonly timestamp_window_sensitivity: TimestampWindowSensitivityReport;
  readonly sequence_order_id_diagnostics: SequenceOrderIdDiagnosticsReport;
  readonly classification: MboActionTaxonomyClassification;
  readonly recommendation: string;
}

export interface MboActionCountsReport {
  readonly event_count: number;
  readonly action_counts: Readonly<Record<MboAction, number>>;
  readonly action_percentages: Readonly<Record<MboAction, number | null>>;
  readonly side_counts_by_action: Readonly<Record<MboAction, Readonly<Record<MboSide, number>>>>;
  readonly price_availability_by_action: Readonly<Record<MboAction, AvailabilityReport>>;
  readonly size_availability_by_action: Readonly<Record<MboAction, AvailabilityReport>>;
  readonly order_id_availability_by_action: Readonly<Record<MboAction, AvailabilityReport>>;
  readonly sequence_availability_by_action: Readonly<Record<MboAction, AvailabilityReport>>;
  readonly first_examples_by_action: Readonly<Record<MboAction, readonly MboActionExample[]>>;
}

export interface AvailabilityReport {
  readonly available_count: number;
  readonly total_count: number;
  readonly available_pct: number | null;
}

export interface MboActionExample {
  readonly ts_ns: string | null;
  readonly raw_action: string | null;
  readonly action: MboAction;
  readonly raw_side: string | null;
  readonly side: MboSide;
  readonly price: number | null;
  readonly size: number | null;
  readonly order_id: string | null;
  readonly sequence: string | null;
}

export interface MboActionMappingEntry {
  readonly provider: MboProvider;
  readonly provider_action_raw: string;
  readonly normalized_action: MboAction;
  readonly include_in_signature_parity: boolean;
  readonly include_in_feature_parity: boolean;
  readonly rationale: string;
}

export interface AlternateSignatureModeReport {
  readonly rithmic_count_included: number;
  readonly databento_count_included: number;
  readonly matched_count: number;
  readonly match_pct_of_databento: number | null;
  readonly unmatched_by_action: Readonly<Record<MboAction, number>>;
  readonly unmatched_by_side: Readonly<Record<MboSide, number>>;
  readonly unmatched_by_price_bucket: Readonly<Record<string, number>>;
  readonly unmatched_by_size_bucket: Readonly<Record<string, number>>;
}

export interface EventSemanticsDecompositionReport {
  readonly unmatched_databento_event_count: number;
  readonly unmatched_databento_by_action: Readonly<Record<MboAction, number>>;
  readonly unmatched_databento_trade_or_unknown_count: number;
  readonly unmatched_databento_trade_or_unknown_pct: number | null;
  readonly zero_size_unmatched_count: number;
  readonly duplicate_order_id_event_counts: Readonly<Record<MboProvider, number>>;
  readonly unmatched_duplicate_order_id_count: number;
  readonly same_timestamp_action_side_price_size_cluster_count: number;
  readonly auction_session_boundary_windows: {
    readonly status: 'not_available';
    readonly reason: string;
  };
  readonly high_trade_rate_windows: readonly HighTradeRateWindow[];
}

export interface HighTradeRateWindow {
  readonly minute_bucket_start_ts_ns: string;
  readonly databento_trade_event_count: number;
  readonly unmatched_databento_event_count: number;
}

export interface TimestampWindowSensitivityReport {
  readonly mode: 'structural_book_actions_only';
  readonly windows: Readonly<Record<TimestampWindowName, TimestampWindowScore>>;
  readonly best_window: TimestampWindowName;
  readonly best_match_pct_of_databento: number | null;
}

export interface TimestampWindowScore {
  readonly window_ms: number;
  readonly databento_count_included: number;
  readonly candidate_match_count: number;
  readonly candidate_match_pct_of_databento: number | null;
}

export interface SequenceOrderIdDiagnosticsReport {
  readonly order_id_overlap: {
    readonly rithmic_unique_order_ids: number;
    readonly databento_unique_order_ids: number;
    readonly common_order_ids: number;
    readonly rithmic_common_order_id_pct: number | null;
    readonly databento_common_order_id_pct: number | null;
  };
  readonly order_id_only_overlap_by_provider: Readonly<Record<MboProvider, number | null>>;
  readonly unmatched_databento_trade_unknown_order_ids_seen_in_rithmic_count: number;
  readonly unmatched_databento_trade_unknown_order_ids_seen_in_rithmic_pct: number | null;
  readonly largest_unmatched_sequence_bursts: readonly SequenceBurstReport[];
}

export interface SequenceBurstReport {
  readonly sequence_bucket_start: string;
  readonly unmatched_databento_event_count: number;
}

export interface MboSignatureMismatch {
  readonly ts_ns: string;
  readonly bucket_start_ts_ns: string;
  readonly action: MboAction;
  readonly side: MboSide;
  readonly price: number | null;
  readonly size: number | null;
  readonly provider: 'databento' | 'rithmic';
  readonly reason: 'signature_not_found_in_other_provider';
}

interface MboEvent {
  readonly ts_ns: string | null;
  readonly raw_action: string | null;
  readonly action: MboAction;
  readonly raw_side: string | null;
  readonly side: MboSide;
  readonly price: number | null;
  readonly size: number | null;
  readonly order_id: string | null;
  readonly sequence: string | null;
}

interface MutableProviderSummary {
  event_count: number;
  missing_timestamp_count: number;
  first_ts_ns: string | null;
  last_ts_ns: string | null;
  readonly action_distribution: Record<MboAction, number>;
  readonly side_distribution: Record<MboSide, number>;
  priced_event_count: number;
  tick_aligned_count: number;
  min_price: number | null;
  max_price: number | null;
  readonly sizes: number[];
  order_id_count: number;
  sequence_count: number;
  last_sequence: bigint | null;
  decreased_count: number;
  gap_count: number;
}

interface MutableActionCounts {
  event_count: number;
  readonly action_counts: Record<MboAction, number>;
  readonly side_counts_by_action: Record<MboAction, Record<MboSide, number>>;
  readonly price_available_by_action: Record<MboAction, number>;
  readonly size_available_by_action: Record<MboAction, number>;
  readonly order_id_available_by_action: Record<MboAction, number>;
  readonly sequence_available_by_action: Record<MboAction, number>;
  readonly first_examples_by_action: Record<MboAction, MboActionExample[]>;
}

interface MutableSignatureModeStats {
  rithmic_count_included: number;
  databento_count_included: number;
  matched_count: number;
  readonly unmatched_by_action: Record<MboAction, number>;
  readonly unmatched_by_side: Record<MboSide, number>;
  readonly unmatched_by_price_bucket: Map<string, number>;
  readonly unmatched_by_size_bucket: Map<string, number>;
}

interface MutableEventSemantics {
  unmatched_databento_event_count: number;
  readonly unmatched_databento_by_action: Record<MboAction, number>;
  unmatched_databento_trade_or_unknown_count: number;
  zero_size_unmatched_count: number;
  rithmic_duplicate_order_id_event_count: number;
  databento_duplicate_order_id_event_count: number;
  unmatched_duplicate_order_id_count: number;
  same_timestamp_action_side_price_size_cluster_count: number;
  readonly seen_unmatched_exact_signatures: Set<string>;
  readonly databento_trade_events_by_minute: Map<string, number>;
  readonly unmatched_databento_events_by_minute: Map<string, number>;
}

interface MutableTaxonomyContext {
  readonly action_counts: Record<MboProvider, MutableActionCounts>;
  readonly alternate_signature_modes: Record<SignatureModeName, MutableSignatureModeStats>;
  readonly event_semantics: MutableEventSemantics;
  readonly rithmic_order_ids: Set<string>;
  readonly databento_order_ids: Set<string>;
  readonly seen_rithmic_order_ids: Set<string>;
  readonly seen_databento_order_ids: Set<string>;
  readonly rithmic_timestamps_by_base_signature: Map<string, bigint[]>;
  readonly timestamp_window_scores: Record<TimestampWindowName, { databento_count_included: number; candidate_match_count: number }>;
  readonly unmatched_databento_sequence_buckets: Map<string, number>;
  unmatched_databento_trade_unknown_order_ids_with_rithmic_match: number;
  unmatched_databento_trade_unknown_order_id_count: number;
}

interface MutableCrossSourceSummary {
  readonly rithmic_signatures: Map<string, number>;
  readonly first_unmatched_databento: MboSignatureMismatch[];
  rithmic_event_count: number;
  databento_event_count: number;
  signature_match_count: number;
  unmatched_databento_signature_count: number;
}

interface CliArgs {
  readonly rithmic_probe_path: string;
  readonly databento_mbo_path: string;
  readonly out_path: string;
}

const DEFAULT_OUT_PATH = 'reports/infra/mbo_parity_report.json';
const MNQ_TICK_SIZE = 0.25;
const SIGNATURE_BUCKET_NS = 1_000_000_000n;
const TIMESTAMP_WINDOWS: readonly { readonly name: TimestampWindowName; readonly window_ns: bigint; readonly window_ms: number }[] = [
  { name: 'exact', window_ns: 0n, window_ms: 0 },
  { name: 'plus_minus_1ms', window_ns: 1_000_000n, window_ms: 1 },
  { name: 'plus_minus_5ms', window_ns: 5_000_000n, window_ms: 5 },
  { name: 'plus_minus_10ms', window_ns: 10_000_000n, window_ms: 10 },
  { name: 'plus_minus_50ms', window_ns: 50_000_000n, window_ms: 50 },
  { name: 'plus_minus_100ms', window_ns: 100_000_000n, window_ms: 100 },
];
const SIGNATURE_MODES: readonly SignatureModeName[] = [
  'strict_all_actions',
  'exclude_unknown',
  'exclude_trade',
  'exclude_trade_and_unknown',
  'structural_book_actions_only',
];
const FIRST_MISMATCH_LIMIT = 20;
const FIRST_ACTION_EXAMPLE_LIMIT = 3;
const LARGE_SEQUENCE_BUCKET_SIZE = 1_000n;
const HIGH_TRADE_RATE_WINDOW_LIMIT = 5;
const STRUCTURAL_MBO_PASS_THRESHOLD_PCT = 99;
const STRUCTURAL_MBO_REVIEW_THRESHOLD_PCT = 95;

export function analyzeMboParity(options: {
  readonly rithmic_probe_path: string;
  readonly databento_mbo_path: string;
}): MboParityReport {
  const rithmicPath = resolve(options.rithmic_probe_path);
  const databentoPath = resolve(options.databento_mbo_path);
  const rithmicSummary = createProviderSummary();
  const databentoSummary = createProviderSummary();
  const crossSource = createCrossSourceSummary();
  const taxonomy = createTaxonomyContext();

  forEachRithmicMboEvent(rithmicPath, (event) => {
    updateProviderSummary(rithmicSummary, event);
    updateActionCounts(taxonomy.action_counts.rithmic, event);
    updateOrderIdDiagnostics(taxonomy, 'rithmic', event);
    updateRithmicSignatureModes(taxonomy, event);
    crossSource.rithmic_event_count += 1;
    if (event.ts_ns !== null) {
      incrementMapCount(crossSource.rithmic_signatures, mboSignature(event));
      if (isIncludedInMode('structural_book_actions_only', event)) {
        addRithmicTimestampForWindowSensitivity(taxonomy, event);
      }
    }
  });

  sortTimestampSensitivityIndexes(taxonomy);

  forEachDatabentoMboEvent(databentoPath, (event) => {
    updateProviderSummary(databentoSummary, event);
    updateActionCounts(taxonomy.action_counts.databento, event);
    const databentoOrderIdWasDuplicate = updateOrderIdDiagnostics(taxonomy, 'databento', event);
    updateDatabentoTradeRateContext(taxonomy, event);
    crossSource.databento_event_count += 1;
    let matched = false;
    if (event.ts_ns === null) {
      updateDatabentoSignatureModes(taxonomy, event, false, databentoOrderIdWasDuplicate);
      return;
    }
    const signature = mboSignature(event);
    const remaining = crossSource.rithmic_signatures.get(signature) ?? 0;
    if (remaining > 0) {
      matched = true;
      crossSource.signature_match_count += 1;
      if (remaining === 1) {
        crossSource.rithmic_signatures.delete(signature);
      } else {
        crossSource.rithmic_signatures.set(signature, remaining - 1);
      }
    } else {
      crossSource.unmatched_databento_signature_count += 1;
      pushMboMismatch(crossSource.first_unmatched_databento, event, 'databento');
    }
    updateDatabentoSignatureModes(taxonomy, event, matched, databentoOrderIdWasDuplicate);
    updateTimestampWindowSensitivity(taxonomy, event);
  });

  const rithmic = finalizeProviderSummary(rithmicSummary);
  const databento = finalizeProviderSummary(databentoSummary);
  const cross = finalizeCrossSourceSummary(crossSource, rithmic, databento);
  const mboActionTaxonomy = finalizeMboActionTaxonomy(taxonomy);
  const classification = classifyMboParity({ rithmic, databento, cross });

  return {
    schema_version: MBO_PARITY_SCHEMA_VERSION,
    ticket_id: 'DATA-PARITY-10',
    status: 'analysis_only',
    data01b_full_eligible: false,
    mbo_policy_decision: 'pending',
    inputs: {
      rithmic_probe_path: rithmicPath,
      databento_mbo_path: databentoPath,
    },
    rithmic_mbo: rithmic,
    databento_mbo: databento,
    cross_source: cross,
    mbo_action_taxonomy: mboActionTaxonomy,
    classification,
    recommendation: recommendationForMboClassification(classification),
    remaining_blocks: [
      'MBO_POLICY_REVIEW_PENDING',
      'MBO_DERIVED_FEATURES_BLOCKED',
      'QUEUE_POSITION_FEATURES_BLOCKED',
      'FULL_DATA01B_REQUIRES_MBO_ACCEPTANCE',
    ],
  };
}

export function writeMboParityReport(report: MboParityReport, outPath: string): void {
  const resolved = resolve(outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${stableJsonStringify(report as unknown as JsonValue)}\n`, 'utf8');
}

function forEachRithmicMboEvent(path: string, handleEvent: (event: MboEvent) => void): void {
  forEachJsonlLine(path, (trimmed, lineNumber) => {
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `Rithmic probe line ${lineNumber}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isMboRecord(record)) {
      return;
    }
    const tsNs = optionalDecimalString(record, ['exchange_event_ts_ns']);
    const sequence = optionalDecimalString(record, ['sequence']);
    if (Array.isArray(record.orders)) {
      for (const order of record.orders) {
        if (!isRecord(order)) {
          continue;
        }
        handleEvent(normalizeMboEvent(order, tsNs, sequence));
      }
      return;
    }
    handleEvent(normalizeMboEvent(record, tsNs, sequence));
  });
}

function forEachDatabentoMboEvent(path: string, handleEvent: (event: MboEvent) => void): void {
  forEachJsonlLine(path, (trimmed, lineNumber) => {
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `Databento MBO line ${lineNumber}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isRecord(record)) {
      throw new Error(`Databento MBO line ${lineNumber}: JSON value must be an object`);
    }
    handleEvent(normalizeMboEvent(record, optionalDecimalString(record, ['ts_event_ns', 'ts_event']), optionalDecimalString(record, ['sequence'])));
  });
}

function normalizeMboEvent(record: Record<string, unknown>, tsNs: string | null, sequence: string | null): MboEvent {
  const rawAction = firstField(record, ['action', 'update_type', 'event_action']);
  const rawSide = firstField(record, ['side', 'transaction_type']);
  return {
    ts_ns: tsNs,
    raw_action: rawValueForReport(rawAction),
    action: normalizeAction(rawAction),
    raw_side: rawValueForReport(rawSide),
    side: normalizeSide(rawSide),
    price: optionalFiniteNumber(record, ['price', 'px', 'depth_price']),
    size: optionalFiniteInteger(record, ['size', 'sz', 'depth_size']),
    order_id: optionalString(record, ['order_id', 'exchange_order_id', 'orderid']),
    sequence,
  };
}

function rawValueForReport(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return String(value);
}

function createProviderSummary(): MutableProviderSummary {
  return {
    event_count: 0,
    missing_timestamp_count: 0,
    first_ts_ns: null,
    last_ts_ns: null,
    action_distribution: emptyActionDistribution(),
    side_distribution: emptySideDistribution(),
    priced_event_count: 0,
    tick_aligned_count: 0,
    min_price: null,
    max_price: null,
    sizes: [],
    order_id_count: 0,
    sequence_count: 0,
    last_sequence: null,
    decreased_count: 0,
    gap_count: 0,
  };
}

function updateProviderSummary(summary: MutableProviderSummary, event: MboEvent): void {
  summary.event_count += 1;
  summary.action_distribution[event.action] += 1;
  summary.side_distribution[event.side] += 1;
  if (event.ts_ns === null) {
    summary.missing_timestamp_count += 1;
  } else {
    summary.first_ts_ns ??= event.ts_ns;
    summary.last_ts_ns = event.ts_ns;
  }
  if (event.price !== null) {
    summary.priced_event_count += 1;
    if (isTickAligned(event.price)) {
      summary.tick_aligned_count += 1;
    }
    summary.min_price = summary.min_price === null ? event.price : Math.min(summary.min_price, event.price);
    summary.max_price = summary.max_price === null ? event.price : Math.max(summary.max_price, event.price);
  }
  if (event.size !== null) {
    summary.sizes.push(event.size);
  }
  if (event.order_id !== null && event.order_id !== '') {
    summary.order_id_count += 1;
  }
  if (event.sequence !== null) {
    summary.sequence_count += 1;
    const sequence = BigInt(event.sequence);
    if (summary.last_sequence !== null) {
      if (sequence < summary.last_sequence) {
        summary.decreased_count += 1;
      } else if (sequence > summary.last_sequence + 1n) {
        summary.gap_count += 1;
      }
    }
    summary.last_sequence = sequence;
  }
}

function finalizeProviderSummary(summary: MutableProviderSummary): MboProviderSummary {
  return {
    event_count: summary.event_count,
    first_ts_ns: summary.first_ts_ns,
    last_ts_ns: summary.last_ts_ns,
    timestamp_coverage_pct: pct(summary.event_count - summary.missing_timestamp_count, summary.event_count),
    action_distribution: summary.action_distribution,
    side_distribution: summary.side_distribution,
    price_sanity: {
      priced_event_count: summary.priced_event_count,
      tick_aligned_count: summary.tick_aligned_count,
      tick_aligned_pct: pct(summary.tick_aligned_count, summary.priced_event_count),
      min_price: summary.min_price,
      max_price: summary.max_price,
    },
    size_distribution: {
      sized_event_count: summary.sizes.length,
      p50: percentile(summary.sizes, 0.5),
      p95: percentile(summary.sizes, 0.95),
      p99: percentile(summary.sizes, 0.99),
    },
    order_id_coverage_pct: pct(summary.order_id_count, summary.event_count),
    sequence_analysis: {
      sequence_coverage_pct: pct(summary.sequence_count, summary.event_count),
      non_decreasing: summary.decreased_count === 0,
      decreased_count: summary.decreased_count,
      gap_count: summary.gap_count,
    },
  };
}

function createCrossSourceSummary(): MutableCrossSourceSummary {
  return {
    rithmic_signatures: new Map<string, number>(),
    first_unmatched_databento: [],
    rithmic_event_count: 0,
    databento_event_count: 0,
    signature_match_count: 0,
    unmatched_databento_signature_count: 0,
  };
}

function finalizeCrossSourceSummary(
  summary: MutableCrossSourceSummary,
  rithmic: MboProviderSummary,
  databento: MboProviderSummary,
): MboCrossSourceSummary {
  const unmatchedRithmic = [...summary.rithmic_signatures.values()].reduce((total, value) => total + value, 0);
  return {
    signature_bucket: '1s_action_side_price_size',
    rithmic_event_count: summary.rithmic_event_count,
    databento_event_count: summary.databento_event_count,
    event_count_ratio_databento_to_rithmic: summary.rithmic_event_count === 0
      ? null
      : round(summary.databento_event_count / summary.rithmic_event_count),
    signature_match_count: summary.signature_match_count,
    signature_match_pct_of_databento: pct(summary.signature_match_count, summary.databento_event_count),
    unmatched_databento_signature_count: summary.unmatched_databento_signature_count,
    unmatched_rithmic_signature_count: unmatchedRithmic,
    action_distribution_delta_pct: distributionDeltas(rithmic.action_distribution, databento.action_distribution),
    side_distribution_delta_pct: distributionDeltas(rithmic.side_distribution, databento.side_distribution),
    first_mismatches: summary.first_unmatched_databento,
  };
}

function createTaxonomyContext(): MutableTaxonomyContext {
  return {
    action_counts: {
      rithmic: createActionCounts(),
      databento: createActionCounts(),
    },
    alternate_signature_modes: createSignatureModeStats(),
    event_semantics: createEventSemantics(),
    rithmic_order_ids: new Set<string>(),
    databento_order_ids: new Set<string>(),
    seen_rithmic_order_ids: new Set<string>(),
    seen_databento_order_ids: new Set<string>(),
    rithmic_timestamps_by_base_signature: new Map<string, bigint[]>(),
    timestamp_window_scores: createTimestampWindowScores(),
    unmatched_databento_sequence_buckets: new Map<string, number>(),
    unmatched_databento_trade_unknown_order_ids_with_rithmic_match: 0,
    unmatched_databento_trade_unknown_order_id_count: 0,
  };
}

function createActionCounts(): MutableActionCounts {
  return {
    event_count: 0,
    action_counts: emptyActionDistribution(),
    side_counts_by_action: emptyActionSideDistribution(),
    price_available_by_action: emptyActionNumericCounts(),
    size_available_by_action: emptyActionNumericCounts(),
    order_id_available_by_action: emptyActionNumericCounts(),
    sequence_available_by_action: emptyActionNumericCounts(),
    first_examples_by_action: emptyActionExamples(),
  };
}

function createSignatureModeStats(): Record<SignatureModeName, MutableSignatureModeStats> {
  return Object.fromEntries(
    SIGNATURE_MODES.map((mode) => [
      mode,
      {
        rithmic_count_included: 0,
        databento_count_included: 0,
        matched_count: 0,
        unmatched_by_action: emptyActionDistribution(),
        unmatched_by_side: emptySideDistribution(),
        unmatched_by_price_bucket: new Map<string, number>(),
        unmatched_by_size_bucket: new Map<string, number>(),
      },
    ]),
  ) as Record<SignatureModeName, MutableSignatureModeStats>;
}

function createEventSemantics(): MutableEventSemantics {
  return {
    unmatched_databento_event_count: 0,
    unmatched_databento_by_action: emptyActionDistribution(),
    unmatched_databento_trade_or_unknown_count: 0,
    zero_size_unmatched_count: 0,
    rithmic_duplicate_order_id_event_count: 0,
    databento_duplicate_order_id_event_count: 0,
    unmatched_duplicate_order_id_count: 0,
    same_timestamp_action_side_price_size_cluster_count: 0,
    seen_unmatched_exact_signatures: new Set<string>(),
    databento_trade_events_by_minute: new Map<string, number>(),
    unmatched_databento_events_by_minute: new Map<string, number>(),
  };
}

function createTimestampWindowScores(): Record<TimestampWindowName, { databento_count_included: number; candidate_match_count: number }> {
  return Object.fromEntries(
    TIMESTAMP_WINDOWS.map((window) => [window.name, { databento_count_included: 0, candidate_match_count: 0 }]),
  ) as Record<TimestampWindowName, { databento_count_included: number; candidate_match_count: number }>;
}

function updateActionCounts(counts: MutableActionCounts, event: MboEvent): void {
  counts.event_count += 1;
  counts.action_counts[event.action] += 1;
  counts.side_counts_by_action[event.action][event.side] += 1;
  if (event.price !== null) {
    counts.price_available_by_action[event.action] += 1;
  }
  if (event.size !== null) {
    counts.size_available_by_action[event.action] += 1;
  }
  if (event.order_id !== null && event.order_id !== '') {
    counts.order_id_available_by_action[event.action] += 1;
  }
  if (event.sequence !== null) {
    counts.sequence_available_by_action[event.action] += 1;
  }
  const examples = counts.first_examples_by_action[event.action];
  if (examples.length < FIRST_ACTION_EXAMPLE_LIMIT) {
    examples.push(actionExample(event));
  }
}

function updateOrderIdDiagnostics(context: MutableTaxonomyContext, provider: MboProvider, event: MboEvent): boolean {
  if (event.order_id === null || event.order_id === '') {
    return false;
  }
  const seen = provider === 'rithmic' ? context.seen_rithmic_order_ids : context.seen_databento_order_ids;
  const ids = provider === 'rithmic' ? context.rithmic_order_ids : context.databento_order_ids;
  const duplicate = seen.has(event.order_id);
  if (duplicate && provider === 'rithmic') {
    context.event_semantics.rithmic_duplicate_order_id_event_count += 1;
  } else if (duplicate) {
    context.event_semantics.databento_duplicate_order_id_event_count += 1;
  }
  seen.add(event.order_id);
  ids.add(event.order_id);
  return duplicate;
}

function updateRithmicSignatureModes(context: MutableTaxonomyContext, event: MboEvent): void {
  for (const mode of SIGNATURE_MODES) {
    if (isIncludedInMode(mode, event)) {
      context.alternate_signature_modes[mode].rithmic_count_included += 1;
    }
  }
}

function updateDatabentoSignatureModes(
  context: MutableTaxonomyContext,
  event: MboEvent,
  matched: boolean,
  duplicateOrderId: boolean,
): void {
  for (const mode of SIGNATURE_MODES) {
    if (!isIncludedInMode(mode, event)) {
      continue;
    }
    const stats = context.alternate_signature_modes[mode];
    stats.databento_count_included += 1;
    if (matched) {
      stats.matched_count += 1;
    } else {
      incrementUnmatchedBreakdown(stats, event);
    }
  }
  if (!matched) {
    updateUnmatchedDatabentoSemantics(context, event, duplicateOrderId);
  }
}

function updateUnmatchedDatabentoSemantics(
  context: MutableTaxonomyContext,
  event: MboEvent,
  duplicateOrderId: boolean,
): void {
  const semantics = context.event_semantics;
  semantics.unmatched_databento_event_count += 1;
  semantics.unmatched_databento_by_action[event.action] += 1;
  if (event.action === 'trade' || event.action === 'unknown') {
    semantics.unmatched_databento_trade_or_unknown_count += 1;
    if (event.order_id !== null && event.order_id !== '') {
      context.unmatched_databento_trade_unknown_order_id_count += 1;
      if (context.rithmic_order_ids.has(event.order_id)) {
        context.unmatched_databento_trade_unknown_order_ids_with_rithmic_match += 1;
      }
    }
  }
  if (event.size === 0) {
    semantics.zero_size_unmatched_count += 1;
  }
  if (duplicateOrderId) {
    semantics.unmatched_duplicate_order_id_count += 1;
  }
  if (event.ts_ns !== null) {
    const exactSignature = eventExactSignature(event);
    if (semantics.seen_unmatched_exact_signatures.has(exactSignature)) {
      semantics.same_timestamp_action_side_price_size_cluster_count += 1;
    }
    semantics.seen_unmatched_exact_signatures.add(exactSignature);
    incrementMapCount(semantics.unmatched_databento_events_by_minute, bucketStart(event.ts_ns, 60_000_000_000n));
    if (event.sequence !== null) {
      incrementMapCount(context.unmatched_databento_sequence_buckets, sequenceBucket(event.sequence));
    }
  }
}

function updateDatabentoTradeRateContext(context: MutableTaxonomyContext, event: MboEvent): void {
  if (event.action !== 'trade' || event.ts_ns === null) {
    return;
  }
  incrementMapCount(context.event_semantics.databento_trade_events_by_minute, bucketStart(event.ts_ns, 60_000_000_000n));
}

function incrementUnmatchedBreakdown(stats: MutableSignatureModeStats, event: MboEvent): void {
  stats.unmatched_by_action[event.action] += 1;
  stats.unmatched_by_side[event.side] += 1;
  incrementMapCount(stats.unmatched_by_price_bucket, priceBucket(event.price));
  incrementMapCount(stats.unmatched_by_size_bucket, sizeBucket(event.size));
}

function addRithmicTimestampForWindowSensitivity(context: MutableTaxonomyContext, event: MboEvent): void {
  if (event.ts_ns === null) {
    return;
  }
  const signature = eventBaseSignature(event);
  const timestamps = context.rithmic_timestamps_by_base_signature.get(signature);
  if (timestamps === undefined) {
    context.rithmic_timestamps_by_base_signature.set(signature, [BigInt(event.ts_ns)]);
  } else {
    timestamps.push(BigInt(event.ts_ns));
  }
}

function sortTimestampSensitivityIndexes(context: MutableTaxonomyContext): void {
  for (const timestamps of context.rithmic_timestamps_by_base_signature.values()) {
    timestamps.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  }
}

function updateTimestampWindowSensitivity(context: MutableTaxonomyContext, event: MboEvent): void {
  if (event.ts_ns === null || !isIncludedInMode('structural_book_actions_only', event)) {
    return;
  }
  const timestamps = context.rithmic_timestamps_by_base_signature.get(eventBaseSignature(event));
  const tsNs = BigInt(event.ts_ns);
  for (const window of TIMESTAMP_WINDOWS) {
    const score = context.timestamp_window_scores[window.name];
    score.databento_count_included += 1;
    if (timestamps !== undefined && hasTimestampWithinWindow(timestamps, tsNs, window.window_ns)) {
      score.candidate_match_count += 1;
    }
  }
}

function finalizeMboActionTaxonomy(context: MutableTaxonomyContext): MboActionTaxonomyReport {
  const alternateSignatureModes = finalizeSignatureModeStats(context.alternate_signature_modes);
  const eventSemantics = finalizeEventSemantics(context);
  const timestampWindowSensitivity = finalizeTimestampWindowSensitivity(context);
  const sequenceOrderIdDiagnostics = finalizeSequenceOrderIdDiagnostics(context);
  const classification = classifyMboActionTaxonomy(alternateSignatureModes, eventSemantics);
  return {
    ticket_id: 'DATA-PARITY-11',
    status: 'analysis_only',
    data01b_eligible: false,
    action_counts: {
      rithmic: finalizeActionCounts(context.action_counts.rithmic),
      databento: finalizeActionCounts(context.action_counts.databento),
    },
    action_mapping: ACTION_MAPPING,
    alternate_signature_modes: alternateSignatureModes,
    event_semantics_decomposition: eventSemantics,
    timestamp_window_sensitivity: timestampWindowSensitivity,
    sequence_order_id_diagnostics: sequenceOrderIdDiagnostics,
    classification,
    recommendation: recommendationForMboActionTaxonomy(classification),
  };
}

function finalizeActionCounts(counts: MutableActionCounts): MboActionCountsReport {
  return {
    event_count: counts.event_count,
    action_counts: counts.action_counts,
    action_percentages: mapActionValues(counts.action_counts, (count) => pct(count, counts.event_count)),
    side_counts_by_action: counts.side_counts_by_action,
    price_availability_by_action: availabilityByAction(counts.price_available_by_action, counts.action_counts),
    size_availability_by_action: availabilityByAction(counts.size_available_by_action, counts.action_counts),
    order_id_availability_by_action: availabilityByAction(counts.order_id_available_by_action, counts.action_counts),
    sequence_availability_by_action: availabilityByAction(counts.sequence_available_by_action, counts.action_counts),
    first_examples_by_action: counts.first_examples_by_action,
  };
}

function finalizeSignatureModeStats(
  statsByMode: Record<SignatureModeName, MutableSignatureModeStats>,
): Record<SignatureModeName, AlternateSignatureModeReport> {
  return Object.fromEntries(
    SIGNATURE_MODES.map((mode) => {
      const stats = statsByMode[mode];
      return [
        mode,
        {
          rithmic_count_included: stats.rithmic_count_included,
          databento_count_included: stats.databento_count_included,
          matched_count: stats.matched_count,
          match_pct_of_databento: pct(stats.matched_count, stats.databento_count_included),
          unmatched_by_action: stats.unmatched_by_action,
          unmatched_by_side: stats.unmatched_by_side,
          unmatched_by_price_bucket: sortedRecordFromMap(stats.unmatched_by_price_bucket),
          unmatched_by_size_bucket: sortedRecordFromMap(stats.unmatched_by_size_bucket),
        },
      ];
    }),
  ) as Record<SignatureModeName, AlternateSignatureModeReport>;
}

function finalizeEventSemantics(context: MutableTaxonomyContext): EventSemanticsDecompositionReport {
  const semantics = context.event_semantics;
  const highTradeRateWindows = [...semantics.databento_trade_events_by_minute.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, HIGH_TRADE_RATE_WINDOW_LIMIT)
    .map(([minute, count]) => ({
      minute_bucket_start_ts_ns: minute,
      databento_trade_event_count: count,
      unmatched_databento_event_count: semantics.unmatched_databento_events_by_minute.get(minute) ?? 0,
    }));

  return {
    unmatched_databento_event_count: semantics.unmatched_databento_event_count,
    unmatched_databento_by_action: semantics.unmatched_databento_by_action,
    unmatched_databento_trade_or_unknown_count: semantics.unmatched_databento_trade_or_unknown_count,
    unmatched_databento_trade_or_unknown_pct: pct(
      semantics.unmatched_databento_trade_or_unknown_count,
      semantics.unmatched_databento_event_count,
    ),
    zero_size_unmatched_count: semantics.zero_size_unmatched_count,
    duplicate_order_id_event_counts: {
      rithmic: semantics.rithmic_duplicate_order_id_event_count,
      databento: semantics.databento_duplicate_order_id_event_count,
    },
    unmatched_duplicate_order_id_count: semantics.unmatched_duplicate_order_id_count,
    same_timestamp_action_side_price_size_cluster_count: semantics.same_timestamp_action_side_price_size_cluster_count,
    auction_session_boundary_windows: {
      status: 'not_available',
      reason: 'No session calendar input is provided to the MBO taxonomy diagnostic; review boundary clustering separately if needed.',
    },
    high_trade_rate_windows: highTradeRateWindows,
  };
}

function finalizeTimestampWindowSensitivity(context: MutableTaxonomyContext): TimestampWindowSensitivityReport {
  const windows = Object.fromEntries(
    TIMESTAMP_WINDOWS.map((window) => {
      const score = context.timestamp_window_scores[window.name];
      return [
        window.name,
        {
          window_ms: window.window_ms,
          databento_count_included: score.databento_count_included,
          candidate_match_count: score.candidate_match_count,
          candidate_match_pct_of_databento: pct(score.candidate_match_count, score.databento_count_included),
        },
      ];
    }),
  ) as Record<TimestampWindowName, TimestampWindowScore>;
  let bestWindow: TimestampWindowName = 'exact';
  for (const window of TIMESTAMP_WINDOWS) {
    const candidate = windows[window.name].candidate_match_pct_of_databento ?? -1;
    const best = windows[bestWindow].candidate_match_pct_of_databento ?? -1;
    if (candidate > best) {
      bestWindow = window.name;
    }
  }
  return {
    mode: 'structural_book_actions_only',
    windows,
    best_window: bestWindow,
    best_match_pct_of_databento: windows[bestWindow].candidate_match_pct_of_databento,
  };
}

function finalizeSequenceOrderIdDiagnostics(context: MutableTaxonomyContext): SequenceOrderIdDiagnosticsReport {
  let commonOrderIds = 0;
  const [smaller, larger] = context.rithmic_order_ids.size <= context.databento_order_ids.size
    ? [context.rithmic_order_ids, context.databento_order_ids]
    : [context.databento_order_ids, context.rithmic_order_ids];
  for (const orderId of smaller) {
    if (larger.has(orderId)) {
      commonOrderIds += 1;
    }
  }
  return {
    order_id_overlap: {
      rithmic_unique_order_ids: context.rithmic_order_ids.size,
      databento_unique_order_ids: context.databento_order_ids.size,
      common_order_ids: commonOrderIds,
      rithmic_common_order_id_pct: pct(commonOrderIds, context.rithmic_order_ids.size),
      databento_common_order_id_pct: pct(commonOrderIds, context.databento_order_ids.size),
    },
    order_id_only_overlap_by_provider: {
      rithmic: pct(commonOrderIds, context.rithmic_order_ids.size),
      databento: pct(commonOrderIds, context.databento_order_ids.size),
    },
    unmatched_databento_trade_unknown_order_ids_seen_in_rithmic_count:
      context.unmatched_databento_trade_unknown_order_ids_with_rithmic_match,
    unmatched_databento_trade_unknown_order_ids_seen_in_rithmic_pct: pct(
      context.unmatched_databento_trade_unknown_order_ids_with_rithmic_match,
      context.unmatched_databento_trade_unknown_order_id_count,
    ),
    largest_unmatched_sequence_bursts: [...context.unmatched_databento_sequence_buckets.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 10)
      .map(([bucket, count]) => ({
        sequence_bucket_start: bucket,
        unmatched_databento_event_count: count,
      })),
  };
}

function classifyMboActionTaxonomy(
  modes: Readonly<Record<SignatureModeName, AlternateSignatureModeReport>>,
  semantics: EventSemanticsDecompositionReport,
): MboActionTaxonomyClassification {
  const strictPct = modes.strict_all_actions.match_pct_of_databento ?? 0;
  const structuralPct = modes.structural_book_actions_only.match_pct_of_databento ?? 0;
  const tradeUnknownPct = semantics.unmatched_databento_trade_or_unknown_pct ?? 0;
  const unknownCount = semantics.unmatched_databento_by_action.unknown;
  const tradeCount = semantics.unmatched_databento_by_action.trade;
  const unmatchedCount = semantics.unmatched_databento_event_count;
  if (structuralPct >= STRUCTURAL_MBO_PASS_THRESHOLD_PCT) {
    return 'book_action_parity_pass_trade_excluded';
  }
  if (structuralPct < STRUCTURAL_MBO_REVIEW_THRESHOLD_PCT) {
    return 'structural_mbo_parity_failure';
  }
  if (unmatchedCount > 0 && (unknownCount / unmatchedCount) * 100 >= 40) {
    return 'unknown_action_mapping_required';
  }
  if (unmatchedCount > 0 && (tradeCount / unmatchedCount) * 100 >= 40) {
    return 'trade_action_semantics_mismatch';
  }
  if (tradeUnknownPct >= 25 && structuralPct > strictPct + 3) {
    return 'action_taxonomy_mismatch';
  }
  return 'inconclusive_mbo_taxonomy';
}

function recommendationForMboActionTaxonomy(classification: MboActionTaxonomyClassification): string {
  if (classification === 'book_action_parity_pass_trade_excluded') {
    return 'Structural MBO book-action parity is strong when trade/unknown actions are excluded; reviewer may consider accepting structural MBO parity while keeping trade/unknown and queue-derived features blocked until policy is written.';
  }
  if (classification === 'action_taxonomy_mismatch') {
    return 'Action taxonomy explains a material share of the mismatch; review provider action mapping and keep DATA-01B blocked until a policy decides whether trade/unknown actions are excluded from hard parity.';
  }
  if (classification === 'trade_action_semantics_mismatch') {
    return 'Databento trade actions dominate unmatched events; add or document Rithmic trade-action normalization before accepting MBO parity.';
  }
  if (classification === 'unknown_action_mapping_required') {
    return 'Databento unknown actions dominate unmatched events; inspect raw provider examples and map the unknown category manually before accepting MBO parity.';
  }
  if (classification === 'structural_mbo_parity_failure') {
    return 'Structural book-action mismatch remains after excluding trade/unknown actions; inspect raw provider examples and keep DATA-01B full scope blocked.';
  }
  return 'MBO action taxonomy is inconclusive; inspect raw provider examples and keep DATA-01B blocked.';
}

const ACTION_MAPPING: readonly MboActionMappingEntry[] = [
  {
    provider: 'rithmic',
    provider_action_raw: 'new',
    normalized_action: 'add',
    include_in_signature_parity: true,
    include_in_feature_parity: true,
    rationale: 'Rithmic book add/new messages create resting order-book state.',
  },
  {
    provider: 'rithmic',
    provider_action_raw: 'change/update',
    normalized_action: 'modify',
    include_in_signature_parity: true,
    include_in_feature_parity: true,
    rationale: 'Rithmic modify/change messages update resting order-book state.',
  },
  {
    provider: 'rithmic',
    provider_action_raw: 'delete/remove',
    normalized_action: 'cancel',
    include_in_signature_parity: true,
    include_in_feature_parity: true,
    rationale: 'Rithmic delete/remove messages remove resting order-book state.',
  },
  {
    provider: 'databento',
    provider_action_raw: 'A',
    normalized_action: 'add',
    include_in_signature_parity: true,
    include_in_feature_parity: true,
    rationale: 'Databento add messages create resting order-book state.',
  },
  {
    provider: 'databento',
    provider_action_raw: 'M',
    normalized_action: 'modify',
    include_in_signature_parity: true,
    include_in_feature_parity: true,
    rationale: 'Databento modify messages update resting order-book state.',
  },
  {
    provider: 'databento',
    provider_action_raw: 'C',
    normalized_action: 'cancel',
    include_in_signature_parity: true,
    include_in_feature_parity: true,
    rationale: 'Databento cancel messages remove resting order-book state.',
  },
  {
    provider: 'databento',
    provider_action_raw: 'T',
    normalized_action: 'trade',
    include_in_signature_parity: false,
    include_in_feature_parity: false,
    rationale: 'Databento trade actions may duplicate execution information carried by Rithmic LAST_TRADE rather than Rithmic MBO.',
  },
  {
    provider: 'databento',
    provider_action_raw: 'unknown/other',
    normalized_action: 'unknown',
    include_in_signature_parity: false,
    include_in_feature_parity: false,
    rationale: 'Unknown actions require raw-provider review before they can be included in hard parity or features.',
  },
];

function emptyActionSideDistribution(): Record<MboAction, Record<MboSide, number>> {
  return {
    add: emptySideDistribution(),
    modify: emptySideDistribution(),
    cancel: emptySideDistribution(),
    trade: emptySideDistribution(),
    clear: emptySideDistribution(),
    unknown: emptySideDistribution(),
  };
}

function emptyActionNumericCounts(): Record<MboAction, number> {
  return {
    add: 0,
    modify: 0,
    cancel: 0,
    trade: 0,
    clear: 0,
    unknown: 0,
  };
}

function emptyActionExamples(): Record<MboAction, MboActionExample[]> {
  return {
    add: [],
    modify: [],
    cancel: [],
    trade: [],
    clear: [],
    unknown: [],
  };
}

function actionExample(event: MboEvent): MboActionExample {
  return {
    ts_ns: event.ts_ns,
    raw_action: event.raw_action,
    action: event.action,
    raw_side: event.raw_side,
    side: event.side,
    price: event.price,
    size: event.size,
    order_id: event.order_id,
    sequence: event.sequence,
  };
}

function availabilityByAction(
  availableByAction: Readonly<Record<MboAction, number>>,
  totalsByAction: Readonly<Record<MboAction, number>>,
): Record<MboAction, AvailabilityReport> {
  return mapActionValues(totalsByAction, (_total, action) => ({
    available_count: availableByAction[action],
    total_count: totalsByAction[action],
    available_pct: pct(availableByAction[action], totalsByAction[action]),
  }));
}

function mapActionValues<T>(
  record: Readonly<Record<MboAction, number>>,
  mapValue: (value: number, action: MboAction) => T,
): Record<MboAction, T> {
  return {
    add: mapValue(record.add, 'add'),
    modify: mapValue(record.modify, 'modify'),
    cancel: mapValue(record.cancel, 'cancel'),
    trade: mapValue(record.trade, 'trade'),
    clear: mapValue(record.clear, 'clear'),
    unknown: mapValue(record.unknown, 'unknown'),
  };
}

function sortedRecordFromMap(map: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort((left, right) => left[0].localeCompare(right[0])));
}

function isIncludedInMode(mode: SignatureModeName, event: MboEvent): boolean {
  if (mode === 'strict_all_actions') {
    return true;
  }
  if (mode === 'exclude_unknown') {
    return event.action !== 'unknown';
  }
  if (mode === 'exclude_trade') {
    return event.action !== 'trade';
  }
  if (mode === 'exclude_trade_and_unknown') {
    return event.action !== 'trade' && event.action !== 'unknown';
  }
  return event.action === 'add' || event.action === 'modify' || event.action === 'cancel';
}

function eventBaseSignature(event: MboEvent): string {
  return [
    event.action,
    event.side,
    event.price === null ? 'null' : event.price.toFixed(2),
    event.size === null ? 'null' : String(event.size),
  ].join('|');
}

function eventExactSignature(event: MboEvent): string {
  return [event.ts_ns ?? 'missing', eventBaseSignature(event)].join('|');
}

function hasTimestampWithinWindow(timestamps: readonly bigint[], target: bigint, windowNs: bigint): boolean {
  let low = 0;
  let high = timestamps.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const value = timestamps[mid]!;
    if (value < target) {
      low = mid + 1;
    } else if (value > target) {
      high = mid - 1;
    } else {
      return true;
    }
  }
  if (windowNs === 0n) {
    return false;
  }
  for (const index of [low, low - 1]) {
    if (index < 0 || index >= timestamps.length) {
      continue;
    }
    const value = timestamps[index]!;
    const delta = value > target ? value - target : target - value;
    if (delta <= windowNs) {
      return true;
    }
  }
  return false;
}

function priceBucket(price: number | null): string {
  if (price === null) {
    return 'missing';
  }
  const start = Math.floor(price / 10) * 10;
  return `${start.toFixed(0)}-${(start + 10).toFixed(0)}`;
}

function sizeBucket(size: number | null): string {
  if (size === null) {
    return 'missing';
  }
  if (size === 0) return '0';
  if (size === 1) return '1';
  if (size <= 5) return '2-5';
  if (size <= 10) return '6-10';
  if (size <= 50) return '11-50';
  return '>50';
}

function sequenceBucket(sequence: string): string {
  const value = BigInt(sequence);
  return ((value / LARGE_SEQUENCE_BUCKET_SIZE) * LARGE_SEQUENCE_BUCKET_SIZE).toString();
}


function classifyMboParity(args: {
  readonly rithmic: MboProviderSummary;
  readonly databento: MboProviderSummary;
  readonly cross: MboCrossSourceSummary;
}): MboParityClassification {
  if (args.rithmic.event_count === 0 || args.databento.event_count === 0) {
    return 'inconclusive';
  }
  if (args.rithmic.sequence_analysis.decreased_count > 0 || args.databento.sequence_analysis.decreased_count > 0) {
    return 'mbo_sequence_semantics_mismatch';
  }
  if ((args.rithmic.price_sanity.tick_aligned_pct ?? 0) < 99 || (args.databento.price_sanity.tick_aligned_pct ?? 0) < 99) {
    return 'mbo_price_size_mismatch';
  }
  const maxActionDelta = maxNullableRecordValue(args.cross.action_distribution_delta_pct);
  const maxSideDelta = maxNullableRecordValue(args.cross.side_distribution_delta_pct);
  if (maxActionDelta > 5 || maxSideDelta > 5) {
    return 'mbo_action_side_mismatch';
  }
  if ((args.rithmic.order_id_coverage_pct ?? 0) < 90 || (args.databento.order_id_coverage_pct ?? 0) < 90) {
    return 'mbo_order_id_semantics_incompatible';
  }
  if ((args.cross.signature_match_pct_of_databento ?? 0) >= 95) {
    return 'mbo_event_semantics_aligned';
  }
  return 'inconclusive';
}

function recommendationForMboClassification(classification: MboParityClassification): string {
  if (classification === 'mbo_event_semantics_aligned') {
    return 'MBO event semantics appear aligned, but DATA-01B still requires reviewer policy acceptance before enabling MBO-derived features.';
  }
  if (classification === 'mbo_action_side_mismatch') {
    return 'Action or side distributions differ materially; inspect Rithmic and Databento action/side normalization before trusting MBO-derived features.';
  }
  if (classification === 'mbo_price_size_mismatch') {
    return 'Price or size semantics fail sanity checks; inspect tick scaling and size normalization before MBO parity can be accepted.';
  }
  if (classification === 'mbo_sequence_semantics_mismatch') {
    return 'One provider shows decreasing sequence values; inspect sequence semantics before using MBO ordering as gate evidence.';
  }
  if (classification === 'mbo_order_id_semantics_incompatible') {
    return 'Order ID coverage or compatibility is insufficient; do not require order-id byte equality until native ID semantics are reviewed.';
  }
  return 'MBO parity is inconclusive; keep DATA-01B full scope and MBO-derived features blocked pending manual review.';
}

function mboSignature(event: MboEvent): string {
  return [
    event.ts_ns === null ? 'missing' : bucketStart(event.ts_ns, SIGNATURE_BUCKET_NS),
    event.action,
    event.side,
    event.price === null ? 'null' : event.price.toFixed(2),
    event.size === null ? 'null' : String(event.size),
  ].join('|');
}

function pushMboMismatch(
  collection: MboSignatureMismatch[],
  event: MboEvent,
  provider: 'databento' | 'rithmic',
): void {
  if (collection.length >= FIRST_MISMATCH_LIMIT || event.ts_ns === null) {
    return;
  }
  collection.push({
    ts_ns: event.ts_ns,
    bucket_start_ts_ns: bucketStart(event.ts_ns, SIGNATURE_BUCKET_NS),
    action: event.action,
    side: event.side,
    price: event.price,
    size: event.size,
    provider,
    reason: 'signature_not_found_in_other_provider',
  });
}

function normalizeAction(value: unknown): MboAction {
  if (typeof value === 'number') {
    if (value === 1) return 'add';
    if (value === 2) return 'modify';
    if (value === 3) return 'cancel';
  }
  if (typeof value !== 'string') {
    return 'unknown';
  }
  const normalized = value.trim().toLowerCase();
  if (['a', 'add', 'new'].includes(normalized)) return 'add';
  if (['m', 'modify', 'modified', 'change', 'update'].includes(normalized)) return 'modify';
  if (['c', 'cancel', 'cancelled', 'delete', 'deleted', 'remove'].includes(normalized)) return 'cancel';
  if (['t', 'trade', 'fill', 'filled'].includes(normalized)) return 'trade';
  if (['r', 'clear', 'reset'].includes(normalized)) return 'clear';
  return 'unknown';
}

function normalizeSide(value: unknown): MboSide {
  if (typeof value === 'number') {
    if (value === 1) return 'bid';
    if (value === 2) return 'ask';
  }
  if (typeof value !== 'string') {
    return 'unknown';
  }
  const normalized = value.trim().toLowerCase();
  if (['b', 'bid', 'buy'].includes(normalized)) return 'bid';
  if (['a', 'ask', 'offer', 'sell'].includes(normalized)) return 'ask';
  return 'unknown';
}

function emptyActionDistribution(): Record<MboAction, number> {
  return {
    add: 0,
    modify: 0,
    cancel: 0,
    trade: 0,
    clear: 0,
    unknown: 0,
  };
}

function emptySideDistribution(): Record<MboSide, number> {
  return {
    bid: 0,
    ask: 0,
    unknown: 0,
  };
}

function distributionDeltas<T extends string>(
  left: Readonly<Record<T, number>>,
  right: Readonly<Record<T, number>>,
): Readonly<Record<T, number | null>> {
  const leftTotal = Object.values<number>(left as Record<string, number>).reduce((total, value) => total + value, 0);
  const rightTotal = Object.values<number>(right as Record<string, number>).reduce((total, value) => total + value, 0);
  const result: Partial<Record<T, number | null>> = {};
  for (const key of Object.keys(left) as T[]) {
    const leftPct = pct(left[key], leftTotal);
    const rightPct = pct(right[key], rightTotal);
    result[key] = leftPct === null || rightPct === null ? null : round(Math.abs(leftPct - rightPct));
  }
  return result as Readonly<Record<T, number | null>>;
}

function maxNullableRecordValue(record: Readonly<Record<string, number | null>>): number {
  let value = 0;
  for (const item of Object.values(record)) {
    if (item !== null) {
      value = Math.max(value, item);
    }
  }
  return value;
}

function incrementMapCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function bucketStart(tsNs: string, bucketNs: bigint): string {
  return ((BigInt(tsNs) / bucketNs) * bucketNs).toString();
}

function isMboRecord(record: unknown): record is Record<string, unknown> {
  if (!isRecord(record)) {
    return false;
  }
  const stream = firstField(record, ['stream', 'stream_id', 'payload_kind']);
  return stream === 'MBO';
}

function optionalDecimalString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  const value = firstField(record, keys);
  if (value === undefined || value === null || value === '') {
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
  throw new Error(`${keys.join('/')} must be a decimal integer string or safe integer`);
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

function optionalString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  const value = firstField(record, keys);
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return String(value);
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

function isTickAligned(price: number): boolean {
  const ticks = price / MNQ_TICK_SIZE;
  return Math.abs(ticks - Math.round(ticks)) < 1e-9;
}

function percentile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index]!;
}

function pct(numerator: number, denominator: number): number | null {
  if (denominator === 0) {
    return null;
  }
  return round((numerator / denominator) * 100);
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function usage(): string {
  return [
    'Usage: npm run infra:analyze-mbo-parity -- --rithmic-probe <probe.jsonl> --databento-mbo <mbo.jsonl> --out <report.json>',
    '',
    `Default --out: ${DEFAULT_OUT_PATH}`,
  ].join('\n');
}

function parseArgs(argv: readonly string[]): CliArgs {
  let rithmicProbePath: string | undefined;
  let databentoMboPath: string | undefined;
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
    if (arg === '--databento-mbo') {
      databentoMboPath = argv[index + 1];
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
  if (!databentoMboPath) {
    throw new Error(`--databento-mbo is required\n${usage()}`);
  }
  return {
    rithmic_probe_path: rithmicProbePath,
    databento_mbo_path: databentoMboPath,
    out_path: outPath ?? DEFAULT_OUT_PATH,
  };
}

function formatSummary(report: MboParityReport): string {
  const bestMode = bestSignatureMode(report.mbo_action_taxonomy.alternate_signature_modes);
  return [
    'DATA-PARITY-10 MBO parity diagnostic: analysis_only',
    `classification=${report.classification}`,
    `taxonomy_classification=${report.mbo_action_taxonomy.classification}`,
    `rithmic_events=${report.rithmic_mbo.event_count}`,
    `databento_events=${report.databento_mbo.event_count}`,
    `signature_match_pct_of_databento=${report.cross_source.signature_match_pct_of_databento}`,
    `best_signature_mode=${bestMode}`,
    `best_signature_mode_match_pct=${report.mbo_action_taxonomy.alternate_signature_modes[bestMode].match_pct_of_databento}`,
    `rithmic_sequence_non_decreasing=${report.rithmic_mbo.sequence_analysis.non_decreasing}`,
    `databento_sequence_non_decreasing=${report.databento_mbo.sequence_analysis.non_decreasing}`,
    'DATA-01B full scope remains blocked pending MBO policy review.',
    '',
  ].join('\n');
}

function bestSignatureMode(modes: Readonly<Record<SignatureModeName, AlternateSignatureModeReport>>): SignatureModeName {
  let best: SignatureModeName = 'strict_all_actions';
  for (const mode of SIGNATURE_MODES) {
    const candidatePct = modes[mode].match_pct_of_databento ?? -1;
    const bestPct = modes[best].match_pct_of_databento ?? -1;
    if (candidatePct > bestPct) {
      best = mode;
    }
  }
  return best;
}

function main(): void {
  try {
    const args = parseArgs(processArgv.slice(2));
    const report = analyzeMboParity({
      rithmic_probe_path: args.rithmic_probe_path,
      databento_mbo_path: args.databento_mbo_path,
    });
    writeMboParityReport(report, args.out_path);
    processStdout.write(formatSummary(report));
    processExit(0);
  } catch (error) {
    processStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    processExit(3);
  }
}

if (processArgv[1] !== undefined && resolve(processArgv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
