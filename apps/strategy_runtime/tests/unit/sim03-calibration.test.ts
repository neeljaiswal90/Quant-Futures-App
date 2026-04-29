import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const PYTHON = process.env.PYTHON ?? 'python';
const SCRIPT = 'scripts/sim/calibrate-fill-slippage-sim03.py';
const CALIBRATED_AT_TS_NS = '1777395600000000000';
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-sim03-calibration-'));
  tempDirectories.push(directory);
  return directory;
}

describe('SIM-03 fill/slippage calibration', () => {
  it('fits constants and passes residuals from a verified fixture corpus', () => {
    const result = runCalibration({
      sessions: [
        sessionFixture('2026-04-27-rth', 'calibration'),
        sessionFixture('2026-04-24-rth', 'validation'),
      ],
      minBucketSample: 1,
    });

    expect(result.exitCode).toBe(0);
    expect(result.report).toMatchObject({
      calibration_report_schema_version: 1,
      ticket_id: 'SIM-03',
      status: 'pass',
      ready_for_rel01_execution_simulation: true,
      simulated_execution_fitter_version: 'fitter_v1',
      calibrated_at_ts_ns: CALIBRATED_AT_TS_NS,
      corpus_summary: {
        verified_sessions: 2,
        calibration_sessions: 1,
        validation_sessions: 1,
      },
    });
    expect(result.report.inputs.manifest_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.report.inputs.thresholds_config_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.values(result.report.fitted_constants.marketable_slippage)).toContainEqual(
      expect.objectContaining({ base_slippage_points: 0 }),
    );
    expect(readFileSync(result.markdownPath, 'utf8')).toContain('Status: `pass`');
  });

  it('returns exit code 2 when validation residuals breach plan thresholds', () => {
    const result = runCalibration({
      sessions: [
        sessionFixture('2026-04-27-rth', 'calibration'),
        sessionFixture('2026-04-24-rth', 'validation', { validationSlippagePoints: 1.0 }),
      ],
      minBucketSample: 1,
    });

    expect(result.exitCode).toBe(2);
    expect(result.report.status).toBe('fail');
    expect(result.report.ready_for_rel01_execution_simulation).toBe(false);
    expect(result.report.failure_reasons.some((reason: string) => reason.startsWith('marketable_slippage'))).toBe(true);
  });

  it('refuses to run when the verified report does not match the manifest hash', () => {
    const directory = makeTempDir();
    const manifestPath = join(directory, 'manifest.json');
    const thresholdsPath = join(directory, 'thresholds.json');
    const verifiedPath = join(directory, 'verified.json');
    writeFileSync(manifestPath, JSON.stringify(baseManifest([])), 'utf8');
    writeFileSync(thresholdsPath, JSON.stringify(thresholds()), 'utf8');
    writeFileSync(
      verifiedPath,
      JSON.stringify({
        verified_report_schema_version: 1,
        ready_for_sim03_model_fitting: true,
        source_manifest_hash: '0'.repeat(64),
        thresholds_config_hash: sha256File(thresholdsPath),
        sessions: [],
      }),
      'utf8',
    );

    const result = spawnSync(
      PYTHON,
      [
        SCRIPT,
        '--manifest',
        manifestPath,
        '--verified-report',
        verifiedPath,
        '--thresholds',
        thresholdsPath,
        '--calibrated-at-ts-ns',
        CALIBRATED_AT_TS_NS,
        '--out',
        join(directory, 'out.json'),
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('manifest hash does not match');
  });

  it('is byte-deterministic for the same corpus and caller-provided timestamp', () => {
    const directory = makeTempDir();
    const first = runCalibration({
      rootDirectory: directory,
      inputName: 'shared',
      outName: 'first.json',
      sessions: [
        sessionFixture('2026-04-27-rth', 'calibration'),
        sessionFixture('2026-04-24-rth', 'validation'),
      ],
      minBucketSample: 1,
    });
    const second = runCalibration({
      rootDirectory: directory,
      inputName: 'shared',
      outName: 'second.json',
      sessions: [
        sessionFixture('2026-04-27-rth', 'calibration'),
        sessionFixture('2026-04-24-rth', 'validation'),
      ],
      minBucketSample: 1,
    });

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(readFileSync(first.reportPath, 'utf8')).toBe(readFileSync(second.reportPath, 'utf8'));
  });

  it('writes progress and checkpoint artifacts and can resume from checkpoint', () => {
    const directory = makeTempDir();
    const checkpointPath = join(directory, 'checkpoint.json');
    const progressLogPath = join(directory, 'progress.jsonl');
    const sessions = [
      sessionFixture('2026-04-27-rth', 'calibration'),
      sessionFixture('2026-04-24-rth', 'validation'),
    ];
    const first = runCalibration({
      rootDirectory: directory,
      inputName: 'checkpointed',
      outName: 'first.json',
      sessions,
      minBucketSample: 1,
      progressLogPath,
      progressEveryRecords: 1,
      checkpointPath,
    });
    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8')) as Record<string, any>;
    const progressEvents = readFileSync(progressLogPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, any>);

    expect(first.exitCode).toBe(0);
    expect(checkpoint).toMatchObject({
      calibration_checkpoint_schema_version: 1,
      ticket_id: 'SIM-03',
      processed_session_ids: ['2026-04-24-rth', '2026-04-27-rth'],
    });
    expect(checkpoint.lineage.manifest_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(checkpoint.marketable_observations.count).toBeGreaterThan(0);
    expect(checkpoint.limit_observations.count).toBeGreaterThan(0);
    expect(progressEvents.map((event) => event.event_type)).toEqual(
      expect.arrayContaining([
        'run_started',
        'session_started',
        'records_processed',
        'schema_completed',
        'session_completed',
        'checkpoint_written',
        'run_completed',
      ]),
    );
    const recordEvent = progressEvents.find((event) => event.event_type === 'records_processed');
    expect(recordEvent).toBeDefined();
    expect(recordEvent).toMatchObject({
      schema_records: expect.any(Number),
      total_records: expect.any(Number),
    });
    expect(recordEvent!.memory.python_traced_current_bytes).toEqual(expect.any(Number));
    expect(progressEvents.find((event) => event.event_type === 'session_completed')).toMatchObject({
      processed_sessions: 1,
      total_sessions: 2,
    });

    const resumed = runCalibration({
      rootDirectory: directory,
      inputName: 'checkpointed',
      outName: 'resumed.json',
      sessions,
      minBucketSample: 1,
      resumeFromCheckpointPath: checkpointPath,
    });

    expect(resumed.exitCode).toBe(0);
    expect(readFileSync(resumed.reportPath, 'utf8')).toBe(readFileSync(first.reportPath, 'utf8'));
  });

  it('resumes from a partial checkpoint after an interrupted session scan', () => {
    const directory = makeTempDir();
    const checkpointPath = join(directory, 'partial-checkpoint.json');
    const sessions = [
      sessionFixture('2026-04-27-rth', 'calibration'),
      sessionFixture('2026-04-24-rth', 'validation'),
      sessionFixture('2026-04-23-rth', 'calibration'),
    ];
    const fresh = runCalibration({
      rootDirectory: directory,
      inputName: 'partial',
      outName: 'fresh.json',
      sessions,
      minBucketSample: 1,
    });
    const interrupted = runCalibration({
      rootDirectory: directory,
      inputName: 'partial',
      outName: 'interrupted.json',
      sessions,
      minBucketSample: 1,
      checkpointPath,
      allowFailure: true,
      beforeRun: ({ materializedSessions }) => {
        unlinkSync(String(materializedSessions[1].schemas['mbp-1'].path));
      },
    });
    const partialCheckpoint = JSON.parse(readFileSync(checkpointPath, 'utf8')) as Record<string, any>;

    expect(interrupted.exitCode).toBe(1);
    expect(interrupted.stderr).toContain('mbp-1');
    expect(partialCheckpoint.processed_session_ids).toEqual(['2026-04-23-rth']);

    const resumed = runCalibration({
      rootDirectory: directory,
      inputName: 'partial',
      outName: 'resumed.json',
      sessions,
      minBucketSample: 1,
      resumeFromCheckpointPath: checkpointPath,
    });

    expect(resumed.exitCode).toBe(0);
    expect(readFileSync(resumed.reportPath, 'utf8')).toBe(readFileSync(fresh.reportPath, 'utf8'));
  });

  it('rejects checkpoints whose lineage does not match the current corpus inputs', () => {
    const directory = makeTempDir();
    const checkpointPath = join(directory, 'lineage-checkpoint.json');
    const sessions = [
      sessionFixture('2026-04-27-rth', 'calibration'),
      sessionFixture('2026-04-24-rth', 'validation'),
    ];
    const first = runCalibration({
      rootDirectory: directory,
      inputName: 'lineage',
      outName: 'first.json',
      sessions,
      minBucketSample: 1,
      checkpointPath,
    });
    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8')) as Record<string, any>;
    checkpoint.lineage.manifest_hash = '0'.repeat(64);
    writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), 'utf8');

    const rejected = runCalibration({
      rootDirectory: directory,
      inputName: 'lineage',
      outName: 'rejected.json',
      sessions,
      minBucketSample: 1,
      resumeFromCheckpointPath: checkpointPath,
      allowFailure: true,
    });

    expect(first.exitCode).toBe(0);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain('checkpoint lineage does not match current calibration inputs');
    expect(rejected.stderr).toContain('expected=');
    expect(rejected.stderr).toContain('found=');
  });
});

function runCalibration(input: {
  readonly rootDirectory?: string;
  readonly inputName?: string;
  readonly outName?: string;
  readonly sessions: readonly SessionFixture[];
  readonly minBucketSample: number;
  readonly progressLogPath?: string;
  readonly progressEveryRecords?: number;
  readonly checkpointPath?: string;
  readonly resumeFromCheckpointPath?: string;
  readonly allowFailure?: boolean;
  readonly beforeRun?: (context: {
    readonly materializedSessions: readonly Record<string, any>[];
    readonly manifestPath: string;
    readonly thresholdsPath: string;
    readonly verifiedPath: string;
    readonly reportPath: string;
  }) => void;
}): {
  readonly exitCode: number | null;
  readonly report: Record<string, any>;
  readonly reportPath: string;
  readonly markdownPath: string;
  readonly stderr: string;
} {
  const directory = input.rootDirectory ?? makeTempDir();
  mkdirSync(directory, { recursive: true });
  const inputName = input.inputName ?? input.outName ?? 'out';
  const manifestPath = join(directory, `manifest-${inputName}.json`);
  const thresholdsPath = join(directory, `thresholds-${inputName}.json`);
  const verifiedPath = join(directory, `verified-${inputName}.json`);
  const reportPath = join(directory, input.outName ?? 'out.json');
  const markdownPath = join(directory, `${input.outName ?? 'out'}.md`);
  const sessions = input.sessions.map((session) => materializeSession(directory, session));
  const manifest = baseManifest(sessions);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  writeFileSync(thresholdsPath, JSON.stringify(thresholds(), null, 2), 'utf8');
  const verified = {
    verified_report_schema_version: 1,
    ticket_id: 'SIM-03A-2',
    status: 'verified',
    ready_for_sim03_model_fitting: true,
    source_manifest_hash: sha256File(manifestPath),
    thresholds_config_hash: sha256File(thresholdsPath),
    corpus_summary: {
      quality_excluded_sessions: 0,
    },
    sessions: sessions.map((session) => ({
      session_id: session.session_id,
      status: 'verified',
    })),
  };
  writeFileSync(verifiedPath, JSON.stringify(verified, null, 2), 'utf8');
  input.beforeRun?.({
    materializedSessions: sessions,
    manifestPath,
    thresholdsPath,
    verifiedPath,
    reportPath,
  });

  const args = [
    SCRIPT,
    '--manifest',
    manifestPath,
    '--verified-report',
    verifiedPath,
    '--thresholds',
    thresholdsPath,
    '--calibrated-at-ts-ns',
    CALIBRATED_AT_TS_NS,
    '--min-bucket-sample',
    String(input.minBucketSample),
    '--out',
    reportPath,
    '--markdown-out',
    markdownPath,
  ];
  if (input.progressLogPath !== undefined) {
    args.push('--progress-log', input.progressLogPath);
  }
  if (input.progressEveryRecords !== undefined) {
    args.push('--progress-every-records', String(input.progressEveryRecords));
  }
  if (input.checkpointPath !== undefined) {
    args.push('--checkpoint', input.checkpointPath);
  }
  if (input.resumeFromCheckpointPath !== undefined) {
    args.push('--resume-from-checkpoint', input.resumeFromCheckpointPath);
  }

  const result = spawnSync(PYTHON, args, { cwd: process.cwd(), encoding: 'utf8' });

  if (result.status !== 0 && result.status !== 2 && input.allowFailure !== true) {
    throw new Error(`calibrator failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return {
    exitCode: result.status,
    report: existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, any> : {},
    reportPath,
    markdownPath,
    stderr: result.stderr,
  };
}

type SessionFixture = {
  readonly sessionId: string;
  readonly split: 'calibration' | 'validation';
  readonly validationSlippagePoints: number;
};

function sessionFixture(
  sessionId: string,
  split: 'calibration' | 'validation',
  options: { readonly validationSlippagePoints?: number } = {},
): SessionFixture {
  return {
    sessionId,
    split,
    validationSlippagePoints: options.validationSlippagePoints ?? 0,
  };
}

function materializeSession(directory: string, fixture: SessionFixture): Record<string, any> {
  const sessionDir = join(directory, fixture.sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const start = 1_000_000_000;
  const end = 30_000_000_000;
  const bid = fixedPrice(100);
  const ask = fixedPrice(100.25);
  const tradePrice = fixedPrice(100.25 + fixture.validationSlippagePoints);
  const files = {
    'mbp-1': [
      { ts_event: start, bid_px_00: bid, ask_px_00: ask },
      { ts_event: start + 5_000_000_000, bid_px_00: bid, ask_px_00: ask },
    ],
    trades: [
      { ts_event: start + 1_000_000_000, price: tradePrice, size: 1, side: 'A' },
      { ts_event: start + 2_000_000_000, price: tradePrice, size: 1, side: 'A' },
    ],
    mbo: [
      { ts_event: start + 100_000_000, order_id: 1, price: bid, size: 1, action: 'A', side: 'B' },
      { ts_event: start + 200_000_000, order_id: 1, price: bid, size: 1, action: 'T', side: 'B' },
      { ts_event: start + 300_000_000, order_id: 2, price: bid, size: 1, action: 'A', side: 'B' },
      { ts_event: start + 400_000_000, order_id: 2, price: bid, size: 1, action: 'C', side: 'B' },
    ],
    'mbp-10': [{ ts_event: start, bid_px_00: bid, ask_px_00: ask }],
    definition: [{ ts_event: 0, raw_symbol: 'MNQM6' }],
  };
  const schemas: Record<string, any> = {};
  for (const [schema, records] of Object.entries(files)) {
    const path = join(sessionDir, `${schema}.jsonl`);
    writeJsonl(path, records);
    schemas[schema] = {
      schema,
      status: 'available',
      path,
      byte_count: Buffer.byteLength(readFileSync(path)),
      start_ts_ns: String(start),
      end_ts_ns: String(end),
      attempts: 1,
      reused_existing: false,
    };
  }
  return {
    session_id: fixture.sessionId,
    symbol: 'MNQM6',
    status: 'complete',
    split: fixture.split,
    rth_window: {
      start_ts_ns: String(start),
      end_ts_ns: String(end),
    },
    definition_snapshot_window: {
      start_ts_ns: '0',
      end_ts_ns: '1000000000',
    },
    exclusion_reason: null,
    schemas,
  };
}

function baseManifest(sessions: readonly Record<string, any>[]): Record<string, any> {
  return {
    manifest_schema_version: 1,
    ticket_id: 'SIM-03A-1',
    status: 'complete',
    dataset: 'GLBX.MDP3',
    symbol: 'MNQM6',
    ready_for_sim03_model_fitting: true,
    corpus_summary: {
      requested_sessions: sessions.length,
      complete_sessions: sessions.length,
      excluded_sessions: 0,
      partial_sessions: 0,
      total_bytes: 1,
    },
    sessions,
  };
}

function thresholds(): Record<string, any> {
  return {
    thresholds_schema_version: 1,
    ticket_id: 'SIM-03A-2',
    dataset: 'GLBX.MDP3',
    symbol: 'MNQM6',
    schemas: {
      trades: { min_byte_count: 1 },
      'mbp-1': { min_byte_count: 1 },
      'mbp-10': { min_byte_count: 1 },
      mbo: { min_byte_count: 1 },
      definition: { min_byte_count: 1 },
    },
  };
}

function writeJsonl(path: string, records: readonly Record<string, unknown>[]): void {
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
}

function fixedPrice(points: number): number {
  return Math.round(points * 1_000_000_000);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
