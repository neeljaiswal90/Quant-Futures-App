import type {
  DbnDefinitionRecord,
  DbnMboRecord,
  DbnMbp10Record,
  DbnMbp1Record,
  DbnRecord,
  DbnTbboRecord,
  DbnTradesRecord,
} from '../dbn-types.js';
import type { QueueBookSide, QueueSynthesisQualityFlag } from './types.js';

export interface KnownQueueContract {
  readonly instrument_id: number;
  readonly raw_symbol: string;
  readonly expiration: DbnDefinitionRecord['expiration'];
}

export interface QueueContractIdentity {
  readonly instrument_id: number;
  readonly raw_symbol: string | null;
  readonly has_definition: boolean;
}

export interface TradeDepletionEvidence {
  readonly ts_ns: DbnRecord['ts_event'];
  readonly instrument_id: number;
  readonly raw_symbol: string | null;
  readonly side: QueueBookSide;
  readonly price: bigint;
  readonly quantity: bigint;
}

export function isDefinitionRecord(record: DbnRecord): record is DbnDefinitionRecord {
  return record.schema === 'definition';
}

export function isMboRecord(record: DbnRecord): record is DbnMboRecord {
  return record.schema === 'mbo';
}

export function isMbpRecord(record: DbnRecord): record is DbnMbp1Record | DbnMbp10Record {
  return record.schema === 'mbp-1' || record.schema === 'mbp-10';
}

export function isTbboRecord(record: DbnRecord): record is DbnTbboRecord {
  return record.schema === 'tbbo';
}

export function isTradesRecord(record: DbnRecord): record is DbnTradesRecord {
  return record.schema === 'trades';
}

export function toKnownQueueContract(record: DbnDefinitionRecord): KnownQueueContract {
  return Object.freeze({
    instrument_id: record.instrument_id,
    raw_symbol: record.raw_symbol,
    expiration: record.expiration,
  });
}

export function resolveQueueContractIdentity(
  record: DbnRecord,
  definitions: ReadonlyMap<number, KnownQueueContract>,
): QueueContractIdentity {
  const definition = definitions.get(record.instrument_id);
  return Object.freeze({
    instrument_id: record.instrument_id,
    raw_symbol: definition?.raw_symbol ?? null,
    has_definition: definition !== undefined,
  });
}

export function definitionQualityFlags(identity: QueueContractIdentity): readonly QueueSynthesisQualityFlag[] {
  return identity.has_definition ? [] : ['definition_missing', 'manifest_unverified'];
}

export function mboBookSide(side: DbnMboRecord['side']): QueueBookSide | null {
  if (side === 'B') {
    return 'bid';
  }
  if (side === 'A') {
    return 'ask';
  }
  return null;
}

export function aggressorSideToDepletedBookSide(
  side: DbnTradesRecord['aggressor_side'],
): QueueBookSide | null {
  if (side === 'A') {
    return 'bid';
  }
  if (side === 'B') {
    return 'ask';
  }
  return null;
}

export function tradeDepletesProbeSide(
  evidence: TradeDepletionEvidence,
  probe: {
    readonly instrument_id: number;
    readonly side: 'buy' | 'sell';
    readonly limit_price: bigint;
  },
): boolean {
  if (evidence.instrument_id !== probe.instrument_id) {
    return false;
  }
  if (probe.side === 'buy') {
    return evidence.side === 'bid' && evidence.price <= probe.limit_price;
  }
  return evidence.side === 'ask' && evidence.price >= probe.limit_price;
}
