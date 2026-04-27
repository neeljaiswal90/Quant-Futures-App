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

export const INFRA_01C_REPORT_SCHEMA_VERSION = 1 as const;

export type TimestampOrderClassification =
  | 'extraction_bug_suspected'
  | 'timestamp_semantics_mismatch'
  | 'bounded_out_of_order_delivery'
  | 'state_stream_not_strict_event_stream'
  | 'inconclusive';

export interface TimestampOrderAnalysisOptions {
  readonly probe_path: string;
  readonly out_path?: string;
}

export interface TimestampOrderReport {
  readonly schema_version: typeof INFRA_01C_REPORT_SCHEMA_VERSION;
  readonly ticket_id: 'INFRA-01C';
  readonly probe_path: string;
  readonly summary: {
    readonly total_records: number;
    readonly streams: readonly string[];
    readonly streams_with_violations: readonly string[];
  };
  readonly streams: Readonly<Record<string, StreamOrderReport>>;
  readonly sequence_analysis: Readonly<Record<string, StreamSequenceReport>>;
  readonly cross_stream_analysis: CrossStreamAnalysisReport;
  readonly disorder_window_analysis: Readonly<Record<string, StreamDisorderWindowReport>>;
  readonly classification: TimestampOrderClassification;
  readonly recommendation: RecommendationReport;
}

export interface StreamOrderReport {
  readonly record_count: number;
  readonly timestamp_coverage: {
    readonly valid_count: number;
    readonly missing_count: number;
    readonly coverage_ratio: number;
  };
  readonly non_decreasing: boolean;
  readonly violation_count: number;
  readonly violation_rate: number;
  readonly first_violation: TimestampViolationSummary | null;
  readonly last_violation: TimestampViolationSummary | null;
  readonly max_negative_delta_ns: string | null;
  readonly max_negative_delta_ms: number | null;
  readonly negative_delta_magnitude: PercentileSummary;
  readonly counts_by_timestamp_source: Readonly<Record<string, number>>;
  readonly counts_by_template_id: Readonly<Record<string, number>>;
  readonly counts_by_payload_kind: Readonly<Record<string, number>>;
}

export interface StreamSequenceReport {
  readonly sequence_present_count: number;
  readonly sequence_missing_count: number;
  readonly sequence_monotonic: boolean | null;
  readonly sequence_decrease_count: number;
  readonly sequence_gap_count: number;
  readonly timestamp_decrease_with_sequence_monotonic_count: number;
  readonly timestamp_decrease_with_sequence_gap_count: number;
  readonly adjacent_file_violation_count: number;
  readonly violation_cluster_count: number;
  readonly first_sequence_timestamp_violation: SequenceTimestampViolationSummary | null;
}

export interface CrossStreamAnalysisReport {
  readonly pairs: readonly CrossStreamPairReport[];
  readonly mbp10_violations_near_mbo: NearbyStreamViolationReport | null;
}

export interface StreamDisorderWindowReport {
  readonly violation_count: number;
  readonly windows: readonly DisorderWindowResult[];
}

interface ParsedProbeRecord {
  readonly record_index: number;
  readonly stream_id: string;
  readonly exchange_event_ts_ns: bigint | null;
  readonly timestamp_source: string;
  readonly template_id: string;
  readonly payload_kind: string;
  readonly sequence: bigint | null;
  readonly sequence_raw: string | null;
}

interface TimestampViolation {
  readonly previous: ParsedProbeRecord;
  readonly current: ParsedProbeRecord;
  readonly delta_ns: bigint;
  readonly stream_position: number;
}

interface TimestampViolationSummary {
  readonly previous_record_index: number;
  readonly current_record_index: number;
  readonly previous_exchange_event_ts_ns: string;
  readonly current_exchange_event_ts_ns: string;
  readonly negative_delta_ns: string;
  readonly negative_delta_ms: number;
  readonly previous_sequence: string | null;
  readonly current_sequence: string | null;
  readonly timestamp_source: string;
  readonly template_id: string;
  readonly payload_kind: string;
}

interface SequenceTimestampViolationSummary extends TimestampViolationSummary {
  readonly sequence_delta: string | null;
}

interface PercentileSummary {
  readonly p50_ns: string | null;
  readonly p95_ns: string | null;
  readonly p99_ns: string | null;
  readonly p50_ms: number | null;
  readonly p95_ms: number | null;
  readonly p99_ms: number | null;
}

interface CrossStreamPairReport {
  readonly pair: string;
  readonly left_stream: string;
  readonly right_stream: string;
  readonly left_timestamp_count: number;
  readonly right_timestamp_count: number;
  readonly overlap: boolean;
  readonly nearest_abs_delta: PercentileSummary;
  readonly max_nearest_abs_delta_ns: string | null;
  readonly max_nearest_abs_delta_ms: number | null;
  readonly interpretation: string;
}

interface NearbyStreamViolationReport {
  readonly violation_stream: 'MBP10';
  readonly nearby_stream: 'MBO';
  readonly violation_count: number;
  readonly nearest_abs_delta: PercentileSummary;
  readonly within_1ms_count: number;
  readonly within_5ms_count: number;
  readonly within_10ms_count: number;
  readonly interpretation: string;
}

interface DisorderWindowResult {
  readonly window_ms: number;
  readonly window_ns: string;
  readonly unresolved_violation_count: number;
  readonly resolved_violation_count: number;
  readonly would_resolve_local_decreases: boolean;
}

interface RecommendationReport {
  readonly infra01b_gate_options: {
    readonly remain_strict_monotonic_for_all_streams: boolean;
    readonly require_strict_monotonic_only_for_mbo_and_last_trade: boolean;
    readonly allow_bounded_disorder_for_l1_quote_and_mbp10: boolean;
    readonly order_l1_quote_mbp10_by_rithmic_sequence_using_exchange_ts_as_metadata: boolean;
    readonly require_databento_parity_before_deciding: boolean;
  };
  readonly summary: string;
  readonly reasons: readonly string[];
}

interface CliArgs {
  readonly probe_path: string;
  readonly out_path: string;
}

const DEFAULT_REPORT_PATH = 'reports/infra/infra01c_timestamp_order_report.json';
const DISORDER_WINDOWS_MS = [1, 5, 10, 50, 100, 500] as const;
const QUOTE_BOOK_STREAMS = new Set(['L1_QUOTE', 'MBP10']);
const STRICT_EVENT_STREAMS = new Set(['LAST_TRADE', 'MBO']);

export function analyzeRithmicTimestampOrder(
  options: TimestampOrderAnalysisOptions,
): TimestampOrderReport {
  const probePath = resolve(options.probe_path);
  const records = readProbeJsonl(probePath);
  const grouped = groupByStream(records);
  const streamReports: Record<string, StreamOrderReport> = {};
  const sequenceReports: Record<string, StreamSequenceReport> = {};
  const violationsByStream = new Map<string, readonly TimestampViolation[]>();

  for (const [streamId, streamRecords] of sortedEntries(grouped)) {
    const violations = collectTimestampViolations(streamRecords);
    violationsByStream.set(streamId, violations);
    streamReports[streamId] = analyzeStream(streamRecords, violations);
    sequenceReports[streamId] = analyzeSequence(streamRecords, violations);
  }

  const disorderWindowAnalysis = buildDisorderWindowAnalysis(violationsByStream);
  const crossStreamAnalysis = buildCrossStreamAnalysis(grouped, violationsByStream);
  const classification = classifyReport(streamReports, sequenceReports, disorderWindowAnalysis);
  const recommendation = buildRecommendation(classification, streamReports, sequenceReports, disorderWindowAnalysis);
  const streams = Object.keys(streamReports).sort(compareStrings);

  return {
    schema_version: INFRA_01C_REPORT_SCHEMA_VERSION,
    ticket_id: 'INFRA-01C',
    probe_path: probePath,
    summary: {
      total_records: records.length,
      streams,
      streams_with_violations: streams.filter((streamId) => streamReports[streamId]!.violation_count > 0),
    },
    streams: streamReports,
    sequence_analysis: sequenceReports,
    cross_stream_analysis: crossStreamAnalysis,
    disorder_window_analysis: disorderWindowAnalysis,
    classification,
    recommendation,
  };
}

export function writeTimestampOrderReport(report: TimestampOrderReport, outPath: string): void {
  const resolved = resolve(outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${stableJsonStringify(report as unknown as JsonValue)}\n`, 'utf8');
}

export function formatTimestampOrderSummary(report: TimestampOrderReport): string {
  const lines = [
    `INFRA-01C timestamp order analysis: ${report.classification}`,
    `probe=${report.probe_path}`,
    `streams=${report.summary.streams.join(',')}`,
    `streams_with_violations=${report.summary.streams_with_violations.join(',') || 'none'}`,
    `recommendation=${report.recommendation.summary}`,
  ];

  for (const streamId of report.summary.streams) {
    const stream = report.streams[streamId]!;
    lines.push(
      `${streamId}: records=${stream.record_count} coverage=${stream.timestamp_coverage.coverage_ratio} violations=${stream.violation_count} rate=${stream.violation_rate}`,
    );
  }

  return `${lines.join('\n')}\n`;
}

function readProbeJsonl(path: string): ParsedProbeRecord[] {
  const records: ParsedProbeRecord[] = [];
  forEachJsonlLine(path, (trimmed, lineNumber) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `probe line ${lineNumber}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    records.push(normalizeProbeRecord(parsed, lineNumber));
  });

  return records;
}

function normalizeProbeRecord(value: unknown, recordIndex: number): ParsedProbeRecord {
  if (!isRecord(value)) {
    throw new Error(`probe line ${recordIndex}: JSON value must be an object`);
  }

  const streamValue = firstField(value, ['stream', 'stream_id', 'event_type', 'type']);
  if (typeof streamValue !== 'string' || streamValue.trim() === '') {
    throw new Error(`probe line ${recordIndex}: stream is required`);
  }

  return {
    record_index: recordIndex,
    stream_id: streamValue.trim(),
    exchange_event_ts_ns: optionalBigIntField(value, ['exchange_event_ts_ns', 'source_event_ts_ns']),
    timestamp_source: optionalStringField(value, 'timestamp_source') ?? 'missing',
    template_id: stringifyCountKey(firstField(value, ['template_id'])),
    payload_kind: optionalStringField(value, 'payload_kind') ?? 'missing',
    sequence: optionalBigIntField(value, ['sequence']),
    sequence_raw: optionalSequenceRaw(value),
  };
}

function analyzeStream(
  records: readonly ParsedProbeRecord[],
  violations: readonly TimestampViolation[],
): StreamOrderReport {
  const validTimestampCount = records.filter((record) => record.exchange_event_ts_ns !== null).length;
  const negativeDeltas = violations.map((violation) => violation.delta_ns);
  const maxNegativeDelta = maxBigInt(negativeDeltas);

  return {
    record_count: records.length,
    timestamp_coverage: {
      valid_count: validTimestampCount,
      missing_count: records.length - validTimestampCount,
      coverage_ratio: ratio(validTimestampCount, records.length),
    },
    non_decreasing: violations.length === 0,
    violation_count: violations.length,
    violation_rate: ratio(violations.length, Math.max(validTimestampCount - 1, 0)),
    first_violation: violations[0] === undefined ? null : summarizeViolation(violations[0]),
    last_violation: violations[violations.length - 1] === undefined ? null : summarizeViolation(violations[violations.length - 1]!),
    max_negative_delta_ns: maxNegativeDelta === null ? null : maxNegativeDelta.toString(),
    max_negative_delta_ms: maxNegativeDelta === null ? null : nsToMs(maxNegativeDelta),
    negative_delta_magnitude: percentileSummary(negativeDeltas),
    counts_by_timestamp_source: countBy(records, (record) => record.timestamp_source),
    counts_by_template_id: countBy(records, (record) => record.template_id),
    counts_by_payload_kind: countBy(records, (record) => record.payload_kind),
  };
}

function analyzeSequence(
  records: readonly ParsedProbeRecord[],
  violations: readonly TimestampViolation[],
): StreamSequenceReport {
  const sequenceRecords = records.filter((record) => record.sequence !== null);
  let sequenceDecreaseCount = 0;
  let sequenceGapCount = 0;
  let previousSequenceRecord: ParsedProbeRecord | undefined;

  for (const record of sequenceRecords) {
    if (
      previousSequenceRecord !== undefined &&
      record.sequence !== null &&
      previousSequenceRecord.sequence !== null
    ) {
      const delta = record.sequence - previousSequenceRecord.sequence;
      if (delta < 0n) {
        sequenceDecreaseCount += 1;
      }
      if (delta > 1n) {
        sequenceGapCount += 1;
      }
    }
    previousSequenceRecord = record;
  }

  let timestampDecreaseWithSequenceMonotonicCount = 0;
  let timestampDecreaseWithSequenceGapCount = 0;
  let adjacentFileViolationCount = 0;
  let firstSequenceTimestampViolation: SequenceTimestampViolationSummary | null = null;
  const violationClusters = countViolationClusters(violations);

  for (const violation of violations) {
    if (violation.current.record_index === violation.previous.record_index + 1) {
      adjacentFileViolationCount += 1;
    }
    if (violation.previous.sequence !== null && violation.current.sequence !== null) {
      const sequenceDelta = violation.current.sequence - violation.previous.sequence;
      if (sequenceDelta >= 0n) {
        timestampDecreaseWithSequenceMonotonicCount += 1;
      }
      if (sequenceDelta > 1n) {
        timestampDecreaseWithSequenceGapCount += 1;
      }
      if (firstSequenceTimestampViolation === null) {
        firstSequenceTimestampViolation = {
          ...summarizeViolation(violation),
          sequence_delta: sequenceDelta.toString(),
        };
      }
    }
  }

  return {
    sequence_present_count: sequenceRecords.length,
    sequence_missing_count: records.length - sequenceRecords.length,
    sequence_monotonic: sequenceRecords.length === 0 ? null : sequenceDecreaseCount === 0,
    sequence_decrease_count: sequenceDecreaseCount,
    sequence_gap_count: sequenceGapCount,
    timestamp_decrease_with_sequence_monotonic_count: timestampDecreaseWithSequenceMonotonicCount,
    timestamp_decrease_with_sequence_gap_count: timestampDecreaseWithSequenceGapCount,
    adjacent_file_violation_count: adjacentFileViolationCount,
    violation_cluster_count: violationClusters,
    first_sequence_timestamp_violation: firstSequenceTimestampViolation,
  };
}

function collectTimestampViolations(records: readonly ParsedProbeRecord[]): readonly TimestampViolation[] {
  const violations: TimestampViolation[] = [];
  let previous: ParsedProbeRecord | undefined;
  let streamPosition = 0;

  for (const record of records) {
    if (record.exchange_event_ts_ns === null) {
      continue;
    }
    streamPosition += 1;
    if (
      previous !== undefined &&
      previous.exchange_event_ts_ns !== null &&
      record.exchange_event_ts_ns < previous.exchange_event_ts_ns
    ) {
      violations.push({
        previous,
        current: record,
        delta_ns: previous.exchange_event_ts_ns - record.exchange_event_ts_ns,
        stream_position: streamPosition,
      });
    }
    previous = record;
  }

  return violations;
}

function buildDisorderWindowAnalysis(
  violationsByStream: ReadonlyMap<string, readonly TimestampViolation[]>,
): Readonly<Record<string, StreamDisorderWindowReport>> {
  const report: Record<string, StreamDisorderWindowReport> = {};
  for (const streamId of ['L1_QUOTE', 'MBP10']) {
    const violations = violationsByStream.get(streamId) ?? [];
    report[streamId] = {
      violation_count: violations.length,
      windows: DISORDER_WINDOWS_MS.map((windowMs) => {
        const windowNs = BigInt(windowMs) * 1_000_000n;
        const unresolved = violations.filter((violation) => violation.delta_ns > windowNs).length;
        return {
          window_ms: windowMs,
          window_ns: windowNs.toString(),
          unresolved_violation_count: unresolved,
          resolved_violation_count: violations.length - unresolved,
          would_resolve_local_decreases: unresolved === 0,
        };
      }),
    };
  }
  return report;
}

function buildCrossStreamAnalysis(
  grouped: ReadonlyMap<string, readonly ParsedProbeRecord[]>,
  violationsByStream: ReadonlyMap<string, readonly TimestampViolation[]>,
): CrossStreamAnalysisReport {
  return {
    pairs: [
      buildCrossStreamPair('LAST_TRADE', 'MBO', grouped),
      buildCrossStreamPair('L1_QUOTE', 'MBP10', grouped),
    ],
    mbp10_violations_near_mbo: buildNearbyMboReport(grouped, violationsByStream),
  };
}

function buildCrossStreamPair(
  leftStream: string,
  rightStream: string,
  grouped: ReadonlyMap<string, readonly ParsedProbeRecord[]>,
): CrossStreamPairReport {
  const leftTimestamps = sortedTimestamps(grouped.get(leftStream) ?? []);
  const rightTimestamps = sortedTimestamps(grouped.get(rightStream) ?? []);
  const nearestDeltas = nearestAbsDeltas(leftTimestamps, rightTimestamps);
  const maxNearestDelta = maxBigInt(nearestDeltas);
  const overlap = rangesOverlap(leftTimestamps, rightTimestamps);

  return {
    pair: `${leftStream}_vs_${rightStream}`,
    left_stream: leftStream,
    right_stream: rightStream,
    left_timestamp_count: leftTimestamps.length,
    right_timestamp_count: rightTimestamps.length,
    overlap,
    nearest_abs_delta: percentileSummary(nearestDeltas),
    max_nearest_abs_delta_ns: maxNearestDelta === null ? null : maxNearestDelta.toString(),
    max_nearest_abs_delta_ms: maxNearestDelta === null ? null : nsToMs(maxNearestDelta),
    interpretation:
      nearestDeltas.length === 0
        ? 'insufficient_timestamp_overlap'
        : overlap
          ? 'streams_share_overlapping_exchange_time_ranges'
          : 'streams_do_not_overlap_in_exchange_time',
  };
}

function buildNearbyMboReport(
  grouped: ReadonlyMap<string, readonly ParsedProbeRecord[]>,
  violationsByStream: ReadonlyMap<string, readonly TimestampViolation[]>,
): NearbyStreamViolationReport | null {
  const mbp10Violations = violationsByStream.get('MBP10') ?? [];
  if (mbp10Violations.length === 0) {
    return null;
  }
  const mboTimestamps = sortedTimestamps(grouped.get('MBO') ?? []);
  const violationTimestamps = mbp10Violations
    .map((violation) => violation.current.exchange_event_ts_ns)
    .filter((timestamp): timestamp is bigint => timestamp !== null);
  const nearestDeltas = nearestAbsDeltas(violationTimestamps, mboTimestamps);

  return {
    violation_stream: 'MBP10',
    nearby_stream: 'MBO',
    violation_count: mbp10Violations.length,
    nearest_abs_delta: percentileSummary(nearestDeltas),
    within_1ms_count: nearestDeltas.filter((delta) => delta <= 1_000_000n).length,
    within_5ms_count: nearestDeltas.filter((delta) => delta <= 5_000_000n).length,
    within_10ms_count: nearestDeltas.filter((delta) => delta <= 10_000_000n).length,
    interpretation:
      nearestDeltas.length === 0
        ? 'no_mbo_timestamps_available_for_comparison'
        : 'mbp10_decreases_have_nearby_mbo_exchange_timestamps_for_context',
  };
}

function classifyReport(
  streams: Readonly<Record<string, StreamOrderReport>>,
  sequenceAnalysis: Readonly<Record<string, StreamSequenceReport>>,
  disorderWindows: Readonly<Record<string, StreamDisorderWindowReport>>,
): TimestampOrderClassification {
  const violatingStreamIds = Object.keys(streams)
    .filter((streamId) => streams[streamId]!.violation_count > 0)
    .sort(compareStrings);
  if (violatingStreamIds.length === 0) {
    return 'inconclusive';
  }

  const strictEventStreamViolation = violatingStreamIds.some((streamId) => STRICT_EVENT_STREAMS.has(streamId));
  if (strictEventStreamViolation) {
    return 'extraction_bug_suspected';
  }

  const onlyQuoteBookStreams = violatingStreamIds.every((streamId) => QUOTE_BOOK_STREAMS.has(streamId));
  const highRepeatedDecrease = violatingStreamIds.some((streamId) => {
    const stream = streams[streamId]!;
    return stream.violation_count >= 100 && stream.violation_rate >= 0.01;
  });
  const allResolvedBy500ms = violatingStreamIds.every(
    (streamId) =>
      disorderWindows[streamId]?.windows.find((window) => window.window_ms === 500)
        ?.would_resolve_local_decreases ?? false,
  );
  const sequenceMonotonicDuringDecrease = violatingStreamIds.some(
    (streamId) =>
      sequenceAnalysis[streamId]!.timestamp_decrease_with_sequence_monotonic_count > 0,
  );

  if (onlyQuoteBookStreams && highRepeatedDecrease) {
    return 'state_stream_not_strict_event_stream';
  }
  if (onlyQuoteBookStreams && allResolvedBy500ms) {
    return 'bounded_out_of_order_delivery';
  }
  if (onlyQuoteBookStreams && sequenceMonotonicDuringDecrease) {
    return 'timestamp_semantics_mismatch';
  }
  if (onlyQuoteBookStreams) {
    return 'timestamp_semantics_mismatch';
  }
  return 'inconclusive';
}

function buildRecommendation(
  classification: TimestampOrderClassification,
  streams: Readonly<Record<string, StreamOrderReport>>,
  sequenceAnalysis: Readonly<Record<string, StreamSequenceReport>>,
  disorderWindows: Readonly<Record<string, StreamDisorderWindowReport>>,
): RecommendationReport {
  const l1 = streams.L1_QUOTE;
  const mbp10 = streams.MBP10;
  const quoteBookViolations = (l1?.violation_count ?? 0) + (mbp10?.violation_count ?? 0);
  const mbp10Sequence = sequenceAnalysis.MBP10;
  const l1Sequence = sequenceAnalysis.L1_QUOTE;
  const resolvedBy500 =
    (disorderWindows.L1_QUOTE?.windows.find((window) => window.window_ms === 500)?.would_resolve_local_decreases ??
      true) &&
    (disorderWindows.MBP10?.windows.find((window) => window.window_ms === 500)?.would_resolve_local_decreases ??
      true);

  const requireStrictOnlyEventStreams =
    classification === 'state_stream_not_strict_event_stream' ||
    classification === 'timestamp_semantics_mismatch' ||
    classification === 'bounded_out_of_order_delivery';
  const allowBoundedDisorder =
    classification === 'bounded_out_of_order_delivery' ||
    (classification === 'state_stream_not_strict_event_stream' && resolvedBy500);
  const orderBySequence =
    (mbp10Sequence?.sequence_present_count ?? 0) > 0 ||
    (l1Sequence?.sequence_present_count ?? 0) > 0;

  return {
    infra01b_gate_options: {
      remain_strict_monotonic_for_all_streams:
        classification === 'extraction_bug_suspected' || classification === 'inconclusive',
      require_strict_monotonic_only_for_mbo_and_last_trade: requireStrictOnlyEventStreams,
      allow_bounded_disorder_for_l1_quote_and_mbp10: allowBoundedDisorder,
      order_l1_quote_mbp10_by_rithmic_sequence_using_exchange_ts_as_metadata: orderBySequence,
      require_databento_parity_before_deciding: true,
    },
    summary:
      classification === 'state_stream_not_strict_event_stream'
        ? 'Treat quote/book decreases as evidence that L1_QUOTE/MBP10 are state streams, not strict event streams; keep DATA-01 blocked pending Databento parity and an explicit INFRA-01B gate decision.'
        : classification === 'bounded_out_of_order_delivery'
          ? 'A bounded reorder policy may be sufficient for L1_QUOTE/MBP10, but Databento parity is still required before changing INFRA-01B.'
          : classification === 'extraction_bug_suspected'
            ? 'A strict event stream decreased; investigate timestamp extraction before changing INFRA-01B.'
            : 'Evidence is not decisive; keep INFRA-01B strict until more analysis or parity evidence is available.',
    reasons: [
      `quote_book_violation_count=${quoteBookViolations}`,
      `classification=${classification}`,
      `l1_quote_sequence_present=${l1Sequence?.sequence_present_count ?? 0}`,
      `mbp10_sequence_present=${mbp10Sequence?.sequence_present_count ?? 0}`,
      `resolved_by_500ms=${resolvedBy500}`,
      'DATA-01 remains blocked until INFRA-01 verification explicitly routes to DATA-01.',
    ],
  };
}

function sortedTimestamps(records: readonly ParsedProbeRecord[]): readonly bigint[] {
  return records
    .map((record) => record.exchange_event_ts_ns)
    .filter((timestamp): timestamp is bigint => timestamp !== null)
    .sort(compareBigInt);
}

function nearestAbsDeltas(left: readonly bigint[], right: readonly bigint[]): readonly bigint[] {
  if (left.length === 0 || right.length === 0) {
    return [];
  }

  const deltas: bigint[] = [];
  let rightIndex = 0;
  for (const timestamp of left) {
    while (
      rightIndex + 1 < right.length &&
      absBigInt(right[rightIndex + 1]! - timestamp) <= absBigInt(right[rightIndex]! - timestamp)
    ) {
      rightIndex += 1;
    }
    deltas.push(absBigInt(right[rightIndex]! - timestamp));
  }
  return deltas;
}

function rangesOverlap(left: readonly bigint[], right: readonly bigint[]): boolean {
  if (left.length === 0 || right.length === 0) {
    return false;
  }
  return left[0]! <= right[right.length - 1]! && right[0]! <= left[left.length - 1]!;
}

function countViolationClusters(violations: readonly TimestampViolation[]): number {
  let clusterCount = 0;
  let previousStreamPosition: number | undefined;
  for (const violation of violations) {
    if (previousStreamPosition === undefined || violation.stream_position - previousStreamPosition > 10) {
      clusterCount += 1;
    }
    previousStreamPosition = violation.stream_position;
  }
  return clusterCount;
}

function summarizeViolation(violation: TimestampViolation): TimestampViolationSummary {
  return {
    previous_record_index: violation.previous.record_index,
    current_record_index: violation.current.record_index,
    previous_exchange_event_ts_ns: violation.previous.exchange_event_ts_ns?.toString() ?? 'missing',
    current_exchange_event_ts_ns: violation.current.exchange_event_ts_ns?.toString() ?? 'missing',
    negative_delta_ns: violation.delta_ns.toString(),
    negative_delta_ms: nsToMs(violation.delta_ns),
    previous_sequence: violation.previous.sequence_raw,
    current_sequence: violation.current.sequence_raw,
    timestamp_source: violation.current.timestamp_source,
    template_id: violation.current.template_id,
    payload_kind: violation.current.payload_kind,
  };
}

function percentileSummary(values: readonly bigint[]): PercentileSummary {
  if (values.length === 0) {
    return {
      p50_ns: null,
      p95_ns: null,
      p99_ns: null,
      p50_ms: null,
      p95_ms: null,
      p99_ms: null,
    };
  }
  const sorted = [...values].sort(compareBigInt);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);
  return {
    p50_ns: p50.toString(),
    p95_ns: p95.toString(),
    p99_ns: p99.toString(),
    p50_ms: nsToMs(p50),
    p95_ms: nsToMs(p95),
    p99_ms: nsToMs(p99),
  };
}

function percentile(sortedValues: readonly bigint[], percentileValue: number): bigint {
  if (sortedValues.length === 0) {
    return 0n;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.floor((percentileValue / 100) * (sortedValues.length - 1)),
  );
  return sortedValues[index]!;
}

function groupByStream(records: readonly ParsedProbeRecord[]): ReadonlyMap<string, readonly ParsedProbeRecord[]> {
  const grouped = new Map<string, ParsedProbeRecord[]>();
  for (const record of records) {
    const recordsForStream = grouped.get(record.stream_id) ?? [];
    recordsForStream.push(record);
    grouped.set(record.stream_id, recordsForStream);
  }
  return grouped;
}

function sortedEntries<T>(map: ReadonlyMap<string, T>): readonly [string, T][] {
  return [...map.entries()].sort(([left], [right]) => compareStrings(left, right));
}

function countBy(
  records: readonly ParsedProbeRecord[],
  selector: (record: ParsedProbeRecord) => string,
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    const key = selector(record);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareStrings(left, right)));
}

function optionalBigIntField(record: Record<string, unknown>, keys: readonly string[]): bigint | null {
  const value = firstField(record, keys);
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  throw new Error(`${keys.join('/')} must be a nanosecond timestamp or integer sequence when present`);
}

function optionalSequenceRaw(record: Record<string, unknown>): string | null {
  const value = record.sequence;
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  return null;
}

function optionalStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function firstField(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(record, key)) {
      return record[key];
    }
  }
  return undefined;
}

function stringifyCountKey(value: unknown): string {
  if (value === undefined || value === null) {
    return 'missing';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return 'unsupported';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function maxBigInt(values: readonly bigint[]): bigint | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((max, value) => (value > max ? value : max), values[0]!);
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function compareBigInt(left: bigint, right: bigint): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function nsToMs(value: bigint): number {
  return Number(value) / 1_000_000;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function usage(): string {
  return [
    'Usage: npm run infra:analyze-timestamp-order -- --probe <probe.jsonl> --out <report.json>',
    '',
    `Default --out: ${DEFAULT_REPORT_PATH}`,
  ].join('\n');
}

function parseArgs(argv: readonly string[]): CliArgs {
  let probePath: string | undefined;
  let outPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      throw new Error(usage());
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
    throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }

  if (!probePath) {
    throw new Error(`--probe is required\n${usage()}`);
  }

  return {
    probe_path: probePath,
    out_path: outPath ?? DEFAULT_REPORT_PATH,
  };
}

function main(): void {
  try {
    const args = parseArgs(processArgv.slice(2));
    const report = analyzeRithmicTimestampOrder({
      probe_path: args.probe_path,
      out_path: args.out_path,
    });
    writeTimestampOrderReport(report, args.out_path);
    processStdout.write(formatTimestampOrderSummary(report));
    processExit(0);
  } catch (error) {
    processStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    processExit(3);
  }
}

if (processArgv[1] !== undefined && resolve(processArgv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
