import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { refitLimitQueueFrontRobust } from '../../../../scripts/sim/refit-limit-queue-front-robust.js';

const PYTHON = process.env.PYTHON ?? 'python';
const CHECKED_AT_TS_NS = '1777399200000000000';
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-sim03l-robust-'));
  tempDirectories.push(directory);
  return directory;
}

describe('SIM-03L robust limit_queue:front refit', () => {
  it('applies a robust front-bucket statistic only when tail audit and SIM-03D pass', () => {
    const fixture = writeFixture();
    const observationsText = writeObservationJsonl(fixture.observationsPath, fixture.sourceHash, {
      calibrationTimes: [...repeat(10, 100), ...repeat(8, 1000), ...repeat(2, 10000)],
      validationTimes: [...repeat(10, 110), ...repeat(8, 1000), ...repeat(2, 9000)],
    });

    const result = refitLimitQueueFrontRobust({
      calibration_report: fixture.calibrationPath,
      diagnosis_report: fixture.diagnosisPath,
      analysis_report: fixture.analysisPath,
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
      sim03l_robust_refit_report_schema_version: 1,
      ticket_id: 'SIM-03L',
      status: 'robust_refit_passed',
      source_calibration_report_hash: fixture.sourceHash,
      source_diagnosis_report_hash: fixture.diagnosisHash,
      source_analysis_report_hash: fixture.analysisHash,
      observations_hash: sha(observationsText),
      target_bucket: 'limit_queue:front',
      target_metric: 'time_to_fill_relative_error_within_time_to_fill_relative_threshold',
      old_metric_value: 0.465225,
      new_metric_value: 0.009009,
      threshold: 0.25,
      method: 'front_bucket_10_90_trimmed_mean_with_tail_audit',
      checked_at_ts_ns: CHECKED_AT_TS_NS,
      unchanged_bucket_count: 5,
      tail_audit: {
        status: 'pass',
        validation_tail_share_above_calibration_p95_threshold: 0.1,
        failure_reasons: [],
      },
      sim03d_gate: {
        status: 'pass',
        exit_code: 0,
        ready_for_rel01_execution_simulation: true,
        failure_reasons: [],
      },
    });
    expect(patchReport.changed_fields).toEqual(
      expect.arrayContaining([
        'fitted_constants.queue_fill_model.front.robust_time_to_fill_statistic_ms',
        'fitted_constants.queue_fill_model.front.time_to_fill_statistic_method',
        'residuals.limit_queue.front.modeled_time_to_fill_statistic_ms',
        'residuals.limit_queue.front.empirical_time_to_fill_statistic_ms',
        'residuals.limit_queue.front.time_to_fill_relative_error',
        'residuals.limit_queue.front.checks.time_to_fill_pass',
        'residuals.limit_queue.front.failure_reasons',
        'residuals.limit_queue.front.status',
        'failure_reasons',
        'status',
        'ready_for_rel01_execution_simulation',
        'robust_refit_metadata',
      ]),
    );
    expect(outputReport.residuals.limit_queue[0]).toMatchObject({
      bucket_id: 'front',
      status: 'pass',
      time_to_fill_statistic_method: 'front_bucket_10_90_trimmed_mean_with_tail_audit',
      modeled_time_to_fill_statistic_ms: 550,
      empirical_time_to_fill_statistic_ms: 555,
      time_to_fill_relative_error: 0.009009,
      checks: {
        time_to_fill_pass: true,
      },
      failure_reasons: [],
    });
    expect(outputReport.fitted_constants.queue_fill_model.front).toMatchObject({
      time_to_fill_statistic_method: 'front_bucket_10_90_trimmed_mean_with_tail_audit',
      robust_time_to_fill_statistic_ms: 550,
    });
    expect(outputReport.residuals.limit_queue[1]).toEqual(fixture.calibrationReport.residuals.limit_queue[1]);
    expect(outputReport.residuals.limit_queue[2]).toEqual(fixture.calibrationReport.residuals.limit_queue[2]);
    expect(outputReport.residuals.limit_queue[3]).toEqual(fixture.calibrationReport.residuals.limit_queue[3]);
    expect(outputReport.residuals.marketable_slippage).toEqual(fixture.calibrationReport.residuals.marketable_slippage);
    expect(outputReport.residuals.strategy_level_cost).toEqual(fixture.calibrationReport.residuals.strategy_level_cost);
    expect(outputReport.status).toBe('pass');
    expect(outputReport.ready_for_rel01_execution_simulation).toBe(true);
  });

  it('refuses to apply the robust statistic when validation tail risk is worse', () => {
    const fixture = writeFixture();
    writeObservationJsonl(fixture.observationsPath, fixture.sourceHash, {
      calibrationTimes: [...repeat(10, 100), ...repeat(8, 1000), ...repeat(2, 10000)],
      validationTimes: [...repeat(10, 110), ...repeat(8, 1000), ...repeat(2, 50000)],
    });

    const result = refitLimitQueueFrontRobust({
      calibration_report: fixture.calibrationPath,
      diagnosis_report: fixture.diagnosisPath,
      analysis_report: fixture.analysisPath,
      observations: fixture.observationsPath,
      out: fixture.outPath,
      patch_report: fixture.patchPath,
      checked_at_ts_ns: CHECKED_AT_TS_NS,
      python: PYTHON,
    });

    const outputReport = readJson(fixture.outPath);
    const patchReport = readJson(fixture.patchPath);

    expect(result.exit_code).toBe(2);
    expect(patchReport.status).toBe('tail_audit_failed');
    expect(patchReport.new_metric_value).toBe(null);
    expect(patchReport.tail_audit.failure_reasons).toEqual(
      expect.arrayContaining(['validation_p99_tail_exceeds_calibration_tolerance']),
    );
    expect(patchReport.sim03d_gate.status).toBe('fail');
    expect(outputReport.residuals.limit_queue[0].time_to_fill_relative_error).toBe(0.465225);
    expect(outputReport.status).toBe('fail');
    expect(outputReport.ready_for_rel01_execution_simulation).toBe(false);
  });

  it('keeps SIM-03 failed when the robust refit still breaches the threshold', () => {
    const fixture = writeFixture();
    writeObservationJsonl(fixture.observationsPath, fixture.sourceHash, {
      calibrationTimes: [...repeat(10, 100), ...repeat(8, 1000), ...repeat(2, 10000)],
      validationTimes: [...repeat(10, 200), ...repeat(8, 2000), ...repeat(2, 9000)],
    });

    const result = refitLimitQueueFrontRobust({
      calibration_report: fixture.calibrationPath,
      diagnosis_report: fixture.diagnosisPath,
      analysis_report: fixture.analysisPath,
      observations: fixture.observationsPath,
      out: fixture.outPath,
      patch_report: fixture.patchPath,
      checked_at_ts_ns: CHECKED_AT_TS_NS,
      python: PYTHON,
    });

    const outputReport = readJson(fixture.outPath);
    const patchReport = readJson(fixture.patchPath);

    expect(result.exit_code).toBe(2);
    expect(patchReport.status).toBe('robust_refit_failed');
    expect(patchReport.new_metric_value).toBe(0.5);
    expect(patchReport.tail_audit.status).toBe('pass');
    expect(patchReport.tail_audit.failure_reasons).toEqual([]);
    expect(patchReport.sim03d_gate.status).toBe('fail');
    expect(outputReport.residuals.limit_queue[0]).toMatchObject({
      bucket_id: 'front',
      status: 'fail',
      modeled_time_to_fill_statistic_ms: 550,
      empirical_time_to_fill_statistic_ms: 1100,
      time_to_fill_relative_error: 0.5,
      checks: {
        time_to_fill_pass: false,
      },
      failure_reasons: ['time_to_fill_pass'],
    });
    expect(outputReport.status).toBe('fail');
    expect(outputReport.ready_for_rel01_execution_simulation).toBe(false);
  });

  it('preserves limit thresholds while changing only target time-to-fill fields', () => {
    const fixture = writeFixture();
    writeObservationJsonl(fixture.observationsPath, fixture.sourceHash, {
      calibrationTimes: [...repeat(10, 100), ...repeat(8, 1000), ...repeat(2, 10000)],
      validationTimes: [...repeat(10, 110), ...repeat(8, 1000), ...repeat(2, 9000)],
    });

    refitLimitQueueFrontRobust({
      calibration_report: fixture.calibrationPath,
      diagnosis_report: fixture.diagnosisPath,
      analysis_report: fixture.analysisPath,
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
      fill_probability_residual: 0.000082,
      no_fill_rate_residual: 0.000082,
    });
  });

  it('rejects analysis reports that do not authorize the heavy-tail robust-statistic path', () => {
    const fixture = writeFixture({ analysisClassification: 'side_specific_underfit' });
    writeObservationJsonl(fixture.observationsPath, fixture.sourceHash, {
      calibrationTimes: [100, 100],
      validationTimes: [100, 100],
    });

    expect(() =>
      refitLimitQueueFrontRobust({
        calibration_report: fixture.calibrationPath,
        diagnosis_report: fixture.diagnosisPath,
        analysis_report: fixture.analysisPath,
        observations: fixture.observationsPath,
        out: fixture.outPath,
        patch_report: fixture.patchPath,
        checked_at_ts_ns: CHECKED_AT_TS_NS,
        python: PYTHON,
      }),
    ).toThrow(/heavy_tail_metric_sensitivity/u);
  });

  it('rejects analysis reports that are bound to a different calibration hash', () => {
    const fixture = writeFixture();
    const analysisReport = readJson(fixture.analysisPath);
    analysisReport.source_inputs.calibration_report_hash = sha('different-calibration-report');
    writeFileSync(fixture.analysisPath, JSON.stringify(analysisReport, null, 2), 'utf8');
    writeObservationJsonl(fixture.observationsPath, fixture.sourceHash, {
      calibrationTimes: [100, 100],
      validationTimes: [100, 100],
    });

    expect(() =>
      refitLimitQueueFrontRobust({
        calibration_report: fixture.calibrationPath,
        diagnosis_report: fixture.diagnosisPath,
        analysis_report: fixture.analysisPath,
        observations: fixture.observationsPath,
        out: fixture.outPath,
        patch_report: fixture.patchPath,
        checked_at_ts_ns: CHECKED_AT_TS_NS,
        python: PYTHON,
      }),
    ).toThrow(/source calibration hash/u);
  });

  it('is deterministic for identical inputs and caller-provided timestamp', () => {
    const fixture = writeFixture();
    writeObservationJsonl(fixture.observationsPath, fixture.sourceHash, {
      calibrationTimes: [...repeat(10, 100), ...repeat(8, 1000), ...repeat(2, 10000)],
      validationTimes: [...repeat(10, 110), ...repeat(8, 1000), ...repeat(2, 9000)],
    });
    const options = {
      calibration_report: fixture.calibrationPath,
      diagnosis_report: fixture.diagnosisPath,
      analysis_report: fixture.analysisPath,
      observations: fixture.observationsPath,
      out: fixture.outPath,
      patch_report: fixture.patchPath,
      checked_at_ts_ns: CHECKED_AT_TS_NS,
      python: PYTHON,
    };

    refitLimitQueueFrontRobust(options);
    const firstReport = readFileSync(fixture.outPath, 'utf8');
    const firstPatch = readFileSync(fixture.patchPath, 'utf8');
    refitLimitQueueFrontRobust(options);

    expect(readFileSync(fixture.outPath, 'utf8')).toBe(firstReport);
    expect(readFileSync(fixture.patchPath, 'utf8')).toBe(firstPatch);
  });

  it('does not use wall-clock or random APIs in deterministic output code', () => {
    const source = readFileSync('scripts/sim/refit-limit-queue-front-robust.ts', 'utf8');

    expect(source).not.toMatch(/\bDate\.now\b/u);
    expect(source).not.toMatch(/\bnew Date\b/u);
    expect(source).not.toMatch(/\bMath\.random\b/u);
  });

  it('exposes the npm script in package.json', () => {
    const packageJson = readJson('package.json');

    expect(packageJson.scripts['sim:03l:robust-front-refit']).toBe(
      'tsx scripts/sim/refit-limit-queue-front-robust.ts',
    );
  });
});

function writeFixture(input: { readonly analysisClassification?: string } = {}): {
  readonly directory: string;
  readonly calibrationPath: string;
  readonly diagnosisPath: string;
  readonly analysisPath: string;
  readonly observationsPath: string;
  readonly outPath: string;
  readonly patchPath: string;
  readonly calibrationReport: Record<string, any>;
  readonly sourceHash: string;
  readonly diagnosisHash: string;
  readonly analysisHash: string;
} {
  const directory = makeTempDir();
  mkdirSync(directory, { recursive: true });
  const calibrationPath = join(directory, 'fill_slippage_calibration.json');
  const diagnosisPath = join(directory, 'limit_queue_front_diagnosis.json');
  const analysisPath = join(directory, 'limit_queue_front_distribution_analysis.json');
  const observationsPath = join(directory, 'limit_queue_front_observations.jsonl');
  const outPath = join(directory, 'fill_slippage_calibration_robust_limit_queue_front.json');
  const patchPath = join(directory, 'limit_queue_front_robust_refit_report.json');
  const calibrationReport = baseCalibrationReport();
  const diagnosisReport = baseDiagnosisReport();
  const calibrationText = JSON.stringify(calibrationReport, null, 2);
  const diagnosisText = JSON.stringify(diagnosisReport, null, 2);
  const sourceHash = sha(calibrationText);
  const analysisReport = baseAnalysisReport(sourceHash, input.analysisClassification ?? 'heavy_tail_metric_sensitivity');
  const analysisText = JSON.stringify(analysisReport, null, 2);
  writeFileSync(calibrationPath, calibrationText, 'utf8');
  writeFileSync(diagnosisPath, diagnosisText, 'utf8');
  writeFileSync(analysisPath, analysisText, 'utf8');
  return {
    directory,
    calibrationPath,
    diagnosisPath,
    analysisPath,
    observationsPath,
    outPath,
    patchPath,
    calibrationReport,
    sourceHash,
    diagnosisHash: sha(diagnosisText),
    analysisHash: sha(analysisText),
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
      queue_ahead_size: 0,
      synthetic_rank: index,
    },
    event_ts_ns: `${1777296600000000000n + BigInt(index)}`,
    session_id: split === 'calibration' ? '2026-04-27-rth' : '2026-04-24-rth',
    instrument: 'MNQM6',
    source_report_hash: sourceReportHash,
    order_side: index % 2 === 0 ? 'bid' : 'ask',
    queue_bucket: 'front',
    source_session_or_file: `${split}:fixture`,
    observation_id: sha(`${sourceReportHash}:${split}:${index}:${observedTimeToFillMs ?? 'nf'}`),
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

function baseAnalysisReport(sourceHash: string, classification: string): Record<string, any> {
  return {
    sim03k_analysis_report_schema_version: 1,
    ticket_id: 'SIM-03K',
    status: 'analysis_only',
    sim03_status: 'failed',
    rel01_status: 'blocked',
    target_bucket: 'limit_queue:front',
    classification,
    source_inputs: {
      calibration_report_hash: sourceHash,
    },
    model_form_candidates: {
      robust_trimmed_statistic: {
        likely_passes_threshold: true,
      },
    },
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

function repeat<T>(count: number, value: T): T[] {
  return Array.from({ length: count }, () => value);
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
