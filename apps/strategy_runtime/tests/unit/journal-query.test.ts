import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatJournalQueryResult,
  parseJournalQueryArgs,
  runJournalQuery,
} from '../../../../scripts/journal/journal-query.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(TEST_DIR, '..', 'fixtures', 'obs00');
const JOURNAL_PATH = join(FIXTURE_DIR, 'mini-journal.jsonl');
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function readFixtureJournal(): string {
  return readFileSync(JOURNAL_PATH, 'utf8').replace(/\r\n/g, '\n');
}

function runCli(args: readonly string[], input?: string): ReturnType<typeof spawnSync> {
  const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.cjs');
  return spawnSync(process.execPath, [tsxCli, 'scripts/journal/journal-query.ts', ...args], {
    cwd: process.cwd(),
    input,
    encoding: 'utf8',
  });
}

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

describe('TUI-04 journal-query CLI', () => {
  it('query by candidate returns the full fixture causation chain', () => {
    const result = runJournalQuery(
      parseJournalQueryArgs([
        '--journal',
        JOURNAL_PATH,
        '--candidate',
        'candidate-obs00-1',
      ]),
    );
    const output = formatJournalQueryResult(result);

    expect(result.exit_code).toBe(0);
    expect(result.missing).toEqual([]);
    expect(result.events.map((event) => event.event_id)).toEqual([
      'bar-1',
      'features-1',
      'structure-1',
      'strat-eval-1',
      'candidate-1',
      'risk-1',
      'sizing-1',
      'order-1',
      'fill-1',
      'position-1',
      'mgmt-tick-1',
      'mgmt-action-1',
    ]);
    expect(output.stdout).toContain('candidate=candidate-obs00-1');
    expect(output.stdout).toContain('fill=fill-obs00-1');
    expect(output.stdout).toContain('position=position-obs00-1');
  });

  it('query by event returns the event, direct cause, and direct children', () => {
    const result = runJournalQuery(
      parseJournalQueryArgs(['--journal', JOURNAL_PATH, '--event', 'candidate-1']),
    );

    expect(result.exit_code).toBe(0);
    expect(result.events.map((event) => event.event_id)).toEqual([
      'strat-eval-1',
      'candidate-1',
      'risk-1',
    ]);
  });

  it('query by strategy filters correctly', () => {
    const result = runJournalQuery(
      parseJournalQueryArgs([
        '--journal',
        JOURNAL_PATH,
        '--strategy',
        'trend_pullback_long',
      ]),
    );

    expect(result.exit_code).toBe(0);
    expect(result.events.map((event) => event.type)).toEqual(['STRAT_EVAL', 'CANDIDATE']);
    expect(
      result.events.every((event) => {
        const payload = event.payload as Record<string, unknown>;
        return payload.strategy_id === 'trend_pullback_long';
      }),
    ).toBe(true);
  });

  it('query by event type filters correctly across deterministic directory order', () => {
    const directory = tempDir('qfa-journal-query-dir-');
    const lines = readFixtureJournal().trimEnd().split('\n');
    writeFileSync(join(directory, '002.jsonl'), `${lines.slice(12).join('\n')}\n`, 'utf8');
    writeFileSync(join(directory, '001.jsonl'), `${lines.slice(0, 12).join('\n')}\n`, 'utf8');

    const result = runJournalQuery(
      parseJournalQueryArgs(['--journal-dir', directory, '--type', 'SIM_FILL']),
    );

    expect(result.exit_code).toBe(0);
    expect(result.source_files).toEqual(['001.jsonl', '002.jsonl']);
    expect(result.events.map((event) => event.event_id)).toEqual(['fill-1']);
  });

  it('JSON output is valid, deterministic, and preserves timestamp strings', () => {
    const options = parseJournalQueryArgs([
      '--journal',
      JOURNAL_PATH,
      '--event',
      'candidate-1',
      '--format',
      'json',
    ]);
    const first = formatJournalQueryResult(runJournalQuery(options));
    const second = formatJournalQueryResult(runJournalQuery(options));

    expect(first.stdout).toBe(second.stdout);
    const parsed = JSON.parse(first.stdout) as {
      readonly events: readonly { readonly event_id: string; readonly ts_ns: string }[];
    };
    expect(parsed.events.map((event) => event.event_id)).toEqual([
      'strat-eval-1',
      'candidate-1',
      'risk-1',
    ]);
    expect(parsed.events[0]!.ts_ns).toBe('1700000000060000000');
    expect(typeof parsed.events[0]!.ts_ns).toBe('string');
  });

  it('text output is byte-stable across two runs', () => {
    const options = parseJournalQueryArgs([
      '--journal',
      JOURNAL_PATH,
      '--position',
      'position-obs00-1',
    ]);
    const first = formatJournalQueryResult(runJournalQuery(options));
    const second = formatJournalQueryResult(runJournalQuery(options));

    expect(first.stdout).toBe(second.stdout);
    expect(first.stderr).toBe('');
    expect(first.stdout).toContain('SIM_FILL event=fill-1');
    expect(first.stdout).toContain('MGMT_ACTION event=mgmt-action-1');
  });

  it('missing id returns non-zero exit and clear message', () => {
    const result = runCli(['--journal', JOURNAL_PATH, '--event', 'does-not-exist']);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('missing in journal id=does-not-exist');
    expect(result.stderr).toContain('missing in journal: does-not-exist');
  });

  it('malformed journal lines are reported without crashing unless strict is enabled', () => {
    const directory = tempDir('qfa-journal-query-malformed-');
    const journalPath = join(directory, 'malformed.jsonl');
    const firstLine = readFixtureJournal().trimEnd().split('\n')[0]!;
    writeFileSync(journalPath, `${firstLine}\n{"bad":\n`, 'utf8');

    const nonStrict = runCli(['--journal', journalPath, '--type', 'CONFIG']);
    expect(nonStrict.status).toBe(0);
    expect(nonStrict.stdout).toContain('CONFIG event=config-1');
    expect(nonStrict.stderr).toContain('malformed.jsonl:2:');

    const strict = runCli(['--journal', journalPath, '--type', 'CONFIG', '--strict']);
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain('CONFIG event=config-1');
    expect(strict.stderr).toContain('malformed.jsonl:2:');
  });
});
