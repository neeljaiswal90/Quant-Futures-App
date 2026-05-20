import { ns, type JournalEventPayloadFor, type UnixNs } from '../../contracts/index.js';
import type { KillSwitchController } from '../kill-switch/kill-switch-controller.js';

export type LivenessComponentState = 'unknown' | 'alive' | 'stale' | 'dead';
export type LivenessOverallState = 'alive' | 'degraded' | 'dead';

export interface DualLivenessMonitorOptions {
  readonly kill_switch: Pick<KillSwitchController, 'engage' | 'isEngaged'>;
  readonly emit?: (event: LivenessMonitorEvent) => void;
  readonly process_stale_after_ms?: number;
  readonly broker_stale_after_ms?: number;
  readonly process_dead_after_ms?: number;
  readonly broker_dead_after_ms?: number;
  readonly now_ms?: () => number;
  readonly now_ns?: () => UnixNs;
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

const DEFAULT_STALE_AFTER_MS = 5_000;
const DEFAULT_DEAD_AFTER_MS = 15_000;

export class DualLivenessMonitor {
  private readonly killSwitch: Pick<KillSwitchController, 'engage' | 'isEngaged'>;
  private readonly emitEvent: (event: LivenessMonitorEvent) => void;
  private readonly processStaleAfterMs: number;
  private readonly brokerStaleAfterMs: number;
  private readonly processDeadAfterMs: number;
  private readonly brokerDeadAfterMs: number;
  private readonly nowMs: () => number;
  private readonly nowNs: () => UnixNs;
  private processLastHeartbeatMs: number | undefined;
  private brokerLastHeartbeatMs: number | undefined;
  private processForcedDeadReason: string | undefined;
  private brokerForcedDeadReason: string | undefined;
  private deadKillSwitchEngaged = false;

  constructor(options: DualLivenessMonitorOptions) {
    this.killSwitch = options.kill_switch;
    this.emitEvent = options.emit ?? (() => undefined);
    this.processStaleAfterMs = options.process_stale_after_ms ?? DEFAULT_STALE_AFTER_MS;
    this.brokerStaleAfterMs = options.broker_stale_after_ms ?? DEFAULT_STALE_AFTER_MS;
    this.processDeadAfterMs = options.process_dead_after_ms ?? DEFAULT_DEAD_AFTER_MS;
    this.brokerDeadAfterMs = options.broker_dead_after_ms ?? DEFAULT_DEAD_AFTER_MS;
    this.nowMs = options.now_ms ?? (() => Date.now());
    this.nowNs = options.now_ns ?? (() => ns(BigInt(this.nowMs()) * 1_000_000n));
  }

  recordProcessHeartbeat(atMs: number = this.nowMs()): LivenessSnapshot {
    this.processLastHeartbeatMs = atMs;
    this.processForcedDeadReason = undefined;
    return this.snapshot(atMs);
  }

  recordBrokerHeartbeat(atMs: number = this.nowMs()): LivenessSnapshot {
    this.brokerLastHeartbeatMs = atMs;
    this.brokerForcedDeadReason = undefined;
    return this.snapshot(atMs);
  }

  markProcessDead(reason = 'process_liveness_dead', atMs: number = this.nowMs()): LivenessSnapshot {
    this.processForcedDeadReason = reason;
    return this.evaluate(atMs);
  }

  markBrokerDead(reason = 'broker_liveness_dead', atMs: number = this.nowMs()): LivenessSnapshot {
    this.brokerForcedDeadReason = reason;
    return this.evaluate(atMs);
  }

  evaluate(atMs: number = this.nowMs()): LivenessSnapshot {
    const process = this.componentState(
      this.processLastHeartbeatMs,
      atMs,
      this.processStaleAfterMs,
      this.processDeadAfterMs,
      this.processForcedDeadReason,
    );
    const broker = this.componentState(
      this.brokerLastHeartbeatMs,
      atMs,
      this.brokerStaleAfterMs,
      this.brokerDeadAfterMs,
      this.brokerForcedDeadReason,
    );
    const overall = overallState(process.state, broker.state);
    const reason = this.reasonFor(process.state, broker.state);

    if (overall === 'dead' && !this.deadKillSwitchEngaged) {
      this.deadKillSwitchEngaged = true;
      if (!this.killSwitch.isEngaged()) {
        this.killSwitch.engage({
          reason: `liveness_dead:${reason ?? 'unknown'}`,
          source: 'dual_liveness_monitor',
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
        ...(process.age_ms === undefined ? {} : { process_last_heartbeat_age_ms: process.age_ms }),
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
    const process = this.componentState(
      this.processLastHeartbeatMs,
      atMs,
      this.processStaleAfterMs,
      this.processDeadAfterMs,
      this.processForcedDeadReason,
    );
    const broker = this.componentState(
      this.brokerLastHeartbeatMs,
      atMs,
      this.brokerStaleAfterMs,
      this.brokerDeadAfterMs,
      this.brokerForcedDeadReason,
    );
    return {
      process_state: process.state,
      broker_state: broker.state,
      overall_state: overallState(process.state, broker.state),
    };
  }

  private componentState(
    lastHeartbeatMs: number | undefined,
    nowMs: number,
    staleAfterMs: number,
    deadAfterMs: number,
    forcedDeadReason: string | undefined,
  ): { readonly state: LivenessComponentState; readonly age_ms?: number } {
    if (forcedDeadReason !== undefined) {
      return { state: 'dead' };
    }
    if (lastHeartbeatMs === undefined) {
      return { state: 'unknown' };
    }
    const ageMs = Math.max(0, nowMs - lastHeartbeatMs);
    if (ageMs >= deadAfterMs) {
      return { state: 'dead', age_ms: ageMs };
    }
    if (ageMs >= staleAfterMs) {
      return { state: 'stale', age_ms: ageMs };
    }
    return { state: 'alive', age_ms: ageMs };
  }

  private reasonFor(
    processState: LivenessComponentState,
    brokerState: LivenessComponentState,
  ): string | undefined {
    if (this.processForcedDeadReason !== undefined) {
      return this.processForcedDeadReason;
    }
    if (this.brokerForcedDeadReason !== undefined) {
      return this.brokerForcedDeadReason;
    }
    if (processState === 'dead') {
      return 'process_dead';
    }
    if (brokerState === 'dead') {
      return 'broker_dead';
    }
    if (processState === 'stale' || brokerState === 'stale') {
      return 'heartbeat_stale';
    }
    if (processState === 'unknown' || brokerState === 'unknown') {
      return 'heartbeat_unknown';
    }
    return undefined;
  }
}

function overallState(
  processState: LivenessComponentState,
  brokerState: LivenessComponentState,
): LivenessOverallState {
  if (processState === 'dead' || brokerState === 'dead') {
    return 'dead';
  }
  if (processState === 'alive' && brokerState === 'alive') {
    return 'alive';
  }
  return 'degraded';
}
