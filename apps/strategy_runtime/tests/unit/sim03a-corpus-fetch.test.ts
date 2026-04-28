import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const PYTHON = process.env.PYTHON ?? 'python';
const SCRIPT = 'scripts/sim/fetch-databento-sim03-corpus.py';
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-sim03a-corpus-'));
  tempDirectories.push(directory);
  return directory;
}

describe('SIM-03A-1 Databento corpus fetch manifest', () => {
  it('fetches event schemas plus definition midnight snapshots and writes a complete manifest', () => {
    const result = runFetch({
      sessions: [
        session('2026-04-27-rth'),
        session('2026-04-28-rth'),
      ],
      fixture: fixtureAllAvailable(),
      minCompleteSessions: 2,
    });

    expect(result.exitCode).toBe(0);
    expect(result.manifest).toMatchObject({
      manifest_schema_version: 1,
      ticket_id: 'SIM-03A-1',
      status: 'complete',
      ready_for_sim03_model_fitting: true,
      corpus_summary: {
        requested_sessions: 2,
        complete_sessions: 2,
        excluded_sessions: 0,
        partial_sessions: 0,
        validation_sessions: 1,
        calibration_sessions: 1,
      },
    });
    const first = result.manifest.sessions[0];
    expect(first.schemas.trades.start_ts_ns).toBe('1777296600000000000');
    expect(first.schemas.trades.end_ts_ns).toBe('1777320000000000000');
    expect(first.schemas.definition.start_ts_ns).toBe('1777248000000000000');
    expect(first.schemas.definition.end_ts_ns).toBe('1777248001000000000');
    expect(existsSync(join(result.outDir, '2026-04-27-rth', 'mbo.dbn.zst'))).toBe(true);
    expect(first.split === 'calibration' || first.split === 'validation').toBe(true);
  });

  it('excludes short sessions and returns structured exit code 2 when minimum complete count is not met', () => {
    const result = runFetch({
      sessions: [
        {
          session_id: '2026-04-27-rth',
          start: '2026-04-27T13:30:00Z',
          end: '2026-04-27T16:00:00Z',
        },
      ],
      fixture: fixtureAllAvailable(),
      minCompleteSessions: 1,
    });

    expect(result.exitCode).toBe(2);
    expect(result.manifest).toMatchObject({
      status: 'partial',
      ready_for_sim03_model_fitting: false,
      blocked_reason: 'complete session count 0 is below required minimum 1',
      sessions: [
        {
          status: 'excluded',
          exclusion_reason: 'short_or_half_day_session',
        },
      ],
    });
  });

  it('resumes existing non-empty files without calling the fixture fetcher', () => {
    const directory = makeTempDir();
    const sessionId = '2026-04-27-rth';
    const outDir = join(directory, 'corpus');
    mkdirSync(join(outDir, sessionId), { recursive: true });
    for (const schema of ['trades', 'mbp-1', 'mbp-10', 'mbo', 'definition']) {
      writeFileSync(join(outDir, sessionId, `${schema}.dbn.zst`), `${schema}-already-present`, 'utf8');
    }

    const result = runFetch({
      baseDir: directory,
      outDir,
      sessions: [session(sessionId)],
      fixture: {
        schemas: {
          trades: { error: 'should not fetch' },
          'mbp-1': { error: 'should not fetch' },
          'mbp-10': { error: 'should not fetch' },
          mbo: { error: 'should not fetch' },
          definition: { error: 'should not fetch' },
        },
      },
      minCompleteSessions: 1,
    });

    expect(result.exitCode).toBe(0);
    expect(result.manifest.sessions[0].schemas.mbo).toMatchObject({
      status: 'available',
      attempts: 0,
      reused_existing: true,
    });
  });

  it('retries transient fetch failures before marking the session complete', () => {
    const result = runFetch({
      sessions: [session('2026-04-27-rth')],
      fixture: {
        schemas: {
          trades: { record_count: 100 },
          'mbp-1': { record_count: 100 },
          'mbp-10': { failures_before_success: 1, transient_error: 'temporary reset', record_count: 100 },
          mbo: { record_count: 100 },
          definition: { record_count: 2 },
        },
      },
      minCompleteSessions: 1,
    });

    expect(result.exitCode).toBe(0);
    expect(result.manifest.sessions[0].schemas['mbp-10']).toMatchObject({
      status: 'available',
      attempts: 2,
      reused_existing: false,
    });
  });

  it('parses the documented simple YAML session-list format', () => {
    const result = runFetch({
      sessionListText: [
        'sessions:',
        '  - session_id: 2026-04-27-rth',
        '    start: 2026-04-27T13:30:00Z',
        '    end: 2026-04-27T20:00:00Z',
      ].join('\n'),
      fixture: fixtureAllAvailable(),
      minCompleteSessions: 1,
      sessionListExtension: '.yaml',
    });

    expect(result.exitCode).toBe(0);
    expect(result.manifest.sessions[0].session_id).toBe('2026-04-27-rth');
  });
});

function runFetch(input: {
  readonly baseDir?: string;
  readonly outDir?: string;
  readonly sessions?: readonly Record<string, string>[];
  readonly sessionListText?: string;
  readonly sessionListExtension?: '.json' | '.yaml';
  readonly fixture: Record<string, unknown>;
  readonly minCompleteSessions: number;
}): {
  readonly exitCode: number | null;
  readonly manifest: Record<string, any>;
  readonly outDir: string;
} {
  const directory = input.baseDir ?? makeTempDir();
  const outDir = input.outDir ?? join(directory, 'corpus');
  const manifestPath = join(directory, 'manifest.json');
  const fixturePath = join(directory, 'fixture.json');
  const sessionListPath = join(directory, `sessions${input.sessionListExtension ?? '.json'}`);
  writeFileSync(fixturePath, JSON.stringify(input.fixture), 'utf8');
  writeFileSync(
    sessionListPath,
    input.sessionListText ?? JSON.stringify({ sessions: input.sessions }),
    'utf8',
  );

  const result = spawnSync(
    PYTHON,
    [
      SCRIPT,
      '--session-list',
      sessionListPath,
      '--out-dir',
      outDir,
      '--manifest',
      manifestPath,
      '--fixture',
      fixturePath,
      '--min-complete-sessions',
      String(input.minCompleteSessions),
      '--retry-base-sec',
      '0',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        SIM03A_FIXTURE_API_KEY_PRESENT: '1',
      },
    },
  );

  if (result.status !== 0 && result.status !== 2) {
    throw new Error(`corpus fetch failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return {
    exitCode: result.status,
    manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>,
    outDir,
  };
}

function session(sessionId: string): Record<string, string> {
  const date = sessionId.slice(0, 10);
  return {
    session_id: sessionId,
    start: `${date}T13:30:00Z`,
    end: `${date}T20:00:00Z`,
  };
}

function fixtureAllAvailable(): Record<string, unknown> {
  return {
    schemas: {
      trades: { record_count: 100 },
      'mbp-1': { record_count: 100 },
      'mbp-10': { record_count: 100 },
      mbo: { record_count: 100 },
      definition: { record_count: 2 },
    },
  };
}
