import type { UnixNs } from '../../contracts/time.js';
import type { ContractIdentityRef } from './output-types.js';
import type { ContractRoot } from './roll-policy.js';

function compactSecondTimestamp(timestamp: UnixNs): string {
  const iso = new Date(Number((timestamp as bigint) / 1_000_000n)).toISOString();
  return iso.slice(0, 19).replace(/[-:]/g, '') + 'Z';
}

function contractToken(rawSymbol: string | null, instrumentId: number | null): string {
  if (rawSymbol !== null) {
    return rawSymbol.toLowerCase();
  }
  if (instrumentId !== null) {
    return `iid${String(instrumentId)}`;
  }
  return 'unknown';
}

export function deriveBarId(input: {
  instrument_root: ContractRoot;
  raw_symbol: string | null;
  instrument_id: number | null;
  bar_spec_token: string;
  bucket_start_ts_ns: UnixNs | null;
  first_record_ts_ns: UnixNs;
  seq: number;
}): string {
  const root = input.instrument_root.toLowerCase();
  const contract = contractToken(input.raw_symbol, input.instrument_id);
  const anchor = compactSecondTimestamp(input.bucket_start_ts_ns ?? input.first_record_ts_ns);
  return `bar-${root}-${contract}-${input.bar_spec_token}-${anchor}-${String(input.seq)}`;
}

export function deriveBoundaryId(input: {
  instrument_root: ContractRoot;
  boundary_ts_ns: UnixNs;
  previous_contract: ContractIdentityRef;
  next_contract: ContractIdentityRef;
}): string {
  const root = input.instrument_root.toLowerCase();
  const previous = contractToken(
    input.previous_contract.raw_symbol,
    input.previous_contract.instrument_id,
  );
  const next = contractToken(input.next_contract.raw_symbol, input.next_contract.instrument_id);
  return `roll-${root}-${previous}-${next}-${(input.boundary_ts_ns as bigint).toString()}`;
}
