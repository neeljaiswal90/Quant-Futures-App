import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  formatJournalEventSchemaValidationErrors,
  journalEventToJsonLine,
  validateJournalEventEnvelope,
  type AnyJournalEventEnvelope,
} from '../../strategy_runtime/src/contracts/events/index.js';

export interface BacktestJournalWriter {
  readonly journal_path: string;
  readonly event_count: number;
  readonly write: (event: AnyJournalEventEnvelope) => Promise<void>;
}

export async function createBacktestJournalWriter(
  outputDir: string,
  runId: string,
): Promise<BacktestJournalWriter> {
  const resolvedOutputDir = resolve(outputDir);
  await mkdir(resolvedOutputDir, { recursive: true });
  const journalPath = join(resolvedOutputDir, `${runId}.jsonl`);
  await writeFile(journalPath, '', 'utf8');

  let eventCount = 0;
  return {
    journal_path: journalPath,
    get event_count() {
      return eventCount;
    },
    write: async (event: AnyJournalEventEnvelope) => {
      const validation = validateJournalEventEnvelope(event);
      if (!validation.ok) {
        throw new Error(formatJournalEventSchemaValidationErrors(validation.issues));
      }
      await appendFile(journalPath, journalEventToJsonLine(event), 'utf8');
      eventCount += 1;
    },
  };
}
