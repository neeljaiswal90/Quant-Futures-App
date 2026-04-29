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
  LIMIT_QUEUE_FRONT_TARGET_METRIC as TARGET_METRIC,
  type JsonObject,
  isJsonObject,
  validateLimitQueueFrontObservation,
} from './limit-queue-front-observation-schema.js';
import { forEachJsonlLine } from './streaming-jsonl.js';

export const SIM_03L_ROBUST_REFIT_REPORT_SCHEMA_VERSION = 1 as const;
export const SIM_03L_TICKET_ID = 'SIM-03L' as const;
const VALIDATOR_SCRIPT = 'scripts/sim/validate-fill-slippage-calibration.py';
const DEFAULT_OUT_PATH = 'reports/sim/fill_slippage_calibration_robust_limit_queue_front.json';
const DEFAULT_PATCH_REPORT_PATH = 'reports/sim/limit_queue_front_robust_refit_report.json';
const ROBUST_REFIT_METHOD = 'front_bucket_10_90_trimmed_mean_with_tail_audit' as const;
const REQUIRED_ANALYSIS_CLASSIFICATION = 'heavy_tail_metric_sensitivity';
const TIME_TO_FILL_FAILURE_REASON = 'time_to_fill_pass';
const LOWER_TRIM_FRACTION = 0.10;
const UPPER_TRIM_FRACTION = 0.90;
const DEFAULT_TAIL_RATIO_TOLERANCE = 1.25;

export interface RobustLimitQueueFrontOptions {
  readonly cwd?: string;
  readonly calibration_report: string;
  readonly diagnosis_report: string;
  readonly observations: string;
  readonly analysis_report: string;
  readonly out?: string;
  readonly patch_report?: string;
  readonly checked_at_ts_ns: string;
  readonly python?: string;
}

export interface Sim03lRobustRefitResult {
  readonly output_report: JsonObject;
  readonly patch_report: Sim03lPatchReport;
  readonly gate_report_path: string;
  readonly exit_code: 0 | 2;
}

export interface Sim03lPatchReport {
  readonly sim03l_robust_refit_report_schema_version: typeof SIM_03L_ROBUST_REFIT_REPORT_SCHEMA_VERSION;
  readonly ticket_id: typeof SIM_03L_TICKET_ID;
  readonly status: 'robust_refit_passed' | 'robust_refit_failed' | 'tail_audit_failed' | 'requires_targeted_observation_export';
  readonly source_calibration_report_hash: string;
  readonly source_diagnosis_report_hash: string;
  readonly source_analysis_report_hash: string;
  readonly observations_hash: string | null;
  readonly target_bucket: typeof TARGET_BUCKET;
  readonly target_metric: typeof TARGET_METRIC;
  readonly old_metric_value: number | null;
  readonly new_metric_value: number | null;
  readonly threshold: number | null;
  readonly method: typeof ROBUST_REFIT_METHOD | 'targeted_observation_export_required';
  readonly trim_policy: {
    readonly lower_fraction: typeof LOWER_TRIM_FRACTION;
    readonly upper_fraction: typeof UPPER_TRIM_FRACTION;
  };
  readonly changed_fields: readonly string[];
  readonly unchanged_bucket_count: number;
  readonly checked_at_ts_ns: string;
  readonly observation_summary: RobustObservationSummary | null;
  readonly tail_audit: TailAuditReport | null;
  readonly sim03d_gate: Sim03dGateResult;
  readonly required_observation_export?: {
    readonly reason: string;
    readonly instructions: readonly string[];
  };
  readonly scope_note: string;
}

export interface RobustObservationSummary {
  readonly path: string;
  readonly total_records: number;
  readonly calibration_records: number;
  readonly validation_records: number;
  readonly calibration_filled_records: number;
  readonly validation_filled_records: number;
  readonly calibration_median_ms: number;
  readonly validation_median_ms: number;
  readonly calibration_trimmed_mean_ms: number;
  readonly validation_trimmed_mean_ms: number;
  readonly median_relative_error: number;
  readonly robust_time_to_fill_relative_error: number;
  readonly calibration_trimmed_count: number;
  readonly validation_trimmed_count: number;
  readonly calibration_trimmed_low_count: number;
  readonly validation_trimmed_low_count: number;
  readonly calibration_trimmed_high_count: number;
  readonly validation_trimmed_high_count: number;
}

export interface TailAuditReport {
  readonly status: 'pass' | 'fail';
  readonly tail_ratio_tolerance: number;
  readonly calibration: TailStats;
  readonly validation: TailStats;
  readonly validation_calibration_p95_ratio: number | null;
  readonly validation_calibration_p99_ratio: number | null;
  readonly validation_tail_share_above_calibration_p95: number | null;
  readonly failure_reasons: readonly string[];
  readonly notes: readonly string[];
}

export interface TailStats {
  readonly count: number;
  readonly p50: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly p95_p50_ratio: number;
  readonly p99_p50_ratio: number;
  readonly trimmed_low_count: number;
  readonly trimmed_high_count: number;
  readonly trimmed_high_share: number;
}

export interface Sim03dGateResult {
  readonly status: 'pass' | 'fail' | 'error';
  readonly exit_code: number | null;
  readonly report_path: string;
  readonly ready_for_rel01_execution_simulation?: boolean;
  readonly failure_reasons?: readonly string[];
  readonly error?: string;
}

type MutableOptions = {
  -readonly [Key in keyof RobustLimitQueueFrontOptions]?: RobustLimitQueueFrontOptions[Key];
};

export function refitLimitQueueFrontRobust(options: RobustLimitQueueFrontOptions): Sim03lRobustRefitResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const calibrationPath = resolve(cwd, options.calibration_report);
  const diagnosisPath = resolve(cwd, options.diagnosis_report);
  const analysisPath = resolve(cwd, options.analysis_report);
  const observationsPath = resolve(cwd, options.observations);
  const outPath = resolve(cwd, options.out ?? DEFAULT_OUT_PATH);
  const patchPath = resolve(cwd, options.patch_report ?? DEFAULT_PATCH_REPORT_PATH);
  const gatePath = defaultGatePath(outPath);

  const sourceText = readFileSync(calibrationPath, 'utf8');
  const diagnosisText = readFileSync(diagnosisPath, 'utf8');
  const analysisText = readFileSync(analysisPath, 'utf8');
  const sourceReportHash = sha256Text(sourceText);
  const diagnosisReportHash = sha256Text(diagnosisText);
  const analysisReportHash = sha256Text(analysisText);
  const sourceReport = parseJsonObject(sourceText, calibrationPath);
  const diagnosisReport = parseJsonObject(diagnosisText, diagnosisPath);
  const analysisReport = parseJsonObject(analysisText, analysisPath);
  validateDiagnosis(diagnosisReport);
  validateAnalysis(analysisReport, { sourceReportHash });

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
      analysisReportHash,
      observationsHash: null,
      checkedAtTsNs: options.checked_at_ts_ns,
      oldMetric,
      newMetric: null,
      threshold,
      changedFields: [],
      method: 'targeted_observation_export_required',
      tailAudit: null,
    });
    writeJson(outPath, outputReport);
    const gate = runSim03dGate({ cwd, reportPath: outPath, gatePath, checkedAtTsNs: options.checked_at_ts_ns, python: options.python ?? 'python' });
    const patch = patchReport({
      status: 'requires_targeted_observation_export',
      sourceReportHash,
      diagnosisReportHash,
      analysisReportHash,
      observationsHash: null,
      checkedAtTsNs: options.checked_at_ts_ns,
      oldMetric,
      newMetric: null,
      threshold,
      changedFields: ['robust_refit_metadata'],
      unchangedBucketCount,
      observationSummary: null,
      tailAudit: null,
      gate,
      reason: `Observation file not found: ${observationsPath}`,
    });
    writeJson(patchPath, patch as unknown as JsonObject);
    return { output_report: outputReport, patch_report: patch, gate_report_path: gatePath, exit_code: 2 };
  }

  const scan = summarizeObservationFile(observationsPath, { observationsPath, sourceReportHash });
  const observationsHash = scan.observationsHash;
  const summary = scan.summary;
  if (summary === null) {
    attachMetadata(outputReport, {
      status: 'requires_targeted_observation_export',
      sourceReportHash,
      diagnosisReportHash,
      analysisReportHash,
      observationsHash,
      checkedAtTsNs: options.checked_at_ts_ns,
      oldMetric,
      newMetric: null,
      threshold,
      changedFields: [],
      method: 'targeted_observation_export_required',
      tailAudit: null,
    });
    writeJson(outPath, outputReport);
    const gate = runSim03dGate({ cwd, reportPath: outPath, gatePath, checkedAtTsNs: options.checked_at_ts_ns, python: options.python ?? 'python' });
    const patch = patchReport({
      status: 'requires_targeted_observation_export',
      sourceReportHash,
      diagnosisReportHash,
      analysisReportHash,
      observationsHash,
      checkedAtTsNs: options.checked_at_ts_ns,
      oldMetric,
      newMetric: null,
      threshold,
      changedFields: ['robust_refit_metadata'],
      unchangedBucketCount,
      observationSummary: null,
      tailAudit: null,
      gate,
      reason: 'Observation file did not include both calibration and validation filled front-bucket samples.',
    });
    writeJson(patchPath, patch as unknown as JsonObject);
    return { output_report: outputReport, patch_report: patch, gate_report_path: gatePath, exit_code: 2 };
  }

  const tailAudit = auditTailRisk(scan.calibrationFilled, scan.validationFilled);
  let changedFields: readonly string[] = [];
  if (tailAudit.status === 'pass') {
    changedFields = applyRobustRefit(outputReport, summary);
  }
  attachMetadata(outputReport, {
    status: tailAudit.status === 'pass' ? 'robust_refit_applied' : 'tail_audit_failed',
    sourceReportHash,
    diagnosisReportHash,
    analysisReportHash,
    observationsHash,
    checkedAtTsNs: options.checked_at_ts_ns,
    oldMetric,
    newMetric: tailAudit.status === 'pass' ? summary.robust_time_to_fill_relative_error : null,
    threshold,
    changedFields,
    method: ROBUST_REFIT_METHOD,
    tailAudit,
  });
  writeJson(outPath, outputReport);
  const gate = runSim03dGate({ cwd, reportPath: outPath, gatePath, checkedAtTsNs: options.checked_at_ts_ns, python: options.python ?? 'python' });
  const status = tailAudit.status === 'fail' ? 'tail_audit_failed' : gate.status === 'pass' ? 'robust_refit_passed' : 'robust_refit_failed';
  const patch = patchReport({
    status,
    sourceReportHash,
    diagnosisReportHash,
    analysisReportHash,
    observationsHash,
    checkedAtTsNs: options.checked_at_ts_ns,
    oldMetric,
    newMetric: tailAudit.status === 'pass' ? summary.robust_time_to_fill_relative_error : null,
    threshold,
    changedFields: [...changedFields, 'robust_refit_metadata'],
    unchangedBucketCount,
    observationSummary: summary,
    tailAudit,
    gate,
  });
  writeJson(patchPath, patch as unknown as JsonObject);
  return { output_report: outputReport, patch_report: patch, gate_report_path: gatePath, exit_code: gate.status === 'pass' ? 0 : 2 };
}

function summarizeObservationFile(
  path: string,
  context: { readonly observationsPath: string; readonly sourceReportHash: string },
): { readonly observationsHash: string; readonly summary: RobustObservationSummary | null; readonly calibrationFilled: readonly number[]; readonly validationFilled: readonly number[] } {
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
      const observation = validateLimitQueueFrontObservation(JSON.parse(line) as unknown, {
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
  const calibrationTrim = trimmedMeanStats(calibrationFilled);
  const validationTrim = trimmedMeanStats(validationFilled);
  if (calibrationMedian === null || validationMedian === null || calibrationTrim === null || validationTrim === null) {
    return { observationsHash, summary: null, calibrationFilled, validationFilled };
  }
  const robustError = Math.abs(calibrationTrim.mean - validationTrim.mean) / Math.max(1.0, validationTrim.mean);
  const medianError = Math.abs(calibrationMedian - validationMedian) / Math.max(1.0, validationMedian);
  return {
    observationsHash,
    calibrationFilled,
    validationFilled,
    summary: {
      path,
      total_records: totalRecords,
      calibration_records: calibrationRecords,
      validation_records: validationRecords,
      calibration_filled_records: calibrationFilled.length,
      validation_filled_records: validationFilled.length,
      calibration_median_ms: round6(calibrationMedian),
      validation_median_ms: round6(validationMedian),
      calibration_trimmed_mean_ms: round6(calibrationTrim.mean),
      validation_trimmed_mean_ms: round6(validationTrim.mean),
      median_relative_error: round6(medianError),
      robust_time_to_fill_relative_error: round6(robustError),
      calibration_trimmed_count: calibrationTrim.includedCount,
      validation_trimmed_count: validationTrim.includedCount,
      calibration_trimmed_low_count: calibrationTrim.lowCount,
      validation_trimmed_low_count: validationTrim.lowCount,
      calibration_trimmed_high_count: calibrationTrim.highCount,
      validation_trimmed_high_count: validationTrim.highCount,
    },
  };
}

function auditTailRisk(calibrationFilled: readonly number[], validationFilled: readonly number[]): TailAuditReport {
  const calibration = tailStats(calibrationFilled);
  const validation = tailStats(validationFilled);
  const p95Ratio = safeRatio(validation.p95, calibration.p95);
  const p99Ratio = safeRatio(validation.p99, calibration.p99);
  const validationShareAboveCalibrationP95 = shareAtOrAbove(validationFilled, calibration.p95);
  const failures: string[] = [];
  if (p95Ratio !== null && p95Ratio > DEFAULT_TAIL_RATIO_TOLERANCE) {
    failures.push('validation_p95_tail_exceeds_calibration_tolerance');
  }
  if (p99Ratio !== null && p99Ratio > DEFAULT_TAIL_RATIO_TOLERANCE) {
    failures.push('validation_p99_tail_exceeds_calibration_tolerance');
  }
  if (validationShareAboveCalibrationP95 !== null && validationShareAboveCalibrationP95 > 0.10) {
    failures.push('validation_tail_share_above_calibration_p95_exceeds_10_percent');
  }
  return {
    status: failures.length === 0 ? 'pass' : 'fail',
    tail_ratio_tolerance: DEFAULT_TAIL_RATIO_TOLERANCE,
    calibration,
    validation,
    validation_calibration_p95_ratio: nullableRound6(p95Ratio),
    validation_calibration_p99_ratio: nullableRound6(p99Ratio),
    validation_tail_share_above_calibration_p95: nullableRound6(validationShareAboveCalibrationP95),
    failure_reasons: failures,
    notes: [
      'The robust refit may pass only when validation tail percentiles and tail share are not worse than calibration by policy tolerances.',
      'Trimmed observations are audited here; SIM-03D remains the authoritative pass/fail gate.',
    ],
  };
}

function applyRobustRefit(report: JsonObject, summary: RobustObservationSummary): readonly string[] {
  const changedFields: string[] = [];
  const target = requireTargetResidual(report);
  const constants = objectAt(report, ['fitted_constants', 'queue_fill_model', TARGET_BUCKET_ID]);
  const threshold = numberValue(target.time_to_fill_relative_threshold);
  const passed = threshold !== null && summary.robust_time_to_fill_relative_error <= threshold;
  setIfChanged(constants, 'time_to_fill_statistic_method', ROBUST_REFIT_METHOD, 'fitted_constants.queue_fill_model.front.time_to_fill_statistic_method', changedFields);
  setIfChanged(constants, 'robust_time_to_fill_statistic_ms', summary.calibration_trimmed_mean_ms, 'fitted_constants.queue_fill_model.front.robust_time_to_fill_statistic_ms', changedFields);
  setIfChanged(target, 'time_to_fill_statistic_method', ROBUST_REFIT_METHOD, 'residuals.limit_queue.front.time_to_fill_statistic_method', changedFields);
  setIfChanged(target, 'modeled_time_to_fill_statistic_ms', summary.calibration_trimmed_mean_ms, 'residuals.limit_queue.front.modeled_time_to_fill_statistic_ms', changedFields);
  setIfChanged(target, 'empirical_time_to_fill_statistic_ms', summary.validation_trimmed_mean_ms, 'residuals.limit_queue.front.empirical_time_to_fill_statistic_ms', changedFields);
  setIfChanged(target, 'time_to_fill_relative_error', summary.robust_time_to_fill_relative_error, 'residuals.limit_queue.front.time_to_fill_relative_error', changedFields);
  const checks = objectAt(target, ['checks']);
  setIfChanged(checks, 'time_to_fill_pass', passed, 'residuals.limit_queue.front.checks.time_to_fill_pass', changedFields);
  const currentReasons = stringArray(target.failure_reasons);
  const nextReasons = passed ? currentReasons.filter((reason) => reason !== TIME_TO_FILL_FAILURE_REASON) : sortedUnique([...currentReasons, TIME_TO_FILL_FAILURE_REASON]);
  setIfChanged(target, 'failure_reasons', nextReasons, 'residuals.limit_queue.front.failure_reasons', changedFields);
  setIfChanged(target, 'status', nextReasons.length === 0 ? 'pass' : 'fail', 'residuals.limit_queue.front.status', changedFields);
  refreshTopLevelStatus(report, changedFields);
  return changedFields;
}

function attachMetadata(
  report: JsonObject,
  metadata: {
    readonly status: 'robust_refit_applied' | 'tail_audit_failed' | 'requires_targeted_observation_export';
    readonly sourceReportHash: string;
    readonly diagnosisReportHash: string;
    readonly analysisReportHash: string;
    readonly observationsHash: string | null;
    readonly checkedAtTsNs: string;
    readonly oldMetric: number | null;
    readonly newMetric: number | null;
    readonly threshold: number | null;
    readonly changedFields: readonly string[];
    readonly method: typeof ROBUST_REFIT_METHOD | 'targeted_observation_export_required';
    readonly tailAudit: TailAuditReport | null;
  },
): void {
  report.robust_refit_metadata = {
    sim03l_robust_refit_metadata_schema_version: SIM_03L_ROBUST_REFIT_REPORT_SCHEMA_VERSION,
    ticket_id: SIM_03L_TICKET_ID,
    status: metadata.status,
    source_calibration_report_hash: metadata.sourceReportHash,
    source_diagnosis_report_hash: metadata.diagnosisReportHash,
    source_analysis_report_hash: metadata.analysisReportHash,
    observations_hash: metadata.observationsHash,
    target_bucket: TARGET_BUCKET,
    target_metric: TARGET_METRIC,
    old_metric_value: metadata.oldMetric,
    new_metric_value: metadata.newMetric,
    threshold: metadata.threshold,
    method: metadata.method,
    trim_policy: { lower_fraction: LOWER_TRIM_FRACTION, upper_fraction: UPPER_TRIM_FRACTION },
    tail_audit_status: metadata.tailAudit?.status ?? null,
    changed_fields: [...metadata.changedFields],
    checked_at_ts_ns: metadata.checkedAtTsNs,
  };
}

function patchReport(input: {
  readonly status: Sim03lPatchReport['status'];
  readonly sourceReportHash: string;
  readonly diagnosisReportHash: string;
  readonly analysisReportHash: string;
  readonly observationsHash: string | null;
  readonly checkedAtTsNs: string;
  readonly oldMetric: number | null;
  readonly newMetric: number | null;
  readonly threshold: number | null;
  readonly changedFields: readonly string[];
  readonly unchangedBucketCount: number;
  readonly observationSummary: RobustObservationSummary | null;
  readonly tailAudit: TailAuditReport | null;
  readonly gate: Sim03dGateResult;
  readonly reason?: string;
}): Sim03lPatchReport {
  return {
    sim03l_robust_refit_report_schema_version: SIM_03L_ROBUST_REFIT_REPORT_SCHEMA_VERSION,
    ticket_id: SIM_03L_TICKET_ID,
    status: input.status,
    source_calibration_report_hash: input.sourceReportHash,
    source_diagnosis_report_hash: input.diagnosisReportHash,
    source_analysis_report_hash: input.analysisReportHash,
    observations_hash: input.observationsHash,
    target_bucket: TARGET_BUCKET,
    target_metric: TARGET_METRIC,
    old_metric_value: input.oldMetric,
    new_metric_value: input.newMetric,
    threshold: input.threshold,
    method: input.status === 'requires_targeted_observation_export' ? 'targeted_observation_export_required' : ROBUST_REFIT_METHOD,
    trim_policy: { lower_fraction: LOWER_TRIM_FRACTION, upper_fraction: UPPER_TRIM_FRACTION },
    changed_fields: [...input.changedFields].sort(),
    unchanged_bucket_count: input.unchangedBucketCount,
    checked_at_ts_ns: input.checkedAtTsNs,
    observation_summary: input.observationSummary,
    tail_audit: input.tailAudit,
    sim03d_gate: input.gate,
    ...(input.reason === undefined
      ? {}
      : {
          required_observation_export: {
            reason: input.reason,
            instructions: [
              'Run SIM-03I to export reports/sim/limit_queue_front_observations.jsonl from the verified SIM-03 corpus.',
              'Then rerun SIM-03L with --observations pointing at that JSONL file.',
            ],
          },
        }),
    scope_note: 'SIM-03L changes only limit_queue:front time-to-fill when a robust-statistic refit passes tail audit and SIM-03D. It does not change thresholds, passing buckets, or REL gates directly.',
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

function validateAnalysis(analysis: JsonObject, expected: { readonly sourceReportHash: string }): void {
  if (analysis.ticket_id !== 'SIM-03K') {
    throw new Error('analysis report ticket_id is not SIM-03K');
  }
  if (analysis.status !== 'analysis_only' || analysis.rel01_status !== 'blocked') {
    throw new Error('analysis report must be analysis_only with REL-01 blocked');
  }
  if (analysis.target_bucket !== TARGET_BUCKET || analysis.classification !== REQUIRED_ANALYSIS_CLASSIFICATION) {
    throw new Error(`analysis report must classify ${TARGET_BUCKET} as ${REQUIRED_ANALYSIS_CLASSIFICATION}`);
  }
  const sourceInputs = objectAt(analysis, ['source_inputs']);
  if (sourceInputs.calibration_report_hash !== expected.sourceReportHash) {
    throw new Error('analysis report source calibration hash does not match input calibration report');
  }
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

function runSim03dGate(input: { readonly cwd: string; readonly reportPath: string; readonly gatePath: string; readonly checkedAtTsNs: string; readonly python: string }): Sim03dGateResult {
  mkdirSync(dirname(input.gatePath), { recursive: true });
  const result = spawnSync(
    input.python,
    [VALIDATOR_SCRIPT, '--report', input.reportPath, '--checked-at-ts-ns', input.checkedAtTsNs, '--out', input.gatePath],
    { cwd: input.cwd, encoding: 'utf8' },
  );
  if (result.status !== 0 && result.status !== 2) {
    return { status: 'error', exit_code: result.status, report_path: input.gatePath, error: `${result.stderr}${result.stdout}`.trim() };
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

function tailStats(values: readonly number[]): TailStats {
  const sorted = sortedNumbers(values);
  const trim = trimmedMeanStats(sorted);
  if (sorted.length === 0 || trim === null) {
    throw new Error('tail audit requires non-empty filled observations');
  }
  const p50 = percentileSorted(sorted, 0.5);
  const p95 = percentileSorted(sorted, 0.95);
  const p99 = percentileSorted(sorted, 0.99);
  return {
    count: sorted.length,
    p50: round6(p50),
    p90: round6(percentileSorted(sorted, 0.9)),
    p95: round6(p95),
    p99: round6(p99),
    max: round6(sorted[sorted.length - 1] ?? 0),
    p95_p50_ratio: round6(p95 / Math.max(1.0, p50)),
    p99_p50_ratio: round6(p99 / Math.max(1.0, p50)),
    trimmed_low_count: trim.lowCount,
    trimmed_high_count: trim.highCount,
    trimmed_high_share: round6(trim.highCount / sorted.length),
  };
}

function trimmedMeanStats(values: readonly number[]): { readonly mean: number; readonly includedCount: number; readonly lowCount: number; readonly highCount: number } | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = sortedNumbers(values);
  const lower = Math.floor(sorted.length * LOWER_TRIM_FRACTION);
  const upper = Math.max(lower + 1, Math.ceil(sorted.length * UPPER_TRIM_FRACTION));
  const selected = sorted.slice(lower, upper);
  const mean = selected.reduce((sum, value) => sum + value, 0) / selected.length;
  return {
    mean,
    includedCount: selected.length,
    lowCount: lower,
    highCount: sorted.length - upper,
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return percentileSorted(sortedNumbers(values), 0.5);
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

function sortedNumbers(values: readonly number[]): readonly number[] {
  return [...values].sort((left, right) => left - right);
}

function shareAtOrAbove(values: readonly number[], threshold: number): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.filter((value) => value >= threshold).length / values.length;
}

function safeRatio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
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

export function parseRobustLimitQueueFrontArgs(args: readonly string[]): RobustLimitQueueFrontOptions {
  const options: MutableOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--calibration-report':
        options.calibration_report = requireArgValue(arg, args[++index]);
        break;
      case '--diagnosis-report':
        options.diagnosis_report = requireArgValue(arg, args[++index]);
        break;
      case '--analysis-report':
        options.analysis_report = requireArgValue(arg, args[++index]);
        break;
      case '--observations':
        options.observations = requireArgValue(arg, args[++index]);
        break;
      case '--out':
        options.out = requireArgValue(arg, args[++index]);
        break;
      case '--patch-report':
        options.patch_report = requireArgValue(arg, args[++index]);
        break;
      case '--checked-at-ts-ns':
        options.checked_at_ts_ns = requireArgValue(arg, args[++index]);
        break;
      case '--python':
        options.python = requireArgValue(arg, args[++index]);
        break;
      case '--help':
        processStdout.write(`${usage()}\n`);
        processExit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg ?? ''}`);
    }
  }
  for (const required of ['calibration_report', 'diagnosis_report', 'analysis_report', 'observations', 'checked_at_ts_ns'] as const) {
    if (options[required] === undefined) {
      throw new Error(`--${required.replaceAll('_', '-')} is required`);
    }
  }
  return options as RobustLimitQueueFrontOptions;
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

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function nullableRound6(value: number | null): number | null {
  return value === null ? null : round6(value);
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function usage(): string {
  return [
    'Usage: npm run sim:03l:robust-front-refit -- --calibration-report path --diagnosis-report path --analysis-report path --observations path --checked-at-ts-ns ns [--out path] [--patch-report path]',
    '',
    'Applies a robust 10-90 trimmed front-bucket time-to-fill refit only when SIM-03K classified the remaining failure as heavy_tail_metric_sensitivity and the tail audit passes.',
    '',
  ].join('\n');
}

function main(): void {
  try {
    const options = parseRobustLimitQueueFrontArgs(processArgv.slice(2));
    const result = refitLimitQueueFrontRobust(options);
    const cwd = resolve(options.cwd ?? process.cwd());
    processStdout.write(`SIM-03L status: ${result.patch_report.status}\n`);
    processStdout.write(`sim03d_gate=${result.patch_report.sim03d_gate.status}\n`);
    processStdout.write(`patch_report=${resolve(cwd, options.patch_report ?? DEFAULT_PATCH_REPORT_PATH)}\n`);
    processExit(result.exit_code);
  } catch (error) {
    processStderr.write(`SIM-03L robust refit failed: ${errorMessage(error)}\n`);
    processExit(1);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (processArgv[1] !== undefined && resolve(processArgv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
