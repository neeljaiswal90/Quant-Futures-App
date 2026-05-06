import type { CachedRecordSource } from '../parquet-cache.js';
import { readCachedRecords } from '../parquet-cache.js';
import type { PassiveOrderProbe, QueueSynthesisOptions, QueueSynthesisOutput } from './types.js';
import { synthesizeQueue } from './queue-synthesizer.js';

export async function* synthesizeCachedQueue(
  sources: readonly CachedRecordSource[],
  options: QueueSynthesisOptions,
  probes?: AsyncIterable<PassiveOrderProbe>,
): AsyncIterableIterator<QueueSynthesisOutput> {
  const recordSources = sources.map((source) => readCachedRecords(source.parquetPath, source.schema));
  yield* synthesizeQueue(recordSources, options, probes);
}
