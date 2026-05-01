import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isExcludedJournalCandidate,
  selectJournalFromDirectory,
  selectJournalPath,
} from '../src/ingest/journal-discovery.js';
import { parseJournalIngestOptions } from '../src/ingest/options.js';

const tempDirs: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'operator-console-discovery-'));
  tempDirs.push(root);
  return root;
}

function writeJournal(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '\n');
}

describe('operator console journal discovery', () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('parses CLI options with CLI taking precedence over env', () => {
    const root = tempRoot();
    const options = parseJournalIngestOptions(
      [
        '--journal',
        'explicit.jsonl',
        '--journal-dir',
        'journals',
        '--journal-glob',
        'custom*.jsonl',
        '--checkpoint-dir',
        'checkpoints',
        '--mode',
        'replay',
        '--poll-ms',
        '500',
      ],
      {
        QFA_CONSOLE_JOURNAL: 'env.jsonl',
        QFA_CONSOLE_MODE: 'live',
      },
      root,
    );

    expect(options.journal).toBe(join(root, 'explicit.jsonl'));
    expect(options.journal_dir).toBe(join(root, 'journals'));
    expect(options.journal_glob).toBe('custom*.jsonl');
    expect(options.checkpoint_dir).toBe(join(root, 'checkpoints'));
    expect(options.mode).toBe('replay');
    expect(options.poll_ms).toBe(500);
  });

  it('lets explicit --journal win', () => {
    const root = tempRoot();
    const explicit = join(root, 'manual.jsonl');
    writeJournal(explicit);

    const selection = selectJournalPath({
      journal: explicit,
      journal_dir: join(root, 'missing'),
      journal_glob: 'rel00_controlled_live_sim_journal*.jsonl',
    });

    expect(selection).toMatchObject({
      journal_path: explicit,
      source: 'explicit',
      candidate_count: 1,
    });
  });

  it('selects newest matching controlled live-sim journal and excludes noisy REL files', () => {
    const root = tempRoot();
    const older = join(root, 'rel00_controlled_live_sim_journal.jsonl');
    const newer = join(root, 'rel00_controlled_live_sim_journal_2.jsonl');
    const shadow = join(root, 'rel00_controlled_live_sim_shadow_journal.jsonl');
    const sidecar = join(root, 'data01a_l1_trade.obs01.jsonl');
    writeJournal(older);
    writeJournal(newer);
    writeJournal(shadow);
    writeJournal(sidecar);

    const now = new Date();
    const prior = new Date(now.getTime() - 60_000);
    const future = new Date(now.getTime() + 60_000);
    // Keep mtime gaps large so filesystem precision does not influence selection.
    utimesSync(older, prior, prior);
    utimesSync(newer, now, now);
    utimesSync(shadow, future, future);
    utimesSync(sidecar, future, future);

    const selection = selectJournalFromDirectory(root);

    expect(selection.journal_path).toBe(newer);
    expect(selection.candidate_count).toBe(2);
  });

  it('recognizes explicit excludes', () => {
    expect(isExcludedJournalCandidate('rel00_controlled_live_sim_shadow_journal.jsonl')).toBe(true);
    expect(isExcludedJournalCandidate('rithmic_probe.jsonl')).toBe(true);
    expect(isExcludedJournalCandidate('rel00_controlled_live_sim_journal.jsonl.partial')).toBe(true);
    expect(isExcludedJournalCandidate('rel00_controlled_live_sim_journal.jsonl')).toBe(false);
  });
});
