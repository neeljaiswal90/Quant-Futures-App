import type { DbnRecord } from '../dbn-types.js';
import {
  QueueSynthesisInputError,
  type QueueSynthesisIssue,
} from './queue-synthesis-input-error.js';
import { assertQueueSynthesisOptions } from './capability-gates.js';
import {
  createQueueStateUnavailableEstimate,
  deriveEffectiveProbeTs,
  validatePassiveOrderProbe,
} from './probe.js';
import {
  mergeQueueRecordSources,
  type QueueMergeRecord,
} from './merge-order.js';
import { QueueSynthesisState } from './queue-state.js';
import { createPassiveFillEstimate } from './passive-fill.js';
import {
  aggressorSideToDepletedBookSide,
  isDefinitionRecord,
  isMboRecord,
  isMbpRecord,
  isTbboRecord,
  isTradesRecord,
  resolveQueueContractIdentity,
  toKnownQueueContract,
  type KnownQueueContract,
  type TradeDepletionEvidence,
} from './record-adapter.js';
import {
  createQueueSynthesisSourceMetadata,
} from './source-metadata.js';
import type {
  PassiveOrderProbe,
  QueueSynthesisMode,
  QueueSynthesisOptions,
  QueueSynthesisOutput,
} from './types.js';
import type { UnixNs } from '../../contracts/time.js';

interface PendingProbe {
  readonly probe: PassiveOrderProbe;
  readonly effective_ts_ns: UnixNs;
}

export async function* synthesizeQueue(
  records: readonly AsyncIterable<DbnRecord>[] | AsyncIterable<DbnRecord>,
  options: QueueSynthesisOptions,
  probes?: AsyncIterable<PassiveOrderProbe>,
): AsyncIterableIterator<QueueSynthesisOutput> {
  const mode = assertQueueSynthesisOptions(options);
  const sources = Array.isArray(records) ? records : [records];
  const state = new QueueSynthesisState(options, mode);
  const definitions = new Map<number, KnownQueueContract>();
  const depletionEvents: TradeDepletionEvidence[] = [];
  const probeCursor = createProbeCursor(probes);

  for await (const mergeRecord of mergeQueueRecordSources(sources)) {
    const nextMarketTs = mergeRecord.record.ts_event;
    for await (const estimate of flushReadyProbes(probeCursor, nextMarketTs, false)) {
      yield estimateProbe(estimate, state, depletionEvents, options, mode);
    }

    for (const output of applyMarketRecord(mergeRecord, mode, state, definitions, depletionEvents)) {
      yield output;
    }
    pruneDepletionEvents(depletionEvents, nextMarketTs - options.depletion_lookback_ns);
  }

  for await (const estimate of flushReadyProbes(probeCursor, null, true)) {
    yield estimateProbe(estimate, state, depletionEvents, options, mode);
  }
}

function applyMarketRecord(
  mergeRecord: QueueMergeRecord,
  mode: ReturnType<typeof assertQueueSynthesisOptions>,
  state: QueueSynthesisState,
  definitions: Map<number, KnownQueueContract>,
  depletionEvents: TradeDepletionEvidence[],
): QueueSynthesisOutput[] {
  const record = mergeRecord.record;
  assertSupportedQueueRecord(record);

  if (isDefinitionRecord(record)) {
    definitions.set(record.instrument_id, toKnownQueueContract(record));
    return [];
  }

  const identity = resolveQueueContractIdentity(record, definitions);

  if (mode === 'mbo_reconstruction' && isMboRecord(record)) {
    const snapshot = state.applyMbo(record, identity);
    return snapshot === null ? [] : [snapshot];
  }

  if (mode === 'mbp_proxy' && isMbpRecord(record)) {
    return state.applyMbp(record, identity);
  }

  if (mode === 'tbbo_trade_proxy' && isTbboRecord(record)) {
    const outputs = state.applyTbbo(record, identity);
    const tradeDepletion = toTradeDepletion(record, identity.raw_symbol);
    if (tradeDepletion !== null) {
      depletionEvents.push(tradeDepletion);
      outputs.push(state.applyTradeDepletion({ ...tradeDepletion, identity }));
    }
    return outputs;
  }

  if (mode === 'tbbo_trade_proxy' && isTradesRecord(record)) {
    const tradeDepletion = toTradeDepletion(record, identity.raw_symbol);
    if (tradeDepletion === null) {
      return [];
    }
    depletionEvents.push(tradeDepletion);
    return [state.applyTradeDepletion({ ...tradeDepletion, identity })];
  }

  return [];
}

function assertSupportedQueueRecord(record: DbnRecord): void {
  switch (record.schema) {
    case 'definition':
    case 'mbo':
    case 'mbp-10':
    case 'mbp-1':
    case 'tbbo':
    case 'trades':
    case 'bbo':
    case 'ohlcv-1m':
    case 'statistics':
    case 'status':
      return;
    default:
      throw new QueueSynthesisInputError([
        {
          path: '$.records[].schema',
          code: 'unsupported_input_schema',
          message: `Unsupported queue synthesis record schema: ${String((record as { schema?: unknown }).schema)}`,
        },
      ]);
  }
}

function pruneDepletionEvents(depletionEvents: TradeDepletionEvidence[], cutoffTsNs: bigint): void {
  let firstKept = 0;
  while (firstKept < depletionEvents.length && depletionEvents[firstKept]!.ts_ns < cutoffTsNs) {
    firstKept += 1;
  }
  if (firstKept > 0) {
    depletionEvents.splice(0, firstKept);
  }
}

function toTradeDepletion(
  record: Extract<DbnRecord, { schema: 'trades' | 'tbbo' }>,
  rawSymbol: string | null,
): TradeDepletionEvidence | null {
  const side = aggressorSideToDepletedBookSide(record.aggressor_side);
  if (side === null) {
    return null;
  }
  return {
    ts_ns: record.ts_event,
    instrument_id: record.instrument_id,
    raw_symbol: rawSymbol,
    side,
    price: record.price,
    quantity: BigInt(record.size),
  };
}

function estimateProbe(
  pendingProbe: PendingProbe,
  state: QueueSynthesisState,
  depletionEvents: readonly TradeDepletionEvidence[],
  options: QueueSynthesisOptions,
  mode: QueueSynthesisMode,
): QueueSynthesisOutput {
  state.trackProbePrice(pendingProbe.probe);
  const queueState = state.getProbeLevel(pendingProbe.probe);
  if (queueState === null) {
    return createQueueStateUnavailableEstimate(
      pendingProbe.probe,
      createQueueSynthesisSourceMetadata({
        mode,
        corpus_tier: options.corpus_tier,
        input_schemas: options.input_schemas,
        confidence: 'unverified',
        quality_flags: ['queue_state_unavailable'],
      }),
    );
  }

  return createPassiveFillEstimate({
    probe: pendingProbe.probe,
    effective_ts_ns: pendingProbe.effective_ts_ns,
    queue_state: queueState,
    depletion_events: depletionEvents,
    options,
  });
}

async function* flushReadyProbes(
  cursor: ProbeCursor,
  nextMarketTs: UnixNs | null,
  flushAll: boolean,
): AsyncIterableIterator<PendingProbe> {
  while (true) {
    const pending = await cursor.peek();
    if (pending === null) {
      return;
    }
    if (!flushAll && nextMarketTs !== null && pending.effective_ts_ns >= nextMarketTs) {
      return;
    }
    yield await cursor.shift();
  }
}

interface ProbeCursor {
  peek(): Promise<PendingProbe | null>;
  shift(): Promise<PendingProbe>;
}

function createProbeCursor(probes: AsyncIterable<PassiveOrderProbe> | undefined): ProbeCursor {
  const iterator = probes?.[Symbol.asyncIterator]() ?? null;
  let pending: PendingProbe | null = null;
  let nextIndex = 0;
  let lastEffectiveTs: UnixNs | null = null;

  async function pull(): Promise<PendingProbe | null> {
    if (pending !== null || iterator === null) {
      return pending;
    }
    const next = await iterator.next();
    if (next.done === true) {
      return null;
    }
    validatePassiveOrderProbe(next.value);
    const effectiveTs = deriveEffectiveProbeTs(next.value);
    if (lastEffectiveTs !== null && effectiveTs < lastEffectiveTs) {
      throw new QueueSynthesisInputError([
        {
          path: `$.probes[${nextIndex}]`,
          code: 'non_monotonic_source',
          message: `probe effective_ts_ns ${effectiveTs.toString()} arrived after ${lastEffectiveTs.toString()}`,
        },
      ] satisfies readonly QueueSynthesisIssue[]);
    }
    pending = {
      probe: next.value,
      effective_ts_ns: effectiveTs,
    };
    nextIndex += 1;
    lastEffectiveTs = effectiveTs;
    return pending;
  }

  return {
    async peek() {
      return pull();
    },
    async shift() {
      const current = await pull();
      if (current === null) {
        throw new Error('cannot shift an exhausted probe cursor');
      }
      pending = null;
      return current;
    },
  };
}
