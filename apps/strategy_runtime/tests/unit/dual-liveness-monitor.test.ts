import { describe, expect, it } from 'vitest';
import { ns } from '../../src/contracts/index.js';
import { KillSwitchController } from '../../src/execution/kill-switch/kill-switch-controller.js';
import {
  DualLivenessMonitor,
  eventLoopLagProviderFromLatencyRegistry,
  type EventLoopLagSnapshotProvider,
  type LivenessMonitorEvent,
} from '../../src/execution/liveness/dual-liveness-monitor.js';
import { SubmissionGate } from '../../src/execution/order-lifecycle-state-machine.js';
import { LatencySliRegistry } from '../../src/observability/latency-sli.js';

describe('DualLivenessMonitor', () => {
  it('derives process liveness from QFA-626 event-loop-lag p95 thresholds', () => {
    const live = monitorFixture({ p95_ms: 50, observation_count: 3, latest_observed_at_ms: 1_000 });
    live.monitor.recordBrokerHeartbeat({ local_received_ms: 1_000 });
    expect(live.monitor.evaluate(1_000)).toMatchObject({ process_state: 'live', overall_state: 'live' });

    const degraded = monitorFixture({ p95_ms: 150, observation_count: 3, latest_observed_at_ms: 1_000 });
    degraded.monitor.recordBrokerHeartbeat({ local_received_ms: 1_000 });
    expect(degraded.monitor.evaluate(1_000)).toMatchObject({
      process_state: 'degraded',
      overall_state: 'degraded',
    });

    const dead = monitorFixture({ p95_ms: 600, observation_count: 3, latest_observed_at_ms: 1_000 });
    dead.monitor.recordBrokerHeartbeat({ local_received_ms: 1_000 });
    expect(dead.monitor.evaluate(1_000)).toMatchObject({ process_state: 'dead', overall_state: 'dead' });
    expect(dead.gate.acquire()).toMatchObject({ allowed: false, reason: 'kill_switch_active' });
  });

  it('marks process dead when the sampler stopped or has no observations in the 30s window', () => {
    const stopped = monitorFixture({ observation_count: 0, sampler_stopped: true });
    stopped.monitor.recordBrokerHeartbeat({ local_received_ms: 1_000 });
    expect(stopped.monitor.evaluate(1_000)).toMatchObject({ process_state: 'dead' });

    const stale = monitorFixture({ p95_ms: 50, observation_count: 1, latest_observed_at_ms: 0 });
    stale.monitor.recordBrokerHeartbeat({ local_received_ms: 31_000 });
    expect(stale.monitor.evaluate(31_000)).toMatchObject({ process_state: 'dead' });
  });

  it('applies broker heartbeat degraded and dead thresholds from 5s cadence', () => {
    const degraded = monitorFixture({ p95_ms: 50, observation_count: 3, latest_observed_at_ms: 0 });
    degraded.monitor.recordBrokerHeartbeat({ local_received_ms: 0 });
    expect(degraded.monitor.evaluate(10_000)).toMatchObject({
      broker_state: 'degraded',
      overall_state: 'degraded',
    });

    const dead = monitorFixture({ p95_ms: 50, observation_count: 3, latest_observed_at_ms: 0 });
    dead.monitor.recordBrokerHeartbeat({ local_received_ms: 0 });
    expect(dead.monitor.evaluate(20_000)).toMatchObject({ broker_state: 'dead', overall_state: 'dead' });
    expect(dead.gate.acquire()).toMatchObject({ allowed: false, reason: 'kill_switch_active' });
  });

  it('locks the combined-state matrix', () => {
    expect(combinedFor(50, 0)).toEqual({ process_state: 'live', broker_state: 'live', overall_state: 'live' });
    expect(combinedFor(150, 0)).toMatchObject({ process_state: 'degraded', overall_state: 'degraded' });
    expect(combinedFor(50, 10_000)).toMatchObject({ broker_state: 'degraded', overall_state: 'degraded' });
    expect(combinedFor(600, 0)).toMatchObject({ process_state: 'dead', overall_state: 'dead' });
    expect(combinedFor(50, 20_000)).toMatchObject({ broker_state: 'dead', overall_state: 'dead' });
  });

  it('keeps forced-dead hooks clearly test/operator scoped', () => {
    const fixture = monitorFixture({ p95_ms: 50, observation_count: 3, latest_observed_at_ms: 0 });
    fixture.monitor.recordBrokerHeartbeat({ local_received_ms: 0 });
    expect(fixture.monitor.forceBrokerDeadForTests('operator_test')).toMatchObject({
      broker_state: 'dead',
      overall_state: 'dead',
    });
    expect(fixture.events.at(-1)).toMatchObject({ payload: { reason: 'operator_test' } });
  });

  it('uses real QFA-626 bucket counts for p95 instead of the event-loop-lag mean', () => {
    const registry = new LatencySliRegistry();
    for (let i = 0; i < 94; i += 1) {
      registry.recordEventLoopLagMs(10);
    }
    for (let i = 0; i < 6; i += 1) {
      registry.recordEventLoopLagMs(1_000);
    }
    const arithmeticMeanMs = (94 * 10 + 6 * 1_000) / 100;
    expect(arithmeticMeanMs).toBeLessThan(100);

    const gate = new SubmissionGate();
    const monitor = new DualLivenessMonitor({
      kill_switch: new KillSwitchController({
        submission_gate: gate,
        now_ns: () => ns(1_800_000_000_000_000_000n),
      }),
      latency_registry: registry,
      now_ms: () => 5_000,
      now_ns: () => ns(1_800_000_000_000_000_000n),
    });
    monitor.recordBrokerHeartbeat({ local_received_ms: 5_000 });

    expect(monitor.evaluate(5_000)).toMatchObject({
      process_state: 'dead',
      overall_state: 'dead',
    });
    expect(gate.acquire()).toMatchObject({ allowed: false, reason: 'kill_switch_active' });
  });

  it('detects a stale real QFA-626 event-loop-lag sampler by count-change timestamp', () => {
    const registry = new LatencySliRegistry();
    const provider = eventLoopLagProviderFromLatencyRegistry(registry);
    registry.recordEventLoopLagMs(50);

    const first = provider.snapshotEventLoopLag(10_000);
    expect(first.latest_observed_at_ms).toBe(10_000);
    const stale = provider.snapshotEventLoopLag(41_000);
    expect(stale.latest_observed_at_ms).toBe(10_000);

    const gate = new SubmissionGate();
    const monitor = new DualLivenessMonitor({
      kill_switch: new KillSwitchController({
        submission_gate: gate,
        now_ns: () => ns(1_800_000_000_000_000_000n),
      }),
      event_loop_lag_provider: provider,
      now_ms: () => 41_000,
      now_ns: () => ns(1_800_000_000_000_000_000n),
    });
    monitor.recordBrokerHeartbeat({ local_received_ms: 41_000 });

    expect(monitor.evaluate(41_000)).toMatchObject({
      process_state: 'dead',
      overall_state: 'dead',
    });
    expect(gate.acquire()).toMatchObject({ allowed: false, reason: 'kill_switch_active' });
  });
});

function combinedFor(processP95Ms: number, brokerAgeMs: number) {
  const fixture = monitorFixture({ p95_ms: processP95Ms, observation_count: 3, latest_observed_at_ms: 0 });
  fixture.monitor.recordBrokerHeartbeat({ local_received_ms: 0 });
  return fixture.monitor.evaluate(brokerAgeMs);
}

function monitorFixture(snapshot: ReturnType<EventLoopLagSnapshotProvider['snapshotEventLoopLag']>): {
  readonly monitor: DualLivenessMonitor;
  readonly gate: SubmissionGate;
  readonly events: LivenessMonitorEvent[];
} {
  const gate = new SubmissionGate();
  const events: LivenessMonitorEvent[] = [];
  const killSwitch = new KillSwitchController({
    submission_gate: gate,
    now_ns: () => ns(1_800_000_000_000_000_000n),
  });
  return {
    gate,
    events,
    monitor: new DualLivenessMonitor({
      kill_switch: killSwitch,
      event_loop_lag_provider: {
        snapshotEventLoopLag: () => snapshot,
      },
      now_ms: () => 0,
      now_ns: () => ns(1_800_000_000_000_000_000n),
      emit: (event) => events.push(event),
    }),
  };
}
