import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  argv as processArgv,
  exit as processExit,
  stderr as processStderr,
  stdout as processStdout,
} from 'node:process';
import { fileURLToPath } from 'node:url';

export const SIM_03G_RECALIBRATION_REPORT_SCHEMA_VERSION = 1 as const;
export const SIM_03G_TICKET_ID = 'SIM-03G' as const;

const TARGET_BUCKET_ID = 'front';
const TARGET_METRIC = 'time_to_fill_relative_error_within_time_to_fill_relative_threshold';
const VALIDATOR_SCRIPT = 'scripts/sim/validate-fill-slippage-calibration.py';
const DEFAULT_OUT_PATH = 'reports/sim/fill_slippage_calibration_recalibrated.json';
const DEFAULT_PATCH_REPORT_PATH = 'reports/sim/limit_queue_front_recalibration_patch.json';

export interface RecalibrateLimitQueueFrontOptions {
  readonly cwd?: string;
  readonly calibration_report: string;
  readonly diagnosis_report: string;
  readonly out?: string;
  readonly patch_report?: string;
  readonly generated_at_ts_ns?: string;
  readonly gate_out?: string;
  readonly checked_at_ts_ns?: string;
  readonly python?: string;
}

export interface RecalibrationResult {
  readonly recalibrated_report: JsonObject;
  readonly patch_report: Sim03gPatchReport;
  readonly exit_code: 0 | 2;
}

export interface Sim03gPatchReport {
  readonly sim03g_recalibration_report_schema_version: typeof SIM_03G_RECALIBRATION_REPORT_SCHEMA_VERSION;
  readonly ticket_id: typeof SIM_03G_TICKET_ID;
  readonly status: 'recalibrated' | 'requires_targeted_bucket_rerun';
  readonly target_bucket: 'limit_queue:front';
  readonly target_metric: typeof TARGET_METRIC;
  readonly source_report_hash: string;
  readonly diagnosis_report_hash: string;
  readonly generated_at_ts_ns?: string;
  readonly old_value: number | null;
  readonly new_value: number | null;
  readonly threshold: number | null;
  readonly method: string;
  readonly changed_fields: readonly string[];
  readonly unchanged_bucket_count: number;
  readonly aggregate_only_recalibration_possible: boolean;
  readonly rerun_requirement?: {
    readonly reason: string;
    readonly instructions: readonly string[];
  };
  readonly sim03d_gate: {
    readonly status: 'not_run' | 'pass' | 'fail' | 'error';
    readonly exit_code: number | null;
    readonly report_path?: string;
    readonly ready_for_rel01_execution_simulation?: boolean;
    readonly failure_reasons?: readonly string[];
    readonly error?: string;
  };
  readonly scope_note: string;
}

interface RecalibrationInput {
  readonly method: string;
  readonly modeled_time_to_fill_median_ms: number;
  readonly time_to_fill_relative_error: number;
  readonly evidence: string;
}

type JsonObject = Record<string, unknown>;

export function recalibrateLimitQueueFront(options: RecalibrateLimitQueueFrontOptions): RecalibrationResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const calibrationPath = resolve(cwd, options.calibration_report);
  const diagnosisPath = resolve(cwd, options.diagnosis_report);
  const calibrationText = readFileSync(calibrationPath, 'utf8');
  const diagnosisText = readFileSync(diagnosisPath, 'utf8');
  const calibrationReport = parseJsonObject(calibrationText, calibrationPath);
  const diagnosisReport = parseJsonObject(diagnosisText, diagnosisPath);

  validateDiagnosis(diagnosisReport);
  const sourceReportHash = sha256Text(calibrationText);
  const diagnosisReportHash = sha256Text(diagnosisText);
  const recalibratedReport = cloneJsonObject(calibrationReport);
  const target = requireTargetResidual(recalibratedReport);
  const oldValue = numberValue(target.time_to_fill_relative_error);
  const threshold = numberValue(target.time_to_fill_relative_threshold);
  const unchangedBucketCount = countUnchangedBuckets(recalibratedReport);
  const recalibrationInput = targetedRecalibrationInput(calibrationReport);

  let patchReport: Sim03gPatchReport;
  if (recalibrationInput === null) {
    const changedFields = attachMetadata(recalibratedReport, {
      status: 'requires_targeted_bucket_rerun',
      sourceReportHash,
      diagnosisReportHash,
      generatedAtTsNs: options.generated_at_ts_ns,
      changedFields: [],
      oldValue,
      newValue: null,
      threshold,
      method: 'targeted_bucket_rerun_required',
    });
    patchReport = {
      sim03g_recalibration_report_schema_version: SIM_03G_RECALIBRATION_REPORT_SCHEMA_VERSION,
      ticket_id: SIM_03G_TICKET_ID,
      status: 'requires_targeted_bucket_rerun',
      target_bucket: 'limit_queue:front',
      target_metric: TARGET_METRIC,
      source_report_hash: sourceReportHash,
      diagnosis_report_hash: diagnosisReportHash,
      ...(options.generated_at_ts_ns === undefined ? {} : { generated_at_ts_ns: options.generated_at_ts_ns }),
      old_value: oldValue,
      new_value: null,
      threshold,
      method: 'targeted_bucket_rerun_required',
      changed_fields: changedFields,
      unchanged_bucket_count: unchangedBucketCount,
      aggregate_only_recalibration_possible: false,
      rerun_requirement: {
        reason: 'The SIM-03 report contains only point residuals, not the front-bucket calibration distribution needed to refit time-to-fill without validation leakage.',
        instructions: [
          'Use SIM-03C checkpoint/progress support to rerun or resume only the limit_queue:front time-to-fill aggregate path.',
          'Produce calibration-split front time-to-fill fitted constants without using validation empirical medians as fit targets.',
          'Re-run SIM-03D against the resulting recalibrated report before unblocking REL-01.',
        ],
      },
      sim03d_gate: {
        status: 'not_run',
        exit_code: null,
      },
      scope_note: scopeNote(),
    };
    return {
      recalibrated_report: recalibratedReport,
      patch_report: patchReport,
      exit_code: 2,
    };
  }

  const changedFields = applyTargetedRecalibration(recalibratedReport, recalibrationInput);
  attachMetadata(recalibratedReport, {
    status: 'recalibrated',
    sourceReportHash,
    diagnosisReportHash,
    generatedAtTsNs: options.generated_at_ts_ns,
    changedFields,
    oldValue,
    newValue: recalibrationInput.time_to_fill_relative_error,
    threshold,
    method: recalibrationInput.method,
  });
  patchReport = {
    sim03g_recalibration_report_schema_version: SIM_03G_RECALIBRATION_REPORT_SCHEMA_VERSION,
    ticket_id: SIM_03G_TICKET_ID,
    status: 'recalibrated',
    target_bucket: 'limit_queue:front',
    target_metric: TARGET_METRIC,
    source_report_hash: sourceReportHash,
    diagnosis_report_hash: diagnosisReportHash,
    ...(options.generated_at_ts_ns === undefined ? {} : { generated_at_ts_ns: options.generated_at_ts_ns }),
    old_value: oldValue,
    new_value: recalibrationInput.time_to_fill_relative_error,
    threshold,
    method: recalibrationInput.method,
    changed_fields: changedFields,
    unchanged_bucket_count: unchangedBucketCount,
    aggregate_only_recalibration_possible: true,
    sim03d_gate: {
      status: 'not_run',
      exit_code: null,
    },
    scope_note: scopeNote(),
  };
  return {
    recalibrated_report: recalibratedReport,
    patch_report: patchReport,
    exit_code: 0,
  };
}

export function writeRecalibrationOutputs(
  result: RecalibrationResult,
  options: RecalibrateLimitQueueFrontOptions,
): Sim03gPatchReport {
  const cwd = resolve(options.cwd ?? process.cwd());
  const outPath = resolve(cwd, options.out ?? DEFAULT_OUT_PATH);
  const patchPath = resolve(cwd, options.patch_report ?? DEFAULT_PATCH_REPORT_PATH);
  mkdirSync(dirname(outPath), { recursive: true });
  mkdirSync(dirname(patchPath), { recursive: true });
  writeJson(outPath, result.recalibrated_report);

  let patchReport = result.patch_report;
  if (options.gate_out !== undefined) {
    patchReport = {
      ...patchReport,
      sim03d_gate: runSim03dGate({
        cwd,
        reportPath: outPath,
        gateOutPath: resolve(cwd, options.gate_out),
        checkedAtTsNs: requireCheckedAtTsNs(options.checked_at_ts_ns),
        python: options.python ?? 'python',
      }),
    };
  }
  writeJson(patchPath, patchReport as unknown as JsonObject);
  return patchReport;
}

export function parseRecalibrateLimitQueueFrontArgs(args: readonly string[]): RecalibrateLimitQueueFrontOptions {
  const options: {
    calibration_report?: string;
    diagnosis_report?: string;
    out?: string;
    patch_report?: string;
    generated_at_ts_ns?: string;
    gate_out?: string;
    checked_at_ts_ns?: string;
  } = {};
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
      case '--out':
        index += 1;
        options.out = requireArgValue(flag, args[index]);
        break;
      case '--patch-report':
        index += 1;
        options.patch_report = requireArgValue(flag, args[index]);
        break;
      case '--generated-at-ts-ns':
        index += 1;
        options.generated_at_ts_ns = requireArgValue(flag, args[index]);
        break;
      case '--gate-out':
        index += 1;
        options.gate_out = requireArgValue(flag, args[index]);
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
  if (options.calibration_report === undefined) {
    throw new Error('--calibration-report is required');
  }
  if (options.diagnosis_report === undefined) {
    throw new Error('--diagnosis-report is required');
  }
  return options as RecalibrateLimitQueueFrontOptions;
}

function targetedRecalibrationInput(report: JsonObject): RecalibrationInput | null {
  const input = optionalObject(valueAt(report, ['targeted_recalibration_inputs', 'limit_queue_front_time_to_fill']));
  const method = maybeString(input.method);
  const modeled = numberValue(input.modeled_time_to_fill_median_ms);
  const error = numberValue(input.time_to_fill_relative_error);
  const evidence = maybeString(input.evidence);
  if (method === null || modeled === null || error === null || evidence === null) {
    return null;
  }
  if (method !== 'targeted_bucket_refit_from_calibration_observations') {
    return null;
  }
  return {
    method,
    modeled_time_to_fill_median_ms: modeled,
    time_to_fill_relative_error: error,
    evidence,
  };
}

function applyTargetedRecalibration(report: JsonObject, input: RecalibrationInput): readonly string[] {
  const changedFields: string[] = [];
  const target = requireTargetResidual(report);
  const threshold = numberValue(target.time_to_fill_relative_threshold);
  const passed = threshold !== null && input.time_to_fill_relative_error <= threshold;
  const constants = objectAt(report, ['fitted_constants', 'queue_fill_model', TARGET_BUCKET_ID]);

  setIfChanged(constants, 'median_time_to_fill_ms', input.modeled_time_to_fill_median_ms, 'fitted_constants.queue_fill_model.front.median_time_to_fill_ms', changedFields);
  setIfChanged(target, 'modeled_time_to_fill_median_ms', input.modeled_time_to_fill_median_ms, 'residuals.limit_queue.front.modeled_time_to_fill_median_ms', changedFields);
  setIfChanged(target, 'time_to_fill_relative_error', input.time_to_fill_relative_error, 'residuals.limit_queue.front.time_to_fill_relative_error', changedFields);

  const checks = objectAt(target, ['checks']);
  setIfChanged(checks, 'time_to_fill_pass', passed, 'residuals.limit_queue.front.checks.time_to_fill_pass', changedFields);
  const currentReasons = stringArray(target.failure_reasons);
  const nextReasons = passed ? currentReasons.filter((reason) => reason !== 'time_to_fill_pass') : sortedUnique([...currentReasons, 'time_to_fill_pass']);
  setIfChanged(target, 'failure_reasons', nextReasons, 'residuals.limit_queue.front.failure_reasons', changedFields);
  setIfChanged(target, 'status', nextReasons.length === 0 ? 'pass' : 'fail', 'residuals.limit_queue.front.status', changedFields);

  refreshTopLevelStatus(report, changedFields);
  return changedFields;
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

function attachMetadata(
  report: JsonObject,
  metadata: {
    readonly status: 'recalibrated' | 'requires_targeted_bucket_rerun';
    readonly sourceReportHash: string;
    readonly diagnosisReportHash: string;
    readonly generatedAtTsNs?: string;
    readonly changedFields: readonly string[];
    readonly oldValue: number | null;
    readonly newValue: number | null;
    readonly threshold: number | null;
    readonly method: string;
  },
): readonly string[] {
  const payload: JsonObject = {
    sim03g_recalibration_metadata_schema_version: SIM_03G_RECALIBRATION_REPORT_SCHEMA_VERSION,
    ticket_id: SIM_03G_TICKET_ID,
    status: metadata.status,
    source_report_hash: metadata.sourceReportHash,
    diagnosis_report_hash: metadata.diagnosisReportHash,
    target_bucket: 'limit_queue:front',
    target_metric: TARGET_METRIC,
    old_value: metadata.oldValue,
    new_value: metadata.newValue,
    threshold: metadata.threshold,
    method: metadata.method,
    changed_fields: [...metadata.changedFields],
    scope_note: scopeNote(),
  };
  if (metadata.generatedAtTsNs !== undefined) {
    payload.generated_at_ts_ns = metadata.generatedAtTsNs;
  }
  report.recalibration_metadata = payload;
  return ['recalibration_metadata'];
}

function runSim03dGate(input: {
  readonly cwd: string;
  readonly reportPath: string;
  readonly gateOutPath: string;
  readonly checkedAtTsNs: string;
  readonly python: string;
}): Sim03gPatchReport['sim03d_gate'] {
  mkdirSync(dirname(input.gateOutPath), { recursive: true });
  const result = spawnSync(
    input.python,
    [
      VALIDATOR_SCRIPT,
      '--report',
      input.reportPath,
      '--checked-at-ts-ns',
      input.checkedAtTsNs,
      '--out',
      input.gateOutPath,
    ],
    { cwd: input.cwd, encoding: 'utf8' },
  );
  if (result.status !== 0 && result.status !== 2) {
    return {
      status: 'error',
      exit_code: result.status,
      report_path: input.gateOutPath,
      error: `${result.stderr}${result.stdout}`.trim(),
    };
  }
  const gate = parseJsonObject(readFileSync(input.gateOutPath, 'utf8'), input.gateOutPath);
  return {
    status: gate.status === 'pass' ? 'pass' : 'fail',
    exit_code: result.status,
    report_path: input.gateOutPath,
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

function optionalObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
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
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function requireCheckedAtTsNs(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error('--checked-at-ts-ns is required when --gate-out is provided');
  }
  return value;
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

function scopeNote(): string {
  return 'SIM-03G is a targeted limit_queue:front time-to-fill recalibration tool. It does not change global thresholds, passing buckets, marketable slippage, no-fill policy, or REL gates.';
}

function usage(): string {
  return [
    'Usage: npm run sim:03g:recalibrate-front -- --calibration-report path --diagnosis-report path [--out path] [--patch-report path]',
    '',
    'Optionally add --gate-out path --checked-at-ts-ns ns to run SIM-03D against the output report.',
    '',
  ].join('\n');
}

function main(): void {
  try {
    const options = parseRecalibrateLimitQueueFrontArgs(processArgv.slice(2));
    const result = recalibrateLimitQueueFront(options);
    const patchReport = writeRecalibrationOutputs(result, options);
    processStdout.write(`SIM-03G status: ${patchReport.status}\n`);
    processStdout.write(`aggregate_only_recalibration_possible=${patchReport.aggregate_only_recalibration_possible}\n`);
    processStdout.write(`patch_report=${resolve(options.cwd ?? process.cwd(), options.patch_report ?? DEFAULT_PATCH_REPORT_PATH)}\n`);
    const gateFailed = options.gate_out !== undefined && patchReport.sim03d_gate.status !== 'pass';
    processExit(gateFailed ? 2 : result.exit_code);
  } catch (error) {
    processStderr.write(`SIM-03G recalibration failed: ${errorMessage(error)}\n`);
    processExit(1);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (processArgv[1] !== undefined && resolve(processArgv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
