import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeLimitQueueFrontDistribution,
  writeAnalysisReport,
} from '../../../../scripts/sim/analyze-limit-queue-front-distribution.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-sim03k-analysis-'));
  tempDirectories.push(directory);
  return directory;
}

describe('SIM-03K limit_queue:front distribution analysis', () => {
  it('computes calibration vs validation percentiles and histograms', () => {
    const fixture = writeFixture();
    writeObservations(fixture, [
      filled('calibration', 100, 'bid'),
      filled('calibration', 200, 'bid'),
      filled('calibration', 300, 'bid'),
      filled('validation', 150, 'bid'),
      filled('validation', 250, 'bid'),
      filled('validation', 350, 'bid'),
      cancelled('validation', 'bid'),
    ]);

    const report = analyzeLimitQueueFrontDistribution(fixture.options);

    expect(report.status).toBe('analysis_only');
    expect(report.sim03_status).toBe('failed');
    expect(report.rel01_status).toBe('blocked');
    expect(report.distribution_comparison.filled_observations.calibration).toMatchObject({
      count: 3,
      p50: 200,
      p90: 280,
    });
    expect(report.distribution_comparison.filled_observations.validation).toMatchObject({
      count: 3,
      p50: 250,
      p90: 330,
    });
    expect(report.histograms.calibration.buckets.find((bucket) => bucket.id === '100_250_ms')).toMatchObject({
      count: 2,
    });
    expect(report.distribution_comparison.outcome_counts.validation.cancelled).toBe(1);
  });

  it('classifies side-specific underfit when side medians explain the remaining error', () => {
    const fixture = writeFixture({ refitMetric: 2 });
    writeObservations(fixture, [
      ...repeat(10, filled('calibration', 100, 'bid')),
      ...repeat(10, filled('calibration', 500, 'ask')),
      ...repeat(18, filled('validation', 100, 'bid')),
      ...repeat(2, filled('validation', 500, 'ask')),
    ]);

    const report = analyzeLimitQueueFrontDistribution(fixture.options);

    expect(report.classification).toBe('side_specific_underfit');
    expect(report.model_form_candidates.side_specific_median_refit).toMatchObject({
      likely_passes_threshold: true,
      projected_validation_metric: 0,
    });
    expect(report.recommendation).toContain('side-specific');
  });

  it('classifies validation distribution shift when the same shape shifts between splits', () => {
    const fixture = writeFixture({ refitMetric: 1 });
    writeObservations(fixture, [
      ...repeat(120, filled('calibration', 200, 'bid')),
      ...repeat(120, filled('validation', 100, 'bid')),
    ]);

    const report = analyzeLimitQueueFrontDistribution(fixture.options);

    expect(report.classification).toBe('validation_distribution_shift');
    expect(report.distribution_comparison.comparison_diagnosis).toBe('shifted_but_same_shape');
  });

  it('detects queue-front definition mismatches from unexpected nonzero queue-ahead records', () => {
    const fixture = writeFixture({ refitMetric: 0.3 });
    writeObservations(fixture, [
      filled('calibration', 100, 'bid', { queueAheadSize: 0 }),
      filled('validation', 100, 'bid', { queueAheadSize: 1 }),
    ]);

    const report = analyzeLimitQueueFrontDistribution(fixture.options);

    expect(report.classification).toBe('queue_front_definition_mismatch');
    expect(report.queue_front_definition_audit).toMatchObject({
      unexpected_nonzero_queue_ahead_records: 1,
      queue_front_definition_mismatch_detected: true,
    });
  });

  it('detects heavy-tail shape without mutating REL status', () => {
    const fixture = writeFixture({ refitMetric: 0.3 });
    writeObservations(fixture, [
      ...repeat(28, filled('calibration', 100, 'bid')),
      ...repeat(22, filled('calibration', 1000, 'bid')),
      ...repeat(5, filled('calibration', 10000, 'bid')),
      ...repeat(28, filled('calibration', 100, 'ask')),
      ...repeat(22, filled('calibration', 1000, 'ask')),
      ...repeat(5, filled('calibration', 10000, 'ask')),
      ...repeat(22, filled('validation', 100, 'bid')),
      ...repeat(28, filled('validation', 1000, 'bid')),
      ...repeat(5, filled('validation', 10000, 'bid')),
      ...repeat(22, filled('validation', 100, 'ask')),
      ...repeat(28, filled('validation', 1000, 'ask')),
      ...repeat(5, filled('validation', 10000, 'ask')),
    ]);

    const report = analyzeLimitQueueFrontDistribution(fixture.options);

    expect(report.classification).toBe('heavy_tail_metric_sensitivity');
    expect(report.distribution_comparison.shape_diagnostics.calibration.heavy_tail).toBe(true);
    expect(report.distribution_comparison.shape_diagnostics.validation.heavy_tail).toBe(true);
    expect(report.rel01_status).toBe('blocked');
  });

  it('buckets deterministic CME equity-index RTH time boundaries', () => {
    const fixture = writeFixture({ refitMetric: 0.3 });
    writeObservations(fixture, [
      filled('calibration', 100, 'bid', { eventTsNs: nsForUtcSecond(13 * 3600 + 29 * 60 + 59) }),
      filled('calibration', 100, 'bid', { eventTsNs: nsForUtcSecond(13 * 3600 + 30 * 60) }),
      filled('calibration', 100, 'bid', { eventTsNs: nsForUtcSecond(14 * 3600 + 30 * 60) }),
      filled('calibration', 100, 'bid', { eventTsNs: nsForUtcSecond(16 * 3600 + 30 * 60) }),
      filled('calibration', 100, 'bid', { eventTsNs: nsForUtcSecond(18 * 3600 + 30 * 60) }),
      filled('validation', 100, 'bid', { eventTsNs: nsForUtcSecond(13 * 3600 + 29 * 60 + 59) }),
      filled('validation', 100, 'bid', { eventTsNs: nsForUtcSecond(13 * 3600 + 30 * 60) }),
      filled('validation', 100, 'bid', { eventTsNs: nsForUtcSecond(14 * 3600 + 30 * 60) }),
      filled('validation', 100, 'bid', { eventTsNs: nsForUtcSecond(16 * 3600 + 30 * 60) }),
      filled('validation', 100, 'bid', { eventTsNs: nsForUtcSecond(18 * 3600 + 30 * 60) }),
    ]);

    const report = analyzeLimitQueueFrontDistribution(fixture.options);
    const ids = report.regime_slices.by_time_of_day.map((slice) => slice.id).sort();

    expect(ids).toEqual(['outside_rth', 'rth_close', 'rth_midday', 'rth_morning', 'rth_open']);
  });

  it('writes a deterministic report shape', () => {
    const fixture = writeFixture({ refitMetric: 0.3 });
    writeObservations(fixture, [
      filled('calibration', 5000, 'bid'),
      filled('calibration', 5000, 'ask'),
      filled('validation', 4000, 'bid'),
      filled('validation', 4000, 'ask'),
    ]);

    const first = analyzeLimitQueueFrontDistribution(fixture.options);
    const second = analyzeLimitQueueFrontDistribution(fixture.options);
    writeAnalysisReport(first, fixture.outPath);

    expect(first).toEqual(second);
    expect(readJson(fixture.outPath)).toMatchObject({
      ticket_id: 'SIM-03K',
      status: 'analysis_only',
      next_ticket: 'SIM-03L',
      rel01_status: 'blocked',
    });
  });

  it('does not use wall-clock or random APIs in deterministic output code', () => {
    const source = readFileSync('scripts/sim/analyze-limit-queue-front-distribution.ts', 'utf8');

    expect(source).not.toContain('Date.now');
    expect(source).not.toContain('new Date');
    expect(source).not.toContain('Math.random');
  });

  it('exposes the npm script wiring', () => {
    const packageJson = readJson('package.json');
    expect(packageJson.scripts['sim:03k:analyze-front-distribution']).toBe(
      'tsx scripts/sim/analyze-limit-queue-front-distribution.ts',
    );
  });
});

interface Fixture {
  readonly directory: string;
  readonly calibrationPath: string;
  readonly diagnosisPath: string;
  readonly refitPath: string;
  readonly observationsPath: string;
  readonly outPath: string;
  readonly sourceHash: string;
  readonly options: {
    readonly cwd: string;
    readonly observations: string;
    readonly calibration_report: string;
    readonly diagnosis_report: string;
    readonly refit_report: string;
    readonly out: string;
  };
}

interface ObservationSpec {
  readonly split: 'calibration' | 'validation';
  readonly fill_outcome: 'filled' | 'cancelled';
  readonly observed_time_to_fill_ms: number | null;
  readonly order_side: 'bid' | 'ask';
  readonly queueAheadSize: number;
  readonly eventTsNs?: string;
}

function writeFixture(input: { readonly refitMetric?: number } = {}): Fixture {
  const directory = makeTempDir();
  const calibrationPath = join(directory, 'fill_slippage_calibration.json');
  const diagnosisPath = join(directory, 'limit_queue_front_diagnosis.json');
  const refitPath = join(directory, 'limit_queue_front_refit_report.json');
  const observationsPath = join(directory, 'limit_queue_front_observations.jsonl');
  const outPath = join(directory, 'limit_queue_front_distribution_analysis.json');
  const calibration = {
    status: 'fail',
    ready_for_rel01_execution_simulation: false,
    failure_reasons: ['limit_queue:front:failed'],
    residuals: {
      limit_queue: [
        {
          bucket_id: 'front',
          status: 'fail',
          time_to_fill_relative_error: 0.465225,
          time_to_fill_relative_threshold: 0.25,
        },
      ],
    },
  };
  writeJson(calibrationPath, calibration);
  const sourceHash = sha(readFileSync(calibrationPath, 'utf8'));
  writeJson(diagnosisPath, {
    ticket_id: 'SIM-03F',
    target_bucket: { group: 'limit_queue', bucket_id: 'front' },
  });
  writeJson(refitPath, {
    ticket_id: 'SIM-03H',
    status: 'refit_failed',
    old_metric_value: 0.465225,
    new_metric_value: input.refitMetric ?? 0.292783,
  });
  return {
    directory,
    calibrationPath,
    diagnosisPath,
    refitPath,
    observationsPath,
    outPath,
    sourceHash,
    options: {
      cwd: directory,
      observations: observationsPath,
      calibration_report: calibrationPath,
      diagnosis_report: diagnosisPath,
      refit_report: refitPath,
      out: outPath,
    },
  };
}

function writeObservations(fixture: Fixture, specs: readonly ObservationSpec[]): void {
  mkdirSync(fixture.directory, { recursive: true });
  const lines = specs.map((spec, index) =>
    JSON.stringify({
      schema_version: 1,
      bucket: 'limit_queue:front',
      split: spec.split,
      observed_time_to_fill_ms: spec.observed_time_to_fill_ms,
      modeled_time_to_fill_ms: null,
      fill_outcome: spec.fill_outcome,
      queue_position_features: {
        queue_bucket: 'front',
        queue_ahead_size: spec.queueAheadSize,
        queue_ahead_order_count: 0,
        order_id: index + 1,
        order_size: 1,
        price: 100,
      },
      event_ts_ns: spec.eventTsNs ?? '1773840600000000000',
      session_id: spec.split === 'calibration' ? '2026-03-18-rth' : '2026-04-27-rth',
      instrument: 'MNQM6',
      source_report_hash: fixture.sourceHash,
      order_side: spec.order_side,
      queue_bucket: 'front',
      no_fill_or_cancel_outcome: spec.fill_outcome === 'cancelled' ? 'cancelled' : null,
      source_session_or_file: `${spec.split}:fixture`,
      observation_id: sha(`${fixture.sourceHash}:${index}`),
    }),
  );
  writeFileSync(fixture.observationsPath, `${lines.join('\n')}\n`, 'utf8');
}

function filled(
  split: 'calibration' | 'validation',
  timeMs: number,
  side: 'bid' | 'ask',
  options: { readonly queueAheadSize?: number; readonly eventTsNs?: string } = {},
): ObservationSpec {
  return {
    split,
    fill_outcome: 'filled',
    observed_time_to_fill_ms: timeMs,
    order_side: side,
    queueAheadSize: options.queueAheadSize ?? 0,
    eventTsNs: options.eventTsNs,
  };
}

function cancelled(split: 'calibration' | 'validation', side: 'bid' | 'ask'): ObservationSpec {
  return {
    split,
    fill_outcome: 'cancelled',
    observed_time_to_fill_ms: null,
    order_side: side,
    queueAheadSize: 0,
  };
}

function repeat<T>(count: number, value: T): T[] {
  return Array.from({ length: count }, () => value);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function nsForUtcSecond(secondsOfDay: number): string {
  return String(BigInt(secondsOfDay) * 1_000_000_000n);
}
