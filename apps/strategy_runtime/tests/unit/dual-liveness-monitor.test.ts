import { describe, expect, it } from 'vitest';
import { ns } from '../../src/contracts/index.js';
import { KillSwitchController } from '../../src/execution/kill-switch/kill-switch-controller.js';
import {
  DualLivenessMonitor,
  type LivenessMonitorEvent,
} from '../../src/execution/liveness/dual-liveness-monitor.js';
import { SubmissionGate } from '../../src/execution/order-lifecycle-state-machine.js';

describe('DualLivenessMonitor', () => {
  it('combines process and broker liveness into alive, degraded, and dead states', () => {
    let nowMs = 0;
    const gate = new SubmissionGate();
    const events: LivenessMonitorEvent[] = [];
    const killSwitch = new KillSwitchController({
      submission_gate: gate,
      now_ms: () => nowMs,
      now_ns: () => ns(BigInt(nowMs) * 1_000_000n),
    });
    const monitor = new DualLivenessMonitor({
      kill_switch: killSwitch,
      process_stale_after_ms: 10,
      broker_stale_after_ms: 10,
      process_dead_after_ms: 30,
      broker_dead_after_ms: 30,
      now_ms: () => nowMs,
      now_ns: () => ns(BigInt(nowMs) * 1_000_000n),
      emit: (event) => events.push(event),
    });

    monitor.recordProcessHeartbeat();
    monitor.recordBrokerHeartbeat();
    expect(monitor.evaluate()).toEqual({
      process_state: 'alive',
      broker_state: 'alive',
      overall_state: 'alive',
    });

    nowMs = 12;
    expect(monitor.evaluate()).toMatchObject({ overall_state: 'degraded' });
    nowMs = 30;
    expect(monitor.evaluate()).toMatchObject({ overall_state: 'dead' });

    expect(killSwitch.isEngaged()).toBe(true);
    expect(gate.acquire()).toMatchObject({ allowed: false, reason: 'kill_switch_active' });
    expect(events.at(-1)).toMatchObject({
      payload: {
        overall_state: 'dead',
        kill_switch_engaged: true,
      },
    });
  });

  it('marks explicit broker death and emits reasoned liveness state', () => {
    const gate = new SubmissionGate();
    const events: LivenessMonitorEvent[] = [];
    const killSwitch = new KillSwitchController({ submission_gate: gate });
    const monitor = new DualLivenessMonitor({
      kill_switch: killSwitch,
      emit: (event) => events.push(event),
    });

    expect(monitor.markBrokerDead('broker_socket_closed')).toMatchObject({
      broker_state: 'dead',
      overall_state: 'dead',
    });
    expect(events[0]).toMatchObject({
      payload: {
        reason: 'broker_socket_closed',
      },
    });
  });
});
