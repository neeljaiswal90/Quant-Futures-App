import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  argv as processArgv,
  exit as processExit,
  stderr as processStderr,
  stdout as processStdout,
} from 'node:process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import {
  LIMIT_QUEUE_FRONT_BUCKET,
  LIMIT_QUEUE_FRONT_TARGET_METRIC,
  type JsonObject,
  type LimitQueueFrontObservation,
  isJsonObject,
  validateLimitQueueFrontObservation,
} from './limit-queue-front-observation-schema.js';

export const SIM_03K_ANALYSIS_REPORT_SCHEMA_VERSION = 1 as const;
export const SIM_03K_TICKET_ID = 'SIM-03K' as const;
const DEFAULT_OUT_PATH = 'reports/sim/limit_queue_front_distribution_analysis.json';
const STREAM_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_THRESHOLD = 0.25;

const TIME_BUCKETS = [
  { id: '0_10_ms', label: '0-10 ms', min: 0, max: 10 },
  { id: '10_25_ms', label: '10-25 ms', min: 10, max: 25 },
  { id: '25_50_ms', label: '25-50 ms', min: 25, max: 50 },
  { id: '50_100_ms', label: '50-100 ms', min: 50, max: 100 },
  { id: '100_250_ms', label: '100-250 ms', min: 100, max: 250 },
  { id: '250_500_ms', label: '250-500 ms', min: 250, max: 500 },
  { id: '500_1000_ms', label: '500-1000 ms', min: 500, max: 1000 },
  { id: '1000_2000_ms', label: '1-2 sec', min: 1000, max: 2000 },
  { id: '2000_5000_ms', label: '2-5 sec', min: 2000, max: 5000 },
  { id: '5000_10000_ms', label: '5-10 sec', min: 5000, max: 10000 },
  { id: '10000_30000_ms', label: '10-30 sec', min: 10000, max: 30000 },
  { id: 'gt_30000_ms', label: '>30 sec', min: 30000, max: Number.POSITIVE_INFINITY },
] as const;

type SplitName = 'calibration' | 'validation';
type ShapeLabel =
  | 'unimodal'
  | 'bimodal_or_multimodal'
  | 'heavy_tailed'
  | 'sparse_or_unstable'
  | 'shifted_but_same_shape'
  | 'inconclusive';

export type Sim03kFailureClassification =
  | 'validation_distribution_shift'
  | 'side_specific_underfit'
  | 'time_of_day_regime_underfit'
  | 'spread_regime_underfit'
  | 'heavy_tail_metric_sensitivity'
  | 'queue_front_definition_mismatch'
  | 'insufficient_feature_fields'
  | 'model_class_underfit'
  | 'inconclusive';

export interface AnalyzeLimitQueueFrontDistributionOptions {
  readonly cwd?: string;
  readonly observations: string;
  readonly calibration_report: string;
  readonly diagnosis_report: string;
  readonly refit_report?: string;
  readonly out?: string;
}

export interface Sim03kAnalysisReport {
  readonly sim03k_analysis_report_schema_version: typeof SIM_03K_ANALYSIS_REPORT_SCHEMA_VERSION;
  readonly ticket_id: typeof SIM_03K_TICKET_ID;
  readonly status: 'analysis_only';
  readonly sim03_status: 'failed';
  readonly rel01_status: 'blocked';
  readonly target_bucket: typeof LIMIT_QUEUE_FRONT_BUCKET;
  readonly target_metric: typeof LIMIT_QUEUE_FRONT_TARGET_METRIC;
  readonly original_metric: number | null;
  readonly refit_metric: number | null;
  readonly threshold: number;
  readonly source_inputs: {
    readonly calibration_report_path: string;
    readonly calibration_report_hash: string;
    readonly diagnosis_report_path: string;
    readonly diagnosis_report_hash: string;
    readonly refit_report_path: string | null;
    readonly refit_report_hash: string | null;
    readonly observations_path: string;
    readonly observations_hash: string;
  };
  readonly distribution_comparison: DistributionComparison;
  readonly histograms: Record<SplitName, HistogramReport>;
  readonly regime_slices: RegimeSlicesReport;
  readonly queue_front_definition_audit: QueueFrontDefinitionAudit;
  readonly model_form_candidates: Record<string, ModelCandidateReport>;
  readonly classification: Sim03kFailureClassification;
  readonly recommendation: string;
  readonly next_ticket: 'SIM-03L';
  readonly scope_note: string;
}

interface DistributionComparison {
  readonly filled_observations: Record<SplitName, DistributionStats>;
  readonly outcome_counts: Record<SplitName, OutcomeCounts>;
  readonly no_fill_cancel_counts: Record<SplitName, OutcomeCounts>;
  readonly ratios: {
    readonly validation_calibration_median_ratio: number | null;
    readonly validation_calibration_p90_ratio: number | null;
    readonly validation_calibration_tail_ratio_delta: number | null;
  };
  readonly shape_diagnostics: Record<SplitName, ShapeDiagnostics>;
  readonly comparison_diagnosis: ShapeLabel;
}

interface DistributionStats {
  readonly count: number;
  readonly p10: number | null;
  readonly p25: number | null;
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly mean: number | null;
  readonly stddev: number | null;
  readonly iqr: number | null;
  readonly tail_ratio_p95_p50: number | null;
}

interface ShapeDiagnostics {
  readonly shape: ShapeLabel;
  readonly local_peak_count: number;
  readonly heavy_tail: boolean;
  readonly sparse_or_unstable: boolean;
  readonly notes: readonly string[];
}

interface HistogramReport {
  readonly buckets: readonly HistogramBucketReport[];
}

interface HistogramBucketReport {
  readonly id: string;
  readonly label: string;
  readonly count: number;
  readonly share: number;
}

interface OutcomeCounts {
  readonly total: number;
  readonly filled: number;
  readonly no_fill: number;
  readonly cancelled: number;
}

interface RegimeSlicesReport {
  readonly by_order_side: readonly SliceReport[];
  readonly by_session_id: readonly SliceReport[];
  readonly by_instrument: readonly SliceReport[];
  readonly by_time_of_day: readonly SliceReport[];
  readonly by_order_size_bucket: readonly SliceReport[];
  readonly by_observed_time_to_fill_bucket: readonly SliceReport[];
  readonly by_modeled_time_to_fill_bucket: readonly SliceReport[];
  readonly unavailable_dimensions: readonly string[];
}

interface SliceReport {
  readonly id: string;
  readonly count: number;
  readonly calibration_count: number;
  readonly validation_count: number;
  readonly calibration_filled_count: number;
  readonly validation_filled_count: number;
  readonly observed_median_ms: number | null;
  readonly modeled_median_ms: number | null;
  readonly relative_error: number | null;
  readonly p90_error: number | null;
  readonly contribution_to_total_failure: number | null;
  readonly passes_threshold: boolean | null;
}

interface QueueFrontDefinitionAudit {
  readonly queue_ahead_size_distribution: {
    readonly negative: number;
    readonly zero: number;
    readonly positive: number;
    readonly missing: number;
  };
  readonly queue_ahead_size_filled_stats: {
    readonly negative: DistributionStats;
    readonly zero: DistributionStats;
  };
  readonly negative_values_behave_differently_than_zero: boolean | null;
  readonly unexpected_nonzero_queue_ahead_records: number;
  readonly queue_front_definition_mismatch_detected: boolean;
}

interface ModelCandidateReport {
  readonly strategy: string;
  readonly projected_validation_metric: number | null;
  readonly changed_parameter_count: number;
  readonly overfit_risk: 'low' | 'medium' | 'high';
  readonly evidence_strength: 'strong' | 'moderate' | 'weak' | 'insufficient';
  readonly likely_passes_threshold: boolean | null;
  readonly notes: readonly string[];
}

interface ObservationAccumulator {
  readonly splitStats: Record<SplitName, SplitAccumulator>;
  readonly sliceGroups: {
    readonly by_order_side: Map<string, SliceAccumulator>;
    readonly by_session_id: Map<string, SliceAccumulator>;
    readonly by_instrument: Map<string, SliceAccumulator>;
    readonly by_time_of_day: Map<string, SliceAccumulator>;
    readonly by_order_size_bucket: Map<string, SliceAccumulator>;
    readonly by_observed_time_to_fill_bucket: Map<string, SliceAccumulator>;
    readonly by_modeled_time_to_fill_bucket: Map<string, SliceAccumulator>;
  };
  readonly queueAhead: QueueAheadAccumulator;
}

interface SplitAccumulator {
  readonly filledTimes: number[];
  readonly histogramCounts: number[];
  readonly outcomeCounts: MutableOutcomeCounts;
}

interface MutableOutcomeCounts {
  total: number;
  filled: number;
  no_fill: number;
  cancelled: number;
}

interface SliceAccumulator {
  count: number;
  calibrationCount: number;
  validationCount: number;
  calibrationFilledTimes: number[];
  validationFilledTimes: number[];
  calibrationModeledTimes: number[];
  validationModeledTimes: number[];
}

interface QueueAheadAccumulator {
  negative: number;
  zero: number;
  positive: number;
  missing: number;
  negativeFilledTimes: number[];
  zeroFilledTimes: number[];
}

export function analyzeLimitQueueFrontDistribution(
  options: AnalyzeLimitQueueFrontDistributionOptions,
): Sim03kAnalysisReport {
  const cwd = resolve(options.cwd ?? process.cwd());
  const observationsPath = resolve(cwd, options.observations);
  const calibrationPath = resolve(cwd, options.calibration_report);
  const diagnosisPath = resolve(cwd, options.diagnosis_report);
  const refitPath = options.refit_report === undefined ? null : resolve(cwd, options.refit_report);

  const calibrationText = readFileSync(calibrationPath, 'utf8');
  const diagnosisText = readFileSync(diagnosisPath, 'utf8');
  const refitText = refitPath === null ? null : readFileSync(refitPath, 'utf8');
  const calibrationHash = sha256Text(calibrationText);
  const diagnosisHash = sha256Text(diagnosisText);
  const refitHash = refitText === null ? null : sha256Text(refitText);
  const calibrationReport = parseJsonObject(calibrationText, calibrationPath);
  const refitReport = refitText === null ? null : parseJsonObject(refitText, refitPath ?? 'refit report');
  const targetResidual = requireFrontResidual(calibrationReport);
  const originalMetric = numberOrNull(targetResidual.time_to_fill_relative_error);
  const threshold = numberOrNull(targetResidual.time_to_fill_relative_threshold) ?? DEFAULT_THRESHOLD;
  const refitMetric = refitReport === null ? null : numberOrNull(refitReport.new_metric_value);

  const accumulator = createAccumulator();
  const observationsHash = streamObservations(observationsPath, calibrationHash, accumulator);
  const distributionComparison = distributionComparisonFrom(accumulator);
  const histograms = histogramsFrom(accumulator);
  const regimeSlices = regimeSlicesFrom(accumulator, threshold);
  const queueAudit = queueFrontDefinitionAuditFrom(accumulator);
  const modelCandidates = modelCandidatesFrom({
    accumulator,
    regimeSlices,
    threshold,
    refitMetric,
  });
  const classification = classifyRemainingFailure({
    threshold,
    refitMetric,
    distributionComparison,
    queueAudit,
    modelCandidates,
  });

  return {
    sim03k_analysis_report_schema_version: SIM_03K_ANALYSIS_REPORT_SCHEMA_VERSION,
    ticket_id: SIM_03K_TICKET_ID,
    status: 'analysis_only',
    sim03_status: 'failed',
    rel01_status: 'blocked',
    target_bucket: LIMIT_QUEUE_FRONT_BUCKET,
    target_metric: LIMIT_QUEUE_FRONT_TARGET_METRIC,
    original_metric: originalMetric,
    refit_metric: refitMetric,
    threshold,
    source_inputs: {
      calibration_report_path: calibrationPath,
      calibration_report_hash: calibrationHash,
      diagnosis_report_path: diagnosisPath,
      diagnosis_report_hash: diagnosisHash,
      refit_report_path: refitPath,
      refit_report_hash: refitHash,
      observations_path: observationsPath,
      observations_hash: observationsHash,
    },
    distribution_comparison: distributionComparison,
    histograms,
    regime_slices: regimeSlices,
    queue_front_definition_audit: queueAudit,
    model_form_candidates: modelCandidates,
    classification,
    recommendation: recommendationFor(classification),
    next_ticket: 'SIM-03L',
    scope_note:
      'SIM-03K is analysis-only: it does not change thresholds, mutate SIM-03 calibration reports, or unblock REL-01.',
  };
}

export function writeAnalysisReport(report: Sim03kAnalysisReport, outPath: string, cwd = process.cwd()): void {
  const resolved = resolve(cwd, outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export function parseAnalyzeLimitQueueFrontDistributionArgs(
  args: readonly string[],
): AnalyzeLimitQueueFrontDistributionOptions {
  const options: {
    observations?: string;
    calibration_report?: string;
    diagnosis_report?: string;
    refit_report?: string;
    out?: string;
  } = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    switch (flag) {
      case '--observations':
        index += 1;
        options.observations = requireArgValue(flag, args[index]);
        break;
      case '--calibration-report':
        index += 1;
        options.calibration_report = requireArgValue(flag, args[index]);
        break;
      case '--diagnosis-report':
        index += 1;
        options.diagnosis_report = requireArgValue(flag, args[index]);
        break;
      case '--refit-report':
        index += 1;
        options.refit_report = requireArgValue(flag, args[index]);
        break;
      case '--out':
        index += 1;
        options.out = requireArgValue(flag, args[index]);
        break;
      case '--help':
        processStdout.write(usage());
        processExit(0);
        break;
      default:
        throw new Error(`unsupported argument: ${flag}`);
    }
  }
  if (options.observations === undefined) {
    throw new Error('missing required --observations');
  }
  if (options.calibration_report === undefined) {
    throw new Error('missing required --calibration-report');
  }
  if (options.diagnosis_report === undefined) {
    throw new Error('missing required --diagnosis-report');
  }
  return {
    observations: options.observations,
    calibration_report: options.calibration_report,
    diagnosis_report: options.diagnosis_report,
    ...(options.refit_report === undefined ? {} : { refit_report: options.refit_report }),
    out: options.out ?? DEFAULT_OUT_PATH,
  };
}

function createAccumulator(): ObservationAccumulator {
  return {
    splitStats: {
      calibration: createSplitAccumulator(),
      validation: createSplitAccumulator(),
    },
    sliceGroups: {
      by_order_side: new Map(),
      by_session_id: new Map(),
      by_instrument: new Map(),
      by_time_of_day: new Map(),
      by_order_size_bucket: new Map(),
      by_observed_time_to_fill_bucket: new Map(),
      by_modeled_time_to_fill_bucket: new Map(),
    },
    queueAhead: {
      negative: 0,
      zero: 0,
      positive: 0,
      missing: 0,
      negativeFilledTimes: [],
      zeroFilledTimes: [],
    },
  };
}

function createSplitAccumulator(): SplitAccumulator {
  return {
    filledTimes: [],
    histogramCounts: TIME_BUCKETS.map(() => 0),
    outcomeCounts: {
      total: 0,
      filled: 0,
      no_fill: 0,
      cancelled: 0,
    },
  };
}

function streamObservations(
  observationsPath: string,
  expectedSourceReportHash: string,
  accumulator: ObservationAccumulator,
): string {
  const digest = createHash('sha256');
  let lineNumber = 0;
  forEachJsonlLine(observationsPath, (line) => {
    lineNumber += 1;
    if (line.trim() === '') {
      return;
    }
    const parsed = JSON.parse(line) as unknown;
    const observation = validateLimitQueueFrontObservation(parsed, {
      lineNumber,
      expectedSourceReportHash,
      sourceLabel: observationsPath,
    });
    accumulateObservation(accumulator, observation);
  }, digest);
  return digest.digest('hex');
}

function forEachJsonlLine(
  path: string,
  callback: (line: string) => void,
  digest: ReturnType<typeof createHash>,
): void {
  const fd = openSync(path, 'r');
  const chunk = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
  const decoder = new StringDecoder('utf8');
  let remainder = '';
  try {
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        break;
      }
      const bytes = chunk.subarray(0, bytesRead);
      digest.update(bytes);
      const text = remainder + decoder.write(bytes);
      const lines = text.split(/\r?\n/u);
      remainder = lines.pop() ?? '';
      for (const line of lines) {
        callback(line);
      }
    }
    const finalText = remainder + decoder.end();
    if (finalText !== '') {
      callback(finalText);
    }
  } finally {
    closeSync(fd);
  }
}

function accumulateObservation(accumulator: ObservationAccumulator, observation: LimitQueueFrontObservation): void {
  const split = observation.split;
  const splitAccumulator = accumulator.splitStats[split];
  splitAccumulator.outcomeCounts.total += 1;
  splitAccumulator.outcomeCounts[observation.fill_outcome] += 1;

  const observedTimeToFill = observation.observed_time_to_fill_ms;
  const filledTime =
    observation.fill_outcome === 'filled' && typeof observedTimeToFill === 'number'
      ? observedTimeToFill
      : null;
  const modeledTime = typeof observation.modeled_time_to_fill_ms === 'number' ? observation.modeled_time_to_fill_ms : null;
  if (filledTime !== null) {
    splitAccumulator.filledTimes.push(filledTime);
    splitAccumulator.histogramCounts[timeBucketIndex(filledTime)] += 1;
  }

  const queueAheadSize = numericFeature(observation.queue_position_features, 'queue_ahead_size');
  accumulateQueueAhead(accumulator.queueAhead, queueAheadSize, filledTime);
  accumulateSlice(accumulator.sliceGroups.by_order_side, observation.order_side ?? 'missing', observation, filledTime, modeledTime);
  accumulateSlice(accumulator.sliceGroups.by_session_id, observation.session_id, observation, filledTime, modeledTime);
  accumulateSlice(accumulator.sliceGroups.by_instrument, observation.instrument, observation, filledTime, modeledTime);
  accumulateSlice(accumulator.sliceGroups.by_time_of_day, timeOfDayBucket(observation.event_ts_ns), observation, filledTime, modeledTime);
  accumulateSlice(
    accumulator.sliceGroups.by_order_size_bucket,
    orderSizeBucket(numericFeature(observation.queue_position_features, 'order_size')),
    observation,
    filledTime,
    modeledTime,
  );
  accumulateSlice(
    accumulator.sliceGroups.by_observed_time_to_fill_bucket,
    filledTime === null ? 'not_filled' : timeBucketId(filledTime),
    observation,
    filledTime,
    modeledTime,
  );
  accumulateSlice(
    accumulator.sliceGroups.by_modeled_time_to_fill_bucket,
    modeledTime === null ? 'missing' : timeBucketId(modeledTime),
    observation,
    filledTime,
    modeledTime,
  );
}

function accumulateSlice(
  group: Map<string, SliceAccumulator>,
  id: string,
  observation: LimitQueueFrontObservation,
  filledTime: number | null,
  modeledTime: number | null,
): void {
  const slice = getSlice(group, id);
  slice.count += 1;
  if (observation.split === 'calibration') {
    slice.calibrationCount += 1;
    if (filledTime !== null) {
      slice.calibrationFilledTimes.push(filledTime);
    }
    if (modeledTime !== null) {
      slice.calibrationModeledTimes.push(modeledTime);
    }
  } else {
    slice.validationCount += 1;
    if (filledTime !== null) {
      slice.validationFilledTimes.push(filledTime);
    }
    if (modeledTime !== null) {
      slice.validationModeledTimes.push(modeledTime);
    }
  }
}

function getSlice(group: Map<string, SliceAccumulator>, id: string): SliceAccumulator {
  const current = group.get(id);
  if (current !== undefined) {
    return current;
  }
  const next: SliceAccumulator = {
    count: 0,
    calibrationCount: 0,
    validationCount: 0,
    calibrationFilledTimes: [],
    validationFilledTimes: [],
    calibrationModeledTimes: [],
    validationModeledTimes: [],
  };
  group.set(id, next);
  return next;
}

function accumulateQueueAhead(
  accumulator: QueueAheadAccumulator,
  queueAheadSize: number | null,
  filledTime: number | null,
): void {
  if (queueAheadSize === null) {
    accumulator.missing += 1;
    return;
  }
  if (queueAheadSize < 0) {
    accumulator.negative += 1;
    if (filledTime !== null) {
      accumulator.negativeFilledTimes.push(filledTime);
    }
    return;
  }
  if (queueAheadSize === 0) {
    accumulator.zero += 1;
    if (filledTime !== null) {
      accumulator.zeroFilledTimes.push(filledTime);
    }
    return;
  }
  accumulator.positive += 1;
}

function distributionComparisonFrom(accumulator: ObservationAccumulator): DistributionComparison {
  const calibrationStats = statsFrom(accumulator.splitStats.calibration.filledTimes);
  const validationStats = statsFrom(accumulator.splitStats.validation.filledTimes);
  const calibrationShape = shapeDiagnosticsFrom(calibrationStats, histogramFrom(accumulator.splitStats.calibration));
  const validationShape = shapeDiagnosticsFrom(validationStats, histogramFrom(accumulator.splitStats.validation));
  return {
    filled_observations: {
      calibration: calibrationStats,
      validation: validationStats,
    },
    outcome_counts: {
      calibration: outcomeCountsFrom(accumulator.splitStats.calibration.outcomeCounts),
      validation: outcomeCountsFrom(accumulator.splitStats.validation.outcomeCounts),
    },
    no_fill_cancel_counts: {
      calibration: noFillCancelCountsFrom(accumulator.splitStats.calibration.outcomeCounts),
      validation: noFillCancelCountsFrom(accumulator.splitStats.validation.outcomeCounts),
    },
    ratios: {
      validation_calibration_median_ratio: ratio(validationStats.p50, calibrationStats.p50),
      validation_calibration_p90_ratio: ratio(validationStats.p90, calibrationStats.p90),
      validation_calibration_tail_ratio_delta: nullableDelta(
        validationStats.tail_ratio_p95_p50,
        calibrationStats.tail_ratio_p95_p50,
      ),
    },
    shape_diagnostics: {
      calibration: calibrationShape,
      validation: validationShape,
    },
    comparison_diagnosis: comparisonDiagnosis(calibrationStats, validationStats, calibrationShape, validationShape),
  };
}

function histogramsFrom(accumulator: ObservationAccumulator): Record<SplitName, HistogramReport> {
  return {
    calibration: histogramFrom(accumulator.splitStats.calibration),
    validation: histogramFrom(accumulator.splitStats.validation),
  };
}

function histogramFrom(split: SplitAccumulator): HistogramReport {
  const total = split.filledTimes.length;
  return {
    buckets: TIME_BUCKETS.map((bucket, index) => ({
      id: bucket.id,
      label: bucket.label,
      count: split.histogramCounts[index] ?? 0,
      share: total === 0 ? 0 : round6((split.histogramCounts[index] ?? 0) / total),
    })),
  };
}

function shapeDiagnosticsFrom(stats: DistributionStats, histogram: HistogramReport): ShapeDiagnostics {
  const notes: string[] = [];
  const localPeakCount = countLocalPeaks(histogram);
  const heavyTail = (stats.tail_ratio_p95_p50 ?? 0) >= 3 || ratio(stats.p99, stats.p50) !== null && (ratio(stats.p99, stats.p50) ?? 0) >= 5;
  const sparseOrUnstable = stats.count < 100;
  if (sparseOrUnstable) {
    notes.push('fewer than 100 filled observations');
  }
  if (heavyTail) {
    notes.push('p95/p50 or p99/p50 tail ratio is elevated');
  }
  if (localPeakCount >= 2) {
    notes.push('histogram has multiple material local peaks');
  }
  let shape: ShapeLabel = 'unimodal';
  if (sparseOrUnstable) {
    shape = 'sparse_or_unstable';
  } else if (localPeakCount >= 2) {
    shape = 'bimodal_or_multimodal';
  } else if (heavyTail) {
    shape = 'heavy_tailed';
  }
  if (notes.length === 0) {
    notes.push('no sparse, multimodal, or heavy-tail signal crossed deterministic heuristics');
  }
  return {
    shape,
    local_peak_count: localPeakCount,
    heavy_tail: heavyTail,
    sparse_or_unstable: sparseOrUnstable,
    notes,
  };
}

function countLocalPeaks(histogram: HistogramReport): number {
  const counts = histogram.buckets.map((bucket) => bucket.count);
  const maxCount = Math.max(0, ...counts);
  if (maxCount === 0) {
    return 0;
  }
  let peaks = 0;
  for (let index = 0; index < counts.length; index += 1) {
    const current = counts[index] ?? 0;
    const previous = index === 0 ? -1 : counts[index - 1] ?? 0;
    const next = index === counts.length - 1 ? -1 : counts[index + 1] ?? 0;
    if (current >= maxCount * 0.15 && current >= previous && current >= next) {
      peaks += 1;
    }
  }
  return peaks;
}

function comparisonDiagnosis(
  calibrationStats: DistributionStats,
  validationStats: DistributionStats,
  calibrationShape: ShapeDiagnostics,
  validationShape: ShapeDiagnostics,
): ShapeLabel {
  if (calibrationStats.count < 100 || validationStats.count < 100) {
    return 'sparse_or_unstable';
  }
  if (calibrationShape.shape === 'bimodal_or_multimodal' || validationShape.shape === 'bimodal_or_multimodal') {
    return 'bimodal_or_multimodal';
  }
  if (calibrationShape.heavy_tail || validationShape.heavy_tail) {
    return 'heavy_tailed';
  }
  const medianRatio = ratio(validationStats.p50, calibrationStats.p50);
  const tailDelta = nullableDelta(validationStats.tail_ratio_p95_p50, calibrationStats.tail_ratio_p95_p50);
  if (medianRatio !== null && (medianRatio < 0.8 || medianRatio > 1.25) && tailDelta !== null && Math.abs(tailDelta) <= 0.75) {
    return 'shifted_but_same_shape';
  }
  return 'unimodal';
}

function regimeSlicesFrom(accumulator: ObservationAccumulator, threshold: number): RegimeSlicesReport {
  const totalValidationFilled = accumulator.splitStats.validation.filledTimes.length;
  return {
    by_order_side: sliceReportsFrom(accumulator.sliceGroups.by_order_side, threshold, totalValidationFilled),
    by_session_id: sliceReportsFrom(accumulator.sliceGroups.by_session_id, threshold, totalValidationFilled),
    by_instrument: sliceReportsFrom(accumulator.sliceGroups.by_instrument, threshold, totalValidationFilled),
    by_time_of_day: sliceReportsFrom(accumulator.sliceGroups.by_time_of_day, threshold, totalValidationFilled),
    by_order_size_bucket: sliceReportsFrom(accumulator.sliceGroups.by_order_size_bucket, threshold, totalValidationFilled),
    by_observed_time_to_fill_bucket: sliceReportsFrom(accumulator.sliceGroups.by_observed_time_to_fill_bucket, threshold, totalValidationFilled),
    by_modeled_time_to_fill_bucket: sliceReportsFrom(accumulator.sliceGroups.by_modeled_time_to_fill_bucket, threshold, totalValidationFilled),
    unavailable_dimensions: [
      'spread_bucket: observation schema does not currently export spread',
      'volatility_regime: observation schema does not currently export volatility regime',
    ],
  };
}

function sliceReportsFrom(
  group: Map<string, SliceAccumulator>,
  threshold: number,
  totalValidationFilled: number,
): readonly SliceReport[] {
  return [...group.entries()]
    .map(([id, slice]) => sliceReportFrom(id, slice, threshold, totalValidationFilled))
    .sort((left, right) => {
      const validationDelta = right.validation_filled_count - left.validation_filled_count;
      if (validationDelta !== 0) {
        return validationDelta;
      }
      return left.id.localeCompare(right.id);
    });
}

function sliceReportFrom(
  id: string,
  slice: SliceAccumulator,
  threshold: number,
  totalValidationFilled: number,
): SliceReport {
  const calibrationMedian = median(slice.calibrationFilledTimes);
  const validationMedian = median(slice.validationFilledTimes);
  const calibrationP90 = percentile(slice.calibrationFilledTimes, 0.9);
  const validationP90 = percentile(slice.validationFilledTimes, 0.9);
  const relativeError =
    calibrationMedian === null || validationMedian === null
      ? null
      : round6(Math.abs(calibrationMedian - validationMedian) / Math.max(1.0, validationMedian));
  const p90Error =
    calibrationP90 === null || validationP90 === null
      ? null
      : round6(Math.abs(calibrationP90 - validationP90) / Math.max(1.0, validationP90));
  return {
    id,
    count: slice.count,
    calibration_count: slice.calibrationCount,
    validation_count: slice.validationCount,
    calibration_filled_count: slice.calibrationFilledTimes.length,
    validation_filled_count: slice.validationFilledTimes.length,
    observed_median_ms: validationMedian === null ? null : round6(validationMedian),
    modeled_median_ms: calibrationMedian === null ? null : round6(calibrationMedian),
    relative_error: relativeError,
    p90_error: p90Error,
    contribution_to_total_failure:
      relativeError === null || totalValidationFilled === 0
        ? null
        : round6((slice.validationFilledTimes.length / totalValidationFilled) * relativeError),
    passes_threshold: relativeError === null ? null : relativeError <= threshold,
  };
}

function queueFrontDefinitionAuditFrom(accumulator: ObservationAccumulator): QueueFrontDefinitionAudit {
  const negativeStats = statsFrom(accumulator.queueAhead.negativeFilledTimes);
  const zeroStats = statsFrom(accumulator.queueAhead.zeroFilledTimes);
  const negativeZeroError =
    negativeStats.p50 === null || zeroStats.p50 === null
      ? null
      : Math.abs(negativeStats.p50 - zeroStats.p50) / Math.max(1.0, zeroStats.p50);
  const negativeDiffers = negativeZeroError === null ? null : negativeZeroError > DEFAULT_THRESHOLD;
  const mismatch = accumulator.queueAhead.positive > 0 || accumulator.queueAhead.missing > 0 || (negativeDiffers ?? false);
  return {
    queue_ahead_size_distribution: {
      negative: accumulator.queueAhead.negative,
      zero: accumulator.queueAhead.zero,
      positive: accumulator.queueAhead.positive,
      missing: accumulator.queueAhead.missing,
    },
    queue_ahead_size_filled_stats: {
      negative: negativeStats,
      zero: zeroStats,
    },
    negative_values_behave_differently_than_zero: negativeDiffers,
    unexpected_nonzero_queue_ahead_records: accumulator.queueAhead.positive,
    queue_front_definition_mismatch_detected: mismatch,
  };
}

function modelCandidatesFrom(input: {
  readonly accumulator: ObservationAccumulator;
  readonly regimeSlices: RegimeSlicesReport;
  readonly threshold: number;
  readonly refitMetric: number | null;
}): Record<string, ModelCandidateReport> {
  const singleMetric = input.refitMetric ?? projectedPiecewiseMetric(input.regimeSlices.by_instrument);
  const sideMetric = projectedPiecewiseMetric(input.regimeSlices.by_order_side);
  const timeMetric = projectedPiecewiseMetric(input.regimeSlices.by_time_of_day);
  const sessionMetric = projectedPiecewiseMetric(input.regimeSlices.by_session_id);
  const orderSizeMetric = projectedPiecewiseMetric(input.regimeSlices.by_order_size_bucket);
  const robustMetric = robustTrimmedMetric(
    input.accumulator.splitStats.calibration.filledTimes,
    input.accumulator.splitStats.validation.filledTimes,
  );
  const bestAvailable = bestMetric([
    ['side_specific_median_refit', sideMetric],
    ['time_of_day_median_refit', timeMetric],
    ['session_median_refit', sessionMetric],
    ['order_size_piecewise_refit', orderSizeMetric],
  ]);
  return {
    single_median_refit: candidateReport({
      strategy: 'single median refit',
      metric: singleMetric,
      parameterCount: 1,
      threshold: input.threshold,
      minValidationFilled: input.accumulator.splitStats.validation.filledTimes.length,
      notes: ['Matches SIM-03H targeted median-refit behavior.'],
    }),
    side_specific_median_refit: candidateReport({
      strategy: 'side-specific front-bucket median refit',
      metric: sideMetric,
      parameterCount: input.regimeSlices.by_order_side.filter((slice) => slice.validation_filled_count > 0).length,
      threshold: input.threshold,
      minValidationFilled: minValidationFilled(input.regimeSlices.by_order_side),
      notes: ['Estimates one calibration median per order_side and scores validation slices by side.'],
    }),
    time_of_day_median_refit: candidateReport({
      strategy: 'time-of-day front-bucket median refit',
      metric: timeMetric,
      parameterCount: input.regimeSlices.by_time_of_day.filter((slice) => slice.validation_filled_count > 0).length,
      threshold: input.threshold,
      minValidationFilled: minValidationFilled(input.regimeSlices.by_time_of_day),
      notes: ['Uses deterministic RTH open/morning/midday/close buckets derived from event_ts_ns.'],
    }),
    spread_bucket_median_refit: {
      strategy: 'spread-bucket front-bucket median refit',
      projected_validation_metric: null,
      changed_parameter_count: 0,
      overfit_risk: 'high',
      evidence_strength: 'insufficient',
      likely_passes_threshold: null,
      notes: ['Observation schema does not currently export spread_bucket; SIM-03L would need an export-field extension.'],
    },
    robust_trimmed_statistic: candidateReport({
      strategy: '10-90 trimmed mean front-bucket statistic',
      metric: robustMetric,
      parameterCount: 1,
      threshold: input.threshold,
      minValidationFilled: input.accumulator.splitStats.validation.filledTimes.length,
      notes: ['Analysis-only robust-statistic proxy; it does not mutate the SIM-03 report.'],
    }),
    best_available_piecewise_model: candidateReport({
      strategy: `best available piecewise split (${bestAvailable.name})`,
      metric: bestAvailable.metric,
      parameterCount: bestAvailable.name === 'none' ? 0 : 2,
      threshold: input.threshold,
      minValidationFilled: Math.max(
        0,
        minValidationFilled(input.regimeSlices.by_order_side),
        minValidationFilled(input.regimeSlices.by_time_of_day),
        minValidationFilled(input.regimeSlices.by_session_id),
      ),
      notes: ['Compares side, session, time-of-day, and order-size splits available in the exported observations.'],
    }),
  };
}

function candidateReport(input: {
  readonly strategy: string;
  readonly metric: number | null;
  readonly parameterCount: number;
  readonly threshold: number;
  readonly minValidationFilled: number;
  readonly notes: readonly string[];
}): ModelCandidateReport {
  return {
    strategy: input.strategy,
    projected_validation_metric: input.metric,
    changed_parameter_count: input.parameterCount,
    overfit_risk: overfitRisk(input.parameterCount, input.minValidationFilled),
    evidence_strength: evidenceStrength(input.minValidationFilled),
    likely_passes_threshold: input.metric === null ? null : input.metric <= input.threshold,
    notes: input.notes,
  };
}

function projectedPiecewiseMetric(slices: readonly SliceReport[]): number | null {
  let weighted = 0;
  let count = 0;
  for (const slice of slices) {
    if (slice.relative_error === null || slice.validation_filled_count === 0 || slice.calibration_filled_count === 0) {
      continue;
    }
    weighted += slice.relative_error * slice.validation_filled_count;
    count += slice.validation_filled_count;
  }
  return count === 0 ? null : round6(weighted / count);
}

function robustTrimmedMetric(calibrationTimes: readonly number[], validationTimes: readonly number[]): number | null {
  const calibration = trimmedMean(calibrationTimes, 0.1, 0.9);
  const validation = trimmedMean(validationTimes, 0.1, 0.9);
  if (calibration === null || validation === null) {
    return null;
  }
  return round6(Math.abs(calibration - validation) / Math.max(1.0, validation));
}

function bestMetric(candidates: readonly (readonly [string, number | null])[]): { readonly name: string; readonly metric: number | null } {
  let bestName = 'none';
  let best: number | null = null;
  for (const [name, metric] of candidates) {
    if (metric === null) {
      continue;
    }
    if (best === null || metric < best) {
      best = metric;
      bestName = name;
    }
  }
  return { name: bestName, metric: best };
}

function minValidationFilled(slices: readonly SliceReport[]): number {
  const populated = slices.filter((slice) => slice.validation_filled_count > 0).map((slice) => slice.validation_filled_count);
  return populated.length === 0 ? 0 : Math.min(...populated);
}

function overfitRisk(parameterCount: number, minValidationFilledCount: number): 'low' | 'medium' | 'high' {
  if (parameterCount <= 1 && minValidationFilledCount >= 500) {
    return 'low';
  }
  if (minValidationFilledCount >= 100 && parameterCount <= 5) {
    return 'medium';
  }
  return 'high';
}

function evidenceStrength(minValidationFilledCount: number): 'strong' | 'moderate' | 'weak' | 'insufficient' {
  if (minValidationFilledCount >= 500) {
    return 'strong';
  }
  if (minValidationFilledCount >= 100) {
    return 'moderate';
  }
  if (minValidationFilledCount >= 30) {
    return 'weak';
  }
  return 'insufficient';
}

function classifyRemainingFailure(input: {
  readonly threshold: number;
  readonly refitMetric: number | null;
  readonly distributionComparison: DistributionComparison;
  readonly queueAudit: QueueFrontDefinitionAudit;
  readonly modelCandidates: Record<string, ModelCandidateReport>;
}): Sim03kFailureClassification {
  if (input.queueAudit.queue_front_definition_mismatch_detected) {
    return 'queue_front_definition_mismatch';
  }
  if (input.modelCandidates.side_specific_median_refit.likely_passes_threshold === true) {
    return 'side_specific_underfit';
  }
  if (input.modelCandidates.time_of_day_median_refit.likely_passes_threshold === true) {
    return 'time_of_day_regime_underfit';
  }
  if (input.modelCandidates.best_available_piecewise_model.likely_passes_threshold === true) {
    return 'model_class_underfit';
  }
  if (
    input.modelCandidates.robust_trimmed_statistic.likely_passes_threshold === true &&
    (input.distributionComparison.shape_diagnostics.calibration.heavy_tail ||
      input.distributionComparison.shape_diagnostics.validation.heavy_tail ||
      input.distributionComparison.comparison_diagnosis === 'bimodal_or_multimodal')
  ) {
    return 'heavy_tail_metric_sensitivity';
  }
  if (input.distributionComparison.comparison_diagnosis === 'shifted_but_same_shape') {
    return 'validation_distribution_shift';
  }
  if (input.distributionComparison.comparison_diagnosis === 'heavy_tailed') {
    return 'heavy_tail_metric_sensitivity';
  }
  if (input.modelCandidates.spread_bucket_median_refit.evidence_strength === 'insufficient') {
    return input.refitMetric !== null && input.refitMetric > input.threshold ? 'model_class_underfit' : 'insufficient_feature_fields';
  }
  return 'inconclusive';
}

function recommendationFor(classification: Sim03kFailureClassification): string {
  switch (classification) {
    case 'side_specific_underfit':
      return 'SIM-03L should implement a side-specific front-bucket time-to-fill refit and validate it with SIM-03D.';
    case 'time_of_day_regime_underfit':
      return 'SIM-03L should implement a time-of-day piecewise front-bucket refit and validate it with SIM-03D.';
    case 'spread_regime_underfit':
      return 'SIM-03L should export spread/regime fields, then evaluate a spread/regime front-bucket refit.';
    case 'heavy_tail_metric_sensitivity':
      return 'SIM-03L should test a robust front-bucket statistic and prove it does not mask tail risk.';
    case 'queue_front_definition_mismatch':
      return 'SIM-03L should redefine or repair the front queue bucket, re-export targeted observations, and rerun SIM-03H.';
    case 'validation_distribution_shift':
      return 'SIM-03L should compare calibration and validation split construction before changing model form.';
    case 'insufficient_feature_fields':
      return 'SIM-03L should extend the observation export with spread/volatility fields before selecting a model change.';
    case 'model_class_underfit':
      return 'SIM-03L should test the best available piecewise front-bucket model while keeping global thresholds unchanged.';
    case 'inconclusive':
      return 'Keep SIM-03 failed pending more evidence; add richer observation fields before refitting.';
  }
}

function outcomeCountsFrom(counts: MutableOutcomeCounts): OutcomeCounts {
  return {
    total: counts.total,
    filled: counts.filled,
    no_fill: counts.no_fill,
    cancelled: counts.cancelled,
  };
}

function noFillCancelCountsFrom(counts: MutableOutcomeCounts): OutcomeCounts {
  return {
    total: counts.no_fill + counts.cancelled,
    filled: 0,
    no_fill: counts.no_fill,
    cancelled: counts.cancelled,
  };
}

function statsFrom(values: readonly number[]): DistributionStats {
  if (values.length === 0) {
    return {
      count: 0,
      p10: null,
      p25: null,
      p50: null,
      p75: null,
      p90: null,
      p95: null,
      p99: null,
      mean: null,
      stddev: null,
      iqr: null,
      tail_ratio_p95_p50: null,
    };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const p25 = percentileSorted(sorted, 0.25);
  const p50 = percentileSorted(sorted, 0.5);
  const p75 = percentileSorted(sorted, 0.75);
  const p95 = percentileSorted(sorted, 0.95);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length;
  return {
    count: sorted.length,
    p10: round6(percentileSorted(sorted, 0.1)),
    p25: round6(p25),
    p50: round6(p50),
    p75: round6(p75),
    p90: round6(percentileSorted(sorted, 0.9)),
    p95: round6(p95),
    p99: round6(percentileSorted(sorted, 0.99)),
    mean: round6(mean),
    stddev: round6(Math.sqrt(variance)),
    iqr: round6(p75 - p25),
    tail_ratio_p95_p50: p50 === 0 ? null : round6(p95 / p50),
  };
}

function median(values: readonly number[]): number | null {
  return percentile(values, 0.5);
}

function percentile(values: readonly number[], probability: number): number | null {
  if (values.length === 0) {
    return null;
  }
  return percentileSorted([...values].sort((left, right) => left - right), probability);
}

function percentileSorted(sorted: readonly number[], probability: number): number {
  if (sorted.length === 1) {
    return sorted[0] ?? 0;
  }
  const rank = probability * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (rank - lower);
}

function trimmedMean(values: readonly number[], lowerProbability: number, upperProbability: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const lower = Math.floor(sorted.length * lowerProbability);
  const upper = Math.ceil(sorted.length * upperProbability);
  const trimmed = sorted.slice(lower, Math.max(lower + 1, upper));
  return trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length;
}

function timeBucketIndex(value: number): number {
  const index = TIME_BUCKETS.findIndex((bucket) => value >= bucket.min && value < bucket.max);
  return index === -1 ? TIME_BUCKETS.length - 1 : index;
}

function timeBucketId(value: number): string {
  return TIME_BUCKETS[timeBucketIndex(value)]?.id ?? 'gt_30000_ms';
}

function timeOfDayBucket(eventTsNs: string): string {
  try {
    const seconds = BigInt(eventTsNs) / 1_000_000_000n;
    const secondsOfDay = Number(seconds % 86_400n);
    if (secondsOfDay >= 13 * 3600 + 30 * 60 && secondsOfDay < 14 * 3600 + 30 * 60) {
      return 'rth_open';
    }
    if (secondsOfDay >= 14 * 3600 + 30 * 60 && secondsOfDay < 16 * 3600 + 30 * 60) {
      return 'rth_morning';
    }
    if (secondsOfDay >= 16 * 3600 + 30 * 60 && secondsOfDay < 18 * 3600 + 30 * 60) {
      return 'rth_midday';
    }
    if (secondsOfDay >= 18 * 3600 + 30 * 60 && secondsOfDay < 20 * 3600) {
      return 'rth_close';
    }
    return 'outside_rth';
  } catch {
    return 'unknown';
  }
}

function orderSizeBucket(value: number | null): string {
  if (value === null) {
    return 'missing';
  }
  if (value <= 1) {
    return 'size_1';
  }
  if (value <= 5) {
    return 'size_2_5';
  }
  if (value <= 10) {
    return 'size_6_10';
  }
  return 'size_gt_10';
}

function numericFeature(features: JsonObject, key: string): number | null {
  const value = features[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) {
    return null;
  }
  return round6(numerator / denominator);
}

function nullableDelta(left: number | null, right: number | null): number | null {
  if (left === null || right === null) {
    return null;
  }
  return round6(left - right);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

function parseJsonObject(text: string, label: string): JsonObject {
  const value = JSON.parse(text) as unknown;
  if (!isJsonObject(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value;
}

function requireFrontResidual(report: JsonObject): JsonObject {
  const residuals = report.residuals;
  if (!isJsonObject(residuals) || !Array.isArray(residuals.limit_queue)) {
    throw new Error('calibration report missing residuals.limit_queue');
  }
  const target = residuals.limit_queue.find(
    (candidate: unknown) => isJsonObject(candidate) && candidate.bucket_id === 'front',
  );
  if (!isJsonObject(target)) {
    throw new Error('calibration report missing limit_queue:front residual');
  }
  return target;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requireArgValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function usage(): string {
  return `Analyze SIM-03 limit_queue:front time-to-fill distributions.

Usage:
  npm run sim:03k:analyze-front-distribution -- \\
    --observations reports/sim/limit_queue_front_observations.jsonl \\
    --calibration-report reports/sim/fill_slippage_calibration.json \\
    --diagnosis-report reports/sim/limit_queue_front_diagnosis.json \\
    --refit-report reports/sim/limit_queue_front_refit_report.json \\
    --out reports/sim/limit_queue_front_distribution_analysis.json
`;
}

export function main(args: readonly string[] = processArgv.slice(2)): number {
  try {
    const options = parseAnalyzeLimitQueueFrontDistributionArgs(args);
    const report = analyzeLimitQueueFrontDistribution(options);
    writeAnalysisReport(report, options.out ?? DEFAULT_OUT_PATH, options.cwd);
    processStdout.write(
      `SIM-03K status: ${report.status}\nclassification=${report.classification}\nrecommendation=${report.recommendation}\n`,
    );
    return 0;
  } catch (error) {
    processStderr.write(`SIM-03K analysis failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (processArgv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(processArgv[1])) {
  processExit(main());
}
