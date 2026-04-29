import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { refitLimitQueueFront } from '../../../../scripts/sim/refit-limit-queue-front.js';

const PYTHON = process.env.PYTHON ?? 'python';
const CHECKED_AT_TS_NS = '1777399200000000000';
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-sim03h-refit-'));
  tempDirectories.push(directory);
  return directory;
}

describe('SIM-03H limit_queue:front observation refit', () => {
  it('emits requires_targeted_observation_export when observations are missing', () => {
    const fixture = writeFixture();
    const missingObservationsPath = join(fixture.directory, 'missing-observations.jsonl');

    const result = refitLimitQueueFront({
      calibration_report: fixture.calibrationPath,
      diagnosis_report: fixture.diagnosisPath,
      observations: missingObservationsPath,
      out: fixture.outPath,
      patch_report: fixture.patchPath,
      checked_at_ts_ns: CHECKED_AT_TS_NS,
      python: PYTHON,
    });

    const outputReport = readJson(fixture.outPath);
    const patchReport = readJson(fixture.patchPath);

    expect(result.exit_code).toBe(2);
    expect(patchReport).toMatchObject({
      sim03h_refit_report_schema_version: 1,
      ticket_id: 'SIM-03H',
      status: 'requires_targeted_observation_export',
      target_bucket: 'limit_queue:front',
      target_metric: 'time_to_fill_relative_error_within_time_to_fill_relative_threshold',
      old_metric_value: 0.465225,
      new_metric_value: null,
      threshold: 0.25,
      method: 'targeted_observation_export_required',
      observations_hash: null,
    });
    expect(patchReport.required_observation_export.instructions).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Export only limit_queue:front observations'),
      ]),
    );
    expect(patchReport.sim03d_gate.status).toBe('fail');
    expect(outputReport.status).toBe('fail');
    expect(outputReport.ready_for_rel01_execution_simulation).toBe(false);
    expect(outputReport.residuals.limit_queue[0].time_to_fill_relative_error).toBe(0.465225);
    expect(readFileSync(fixture.calibrationPath, 'utf8')).toBe(fixture.calibrationText);
  });

  it('changes only limit_queue:front time-to-fill fields and validates a passing refit', () => {
    const fixture = writeFixture();
    const observationsText = writeObservationJsonl(fixture.observationsPath, fixture.sourceHash, {
      calibrationTimes: [3900, 3900],
      validationTimes: [3950, 3950],
    });
    const source = fixture.calibrationReport;

    const result = refitLimitQueueFront({
      calibration_report: fixture.calibrationPath,
      diagnosis_report: fixture.diagnosisPath,
      observations: fixture.observationsPath,
      out: fixture.outPath,
      patch_report: fixture.patchPath,
      checked_at_ts_ns: CHECKED_AT_TS_NS,
      python: PYTHON,
    });

    const outputReport = readJson(fixture.outPath);
    const patchReport = readJson(fixture.patchPath);

    expect(result.exit_code).toBe(0);
    expect(patchReport).toMatchObject({
      status: 'refit_passed',
      source_calibration_report_hash: fixture.sourceHash,
      source_diagnosis_report_hash: fixture.diagnosisHash,
      observations_hash: sha(observationsText),
      old_metric_value: 0.465225,
      new_metric_value: 0.012658,
      threshold: 0.25,
      method: 'targeted_bucket_refit_from_calibration_observations',
      checked_at_ts_ns: CHECKED_AT_TS_NS,
      unchanged_bucket_count: 5,
      sim03d_gate: {
        status: 'pass',
        exit_code: 0,
        ready_for_rel01_execution_simulation: true,
        failure_reasons: [],
      },
    });
    expect(patchReport.changed_fields).toEqual(
      expect.arrayContaining([
        'fitted_constants.queue_fill_model.front.median_time_to_fill_ms',
        'residuals.limit_queue.front.modeled_time_to_fill_median_ms',
        'residuals.limit_queue.front.empirical_time_to_fill_median_ms',
        'residuals.limit_queue.front.time_to_fill_relative_error',
        'residuals.limit_queue.front.checks.time_to_fill_pass',
        'residuals.limit_queue.front.failure_reasons',
        'residuals.limit_queue.front.status',
        'failure_reasons',
        'status',
        'ready_for_rel01_execution_simulation',
      ]),
    );
    expect(outputReport.residuals.limit_queue[0]).toMatchObject({
      bucket_id: 'front',
      status: 'pass',
      empirical_time_to_fill_median_ms: 3950,
      modeled_time_to_fill_median_ms: 3900,
      time_to_fill_relative_error: 0.012658,
      checks: {
        time_to_fill_pass: true,
      },
      failure_reasons: [],
    });
    expect(outputReport.fitted_constants.queue_fill_model.front.median_time_to_fill_ms).toBe(3900);
    expect(outputReport.residuals.limit_queue[1]).toEqual(source.residuals.limit_queue[1]);
    expect(outputReport.residuals.limit_queue[2]).toEqual(source.residuals.limit_queue[2]);
    expect(outputReport.residuals.limit_queue[3]).toEqual(source.residuals.limit_queue[3]);
    expect(outputReport.residuals.marketable_slippage).toEqual(source.residuals.marketable_slippage);
    expect(outputReport.residuals.strategy_level_cost).toEqual(source.residuals.strategy_level_cost);
    expect(outputReport.status).toBe('pass');
    expect(outputReport.ready_for_rel01_execution_simulation).toBe(true);
    expect(outputReport.failure_reasons).toEqual([]);
  });

  it('preserves all limit thresholds while refitting the target bucket', () => {
    const fixture = writeFixture();
    writeObservationJsonl(fixture.observationsPath, fixture.sourceHash, {
      calibrationTimes: [3900, 3900],
      validationTimes: [3950, 3950],
    });

    refitLimitQueueFront({
      calibration_report: fixture.calibrationPath,
      diagnosis_report: fixture.diagnosisPath,
      observations: fixture.observationsPath,
      out: fixture.outPath,
      patch_report: fixture.patchPath,
      checked_at_ts_ns: CHECKED_AT_TS_NS,
      python: PYTHON,
    });

    const outputReport = readJson(fixture.outPath);
    expect(outputReport.residuals.limit_queue[0]).toMatchObject({
      fill_probability_threshold: 0.1,
      no_fill_rate_threshold: 0.1,
      time_to_fill_relative_threshold: 0.25,
    });
  });

  it('reports SIM-03D failure when observation-backed refit still breaches threshold', () => {
    const fixture = writeFixture();
    writeObservationJsonl(fixture.observationsPath, fixture.sourceHash, {
      calibrationTimes: [5000, 5000],
      validationTimes: [3000, 3000],
    });

    const result = refitLimitQueueFront({
      calibration_report: fixture.calibrationPath,
      diagnosis_report: fixture.diagnosisPath,
      observations: fixture.observationsPath,
      out: fixture.outPath,
      patch_report: fixture.patchPath,
      checked_at_ts_ns: CHECKED_AT_TS_NS,
      python: PYTHON,
    });

    const outputReport = readJson(fixture.outPath);
    const patchReport = readJson(fixture.patchPath);

    expect(result.exit_code).toBe(2);
    expect(patchReport.status).toBe('refit_failed');
    expect(patchReport.new_metric_value).toBe(0.666667);
    expect(patchReport.sim03d_gate).toMatchObject({
      status: 'fail',
      exit_code: 2,
      ready_for_rel01_execution_simulation: false,
    });
    expect(outputReport.residuals.limit_queue[0]).toMatchObject({
      status: 'fail',
      time_to_fill_relative_error: 0.666667,
      checks: {
        time_to_fill_pass: false,
      },
      failure_reasons: ['time_to_fill_pass'],
    });
    expect(outputReport.status).toBe('fail');
    expect(outputReport.ready_for_rel01_execution_simulation).toBe(false);
  });

  it('is deterministic for identical inputs and caller-provided timestamp', () => {
    const fixture = writeFixture();
    writeObservationJsonl(fixture.observationsPath, fixture.sourceHash, {
      calibrationTimes: [3900, 3900],
      validationTimes: [3950, 3950],
    });

    const options = {
      calibration_report: fixture.calibrationPath,
      diagnosis_report: fixture.diagnosisPath,
      observations: fixture.observationsPath,
      out: fixture.outPath,
      patch_report: fixture.patchPath,
      checked_at_ts_ns: CHECKED_AT_TS_NS,
      python: PYTHON,
    };
    refitLimitQueueFront(options);
    const firstReport = readFileSync(fixture.outPath, 'utf8');
    const firstPatch = readFileSync(fixture.patchPath, 'utf8');
    refitLimitQueueFront(options);

    expect(readFileSync(fixture.outPath, 'utf8')).toBe(firstReport);
    expect(readFileSync(fixture.patchPath, 'utf8')).toBe(firstPatch);
  });

  it('does not use wall-clock or random APIs in deterministic output code', () => {
    const source = readFileSync('scripts/sim/refit-limit-queue-front.ts', 'utf8');

    expect(source).not.toMatch(/\bDate\.now\b/u);
    expect(source).not.toMatch(/\bnew Date\b/u);
    expect(source).not.toMatch(/\bMath\.random\b/u);
  });

  it('exposes the npm script in package.json', () => {
    const packageJson = readJson('package.json');

    expect(packageJson.scripts['sim:03h:refit-front']).toBe(
      'tsx scripts/sim/refit-limit-queue-front.ts',
    );
  });
});

function writeFixture(): {
  readonly directory: string;
  readonly calibrationPath: string;
  readonly diagnosisPath: string;
  readonly observationsPath: string;
  readonly outPath: string;
  readonly patchPath: string;
  readonly calibrationReport: Record<string, any>;
  readonly calibrationText: string;
  readonly sourceHash: string;
  readonly diagnosisHash: string;
} {
  const directory = makeTempDir();
  mkdirSync(directory, { recursive: true });
  const calibrationPath = join(directory, 'fill_slippage_calibration.json');
  const diagnosisPath = join(directory, 'limit_queue_front_diagnosis.json');
  const observationsPath = join(directory, 'limit_queue_front_observations.jsonl');
  const outPath = join(directory, 'fill_slippage_calibration_refit_limit_queue_front.json');
  const patchPath = join(directory, 'limit_queue_front_refit_report.json');
  const calibrationReport = baseCalibrationReport();
  const diagnosisReport = baseDiagnosisReport();
  const calibrationText = JSON.stringify(calibrationReport, null, 2);
  const diagnosisText = JSON.stringify(diagnosisReport, null, 2);
  writeFileSync(calibrationPath, calibrationText, 'utf8');
  writeFileSync(diagnosisPath, diagnosisText, 'utf8');
  return {
    directory,
    calibrationPath,
    diagnosisPath,
    observationsPath,
    outPath,
    patchPath,
    calibrationReport,
    calibrationText,
    sourceHash: sha(calibrationText),
    diagnosisHash: sha(diagnosisText),
  };
}

function writeObservationJsonl(
  path: string,
  sourceReportHash: string,
  input: {
    readonly calibrationTimes: readonly number[];
    readonly validationTimes: readonly number[];
  },
): string {
  const rows = [
    ...input.calibrationTimes.map((time, index) =>
      observationRow('calibration', time, index, sourceReportHash),
    ),
    ...input.validationTimes.map((time, index) =>
      observationRow('validation', time, index, sourceReportHash),
    ),
    {
      ...observationRow('calibration', null, 99, sourceReportHash),
      fill_outcome: 'no_fill',
    },
  ];
  const text = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  writeFileSync(path, text, 'utf8');
  return text;
}

function observationRow(
  split: 'calibration' | 'validation',
  observedTimeToFillMs: number | null,
  index: number,
  sourceReportHash: string,
): Record<string, any> {
  return {
    schema_version: 1,
    bucket: 'limit_queue:front',
    split,
    observed_time_to_fill_ms: observedTimeToFillMs,
    modeled_time_to_fill_ms: null,
    fill_outcome: observedTimeToFillMs === null ? 'no_fill' : 'filled',
    queue_position_features: {
      queue_bucket: 'front',
      synthetic_rank: index,
    },
    event_ts_ns: `${1777296600000000000n + BigInt(index)}`,
    session_id: split === 'calibration' ? '2026-04-27-rth' : '2026-04-24-rth',
    instrument: 'MNQM6',
    source_report_hash: sourceReportHash,
  };
}

function baseCalibrationReport(): Record<string, any> {
  return {
    calibration_report_schema_version: 1,
    ticket_id: 'SIM-03',
    status: 'fail',
    ready_for_rel01_execution_simulation: false,
    simulated_execution_fitter_version: 'fitter_v1',
    calibrated_at_ts_ns: '1777395600000000000',
    inputs: {
      manifest_hash: sha('manifest'),
      verified_report_hash: sha('verified'),
      thresholds_config_hash: sha('thresholds'),
      verified_report_ready: true,
    },
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
          bucket_id: 'order_type=marketable|side=buy|spread_bucket=one_tick|session_phase=open|volatility_regime=normal',
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

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
