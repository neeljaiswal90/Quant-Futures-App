import { resolve } from 'node:path';

export interface JournalIngestEnv {
  readonly QFA_CONSOLE_JOURNAL?: string;
  readonly QFA_CONSOLE_JOURNAL_DIR?: string;
  readonly QFA_CONSOLE_JOURNAL_GLOB?: string;
  readonly QFA_CONSOLE_CHECKPOINT_DIR?: string;
  readonly QFA_CONSOLE_MODE?: string;
  readonly QFA_CONSOLE_POLL_MS?: string;
  readonly QFA_CONSOLE_WS_COALESCE_MS?: string;
}

export interface JournalIngestOptions {
  readonly journal?: string;
  readonly journal_dir?: string;
  readonly journal_glob: string;
  readonly checkpoint_dir: string;
  readonly mode: 'live' | 'replay';
  readonly poll_ms: number;
  readonly ws_coalesce_ms?: number;
}

export const DEFAULT_JOURNAL_GLOB = 'rel00_controlled_live_sim_journal*.jsonl';
export const DEFAULT_CHECKPOINT_DIR = '.operator-console';
export const DEFAULT_POLL_MS = 250;

type MutablePartialJournalIngestOptions = {
  -readonly [Key in keyof JournalIngestOptions]?: JournalIngestOptions[Key];
};

export function parseJournalIngestOptions(
  argv: readonly string[],
  env: JournalIngestEnv,
  cwd = process.cwd(),
): JournalIngestOptions {
  const parsed: MutablePartialJournalIngestOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const [flag, inlineValue] = arg.split('=', 2);
    const nextValue = (): string => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      const next = argv[index + 1];
      if (next === undefined) {
        throw new Error(`${flag} requires a value`);
      }
      index += 1;
      return next;
    };

    switch (flag) {
      case '--journal':
        parsed.journal = resolve(cwd, nextValue());
        break;
      case '--journal-dir':
        parsed.journal_dir = resolve(cwd, nextValue());
        break;
      case '--journal-glob':
        parsed.journal_glob = nextValue();
        break;
      case '--checkpoint-dir':
        parsed.checkpoint_dir = resolve(cwd, nextValue());
        break;
      case '--mode':
        parsed.mode = parseMode(nextValue());
        break;
      case '--poll-ms':
        parsed.poll_ms = parsePositiveInteger(nextValue(), '--poll-ms');
        break;
      case '--ws-coalesce-ms':
        parsed.ws_coalesce_ms = parsePositiveInteger(nextValue(), '--ws-coalesce-ms');
        break;
      default:
        throw new Error(`Unknown operator console journal option: ${arg}`);
    }
  }

  const journal = parsed.journal ?? optionalResolve(cwd, env.QFA_CONSOLE_JOURNAL);
  const journalDir = parsed.journal_dir ?? optionalResolve(cwd, env.QFA_CONSOLE_JOURNAL_DIR);

  return {
    ...(journal === undefined ? {} : { journal }),
    ...(journalDir === undefined ? {} : { journal_dir: journalDir }),
    journal_glob: parsed.journal_glob ?? env.QFA_CONSOLE_JOURNAL_GLOB ?? DEFAULT_JOURNAL_GLOB,
    checkpoint_dir:
      parsed.checkpoint_dir ??
      optionalResolve(cwd, env.QFA_CONSOLE_CHECKPOINT_DIR) ??
      resolve(cwd, DEFAULT_CHECKPOINT_DIR),
    mode: parsed.mode ?? parseMode(env.QFA_CONSOLE_MODE ?? 'live'),
    poll_ms:
      parsed.poll_ms ??
      (env.QFA_CONSOLE_POLL_MS === undefined
        ? DEFAULT_POLL_MS
        : parsePositiveInteger(env.QFA_CONSOLE_POLL_MS, 'QFA_CONSOLE_POLL_MS')),
    ws_coalesce_ms:
      parsed.ws_coalesce_ms ??
      (env.QFA_CONSOLE_WS_COALESCE_MS === undefined
        ? undefined
        : parsePositiveInteger(env.QFA_CONSOLE_WS_COALESCE_MS, 'QFA_CONSOLE_WS_COALESCE_MS')),
  };
}

function optionalResolve(cwd: string, value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  return resolve(cwd, value);
}

function parseMode(value: string): 'live' | 'replay' {
  if (value === 'live' || value === 'replay') {
    return value;
  }
  throw new Error(`operator console mode must be live or replay: ${value}`);
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return parsed;
}
