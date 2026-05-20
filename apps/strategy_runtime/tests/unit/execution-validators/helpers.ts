import { ns, type AnyJournalEventEnvelope, type RuntimeEventType } from '../../../src/contracts/index.js';
import { buildExecutionCapabilityMask } from '../../../src/execution/execution-capability-mask.js';

export const BASE_TS_NS = 1_800_000_000_000_000_000n;
let eventSequence = 0;

export function event(
  type: RuntimeEventType,
  payload: Readonly<Record<string, unknown>> = {},
  overrides: Readonly<Record<string, unknown>> = {},
): AnyJournalEventEnvelope {
  eventSequence += 1;
  return {
    schema_version: 2,
    event_id: `evt-${eventSequence}`,
    type,
    ts_ns: ns(BASE_TS_NS),
    run_id: 'run-qfa-624',
    session_id: 'session-qfa-624',
    payload,
    ...overrides,
  } as unknown as AnyJournalEventEnvelope;
}

export function brokerEvent(
  type: 'ORDER_ACK_SUBMISSION' | 'ORDER_ACK_FILL' | 'ORDER_ACK_CANCEL' | 'ORDER_BROKER_REJECT',
  payload: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>> = {},
): AnyJournalEventEnvelope {
  return event(type, payload, {
    ts_ns: ns(BASE_TS_NS),
    ts_ns_local: ns(BASE_TS_NS + 1_000_000n),
    ...overrides,
  });
}

export function completeManifest(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const mask = buildExecutionCapabilityMask();
  return {
    mask_id: mask.mask_id,
    mask_version: mask.mask_version,
    mask_hash: mask.mask_hash,
    reconnect_policy_config: {
      max_reconnects: 3,
      backoff_ms: 250,
    },
    plant_scope: ['ORDER_PLANT'],
    mode: 'paper',
    timestamp_anchor: 'dual',
    execution_phase: 'paper_ordering',
    ...overrides,
  };
}
