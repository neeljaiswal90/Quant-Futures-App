import { describe, expect, it } from 'vitest';
import { ns } from '../../src/contracts/index.js';
import {
  AnomalyDetector,
  type AnomalyDetectorEvent,
} from '../../src/execution/anomaly/anomaly-detector.js';
import { KillSwitchController } from '../../src/execution/kill-switch/kill-switch-controller.js';
import { SubmissionGate } from '../../src/execution/order-lifecycle-state-machine.js';

describe('AnomalyDetector', () => {
  it('detects rapid quarantine and auto-engages the kill switch for high severity', () => {
    const { detector, gate, events } = detectorFixture();

    detector.recordQuarantine(0);
    detector.recordQuarantine(10);
    detector.recordQuarantine(20);

    expect(events.at(-1)).toMatchObject({
      payload: {
        rule: 'rapid_quarantine',
        severity: 'high',
        auto_engaged_kill_switch: true,
      },
    });
    expect(gate.acquire()).toMatchObject({ allowed: false, reason: 'kill_switch_active' });
  });

  it('detects auth reject bursts using the failure taxonomy', () => {
    const { detector, events } = detectorFixture();

    detector.recordBrokerReject('MOCK_AUTH_REJECT', 'auth.invalid_credentials', 0);
    detector.recordBrokerReject('MOCK_AUTH_REJECT', 'auth.invalid_credentials', 1);
    detector.recordBrokerReject('MOCK_AUTH_REJECT', 'auth.invalid_credentials', 2);

    expect(events.at(-1)).toMatchObject({
      payload: {
        rule: 'auth_reject_burst',
        details: {
          canonical_subreason: 'auth.invalid_credentials',
        },
      },
    });
  });

  it('detects heartbeat skew and reconnect storms', () => {
    const { detector, events } = detectorFixture();

    detector.recordHeartbeatSkew(0, 6_000);
    expect(events.at(-1)).toMatchObject({
      payload: {
        rule: 'heartbeat_skew',
        severity: 'medium',
      },
    });

    for (let index = 0; index < 5; index += 1) {
      detector.recordReconnectState({ phase: 'attempt' }, index);
    }
    expect(events.at(-1)).toMatchObject({
      payload: {
        rule: 'reconnect_storm',
        severity: 'high',
      },
    });
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
