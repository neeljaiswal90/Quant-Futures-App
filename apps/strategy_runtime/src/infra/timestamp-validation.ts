import { ns, type UnixNs, type UnixNsInput } from '../contracts/index.js';

const NS_PER_MILLISECOND = 1_000_000n;
const NS_PER_MINUTE = 60_000_000_000n;

export const INFRA_01_TICKET_ID = 'INFRA-01' as const;
export const INFRA_01B_TICKET_ID = 'INFRA-01B' as const;

export type ClockDisciplineSource = 'chrony' | 'ntp' | 'ptp' | 'manual' | 'unknown';

export type TimestampProbeStatus = 'pass' | 'fail' | 'incomplete';
export type Data01GateStatus = 'unblocked' | 'blocked';
export type TimestampFailureLane =
  | 'timestamp_semantics_mismatch'
  | 'clock_discipline_failure';
export type SecondaryTimestampFailureLane = 'timestamp_semantics_unresolved';

export type TimestampLatencyBasis = 'sidecar_recv_ts_ns_minus_exchange_event_ts_ns';

export interface ClockSyncThresholds {
  readonly max_abs_mean_offset_ms: number;
  readonly max_dispersion_ms: number;
}

export interface LatencyReprobeThresholds {
  readonly required_duration_minutes: number;
  readonly max_abs_median_latency_ms: number;
  readonly max_p99_latency_ms: number;
  readonly min_samples_per_stream: number;
  readonly allow_negative_p50_latency: false;
}

export interface TimestampReprobeThresholds {
  readonly clock_sync: ClockSyncThresholds;
  readonly latency_reprobe: LatencyReprobeThresholds;
}

export interface TimestampReprobeThresholdOverrides {
  readonly clock_sync?: Partial<ClockSyncThresholds>;
  readonly latency_reprobe?: Partial<LatencyReprobeThresholds>;
}

export const DEFAULT_INFRA_01_THRESHOLDS: TimestampReprobeThresholds = {
  clock_sync: {
    max_abs_mean_offset_ms: 5,
    max_dispersion_ms: 20,
  },
  latency_reprobe: {
    required_duration_minutes: 30,
    max_abs_median_latency_ms: 10,
    max_p99_latency_ms: 200,
    min_samples_per_stream: 1,
    allow_negative_p50_latency: false,
  },
} as const;

export interface ClockDisciplineSnapshot {
  readonly source: ClockDisciplineSource;
  readonly captured_at_ts_ns: UnixNsInput;
  readonly mean_offset_ms: number;
  readonly dispersion_ms: number;
  readonly synchronized: boolean;
  readonly notes?: string;
}

export interface TimestampProbeSample {
  readonly stream_id: string;
  readonly exchange_event_ts_ns: UnixNsInput;
  readonly rithmic_publish_ts_ns?: UnixNsInput;
  readonly sidecar_recv_ts_ns: UnixNsInput;
  readonly sequence?: string | number;
}

export interface EvaluateTimestampReprobeInput {
  readonly probe_id: string;
  readonly started_at_ts_ns: UnixNsInput;
  readonly ended_at_ts_ns: UnixNsInput;
  readonly clock: ClockDisciplineSnapshot;
  readonly samples: readonly TimestampProbeSample[];
  readonly thresholds?: TimestampReprobeThresholdOverrides;
}

export interface TimestampProbeIssue {
  readonly code:
    | 'invalid_probe_id'
    | 'invalid_stream_id'
    | 'invalid_probe_window'
    | 'probe_duration_too_short'
    | 'no_probe_samples'
    | 'invalid_timestamp'
    | 'invalid_clock_metric'
    | 'clock_unsynchronized'
    | 'clock_mean_offset_out_of_range'
    | 'clock_dispersion_out_of_range'
    | 'stream_sample_count_too_low'
    | 'median_latency_out_of_range'
    | 'p99_latency_out_of_range'
    | 'negative_p50_latency';
  readonly path: string;
  readonly message: string;
}

export interface ClockSyncResult {
  readonly thresholds: ClockSyncThresholds;
  readonly source: ClockDisciplineSource;
  readonly captured_at_ts_ns: UnixNs;
  readonly mean_offset_ms: number;
  readonly dispersion_ms: number;
  readonly synchronized: boolean;
  readonly mean_offset_within_threshold: boolean;
  readonly dispersion_within_threshold: boolean;
  readonly passes: boolean;
  readonly issues: readonly TimestampProbeIssue[];
}

export interface StreamLatencyResult {
  readonly stream_id: string;
  readonly sample_count: number;
  readonly rithmic_publish_sample_count: number;
  readonly min_latency_ms: number;
  readonly p50_latency_ms: number;
  readonly median_latency_ms: number;
  readonly p99_latency_ms: number;
  readonly max_latency_ms: number;
  readonly negative_p50_latency: boolean;
  readonly median_within_threshold: boolean;
  readonly p99_within_threshold: boolean;
  readonly sample_count_within_threshold: boolean;
  readonly passes: boolean;
}

export interface LatencyReprobeResult {
  readonly latency_basis: TimestampLatencyBasis;
  readonly thresholds: LatencyReprobeThresholds;
  readonly probe: {
    readonly probe_id: string;
    readonly started_at_ts_ns: UnixNs;
    readonly ended_at_ts_ns: UnixNs;
    readonly duration_minutes: number;
    readonly stream_count: number;
    readonly sample_count: number;
  };
  readonly streams: readonly StreamLatencyResult[];
  readonly evidence_complete: boolean;
  readonly passes: boolean;
  readonly issues: readonly TimestampProbeIssue[];
}

export interface TimestampReprobeReport {
  readonly ticket_id: typeof INFRA_01_TICKET_ID;
  readonly status: TimestampProbeStatus;
  readonly data_01_gate: Data01GateStatus;
  readonly infra_01b_required: boolean;
  readonly failure_lane?: TimestampFailureLane;
  readonly secondary_failure_lane?: SecondaryTimestampFailureLane;
  readonly recommended_next_ticket: 'DATA-01' | typeof INFRA_01_TICKET_ID | typeof INFRA_01B_TICKET_ID;
  readonly recommended_action: string;
  readonly clock_sync: ClockSyncResult;
  readonly latency_reprobe: LatencyReprobeResult;
  readonly issues: readonly TimestampProbeIssue[];
}

interface NormalizedSample {
  readonly stream_id: string;
  readonly exchange_event_ts_ns: UnixNs;
  readonly rithmic_publish_ts_ns?: UnixNs;
  readonly sidecar_recv_ts_ns: UnixNs;
  readonly latency_ms: number;
}

function issue(
  code: TimestampProbeIssue['code'],
  path: string,
  message: string,
): TimestampProbeIssue {
  return { code, path, message };
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function assertThreshold(value: number, path: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a finite non-negative number`);
  }
}

function mergeThresholds(
  overrides: TimestampReprobeThresholdOverrides | undefined,
): TimestampReprobeThresholds {
  const clockSync: ClockSyncThresholds = {
    ...DEFAULT_INFRA_01_THRESHOLDS.clock_sync,
    ...(overrides?.clock_sync ?? {}),
  };
  const latencyReprobe: LatencyReprobeThresholds = {
    ...DEFAULT_INFRA_01_THRESHOLDS.latency_reprobe,
    ...(overrides?.latency_reprobe ?? {}),
    allow_negative_p50_latency: false,
  };

  assertThreshold(clockSync.max_abs_mean_offset_ms, 'clock_sync.max_abs_mean_offset_ms');
  assertThreshold(clockSync.max_dispersion_ms, 'clock_sync.max_dispersion_ms');
  assertThreshold(
    latencyReprobe.required_duration_minutes,
    'latency_reprobe.required_duration_minutes',
  );
  assertThreshold(
    latencyReprobe.max_abs_median_latency_ms,
    'latency_reprobe.max_abs_median_latency_ms',
  );
  assertThreshold(latencyReprobe.max_p99_latency_ms, 'latency_reprobe.max_p99_latency_ms');
  assertThreshold(latencyReprobe.min_samples_per_stream, 'latency_reprobe.min_samples_per_stream');

  if (!Number.isInteger(latencyReprobe.min_samples_per_stream)) {
    throw new Error('latency_reprobe.min_samples_per_stream must be an integer');
  }

  return {
    clock_sync: clockSync,
    latency_reprobe: latencyReprobe,
  };
}

function nsDeltaToMilliseconds(later: UnixNs, earlier: UnixNs): number {
  const deltaNs = BigInt(later) - BigInt(earlier);
  const sign = deltaNs < 0n ? -1 : 1;
  const absDeltaNs = deltaNs < 0n ? -deltaNs : deltaNs;
  const wholeMilliseconds = absDeltaNs / NS_PER_MILLISECOND;
  const remainderNs = absDeltaNs % NS_PER_MILLISECOND;

  if (wholeMilliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('nanosecond delta is too large to represent as milliseconds');
  }

  return sign * (Number(wholeMilliseconds) + Number(remainderNs) / 1_000_000);
}

function nsDeltaToMinutes(later: UnixNs, earlier: UnixNs): number {
  const deltaNs = BigInt(later) - BigInt(earlier);
  const sign = deltaNs < 0n ? -1 : 1;
  const absDeltaNs = deltaNs < 0n ? -deltaNs : deltaNs;
  const wholeMinutes = absDeltaNs / NS_PER_MINUTE;
  const remainderNs = absDeltaNs % NS_PER_MINUTE;

  if (wholeMinutes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('nanosecond delta is too large to represent as minutes');
  }

  return sign * (Number(wholeMinutes) + Number(remainderNs) / Number(NS_PER_MINUTE));
}

function percentile(sortedValues: readonly number[], percentileRank: number): number {
  if (sortedValues.length === 0) {
    throw new Error('cannot compute percentile for an empty sample');
  }
  if (sortedValues.length === 1) {
    return sortedValues[0]!;
  }

  const index = Math.ceil((percentileRank / 100) * sortedValues.length) - 1;
  const boundedIndex = Math.min(Math.max(index, 0), sortedValues.length - 1);
  return sortedValues[boundedIndex]!;
}

function median(sortedValues: readonly number[]): number {
  if (sortedValues.length === 0) {
    throw new Error('cannot compute median for an empty sample');
  }

  const middle = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) {
    return sortedValues[middle]!;
  }

  return (sortedValues[middle - 1]! + sortedValues[middle]!) / 2;
}

function normalizeSample(
  sample: TimestampProbeSample,
  path: string,
  issues: TimestampProbeIssue[],
): NormalizedSample | undefined {
  if (sample.stream_id.trim() === '') {
    issues.push(issue('invalid_stream_id', `${path}.stream_id`, 'stream_id must be non-empty'));
    return undefined;
  }

  try {
    const exchange_event_ts_ns = ns(sample.exchange_event_ts_ns);
    const sidecar_recv_ts_ns = ns(sample.sidecar_recv_ts_ns);
    const rithmic_publish_ts_ns =
      sample.rithmic_publish_ts_ns === undefined ? undefined : ns(sample.rithmic_publish_ts_ns);

    return {
      stream_id: sample.stream_id,
      exchange_event_ts_ns,
      rithmic_publish_ts_ns,
      sidecar_recv_ts_ns,
      latency_ms: nsDeltaToMilliseconds(sidecar_recv_ts_ns, exchange_event_ts_ns),
    };
  } catch (error) {
    issues.push(
      issue(
        'invalid_timestamp',
        path,
        error instanceof Error ? error.message : 'sample contains an invalid timestamp',
      ),
    );
    return undefined;
  }
}

function groupSamplesByStream(
  samples: readonly NormalizedSample[],
): Map<string, readonly NormalizedSample[]> {
  const grouped = new Map<string, NormalizedSample[]>();
  const sortedSamples = [...samples].sort((a, b) => {
    if (a.stream_id !== b.stream_id) {
      return a.stream_id < b.stream_id ? -1 : 1;
    }
    const tsCompare = BigInt(a.exchange_event_ts_ns) - BigInt(b.exchange_event_ts_ns);
    if (tsCompare !== 0n) {
      return tsCompare < 0n ? -1 : 1;
    }
    return BigInt(a.sidecar_recv_ts_ns) < BigInt(b.sidecar_recv_ts_ns) ? -1 : 1;
  });

  for (const sample of sortedSamples) {
    const streamSamples = grouped.get(sample.stream_id) ?? [];
    streamSamples.push(sample);
    grouped.set(sample.stream_id, streamSamples);
  }

  return grouped;
}

function evaluateStream(
  streamId: string,
  samples: readonly NormalizedSample[],
  thresholds: LatencyReprobeThresholds,
  issues: TimestampProbeIssue[],
): StreamLatencyResult {
  const latencies = samples.map((sample) => sample.latency_ms).sort((a, b) => a - b);
  const p50 = median(latencies);
  const p99 = percentile(latencies, 99);
  const medianWithinThreshold = Math.abs(p50) <= thresholds.max_abs_median_latency_ms;
  const p99WithinThreshold = p99 <= thresholds.max_p99_latency_ms;
  const sampleCountWithinThreshold = samples.length >= thresholds.min_samples_per_stream;
  const negativeP50Latency = p50 < 0;

  if (!sampleCountWithinThreshold) {
    issues.push(
      issue(
        'stream_sample_count_too_low',
        `latency_reprobe.streams.${streamId}.sample_count`,
        `stream has ${samples.length} samples; required minimum is ${thresholds.min_samples_per_stream}`,
      ),
    );
  }
  if (!medianWithinThreshold) {
    issues.push(
      issue(
        'median_latency_out_of_range',
        `latency_reprobe.streams.${streamId}.p50_latency_ms`,
        `p50 latency ${p50}ms must be within +/-${thresholds.max_abs_median_latency_ms}ms`,
      ),
    );
  }
  if (!p99WithinThreshold) {
    issues.push(
      issue(
        'p99_latency_out_of_range',
        `latency_reprobe.streams.${streamId}.p99_latency_ms`,
        `p99 latency ${p99}ms must be <= ${thresholds.max_p99_latency_ms}ms`,
      ),
    );
  }
  if (negativeP50Latency && !thresholds.allow_negative_p50_latency) {
    issues.push(
      issue(
        'negative_p50_latency',
        `latency_reprobe.streams.${streamId}.p50_latency_ms`,
        `p50 latency ${p50}ms is negative; DATA-01 requires zero negative p50 latencies per stream`,
      ),
    );
  }

  return {
    stream_id: streamId,
    sample_count: samples.length,
    rithmic_publish_sample_count: samples.filter(
      (sample) => sample.rithmic_publish_ts_ns !== undefined,
    ).length,
    min_latency_ms: latencies[0]!,
    p50_latency_ms: p50,
    median_latency_ms: p50,
    p99_latency_ms: p99,
    max_latency_ms: latencies[latencies.length - 1]!,
    negative_p50_latency: negativeP50Latency,
    median_within_threshold: medianWithinThreshold,
    p99_within_threshold: p99WithinThreshold,
    sample_count_within_threshold: sampleCountWithinThreshold,
    passes:
      sampleCountWithinThreshold &&
      medianWithinThreshold &&
      p99WithinThreshold &&
      (!negativeP50Latency || thresholds.allow_negative_p50_latency),
  };
}

function evaluateClockSync(
  clock: ClockDisciplineSnapshot,
  thresholds: ClockSyncThresholds,
): ClockSyncResult {
  const issues: TimestampProbeIssue[] = [];
  let captured_at_ts_ns: UnixNs;
  try {
    captured_at_ts_ns = ns(clock.captured_at_ts_ns);
  } catch (error) {
    issues.push(
      issue(
        'invalid_timestamp',
        'clock_sync.captured_at_ts_ns',
        error instanceof Error ? error.message : 'clock capture timestamp is invalid',
      ),
    );
    captured_at_ts_ns = ns(0);
  }

  const meanOffsetIsFinite = isFiniteNumber(clock.mean_offset_ms);
  const dispersionIsFinite = isFiniteNumber(clock.dispersion_ms);
  const meanOffsetWithinThreshold =
    meanOffsetIsFinite && Math.abs(clock.mean_offset_ms) <= thresholds.max_abs_mean_offset_ms;
  const dispersionWithinThreshold =
    dispersionIsFinite && clock.dispersion_ms <= thresholds.max_dispersion_ms;

  if (!meanOffsetIsFinite) {
    issues.push(
      issue(
        'invalid_clock_metric',
        'clock_sync.mean_offset_ms',
        'clock mean offset must be a finite number',
      ),
    );
  }
  if (!dispersionIsFinite) {
    issues.push(
      issue(
        'invalid_clock_metric',
        'clock_sync.dispersion_ms',
        'clock dispersion must be a finite number',
      ),
    );
  }
  if (!clock.synchronized) {
    issues.push(
      issue(
        'clock_unsynchronized',
        'clock_sync.synchronized',
        'post-sync re-probe requires a synchronized host clock',
      ),
    );
  }
  if (meanOffsetIsFinite && !meanOffsetWithinThreshold) {
    issues.push(
      issue(
        'clock_mean_offset_out_of_range',
        'clock_sync.mean_offset_ms',
        `clock mean offset ${clock.mean_offset_ms}ms must be within +/-${thresholds.max_abs_mean_offset_ms}ms`,
      ),
    );
  }
  if (dispersionIsFinite && !dispersionWithinThreshold) {
    issues.push(
      issue(
        'clock_dispersion_out_of_range',
        'clock_sync.dispersion_ms',
        `clock dispersion ${clock.dispersion_ms}ms must be <= ${thresholds.max_dispersion_ms}ms`,
      ),
    );
  }

  return {
    thresholds,
    source: clock.source,
    captured_at_ts_ns,
    mean_offset_ms: clock.mean_offset_ms,
    dispersion_ms: clock.dispersion_ms,
    synchronized: clock.synchronized,
    mean_offset_within_threshold: meanOffsetWithinThreshold,
    dispersion_within_threshold: dispersionWithinThreshold,
    passes: clock.synchronized && meanOffsetWithinThreshold && dispersionWithinThreshold,
    issues,
  };
}

function evaluateLatencyReprobe(
  input: EvaluateTimestampReprobeInput,
  thresholds: LatencyReprobeThresholds,
): LatencyReprobeResult {
  const issues: TimestampProbeIssue[] = [];

  if (input.probe_id.trim() === '') {
    issues.push(issue('invalid_probe_id', 'latency_reprobe.probe_id', 'probe_id must be non-empty'));
  }

  let started_at_ts_ns: UnixNs;
  let ended_at_ts_ns: UnixNs;
  try {
    started_at_ts_ns = ns(input.started_at_ts_ns);
  } catch (error) {
    issues.push(
      issue(
        'invalid_timestamp',
        'latency_reprobe.started_at_ts_ns',
        error instanceof Error ? error.message : 'started_at_ts_ns is invalid',
      ),
    );
    started_at_ts_ns = ns(0);
  }
  try {
    ended_at_ts_ns = ns(input.ended_at_ts_ns);
  } catch (error) {
    issues.push(
      issue(
        'invalid_timestamp',
        'latency_reprobe.ended_at_ts_ns',
        error instanceof Error ? error.message : 'ended_at_ts_ns is invalid',
      ),
    );
    ended_at_ts_ns = ns(0);
  }

  const durationMinutes = nsDeltaToMinutes(ended_at_ts_ns, started_at_ts_ns);
  if (BigInt(ended_at_ts_ns) <= BigInt(started_at_ts_ns)) {
    issues.push(
      issue(
        'invalid_probe_window',
        'latency_reprobe.ended_at_ts_ns',
        'ended_at_ts_ns must be greater than started_at_ts_ns',
      ),
    );
  }
  if (durationMinutes < thresholds.required_duration_minutes) {
    issues.push(
      issue(
        'probe_duration_too_short',
        'latency_reprobe.probe.duration_minutes',
        `probe duration ${durationMinutes} minutes is shorter than required ${thresholds.required_duration_minutes} minutes`,
      ),
    );
  }
  if (input.samples.length === 0) {
    issues.push(
      issue('no_probe_samples', 'latency_reprobe.samples', 'probe must include at least one sample'),
    );
  }

  const normalizedSamples = input.samples
    .map((sample, index) => normalizeSample(sample, `latency_reprobe.samples[${index}]`, issues))
    .filter((sample): sample is NormalizedSample => sample !== undefined);
  const groupedSamples = groupSamplesByStream(normalizedSamples);
  const streams = [...groupedSamples.entries()].map(([streamId, streamSamples]) =>
    evaluateStream(streamId, streamSamples, thresholds, issues),
  );
  const hasIncompleteEvidenceIssue = issues.some((probeIssue) =>
    [
      'invalid_probe_id',
      'invalid_stream_id',
      'invalid_probe_window',
      'probe_duration_too_short',
      'no_probe_samples',
      'invalid_timestamp',
    ].includes(probeIssue.code),
  );
  const evidenceComplete =
    input.probe_id.trim() !== '' &&
    BigInt(ended_at_ts_ns) > BigInt(started_at_ts_ns) &&
    durationMinutes >= thresholds.required_duration_minutes &&
    input.samples.length > 0 &&
    normalizedSamples.length === input.samples.length &&
    streams.length > 0 &&
    !hasIncompleteEvidenceIssue;
  const streamsPass = streams.every((stream) => stream.passes);

  return {
    latency_basis: 'sidecar_recv_ts_ns_minus_exchange_event_ts_ns',
    thresholds,
    probe: {
      probe_id: input.probe_id,
      started_at_ts_ns,
      ended_at_ts_ns,
      duration_minutes: durationMinutes,
      stream_count: streams.length,
      sample_count: normalizedSamples.length,
    },
    streams,
    evidence_complete: evidenceComplete,
    passes: evidenceComplete && streamsPass,
    issues,
  };
}

function recommendedAction(
  status: TimestampProbeStatus,
  failureLane: TimestampFailureLane | undefined,
  secondaryFailureLane: SecondaryTimestampFailureLane | undefined,
): string {
  if (status === 'pass') {
    return 'DATA-01 may proceed because clock_sync and latency_reprobe both passed.';
  }
  if (status === 'incomplete') {
    return 'Keep DATA-01 blocked and collect a complete 30-minute post-sync latency re-probe before evaluating INFRA-01.';
  }
  if (failureLane === 'clock_discipline_failure' && secondaryFailureLane !== undefined) {
    return 'Route to INFRA-01B: clock discipline failed, and timestamp semantics remain unresolved because latency thresholds also failed. Fix clock discipline first, then rerun the latency re-probe without arbitrary offsets.';
  }
  if (failureLane === 'clock_discipline_failure') {
    return 'Route to INFRA-01B: classify clock discipline failure, inspect host mean offset/dispersion, and consider PTP/network infrastructure if Chrony/NTP cannot meet thresholds.';
  }
  return 'Route to INFRA-01B: classify timestamp semantics mismatch, inspect Rithmic timestamp fields and capture-side timestamping, then rerun the probe without arbitrary offsets.';
}

export function evaluateTimestampReprobe(
  input: EvaluateTimestampReprobeInput,
): TimestampReprobeReport {
  const thresholds = mergeThresholds(input.thresholds);
  const clockSync = evaluateClockSync(input.clock, thresholds.clock_sync);
  const latencyReprobe = evaluateLatencyReprobe(input, thresholds.latency_reprobe);

  let status: TimestampProbeStatus;
  let failureLane: TimestampFailureLane | undefined;
  let secondaryFailureLane: SecondaryTimestampFailureLane | undefined;

  if (!clockSync.passes) {
    status = 'fail';
    failureLane = 'clock_discipline_failure';
    if (latencyReprobe.evidence_complete && !latencyReprobe.passes) {
      secondaryFailureLane = 'timestamp_semantics_unresolved';
    }
  } else if (!latencyReprobe.evidence_complete) {
    status = 'incomplete';
  } else if (!latencyReprobe.passes) {
    status = 'fail';
    failureLane = 'timestamp_semantics_mismatch';
  } else {
    status = 'pass';
  }

  return {
    ticket_id: INFRA_01_TICKET_ID,
    status,
    data_01_gate: status === 'pass' ? 'unblocked' : 'blocked',
    infra_01b_required: status === 'fail',
    ...(failureLane === undefined ? {} : { failure_lane: failureLane }),
    ...(secondaryFailureLane === undefined ? {} : { secondary_failure_lane: secondaryFailureLane }),
    recommended_next_ticket:
      status === 'pass' ? 'DATA-01' : status === 'fail' ? INFRA_01B_TICKET_ID : INFRA_01_TICKET_ID,
    recommended_action: recommendedAction(status, failureLane, secondaryFailureLane),
    clock_sync: clockSync,
    latency_reprobe: latencyReprobe,
    issues: [...clockSync.issues, ...latencyReprobe.issues],
  };
}

export const REQUIRED_INFRA_01B_STREAMS = [
  'L1_QUOTE',
  'LAST_TRADE',
  'MBP10',
  'MBO',
] as const;

export type Infra01bRequiredStream = (typeof REQUIRED_INFRA_01B_STREAMS)[number];
export type Infra01bStatus = 'pass' | 'fail' | 'invalid';
export type Infra01bRoute = typeof INFRA_01_TICKET_ID | typeof INFRA_01B_TICKET_ID;
export type DatabentoParityStatus = 'pass' | 'fail' | 'pending';
export type Infra01bFailurePrimary =
  | 'invalid_input'
  | 'canonical_event_time_failure'
  | 'telemetry_clock_health_issue'
  | 'clock_evidence_incomplete'
  | 'databento_parity_failure';
export type Infra01bFailureSecondary =
  | 'telemetry_clock_health_issue'
  | 'clock_evidence_incomplete'
  | 'databento_parity_pending'
  | 'timestamp_semantics_unresolved';

export interface Infra01bThresholds {
  readonly required_duration_minutes: number;
  readonly min_exchange_timestamp_coverage_ratio: number;
  readonly max_receive_latency_p99_ms: number;
  readonly min_receive_latency_p50_ms: number;
  readonly chrony_max_rms_offset_ms: number;
  readonly chrony_max_root_dispersion_ms: number;
  readonly min_clock_observation_minutes: number;
  readonly required_streams: readonly Infra01bRequiredStream[];
}

export interface Infra01bThresholdOverrides {
  readonly required_duration_minutes?: number;
  readonly min_exchange_timestamp_coverage_ratio?: number;
  readonly max_receive_latency_p99_ms?: number;
  readonly min_receive_latency_p50_ms?: number;
  readonly chrony_max_rms_offset_ms?: number;
  readonly chrony_max_root_dispersion_ms?: number;
  readonly min_clock_observation_minutes?: number;
  readonly required_streams?: readonly Infra01bRequiredStream[];
}

export const DEFAULT_INFRA_01B_THRESHOLDS: Infra01bThresholds = {
  required_duration_minutes: 30,
  min_exchange_timestamp_coverage_ratio: 0.999,
  max_receive_latency_p99_ms: 500,
  min_receive_latency_p50_ms: 0,
  chrony_max_rms_offset_ms: 10,
  chrony_max_root_dispersion_ms: 50,
  min_clock_observation_minutes: 60,
  required_streams: REQUIRED_INFRA_01B_STREAMS,
} as const;

export interface Infra01bIssue {
  readonly code:
    | 'invalid_probe_id'
    | 'invalid_stream_id'
    | 'invalid_probe_window'
    | 'probe_duration_too_short'
    | 'no_probe_records'
    | 'no_valid_exchange_timestamps'
    | 'invalid_timestamp'
    | 'invalid_clock_metric'
    | 'unsupported_clock_source'
    | 'missing_required_stream'
    | 'exchange_timestamp_coverage_below_threshold'
    | 'exchange_timestamp_decreased'
    | 'receive_latency_p50_negative'
    | 'receive_latency_p99_out_of_range'
    | 'clock_unsynchronized'
    | 'clock_rms_offset_out_of_range'
    | 'clock_root_dispersion_out_of_range'
    | 'clock_observation_window_too_short'
    | 'databento_parity_failed'
    | 'databento_parity_pending';
  readonly path: string;
  readonly message: string;
}

export interface CanonicalExchangeTimeProbeRecord {
  readonly stream_id: string;
  readonly exchange_event_ts_ns: UnixNsInput | null;
  readonly sidecar_recv_ts_ns: UnixNsInput;
  readonly rithmic_publish_ts_ns?: UnixNsInput | null;
  readonly sequence?: string | number;
  readonly timestamp_source?: string;
  readonly payload_kind?: string;
  readonly is_startup_or_control?: boolean;
}

export interface Infra01bClockEvidence {
  readonly source: ClockDisciplineSource;
  readonly captured_at_ts_ns?: UnixNsInput;
  readonly synchronized?: boolean;
  readonly rms_offset_ms?: number;
  readonly root_dispersion_ms?: number;
  readonly observation_window_minutes?: number;
  readonly observation_window_seconds?: number;
  readonly mean_offset_ms?: number;
  readonly dispersion_ms?: number;
  readonly notes?: string;
}

export interface DatabentoOverlapParityReport {
  readonly present: boolean;
  readonly status: DatabentoParityStatus;
  readonly report_path?: string;
  readonly summary?: string;
  readonly matched_windows?: number;
  readonly unmatched_event_count?: number;
  readonly max_price_alignment_ticks?: number;
  readonly notes?: string;
}

export interface EvaluateCanonicalExchangeTimeInput {
  readonly probe_id: string;
  readonly started_at_ts_ns: UnixNsInput;
  readonly ended_at_ts_ns: UnixNsInput;
  readonly records: readonly CanonicalExchangeTimeProbeRecord[];
  readonly records_by_stream: Readonly<Record<string, number>>;
  readonly clock_evidence: Infra01bClockEvidence;
  readonly databento_overlap_parity?: DatabentoOverlapParityReport;
  readonly thresholds?: Infra01bThresholdOverrides;
}

export interface InputValidationBlock {
  readonly pass: boolean;
  readonly reasons: readonly Infra01bIssue[];
}

export interface CanonicalEventTimeBlock {
  readonly pass: boolean;
  readonly canonical_field: 'exchange_event_ts_ns';
  readonly sidecar_recv_ts_ns_role: 'telemetry_only';
  readonly ts_ns_rule: 'market_data_ts_ns_equals_exchange_event_ts_ns';
  readonly required_duration_minutes: number;
  readonly observed_duration_minutes: number;
  readonly required_streams: readonly Infra01bRequiredStream[];
  readonly present_streams: readonly string[];
  readonly missing_streams: readonly Infra01bRequiredStream[];
  readonly reasons: readonly Infra01bIssue[];
}

export interface ExchangeTimestampCoverageBlock {
  readonly pass: boolean;
  readonly threshold_ratio: number;
  readonly coverage_ratio: number;
  readonly market_data_records: number;
  readonly valid_exchange_timestamp_records: number;
  readonly missing_exchange_timestamp_records: number;
  readonly ignored_startup_control_records: number;
  readonly reasons: readonly Infra01bIssue[];
}

export interface StreamMonotonicityResult {
  readonly stream_id: string;
  readonly sample_count: number;
  readonly non_decreasing: boolean;
  readonly violation_count: number;
  readonly first_violation?: {
    readonly previous_exchange_event_ts_ns: UnixNs;
    readonly current_exchange_event_ts_ns: UnixNs;
    readonly record_index: number;
  };
}

export interface PerStreamMonotonicityBlock {
  readonly pass: boolean;
  readonly rule: 'non_decreasing_exchange_event_ts_ns_per_stream';
  readonly streams: readonly StreamMonotonicityResult[];
  readonly reasons: readonly Infra01bIssue[];
}

export interface ReceiveLatencyTelemetryStream {
  readonly stream_id: string;
  readonly sample_count: number;
  readonly p50_latency_ms: number;
  readonly p99_latency_ms: number;
  readonly min_latency_ms: number;
  readonly max_latency_ms: number;
  readonly negative_p50: boolean;
  readonly p50_non_negative: boolean;
  readonly p99_within_threshold: boolean;
  readonly pass: boolean;
}

export interface ReceiveLatencyTelemetryBlock {
  readonly pass: boolean;
  readonly basis: 'sidecar_recv_ts_ns_minus_exchange_event_ts_ns';
  readonly role: 'telemetry_only';
  readonly min_p50_latency_ms: number;
  readonly max_p99_latency_ms: number;
  readonly per_stream: readonly ReceiveLatencyTelemetryStream[];
  readonly reasons: readonly Infra01bIssue[];
}

export interface ClockEvidenceBlock {
  readonly pass: boolean;
  readonly source: ClockDisciplineSource;
  readonly source_role: 'host_clock_health_telemetry';
  readonly synchronized?: boolean;
  readonly rms_offset_ms?: number;
  readonly root_dispersion_ms?: number;
  readonly observation_window_minutes?: number;
  readonly mean_offset_ms?: number;
  readonly dispersion_ms?: number;
  readonly max_rms_offset_ms: number;
  readonly max_root_dispersion_ms: number;
  readonly min_observation_window_minutes: number;
  readonly canonical_event_time_blocker: false;
  readonly reasons: readonly Infra01bIssue[];
}

export interface CanonicalExchangeTimeReport {
  readonly ticket_id: typeof INFRA_01B_TICKET_ID;
  readonly status: Infra01bStatus;
  readonly data01_conceptually_unblocked: boolean;
  readonly data01_eligible: false;
  readonly route_to: Infra01bRoute;
  readonly canonical_event_time: CanonicalEventTimeBlock;
  readonly exchange_timestamp_coverage: ExchangeTimestampCoverageBlock;
  readonly per_stream_monotonicity: PerStreamMonotonicityBlock;
  readonly receive_latency_telemetry: ReceiveLatencyTelemetryBlock;
  readonly clock_evidence: ClockEvidenceBlock;
  readonly databento_overlap_parity: DatabentoOverlapParityReport;
  readonly input_validation: InputValidationBlock;
  readonly ignored_records: number;
  readonly records_by_stream: Readonly<Record<string, number>>;
  readonly failure_classification: {
    readonly primary?: Infra01bFailurePrimary;
    readonly secondary?: Infra01bFailureSecondary;
  };
  readonly recommended_next_ticket: typeof INFRA_01_TICKET_ID | typeof INFRA_01B_TICKET_ID;
  readonly issues: readonly Infra01bIssue[];
}

interface NormalizedCanonicalRecord {
  readonly record_index: number;
  readonly stream_id: string;
  readonly exchange_event_ts_ns: UnixNs | null;
  readonly sidecar_recv_ts_ns: UnixNs;
  readonly latency_ms?: number;
  readonly is_startup_or_control: boolean;
}

function infra01bIssue(
  code: Infra01bIssue['code'],
  path: string,
  message: string,
): Infra01bIssue {
  return { code, path, message };
}

function mergeInfra01bThresholds(
  overrides: Infra01bThresholdOverrides | undefined,
): Infra01bThresholds {
  const thresholds: Infra01bThresholds = {
    ...DEFAULT_INFRA_01B_THRESHOLDS,
    ...(overrides ?? {}),
    required_streams: overrides?.required_streams ?? DEFAULT_INFRA_01B_THRESHOLDS.required_streams,
  };

  assertThreshold(thresholds.required_duration_minutes, 'required_duration_minutes');
  assertThreshold(
    thresholds.min_exchange_timestamp_coverage_ratio,
    'min_exchange_timestamp_coverage_ratio',
  );
  assertThreshold(thresholds.max_receive_latency_p99_ms, 'max_receive_latency_p99_ms');
  assertThreshold(thresholds.min_receive_latency_p50_ms, 'min_receive_latency_p50_ms');
  assertThreshold(thresholds.chrony_max_rms_offset_ms, 'chrony_max_rms_offset_ms');
  assertThreshold(thresholds.chrony_max_root_dispersion_ms, 'chrony_max_root_dispersion_ms');
  assertThreshold(thresholds.min_clock_observation_minutes, 'min_clock_observation_minutes');

  if (thresholds.min_exchange_timestamp_coverage_ratio > 1) {
    throw new Error('min_exchange_timestamp_coverage_ratio must be <= 1');
  }

  return thresholds;
}

function isDocumentedStartupOrControlRecord(record: CanonicalExchangeTimeProbeRecord): boolean {
  if (record.is_startup_or_control === true) {
    return true;
  }

  const streamId = record.stream_id.trim().toUpperCase();
  const payloadKind = (record.payload_kind ?? '').trim().toLowerCase();

  if (streamId === 'CONTROL' || streamId === 'STARTUP' || streamId === 'SESSION') {
    return true;
  }

  return (
    payloadKind.includes('startup') ||
    payloadKind.includes('control') ||
    payloadKind.includes('heartbeat') ||
    payloadKind.includes('login') ||
    payloadKind.includes('logout') ||
    payloadKind.includes('response')
  );
}

function normalizeCanonicalRecord(
  record: CanonicalExchangeTimeProbeRecord,
  recordIndex: number,
  issues: Infra01bIssue[],
): NormalizedCanonicalRecord | undefined {
  const path = `records[${recordIndex}]`;
  if (record.stream_id.trim() === '') {
    issues.push(infra01bIssue('invalid_stream_id', `${path}.stream_id`, 'stream_id must be non-empty'));
    return undefined;
  }

  try {
    const sidecarRecvTsNs = ns(record.sidecar_recv_ts_ns);
    const exchangeEventTsNs =
      record.exchange_event_ts_ns === null ? null : ns(record.exchange_event_ts_ns);

    return {
      record_index: recordIndex,
      stream_id: record.stream_id.trim(),
      exchange_event_ts_ns: exchangeEventTsNs,
      sidecar_recv_ts_ns: sidecarRecvTsNs,
      ...(exchangeEventTsNs === null
        ? {}
        : { latency_ms: nsDeltaToMilliseconds(sidecarRecvTsNs, exchangeEventTsNs) }),
      is_startup_or_control: isDocumentedStartupOrControlRecord(record),
    };
  } catch (error) {
    issues.push(
      infra01bIssue(
        'invalid_timestamp',
        path,
        error instanceof Error ? error.message : 'record contains an invalid timestamp',
      ),
    );
    return undefined;
  }
}

function groupCanonicalRecordsByStream(
  records: readonly NormalizedCanonicalRecord[],
): Map<string, NormalizedCanonicalRecord[]> {
  const grouped = new Map<string, NormalizedCanonicalRecord[]>();
  for (const record of records) {
    const streamRecords = grouped.get(record.stream_id) ?? [];
    streamRecords.push(record);
    grouped.set(record.stream_id, streamRecords);
  }
  return grouped;
}

function evaluateExchangeTimestampCoverage(
  records: readonly NormalizedCanonicalRecord[],
  thresholds: Infra01bThresholds,
): ExchangeTimestampCoverageBlock {
  const ignoredStartupControlRecords = records.filter((record) => record.is_startup_or_control).length;
  const marketDataRecords = records.filter((record) => !record.is_startup_or_control);
  const validExchangeTimestampRecords = marketDataRecords.filter(
    (record) => record.exchange_event_ts_ns !== null,
  ).length;
  const missingExchangeTimestampRecords = marketDataRecords.length - validExchangeTimestampRecords;
  const coverageRatio =
    marketDataRecords.length === 0 ? 0 : validExchangeTimestampRecords / marketDataRecords.length;
  const pass =
    marketDataRecords.length > 0 &&
    coverageRatio >= thresholds.min_exchange_timestamp_coverage_ratio;
  const reasons: Infra01bIssue[] = [];

  if (!pass) {
    reasons.push(
      infra01bIssue(
        'exchange_timestamp_coverage_below_threshold',
        'exchange_timestamp_coverage.coverage_ratio',
        `exchange_event_ts_ns coverage ${coverageRatio} must be >= ${thresholds.min_exchange_timestamp_coverage_ratio}`,
      ),
    );
  }

  return {
    pass,
    threshold_ratio: thresholds.min_exchange_timestamp_coverage_ratio,
    coverage_ratio: coverageRatio,
    market_data_records: marketDataRecords.length,
    valid_exchange_timestamp_records: validExchangeTimestampRecords,
    missing_exchange_timestamp_records: missingExchangeTimestampRecords,
    ignored_startup_control_records: ignoredStartupControlRecords,
    reasons,
  };
}

function evaluatePerStreamMonotonicity(
  records: readonly NormalizedCanonicalRecord[],
): PerStreamMonotonicityBlock {
  const grouped = groupCanonicalRecordsByStream(
    records.filter(
      (record) => !record.is_startup_or_control && record.exchange_event_ts_ns !== null,
    ),
  );
  const streamResults: StreamMonotonicityResult[] = [];
  const reasons: Infra01bIssue[] = [];

  for (const [streamId, streamRecords] of [...grouped.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    let previous: NormalizedCanonicalRecord | undefined;
    let violationCount = 0;
    let firstViolation: StreamMonotonicityResult['first_violation'];

    for (const record of streamRecords) {
      if (
        previous !== undefined &&
        record.exchange_event_ts_ns !== null &&
        previous.exchange_event_ts_ns !== null &&
        BigInt(record.exchange_event_ts_ns) < BigInt(previous.exchange_event_ts_ns)
      ) {
        violationCount += 1;
        if (firstViolation === undefined) {
          firstViolation = {
            previous_exchange_event_ts_ns: previous.exchange_event_ts_ns,
            current_exchange_event_ts_ns: record.exchange_event_ts_ns,
            record_index: record.record_index,
          };
        }
      }
      previous = record;
    }

    if (violationCount > 0 && firstViolation !== undefined) {
      reasons.push(
        infra01bIssue(
          'exchange_timestamp_decreased',
          `per_stream_monotonicity.streams.${streamId}`,
          `exchange_event_ts_ns decreased within stream ${streamId} at record index ${firstViolation.record_index}`,
        ),
      );
    }

    streamResults.push({
      stream_id: streamId,
      sample_count: streamRecords.length,
      non_decreasing: violationCount === 0,
      violation_count: violationCount,
      ...(firstViolation === undefined ? {} : { first_violation: firstViolation }),
    });
  }

  return {
    pass: reasons.length === 0,
    rule: 'non_decreasing_exchange_event_ts_ns_per_stream',
    streams: streamResults,
    reasons,
  };
}

function evaluateReceiveLatencyTelemetry(
  records: readonly NormalizedCanonicalRecord[],
  thresholds: Infra01bThresholds,
): ReceiveLatencyTelemetryBlock {
  const grouped = groupCanonicalRecordsByStream(
    records.filter(
      (record) =>
        !record.is_startup_or_control &&
        record.exchange_event_ts_ns !== null &&
        record.latency_ms !== undefined,
    ),
  );
  const streamResults: ReceiveLatencyTelemetryStream[] = [];
  const reasons: Infra01bIssue[] = [];

  for (const [streamId, streamRecords] of [...grouped.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const latencies = streamRecords
      .map((record) => record.latency_ms)
      .filter((latency): latency is number => latency !== undefined)
      .sort((a, b) => a - b);
    const p50 = median(latencies);
    const p99 = percentile(latencies, 99);
    const p50NonNegative = p50 >= thresholds.min_receive_latency_p50_ms;
    const p99WithinThreshold = p99 < thresholds.max_receive_latency_p99_ms;
    const pass = p50NonNegative && p99WithinThreshold;

    if (!p50NonNegative) {
      reasons.push(
        infra01bIssue(
          'receive_latency_p50_negative',
          `receive_latency_telemetry.per_stream.${streamId}.p50_latency_ms`,
          `receive latency p50 ${p50}ms must be >= ${thresholds.min_receive_latency_p50_ms}ms`,
        ),
      );
    }
    if (!p99WithinThreshold) {
      reasons.push(
        infra01bIssue(
          'receive_latency_p99_out_of_range',
          `receive_latency_telemetry.per_stream.${streamId}.p99_latency_ms`,
          `receive latency p99 ${p99}ms must be < ${thresholds.max_receive_latency_p99_ms}ms`,
        ),
      );
    }

    streamResults.push({
      stream_id: streamId,
      sample_count: latencies.length,
      p50_latency_ms: p50,
      p99_latency_ms: p99,
      min_latency_ms: latencies[0]!,
      max_latency_ms: latencies[latencies.length - 1]!,
      negative_p50: p50 < 0,
      p50_non_negative: p50NonNegative,
      p99_within_threshold: p99WithinThreshold,
      pass,
    });
  }

  return {
    pass: reasons.length === 0 && streamResults.length > 0,
    basis: 'sidecar_recv_ts_ns_minus_exchange_event_ts_ns',
    role: 'telemetry_only',
    min_p50_latency_ms: thresholds.min_receive_latency_p50_ms,
    max_p99_latency_ms: thresholds.max_receive_latency_p99_ms,
    per_stream: streamResults,
    reasons,
  };
}

function observationWindowMinutes(clock: Infra01bClockEvidence): number | undefined {
  if (clock.observation_window_minutes !== undefined) {
    return clock.observation_window_minutes;
  }
  if (clock.observation_window_seconds !== undefined) {
    return clock.observation_window_seconds / 60;
  }
  return undefined;
}

function finiteOptionalMetric(value: number | undefined): boolean {
  return value === undefined || Number.isFinite(value);
}

function evaluateClockEvidence(
  clock: Infra01bClockEvidence,
  thresholds: Infra01bThresholds,
): ClockEvidenceBlock {
  const reasons: Infra01bIssue[] = [];
  const rmsOffsetMs = clock.rms_offset_ms ?? (clock.mean_offset_ms === undefined ? undefined : Math.abs(clock.mean_offset_ms));
  const rootDispersionMs = clock.root_dispersion_ms ?? clock.dispersion_ms;
  const observedMinutes = observationWindowMinutes(clock);

  if (
    !finiteOptionalMetric(clock.rms_offset_ms) ||
    !finiteOptionalMetric(clock.root_dispersion_ms) ||
    !finiteOptionalMetric(clock.observation_window_minutes) ||
    !finiteOptionalMetric(clock.observation_window_seconds) ||
    !finiteOptionalMetric(clock.mean_offset_ms) ||
    !finiteOptionalMetric(clock.dispersion_ms)
  ) {
    reasons.push(
      infra01bIssue(
        'invalid_clock_metric',
        'clock_evidence',
        'clock evidence metrics must be finite numbers when provided',
      ),
    );
  }

  if (clock.synchronized === false) {
    reasons.push(
      infra01bIssue(
        'clock_unsynchronized',
        'clock_evidence.synchronized',
        'host clock evidence reports synchronized=false',
      ),
    );
  }

  if (rmsOffsetMs === undefined || rmsOffsetMs >= thresholds.chrony_max_rms_offset_ms) {
    reasons.push(
      infra01bIssue(
        'clock_rms_offset_out_of_range',
        'clock_evidence.rms_offset_ms',
        `clock RMS/absolute offset ${rmsOffsetMs ?? 'missing'}ms must be < ${thresholds.chrony_max_rms_offset_ms}ms`,
      ),
    );
  }

  if (
    rootDispersionMs === undefined ||
    rootDispersionMs >= thresholds.chrony_max_root_dispersion_ms
  ) {
    reasons.push(
      infra01bIssue(
        'clock_root_dispersion_out_of_range',
        'clock_evidence.root_dispersion_ms',
        `clock root dispersion ${rootDispersionMs ?? 'missing'}ms must be < ${thresholds.chrony_max_root_dispersion_ms}ms`,
      ),
    );
  }

  if (
    observedMinutes === undefined ||
    observedMinutes < thresholds.min_clock_observation_minutes
  ) {
    reasons.push(
      infra01bIssue(
        'clock_observation_window_too_short',
        'clock_evidence.observation_window_minutes',
        `clock evidence observation window ${observedMinutes ?? 'missing'} minutes must be >= ${thresholds.min_clock_observation_minutes} minutes`,
      ),
    );
  }

  return {
    pass: reasons.length === 0,
    source: clock.source,
    source_role: 'host_clock_health_telemetry',
    ...(clock.synchronized === undefined ? {} : { synchronized: clock.synchronized }),
    ...(rmsOffsetMs === undefined ? {} : { rms_offset_ms: rmsOffsetMs }),
    ...(rootDispersionMs === undefined ? {} : { root_dispersion_ms: rootDispersionMs }),
    ...(observedMinutes === undefined ? {} : { observation_window_minutes: observedMinutes }),
    ...(clock.mean_offset_ms === undefined ? {} : { mean_offset_ms: clock.mean_offset_ms }),
    ...(clock.dispersion_ms === undefined ? {} : { dispersion_ms: clock.dispersion_ms }),
    max_rms_offset_ms: thresholds.chrony_max_rms_offset_ms,
    max_root_dispersion_ms: thresholds.chrony_max_root_dispersion_ms,
    min_observation_window_minutes: thresholds.min_clock_observation_minutes,
    canonical_event_time_blocker: false,
    reasons,
  };
}

function databentoParityBlock(
  parity: DatabentoOverlapParityReport | undefined,
): DatabentoOverlapParityReport {
  return (
    parity ?? {
      present: false,
      status: 'pending',
      summary: 'Databento overlap parity is pending; INFRA-01 verification requires it before DATA-01 proceeds.',
    }
  );
}

function classifyInfra01bFailure(input: {
  readonly inputValidation: InputValidationBlock;
  readonly canonicalEventTime: CanonicalEventTimeBlock;
  readonly receiveLatencyTelemetry: ReceiveLatencyTelemetryBlock;
  readonly clockEvidence: ClockEvidenceBlock;
  readonly databentoOverlapParity: DatabentoOverlapParityReport;
}): CanonicalExchangeTimeReport['failure_classification'] {
  if (!input.inputValidation.pass) {
    return { primary: 'invalid_input' };
  }
  if (!input.canonicalEventTime.pass) {
    return {
      primary: 'canonical_event_time_failure',
      ...(!input.receiveLatencyTelemetry.pass
        ? { secondary: 'telemetry_clock_health_issue' as const }
        : {}),
    };
  }
  if (input.databentoOverlapParity.status === 'fail') {
    return { primary: 'databento_parity_failure' };
  }
  if (!input.receiveLatencyTelemetry.pass) {
    return { primary: 'telemetry_clock_health_issue' };
  }
  if (!input.clockEvidence.pass) {
    return {
      primary: 'clock_evidence_incomplete',
    };
  }
  return {};
}

export function evaluateCanonicalExchangeTimeGate(
  input: EvaluateCanonicalExchangeTimeInput,
): CanonicalExchangeTimeReport {
  const thresholds = mergeInfra01bThresholds(input.thresholds);
  const validationReasons: Infra01bIssue[] = [];
  const normalizedRecords = input.records
    .map((record, index) => normalizeCanonicalRecord(record, index, validationReasons))
    .filter((record): record is NormalizedCanonicalRecord => record !== undefined);

  let startedAtTsNs: UnixNs;
  let endedAtTsNs: UnixNs;
  try {
    startedAtTsNs = ns(input.started_at_ts_ns);
  } catch (error) {
    validationReasons.push(
      infra01bIssue(
        'invalid_timestamp',
        'started_at_ts_ns',
        error instanceof Error ? error.message : 'started_at_ts_ns is invalid',
      ),
    );
    startedAtTsNs = ns(0);
  }
  try {
    endedAtTsNs = ns(input.ended_at_ts_ns);
  } catch (error) {
    validationReasons.push(
      infra01bIssue(
        'invalid_timestamp',
        'ended_at_ts_ns',
        error instanceof Error ? error.message : 'ended_at_ts_ns is invalid',
      ),
    );
    endedAtTsNs = ns(0);
  }

  if (input.probe_id.trim() === '') {
    validationReasons.push(infra01bIssue('invalid_probe_id', 'probe_id', 'probe_id must be non-empty'));
  }
  if (input.records.length === 0) {
    validationReasons.push(
      infra01bIssue('no_probe_records', 'records', 'probe must include at least one record'),
    );
  }
  if (BigInt(endedAtTsNs) <= BigInt(startedAtTsNs)) {
    validationReasons.push(
      infra01bIssue(
        'invalid_probe_window',
        'ended_at_ts_ns',
        'ended_at_ts_ns must be greater than started_at_ts_ns',
      ),
    );
  }

  const observedDurationMinutes = nsDeltaToMinutes(endedAtTsNs, startedAtTsNs);
  if (observedDurationMinutes < thresholds.required_duration_minutes) {
    validationReasons.push(
      infra01bIssue(
        'probe_duration_too_short',
        'canonical_event_time.observed_duration_minutes',
        `probe duration ${observedDurationMinutes} minutes is shorter than required ${thresholds.required_duration_minutes} minutes`,
      ),
    );
  }

  const validExchangeTimestampRecords = normalizedRecords.filter(
    (record) => !record.is_startup_or_control && record.exchange_event_ts_ns !== null,
  );
  if (validExchangeTimestampRecords.length === 0) {
    validationReasons.push(
      infra01bIssue(
        'no_valid_exchange_timestamps',
        'records',
        'probe contains no usable market-data records with exchange_event_ts_ns',
      ),
    );
  }

  const inputValidation: InputValidationBlock = {
    pass: validationReasons.length === 0,
    reasons: validationReasons,
  };

  const coverage = evaluateExchangeTimestampCoverage(normalizedRecords, thresholds);
  const monotonicity = evaluatePerStreamMonotonicity(normalizedRecords);
  const telemetry = evaluateReceiveLatencyTelemetry(normalizedRecords, thresholds);
  const clockEvidence = evaluateClockEvidence(input.clock_evidence, thresholds);
  const databentoOverlapParity = databentoParityBlock(input.databento_overlap_parity);
  const presentStreamSet = new Set(validExchangeTimestampRecords.map((record) => record.stream_id));
  const presentStreams = [
    ...thresholds.required_streams.filter((streamId) => presentStreamSet.has(streamId)),
    ...[...presentStreamSet]
      .filter((streamId) => !thresholds.required_streams.includes(streamId as Infra01bRequiredStream))
      .sort(),
  ];
  const missingStreams = thresholds.required_streams.filter(
    (requiredStream) => !presentStreams.includes(requiredStream),
  );
  const streamReasons = missingStreams.map((streamId) =>
    infra01bIssue(
      'missing_required_stream',
      `canonical_event_time.required_streams.${streamId}`,
      `required stream ${streamId} is missing usable exchange_event_ts_ns records`,
    ),
  );
  const durationReasons = validationReasons.filter(
    (reason) =>
      reason.code === 'probe_duration_too_short' ||
      reason.code === 'invalid_probe_window' ||
      reason.code === 'no_probe_records' ||
      reason.code === 'no_valid_exchange_timestamps',
  );
  const canonicalReasons = [
    ...durationReasons,
    ...streamReasons,
    ...coverage.reasons,
    ...monotonicity.reasons,
  ];
  const canonicalEventTime: CanonicalEventTimeBlock = {
    pass:
      inputValidation.pass &&
      coverage.pass &&
      monotonicity.pass &&
      missingStreams.length === 0,
    canonical_field: 'exchange_event_ts_ns',
    sidecar_recv_ts_ns_role: 'telemetry_only',
    ts_ns_rule: 'market_data_ts_ns_equals_exchange_event_ts_ns',
    required_duration_minutes: thresholds.required_duration_minutes,
    observed_duration_minutes: observedDurationMinutes,
    required_streams: thresholds.required_streams,
    present_streams: presentStreams,
    missing_streams: missingStreams,
    reasons: canonicalReasons,
  };
  const parityFailIssue =
    databentoOverlapParity.status === 'fail'
      ? [
          infra01bIssue(
            'databento_parity_failed',
            'databento_overlap_parity.status',
            'Databento overlap parity report failed; exchange-time parity must be investigated',
          ),
        ]
      : [];
  const failureClassification = classifyInfra01bFailure({
    inputValidation,
    canonicalEventTime,
    receiveLatencyTelemetry: telemetry,
    clockEvidence,
    databentoOverlapParity,
  });
  const gateFailed =
    !canonicalEventTime.pass ||
    !telemetry.pass ||
    !clockEvidence.pass ||
    databentoOverlapParity.status === 'fail';
  const status: Infra01bStatus = !inputValidation.pass ? 'invalid' : gateFailed ? 'fail' : 'pass';
  const data01ConceptuallyUnblocked =
    canonicalEventTime.pass && databentoOverlapParity.status !== 'fail';

  return {
    ticket_id: INFRA_01B_TICKET_ID,
    status,
    data01_conceptually_unblocked: data01ConceptuallyUnblocked,
    data01_eligible: false,
    route_to: status === 'pass' ? INFRA_01_TICKET_ID : INFRA_01B_TICKET_ID,
    canonical_event_time: canonicalEventTime,
    exchange_timestamp_coverage: coverage,
    per_stream_monotonicity: monotonicity,
    receive_latency_telemetry: telemetry,
    clock_evidence: clockEvidence,
    databento_overlap_parity: databentoOverlapParity,
    input_validation: inputValidation,
    ignored_records: coverage.ignored_startup_control_records,
    records_by_stream: input.records_by_stream,
    failure_classification: failureClassification,
    recommended_next_ticket: status === 'pass' ? INFRA_01_TICKET_ID : INFRA_01B_TICKET_ID,
    issues: [
      ...validationReasons,
      ...canonicalReasons.filter((reason) => !validationReasons.includes(reason)),
      ...telemetry.reasons,
      ...clockEvidence.reasons,
      ...parityFailIssue,
    ],
  };
}
