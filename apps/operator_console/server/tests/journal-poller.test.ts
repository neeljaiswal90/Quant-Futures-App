import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConsoleJournalPoller } from '../src/ingest/journal-poller.js';
import { type JournalIngestOptions } from '../src/ingest/options.js';

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
  const root = mkdtempSync(join(tmpdir(), 'operator-console-poller-'));
  tempDirs.push(root);
  return root;
}

function fixtureLines(): readonly string[] {
  return readFileSync(fixturePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(0, 3);
}

function options(root: string): JournalIngestOptions {
  return {
    journal_dir: root,
    journal_glob: 'rel00_controlled_live_sim_journal*.jsonl',
    checkpoint_dir: join(root, 'console-checkpoints'),
    mode: 'live',
    poll_ms: 250,
  };
}

describe('operator console journal poller', () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('switches to a newer active journal after draining the current file without missing first line', () => {
    const root = tempRoot();
    const [first, second, third] = fixtureLines();
    const journalA = join(root, 'rel00_controlled_live_sim_journal_a.jsonl');
    const journalB = join(root, 'rel00_controlled_live_sim_journal_b.jsonl');
    writeFileSync(journalA, `${first}\n`, 'utf8');
    utimesSync(journalA, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

    const poller = new ConsoleJournalPoller(options(root));
    const firstPoll = poller.pollOnce();
    expect(firstPoll.events.map((event) => event.event.event_id)).toEqual(['config-1']);
    expect(firstPoll.switched_journal).toBe(false);

    writeFileSync(journalA, `${first}\n${second}\n`, 'utf8');
    writeFileSync(journalB, `${third}\n`, 'utf8');
    utimesSync(journalB, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));

    const secondPoll = poller.pollOnce();
    expect(secondPoll.switched_journal).toBe(true);
    expect(secondPoll.events.map((event) => event.event.event_id)).toEqual(['conn-1', 'feed-warm-1']);
    expect(secondPoll.selection.journal_path).toBe(journalB);
  });
});
