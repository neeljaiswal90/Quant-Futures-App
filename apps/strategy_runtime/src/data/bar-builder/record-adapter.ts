import type { UnixNs } from '../../contracts/time.js';
import type {
  DbnDefinitionRecord,
  DbnOhlcv1mRecord,
  DbnRecord,
  DbnTbboRecord,
  DbnTradesRecord,
} from '../dbn-types.js';
import { parseManifestSymbol } from './manifest-symbol.js';
import type { ContractIdentityRef } from './output-types.js';
import type { ContractRoot } from './roll-policy.js';
import type { ContractIdentitySource } from './source-metadata.js';

export interface KnownContractDefinition extends ContractIdentityRef {
  readonly root: ContractRoot | null;
}

export interface ResolvedRecordContract extends KnownContractDefinition {
  readonly root: ContractRoot;
  readonly has_definition: boolean;
  readonly identity_source: ContractIdentitySource;
}

export interface TradeLikeRecord {
  readonly ts_ns: UnixNs;
  readonly price: bigint;
  readonly size: bigint;
}

export function isDefinitionRecord(record: DbnRecord): record is DbnDefinitionRecord {
  return record.schema === 'definition';
}

export function isTradeLikeRecord(record: DbnRecord): record is DbnTradesRecord | DbnTbboRecord {
  return record.schema === 'trades' || record.schema === 'tbbo';
}

export function isOhlcvRecord(record: DbnRecord): record is DbnOhlcv1mRecord {
  return record.schema === 'ohlcv-1m';
}

export function toKnownContractDefinition(record: DbnDefinitionRecord): KnownContractDefinition {
  return Object.freeze({
    instrument_id: record.instrument_id,
    raw_symbol: record.raw_symbol,
    expiration: record.expiration,
    root: deriveRootFromRawSymbol(record.raw_symbol),
  });
}

export function resolveRecordContract(
  record: DbnRecord,
  instrumentRoot: ContractRoot,
  definitions: ReadonlyMap<number, KnownContractDefinition>,
): ResolvedRecordContract {
  const definition = definitions.get(record.instrument_id);
  if (definition !== undefined) {
    return Object.freeze({
      ...definition,
      root: definition.root ?? instrumentRoot,
      has_definition: true,
      identity_source: 'definition',
    });
  }

  return Object.freeze({
    instrument_id: record.instrument_id,
    raw_symbol: null,
    expiration: null,
    root: instrumentRoot,
    has_definition: false,
    identity_source: 'instrument_id',
  });
}

export function toTradeLikeRecord(record: DbnTradesRecord | DbnTbboRecord): TradeLikeRecord {
  return Object.freeze({
    ts_ns: record.ts_event,
    price: record.price,
    size: BigInt(record.size),
  });
}

export function deriveRootFromRawSymbol(rawSymbol: string | null): ContractRoot | null {
  if (rawSymbol === null) {
    return null;
  }
  try {
    return parseManifestSymbol(rawSymbol).root;
  } catch {
    return null;
  }
}
