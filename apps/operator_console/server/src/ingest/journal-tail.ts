import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  formatJournalEventSchemaValidationErrors,
  journalEventFromJsonLine,
  validateJournalEventEnvelope,
  type JournalEventEnvelope,
} from '../../../../strategy_runtime/src/contracts/events/index.js';
import { stableJsonStringify, type JsonValue } from '../transport/json-safe.js';
import {
  readCheckpoint,
  quarantinePath,
  updateCheckpointFile,
  writeCheckpoint,
  type JournalCheckpoint,
  type JournalCheckpointFileState,
} from './checkpoint.js';

export interface IngestedJournalEvent {
  readonly event: JournalEventEnvelope;
  readonly source_file: string;
  readonly byte_offset_start: number;
  readonly byte_offset_end: number;
  readonly line_number: number;
}

export interface QuarantinedJournalLine {
  readonly schema_version: 1;
  readonly source_file: string;
  readonly byte_offset_start: number;
  readonly byte_offset_end: number;
  readonly line_number: number;
  readonly error_message: string;
  readonly raw_line: string;
}

export interface JournalTailResult {
  readonly events: readonly IngestedJournalEvent[];
  readonly malformed_lines: readonly QuarantinedJournalLine[];
  readonly checkpoint: JournalCheckpoint;
}

export interface JournalTailOptions {
  readonly journal_path: string;
  readonly checkpoint_dir: string;
}

export function ingestJournalOnce(options: JournalTailOptions): JournalTailResult {
  const journalPath = resolve(options.journal_path);
  const checkpointDir = resolve(options.checkpoint_dir);
  const checkpoint = readCheckpoint(checkpointDir);
  const fileState = stateForFile(checkpoint, journalPath, statSync(journalPath).size);
  const buffer = readFileSync(journalPath);
  const appended = buffer.subarray(fileState.offset_bytes);

  let cursor = fileState.offset_bytes;
  let lineStart = 0;
  let lineNumber = fileState.line_number;
  let lastEventId = fileState.last_event_id;
  const events: IngestedJournalEvent[] = [];
  const malformedLines: QuarantinedJournalLine[] = [];

  for (let index = 0; index < appended.length; index += 1) {
    if (appended[index] !== 0x0a) {
      continue;
    }

    const absoluteLineStart = fileState.offset_bytes + lineStart;
    const absoluteLineEnd = fileState.offset_bytes + index + 1;
    const rawLine = stripTrailingCarriageReturn(appended.subarray(lineStart, index).toString('utf8'));
    lineNumber += 1;

    if (rawLine.trim().length > 0) {
      try {
        const event = parseAndValidateJournalLine(rawLine);
        events.push({
          event,
          source_file: journalPath,
          byte_offset_start: absoluteLineStart,
          byte_offset_end: absoluteLineEnd,
          line_number: lineNumber,
        });
        lastEventId = event.event_id;
      } catch (error) {
        const quarantined = {
          schema_version: 1,
          source_file: journalPath,
          byte_offset_start: absoluteLineStart,
          byte_offset_end: absoluteLineEnd,
          line_number: lineNumber,
          error_message: error instanceof Error ? error.message : String(error),
          raw_line: rawLine,
        } as const satisfies QuarantinedJournalLine;
        appendQuarantineLine(checkpointDir, quarantined);
        malformedLines.push(quarantined);
      }
    }

    cursor = absoluteLineEnd;
    lineStart = index + 1;
  }

  const nextState: JournalCheckpointFileState = {
    offset_bytes: cursor,
    line_number: lineNumber,
    ...(lastEventId === undefined ? {} : { last_event_id: lastEventId }),
  };
  const nextCheckpoint = updateCheckpointFile(checkpoint, journalPath, nextState);
  writeCheckpoint(checkpointDir, nextCheckpoint);

  return {
    events,
    malformed_lines: malformedLines,
    checkpoint: nextCheckpoint,
  };
}

function parseAndValidateJournalLine(rawLine: string): JournalEventEnvelope {
  const event = journalEventFromJsonLine(rawLine);
  const validation = validateJournalEventEnvelope(event);
  if (!validation.ok) {
    throw new Error(formatJournalEventSchemaValidationErrors(validation.issues));
  }
  return event;
}

function stateForFile(
  checkpoint: JournalCheckpoint,
  journalPath: string,
  fileSize: number,
): JournalCheckpointFileState {
  const state = checkpoint.files[resolve(journalPath)] ?? { offset_bytes: 0, line_number: 0 };
  return state.offset_bytes > fileSize ? { offset_bytes: 0, line_number: 0 } : state;
}

function appendQuarantineLine(checkpointDir: string, line: QuarantinedJournalLine): void {
  const path = quarantinePath(checkpointDir);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${stableJsonStringify(line as unknown as JsonValue)}\n`, 'utf8');
}

function stripTrailingCarriageReturn(value: string): string {
  return value.endsWith('\r') ? value.slice(0, -1) : value;
}
