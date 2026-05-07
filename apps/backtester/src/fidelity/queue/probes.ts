import { ns } from '../../../../strategy_runtime/src/contracts/time.js';
import type { UnixNs } from '../../../../strategy_runtime/src/contracts/time.js';
import type { DbnMbp1Record } from '../../../../strategy_runtime/src/data/dbn-types.js';
import {
  DEFAULT_QUEUE_FIDELITY_POLICY_V1,
  type QueueFidelityPolicy,
  type QueueFidelityProbe,
  type QueueFidelitySide,
} from './types.js';

const ONE_SECOND_NS = 1_000_000_000n;

interface GenerateQueueFidelityProbesOptions {
  readonly policy?: QueueFidelityPolicy;
  readonly raw_symbol?: string | null;
}

interface TopOfBookState {
  readonly instrument_id: number;
  readonly bid_px: bigint;
  readonly bid_sz: number;
  readonly ask_px: bigint;
  readonly ask_sz: number;
}

export function generateQueueFidelityProbes(
  records: readonly DbnMbp1Record[],
  options: GenerateQueueFidelityProbesOptions = {},
): readonly QueueFidelityProbe[] {
  const policy = options.policy ?? DEFAULT_QUEUE_FIDELITY_POLICY_V1;
  const sortedRecords = sortMbp1Records(records);
  if (sortedRecords.length === 0) {
    return [];
  }

  const firstSample = floorToSecond(sortedRecords[0]!.ts_event);
  const lastSample = floorToSecond(sortedRecords[sortedRecords.length - 1]!.ts_event);
  const currentByInstrument = new Map<number, TopOfBookState>();
  const probes: QueueFidelityProbe[] = [];
  let recordIndex = 0;

  for (let sample = firstSample; sample <= lastSample; sample = ns(sample + ONE_SECOND_NS)) {
    while (recordIndex < sortedRecords.length && sortedRecords[recordIndex]!.ts_event <= sample) {
      const record = sortedRecords[recordIndex]!;
      const level = record.levels[0];
      if (level !== undefined) {
        currentByInstrument.set(record.instrument_id, {
          instrument_id: record.instrument_id,
          bid_px: level.bid_px,
          bid_sz: level.bid_sz,
          ask_px: level.ask_px,
          ask_sz: level.ask_sz,
        });
      }
      recordIndex += 1;
    }

    for (const state of [...currentByInstrument.values()].sort((left, right) => left.instrument_id - right.instrument_id)) {
      for (const side of policy.sides) {
        const probe = makeProbe(state, sample, side, policy, options.raw_symbol ?? null, probes.length + 1);
        if (probe !== null) {
          probes.push(probe);
        }
      }
    }
  }

  return Object.freeze(probes);
}

function makeProbe(
  state: TopOfBookState,
  tsNs: UnixNs,
  side: QueueFidelitySide,
  policy: QueueFidelityPolicy,
  rawSymbol: string | null,
  sequence: number,
): QueueFidelityProbe | null {
  const limitPrice = side === 'buy' ? state.bid_px : state.ask_px;
  const visibleSize = side === 'buy' ? state.bid_sz : state.ask_sz;
  if (limitPrice <= 0n || visibleSize <= 0) {
    return null;
  }

  return Object.freeze({
    probe_id: `qfa-402:${tsNs.toString()}:${state.instrument_id}:${side}:${limitPrice.toString()}:${sequence}`,
    ts_ns: tsNs,
    instrument_id: state.instrument_id,
    raw_symbol: rawSymbol,
    side,
    limit_price: limitPrice,
    quantity: policy.order_quantity,
    fill_horizon_ns: policy.fill_horizon_ns,
    depletion_lookback_ns: policy.depletion_lookback_ns,
  });
}

function sortMbp1Records(records: readonly DbnMbp1Record[]): readonly DbnMbp1Record[] {
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      if (left.record.ts_event < right.record.ts_event) {
        return -1;
      }
      if (left.record.ts_event > right.record.ts_event) {
        return 1;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.record);
}

function floorToSecond(tsNs: UnixNs): UnixNs {
  return ns((tsNs / ONE_SECOND_NS) * ONE_SECOND_NS);
}
