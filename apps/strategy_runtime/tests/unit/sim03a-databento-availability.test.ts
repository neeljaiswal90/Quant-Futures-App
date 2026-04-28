import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const PYTHON = process.env.PYTHON ?? 'python';
const SCRIPT = 'scripts/sim/check-databento-mnq-availability.py';
const START = '2026-04-27T13:30:00Z';
const END = '2026-04-27T20:00:00Z';
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-sim03a-'));
  tempDirectories.push(directory);
  return directory;
}

describe('SIM-03A-0 Databento MNQ availability preflight', () => {
  it('returns ready when all fixture-backed schemas are available', () => {
    const report = runAvailability({
      dataset_range: {
        start: '2017-05-21T00:00:00Z',
        end: '2026-04-27T20:00:00Z',
      },
      schemas: {
        trades: { sample_record_count: 100 },
        'mbp-1': { sample_record_count: 100 },
        'mbp-10': { sample_record_count: 100 },
        mbo: { sample_record_count: 100 },
        definition: { sample_record_count: 3 },
      },
    });

    expect(report.exitCode).toBe(0);
    expect(report.body).toMatchObject({
      availability_report_schema_version: 1,
      ticket_id: 'SIM-03A-0',
      status: 'ready',
      dataset: 'GLBX.MDP3',
      symbol: 'MNQM6',
      databento_api_key_present: true,
      ready_for_sim03_calibration_corpus: true,
      blocked_reason: null,
      schemas: {
        trades: { available: true, sample_record_count: 100 },
        'mbp-10': { available: true, sample_record_count: 100 },
        mbo: { available: true, sample_record_count: 100 },
        definition: { available: true, sample_record_count: 3 },
      },
    });
    expect(JSON.stringify(report.body)).not.toContain('db-');
  });

  it('returns structured exit code 2 when MBO is unavailable', () => {
    const report = runAvailability({
      dataset_range: {
        start: '2017-05-21T00:00:00Z',
        end: '2026-04-27T20:00:00Z',
      },
      schemas: {
        trades: { sample_record_count: 100 },
        'mbp-1': { sample_record_count: 100 },
        'mbp-10': { sample_record_count: 100 },
        mbo: { error: 'delay window not yet open' },
        definition: { sample_record_count: 3 },
      },
    });

    expect(report.exitCode).toBe(2);
    expect(report.body).toMatchObject({
      status: 'blocked',
      ready_for_sim03_calibration_corpus: false,
      schemas: {
        mbo: {
          available: false,
          sample_record_count: 0,
          error: 'delay window not yet open',
        },
      },
    });
    expect(report.body.blocked_reason).toContain('mbo: delay window not yet open');
  });

  it('redacts Databento-looking tokens from provider errors', () => {
    const report = runAvailability({
      dataset_range: {
        start: '2017-05-21T00:00:00Z',
        end: '2026-04-27T20:00:00Z',
      },
      schemas: {
        trades: { sample_record_count: 100 },
        'mbp-1': { sample_record_count: 100 },
        'mbp-10': { sample_record_count: 100 },
        mbo: { error: 'auth failed for token db-secretShouldNeverLand' },
        definition: { sample_record_count: 3 },
      },
    });

    const rendered = JSON.stringify(report.body);
    expect(rendered).not.toContain('db-secretShouldNeverLand');
    expect(rendered).toContain('db-[REDACTED]');
  });

  it('reports missing DATABENTO_API_KEY without importing Databento or leaking secrets', () => {
    const directory = makeTempDir();
    const reportPath = join(directory, 'availability.json');
    const env = { ...process.env };
    delete env.DATABENTO_API_KEY;

    const result = spawnSync(
      PYTHON,
      [
        SCRIPT,
        '--session-id',
        '2026-04-27-rth',
        '--start',
        START,
        '--end',
        END,
        '--out',
        reportPath,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env,
      },
    );

    expect(result.status).toBe(2);
    const body = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
    expect(body).toMatchObject({
      databento_api_key_present: false,
      ready_for_sim03_calibration_corpus: false,
      blocked_reason: 'DATABENTO_API_KEY is not set',
    });
    expect(result.stdout).not.toContain('db-');
    expect(result.stderr).toBe('');
  });

  it('returns exit code 1 for argument validation errors', () => {
    const result = spawnSync(
      PYTHON,
      [
        SCRIPT,
        '--session-id',
        '2026-04-27-rth',
        '--start',
        END,
        '--end',
        START,
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--end must be after --start');
  });
});

function runAvailability(fixture: Record<string, unknown>): {
  readonly exitCode: number | null;
  readonly body: Record<string, any>;
} {
  const directory = makeTempDir();
  const fixturePath = join(directory, 'fixture.json');
  const reportPath = join(directory, 'availability.json');
  writeFileSync(fixturePath, JSON.stringify(fixture), 'utf8');

  const result = spawnSync(
    PYTHON,
    [
      SCRIPT,
      '--session-id',
      '2026-04-27-rth',
      '--start',
      START,
      '--end',
      END,
      '--fixture',
      fixturePath,
      '--out',
      reportPath,
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
    throw new Error(`availability check failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }

  return {
    exitCode: result.status,
    body: JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, any>,
  };
}
