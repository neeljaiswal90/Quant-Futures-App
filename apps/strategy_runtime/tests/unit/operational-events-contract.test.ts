import { describe, expect, it } from 'vitest';
import {
  createJournalEventEnvelope,
  formatJournalEventSchemaValidationErrors,
  makeEventId,
  makeRunId,
  makeSessionId,
  ns,
  validateJournalEventEnvelope,
  type JournalEventPayloadFor,
  type RuntimeEventType,
} from '../../src/contracts/index.js';
import { channelsForEventType } from '../../src/contracts/events/channels.js';
import { formatJournalEvent } from '../../src/operator/formatter.js';

const RUN_ID = makeRunId('run-operational-events');
const SESSION_ID = makeSessionId('session-operational-events');
const TS_NS = ns(1_800_000_000_000_000_000n);

describe('operational safety event contracts', () => {
  it('validates and formats all new system-control event payloads', () => {
    const events = [
      event('RECONNECT_STATE', {
        previous_state: 'CONNECTED',
        state: 'RECONNECTING',
        phase: 'attempt',
        attempt: 1,
        max_attempts: 5,
        retry_budget_config: { max_attempts: 5 },
        blocked_submission_gate: true,
      }),
      event('LIVENESS_STATE', {
        process_state: 'alive',
        broker_state: 'dead',
        overall_state: 'dead',
        kill_switch_engaged: true,
        reason: 'broker_dead',
      }),
      event('KILL_SWITCH_ENGAGED', {
        state: 'engaged',
        reason: 'fixture',
        source: 'test',
        engaged_at_ts_ns: TS_NS,
        persistence_enabled: false,
      }),
      event('KILL_SWITCH_DISENGAGED', {
        state: 'disengaged',
        reason: 'fixture',
        source: 'test',
        disengaged_at_ts_ns: TS_NS,
        token_id: 'token',
        persistence_enabled: false,
      }),
      event('ANOMALY_DETECTED', {
        anomaly_id: 'anomaly-1',
        rule: 'rapid_quarantine',
        severity: 'high',
        observed_at_ts_ns: TS_NS,
        message: 'fixture',
        auto_engaged_kill_switch: true,
      }),
      event('SESSION_MANIFEST', {
        mask_id: 'mask',
        mask_version: 1,
        mask_hash: 'hash',
        reconnect_policy_config: {},
        plant_scope: 'ORDER_PLANT',
        mode: 'paper',
        timestamp_anchor: 'dual',
        broker_session_id: 'session',
        adapter_kind: 'MOCK_ORDER_PLANT',
        session_phase: 'reconnect_success',
      }),
      event('SESSION_MANIFEST', {
        mask_id: 'mask',
        mask_version: 1,
        mask_hash: 'hash',
        reconnect_policy_config: {},
        plant_scope: 'ORDER_PLANT',
        mode: 'paper',
        timestamp_anchor: 'dual',
        broker_session_id: 'session',
        adapter_kind: 'MOCK_ORDER_PLANT',
        session_phase: 'reconnect_exhausted',
      }),
    ];

    for (const candidate of events) {
      const validation = validateJournalEventEnvelope(candidate);
      expect(validation.ok, formatJournalEventSchemaValidationErrors(validation.issues)).toBe(true);
      expect(formatJournalEvent(candidate)).toContain(candidate.type);
      expect(channelsForEventType(candidate.type)).not.toEqual([]);
    }
  });
});

function event(type: RuntimeEventType, payload: Record<string, unknown>) {
  return createJournalEventEnvelope({
    event_id: makeEventId(`event-${type}-${String(payload.session_phase ?? payload.state ?? payload.rule ?? 'x')}`),
    type,
    ts_ns: TS_NS,
    run_id: RUN_ID,
    session_id: SESSION_ID,
    payload: payload as unknown as JournalEventPayloadFor<typeof type>,
  });
}
