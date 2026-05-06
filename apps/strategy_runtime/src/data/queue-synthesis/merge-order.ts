import type { DbnRecord } from '../dbn-types.js';
import {
  QueueSynthesisInputError,
  type QueueSynthesisIssue,
} from './queue-synthesis-input-error.js';
import { getQueueSchemaPriority } from './schema-priority.js';

export interface QueueMergeRecord {
  readonly record: DbnRecord;
  readonly source_index: number;
  readonly record_index: number;
}

export function compareQueueMergeRecords(
  left: QueueMergeRecord,
  right: QueueMergeRecord,
): number {
  if (left.record.ts_event < right.record.ts_event) {
    return -1;
  }
  if (left.record.ts_event > right.record.ts_event) {
    return 1;
  }

  const schemaDelta =
    getQueueSchemaPriority(left.record.schema) - getQueueSchemaPriority(right.record.schema);
  if (schemaDelta !== 0) {
    return schemaDelta;
  }

  const sourceDelta = left.source_index - right.source_index;
  if (sourceDelta !== 0) {
    return sourceDelta;
  }
  return left.record_index - right.record_index;
}

export function assertQueueSourceMonotonic(
  records: readonly DbnRecord[],
  sourceIndex = 0,
): void {
  let previous: DbnRecord | null = null;
  for (const [recordIndex, record] of records.entries()) {
    if (previous !== null && record.ts_event < previous.ts_event) {
      throw nonMonotonicIssue(sourceIndex, recordIndex, previous.ts_event, record.ts_event);
    }
    previous = record;
  }
}

export async function* mergeQueueRecordSources(
  sources: readonly AsyncIterable<DbnRecord>[],
): AsyncIterableIterator<QueueMergeRecord> {
  const iterators = sources.map((source) => source[Symbol.asyncIterator]());
  const heads: Array<QueueMergeRecord | null> = new Array(sources.length).fill(null);
  const nextIndexes = new Array<number>(sources.length).fill(0);
  const lastTsBySource: Array<DbnRecord['ts_event'] | null> = new Array(sources.length).fill(null);

  async function pull(sourceIndex: number): Promise<void> {
    const next = await iterators[sourceIndex]!.next();
    if (next.done === true) {
      heads[sourceIndex] = null;
      return;
    }

    const previousTs = lastTsBySource[sourceIndex];
    if (previousTs !== null && next.value.ts_event < previousTs) {
      throw nonMonotonicIssue(sourceIndex, nextIndexes[sourceIndex]!, previousTs, next.value.ts_event);
    }

    heads[sourceIndex] = {
      record: next.value,
      source_index: sourceIndex,
      record_index: nextIndexes[sourceIndex]!,
    };
    nextIndexes[sourceIndex] += 1;
    lastTsBySource[sourceIndex] = next.value.ts_event;
  }

  await Promise.all(sources.map((_, sourceIndex) => pull(sourceIndex)));

  while (true) {
    const available = heads.filter((head): head is QueueMergeRecord => head !== null);
    if (available.length === 0) {
      return;
    }

    const selected = available.reduce((best, candidate) =>
      compareQueueMergeRecords(candidate, best) < 0 ? candidate : best,
    );
    yield selected;
    await pull(selected.source_index);
  }
}

function nonMonotonicIssue(
  sourceIndex: number,
  recordIndex: number,
  previousTs: DbnRecord['ts_event'],
  currentTs: DbnRecord['ts_event'],
): QueueSynthesisInputError {
  const issues: readonly QueueSynthesisIssue[] = [
    {
      path: `$.sources[${sourceIndex}][${recordIndex}]`,
      code: 'non_monotonic_source',
      message: `source emitted ts_event ${currentTs.toString()} after ${previousTs.toString()}`,
    },
  ];
  return new QueueSynthesisInputError(issues);
}
