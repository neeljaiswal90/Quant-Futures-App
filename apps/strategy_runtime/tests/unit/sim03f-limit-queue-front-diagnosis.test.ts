import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  diagnoseLimitQueueFront,
  writeDiagnosisReport,
} from '../../../../scripts/sim/diagnose-limit-queue-front.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-sim03f-diagnosis-'));
  tempDirectories.push(directory);
  return directory;
}

describe('SIM-03F limit_queue:front diagnosis', () => {
  it('extracts the failed front bucket and keeps SIM-03 failed', () => {
    const result = runDiagnosis(baseCalibrationReport());

    expect(result.report).toMatchObject({
      sim03f_diagnosis_report_schema_version: 1,
      ticket_id: 'SIM-03F',
      status: 'diagnosed',
      source_report: {
        status: 'fail',
        ready_for_rel01_execution_simulation: false,
        failure_reasons: ['limit_queue:front:failed thresholds'],
      },
      target_bucket: {
        group: 'limit_queue',
        bucket_id: 'front',
        status: 'fail',
        sample_counts: {
          calibration: 18_842_513,
          validation: 3_779_021,
        },
      },
      likely_failure_class: 'model_underfit_specific_bucket',
      sim03_acceptance_remains_failed: true,
    });
    expect(result.report.source_report.sha256).toBe(sha(result.sourceText));
    expect(result.report.target_bucket.exact_failed_criteria).toEqual([
      {
        name: 'time_to_fill_relative_error_within_time_to_fill_relative_threshold',
        source_check: 'time_to_fill_pass',
        value: 0.465225,
        threshold: 0.25,
        comparator: '<=',
      },
    ]);
    expect(result.report.recommendation.keep_sim03_failed).toBe(true);
  });

  it('compares neighboring buckets with a stable near_front alias', () => {
    const { report } = runDiagnosis(baseCalibrationReport());

    expect(report.neighboring_buckets.map((bucket) => bucket.bucket_id)).toEqual(['near', 'middle', 'back']);
    expect(report.neighboring_buckets[0]).toMatchObject({
      bucket_id: 'near',
      alias: 'near_front',
      status: 'pass',
      metrics: {
        time_to_fill_relative_error: 0.171629,
      },
    });
    expect(report.neighboring_buckets.every((bucket) => bucket.failed_criteria.length === 0)).toBe(true);
  });

  it('classifies sparse buckets without recommending a threshold change', () => {
    const source = baseCalibrationReport();
    source.residuals.limit_queue[0].calibration_sample_count = 10;
    source.residuals.limit_queue[0].validation_sample_count = 8;

    const { report } = runDiagnosis(source);

    expect(report.likely_failure_class).toBe('sparse_or_unstable_bucket');
    expect(report.recommendation.primary_action).toContain('gather more front-bucket validation evidence');
    expect(report.recommendation.keep_sim03_failed).toBe(true);
    expect(report.recommendation.full_rerun_required).toBe(true);
  });

  it('writes deterministic report bytes for the same source report', () => {
    const directory = makeTempDir();
    const source = baseCalibrationReport();
    const reportPath = join(directory, 'calibration.json');
    const firstPath = join(directory, 'first.json');
    const secondPath = join(directory, 'second.json');
    writeFileSync(reportPath, JSON.stringify(source, null, 2), 'utf8');

    writeDiagnosisReport(diagnoseLimitQueueFront({ report: reportPath }), firstPath);
    writeDiagnosisReport(diagnoseLimitQueueFront({ report: reportPath }), secondPath);

    expect(readFileSync(firstPath, 'utf8')).toBe(readFileSync(secondPath, 'utf8'));
  });

  it('exposes the npm script in package.json', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, any>;

    expect(packageJson.scripts['sim:03f:diagnose-limit-front']).toBe(
      'tsx scripts/sim/diagnose-limit-queue-front.ts',
    );
  });
});

function runDiagnosis(source: Record<string, any>): {
  readonly report: ReturnType<typeof diagnoseLimitQueueFront>;
  readonly sourceText: string;
} {
  const directory = makeTempDir();
  mkdirSync(directory, { recursive: true });
  const reportPath = join(directory, 'fill_slippage_calibration.json');
  const sourceText = JSON.stringify(source, null, 2);
  writeFileSync(reportPath, sourceText, 'utf8');
  return {
    report: diagnoseLimitQueueFront({ report: reportPath }),
    sourceText,
  };
}

function baseCalibrationReport(): Record<string, any> {
  return {
    calibration_report_schema_version: 1,
    ticket_id: 'SIM-03',
    status: 'fail',
    ready_for_rel01_execution_simulation: false,
    corpus_summary: {
      verified_sessions: 29,
      calibration_sessions: 24,
      validation_sessions: 5,
      marketable_observations: 19_396_035,
      limit_observations: 362_191_887,
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
          bucket_id: 'order_type=marketable|side=buy',
          status: 'pass',
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
        limitBucket({
          bucket_id: 'near',
          calibration_sample_count: 133_332_230,
          validation_sample_count: 28_495_816,
          time_to_fill_relative_error: 0.171629,
        }),
        limitBucket({
          bucket_id: 'middle',
          calibration_sample_count: 145_068_685,
          validation_sample_count: 26_146_772,
          time_to_fill_relative_error: 0.007194,
        }),
        limitBucket({
          bucket_id: 'back',
          calibration_sample_count: 5_577_960,
          validation_sample_count: 948_890,
          time_to_fill_relative_error: 0.074721,
        }),
      ],
      strategy_level_cost: [],
    },
    insufficient_sample_buckets: [],
    failure_reasons: ['limit_queue:front:failed thresholds'],
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
