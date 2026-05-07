import { ns } from '../../../../strategy_runtime/src/contracts/time.js';
import type { UnixNs } from '../../../../strategy_runtime/src/contracts/time.js';
import type {
  DbnLevel,
  DbnMbp10Record,
  DbnMbp1Record,
  DbnRecord,
  DbnTradesRecord,
} from '../../../../strategy_runtime/src/data/dbn-types.js';
import type { OfiBucket, OfiFidelityPolicy } from './types.js';
import { DEFAULT_OFI_FIDELITY_POLICY_V1 } from './ofi-fidelity.js';

const ONE_SECOND_NS = 1_000_000_000n;

interface MutableOfiBucket {
  bucket_start_ts_ns: UnixNs;
  bucket_end_ts_ns: UnixNs;
  ofi: bigint;
  event_count: number;
  missing_depth_level_count: number;
  unknown_trade_side_count: number;
}

interface IndexedRecord<T extends DbnRecord> {
  readonly record: T;
  readonly index: number;
}

export interface LevelOfiContribution {
  readonly ofi: bigint;
  readonly missing_depth_level_count: number;
}

export async function buildMbp10ReferenceOfiBuckets(
  records: AsyncIterable<DbnRecord> | readonly DbnRecord[],
  policy: OfiFidelityPolicy = DEFAULT_OFI_FIDELITY_POLICY_V1,
): Promise<readonly OfiBucket[]> {
  const buckets = new Map<string, MutableOfiBucket>();
  const previousByInstrument = new Map<number, readonly DbnLevel[]>();

  for (const record of sortRecords(await collectRecords(records)).filter(isMbp10Record)) {
    const previous = previousByInstrument.get(record.instrument_id);
    if (previous !== undefined) {
      let ofi = 0n;
      let missingDepthLevelCount = 0;
      for (let index = 0; index < policy.reference_depth_levels; index += 1) {
        const contribution = computeLevelOfiContribution(previous[index], record.levels[index]);
        ofi += contribution.ofi;
        missingDepthLevelCount += contribution.missing_depth_level_count;
      }
      addToBucket(buckets, record.ts_event, {
        ofi,
        event_count: 1,
        missing_depth_level_count: missingDepthLevelCount,
        unknown_trade_side_count: 0,
      });
    }
    previousByInstrument.set(record.instrument_id, record.levels);
  }

  return finalizeBuckets(buckets);
}

export async function buildMbp1TradeSynthesizedOfiBuckets(
  records: AsyncIterable<DbnRecord> | readonly DbnRecord[],
  policy: OfiFidelityPolicy = DEFAULT_OFI_FIDELITY_POLICY_V1,
): Promise<readonly OfiBucket[]> {
  void policy;
  const buckets = new Map<string, MutableOfiBucket>();
  const previousByInstrument = new Map<number, DbnLevel>();

  for (const record of sortRecords(await collectRecords(records))) {
    if (isMbp1Record(record)) {
      const current = record.levels[0];
      const previous = previousByInstrument.get(record.instrument_id);
      if (previous !== undefined && current !== undefined) {
        const contribution = computeLevelOfiContribution(previous, current);
        addToBucket(buckets, record.ts_event, {
          ofi: contribution.ofi,
          event_count: 1,
          missing_depth_level_count: contribution.missing_depth_level_count,
          unknown_trade_side_count: 0,
        });
      }
      if (current !== undefined) {
        previousByInstrument.set(record.instrument_id, current);
      }
      continue;
    }

    if (isTradesRecord(record)) {
      const trade = computeTradeImbalance(record);
      addToBucket(buckets, record.ts_event, {
        ofi: trade.ofi,
        event_count: 1,
        missing_depth_level_count: 0,
        unknown_trade_side_count: trade.unknown_trade_side_count,
      });
    }
  }

  return finalizeBuckets(buckets);
}

export function computeLevelOfiContribution(
  previous: DbnLevel | undefined,
  current: DbnLevel | undefined,
): LevelOfiContribution {
  if (previous === undefined || current === undefined) {
    return { ofi: 0n, missing_depth_level_count: 1 };
  }

  // Cont-style OFI contribution for one book level:
  // bid up => current bid size; bid unchanged => size delta; bid down => previous bid size removed.
  // ask down => negative current ask size; ask unchanged => negative size delta; ask up => previous ask size removed.
  let bidContribution: bigint;
  if (current.bid_px > previous.bid_px) {
    bidContribution = BigInt(current.bid_sz);
  } else if (current.bid_px === previous.bid_px) {
    bidContribution = BigInt(current.bid_sz - previous.bid_sz);
  } else {
    bidContribution = -BigInt(previous.bid_sz);
  }

  let askContribution: bigint;
  if (current.ask_px < previous.ask_px) {
    askContribution = -BigInt(current.ask_sz);
  } else if (current.ask_px === previous.ask_px) {
    askContribution = -BigInt(current.ask_sz - previous.ask_sz);
  } else {
    askContribution = BigInt(previous.ask_sz);
  }

  return {
    ofi: bidContribution + askContribution,
    missing_depth_level_count: 0,
  };
}

function computeTradeImbalance(record: DbnTradesRecord): {
  readonly ofi: bigint;
  readonly unknown_trade_side_count: number;
} {
  // Databento side convention in this codebase: B is buy-aggressor, A is sell-aggressor, N is unknown.
  if (record.aggressor_side === 'B') {
    return { ofi: BigInt(record.size), unknown_trade_side_count: 0 };
  }
  if (record.aggressor_side === 'A') {
    return { ofi: -BigInt(record.size), unknown_trade_side_count: 0 };
  }
  return { ofi: 0n, unknown_trade_side_count: 1 };
}

async function collectRecords(
  records: AsyncIterable<DbnRecord> | readonly DbnRecord[],
): Promise<readonly IndexedRecord<DbnRecord>[]> {
  const collected: IndexedRecord<DbnRecord>[] = [];
  let index = 0;
  if (Symbol.asyncIterator in records) {
    for await (const record of records) {
      collected.push({ record, index });
      index += 1;
    }
    return collected;
  }
  for (const record of records) {
    collected.push({ record, index });
    index += 1;
  }
  return collected;
}

function sortRecords(records: readonly IndexedRecord<DbnRecord>[]): readonly DbnRecord[] {
  return [...records]
    .sort((left, right) => {
      if (left.record.ts_event < right.record.ts_event) {
        return -1;
      }
      if (left.record.ts_event > right.record.ts_event) {
        return 1;
      }
      return left.index - right.index;
    })
    .map((item) => item.record);
}

function addToBucket(
  buckets: Map<string, MutableOfiBucket>,
  tsEvent: UnixNs,
  delta: {
    readonly ofi: bigint;
    readonly event_count: number;
    readonly missing_depth_level_count: number;
    readonly unknown_trade_side_count: number;
  },
): void {
  const start = bucketStart(tsEvent);
  const key = start.toString();
  const bucket = buckets.get(key) ?? {
    bucket_start_ts_ns: start,
    bucket_end_ts_ns: ns(start + ONE_SECOND_NS),
    ofi: 0n,
    event_count: 0,
    missing_depth_level_count: 0,
    unknown_trade_side_count: 0,
  };
  bucket.ofi += delta.ofi;
  bucket.event_count += delta.event_count;
  bucket.missing_depth_level_count += delta.missing_depth_level_count;
  bucket.unknown_trade_side_count += delta.unknown_trade_side_count;
  buckets.set(key, bucket);
}

function finalizeBuckets(buckets: ReadonlyMap<string, MutableOfiBucket>): readonly OfiBucket[] {
  return [...buckets.values()]
    .sort((left, right) => (left.bucket_start_ts_ns < right.bucket_start_ts_ns ? -1 : 1))
    .map((bucket) => Object.freeze({ ...bucket }));
}

function bucketStart(tsEvent: UnixNs): UnixNs {
  return ns((tsEvent / ONE_SECOND_NS) * ONE_SECOND_NS);
}

function isMbp10Record(record: DbnRecord): record is DbnMbp10Record {
  return record.schema === 'mbp-10';
}

function isMbp1Record(record: DbnRecord): record is DbnMbp1Record {
  return record.schema === 'mbp-1';
}

function isTradesRecord(record: DbnRecord): record is DbnTradesRecord {
  return record.schema === 'trades';
}
