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
  auth_reject_count: 5,
  heartbeat_skew_ms: 5_000,
  reconnect_storm_window_ms: 300_000,
  reconnect_storm_count: 3,
} as const satisfies Required<AnomalyDetectorThresholds>;

export class AnomalyDetector {
  private readonly killSwitch: Pick<KillSwitchController, 'engage' | 'isEngaged'>;
  private readonly emitEvent: (event: AnomalyDetectorEvent) => void;
  private readonly thresholds: Required<AnomalyDetectorThresholds>;
  private readonly nowMs: () => number;
  private readonly nowNs: () => UnixNs;
  private readonly quarantineTimesMs: number[] = [];
  private readonly authRejectTimesMs: number[] = [];
  private readonly reconnectAttemptTimesMs: number[] = [];

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
      default:
        return;
    }
  }

  recordQuarantine(atMs: number = this.nowMs()): void {
    this.quarantineTimesMs.push(atMs);
    trimWindow(this.quarantineTimesMs, atMs, this.thresholds.rapid_quarantine_window_ms);
    if (this.quarantineTimesMs.length >= this.thresholds.rapid_quarantine_count) {
      this.emitAnomaly({
        rule_id: 'rapid_quarantine_accumulation',
        severity: 'high',
        evidence_summary: `${this.quarantineTimesMs.length} quarantines within ${this.thresholds.rapid_quarantine_window_ms}ms`,
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
        rule_id: 'auth_reject_burst',
        severity: 'high',
        evidence_summary: `${this.authRejectTimesMs.length} auth rejects within ${this.thresholds.auth_reject_window_ms}ms (${classification.canonical_subreason})`,
      });
    }
  }

  recordHeartbeatSkew(
    brokerTimestampMs: number,
    localClockMs: number = this.nowMs(),
  ): void {
    const skewMs = Math.abs(localClockMs - brokerTimestampMs);
    if (skewMs <= this.thresholds.heartbeat_skew_ms) {
      return;
    }
    this.emitAnomaly({
      rule_id: 'heartbeat_skew',
      severity: 'medium',
      evidence_summary: `broker/local heartbeat skew ${skewMs}ms exceeds ${this.thresholds.heartbeat_skew_ms}ms`,
    });
  }

  recordReconnectState(
    payload: Pick<JournalEventPayloadFor<'RECONNECT_STATE'>, 'phase'>,
    atMs: number = this.nowMs(),
  ): void {
    if (payload.phase !== 'attempt') {
      return;
    }
    this.reconnectAttemptTimesMs.push(atMs);
    trimWindow(this.reconnectAttemptTimesMs, atMs, this.thresholds.reconnect_storm_window_ms);
    if (this.reconnectAttemptTimesMs.length >= this.thresholds.reconnect_storm_count) {
      this.emitAnomaly({
        rule_id: 'reconnect_storm',
        severity: 'medium',
        evidence_summary: `${this.reconnectAttemptTimesMs.length} reconnect attempts within ${this.thresholds.reconnect_storm_window_ms}ms`,
      });
    }
  }

  private emitAnomaly(input: {
    readonly rule_id: JournalEventPayloadFor<'ANOMALY_DETECTED'>['rule_id'];
    readonly severity: JournalEventPayloadFor<'ANOMALY_DETECTED'>['severity'];
    readonly evidence_summary: string;
  }): void {
    const autoAction: JournalEventPayloadFor<'ANOMALY_DETECTED'>['auto_action'] =
      input.severity === 'high' ? 'kill_switch_engaged' : 'alert_only';
    const tsNs = this.nowNs();
    this.emitEvent({
      type: 'ANOMALY_DETECTED',
      ts_ns: tsNs,
      payload: {
        rule_id: input.rule_id,
        severity: input.severity,
        triggered_ts_ns: tsNs,
        evidence_summary: input.evidence_summary,
        auto_action: autoAction,
      },
    });
    if (autoAction === 'kill_switch_engaged' && !this.killSwitch.isEngaged()) {
      this.killSwitch.engage({
        reason: `anomaly:${input.rule_id}`,
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
