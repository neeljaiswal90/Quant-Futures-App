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

export type MboParityClassification =
  | 'mbo_event_semantics_aligned'
  | 'mbo_action_side_mismatch'
  | 'mbo_price_size_mismatch'
  | 'mbo_sequence_semantics_mismatch'
  | 'mbo_order_id_semantics_incompatible'
  | 'inconclusive';

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
  readonly action: MboAction;
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
const FIRST_MISMATCH_LIMIT = 20;

export function analyzeMboParity(options: {
  readonly rithmic_probe_path: string;
  readonly databento_mbo_path: string;
}): MboParityReport {
  const rithmicPath = resolve(options.rithmic_probe_path);
  const databentoPath = resolve(options.databento_mbo_path);
  const rithmicSummary = createProviderSummary();
  const databentoSummary = createProviderSummary();
  const crossSource = createCrossSourceSummary();

  forEachRithmicMboEvent(rithmicPath, (event) => {
    updateProviderSummary(rithmicSummary, event);
    crossSource.rithmic_event_count += 1;
    if (event.ts_ns !== null) {
      incrementMapCount(crossSource.rithmic_signatures, mboSignature(event));
    }
  });

  forEachDatabentoMboEvent(databentoPath, (event) => {
    updateProviderSummary(databentoSummary, event);
    crossSource.databento_event_count += 1;
    if (event.ts_ns === null) {
      return;
    }
    const signature = mboSignature(event);
    const remaining = crossSource.rithmic_signatures.get(signature) ?? 0;
    if (remaining > 0) {
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
  });

  const rithmic = finalizeProviderSummary(rithmicSummary);
  const databento = finalizeProviderSummary(databentoSummary);
  const cross = finalizeCrossSourceSummary(crossSource, rithmic, databento);
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
  return {
    ts_ns: tsNs,
    action: normalizeAction(firstField(record, ['action', 'update_type', 'event_action'])),
    side: normalizeSide(firstField(record, ['side', 'transaction_type'])),
    price: optionalFiniteNumber(record, ['price', 'px', 'depth_price']),
    size: optionalFiniteInteger(record, ['size', 'sz', 'depth_size']),
    order_id: optionalString(record, ['order_id', 'exchange_order_id', 'orderid']),
    sequence,
  };
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
  return [
    'DATA-PARITY-10 MBO parity diagnostic: analysis_only',
    `classification=${report.classification}`,
    `rithmic_events=${report.rithmic_mbo.event_count}`,
    `databento_events=${report.databento_mbo.event_count}`,
    `signature_match_pct_of_databento=${report.cross_source.signature_match_pct_of_databento}`,
    `rithmic_sequence_non_decreasing=${report.rithmic_mbo.sequence_analysis.non_decreasing}`,
    `databento_sequence_non_decreasing=${report.databento_mbo.sequence_analysis.non_decreasing}`,
    'DATA-01B full scope remains blocked pending MBO policy review.',
    '',
  ].join('\n');
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
