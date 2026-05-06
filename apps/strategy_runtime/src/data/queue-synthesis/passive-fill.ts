import type { UnixNs } from '../../contracts/time.js';
import { assertFillProbabilityPpm } from './probe.js';
import {
  createQueueSynthesisSourceMetadata,
  withQueueSynthesisConfidence,
  withQueueSynthesisQualityFlags,
} from './source-metadata.js';
import type {
  FillProbabilityPpm,
  PassiveFillEstimate,
  PassiveOrderProbe,
  QueueSynthesisOptions,
  QueueSynthesisSourceMetadata,
} from './types.js';
import type { TradeDepletionEvidence } from './record-adapter.js';
import { tradeDepletesProbeSide } from './record-adapter.js';

interface PassiveFillQueueState {
  readonly estimated_queue_ahead: bigint | null;
  readonly source_metadata: QueueSynthesisSourceMetadata;
}

export function createPassiveFillEstimate(input: {
  readonly probe: PassiveOrderProbe;
  readonly effective_ts_ns: UnixNs;
  readonly queue_state: PassiveFillQueueState;
  readonly depletion_events: readonly TradeDepletionEvidence[];
  readonly options: QueueSynthesisOptions;
}): PassiveFillEstimate {
  const queueAhead = input.queue_state.estimated_queue_ahead;
  if (queueAhead === null) {
    return zeroUnknownQueueEstimate(input.probe, input.effective_ts_ns, input.queue_state);
  }

  const trailingDepletion = sumTrailingDepletion(
    input.depletion_events,
    input.probe,
    input.effective_ts_ns,
    input.options.depletion_lookback_ns,
  );
  const requiredDepletion = queueAhead + input.probe.order_quantity;
  const expectedDepletion =
    (trailingDepletion * input.options.fill_horizon_ns) / input.options.depletion_lookback_ns;
  const estimatedFillQuantity = clampBigint(
    expectedDepletion - queueAhead,
    0n,
    input.probe.order_quantity,
  );
  const ppmBigint =
    requiredDepletion <= 0n
      ? 0n
      : minBigint(1_000_000n, (expectedDepletion * 1_000_000n) / requiredDepletion);
  const probability = Number(ppmBigint) as FillProbabilityPpm;
  assertFillProbabilityPpm(probability);

  return Object.freeze({
    type: 'passive_fill_estimate',
    ts_ns: input.probe.ts_ns,
    effective_ts_ns: input.effective_ts_ns,
    instrument_id: input.probe.instrument_id,
    raw_symbol: input.probe.raw_symbol,
    side: input.probe.side,
    limit_price: input.probe.limit_price,
    order_quantity: input.probe.order_quantity,
    estimated_fill_probability_ppm: probability,
    estimated_fill_quantity: estimatedFillQuantity,
    source_metadata: input.queue_state.source_metadata,
  });
}

function zeroUnknownQueueEstimate(
  probe: PassiveOrderProbe,
  effectiveTsNs: UnixNs,
  queueState: PassiveFillQueueState,
): PassiveFillEstimate {
  const sourceMetadata = withQueueSynthesisConfidence(
    withQueueSynthesisQualityFlags(queueState.source_metadata, ['queue_ahead_unknown']),
    'unverified',
  );
  return Object.freeze({
    type: 'passive_fill_estimate',
    ts_ns: probe.ts_ns,
    effective_ts_ns: effectiveTsNs,
    instrument_id: probe.instrument_id,
    raw_symbol: probe.raw_symbol,
    side: probe.side,
    limit_price: probe.limit_price,
    order_quantity: probe.order_quantity,
    estimated_fill_probability_ppm: 0,
    estimated_fill_quantity: 0n,
    source_metadata: createQueueSynthesisSourceMetadata(sourceMetadata),
  });
}

function sumTrailingDepletion(
  events: readonly TradeDepletionEvidence[],
  probe: PassiveOrderProbe,
  effectiveTsNs: UnixNs,
  lookbackNs: bigint,
): bigint {
  const cutoff = effectiveTsNs > lookbackNs ? effectiveTsNs - lookbackNs : 0n;
  let total = 0n;
  for (const event of events) {
    if (event.ts_ns < cutoff || event.ts_ns > effectiveTsNs) {
      continue;
    }
    if (tradeDepletesProbeSide(event, probe)) {
      total += event.quantity;
    }
  }
  return total;
}

function clampBigint(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function minBigint(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
