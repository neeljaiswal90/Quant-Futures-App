import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { refitLimitQueueFront } from '../../../../scripts/sim/refit-limit-queue-front.js';
import {
  exportLimitQueueFrontObservations,
} from '../../../../scripts/sim/export-limit-queue-front-observations.js';

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
  const directory = mkdtempSync(join(tmpdir(), 'qfa-sim03i-export-'));
  tempDirectories.push(directory);
  return directory;
}

describe('SIM-03I limit_queue:front observation export', () => {
  it('exports only limit_queue:front observations and writes a stable manifest', () => {
    const fixture = writeFixture();

    const result = exportLimitQueueFrontObservations({
      calibration_report: fixture.calibrationPath,
      diagnosis_report: fixture.diagnosisPath,
      corpus_root: fixture.corpusRoot,
      out: fixture.outPath,
      manifest_out: fixture.manifestOutPath,
      generated_at_ts_ns: GENERATED_AT_TS_NS,
    });
    const rows = readJsonl(fixture.outPath);
    const manifest = readJson(fixture.manifestOutPath);

    expect(result.exit_code).toBe(0);
    expect(manifest).toMatchObject({
      sim03i_observation_export_manifest_schema_version: 1,
      ticket_id: 'SIM-03I',
      status: 'exported',
      observation_count: 6,
      calibration_count: 3,
      validation_count: 3,
      source_report_hash: fixture.sourceHash,
      diagnosis_report_hash: fixture.diagnosisHash,
      output_hash: sha(readFileSync(fixture.outPath, 'utf8')),
      sim03_status: 'fail',
      rel01_status: 'blocked',
      generated_at_ts_ns: GENERATED_AT_TS_NS,
    });
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.bucket === 'limit_queue:front')).toBe(true);
    expect(rows.every((row) => row.queue_bucket === 'front')).toBe(true);
    expect(rows.every((row) => row.source_report_hash === fixture.sourceHash)).toBe(true);
    expect(rows.map((row) => row.fill_outcome)).toEqual(
      expect.arrayContaining(['filled', 'cancelled', 'no_fill']),
    );
    expect(rows.some((row) => row.queue_position_features.queue_ahead_size > 0)).toBe(false);
    expect(new Set(rows.map((row) => row.observation_id)).size).toBe(rows.length);
  });

  it('filters splits without leaking validation rows into calibration-only output', () => {
    const fixture = writeFixture();

    const result = exportLimitQueueFrontObservations({
      calibration_report: fixture.calibrationPath,
      diagnosis_report: fixture.diagnosisPath,
      corpus_root: fixture.corpusRoot,
      out: fixture.outPath,
      manifest_out: fixture.manifestOutPath,
      split: 'calibration',
    });
    const rows = readJsonl(fixture.outPath);
    const manifest = readJson(fixture.manifestOutPath);

    expect(result.exit_code).toBe(0);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.split === 'calibration')).toBe(true);
    expect(manifest.calibration_count).toBe(3);
    expect(manifest.validation_count).toBe(0);
    expect(manifest.leakage_checks.overlapping_session_ids).toEqual([]);
  });

  it('uses deterministic observation ids and byte-stable outputs for identical inputs', () => {
    const fixture = writeFixture();
    const options = {
      calibration_report: fixture.calibrationPath,
      diagnosis_report: fixture.diagnosisPath,
      corpus_root: fixture.corpusRoot,
      out: fixture.outPath,
      manifest_out: fixture.manifestOutPath,
      generated_at_ts_ns: GENERATED_AT_TS_NS,
    };

    exportLimitQueueFrontObservations(options);
    const firstRows = readFileSync(fixture.outPath, 'utf8');
    const firstManifest = readFileSync(fixture.manifestOutPath, 'utf8');
    exportLimitQueueFrontObservations(options);

    expect(readFileSync(fixture.outPath, 'utf8')).toBe(firstRows);
    expect(readFileSync(fixture.manifestOutPath, 'utf8')).toBe(firstManifest);
  });

  it('returns requires_corpus_source when the corpus root is missing', () => {
    const fixture = writeFixture();
    const missingRoot = join(fixture.directory, 'missing-corpus');

    const result = exportLimitQueueFrontObservations({
      calibration_report: fixture.calibrationPath,
      diagnosis_report: fixture.diagnosisPath,
      corpus_root: missingRoot,
      out: fixture.outPath,
      manifest_out: fixture.manifestOutPath,
    });
    const manifest = readJson(fixture.manifestOutPath);

    expect(result.exit_code).toBe(2);
    expect(manifest).toMatchObject({
      status: 'requires_corpus_source',
      observation_count: 0,
      output_hash: null,
      reason: expect.stringContaining('Corpus root not found'),
    });
  });

  it('reports requires_decoded_observation_source for unsupported DBN-only inputs', () => {
    const fixture = writeFixture({ dbnOnly: true });

    const result = exportLimitQueueFrontObservations({
      calibration_report: fixture.calibrationPath,
      diagnosis_report: fixture.diagnosisPath,
      corpus_root: fixture.corpusRoot,
      out: fixture.outPath,
      manifest_out: fixture.manifestOutPath,
    });
    const manifest = readJson(fixture.manifestOutPath);

    expect(result.exit_code).toBe(2);
    expect(manifest.status).toBe('requires_decoded_observation_source');
    expect(manifest.skipped_count_by_reason).toMatchObject({
      dbn_decode_failed: 2,
    });
  }, 15_000);

  it('decodes DBN inputs through the configured SIM-03J decoder before exporting', () => {
    const fixture = writeFixture({ dbnOnly: true });
    const fakeDecoderPath = writeFakeDbnDecoder(fixture.directory);

    const result = exportLimitQueueFrontObservations({
      calibration_report: fixture.calibrationPath,
      diagnosis_report: fixture.diagnosisPath,
      corpus_root: fixture.corpusRoot,
      out: fixture.outPath,
      manifest_out: fixture.manifestOutPath,
      dbn_decoder: fakeDecoderPath,
      python: PYTHON,
    });
    const rows = readJsonl(fixture.outPath);
    const manifest = readJson(fixture.manifestOutPath);

    expect(result.exit_code).toBe(0);
    expect(manifest.status).toBe('exported');
    expect(manifest.dbn_decoded_files_count).toBe(2);
    expect(manifest.skipped_count_by_reason).toEqual({});
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.bucket === 'limit_queue:front')).toBe(true);
  });

  it('fails closed when the source manifest leaks a session into both splits', () => {
    const fixture = writeFixture({ splitLeakage: true });

    const result = exportLimitQueueFrontObservations({
      calibration_report: fixture.calibrationPath,
      diagnosis_report: fixture.diagnosisPath,
      corpus_root: fixture.corpusRoot,
      out: fixture.outPath,
      manifest_out: fixture.manifestOutPath,
    });
    const manifest = readJson(fixture.manifestOutPath);

    expect(result.exit_code).toBe(2);
    expect(manifest.status).toBe('split_leakage_detected');
    expect(manifest.leakage_checks.overlapping_session_ids).toEqual(['2026-04-27-rth']);
  });

  it('produces observations accepted by the SIM-03H synthetic refit path', () => {
    const fixture = writeFixture();
    exportLimitQueueFrontObservations({
      calibration_report: fixture.calibrationPath,
      diagnosis_report: fixture.diagnosisPath,
      corpus_root: fixture.corpusRoot,
      out: fixture.outPath,
      manifest_out: fixture.manifestOutPath,
    });

    const refitResult = refitLimitQueueFront({
      calibration_report: fixture.calibrationPath,
      diagnosis_report: fixture.diagnosisPath,
      observations: fixture.outPath,
      out: fixture.refitOutPath,
      patch_report: fixture.refitPatchPath,
      checked_at_ts_ns: CHECKED_AT_TS_NS,
      python: PYTHON,
    });
    const patch = readJson(fixture.refitPatchPath);

    expect(refitResult.exit_code).toBe(0);
    expect(patch.status).toBe('refit_passed');
    expect(patch.sim03d_gate.status).toBe('pass');
    expect(patch.observation_summary).toMatchObject({
      calibration_filled_records: 1,
      validation_filled_records: 1,
      calibration_time_to_fill_median_ms: 3900,
      validation_time_to_fill_median_ms: 3950,
    });
  });

  it('does not use wall-clock or random APIs in deterministic output code', () => {
    const source = readFileSync('scripts/sim/export-limit-queue-front-observations.ts', 'utf8');

    expect(source).not.toMatch(/\bDate\.now\b/u);
    expect(source).not.toMatch(/\bnew Date\b/u);
    expect(source).not.toMatch(/\bMath\.random\b/u);
  });

  it('exposes the npm script in package.json', () => {
    const packageJson = readJson('package.json');

    expect(packageJson.scripts['sim:03i:export-front-observations']).toBe(
      'tsx scripts/sim/export-limit-queue-front-observations.ts',
    );
    expect(packageJson.scripts['sim:03j:decode-mbo-dbn']).toBe(
      'python scripts/sim/decode-databento-mbo-jsonl.py',
    );
  });
});

function writeFixture(options: {
  readonly dbnOnly?: boolean;
  readonly splitLeakage?: boolean;
} = {}): {
  readonly directory: string;
  readonly corpusRoot: string;
  readonly calibrationPath: string;
  readonly diagnosisPath: string;
  readonly outPath: string;
  readonly manifestOutPath: string;
  readonly refitOutPath: string;
  readonly refitPatchPath: string;
  readonly sourceHash: string;
  readonly diagnosisHash: string;
} {
  const directory = makeTempDir();
  const corpusRoot = join(directory, 'corpus');
  mkdirSync(corpusRoot, { recursive: true });
  const sessions = options.splitLeakage === true
    ? [
        materializeSession(corpusRoot, '2026-04-27-rth', 'calibration', 3900, options.dbnOnly === true, 'calibration-copy'),
        materializeSession(corpusRoot, '2026-04-27-rth', 'validation', 3950, options.dbnOnly === true, 'validation-copy'),
      ]
    : [
        materializeSession(corpusRoot, '2026-04-27-rth', 'calibration', 3900, options.dbnOnly === true),
        materializeSession(corpusRoot, '2026-04-24-rth', 'validation', 3950, options.dbnOnly === true),
      ];
  const sourceManifestPath = join(directory, 'sim03_calibration_corpus_manifest.json');
  writeFileSync(sourceManifestPath, JSON.stringify(baseSourceManifest(sessions), null, 2), 'utf8');

  const calibrationPath = join(directory, 'fill_slippage_calibration.json');
  const diagnosisPath = join(directory, 'limit_queue_front_diagnosis.json');
  const calibrationText = JSON.stringify(baseCalibrationReport(sourceManifestPath), null, 2);
  const diagnosisText = JSON.stringify(baseDiagnosisReport(), null, 2);
  writeFileSync(calibrationPath, calibrationText, 'utf8');
  writeFileSync(diagnosisPath, diagnosisText, 'utf8');

  return {
    directory,
    corpusRoot,
    calibrationPath,
    diagnosisPath,
    outPath: join(directory, 'limit_queue_front_observations.jsonl'),
    manifestOutPath: join(directory, 'limit_queue_front_observations_manifest.json'),
    refitOutPath: join(directory, 'fill_slippage_calibration_refit_limit_queue_front.json'),
    refitPatchPath: join(directory, 'limit_queue_front_refit_report.json'),
    sourceHash: sha(calibrationText),
    diagnosisHash: sha(diagnosisText),
  };
}

function materializeSession(
  corpusRoot: string,
  sessionId: string,
  split: 'calibration' | 'validation',
  fillTimeMs: number,
  dbnOnly: boolean,
  directoryName = sessionId,
): Record<string, any> {
  const sessionDir = join(corpusRoot, directoryName);
  mkdirSync(sessionDir, { recursive: true });
  const mboPath = join(sessionDir, dbnOnly ? 'mbo.dbn.zst' : 'mbo.jsonl');
  if (dbnOnly) {
    writeFileSync(mboPath, 'synthetic dbn placeholder', 'utf8');
    writeJsonl(`${mboPath}.fixture.jsonl`, mboRecords(fillTimeMs));
  } else {
    writeJsonl(mboPath, mboRecords(fillTimeMs));
  }
  return {
    session_id: sessionId,
    symbol: 'MNQM6',
    status: 'complete',
    split,
    schemas: {
      mbo: {
        path: mboPath,
        status: 'available',
      },
    },
  };
}

function mboRecords(fillTimeMs: number): readonly Record<string, any>[] {
  const start = 1_000_000_000;
  const price = 100_000_000_000;
  return [
    { ts_event: start, order_id: 1, price, size: 1, action: 'A', side: 'B' },
    { ts_event: start + fillTimeMs * 1_000_000, order_id: 1, price, size: 1, action: 'T', side: 'B' },
    { ts_event: start + 100, order_id: 2, price: price + 250_000_000, size: 1, action: 'A', side: 'A' },
    { ts_event: start + 200, order_id: 2, price: price + 250_000_000, size: 1, action: 'C', side: 'A' },
    { ts_event: start + 300, order_id: 10, price, size: 1, action: 'A', side: 'B' },
    { ts_event: start + 400, order_id: 11, price, size: 1, action: 'A', side: 'B' },
    { ts_event: start + 500, order_id: 11, price, size: 1, action: 'T', side: 'B' },
  ];
}

function writeFakeDbnDecoder(directory: string): string {
  const decoderPath = join(directory, 'fake-dbn-decoder.py');
  writeFileSync(
    decoderPath,
    [
      'import argparse',
      'from pathlib import Path',
      '',
      'parser = argparse.ArgumentParser()',
      'parser.add_argument("--input", required=True)',
      'parser.add_argument("--out", required=True)',
      'parser.add_argument("--schema", default="mbo")',
      'args = parser.parse_args()',
      'Path(args.out).parent.mkdir(parents=True, exist_ok=True)',
      'Path(args.out).write_text(Path(args.input + ".fixture.jsonl").read_text(encoding="utf-8"), encoding="utf-8")',
    ].join('\n'),
    'utf8',
  );
  return decoderPath;
}

function baseSourceManifest(sessions: readonly Record<string, any>[]): Record<string, any> {
  return {
    manifest_schema_version: 1,
    ticket_id: 'SIM-03A-1',
    status: 'complete',
    symbol: 'MNQM6',
    sessions,
  };
}

function baseCalibrationReport(sourceManifestPath: string): Record<string, any> {
  return {
    calibration_report_schema_version: 1,
    ticket_id: 'SIM-03',
    status: 'fail',
    ready_for_rel01_execution_simulation: false,
    inputs: {
      manifest_path: sourceManifestPath,
      manifest_hash: sha('manifest'),
      verified_report_hash: sha('verified'),
      thresholds_config_hash: sha('thresholds'),
      verified_report_ready: true,
    },
    fitted_constants: {
      queue_fill_model: {
        front: {
          median_time_to_fill_ms: 5329.796914,
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
        {
          bucket_id: 'front',
          status: 'fail',
          calibration_sample_count: 100,
          validation_sample_count: 100,
          fill_probability_residual: 0.000082,
          fill_probability_threshold: 0.1,
          no_fill_rate_residual: 0.000082,
          no_fill_rate_threshold: 0.1,
          empirical_time_to_fill_median_ms: 3637.527295,
          modeled_time_to_fill_median_ms: 5329.796914,
          time_to_fill_relative_error: 0.465225,
          time_to_fill_relative_threshold: 0.25,
          checks: {
            fill_probability_pass: true,
            no_fill_rate_pass: true,
            time_to_fill_pass: false,
          },
          failure_reasons: ['time_to_fill_pass'],
        },
        {
          bucket_id: 'near',
          status: 'pass',
          calibration_sample_count: 100,
          validation_sample_count: 100,
          fill_probability_residual: 0,
          fill_probability_threshold: 0.1,
          time_to_fill_relative_error: 0.1,
          time_to_fill_relative_threshold: 0.25,
          no_fill_rate_residual: 0,
          no_fill_rate_threshold: 0.1,
        },
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

function writeJsonl(path: string, records: readonly Record<string, unknown>[]): void {
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

function readJsonl(path: string): Record<string, any>[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
