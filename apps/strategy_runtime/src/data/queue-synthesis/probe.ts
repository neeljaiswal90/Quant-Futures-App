import { ns } from '../../contracts/time.js';
import type { UnixNs } from '../../contracts/time.js';
import {
  QueueSynthesisInputError,
  type QueueSynthesisIssue,
} from './queue-synthesis-input-error.js';
import {
  withQueueSynthesisConfidence,
  withQueueSynthesisQualityFlags,
} from './source-metadata.js';
import type {
  FillProbabilityPpm,
  PassiveFillEstimate,
  PassiveOrderProbe,
  QueueSynthesisSourceMetadata,
} from './types.js';

export function assertFillProbabilityPpm(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new QueueSynthesisInputError([
      {
        path: '$.estimated_fill_probability_ppm',
        code: 'invalid_probability_ppm',
        message: 'fill probability must be a safe integer ppm value from 0 to 1_000_000',
      },
    ]);
  }
}

export function validatePassiveOrderProbe(probe: PassiveOrderProbe): void {
  const issues: QueueSynthesisIssue[] = [];

  if (!Number.isSafeInteger(probe.instrument_id) || probe.instrument_id <= 0) {
    issues.push({
      path: '$.instrument_id',
      code: 'invalid_passive_probe',
      message: 'instrument_id must be a positive safe integer',
    });
  }
  if (probe.side !== 'buy' && probe.side !== 'sell') {
    issues.push({
      path: '$.side',
      code: 'invalid_passive_probe',
      message: 'side must be buy or sell',
    });
  }
  if (probe.limit_price <= 0n) {
    issues.push({
      path: '$.limit_price',
      code: 'invalid_passive_probe',
      message: 'limit_price must be greater than 0',
    });
  }
  if (probe.order_quantity <= 0n) {
    issues.push({
      path: '$.order_quantity',
      code: 'invalid_passive_probe',
      message: 'order_quantity must be greater than 0',
    });
  }
  if (probe.latency_ns < 0n) {
    issues.push({
      path: '$.latency_ns',
      code: 'invalid_passive_probe',
      message: 'latency_ns must be non-negative',
    });
  }

  try {
    ns(probe.ts_ns);
    if (probe.latency_ns >= 0n) {
      ns(probe.ts_ns + probe.latency_ns);
    }
  } catch {
    issues.push({
      path: '$.ts_ns',
      code: 'invalid_passive_probe',
      message: 'ts_ns + latency_ns must be a valid non-negative UnixNs timestamp',
    });
  }

  if (issues.length > 0) {
    throw new QueueSynthesisInputError(issues);
  }
}

export function deriveEffectiveProbeTs(probe: PassiveOrderProbe): UnixNs {
  validatePassiveOrderProbe(probe);
  return ns(probe.ts_ns + probe.latency_ns);
}

export function createQueueStateUnavailableEstimate(
  probe: PassiveOrderProbe,
  metadata: QueueSynthesisSourceMetadata,
): PassiveFillEstimate {
  validatePassiveOrderProbe(probe);
  const sourceMetadata = withQueueSynthesisConfidence(
    withQueueSynthesisQualityFlags(metadata, ['queue_state_unavailable']),
    'unverified',
  );
  const probability: FillProbabilityPpm = 0;
  assertFillProbabilityPpm(probability);

  return Object.freeze({
    type: 'passive_fill_estimate',
    ts_ns: probe.ts_ns,
    effective_ts_ns: deriveEffectiveProbeTs(probe),
    instrument_id: probe.instrument_id,
    raw_symbol: probe.raw_symbol,
    side: probe.side,
    limit_price: probe.limit_price,
    order_quantity: probe.order_quantity,
    estimated_fill_probability_ppm: probability,
    estimated_fill_quantity: 0n,
    source_metadata: sourceMetadata,
  });
}
