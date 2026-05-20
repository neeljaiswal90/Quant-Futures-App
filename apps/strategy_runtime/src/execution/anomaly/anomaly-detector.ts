import {
  ns,
  type AnyJournalEventEnvelope,
  type JournalEventPayloadFor,
  type UnixNs,
} from '../../contracts/index.js';
import { parseBrokerRejectCode } from '../failure-taxonomy.js';
import type { KillSwitchController } from '../kill-switch/kill-switch-controller.js';

export interface AnomalyDetectorThresholds {
  readonly rapid_quarantine_window_ms?: number;
  readonly rapid_quarantine_count?: number;
  readonly auth_reject_window_ms?: number;
  readonly auth_reject_count?: number;
  readonly heartbeat_skew_ms?: number;
  readonly critical_heartbeat_skew_ms?: number;
  readonly reconnect_storm_window_ms?: number;
  readonly reconnect_storm_count?: number;
}

export interface AnomalyDetectorOptions {
  readonly kill_switch: Pick<KillSwitchController, 'engage' | 'isEngaged'>;
  readonly emit?: (event: AnomalyDetectorEvent) => void;
  readonly thresholds?: AnomalyDetectorThresholds;
  readonly now_ms?: () => number;
  readonly now_ns?: () => UnixNs;
}

export interface AnomalyDetectorEvent {
  readonly type: 'ANOMALY_DETECTED';
  readonly ts_ns: UnixNs;
  readonly payload: JournalEventPayloadFor<'ANOMALY_DETECTED'>;
}

const DEFAULT_THRESHOLDS = {
  rapid_quarantine_window_ms: 60_000,
  rapid_quarantine_count: 3,
  auth_reject_window_ms: 60_000,
  auth_reject_count: 3,
  heartbeat_skew_ms: 5_000,
  critical_heartbeat_skew_ms: 30_000,
  reconnect_storm_window_ms: 120_000,
  reconnect_storm_count: 5,
} as const satisfies Required<AnomalyDetectorThresholds>;

export class AnomalyDetector {
  private readonly killSwitch: Pick<KillSwitchController, 'engage' | 'isEngaged'>;
  private readonly emitEvent: (event: AnomalyDetectorEvent) => void;
  private readonly thresholds: Required<AnomalyDetectorThresholds>;
  private readonly nowMs: () => number;
  private readonly nowNs: () => UnixNs;
  private readonly quarantineTimesMs: number[] = [];
  private readonly authRejectTimesMs: number[] = [];
  private readonly reconnectTimesMs: number[] = [];
  private anomalySequence = 0;

  constructor(options: AnomalyDetectorOptions) {
    this.killSwitch = options.kill_switch;
    this.emitEvent = options.emit ?? (() => undefined);
    this.thresholds = {
      ...DEFAULT_THRESHOLDS,
      ...(options.thresholds ?? {}),
    };
    this.nowMs = options.now_ms ?? (() => Date.now());
    this.nowNs = options.now_ns ?? (() => ns(BigInt(this.nowMs()) * 1_000_000n));
  }

  observeEvent(event: AnyJournalEventEnvelope): void {
    switch (event.type) {
      case 'ORDER_QUARANTINE_ENTERED':
        this.recordQuarantine(nsToMs(event.ts_ns));
        return;
      case 'ORDER_BROKER_REJECT': {
        const payload = event.payload as JournalEventPayloadFor<'ORDER_BROKER_REJECT'>;
        this.recordBrokerReject(payload.reject_reason_code, payload.reject_subreason, nsToMs(event.ts_ns));
        return;
      }
      case 'RECONNECT_STATE': {
        const payload = event.payload as JournalEventPayloadFor<'RECONNECT_STATE'>;
        this.recordReconnectState(payload, nsToMs(event.ts_ns));
        return;
      }
      case 'LIVENESS_STATE': {
        const payload = event.payload as JournalEventPayloadFor<'LIVENESS_STATE'>;
        if (
          payload.process_last_heartbeat_age_ms !== undefined &&
          payload.broker_last_heartbeat_age_ms !== undefined
        ) {
          this.recordHeartbeatSkew(
            payload.process_last_heartbeat_age_ms,
            payload.broker_last_heartbeat_age_ms,
            nsToMs(event.ts_ns),
          );
        }
        return;
      }
      default:
        return;
    }
  }

  recordQuarantine(atMs: number = this.nowMs()): void {
    this.quarantineTimesMs.push(atMs);
    trimWindow(this.quarantineTimesMs, atMs, this.thresholds.rapid_quarantine_window_ms);
    if (this.quarantineTimesMs.length >= this.thresholds.rapid_quarantine_count) {
      this.emitAnomaly({
        rule: 'rapid_quarantine',
        severity: 'high',
        message: 'rapid order quarantine burst detected',
        count: this.quarantineTimesMs.length,
        threshold: this.thresholds.rapid_quarantine_count,
        window_ms: this.thresholds.rapid_quarantine_window_ms,
      });
    }
  }

  recordBrokerReject(
    rejectReasonCode: string,
    rejectSubreason?: string,
    atMs: number = this.nowMs(),
  ): void {
    const classification = parseBrokerRejectCode(rejectReasonCode, rejectSubreason);
    if (classification.category !== 'auth') {
      return;
    }
    this.authRejectTimesMs.push(atMs);
    trimWindow(this.authRejectTimesMs, atMs, this.thresholds.auth_reject_window_ms);
    if (this.authRejectTimesMs.length >= this.thresholds.auth_reject_count) {
      this.emitAnomaly({
        rule: 'auth_reject_burst',
        severity: 'high',
        message: 'authentication reject burst detected',
        count: this.authRejectTimesMs.length,
        threshold: this.thresholds.auth_reject_count,
        window_ms: this.thresholds.auth_reject_window_ms,
        details: {
          canonical_subreason: classification.canonical_subreason,
        },
      });
    }
  }

  recordHeartbeatSkew(
    processHeartbeatAgeMs: number,
    brokerHeartbeatAgeMs: number,
    _atMs: number = this.nowMs(),
  ): void {
    const skewMs = Math.abs(processHeartbeatAgeMs - brokerHeartbeatAgeMs);
    if (skewMs < this.thresholds.heartbeat_skew_ms) {
      return;
    }
    this.emitAnomaly({
      rule: 'heartbeat_skew',
      severity: skewMs >= this.thresholds.critical_heartbeat_skew_ms ? 'high' : 'medium',
      message: 'process and broker heartbeat ages diverged',
      count: skewMs,
      threshold: this.thresholds.heartbeat_skew_ms,
      details: {
        process_heartbeat_age_ms: processHeartbeatAgeMs,
        broker_heartbeat_age_ms: brokerHeartbeatAgeMs,
        skew_ms: skewMs,
      },
    });
  }

  recordReconnectState(
    payload: Pick<JournalEventPayloadFor<'RECONNECT_STATE'>, 'phase'>,
    atMs: number = this.nowMs(),
  ): void {
    if (payload.phase !== 'attempt' && payload.phase !== 'exhausted') {
      return;
    }
    this.reconnectTimesMs.push(atMs);
    trimWindow(this.reconnectTimesMs, atMs, this.thresholds.reconnect_storm_window_ms);
    if (this.reconnectTimesMs.length >= this.thresholds.reconnect_storm_count) {
      this.emitAnomaly({
        rule: 'reconnect_storm',
        severity: 'high',
        message: 'reconnect storm detected',
        count: this.reconnectTimesMs.length,
        threshold: this.thresholds.reconnect_storm_count,
        window_ms: this.thresholds.reconnect_storm_window_ms,
      });
    }
  }

  private emitAnomaly(input: {
    readonly rule: JournalEventPayloadFor<'ANOMALY_DETECTED'>['rule'];
    readonly severity: JournalEventPayloadFor<'ANOMALY_DETECTED'>['severity'];
    readonly message: string;
    readonly count?: number;
    readonly threshold?: number;
    readonly window_ms?: number;
    readonly details?: JournalEventPayloadFor<'ANOMALY_DETECTED'>['details'];
  }): void {
    this.anomalySequence += 1;
    const autoEngage = input.severity === 'high';
    const tsNs = this.nowNs();
    this.emitEvent({
      type: 'ANOMALY_DETECTED',
      ts_ns: tsNs,
      payload: {
        anomaly_id: `anomaly-${this.anomalySequence}`,
        rule: input.rule,
        severity: input.severity,
        observed_at_ts_ns: tsNs,
        message: input.message,
        auto_engaged_kill_switch: autoEngage,
        ...(input.count === undefined ? {} : { count: input.count }),
        ...(input.threshold === undefined ? {} : { threshold: input.threshold }),
        ...(input.window_ms === undefined ? {} : { window_ms: input.window_ms }),
        ...(input.details === undefined ? {} : { details: input.details }),
      },
    });
    if (autoEngage && !this.killSwitch.isEngaged()) {
      this.killSwitch.engage({
        reason: `anomaly:${input.rule}`,
        source: 'anomaly_detector',
      });
    }
  }
}

function trimWindow(values: number[], nowMs: number, windowMs: number): void {
  while (values.length > 0 && nowMs - values[0]! > windowMs) {
    values.shift();
  }
}

function nsToMs(value: UnixNs): number {
  return Number(BigInt(value) / 1_000_000n);
}
