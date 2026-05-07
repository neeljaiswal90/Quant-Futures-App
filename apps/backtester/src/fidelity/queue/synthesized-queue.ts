import type { DbnMbp1Record, DbnRecord } from '../../../../strategy_runtime/src/data/dbn-types.js';
import { synthesizeQueue } from '../../../../strategy_runtime/src/data/queue-synthesis/queue-synthesizer.js';
import type {
  PassiveFillEstimate,
  PassiveOrderProbe,
  QueueSynthesisOptions,
  QueueSynthesisOutput,
} from '../../../../strategy_runtime/src/data/queue-synthesis/types.js';
import {
  type QueueFidelityProbe,
  type QueueFidelityProbeResult,
} from './types.js';

export async function computeSynthesizedFillEstimate(
  probe: QueueFidelityProbe,
  records: readonly DbnRecord[] | AsyncIterable<DbnRecord>,
): Promise<QueueFidelityProbeResult> {
  const mbp1Records = sortRecords(await collectMbp1Records(records));
  const outputs: QueueSynthesisOutput[] = [];
  for await (const output of synthesizeQueue(
    asyncRecords(mbp1Records),
    makeMbpProxyOptions(probe),
    asyncProbes([toPassiveOrderProbe(probe)]),
  )) {
    outputs.push(output);
  }

  const estimate = outputs.find((output): output is PassiveFillEstimate => output.type === 'passive_fill_estimate') ?? null;
  if (estimate === null || estimate.source_metadata.quality_flags.includes('queue_state_unavailable')) {
    return makeUnavailableResult(probe);
  }

  return Object.freeze({
    probe_id: probe.probe_id,
    ts_ns: probe.ts_ns,
    side: probe.side,
    limit_price: probe.limit_price,
    quantity: probe.quantity,
    reference_fill_probability_ppm: null,
    synthesized_fill_probability_ppm: estimate.estimated_fill_probability_ppm,
    absolute_error_ppm: null,
    within_tolerance: null,
    status: 'compared',
    synthesized_source_mode: estimate.source_metadata.mode,
  });
}

function makeMbpProxyOptions(probe: QueueFidelityProbe): QueueSynthesisOptions {
  const instrumentRoot = inferInstrumentRoot(probe.raw_symbol) ?? 'MNQ';
  return {
    instrument_root: instrumentRoot,
    manifest_symbol: probe.raw_symbol ?? instrumentRoot,
    input_schemas: ['mbp-1'],
    corpus_tier: null,
    mode: 'mbp_proxy',
    passive_order_quantity: probe.quantity,
    fill_horizon_ns: probe.fill_horizon_ns,
    depletion_lookback_ns: probe.depletion_lookback_ns,
    allow_unverified_identity: true,
  };
}

function toPassiveOrderProbe(probe: QueueFidelityProbe): PassiveOrderProbe {
  return {
    ts_ns: probe.ts_ns,
    instrument_id: probe.instrument_id,
    raw_symbol: probe.raw_symbol,
    side: probe.side,
    limit_price: probe.limit_price,
    order_quantity: probe.quantity,
    latency_ns: 0n,
  };
}

function makeUnavailableResult(probe: QueueFidelityProbe): QueueFidelityProbeResult {
  return Object.freeze({
    probe_id: probe.probe_id,
    ts_ns: probe.ts_ns,
    side: probe.side,
    limit_price: probe.limit_price,
    quantity: probe.quantity,
    reference_fill_probability_ppm: null,
    synthesized_fill_probability_ppm: null,
    absolute_error_ppm: null,
    within_tolerance: null,
    status: 'synthesized_unavailable',
    synthesized_source_mode: 'mbp_proxy',
  });
}

async function collectMbp1Records(records: readonly DbnRecord[] | AsyncIterable<DbnRecord>): Promise<DbnMbp1Record[]> {
  const collected: DbnMbp1Record[] = [];
  if (Array.isArray(records)) {
    for (const record of records) {
      if (record.schema === 'mbp-1') {
        collected.push(record);
      }
    }
    return collected;
  }

  for await (const record of records) {
    if (record.schema === 'mbp-1') {
      collected.push(record);
    }
  }
  return collected;
}

function sortRecords<TRecord extends DbnRecord>(records: readonly TRecord[]): readonly TRecord[] {
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

async function* asyncRecords<TRecord extends DbnRecord>(records: readonly TRecord[]): AsyncIterableIterator<TRecord> {
  for (const record of records) {
    yield record;
  }
}

async function* asyncProbes(probes: readonly PassiveOrderProbe[]): AsyncIterableIterator<PassiveOrderProbe> {
  for (const probe of probes) {
    yield probe;
  }
}

function inferInstrumentRoot(rawSymbol: string | null): string | null {
  if (rawSymbol === null) {
    return null;
  }
  const match = /^([A-Z]{1,3})/u.exec(rawSymbol);
  return match?.[1] ?? null;
}
