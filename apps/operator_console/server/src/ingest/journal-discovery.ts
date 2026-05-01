import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DEFAULT_JOURNAL_GLOB, type JournalIngestOptions } from './options.js';

export interface JournalSelection {
  readonly journal_path: string;
  readonly source: 'explicit' | 'directory';
  readonly candidate_count: number;
  readonly glob: string;
}

const EXCLUDED_NAME_FRAGMENTS = [
  'shadow',
  'sidecar',
  'probe',
  'quarantine',
  'checkpoint',
  'malformed-lines',
] as const;

const EXCLUDED_SUFFIXES = ['.tmp', '.partial', '.writing'] as const;

export function selectJournalPath(options: Pick<JournalIngestOptions, 'journal' | 'journal_dir' | 'journal_glob'>): JournalSelection {
  if (options.journal !== undefined) {
    const journalPath = resolve(options.journal);
    if (!existsSync(journalPath)) {
      throw new Error(`journal does not exist: ${journalPath}`);
    }
    return {
      journal_path: journalPath,
      source: 'explicit',
      candidate_count: 1,
      glob: options.journal_glob,
    };
  }

  if (options.journal_dir === undefined) {
    throw new Error('journal source required: provide --journal or --journal-dir');
  }

  return selectJournalFromDirectory(options.journal_dir, options.journal_glob);
}

export function selectJournalFromDirectory(
  journalDir: string,
  journalGlob = DEFAULT_JOURNAL_GLOB,
): JournalSelection {
  const absoluteDir = resolve(journalDir);
  if (!existsSync(absoluteDir)) {
    throw new Error(`journal dir does not exist: ${absoluteDir}`);
  }

  const matcher = globMatcher(journalGlob);
  const candidates = readdirSync(absoluteDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => matcher(entry.name))
    .filter((entry) => !isExcludedJournalCandidate(entry.name))
    .map((entry) => {
      const fullPath = join(absoluteDir, entry.name);
      return {
        basename: entry.name,
        fullPath,
        mtimeMs: statSync(fullPath).mtimeMs,
      };
    })
    .sort((left, right) => {
      const mtimeComparison = right.mtimeMs - left.mtimeMs;
      return mtimeComparison === 0 ? right.basename.localeCompare(left.basename) : mtimeComparison;
    });

  const selected = candidates[0];
  if (selected === undefined) {
    throw new Error(`no journal candidates in ${absoluteDir} matching ${journalGlob}`);
  }

  return {
    journal_path: selected.fullPath,
    source: 'directory',
    candidate_count: candidates.length,
    glob: journalGlob,
  };
}

export function isExcludedJournalCandidate(fileNameOrPath: string): boolean {
  const normalized = fileNameOrPath.replaceAll('\\', '/').toLowerCase();
  const name = basename(normalized);
  return (
    EXCLUDED_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment)) ||
    EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

function globMatcher(pattern: string): (name: string) => boolean {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const regex = new RegExp(`^${escaped}$`);
  return (name: string) => regex.test(name);
}
