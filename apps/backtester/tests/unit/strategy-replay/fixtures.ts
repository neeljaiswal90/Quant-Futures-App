import { ns } from '../../../../strategy_runtime/src/contracts/time.js';
import type { BuiltBar } from '../../../../strategy_runtime/src/data/bar-builder/index.js';

export function makeReplayBar(
  barId: string,
  sequence: number,
  close: bigint,
): BuiltBar {
  const start = BigInt(sequence) * 60_000_000_000n;
  return {
    type: 'bar',
    bar_id: barId,
    instrument_root: 'MNQ',
    instrument_id: 1,
    raw_symbol: 'MNQH6',
    bar_spec: '1m',
    open_reason: sequence === 1 ? 'stream_start' : 'bar_boundary',
    close_reason: 'bar_boundary',
    is_complete: true,
    roll_boundary_id: null,
    manifest_symbol_check: {
      manifest_symbol: 'MNQ',
      expectation_type: 'root',
      status: 'matched',
      message: 'fixture manifest symbol matches replay sanity root',
    },
    source_metadata: {
      corpus_tier: null,
      input_schemas: ['trades'],
      construction_method: 'trade_aggregation',
      contract_identity_source: 'raw_symbol',
      quality_flags: [],
    },
    bucket_start_ts_ns: ns(start),
    bucket_end_ts_ns: ns(start + 60_000_000_000n),
    first_record_ts_ns: ns(start + 1_000_000n),
    last_record_ts_ns: ns(start + 59_000_000_000n),
    open: close - 1n,
    high: close + 2n,
    low: close - 2n,
    close,
    volume: BigInt(100 + sequence),
  };
}

export const REPLAY_BARS = [
  makeReplayBar('bar-001', 1, 100n),
  makeReplayBar('bar-002', 2, 101n),
  makeReplayBar('bar-003', 3, 102n),
  makeReplayBar('bar-004', 4, 101n),
] as const;
