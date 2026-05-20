import { ns, type JournalEventPayloadFor, type UnixNs } from '../../contracts/index.js';
import {
  PROVISIONAL_LATENCY_HISTOGRAM_BUCKETS_MS,
  type HistogramSeries,
  type LatencySliRegistry,
} from '../../observability/latency-sli.js';
import type { KillSwitchController } from '../kill-switch/kill-switch-controller.js';

export type LivenessComponentState = 'live' | 'degraded' | 'dead';
export type LivenessOverallState = 'live' | 'degraded' | 'dead';

export interface EventLoopLagWindowSnapshot {
  readonly p95_ms?: number;
  readonly observation_count: number;
  readonly latest_observed_at_ms?: number;
  readonly sampler_stopped?: boolean;
}

export interface EventLoopLagSnapshotProvider {
  snapshotEventLoopLag(nowMs: number): EventLoopLagWindowSnapshot;
}

export interface DualLivenessMonitorOptions {
  readonly kill_switch: Pick<KillSwitchController, 'engage' | 'isEngaged'>;
  readonly event_loop_lag_provider?: EventLoopLagSnapshotProvider;
  readonly latency_registry?: Pick<LatencySliRegistry, 'histogramSnapshot'>;
  readonly emit?: (event: LivenessMonitorEvent) => void;
  readonly now_ms?: () => number;
  readonly now_ns?: () => UnixNs;
  readonly process_window_ms?: number;
  readonly process_degraded_p95_ms?: number;
  readonly process_dead_p95_ms?: number;
  readonly broker_heartbeat_cadence_ms?: number;
}

export interface BrokerHeartbeatInput {
  readonly broker_ts_ns?: UnixNs;
  readonly local_received_ms?: number;
}

export interface LivenessMonitorEvent {
  readonly type: 'LIVENESS_STATE';
  readonly ts_ns: UnixNs;
  readonly payload: JournalEventPayloadFor<'LIVENESS_STATE'>;
}

export interface LivenessSnapshot {
  readonly process_state: LivenessComponentState;
  readonly broker_state: LivenessComponentState;
  readonly overall_state: LivenessOverallState;
}

const DEFAULT_PROCESS_WINDOW_MS = 30_000;
const DEFAULT_PROCESS_DEGRADED_P95_MS = 100;
const DEFAULT_PROCESS_DEAD_P95_MS = 500;
const DEFAULT_BROKER_HEARTBEAT_CADENCE_MS = 5_000;

export class DualLivenessMonitor {
  private readonly killSwitch: Pick<KillSwitchController, 'engage' | 'isEngaged'>;
  private readonly eventLoopLagProvider: EventLoopLagSnapshotProvider;
  private readonly emitEvent: (event: LivenessMonitorEvent) => void;
  private readonly nowMs: () => number;
  private readonly nowNs: () => UnixNs;
  private readonly processWindowMs: number;
  private readonly processDegradedP95Ms: number;
  private readonly processDeadP95Ms: number;
  private readonly brokerHeartbeatCadenceMs: number;
  private brokerLastHeartbeatMs: number | undefined;
  private processForcedDeadReason: string | undefined;
  private brokerForcedDeadReason: string | undefined;
  private deadKillSwitchEngaged = false;

  constructor(options: DualLivenessMonitorOptions) {
    this.killSwitch = options.kill_switch;
    this.nowMs = options.now_ms ?? (() => Date.now());
    this.nowNs = options.now_ns ?? (() => ns(BigInt(this.nowMs()) * 1_000_000n));
    this.processWindowMs = options.process_window_ms ?? DEFAULT_PROCESS_WINDOW_MS;
    this.processDegradedP95Ms = options.process_degraded_p95_ms ?? DEFAULT_PROCESS_DEGRADED_P95_MS;
    this.processDeadP95Ms = options.process_dead_p95_ms ?? DEFAULT_PROCESS_DEAD_P95_MS;
    this.brokerHeartbeatCadenceMs = options.broker_heartbeat_cadence_ms ?? DEFAULT_BROKER_HEARTBEAT_CADENCE_MS;
    this.emitEvent = options.emit ?? (() => undefined);
    this.eventLoopLagProvider =
      options.event_loop_lag_provider ??
      (options.latency_registry === undefined
        ? stoppedEventLoopLagProvider()
        : eventLoopLagProviderFromLatencyRegistry(options.latency_registry));
  }

  recordBrokerHeartbeat(input: BrokerHeartbeatInput = {}): LivenessSnapshot {
    this.brokerLastHeartbeatMs = input.local_received_ms ?? this.nowMs();
    this.brokerForcedDeadReason = undefined;
    return this.snapshot(this.brokerLastHeartbeatMs);
  }

  forceProcessDeadForTests(reason = 'process_liveness_forced_dead'): LivenessSnapshot {
    this.processForcedDeadReason = reason;
    return this.evaluate();
  }

  forceBrokerDeadForTests(reason = 'broker_liveness_forced_dead'): LivenessSnapshot {
    this.brokerForcedDeadReason = reason;
    return this.evaluate();
  }

  evaluate(atMs: number = this.nowMs()): LivenessSnapshot {
    const process = this.processState(atMs);
    const broker = this.brokerState(atMs);
    const overall = combinedState(process.state, broker.state);
    const reason = this.reasonFor(process.state, broker.state, process.reason, broker.reason);

    if (overall === 'dead' && !this.deadKillSwitchEngaged) {
      this.deadKillSwitchEngaged = true;
      if (!this.killSwitch.isEngaged()) {
        this.killSwitch.engage({
          reason: `liveness_dead:${reason ?? 'unknown'}`,
          source: 'auto_liveness',
        });
      }
    }

    const tsNs = this.nowNs();
    this.emitEvent({
      type: 'LIVENESS_STATE',
      ts_ns: tsNs,
      payload: {
        process_state: process.state,
        broker_state: broker.state,
        overall_state: overall,
        kill_switch_engaged: this.killSwitch.isEngaged(),
        ...(process.p95_ms === undefined ? {} : { process_event_loop_lag_p95_ms: process.p95_ms }),
        ...(broker.age_ms === undefined ? {} : { broker_last_heartbeat_age_ms: broker.age_ms }),
        ...(reason === undefined ? {} : { reason }),
      },
    });
    return {
      process_state: process.state,
      broker_state: broker.state,
      overall_state: overall,
    };
  }

  private snapshot(atMs: number): LivenessSnapshot {
    const process = this.processState(atMs);
    const broker = this.brokerState(atMs);
    return {
      process_state: process.state,
      broker_state: broker.state,
      overall_state: combinedState(process.state, broker.state),
    };
  }

  private processState(atMs: number): {
    readonly state: LivenessComponentState;
    readonly reason?: string;
    readonly p95_ms?: number;
  } {
    if (this.processForcedDeadReason !== undefined) {
      return { state: 'dead', reason: this.processForcedDeadReason };
    }
    const snapshot = this.eventLoopLagProvider.snapshotEventLoopLag(atMs);
    if (snapshot.sampler_stopped === true || snapshot.observation_count === 0) {
      return { state: 'dead', reason: 'event_loop_lag_sampler_stopped_or_empty' };
    }
    if (
      snapshot.latest_observed_at_ms !== undefined &&
      atMs - snapshot.latest_observed_at_ms > this.processWindowMs
    ) {
      return { state: 'dead', reason: 'event_loop_lag_no_recent_observations' };
    }
    const p95Ms = snapshot.p95_ms;
    if (p95Ms === undefined) {
      return { state: 'dead', reason: 'event_loop_lag_p95_unavailable' };
    }
    if (p95Ms > this.processDeadP95Ms) {
      return { state: 'dead', reason: 'event_loop_lag_p95_dead', p95_ms: p95Ms };
    }
    if (p95Ms > this.processDegradedP95Ms) {
      return { state: 'degraded', reason: 'event_loop_lag_p95_degraded', p95_ms: p95Ms };
    }
    return { state: 'live', p95_ms: p95Ms };
  }

  private brokerState(atMs: number): {
    readonly state: LivenessComponentState;
    readonly reason?: string;
    readonly age_ms?: number;
  } {
    if (this.brokerForcedDeadReason !== undefined) {
      return { state: 'dead', reason: this.brokerForcedDeadReason };
    }
    if (this.brokerLastHeartbeatMs === undefined) {
      return { state: 'dead', reason: 'broker_heartbeat_missing' };
    }
    const ageMs = Math.max(0, atMs - this.brokerLastHeartbeatMs);
    const missedHeartbeatCount = Math.max(0, Math.floor(ageMs / this.brokerHeartbeatCadenceMs) - 1);
    if (missedHeartbeatCount >= 3 || ageMs > 30_000) {
      return { state: 'dead', reason: 'broker_heartbeat_dead', age_ms: ageMs };
    }
    if (missedHeartbeatCount >= 1) {
      return { state: 'degraded', reason: 'broker_heartbeat_degraded', age_ms: ageMs };
    }
    return { state: 'live', age_ms: ageMs };
  }

  private reasonFor(
    processState: LivenessComponentState,
    brokerState: LivenessComponentState,
    processReason: string | undefined,
    brokerReason: string | undefined,
  ): string | undefined {
    if (processState === 'dead') {
      return processReason ?? 'process_dead';
    }
    if (brokerState === 'dead') {
      return brokerReason ?? 'broker_dead';
    }
    if (processState === 'degraded') {
      return processReason ?? 'process_degraded';
    }
    if (brokerState === 'degraded') {
      return brokerReason ?? 'broker_degraded';
    }
    return undefined;
  }
}

export function eventLoopLagProviderFromLatencyRegistry(
  registry: Pick<LatencySliRegistry, 'histogramSnapshot'>,
): EventLoopLagSnapshotProvider {
  let previousCount = 0;
  let lastCountChangedAtMs: number | undefined;

  return {
    snapshotEventLoopLag: (nowMs) => {
      const snapshot = registry.histogramSnapshot('qfa_event_loop_lag_ms') as HistogramSeries | undefined;
      if (snapshot === undefined) {
        return { observation_count: 0, sampler_stopped: true };
      }
      if (snapshot.count > previousCount) {
        lastCountChangedAtMs = nowMs;
        previousCount = snapshot.count;
      }
      if (snapshot.count === 0) {
        return { observation_count: 0, latest_observed_at_ms: undefined };
      }
      return {
        observation_count: snapshot.count,
        p95_ms: percentileFromHistogram(snapshot, PROVISIONAL_LATENCY_HISTOGRAM_BUCKETS_MS, 0.95),
        latest_observed_at_ms: lastCountChangedAtMs,
      };
    },
  };
}

function percentileFromHistogram(
  snapshot: HistogramSeries,
  bucketsMs: readonly number[],
  percentile: number,
): number | undefined {
  if (snapshot.count === 0) {
    return undefined;
  }
  const target = Math.ceil(snapshot.count * percentile);
  if (hasCumulativeBucketCounts(snapshot, bucketsMs)) {
    for (let i = 0; i < bucketsMs.length; i += 1) {
      if ((snapshot.bucketCounts[i] ?? 0) >= target) {
        return bucketsMs[i];
      }
    }
    return bucketsMs[bucketsMs.length - 1];
  }
  let cumulative = 0;
  for (let i = 0; i < bucketsMs.length; i += 1) {
    cumulative += snapshot.bucketCounts[i] ?? 0;
    if (cumulative >= target) {
      return bucketsMs[i];
    }
  }
  return bucketsMs[bucketsMs.length - 1];
}

function hasCumulativeBucketCounts(snapshot: HistogramSeries, bucketsMs: readonly number[]): boolean {
  if ((snapshot.bucketCounts[bucketsMs.length] ?? snapshot.count) !== snapshot.count) {
    return false;
  }
  for (let i = 1; i < bucketsMs.length; i += 1) {
    if ((snapshot.bucketCounts[i] ?? 0) < (snapshot.bucketCounts[i - 1] ?? 0)) {
      return false;
    }
  }
  return true;
}

function stoppedEventLoopLagProvider(): EventLoopLagSnapshotProvider {
  return {
    snapshotEventLoopLag: () => ({ observation_count: 0, sampler_stopped: true }),
  };
}

function combinedState(
  processState: LivenessComponentState,
  brokerState: LivenessComponentState,
): LivenessOverallState {
  if (processState === 'dead' || brokerState === 'dead') {
    return 'dead';
  }
  if (processState === 'live' && brokerState === 'live') {
    return 'live';
  }
  return 'degraded';
}
