import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  recalibrateLimitQueueFront,
  writeRecalibrationOutputs,
} from '../../../../scripts/sim/recalibrate-limit-queue-front.js';

const PYTHON = process.env.PYTHON ?? 'python';
const CHECKED_AT_TS_NS = '1777399200000000000';
const GENERATED_AT_TS_NS = '1777399200000000000';
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-sim03g-recalibration-'));
  tempDirectories.push(directory);
  return directory;
}

describe('SIM-03G limit_queue:front recalibration', () => {
  it('emits requires_targeted_bucket_rerun when aggregate report detail is insufficient', () => {
    const result = runRecalibration({
      calibrationReport: baseCalibrationReport(),
      diagnosisReport: baseDiagnosisReport(),
    });

    expect(result.exitCode).toBe(2);
    expect(result.patchReport).toMatchObject({
      sim03g_recalibration_report_schema_version: 1,
      ticket_id: 'SIM-03G',
      status: 'requires_targeted_bucket_rerun',
      target_bucket: 'limit_queue:front',
      target_metric: 'time_to_fill_relative_error_within_time_to_fill_relative_threshold',
      old_value: 0.465225,
      new_value: null,
      threshold: 0.25,
      aggregate_only_recalibration_possible: false,
    });
    expect(result.outputReport.status).toBe('fail');
    expect(result.outputReport.ready_for_rel01_execution_simulation).toBe(false);
    expect(result.outputReport.residuals.limit_queue[0].time_to_fill_relative_error).toBe(0.465225);
  });

  it('changes only front time-to-fill fields plus top-level gate fields when targeted refit evidence is present', () => {
    const source = baseCalibrationReport({
      targetedRefit: {
        modeled_time_to_fill_median_ms: 3900,
        time_to_fill_relative_error: 0.072154,
      },
    });
    const result = runRecalibration({
      calibrationReport: source,
      diagnosisReport: baseDiagnosisReport(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.patchReport.status).toBe('recalibrated');
    expect(result.patchReport.aggregate_only_recalibration_possible).toBe(true);
    expect(result.patchReport.changed_fields).toEqual(
      expect.arrayContaining([
        'fitted_constants.queue_fill_model.front.median_time_to_fill_ms',
        'residuals.limit_queue.front.modeled_time_to_fill_median_ms',
        'residuals.limit_queue.front.time_to_fill_relative_error',
        'residuals.limit_queue.front.checks.time_to_fill_pass',
        'residuals.limit_queue.front.failure_reasons',
        'residuals.limit_queue.front.status',
        'failure_reasons',
        'status',
        'ready_for_rel01_execution_simulation',
      ]),
    );
    expect(result.outputReport.residuals.limit_queue[0]).toMatchObject({
      bucket_id: 'front',
      status: 'pass',
      modeled_time_to_fill_median_ms: 3900,
      time_to_fill_relative_error: 0.072154,
      checks: {
        fill_probability_pass: true,
        no_fill_rate_pass: true,
        time_to_fill_pass: true,
      },
      failure_reasons: [],
    });
    expect(result.outputReport.residuals.limit_queue[1]).toEqual(source.residuals.limit_queue[1]);
    expect(result.outputReport.residuals.limit_queue[2]).toEqual(source.residuals.limit_queue[2]);
    expect(result.outputReport.residuals.limit_queue[3]).toEqual(source.residuals.limit_queue[3]);
  });

  it('preserves thresholds and reports stable lineage hashes', () => {
    const source = baseCalibrationReport({
      targetedRefit: {
        modeled_time_to_fill_median_ms: 3900,
        time_to_fill_relative_error: 0.072154,
      },
    });
    const diagnosis = baseDiagnosisReport();
    const result = runRecalibration({ calibrationReport: source, diagnosisReport: diagnosis });

    expect(result.outputReport.residuals.limit_queue[0].time_to_fill_relative_threshold).toBe(0.25);
    expect(result.outputReport.residuals.limit_queue[0].fill_probability_threshold).toBe(0.1);
    expect(result.outputReport.residuals.limit_queue[0].no_fill_rate_threshold).toBe(0.1);
    expect(result.patchReport.source_report_hash).toBe(sha(JSON.stringify(source, null, 2)));
    expect(result.patchReport.diagnosis_report_hash).toBe(sha(JSON.stringify(diagnosis, null, 2)));
    expect(result.patchReport.generated_at_ts_ns).toBe(GENERATED_AT_TS_NS);
  });

  it('produces a SIM-03D passing synthetic corrected report when validation mode is enabled', () => {
    const result = runRecalibration({
      calibrationReport: baseCalibrationReport({
        targetedRefit: {
          modeled_time_to_fill_median_ms: 3900,
          time_to_fill_relative_error: 0.072154,
        },
      }),
      diagnosisReport: baseDiagnosisReport(),
      runGate: true,
    });

    expect(result.patchReport.sim03d_gate).toMatchObject({
      status: 'pass',
      exit_code: 0,
      ready_for_rel01_execution_simulation: true,
      failure_reasons: [],
    });
  });

  it('is deterministic for the same input reports and caller-provided timestamp', () => {
    const source = baseCalibrationReport({
      targetedRefit: {
        modeled_time_to_fill_median_ms: 3900,
        time_to_fill_relative_error: 0.072154,
      },
    });
    const first = runRecalibration({ calibrationReport: source, diagnosisReport: baseDiagnosisReport() });
    const second = runRecalibration({ calibrationReport: source, diagnosisReport: baseDiagnosisReport() });

    expect(readFileSync(first.outPath, 'utf8')).toBe(readFileSync(second.outPath, 'utf8'));
    expect(readFileSync(first.patchPath, 'utf8')).toBe(readFileSync(second.patchPath, 'utf8'));
  });

  it('exposes the npm script in package.json', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, any>;

    expect(packageJson.scripts['sim:03g:recalibrate-front']).toBe(
      'tsx scripts/sim/recalibrate-limit-queue-front.ts',
    );
  });
});

function runRecalibration(input: {
  readonly calibrationReport: Record<string, any>;
  readonly diagnosisReport: Record<string, any>;
  readonly runGate?: boolean;
}): {
  readonly exitCode: number;
  readonly outputReport: Record<string, any>;
  readonly patchReport: Record<string, any>;
  readonly outPath: string;
  readonly patchPath: string;
} {
  const directory = makeTempDir();
  mkdirSync(directory, { recursive: true });
  const calibrationPath = join(directory, 'fill_slippage_calibration.json');
  const diagnosisPath = join(directory, 'limit_queue_front_diagnosis.json');
  const outPath = join(directory, 'fill_slippage_calibration_recalibrated.json');
  const patchPath = join(directory, 'limit_queue_front_recalibration_patch.json');
  const gatePath = join(directory, 'fill_slippage_calibration_recalibrated_gate.json');
  writeFileSync(calibrationPath, JSON.stringify(input.calibrationReport, null, 2), 'utf8');
  writeFileSync(diagnosisPath, JSON.stringify(input.diagnosisReport, null, 2), 'utf8');

  const result = recalibrateLimitQueueFront({
    calibration_report: calibrationPath,
    diagnosis_report: diagnosisPath,
    out: outPath,
    patch_report: patchPath,
    generated_at_ts_ns: GENERATED_AT_TS_NS,
    ...(input.runGate === true ? { gate_out: gatePath, checked_at_ts_ns: CHECKED_AT_TS_NS, python: PYTHON } : {}),
  });
  writeRecalibrationOutputs(result, {
    calibration_report: calibrationPath,
    diagnosis_report: diagnosisPath,
    out: outPath,
    patch_report: patchPath,
    generated_at_ts_ns: GENERATED_AT_TS_NS,
    ...(input.runGate === true ? { gate_out: gatePath, checked_at_ts_ns: CHECKED_AT_TS_NS, python: PYTHON } : {}),
  });

  return {
    exitCode: result.exit_code,
    outputReport: JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, any>,
    patchReport: JSON.parse(readFileSync(patchPath, 'utf8')) as Record<string, any>,
    outPath,
    patchPath,
  };
}

function baseCalibrationReport(options: {
  readonly targetedRefit?: {
    readonly modeled_time_to_fill_median_ms: number;
    readonly time_to_fill_relative_error: number;
  };
} = {}): Record<string, any> {
  return {
    calibration_report_schema_version: 1,
    ticket_id: 'SIM-03',
    status: 'fail',
    ready_for_rel01_execution_simulation: false,
    inputs: {
      manifest_hash: sha('manifest'),
      verified_report_hash: sha('verified'),
      thresholds_config_hash: sha('thresholds'),
      verified_report_ready: true,
    },
    ...(options.targetedRefit === undefined ? {} : {
      targeted_recalibration_inputs: {
        limit_queue_front_time_to_fill: {
          method: 'targeted_bucket_refit_from_calibration_observations',
          modeled_time_to_fill_median_ms: options.targetedRefit.modeled_time_to_fill_median_ms,
          time_to_fill_relative_error: options.targetedRefit.time_to_fill_relative_error,
          evidence: 'synthetic calibration-only front bucket refit',
        },
      },
    }),
    fitted_constants: {
      queue_fill_model: {
        front: {
          fill_probability: 0.000379,
          no_fill_probability: 0.999621,
          median_time_to_fill_ms: 5329.796914,
          sample_count: 18_842_513,
        },
        near: {
          fill_probability: 0.000266,
          no_fill_probability: 0.999734,
          median_time_to_fill_ms: 11200,
          sample_count: 133_332_230,
        },
        middle: {
          fill_probability: 0.000696,
          no_fill_probability: 0.999304,
          median_time_to_fill_ms: 13800,
          sample_count: 145_068_685,
        },
        back: {
          fill_probability: 0.002877,
          no_fill_probability: 0.997123,
          median_time_to_fill_ms: 43700,
          sample_count: 5_577_960,
        },
      },
    },
    residuals: {
      marketable_slippage: [
        {
          bucket_id: 'order_type=marketable|side=buy',
          status: 'pass',
          calibration_sample_count: 20,
          validation_sample_count: 20,
          ks_statistic: 0.05,
          ks_threshold: 0.15,
          p50_residual: 0.02,
          p50_threshold: 0.0625,
          p90_residual: 0.03,
          p90_threshold: 0.125,
          adverse_p95_residual: 0.04,
          adverse_p95_threshold: 0.125,
        },
      ],
      limit_queue: [
        limitBucket({
          bucket_id: 'front',
          status: 'fail',
          calibration_sample_count: 18_842_513,
          validation_sample_count: 3_779_021,
          empirical_fill_probability: 0.000297,
          modeled_fill_probability: 0.000379,
          fill_probability_residual: 0.000082,
          empirical_no_fill_rate: 0.999703,
          modeled_no_fill_rate: 0.999621,
          no_fill_rate_residual: 0.000082,
          empirical_time_to_fill_median_ms: 3637.527295,
          modeled_time_to_fill_median_ms: 5329.796914,
          time_to_fill_relative_error: 0.465225,
          checks: {
            fill_probability_pass: true,
            no_fill_rate_pass: true,
            time_to_fill_pass: false,
          },
          failure_reasons: ['time_to_fill_pass'],
        }),
        limitBucket({ bucket_id: 'near', time_to_fill_relative_error: 0.171629 }),
        limitBucket({ bucket_id: 'middle', time_to_fill_relative_error: 0.007194 }),
        limitBucket({ bucket_id: 'back', time_to_fill_relative_error: 0.074721 }),
      ],
      strategy_level_cost: [
        {
          strategy_id: 'sim03_proxy_all',
          status: 'pass',
          calibration_sample_count: 20,
          validation_sample_count: 20,
          mean_residual: 0.01,
          threshold: 0.0625,
        },
      ],
    },
    insufficient_sample_buckets: [],
    failure_reasons: ['limit_queue:front:failed thresholds'],
  };
}

function baseDiagnosisReport(): Record<string, any> {
  return {
    sim03f_diagnosis_report_schema_version: 1,
    ticket_id: 'SIM-03F',
    status: 'diagnosed',
    target_bucket: {
      group: 'limit_queue',
      bucket_id: 'front',
      exact_failed_criteria: [
        {
          name: 'time_to_fill_relative_error_within_time_to_fill_relative_threshold',
          source_check: 'time_to_fill_pass',
          value: 0.465225,
          threshold: 0.25,
          comparator: '<=',
        },
      ],
    },
    likely_failure_class: 'model_underfit_specific_bucket',
  };
}

function limitBucket(overrides: Record<string, any>): Record<string, any> {
  return {
    bucket_id: 'unknown',
    status: 'pass',
    aggregation: 'exact_queue_bucket',
    calibration_sample_count: 100,
    validation_sample_count: 100,
    empirical_fill_probability: 0.001,
    modeled_fill_probability: 0.001,
    fill_probability_residual: 0,
    fill_probability_threshold: 0.1,
    empirical_no_fill_rate: 0.999,
    modeled_no_fill_rate: 0.999,
    no_fill_rate_residual: 0,
    no_fill_rate_threshold: 0.1,
    empirical_time_to_fill_median_ms: 1000,
    modeled_time_to_fill_median_ms: 1100,
    time_to_fill_relative_error: 0.1,
    time_to_fill_relative_threshold: 0.25,
    checks: {
      fill_probability_pass: true,
      no_fill_rate_pass: true,
      time_to_fill_pass: true,
    },
    failure_reasons: [],
    ...overrides,
  };
}

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
