import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkpointPath, quarantinePath, readCheckpoint } from '../src/ingest/checkpoint.js';
import { ingestJournalOnce } from '../src/ingest/journal-tail.js';

const tempDirs: string[] = [];
const fixturePath = resolve(
  findRepoRoot(process.cwd()),
  'apps/strategy_runtime/tests/fixtures/obs00/mini-journal.jsonl',
);

function findRepoRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(current, 'package.json'), 'utf8')) as {
        name?: string;
      };
      if (manifest.name === 'quant-futures-app') {
        return current;
      }
    } catch {
      // Keep walking.
    }
    const parent = resolve(current, '..');
    if (parent === current) {
      throw new Error('Unable to find quant-futures-app repo root');
    }
    current = parent;
  }
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'operator-console-tail-'));
  tempDirs.push(root);
  return root;
}

function firstFixtureLine(): string {
  return readFileSync(fixturePath, 'utf8').split(/\r?\n/)[0]!;
}

describe('operator console journal tailer', () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('ingests complete valid lines and checkpoints by byte offset and last event id', () => {
    const root = tempRoot();
    const journal = join(root, 'rel00_controlled_live_sim_journal.jsonl');
    const checkpointDir = join(root, 'console-checkpoints');
    writeFileSync(journal, `${firstFixtureLine()}\n`, 'utf8');

    const result = ingestJournalOnce({ journal_path: journal, checkpoint_dir: checkpointDir });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.event.event_id).toBe('config-1');
    expect(result.events[0]?.byte_offset_start).toBe(0);
    expect(result.events[0]?.line_number).toBe(1);
    expect(result.malformed_lines).toEqual([]);
    expect(readCheckpoint(checkpointDir).files[resolve(journal)]?.last_event_id).toBe('config-1');
    expect(readFileSync(checkpointPath(checkpointDir), 'utf8')).toContain('config-1');
  });

  it('does not reprocess checkpointed lines on resume', () => {
    const root = tempRoot();
    const journal = join(root, 'rel00_controlled_live_sim_journal.jsonl');
    const checkpointDir = join(root, 'console-checkpoints');
    writeFileSync(journal, `${firstFixtureLine()}\n`, 'utf8');

    expect(ingestJournalOnce({ journal_path: journal, checkpoint_dir: checkpointDir }).events).toHaveLength(1);
    expect(ingestJournalOnce({ journal_path: journal, checkpoint_dir: checkpointDir }).events).toHaveLength(0);
  });

  it('quarantines malformed and schema-invalid newline-terminated lines', () => {
    const root = tempRoot();
    const journal = join(root, 'rel00_controlled_live_sim_journal.jsonl');
    const checkpointDir = join(root, 'console-checkpoints');
    writeFileSync(
      journal,
      [
        '{bad json',
        JSON.stringify({
          schema_version: 1,
          event_id: 'bad-1',
          type: 'CONFIG',
          ts_ns: '1700000000000000000',
          run_id: 'run-1',
          session_id: 'session-1',
          payload: {},
        }),
        firstFixtureLine(),
        '',
      ].join('\n'),
      'utf8',
    );

    const result = ingestJournalOnce({ journal_path: journal, checkpoint_dir: checkpointDir });

    expect(result.events).toHaveLength(1);
    expect(result.malformed_lines).toHaveLength(2);
    const quarantine = readFileSync(quarantinePath(checkpointDir), 'utf8');
    expect(quarantine).toContain('bad json');
    expect(quarantine).toContain('journal event schema validation failed');
  });

  it('holds partial trailing lines until newline termination', () => {
    const root = tempRoot();
    const journal = join(root, 'rel00_controlled_live_sim_journal.jsonl');
    const checkpointDir = join(root, 'console-checkpoints');
    const line = firstFixtureLine();
    writeFileSync(journal, line, 'utf8');

    const partial = ingestJournalOnce({ journal_path: journal, checkpoint_dir: checkpointDir });
    expect(partial.events).toHaveLength(0);
    expect(partial.malformed_lines).toHaveLength(0);
    expect(readCheckpoint(checkpointDir).files[resolve(journal)]?.offset_bytes).toBe(0);

    appendFileSync(journal, '\n', 'utf8');
    const complete = ingestJournalOnce({ journal_path: journal, checkpoint_dir: checkpointDir });
    expect(complete.events).toHaveLength(1);
    expect(complete.events[0]?.event.event_id).toBe('config-1');
  });

  it('resets checkpoint when a file is truncated', () => {
    const root = tempRoot();
    const journal = join(root, 'rel00_controlled_live_sim_journal.jsonl');
    const checkpointDir = join(root, 'console-checkpoints');
    writeFileSync(journal, `${firstFixtureLine()}\n`, 'utf8');
    expect(ingestJournalOnce({ journal_path: journal, checkpoint_dir: checkpointDir }).events).toHaveLength(1);

    writeFileSync(journal, '\n', 'utf8');
    const truncated = ingestJournalOnce({ journal_path: journal, checkpoint_dir: checkpointDir });
    expect(truncated.events).toHaveLength(0);
    expect(readCheckpoint(checkpointDir).files[resolve(journal)]?.offset_bytes).toBe(1);

    appendFileSync(journal, `${firstFixtureLine()}\n`, 'utf8');
    const result = ingestJournalOnce({ journal_path: journal, checkpoint_dir: checkpointDir });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.line_number).toBe(2);
  });
});
