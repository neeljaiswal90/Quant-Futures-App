import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  argv as processArgv,
  exit as processExit,
  stderr as processStderr,
  stdout as processStdout,
} from 'node:process';
import { fileURLToPath } from 'node:url';

export const SIM_03F_DIAGNOSIS_REPORT_SCHEMA_VERSION = 1 as const;
export const SIM_03F_TICKET_ID = 'SIM-03F' as const;
const TARGET_BUCKET_ID = 'front';
const NEIGHBOR_BUCKET_IDS = ['near', 'middle', 'back'] as const;
const DEFAULT_OUT_PATH = 'reports/sim/limit_queue_front_diagnosis.json';

export type FailureClass =
  | 'threshold_too_strict'
  | 'queue_front_definition_mismatch'
  | 'fill_labeling_bug'
  | 'timeout_window_mismatch'
  | 'validation_distribution_shift'
  | 'sparse_or_unstable_bucket'
  | 'model_underfit_specific_bucket'
  | 'inconclusive';

export interface DiagnoseLimitQueueFrontOptions {
  readonly cwd?: string;
  readonly report: string;
  readonly out?: string;
}

export interface LimitQueueBucketMetrics {
  readonly empirical_fill_probability: number | null;
  readonly modeled_fill_probability: number | null;
  readonly fill_probability_residual: number | null;
  readonly fill_probability_threshold: number | null;
  readonly empirical_no_fill_rate: number | null;
  readonly modeled_no_fill_rate: number | null;
  readonly no_fill_rate_residual: number | null;
  readonly no_fill_rate_threshold: number | null;
  readonly empirical_time_to_fill_median_ms: number | null;
  readonly modeled_time_to_fill_median_ms: number | null;
  readonly time_to_fill_relative_error: number | null;
  readonly time_to_fill_relative_threshold: number | null;
}

export interface Sim03fDiagnosisReport {
  readonly sim03f_diagnosis_report_schema_version: typeof SIM_03F_DIAGNOSIS_REPORT_SCHEMA_VERSION;
  readonly ticket_id: typeof SIM_03F_TICKET_ID;
  readonly status: 'diagnosed';
  readonly source_report: {
    readonly path: string;
    readonly sha256: string;
    readonly status: string | null;
    readonly ready_for_rel01_execution_simulation: boolean | null;
    readonly failure_reasons: readonly string[];
  };
  readonly target_bucket: {
    readonly group: 'limit_queue';
    readonly bucket_id: typeof TARGET_BUCKET_ID;
    readonly status: string | null;
    readonly aggregation: string | null;
    readonly sample_counts: {
      readonly calibration: number | null;
      readonly validation: number | null;
    };
    readonly metrics: LimitQueueBucketMetrics;
    readonly checks: Record<string, boolean>;
    readonly exact_failed_criteria: readonly FailedCriterion[];
    readonly source_failure_reasons: readonly string[];
  };
  readonly neighboring_buckets: readonly NeighborBucket[];
  readonly marketable_context: {
    readonly total_buckets: number;
    readonly failed_buckets: number;
    readonly insufficient_sample_buckets: number;
    readonly failed_bucket_ids: readonly string[];
  };
  readonly queue_position_assumptions: {
    readonly target_bucket_meaning: string;
    readonly near_front_alias: string;
    readonly modeled_metric_source: string;
    readonly empirical_metric_source: string;
    readonly diagnosis_note: string;
  };
  readonly likely_failure_class: FailureClass;
  readonly secondary_failure_classes: readonly FailureClass[];
  readonly recommendation: {
    readonly primary_action: string;
    readonly supporting_actions: readonly string[];
    readonly keep_sim03_failed: true;
    readonly full_rerun_required: boolean;
    readonly targeted_rerun_required: boolean;
    readonly rationale: string;
  };
  readonly sim03_acceptance_remains_failed: true;
  readonly scope_note: string;
}

export interface FailedCriterion {
  readonly name: string;
  readonly source_check: string;
  readonly value: number | null;
  readonly threshold: number | null;
  readonly comparator: '<=';
}

export interface NeighborBucket {
  readonly bucket_id: string;
  readonly alias: string | null;
  readonly status: string | null;
  readonly sample_counts: {
    readonly calibration: number | null;
    readonly validation: number | null;
  };
  readonly metrics: LimitQueueBucketMetrics;
  readonly failed_criteria: readonly FailedCriterion[];
}

type JsonObject = Record<string, unknown>;

export function diagnoseLimitQueueFront(options: DiagnoseLimitQueueFrontOptions): Sim03fDiagnosisReport {
  const cwd = resolve(options.cwd ?? process.cwd());
  const reportPath = resolve(cwd, options.report);
  const sourceText = readFileSync(reportPath, 'utf8');
  const source = parseJsonObject(sourceText, reportPath);
  const limitResiduals = arrayOfObjects(valuePath(source, ['residuals', 'limit_queue']), 'residuals.limit_queue');
  const targetResidual = requireBucket(limitResiduals, TARGET_BUCKET_ID);
  const fittedConstants = objectPath(source, ['fitted_constants', 'queue_fill_model']);
  const targetConstants = optionalObject(fittedConstants[TARGET_BUCKET_ID]);

  const targetMetrics = bucketMetrics(targetResidual, targetConstants);
  const targetChecks = boolRecord(targetResidual.checks);
  const sourceFailureReasons = stringArray(targetResidual.failure_reasons);
  const exactFailedCriteria = failedCriteria(targetResidual, targetMetrics);
  const neighboringBuckets = NEIGHBOR_BUCKET_IDS.map((bucketId) => {
    const residual = limitResiduals.find((candidate) => candidate.bucket_id === bucketId);
    if (residual === undefined) {
      return missingNeighbor(bucketId);
    }
    return neighborBucket(bucketId, residual, optionalObject(fittedConstants[bucketId]));
  });

  const marketableResiduals = arrayOfObjects(valuePath(source, ['residuals', 'marketable_slippage']), 'residuals.marketable_slippage');
  const likelyFailureClass = classifyFailure({
    target: targetResidual,
    metrics: targetMetrics,
    failedCriteria: exactFailedCriteria,
    neighbors: neighboringBuckets,
  });
  const secondaryFailureClasses = secondaryFailureClassesFor(likelyFailureClass, exactFailedCriteria);

  return {
    sim03f_diagnosis_report_schema_version: SIM_03F_DIAGNOSIS_REPORT_SCHEMA_VERSION,
    ticket_id: SIM_03F_TICKET_ID,
    status: 'diagnosed',
    source_report: {
      path: reportPath,
      sha256: createHash('sha256').update(sourceText, 'utf8').digest('hex'),
      status: maybeString(source.status),
      ready_for_rel01_execution_simulation: maybeBoolean(source.ready_for_rel01_execution_simulation),
      failure_reasons: stringArray(source.failure_reasons),
    },
    target_bucket: {
      group: 'limit_queue',
      bucket_id: TARGET_BUCKET_ID,
      status: maybeString(targetResidual.status),
      aggregation: maybeString(targetResidual.aggregation),
      sample_counts: sampleCounts(targetResidual),
      metrics: targetMetrics,
      checks: targetChecks,
      exact_failed_criteria: exactFailedCriteria,
      source_failure_reasons: sourceFailureReasons,
    },
    neighboring_buckets: neighboringBuckets,
    marketable_context: marketableContext(marketableResiduals),
    queue_position_assumptions: {
      target_bucket_meaning: 'The front limit-queue bucket represents the most aggressive queue-position slice scored by SIM-03.',
      near_front_alias: 'SIM-03F reports the existing SIM-03 `near` bucket as the requested neighboring `near_front` bucket.',
      modeled_metric_source: 'Modeled limit metrics come from calibration-split fitted queue_fill_model constants.',
      empirical_metric_source: 'Empirical residual metrics come from validation-split limit-queue observations in the SIM-03 report.',
      diagnosis_note: 'SIM-03F is diagnostic only: it does not relax thresholds, mutate the SIM-03 report, or unblock REL-01.',
    },
    likely_failure_class: likelyFailureClass,
    secondary_failure_classes: secondaryFailureClasses,
    recommendation: recommendationFor(likelyFailureClass, exactFailedCriteria, targetMetrics, neighboringBuckets),
    sim03_acceptance_remains_failed: true,
    scope_note: 'SIM-03F diagnoses the isolated SIM-03 limit_queue:front failure without changing calibration thresholds or REL gates.',
  };
}

export function writeDiagnosisReport(report: Sim03fDiagnosisReport, outPath: string, cwd = process.cwd()): void {
  const resolved = resolve(cwd, outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export function parseDiagnoseLimitQueueFrontArgs(args: readonly string[]): DiagnoseLimitQueueFrontOptions {
  const options: {
    report?: string;
    out?: string;
  } = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    switch (flag) {
      case '--report':
        index += 1;
        options.report = requireArgValue(flag, args[index]);
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
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (options.report === undefined) {
    throw new Error('--report is required');
  }
  return {
    report: options.report,
    out: options.out ?? DEFAULT_OUT_PATH,
  };
}

function classifyFailure(input: {
  readonly target: JsonObject;
  readonly metrics: LimitQueueBucketMetrics;
  readonly failedCriteria: readonly FailedCriterion[];
  readonly neighbors: readonly NeighborBucket[];
}): FailureClass {
  const calibrationCount = numberValue(input.target.calibration_sample_count) ?? 0;
  const validationCount = numberValue(input.target.validation_sample_count) ?? 0;
  if (calibrationCount < 1_000 || validationCount < 1_000) {
    return 'sparse_or_unstable_bucket';
  }

  const failedNames = new Set(input.failedCriteria.map((criterion) => criterion.name));
  const onlyTimeToFillFailed = failedNames.size === 1 &&
    failedNames.has('time_to_fill_relative_error_within_time_to_fill_relative_threshold');
  const neighborsPass = input.neighbors.every((neighbor) => neighbor.status === 'pass');
  if (onlyTimeToFillFailed && neighborsPass) {
    return 'model_underfit_specific_bucket';
  }
  if (failedNames.has('fill_probability_residual_within_fill_probability_threshold')) {
    return 'fill_labeling_bug';
  }
  if (
    failedNames.has('no_fill_rate_residual_within_no_fill_rate_threshold') &&
    failedNames.has('time_to_fill_relative_error_within_time_to_fill_relative_threshold')
  ) {
    return 'timeout_window_mismatch';
  }
  if (onlyTimeToFillFailed) {
    return 'validation_distribution_shift';
  }
  return 'inconclusive';
}

function secondaryFailureClassesFor(
  primary: FailureClass,
  failedCriteria: readonly FailedCriterion[],
): readonly FailureClass[] {
  if (
    primary === 'model_underfit_specific_bucket' &&
    failedCriteria.some((criterion) => criterion.name === 'time_to_fill_relative_error_within_time_to_fill_relative_threshold')
  ) {
    return ['validation_distribution_shift', 'queue_front_definition_mismatch'];
  }
  if (primary === 'fill_labeling_bug') {
    return ['queue_front_definition_mismatch'];
  }
  return [];
}

function recommendationFor(
  failureClass: FailureClass,
  failedCriteria: readonly FailedCriterion[],
  metrics: LimitQueueBucketMetrics,
  neighbors: readonly NeighborBucket[],
): Sim03fDiagnosisReport['recommendation'] {
  const failedNames = failedCriteria.map((criterion) => criterion.name);
  if (failureClass === 'model_underfit_specific_bucket') {
    return {
      primary_action: 'Add a targeted front-bucket time-to-fill recalibration path; do not alter global thresholds or passing neighboring buckets.',
      supporting_actions: [
        'Compare front-bucket calibration-vs-validation time-to-fill distributions before changing queue labels.',
        'Evaluate splitting the front bucket into finer sub-buckets if the validation median remains materially faster than the fitted median.',
        'Keep fill-probability and no-fill constants unchanged unless a follow-up label audit shows they are coupled to the time-to-fill miss.',
      ],
      keep_sim03_failed: true,
      full_rerun_required: false,
      targeted_rerun_required: true,
      rationale: [
        `Failed criteria: ${failedNames.join(', ') || 'none'}.`,
        `Front time-to-fill relative error ${formatNumber(metrics.time_to_fill_relative_error)} exceeds threshold ${formatNumber(metrics.time_to_fill_relative_threshold)}.`,
        `Neighbor statuses: ${neighbors.map((neighbor) => `${neighbor.alias ?? neighbor.bucket_id}=${neighbor.status ?? 'missing'}`).join(', ')}.`,
      ].join(' '),
    };
  }
  if (failureClass === 'sparse_or_unstable_bucket') {
    return {
      primary_action: 'Keep SIM-03 failed and gather more front-bucket validation evidence before tuning.',
      supporting_actions: [
        'Expand the corpus or aggregate the front bucket with the nearest queue bucket.',
        'Re-run the diagnostic after the sample floor is healthy.',
      ],
      keep_sim03_failed: true,
      full_rerun_required: true,
      targeted_rerun_required: false,
      rationale: 'The target bucket does not have enough samples for a stable isolated diagnosis.',
    };
  }
  return {
    primary_action: 'Keep SIM-03 failed pending a focused label/model audit of the front queue bucket.',
    supporting_actions: [
      'Audit fill labels and timeout/no-fill policy for the target bucket.',
      'Compare validation distribution shift against neighboring queue buckets.',
    ],
    keep_sim03_failed: true,
    full_rerun_required: false,
    targeted_rerun_required: true,
    rationale: `Failure class ${failureClass} requires a targeted follow-up before REL-01 can consume the calibration.`,
  };
}

function failedCriteria(bucket: JsonObject, metrics: LimitQueueBucketMetrics): readonly FailedCriterion[] {
  const failures = new Set(stringArray(bucket.failure_reasons));
  const checks = boolRecord(bucket.checks);
  const criteria: FailedCriterion[] = [];
  if (failures.has('fill_probability_pass') || checks.fill_probability_pass === false) {
    criteria.push({
      name: 'fill_probability_residual_within_fill_probability_threshold',
      source_check: 'fill_probability_pass',
      value: metrics.fill_probability_residual,
      threshold: metrics.fill_probability_threshold,
      comparator: '<=',
    });
  }
  if (failures.has('time_to_fill_pass') || checks.time_to_fill_pass === false) {
    criteria.push({
      name: 'time_to_fill_relative_error_within_time_to_fill_relative_threshold',
      source_check: 'time_to_fill_pass',
      value: metrics.time_to_fill_relative_error,
      threshold: metrics.time_to_fill_relative_threshold,
      comparator: '<=',
    });
  }
  if (failures.has('no_fill_rate_pass') || checks.no_fill_rate_pass === false) {
    criteria.push({
      name: 'no_fill_rate_residual_within_no_fill_rate_threshold',
      source_check: 'no_fill_rate_pass',
      value: metrics.no_fill_rate_residual,
      threshold: metrics.no_fill_rate_threshold,
      comparator: '<=',
    });
  }
  return criteria;
}

function neighborBucket(bucketId: string, residual: JsonObject, constants: JsonObject): NeighborBucket {
  return {
    bucket_id: bucketId,
    alias: bucketId === 'near' ? 'near_front' : null,
    status: maybeString(residual.status),
    sample_counts: sampleCounts(residual),
    metrics: bucketMetrics(residual, constants),
    failed_criteria: failedCriteria(residual, bucketMetrics(residual, constants)),
  };
}

function missingNeighbor(bucketId: string): NeighborBucket {
  return {
    bucket_id: bucketId,
    alias: bucketId === 'near' ? 'near_front' : null,
    status: 'missing',
    sample_counts: {
      calibration: null,
      validation: null,
    },
    metrics: emptyMetrics(),
    failed_criteria: [],
  };
}

function bucketMetrics(bucket: JsonObject, constants: JsonObject): LimitQueueBucketMetrics {
  return {
    empirical_fill_probability: numberValue(bucket.empirical_fill_probability),
    modeled_fill_probability: numberValue(bucket.modeled_fill_probability ?? constants.fill_probability),
    fill_probability_residual: numberValue(bucket.fill_probability_residual),
    fill_probability_threshold: numberValue(bucket.fill_probability_threshold),
    empirical_no_fill_rate: numberValue(bucket.empirical_no_fill_rate),
    modeled_no_fill_rate: numberValue(bucket.modeled_no_fill_rate ?? constants.no_fill_probability),
    no_fill_rate_residual: numberValue(bucket.no_fill_rate_residual),
    no_fill_rate_threshold: numberValue(bucket.no_fill_rate_threshold),
    empirical_time_to_fill_median_ms: numberValue(bucket.empirical_time_to_fill_median_ms),
    modeled_time_to_fill_median_ms: numberValue(bucket.modeled_time_to_fill_median_ms ?? constants.median_time_to_fill_ms),
    time_to_fill_relative_error: numberValue(bucket.time_to_fill_relative_error),
    time_to_fill_relative_threshold: numberValue(bucket.time_to_fill_relative_threshold),
  };
}

function emptyMetrics(): LimitQueueBucketMetrics {
  return {
    empirical_fill_probability: null,
    modeled_fill_probability: null,
    fill_probability_residual: null,
    fill_probability_threshold: null,
    empirical_no_fill_rate: null,
    modeled_no_fill_rate: null,
    no_fill_rate_residual: null,
    no_fill_rate_threshold: null,
    empirical_time_to_fill_median_ms: null,
    modeled_time_to_fill_median_ms: null,
    time_to_fill_relative_error: null,
    time_to_fill_relative_threshold: null,
  };
}

function sampleCounts(bucket: JsonObject): { readonly calibration: number | null; readonly validation: number | null } {
  return {
    calibration: numberValue(bucket.calibration_sample_count),
    validation: numberValue(bucket.validation_sample_count),
  };
}

function marketableContext(marketableResiduals: readonly JsonObject[]): Sim03fDiagnosisReport['marketable_context'] {
  const failed = marketableResiduals.filter((bucket) => bucket.status === 'fail');
  const insufficient = marketableResiduals.filter((bucket) => bucket.status === 'insufficient_sample');
  return {
    total_buckets: marketableResiduals.length,
    failed_buckets: failed.length,
    insufficient_sample_buckets: insufficient.length,
    failed_bucket_ids: failed.map((bucket) => maybeString(bucket.bucket_id) ?? 'unknown').sort(),
  };
}

function requireBucket(buckets: readonly JsonObject[], bucketId: string): JsonObject {
  const bucket = buckets.find((candidate) => candidate.bucket_id === bucketId);
  if (bucket === undefined) {
    throw new Error(`limit_queue bucket not found: ${bucketId}`);
  }
  return bucket;
}

function parseJsonObject(text: string, path: string): JsonObject {
  const value = JSON.parse(text) as unknown;
  if (!isJsonObject(value)) {
    throw new Error(`expected JSON object in ${path}`);
  }
  return value;
}

function objectPath(root: JsonObject, path: readonly string[]): JsonObject {
  const current = valuePath(root, path);
  if (!isJsonObject(current)) {
    throw new Error(`expected object at ${path.join('.')}`);
  }
  return current;
}

function valuePath(root: JsonObject, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isJsonObject(current)) {
      throw new Error(`expected object at ${path.join('.')}`);
    }
    current = current[segment];
  }
  return current;
}

function optionalObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

function arrayOfObjects(value: unknown, label: string): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected array at ${label}`);
  }
  return value.map((item, index) => {
    if (!isJsonObject(item)) {
      throw new Error(`expected object at ${label}[${index}]`);
    }
    return item;
  });
}

function boolRecord(value: unknown): Record<string, boolean> {
  if (!isJsonObject(value)) {
    return {};
  }
  const entries = Object.entries(value)
    .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string').sort();
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function maybeString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function maybeBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireArgValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function formatNumber(value: number | null): string {
  return value === null ? 'n/a' : String(value);
}

function usage(): string {
  return [
    'Usage: npm run sim:03f:diagnose-limit-front -- --report path [--out path]',
    '',
    'Diagnoses the SIM-03 limit_queue:front failure without changing calibration outputs.',
    '',
  ].join('\n');
}

function main(): void {
  try {
    const options = parseDiagnoseLimitQueueFrontArgs(processArgv.slice(2));
    const report = diagnoseLimitQueueFront(options);
    writeDiagnosisReport(report, options.out ?? DEFAULT_OUT_PATH, options.cwd);
    processStdout.write(`SIM-03F diagnosis: ${report.likely_failure_class}\n`);
    processStdout.write(`report=${resolve(options.cwd ?? process.cwd(), options.out ?? DEFAULT_OUT_PATH)}\n`);
    processExit(0);
  } catch (error) {
    processStderr.write(`SIM-03F diagnosis failed: ${errorMessage(error)}\n`);
    processExit(1);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (processArgv[1] !== undefined && resolve(processArgv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
