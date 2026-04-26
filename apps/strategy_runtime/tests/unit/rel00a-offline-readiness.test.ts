import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runRel00aOfflineReadiness,
  type Rel00aReport,
} from '../../../../scripts/rel/rel-00a-offline-readiness.js';

const FIXTURE_DIR = 'apps/strategy_runtime/tests/fixtures/obs00';
const TEMP_ROOTS: string[] = [];

afterEach(() => {
  for (const root of TEMP_ROOTS.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('REL-00A offline readiness checker', () => {
  it('returns pass for the committed fixture and deterministic runtime path', async () => {
    const root = makeTempRoot();

    const report = await runReadiness(root);

    expect(report.status).toBe('pass');
    expect(report.reasons).toEqual([]);
    expect(report.next_blocker).toBe('INFRA-01 verification / DATA-01');
    expect(report.fixture_checks.status).toBe('pass');
    expect(report.traceability_checks.status).toBe('pass');
  });

  it('fails when the OBS-00 fixture checksum is broken', async () => {
    const root = makeTempRoot();
    const fixtureDir = copyObsFixture(root);
    const manifestPath = join(fixtureDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.journal_sha256_lf = '0'.repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const report = await runReadiness(root, { fixture_dir: fixtureDir });

    expect(report.status).toBe('fail');
    expect(report.reasons.some((reason) => reason.includes('obs00_checksum_matches_manifest'))).toBe(true);
  });

  it('fails when the OBS-00 fixture has a schema-invalid line', async () => {
    const root = makeTempRoot();
    const fixtureDir = copyObsFixture(root);
    mutateFixtureJournal(fixtureDir, (line) => line.replace('"payload":', '"payload_broken":'));

    const report = await runReadiness(root, { fixture_dir: fixtureDir });

    expect(report.status).toBe('fail');
    expect(report.reasons.some((reason) => reason.includes('obs00_transport_ingests_without_quarantine'))).toBe(true);
  });

  it('fails when the OBS-00 fixture breaks causation invariants', async () => {
    const root = makeTempRoot();
    const fixtureDir = copyObsFixture(root);
    mutateFixtureJournal(fixtureDir, (line) =>
      line.includes('"type":"SIM_FILL"')
        ? line.replace('"causation_id":"order-1"', '"causation_id":"missing-order"')
        : line,
    );

    const report = await runReadiness(root, { fixture_dir: fixtureDir });

    expect(report.status).toBe('fail');
    expect(report.reasons.some((reason) => reason.includes('obs00_transport_ingests_without_quarantine'))).toBe(true);
  });

  it('fails when runtime output is not deterministic across two runs', async () => {
    const root = makeTempRoot();

    const report = await runReadiness(root, {
      runtime_journal_mutator: (journal, label) => (
        label === 'b'
          ? journal.replace('{', '{"nondeterministic":"b",')
          : journal
      ),
    });

    expect(report.status).toBe('fail');
    expect(report.reasons).toContain('runtime_journals_byte_identical: failed');
  });

  it('fails when the candidate provenance chain cannot be reconstructed', async () => {
    const root = makeTempRoot();

    const report = await runReadiness(root, {
      trace_candidate_id: 'candidate-does-not-exist',
    });

    expect(report.status).toBe('fail');
    expect(report.reasons.some((reason) => reason.includes('candidate_query_has_no_missing_refs'))).toBe(true);
  });

  it('writes a stable report shape', async () => {
    const root = makeTempRoot();

    const report = await runReadiness(root);
    const reportFromDisk = JSON.parse(readFileSync(report.generated_output_paths.report, 'utf8')) as Rel00aReport;

    expect(Object.keys(reportFromDisk)).toEqual([
      'config_checks',
      'determinism_checks',
      'evt_invariant_checks',
      'fixture_checks',
      'generated_output_paths',
      'journal_schema_checks',
      'next_blocker',
      'reasons',
      'schema_version',
      'status',
      'traceability_checks',
    ].sort());
    expect(reportFromDisk.status).toBe('pass');
  });
});

async function runReadiness(
  root: string,
  options: Parameters<typeof runRel00aOfflineReadiness>[0] = {},
): Promise<Rel00aReport> {
  return runRel00aOfflineReadiness({
    output_dir: join(root, 'rel00a-output'),
    report_path: join(root, 'rel00a-report.json'),
    ...options,
  });
}

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qfa-rel00a-'));
  TEMP_ROOTS.push(root);
  return root;
}

function copyObsFixture(root: string): string {
  const target = join(root, 'rel00a-fixture');
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(FIXTURE_DIR, { withFileTypes: true })) {
    if (entry.isFile()) {
      copyFileSync(join(FIXTURE_DIR, entry.name), join(target, entry.name));
    }
  }
  return target;
}

function mutateFixtureJournal(
  fixtureDir: string,
  mutateLine: (line: string) => string,
): void {
  const journalPath = join(fixtureDir, 'mini-journal.jsonl');
  const lines = readFileSync(journalPath, 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.trim() === '' ? line : mutateLine(line)));
  const journalText = lines.join('\n');
  writeFileSync(journalPath, journalText, 'utf8');
  const manifestPath = join(fixtureDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.journal_sha256_lf = sha256Lf(journalText);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function sha256Lf(value: string): string {
  return createHash('sha256').update(value.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}
