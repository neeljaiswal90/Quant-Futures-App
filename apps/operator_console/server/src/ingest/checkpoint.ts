import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { stableJsonStringify } from '../transport/json-safe.js';

export const CONSOLE_JOURNAL_CHECKPOINT_SCHEMA_VERSION = 1 as const;

export interface JournalCheckpointFileState {
  readonly offset_bytes: number;
  readonly line_number: number;
  readonly last_event_id?: string;
}

export interface JournalCheckpoint {
  readonly schema_version: typeof CONSOLE_JOURNAL_CHECKPOINT_SCHEMA_VERSION;
  readonly files: Readonly<Record<string, JournalCheckpointFileState>>;
}

export function checkpointPath(checkpointDir: string): string {
  return join(resolve(checkpointDir), 'checkpoints', 'journal-tail-checkpoint.json');
}

export function quarantinePath(checkpointDir: string): string {
  return join(resolve(checkpointDir), 'quarantine', 'malformed-lines.jsonl');
}

export function emptyCheckpoint(): JournalCheckpoint {
  return {
    schema_version: CONSOLE_JOURNAL_CHECKPOINT_SCHEMA_VERSION,
    files: {},
  };
}

export function readCheckpoint(checkpointDir: string): JournalCheckpoint {
  const path = checkpointPath(checkpointDir);
  if (!existsSync(path)) {
    return emptyCheckpoint();
  }

  return parseCheckpoint(JSON.parse(readFileSync(path, 'utf8')));
}

export function writeCheckpoint(checkpointDir: string, checkpoint: JournalCheckpoint): void {
  const path = checkpointPath(checkpointDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, `${stableJsonStringify(checkpoint)}\n`, 'utf8');
  renameSync(tmpPath, path);
}

export function updateCheckpointFile(
  checkpoint: JournalCheckpoint,
  journalPath: string,
  state: JournalCheckpointFileState,
): JournalCheckpoint {
  return {
    schema_version: CONSOLE_JOURNAL_CHECKPOINT_SCHEMA_VERSION,
    files: {
      ...checkpoint.files,
      [resolve(journalPath)]: state,
    },
  };
}

function parseCheckpoint(value: unknown): JournalCheckpoint {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('console journal checkpoint must be a JSON object');
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== CONSOLE_JOURNAL_CHECKPOINT_SCHEMA_VERSION) {
    throw new Error(
      `console journal checkpoint schema_version must be ${CONSOLE_JOURNAL_CHECKPOINT_SCHEMA_VERSION}`,
    );
  }
  if (record.files === null || typeof record.files !== 'object' || Array.isArray(record.files)) {
    throw new Error('console journal checkpoint files must be an object');
  }

  const files: Record<string, JournalCheckpointFileState> = {};
  for (const [filePath, rawState] of Object.entries(record.files as Record<string, unknown>)) {
    if (rawState === null || typeof rawState !== 'object' || Array.isArray(rawState)) {
      throw new Error(`console journal checkpoint state for ${filePath} must be an object`);
    }
    const state = rawState as Record<string, unknown>;
    const offsetBytes = state.offset_bytes;
    const lineNumber = state.line_number;
    const lastEventId = state.last_event_id;
    if (typeof offsetBytes !== 'number' || !Number.isSafeInteger(offsetBytes) || offsetBytes < 0) {
      throw new Error(`console journal checkpoint ${filePath}.offset_bytes must be safe`);
    }
    if (typeof lineNumber !== 'number' || !Number.isSafeInteger(lineNumber) || lineNumber < 0) {
      throw new Error(`console journal checkpoint ${filePath}.line_number must be safe`);
    }
    if (lastEventId !== undefined && typeof lastEventId !== 'string') {
      throw new Error(`console journal checkpoint ${filePath}.last_event_id must be a string`);
    }
    files[filePath] = {
      offset_bytes: offsetBytes,
      line_number: lineNumber,
      ...(lastEventId === undefined ? {} : { last_event_id: lastEventId }),
    };
  }

  return {
    schema_version: CONSOLE_JOURNAL_CHECKPOINT_SCHEMA_VERSION,
    files,
  };
}
