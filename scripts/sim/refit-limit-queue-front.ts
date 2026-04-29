import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  argv as processArgv,
  exit as processExit,
  stderr as processStderr,
  stdout as processStdout,
} from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  LIMIT_QUEUE_FRONT_BUCKET as TARGET_BUCKET,
  LIMIT_QUEUE_FRONT_BUCKET_ID as TARGET_BUCKET_ID,
  LIMIT_QUEUE_FRONT_OBSERVATION_SCHEMA_VERSION as OBSERVATION_SCHEMA_VERSION,
  LIMIT_QUEUE_FRONT_TARGET_METRIC as TARGET_METRIC,
  type JsonObject,
  type LimitQueueFrontObservation,
  TARGETED_FRONT_REFIT_METHOD as REFIT_METHOD,
  observationSchemaExample,
  validateLimitQueueFrontObservation,
} from './limit-queue-front-observation-schema.js';
import { forEachJsonlLine } from './streaming-jsonl.js';

export const SIM_03H_REFIT_REPORT_SCHEMA_VERSION = 1 as const;
export const SIM_03H_TICKET_ID = 'SIM-03H' as const;
const TIME_TO_FILL_FAILURE_REASON = 'time_to_fill_pass';
const VALIDATOR_SCRIPT = 'scripts/sim/validate-fill-slippage-calibration.py';
const DEFAULT_OUT_PATH = 'reports/sim/fill_slippage_calibration_refit_limit_queue_front.json';
const DEFAULT_PATCH_REPORT_PATH = 'reports/sim/limit_queue_front_refit_report.json';

export interface RefitLimitQueueFrontOptions {
  readonly cwd?: string;
  readonly calibration_report: string;
  readonly diagnosis_report: string;
  readonly observations: string;
  readonly out?: string;
  readonly patch_report?: string;
  readonly checked_at_ts_ns: string;
  readonly python?: string;
}

export interface Sim03hRefitResult {
  readonly output_report: JsonObject;
  readonly patch_report: Sim03hPatchReport;
  readonly gate_report_path: string;
  readonly exit_code: 0 | 2;
}

export interface Sim03hPatchReport {
  readonly sim03h_refit_report_schema_version: typeof SIM_03H_REFIT_REPORT_SCHEMA_VERSION;
  readonly ticket_id: typeof SIM_03H_TICKET_ID;
  readonly status: 'refit_passed' | 'refit_failed' | 'requires_targeted_observation_export';
  readonly source_calibration_report_hash: string;
  readonly source_diagnosis_report_hash: string;
  readonly observations_hash: string | null;
  readonly target_bucket: typeof TARGET_BUCKET;
  readonly target_metric: typeof TARGET_METRIC;
  readonly old_metric_value: number | null;
  readonly new_metric_value: number | null;
  readonly threshold: number | null;
  readonly method: typeof REFIT_METHOD | 'targeted_observation_export_required';
  readonly changed_fields: readonly string[];
  readonly unchanged_bucket_count: number;
  readonly checked_at_ts_ns: string;
  readonly observation_summary: ObservationSummary | null;
  readonly sim03d_gate: Sim03dGateResult;
  readonly required_observation_export?: {
    readonly reason: string;
    readonly instructions: readonly string[];
    readonly observation_schema: JsonObject;
  };
  readonly scope_note: string;
}

export interface ObservationSummary {
  readonly path: string;
  readonly total_records: number;
  readonly calibration_records: number;
  readonly validation_records: number;
  readonly calibration_filled_records: number;
  readonly validation_filled_records: number;
  readonly calibration_time_to_fill_median_ms: number;
  readonly validation_time_to_fill_median_ms: number;
  readonly refit_time_to_fill_relative_error: number;
}

export interface Sim03dGateResult {
  readonly status: 'pass' | 'fail' | 'error';
  readonly exit_code: number | null;
  readonly report_path: string;
  readonly ready_for_rel01_execution_simulation?: boolean;
  readonly failure_reasons?: readonly string[];
  readonly error?: string;
}

type MutableRefitOptions = {
  -readonly [Key in keyof RefitLimitQueueFrontOptions]?: RefitLimitQueueFrontOptions[Key];
};

export function refitLimitQueueFront(options: RefitLimitQueueFrontOptions): Sim03hRefitResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const calibrationPath = resolve(cwd, options.calibration_report);
  const diagnosisPath = resolve(cwd, options.diagnosis_report);
  const observationsPath = resolve(cwd, options.observations);
  const outPath = resolve(cwd, options.out ?? DEFAULT_OUT_PATH);
  const patchPath = resolve(cwd, options.patch_report ?? DEFAULT_PATCH_REPORT_PATH);
  const gatePath = defaultGatePath(outPath);

  const sourceText = readFileSync(calibrationPath, 'utf8');
  const diagnosisText = readFileSync(diagnosisPath, 'utf8');
  const sourceReportHash = sha256Text(sourceText);
  const diagnosisReportHash = sha256Text(diagnosisText);
  const sourceReport = parseJsonObject(sourceText, calibrationPath);
  const diagnosisReport = parseJsonObject(diagnosisText, diagnosisPath);
  validateDiagnosis(diagnosisReport);

  const outputReport = cloneJsonObject(sourceReport);
  const target = requireTargetResidual(outputReport);
  const oldMetric = numberValue(target.time_to_fill_relative_error);
  const threshold = numberValue(target.time_to_fill_relative_threshold);
  const unchangedBucketCount = countUnchangedBuckets(outputReport);

  if (!existsSync(observationsPath)) {
    attachMetadata(outputReport, {
      status: 'requires_targeted_observation_export',
      sourceReportHash,
      diagnosisReportHash,
      observationsHash: null,
      checkedAtTsNs: options.checked_at_ts_ns,
      oldMetric,
      newMetric: null,
      threshold,
      changedFields: [],
      method: 'targeted_observation_export_required',
    });
    writeJson(outPath, outputReport);
    const gate = runSim03dGate({
      cwd,
      reportPath: outPath,
      gatePath,
      checkedAtTsNs: options.checked_at_ts_ns,
      python: options.python ?? 'python',
    });
    const patch = patchReport({
      status: 'requires_targeted_observation_export',
      sourceReportHash,
      diagnosisReportHash,
      observationsHash: null,
      checkedAtTsNs: options.checked_at_ts_ns,
      oldMetric,
      newMetric: null,
      threshold,
      changedFields: ['refit_metadata'],
      unchangedBucketCount,
      observationSummary: null,
      gate,
      reason: `Observation file not found: ${observationsPath}`,
    });
    writeJson(patchPath, patch as unknown as JsonObject);
    return {
      output_report: outputReport,
      patch_report: patch,
      gate_report_path: gatePath,
      exit_code: 2,
    };
  }

  const observationScan = summarizeObservationFile(observationsPath, {
    observationsPath,
    sourceReportHash,
  });
  const observationsHash = observationScan.observationsHash;
  const summary = observationScan.summary;

  if (summary === null) {
    attachMetadata(outputReport, {
      status: 'requires_targeted_observation_export',
      sourceReportHash,
      diagnosisReportHash,
      observationsHash,
      checkedAtTsNs: options.checked_at_ts_ns,
      oldMetric,
      newMetric: null,
      threshold,
      changedFields: [],
      method: 'targeted_observation_export_required',
    });
    writeJson(outPath, outputReport);
    const gate = runSim03dGate({
      cwd,
      reportPath: outPath,
      gatePath,
      checkedAtTsNs: options.checked_at_ts_ns,
      python: options.python ?? 'python',
    });
    const patch = patchReport({
      status: 'requires_targeted_observation_export',
      sourceReportHash,
      diagnosisReportHash,
      observationsHash,
      checkedAtTsNs: options.checked_at_ts_ns,
      oldMetric,
      newMetric: null,
      threshold,
      changedFields: ['refit_metadata'],
      unchangedBucketCount,
      observationSummary: null,
      gate,
      reason: 'Observation file did not include both calibration and validation filled front-bucket time-to-fill samples.',
    });
    writeJson(patchPath, patch as unknown as JsonObject);
    return {
      output_report: outputReport,
      patch_report: patch,
      gate_report_path: gatePath,
      exit_code: 2,
    };
  }

  const changedFields = applyRefit(outputReport, summary);
  attachMetadata(outputReport, {
    status: 'refit_applied',
    sourceReportHash,
    diagnosisReportHash,
    observationsHash,
    checkedAtTsNs: options.checked_at_ts_ns,
    oldMetric,
    newMetric: summary.refit_time_to_fill_relative_error,
    threshold,
    changedFields,
    method: REFIT_METHOD,
  });
  writeJson(outPath, outputReport);
  const gate = runSim03dGate({
    cwd,
    reportPath: outPath,
    gatePath,
    checkedAtTsNs: options.checked_at_ts_ns,
    python: options.python ?? 'python',
  });
  const status = gate.status === 'pass' ? 'refit_passed' : 'refit_failed';
  const patch = patchReport({
    status,
    sourceReportHash,
    diagnosisReportHash,
    observationsHash,
    checkedAtTsNs: options.checked_at_ts_ns,
    oldMetric,
    newMetric: summary.refit_time_to_fill_relative_error,
    threshold,
    changedFields,
    unchangedBucketCount,
    observationSummary: summary,
    gate,
  });
  writeJson(patchPath, patch as unknown as JsonObject);
  return {
    output_report: outputReport,
    patch_report: patch,
    gate_report_path: gatePath,
    exit_code: gate.status === 'pass' ? 0 : 2,
  };
}

export function parseRefitLimitQueueFrontArgs(args: readonly string[]): RefitLimitQueueFrontOptions {
  const options: MutableRefitOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    switch (flag) {
      case '--calibration-report':
        index += 1;
        options.calibration_report = requireArgValue(flag, args[index]);
        break;
      case '--diagnosis-report':
        index += 1;
        options.diagnosis_report = requireArgValue(flag, args[index]);
        break;
      case '--observations':
        index += 1;
        options.observations = requireArgValue(flag, args[index]);
        break;
      case '--out':
        index += 1;
        options.out = requireArgValue(flag, args[index]);
        break;
      case '--patch-report':
        index += 1;
        options.patch_report = requireArgValue(flag, args[index]);
        break;
      case '--checked-at-ts-ns':
        index += 1;
        options.checked_at_ts_ns = requireArgValue(flag, args[index]);
        break;
      case '--help':
        processStdout.write(usage());
        processExit(0);
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  for (const required of ['calibration_report', 'diagnosis_report', 'observations', 'checked_at_ts_ns'] as const) {
    if (options[required] === undefined) {
      throw new Error(`--${required.replaceAll('_', '-')} is required`);
    }
  }
  return options as RefitLimitQueueFrontOptions;
}

function applyRefit(report: JsonObject, summary: ObservationSummary): readonly string[] {
  const changedFields: string[] = [];
  const target = requireTargetResidual(report);
  const constants = objectAt(report, ['fitted_constants', 'queue_fill_model', TARGET_BUCKET_ID]);
  const threshold = numberValue(target.time_to_fill_relative_threshold);
  const passed = threshold !== null && summary.refit_time_to_fill_relative_error <= threshold;

  setIfChanged(constants, 'median_time_to_fill_ms', summary.calibration_time_to_fill_median_ms, 'fitted_constants.queue_fill_model.front.median_time_to_fill_ms', changedFields);
  setIfChanged(target, 'modeled_time_to_fill_median_ms', summary.calibration_time_to_fill_median_ms, 'residuals.limit_queue.front.modeled_time_to_fill_median_ms', changedFields);
  setIfChanged(target, 'empirical_time_to_fill_median_ms', summary.validation_time_to_fill_median_ms, 'residuals.limit_queue.front.empirical_time_to_fill_median_ms', changedFields);
  setIfChanged(target, 'time_to_fill_relative_error', summary.refit_time_to_fill_relative_error, 'residuals.limit_queue.front.time_to_fill_relative_error', changedFields);
  const checks = objectAt(target, ['checks']);
  setIfChanged(checks, 'time_to_fill_pass', passed, 'residuals.limit_queue.front.checks.time_to_fill_pass', changedFields);
  const currentReasons = stringArray(target.failure_reasons);
  const nextReasons = passed
    ? currentReasons.filter((reason) => reason !== TIME_TO_FILL_FAILURE_REASON)
    : sortedUnique([...currentReasons, TIME_TO_FILL_FAILURE_REASON]);
  setIfChanged(target, 'failure_reasons', nextReasons, 'residuals.limit_queue.front.failure_reasons', changedFields);
  setIfChanged(target, 'status', nextReasons.length === 0 ? 'pass' : 'fail', 'residuals.limit_queue.front.status', changedFields);
  refreshTopLevelStatus(report, changedFields);
  return changedFields;
}

function summarizeObservationFile(
  path: string,
  context: {
    readonly observationsPath: string;
    readonly sourceReportHash: string;
  },
): { readonly observationsHash: string; readonly summary: ObservationSummary | null } {
  const digest = createHash('sha256');
  const calibrationFilled: number[] = [];
  const validationFilled: number[] = [];
  let totalRecords = 0;
  let calibrationRecords = 0;
  let validationRecords = 0;
  let lineNumber = 0;

  forEachJsonlLine(
    path,
    (line) => {
      lineNumber += 1;
      if (line.trim() === '') {
        return;
      }
      const value = JSON.parse(line) as unknown;
      const observation = validateLimitQueueFrontObservation(value, {
        lineNumber,
        expectedSourceReportHash: context.sourceReportHash,
        sourceLabel: context.observationsPath,
      });
      totalRecords += 1;
      if (observation.split === 'calibration') {
        calibrationRecords += 1;
      } else {
        validationRecords += 1;
      }
      if (observation.fill_outcome === 'filled' && observation.observed_time_to_fill_ms !== null) {
        if (observation.split === 'calibration') {
          calibrationFilled.push(observation.observed_time_to_fill_ms as number);
        } else {
          validationFilled.push(observation.observed_time_to_fill_ms as number);
        }
      }
    },
    { digest },
  );

  const observationsHash = digest.digest('hex');
  const calibrationMedian = median(calibrationFilled);
  const validationMedian = median(validationFilled);
  if (calibrationMedian === null || validationMedian === null) {
    return { observationsHash, summary: null };
  }
  const relativeError = Math.abs(calibrationMedian - validationMedian) / Math.max(1.0, validationMedian);
  return {
    observationsHash,
    summary: {
      path,
      total_records: totalRecords,
      calibration_records: calibrationRecords,
      validation_records: validationRecords,
      calibration_filled_records: calibrationFilled.length,
      validation_filled_records: validationFilled.length,
      calibration_time_to_fill_median_ms: round6(calibrationMedian),
      validation_time_to_fill_median_ms: round6(validationMedian),
      refit_time_to_fill_relative_error: round6(relativeError),
    },
  };
}

function patchReport(input: {
  readonly status: Sim03hPatchReport['status'];
  readonly sourceReportHash: string;
  readonly diagnosisReportHash: string;
  readonly observationsHash: string | null;
  readonly checkedAtTsNs: string;
  readonly oldMetric: number | null;
  readonly newMetric: number | null;
  readonly threshold: number | null;
  readonly changedFields: readonly string[];
  readonly unchangedBucketCount: number;
  readonly observationSummary: ObservationSummary | null;
  readonly gate: Sim03dGateResult;
  readonly reason?: string;
}): Sim03hPatchReport {
  return {
    sim03h_refit_report_schema_version: SIM_03H_REFIT_REPORT_SCHEMA_VERSION,
    ticket_id: SIM_03H_TICKET_ID,
    status: input.status,
    source_calibration_report_hash: input.sourceReportHash,
    source_diagnosis_report_hash: input.diagnosisReportHash,
    observations_hash: input.observationsHash,
    target_bucket: TARGET_BUCKET,
    target_metric: TARGET_METRIC,
    old_metric_value: input.oldMetric,
    new_metric_value: input.newMetric,
    threshold: input.threshold,
    method: input.status === 'requires_targeted_observation_export' ? 'targeted_observation_export_required' : REFIT_METHOD,
    changed_fields: input.changedFields,
    unchanged_bucket_count: input.unchangedBucketCount,
    checked_at_ts_ns: input.checkedAtTsNs,
    observation_summary: input.observationSummary,
    sim03d_gate: input.gate,
    ...(input.status === 'requires_targeted_observation_export'
      ? {
          required_observation_export: {
            reason: input.reason ?? 'Targeted observations are unavailable or incomplete.',
            instructions: [
              'Export only limit_queue:front observations from the SIM-03C checkpoint/progress pipeline or a targeted corpus pass.',
              'Include calibration and validation splits with filled observed_time_to_fill_ms values.',
              'Preserve source_report_hash so SIM-03H can reject stale or mismatched observations.',
            ],
            observation_schema: observationSchemaExample(),
          },
        }
      : {}),
    scope_note: 'SIM-03H refits only limit_queue:front time-to-fill from targeted observations; it does not change global thresholds, passing buckets, marketable slippage, no-fill policy, or REL gates.',
  };
}

function attachMetadata(
  report: JsonObject,
  metadata: {
    readonly status: 'refit_applied' | 'requires_targeted_observation_export';
    readonly sourceReportHash: string;
    readonly diagnosisReportHash: string;
    readonly observationsHash: string | null;
    readonly checkedAtTsNs: string;
    readonly oldMetric: number | null;
    readonly newMetric: number | null;
    readonly threshold: number | null;
    readonly changedFields: readonly string[];
    readonly method: typeof REFIT_METHOD | 'targeted_observation_export_required';
  },
): void {
  report.refit_metadata = {
    sim03h_refit_metadata_schema_version: SIM_03H_REFIT_REPORT_SCHEMA_VERSION,
    ticket_id: SIM_03H_TICKET_ID,
    status: metadata.status,
    source_calibration_report_hash: metadata.sourceReportHash,
    source_diagnosis_report_hash: metadata.diagnosisReportHash,
    observations_hash: metadata.observationsHash,
    target_bucket: TARGET_BUCKET,
    target_metric: TARGET_METRIC,
    old_metric_value: metadata.oldMetric,
    new_metric_value: metadata.newMetric,
    threshold: metadata.threshold,
    method: metadata.method,
    changed_fields: [...metadata.changedFields],
    checked_at_ts_ns: metadata.checkedAtTsNs,
  };
}

function refreshTopLevelStatus(report: JsonObject, changedFields: string[]): void {
  const residualFailures = residualFailureReasons(report);
  setIfChanged(report, 'failure_reasons', residualFailures, 'failure_reasons', changedFields);
  const passed = residualFailures.length === 0;
  setIfChanged(report, 'status', passed ? 'pass' : 'fail', 'status', changedFields);
  setIfChanged(report, 'ready_for_rel01_execution_simulation', passed, 'ready_for_rel01_execution_simulation', changedFields);
}

function residualFailureReasons(report: JsonObject): readonly string[] {
  const residuals = objectAt(report, ['residuals']);
  const failures: string[] = [];
  for (const [group, idField] of [
    ['marketable_slippage', 'bucket_id'],
    ['limit_queue', 'bucket_id'],
    ['strategy_level_cost', 'strategy_id'],
  ] as const) {
    for (const residual of arrayOfObjects(residuals[group], `residuals.${group}`)) {
      const id = maybeString(residual[idField]) ?? 'unknown';
      if (residual.status === 'fail') {
        failures.push(`${group}:${id}:failed thresholds`);
      } else if (residual.status === 'insufficient_sample') {
        failures.push(`${group}:${id}:insufficient_sample`);
      }
    }
  }
  return failures.sort();
}

function runSim03dGate(input: {
  readonly cwd: string;
  readonly reportPath: string;
  readonly gatePath: string;
  readonly checkedAtTsNs: string;
  readonly python: string;
}): Sim03dGateResult {
  mkdirSync(dirname(input.gatePath), { recursive: true });
  const result = spawnSync(
    input.python,
    [
      VALIDATOR_SCRIPT,
      '--report',
      input.reportPath,
      '--checked-at-ts-ns',
      input.checkedAtTsNs,
      '--out',
      input.gatePath,
    ],
    { cwd: input.cwd, encoding: 'utf8' },
  );
  if (result.status !== 0 && result.status !== 2) {
    return {
      status: 'error',
      exit_code: result.status,
      report_path: input.gatePath,
      error: `${result.stderr}${result.stdout}`.trim(),
    };
  }
  const gate = parseJsonObject(readFileSync(input.gatePath, 'utf8'), input.gatePath);
  return {
    status: gate.status === 'pass' ? 'pass' : 'fail',
    exit_code: result.status,
    report_path: input.gatePath,
    ready_for_rel01_execution_simulation: gate.ready_for_rel01_execution_simulation === true,
    failure_reasons: stringArray(gate.failure_reasons),
  };
}

function validateDiagnosis(diagnosis: JsonObject): void {
  if (diagnosis.ticket_id !== 'SIM-03F') {
    throw new Error('diagnosis report ticket_id is not SIM-03F');
  }
  const target = objectAt(diagnosis, ['target_bucket']);
  if (target.group !== 'limit_queue' || target.bucket_id !== TARGET_BUCKET_ID) {
    throw new Error('diagnosis report does not target limit_queue:front');
  }
  const failed = arrayOfObjects(target.exact_failed_criteria, 'target_bucket.exact_failed_criteria');
  if (!failed.some((criterion) => criterion.name === TARGET_METRIC)) {
    throw new Error(`diagnosis report does not identify ${TARGET_METRIC}`);
  }
}

function requireTargetResidual(report: JsonObject): JsonObject {
  const residuals = objectAt(report, ['residuals']);
  const limit = arrayOfObjects(residuals.limit_queue, 'residuals.limit_queue');
  const target = limit.find((candidate) => candidate.bucket_id === TARGET_BUCKET_ID);
  if (target === undefined) {
    throw new Error('limit_queue:front residual not found');
  }
  return target;
}

function countUnchangedBuckets(report: JsonObject): number {
  const residuals = objectAt(report, ['residuals']);
  return [
    ...arrayOfObjects(residuals.marketable_slippage, 'residuals.marketable_slippage'),
    ...arrayOfObjects(residuals.limit_queue, 'residuals.limit_queue'),
    ...arrayOfObjects(residuals.strategy_level_cost, 'residuals.strategy_level_cost'),
  ].filter((bucket) => bucket.bucket_id !== TARGET_BUCKET_ID).length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }
  const left = sorted[middle - 1];
  const right = sorted[middle];
  return left === undefined || right === undefined ? null : (left + right) / 2;
}

function defaultGatePath(outPath: string): string {
  const extension = extname(outPath);
  const base = basename(outPath, extension);
  return join(dirname(outPath), `${base}_gate${extension || '.json'}`);
}

function setIfChanged(target: JsonObject, key: string, next: unknown, path: string, changedFields: string[]): void {
  if (JSON.stringify(target[key]) !== JSON.stringify(next)) {
    target[key] = next;
    changedFields.push(path);
  }
}

function objectAt(root: JsonObject, path: readonly string[]): JsonObject {
  const value = valueAt(root, path);
  if (!isJsonObject(value)) {
    throw new Error(`expected object at ${path.join('.')}`);
  }
  return value;
}

function valueAt(root: JsonObject, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isJsonObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
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

function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function parseJsonObject(text: string, path: string): JsonObject {
  const value = JSON.parse(text) as unknown;
  if (!isJsonObject(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return value;
}

function writeJson(path: string, payload: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function requireArgValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function maybeString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string').sort();
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function usage(): string {
  return [
    'Usage: npm run sim:03h:refit-front -- --calibration-report path --diagnosis-report path --observations path --checked-at-ts-ns ns [--out path] [--patch-report path]',
    '',
    'Refits only limit_queue:front time-to-fill from targeted calibration observations and validates with SIM-03D.',
    '',
  ].join('\n');
}

function main(): void {
  try {
    const options = parseRefitLimitQueueFrontArgs(processArgv.slice(2));
    const result = refitLimitQueueFront(options);
    const cwd = resolve(options.cwd ?? process.cwd());
    processStdout.write(`SIM-03H status: ${result.patch_report.status}\n`);
    processStdout.write(`sim03d_gate=${result.patch_report.sim03d_gate.status}\n`);
    processStdout.write(`patch_report=${resolve(cwd, options.patch_report ?? DEFAULT_PATCH_REPORT_PATH)}\n`);
    processExit(result.exit_code);
  } catch (error) {
    processStderr.write(`SIM-03H refit failed: ${errorMessage(error)}\n`);
    processExit(1);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (processArgv[1] !== undefined && resolve(processArgv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
