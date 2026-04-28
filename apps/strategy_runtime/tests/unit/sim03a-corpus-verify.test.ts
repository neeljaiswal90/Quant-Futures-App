import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const PYTHON = process.env.PYTHON ?? 'python';
const SCRIPT = 'scripts/sim/verify-databento-sim03-corpus.py';
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-sim03a-verify-'));
  tempDirectories.push(directory);
  return directory;
}

describe('SIM-03A-2 corpus integrity verifier', () => {
  it('writes sha256 checksums and returns ready for a verified corpus', () => {
    const result = runVerifier({
      sessions: [
        completeSession('2026-04-27-rth'),
        completeSession('2026-04-24-rth'),
      ],
      thresholds: thresholds({ minVerifiedSessions: 2 }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.report).toMatchObject({
      verified_report_schema_version: 1,
      ticket_id: 'SIM-03A-2',
      status: 'verified',
      ready_for_sim03_model_fitting: true,
      verified_at_ts_ns: '1777392000000000000',
      corpus_summary: {
        verified_sessions: 2,
        failed_sessions: 0,
        quality_excluded_sessions: 0,
      },
    });
    const sha = result.report.sessions[0].schemas.trades.sha256;
    expect(sha).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.report.thresholds_config_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.report.source_manifest_hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('keeps degraded sessions out of the model-fitting count without failing integrity', () => {
    const result = runVerifier({
      sessions: [
        completeSession('2026-04-27-rth'),
        completeSession('2026-04-10-rth'),
      ],
      thresholds: thresholds({
        minVerifiedSessions: 1,
        qualityExclusions: {
          '2026-04-10-rth': { reason: 'databento_condition_degraded_warning' },
        },
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.report.corpus_summary).toMatchObject({
      verified_sessions: 1,
      quality_excluded_sessions: 1,
      failed_sessions: 0,
    });
    expect(result.report.sessions.find((session: any) => session.session_id === '2026-04-10-rth')).toMatchObject({
      status: 'quality_excluded',
      quality_exclusion_reason: 'databento_condition_degraded_warning',
    });
  });

  it('fails with exit code 2 when a file is below its configured byte floor', () => {
    const result = runVerifier({
      sessions: [completeSession('2026-04-27-rth', { trades: 'tiny' })],
      thresholds: thresholds({ minVerifiedSessions: 1, schemaFloors: { trades: 100 } }),
    });

    expect(result.exitCode).toBe(2);
    expect(result.report).toMatchObject({
      status: 'failed',
      ready_for_sim03_model_fitting: false,
      corpus_summary: {
        failed_sessions: 1,
        verified_sessions: 0,
      },
    });
    expect(result.report.sessions[0].schemas.trades.failure_reasons[0]).toContain('below minimum');
  });

  it('fails when a manifest file path is missing', () => {
    const result = runVerifier({
      sessions: [completeSession('2026-04-27-rth', {}, { omitFileForSchema: 'mbo' })],
      thresholds: thresholds({ minVerifiedSessions: 1 }),
    });

    expect(result.exitCode).toBe(2);
    expect(result.report.sessions[0].schemas.mbo).toMatchObject({
      status: 'failed',
      sha256_valid: false,
      failure_reasons: ['schema file is missing'],
    });
  });

  it('returns exit code 1 for a missing caller-provided verification timestamp', () => {
    const directory = makeTempDir();
    const result = spawnSync(
      PYTHON,
      [
        SCRIPT,
        '--manifest',
        join(directory, 'manifest.json'),
        '--thresholds',
        join(directory, 'thresholds.json'),
        '--out',
        join(directory, 'report.json'),
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('verified-at-ts-ns');
  });
});

function runVerifier(input: {
  readonly sessions: readonly SessionFixture[];
  readonly thresholds: Record<string, unknown>;
}): {
  readonly exitCode: number | null;
  readonly report: Record<string, any>;
} {
  const directory = makeTempDir();
  const manifestPath = join(directory, 'manifest.json');
  const thresholdsPath = join(directory, 'thresholds.json');
  const reportPath = join(directory, 'verified.json');
  const sessions = input.sessions.map((session) => materializeSession(directory, session));
  const manifest = {
    manifest_schema_version: 1,
    ticket_id: 'SIM-03A-1',
    status: 'complete',
    ready_for_sim03_model_fitting: true,
    dataset: 'GLBX.MDP3',
    symbol: 'MNQM6',
    corpus_summary: {
      requested_sessions: sessions.length,
      complete_sessions: sessions.length,
      excluded_sessions: 0,
      partial_sessions: 0,
      total_bytes: sessions.reduce(
        (sum, session) =>
          sum + Object.values(session.schemas).reduce((schemaSum: number, schema: any) => schemaSum + schema.byte_count, 0),
        0,
      ),
    },
    sessions,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  writeFileSync(thresholdsPath, JSON.stringify(input.thresholds), 'utf8');

  const result = spawnSync(
    PYTHON,
    [
      SCRIPT,
      '--manifest',
      manifestPath,
      '--thresholds',
      thresholdsPath,
      '--verified-at-ts-ns',
      '1777392000000000000',
      '--out',
      reportPath,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );

  if (result.status !== 0 && result.status !== 2) {
    throw new Error(`verifier failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return {
    exitCode: result.status,
    report: JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, any>,
  };
}

type SessionFixture = {
  readonly sessionId: string;
  readonly contents: Record<string, string>;
  readonly omitFileForSchema?: string;
};

function completeSession(
  sessionId: string,
  contentOverrides: Record<string, string> = {},
  options: { readonly omitFileForSchema?: string } = {},
): SessionFixture {
  return {
    sessionId,
    contents: {
      trades: 'trade rows\n'.repeat(20),
      'mbp-1': 'mbp1 rows\n'.repeat(20),
      'mbp-10': 'mbp10 rows\n'.repeat(20),
      mbo: 'mbo rows\n'.repeat(20),
      definition: 'definition',
      ...contentOverrides,
    },
    omitFileForSchema: options.omitFileForSchema,
  };
}

function materializeSession(directory: string, fixture: SessionFixture): Record<string, any> {
  const sessionDir = join(directory, fixture.sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const schemas: Record<string, any> = {};
  for (const [schema, content] of Object.entries(fixture.contents)) {
    const path = join(sessionDir, `${schema}.dbn.zst`);
    if (schema !== fixture.omitFileForSchema) {
      writeFileSync(path, content, 'utf8');
    }
    schemas[schema] = {
      schema,
      status: 'available',
      path,
      byte_count: Buffer.byteLength(content),
      start_ts_ns: '1777296600000000000',
      end_ts_ns: '1777320000000000000',
      attempts: 1,
      reused_existing: false,
    };
  }
  return {
    session_id: fixture.sessionId,
    symbol: 'MNQM6',
    status: 'complete',
    split: 'calibration',
    rth_window: {
      start_ts_ns: '1777296600000000000',
      end_ts_ns: '1777320000000000000',
    },
    definition_snapshot_window: {
      start_ts_ns: '1777248000000000000',
      end_ts_ns: '1777248001000000000',
    },
    exclusion_reason: null,
    schemas,
  };
}

function thresholds(input: {
  readonly minVerifiedSessions?: number;
  readonly schemaFloors?: Record<string, number>;
  readonly qualityExclusions?: Record<string, { readonly reason: string }>;
} = {}): Record<string, unknown> {
  const defaultFloor = 1;
  return {
    thresholds_schema_version: 1,
    ticket_id: 'SIM-03A-2',
    dataset: 'GLBX.MDP3',
    symbol: 'MNQM6',
    min_verified_sessions: input.minVerifiedSessions ?? 1,
    quality_exclusions: input.qualityExclusions ?? {},
    schemas: {
      trades: { min_byte_count: input.schemaFloors?.trades ?? defaultFloor },
      'mbp-1': { min_byte_count: input.schemaFloors?.['mbp-1'] ?? defaultFloor },
      'mbp-10': { min_byte_count: input.schemaFloors?.['mbp-10'] ?? defaultFloor },
      mbo: { min_byte_count: input.schemaFloors?.mbo ?? defaultFloor },
      definition: { min_byte_count: input.schemaFloors?.definition ?? defaultFloor },
    },
  };
}
