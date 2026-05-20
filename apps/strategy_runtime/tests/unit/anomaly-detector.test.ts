import { describe, expect, it } from 'vitest';
import { ns } from '../../src/contracts/index.js';
import {
  AnomalyDetector,
  type AnomalyDetectorEvent,
} from '../../src/execution/anomaly/anomaly-detector.js';
import { KillSwitchController } from '../../src/execution/kill-switch/kill-switch-controller.js';
import { SubmissionGate } from '../../src/execution/order-lifecycle-state-machine.js';

describe('AnomalyDetector', () => {
  it('requires 3 rapid quarantines in 60s and emits high kill-switch action with new payload names', () => {
    const { detector, gate, events } = detectorFixture();

    detector.recordQuarantine(0);
    detector.recordQuarantine(10);
    expect(events).toHaveLength(0);
    detector.recordQuarantine(20);

    expect(events.at(-1)?.payload).toMatchObject({
      rule_id: 'rapid_quarantine_accumulation',
      severity: 'high',
      auto_action: 'kill_switch_engaged',
      evidence_summary: expect.stringContaining('3 quarantines') as unknown as string,
    });
    expect(Object.keys(events.at(-1)?.payload ?? {}).sort()).toEqual([
      'auto_action',
      'evidence_summary',
      'rule_id',
      'severity',
      'triggered_ts_ns',
    ]);
    expect(gate.acquire()).toMatchObject({ allowed: false, reason: 'kill_switch_active' });
  });

  it('requires 5 auth rejects in 60s before high kill-switch action', () => {
    const { detector, gate, events } = detectorFixture();

    for (let index = 0; index < 4; index += 1) {
      detector.recordBrokerReject('AUTH_INVALID_CREDENTIALS', 'auth.invalid_credentials', index);
    }
    expect(events).toHaveLength(0);

    detector.recordBrokerReject('AUTH_INVALID_CREDENTIALS', 'auth.invalid_credentials', 4);
    expect(events.at(-1)?.payload).toMatchObject({
      rule_id: 'auth_reject_burst',
      severity: 'high',
      auto_action: 'kill_switch_engaged',
    });
    expect(gate.acquire()).toMatchObject({ allowed: false, reason: 'kill_switch_active' });
  });

  it('uses heartbeat skew >5s as medium alert-only without high escalation', () => {
    const { detector, gate, events } = detectorFixture();

    detector.recordHeartbeatSkew(100, 5_000);
    expect(events).toHaveLength(0);

    detector.recordHeartbeatSkew(100, 5_200);
    expect(events.at(-1)?.payload).toMatchObject({
      rule_id: 'heartbeat_skew',
      severity: 'medium',
      auto_action: 'alert_only',
    });
    expect(gate.acquire()).toEqual({ allowed: true });
  });

  it('requires 3 reconnect attempts in 5min and remains medium alert-only', () => {
    const { detector, gate, events } = detectorFixture();

    detector.recordReconnectState({ phase: 'attempt' }, 0);
    detector.recordReconnectState({ phase: 'attempt' }, 1);
    expect(events).toHaveLength(0);

    detector.recordReconnectState({ phase: 'attempt' }, 2);
    expect(events.at(-1)?.payload).toMatchObject({
      rule_id: 'reconnect_storm',
      severity: 'medium',
      auto_action: 'alert_only',
    });
    expect(gate.acquire()).toEqual({ allowed: true });
  });
});

function detectorFixture(): {
  readonly detector: AnomalyDetector;
  readonly gate: SubmissionGate;
  readonly events: AnomalyDetectorEvent[];
} {
  const gate = new SubmissionGate();
  const killSwitch = new KillSwitchController({
    submission_gate: gate,
    now_ns: () => ns(1_800_000_000_000_000_000n),
  });
  const events: AnomalyDetectorEvent[] = [];
  return {
    gate,
    events,
    detector: new AnomalyDetector({
      kill_switch: killSwitch,
      now_ns: () => ns(1_800_000_000_000_000_000n),
      emit: (event) => events.push(event),
    }),
  };
}
