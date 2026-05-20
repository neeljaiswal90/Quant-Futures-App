import type { AnyJournalEventEnvelope, JournalEventPayloadFor, RuntimeEventType, UnixNs } from '../../contracts/index.js';
import type { ExecutionCapabilityMask } from '../../execution/execution-capability-mask.js';
import { buildExecutionCapabilityMask } from '../../execution/execution-capability-mask.js';
import type { ValidatorIssueSeverity } from '../../contracts/events/payloads.js';
import {
  LATENCY_HISTOGRAM_METRIC_NAMES,
  PROVISIONAL_LATENCY_HISTOGRAM_BUCKETS_MS,
  type LatencyHistogramMetricName,
  type LatencySliRegistry,
} from '../../observability/latency-sli.js';
import type {
  BurnRateEvaluator,
  SloEvaluation,
  SloStateTransition,
  SloWindowState,
} from '../../observability/burn-rate-evaluator.js';

export interface SubmissionGateSnapshotLike {
  readonly open_quarantine_count: number;
  readonly active_block_sources: readonly string[];
}

export interface HeaderPanelState {
  readonly session_id?: string;
  readonly mode?: 'paper' | 'live';
  readonly uptime_ms: number;
  readonly strategy_id?: string;
  readonly capability_mask_version?: number;
  readonly manifest_ts_ns?: UnixNs;
}

export interface SloWindowPanelState {
  readonly window_id: string;
  readonly state: SloWindowState;
  readonly sample_count: number;
  readonly sample_count_floor: number;
  readonly percentile_value?: number;
  readonly budget_threshold_ms?: number;
}

export interface SloMetricPanelState {
  readonly metric_name: string;
  readonly state: SloWindowState;
  readonly last_transition_ts_ns?: UnixNs;
  readonly is_provisional: boolean;
  readonly breach_eligibility: string;
  readonly windows: readonly SloWindowPanelState[];
}

export interface SloPanelState {
  readonly metrics: readonly SloMetricPanelState[];
}

export interface QuarantineOrderSummary {
  readonly intent_id: string;
  readonly previous_state: string;
  readonly quarantine_reason: string;
  readonly broker_order_id?: string;
  readonly instrument_symbol?: string;
  readonly open_quarantine_count: number;
  readonly escalation_required: boolean;
  readonly is_provisional: boolean;
  readonly entered_ts_ns: UnixNs;
}

export interface QuarantinePanelState {
  readonly open_quarantine_count: number;
  readonly escalation_required: boolean;
  readonly orders: readonly QuarantineOrderSummary[];
}

export interface HaltEmissionSummary {
  readonly type: 'HALT' | 'WOULD_HALT';
  readonly state: 'halted' | 'resumed';
  readonly reason?: string;
  readonly resolved?: boolean;
  readonly ts_ns: UnixNs;
}

export interface HaltPanelState {
  readonly emissions: readonly HaltEmissionSummary[];
  readonly current_block_sources: readonly string[];
}

export interface ValidatorIssueSummary {
  readonly validator_id: string;
  readonly severity: ValidatorIssueSeverity;
  readonly emitted_ts_ns: UnixNs;
  readonly code: string;
  readonly message: string;
  readonly source_event_type?: string;
}

export interface ValidatorsPanelState {
  readonly issues: readonly ValidatorIssueSummary[];
}

export interface LatencyMetricPanelState {
  readonly metric_name: LatencyHistogramMetricName;
  readonly labels: Readonly<Record<string, string>>;
  readonly count: number;
  readonly p50_ms?: number;
  readonly p95_ms?: number;
  readonly p99_ms?: number;
  readonly bucket_utilization: string;
}

export interface LatencyPanelState {
  readonly metrics: readonly LatencyMetricPanelState[];
  readonly ack_intent_cache_misses: number;
}

export type MaskDriftStatus = 'ok' | 'drift_detected';

export interface MaskPanelState {
  readonly mask_id?: string;
  readonly mask_version?: number;
  readonly mask_hash?: string;
  readonly drift_status: MaskDriftStatus;
  readonly drift_code?: string;
  readonly drift_severity?: ValidatorIssueSeverity;
  readonly drift_ts_ns?: UnixNs;
}

export interface FutureOperatorPanelSlot {
  readonly id: 'liveness' | 'kill_switch' | 'anomalies';
  readonly title: string;
  readonly event_types: readonly string[];
}

export interface OperatorConsoleState {
  readonly header: HeaderPanelState;
  readonly slo: SloPanelState;
  readonly quarantine: QuarantinePanelState;
  readonly halt: HaltPanelState;
  readonly validators: ValidatorsPanelState;
  readonly latency: LatencyPanelState;
  readonly mask: MaskPanelState;
  readonly future_panel_slots: readonly FutureOperatorPanelSlot[];
}

export interface OperatorConsoleStateStoreOptions {
  readonly now_ms?: () => number;
  readonly started_at_ms?: number;
  readonly strategy_id?: string;
  readonly burn_rate_evaluator?: BurnRateEvaluator;
  readonly latency_registry?: LatencySliRegistry;
  readonly submission_gate?: SubmissionGateSnapshotLike;
  readonly capability_mask?: ExecutionCapabilityMask;
}

const CURRENT_OPERATOR_EVENT_TYPES = [
  'SESSION_MANIFEST',
  'HALT',
  'WOULD_HALT',
  'VALIDATOR_ISSUE',
  'ORDER_QUARANTINE_ENTERED',
  'ORDER_QUARANTINE_CLEARED',
] as const satisfies readonly RuntimeEventType[];

export type CurrentOperatorConsoleEventType = (typeof CURRENT_OPERATOR_EVENT_TYPES)[number];

export const OPERATOR_CONSOLE_CURRENT_EVENT_TYPES: readonly CurrentOperatorConsoleEventType[] =
  CURRENT_OPERATOR_EVENT_TYPES;

export const OPERATOR_CONSOLE_FUTURE_PANEL_SLOTS: readonly FutureOperatorPanelSlot[] = [
  {
    id: 'liveness',
    title: 'Liveness',
    event_types: ['LIVENESS_STATE'],
  },
  {
    id: 'kill_switch',
    title: 'Kill Switch',
    event_types: ['KILL_SWITCH_ENGAGED', 'KILL_SWITCH_DISENGAGED'],
  },
  {
    id: 'anomalies',
    title: 'Anomalies',
    event_types: ['ANOMALY_DETECTED'],
  },
];

export class OperatorConsoleStateStore {
  private readonly nowMs: () => number;
  private readonly startedAtMs: number;
  private readonly burnRateEvaluator?: BurnRateEvaluator;
  private readonly latencyRegistry?: LatencySliRegistry;
  private readonly submissionGate?: SubmissionGateSnapshotLike;
  private readonly state: MutableOperatorConsoleState;
  private readonly quarantineOrdersByIntent = new Map<string, QuarantineOrderSummary>();
  private readonly lastSloTransitionByMetric = new Map<string, SloStateTransition>();
  private readonly seenSloTransitionKeys = new Set<string>();

  constructor(options: OperatorConsoleStateStoreOptions = {}) {
    this.nowMs = options.now_ms ?? (() => Date.now());
    this.startedAtMs = options.started_at_ms ?? this.nowMs();
    this.burnRateEvaluator = options.burn_rate_evaluator;
    this.latencyRegistry = options.latency_registry;
    this.submissionGate = options.submission_gate;
    const mask = options.capability_mask ?? buildExecutionCapabilityMask();
    this.state = {
      header: {
        uptime_ms: 0,
        strategy_id: options.strategy_id,
        capability_mask_version: mask.mask_version,
      },
      slo: { metrics: [] },
      quarantine: {
        open_quarantine_count: 0,
        escalation_required: false,
        orders: [],
      },
      halt: {
        emissions: [],
        current_block_sources: [],
      },
      validators: { issues: [] },
      latency: {
        metrics: [],
        ack_intent_cache_misses: 0,
      },
      mask: {
        mask_id: mask.mask_id,
        mask_version: mask.mask_version,
        mask_hash: mask.mask_hash,
        drift_status: 'ok',
      },
      future_panel_slots: OPERATOR_CONSOLE_FUTURE_PANEL_SLOTS,
    };
  }

  subscribeToBurnRateEvaluator(): () => void {
    if (this.burnRateEvaluator === undefined) {
      return () => undefined;
    }
    return this.burnRateEvaluator.subscribe((transitions) => {
      this.recordSloTransitions(transitions);
    });
  }

  observeEvent(event: AnyJournalEventEnvelope): void {
    switch (event.type) {
      case 'SESSION_MANIFEST':
        this.observeSessionManifest(event as EventOf<'SESSION_MANIFEST'>);
        return;
      case 'HALT':
      case 'WOULD_HALT':
        this.observeHalt(event as EventOf<'HALT'> | EventOf<'WOULD_HALT'>);
        return;
      case 'VALIDATOR_ISSUE':
        this.observeValidatorIssue(event as EventOf<'VALIDATOR_ISSUE'>);
        return;
      case 'ORDER_QUARANTINE_ENTERED':
        this.observeQuarantineEntered(event as EventOf<'ORDER_QUARANTINE_ENTERED'>);
        return;
      case 'ORDER_QUARANTINE_CLEARED':
        this.observeQuarantineCleared(event as EventOf<'ORDER_QUARANTINE_CLEARED'>);
        return;
      default:
        return;
    }
  }

  captureSnapshots(): void {
    this.captureSloSnapshot();
    this.captureLatencySnapshot();
    this.captureSubmissionGateSnapshot();
  }

  getState(): OperatorConsoleState {
    const uptimeMs = Math.max(0, this.nowMs() - this.startedAtMs);
    return {
      header: {
        ...this.state.header,
        uptime_ms: uptimeMs,
      },
      slo: {
        metrics: this.state.slo.metrics.map((metric) => ({
          ...metric,
          windows: metric.windows.map((window) => ({ ...window })),
        })),
      },
      quarantine: {
        open_quarantine_count: this.state.quarantine.open_quarantine_count,
        escalation_required: this.state.quarantine.escalation_required,
        orders: this.sortedQuarantineOrders(),
      },
      halt: {
        emissions: this.state.halt.emissions.map((emission) => ({ ...emission })),
        current_block_sources: [...this.state.halt.current_block_sources],
      },
      validators: {
        issues: this.state.validators.issues.map((issue) => ({ ...issue })),
      },
      latency: {
        ack_intent_cache_misses: this.state.latency.ack_intent_cache_misses,
        metrics: this.state.latency.metrics.map((metric) => ({
          ...metric,
          labels: { ...metric.labels },
        })),
      },
      mask: { ...this.state.mask },
      future_panel_slots: this.state.future_panel_slots.map((slot) => ({
        ...slot,
        event_types: [...slot.event_types],
      })),
    };
  }

  private observeSessionManifest(event: EventOf<'SESSION_MANIFEST'>): void {
    const payload = event.payload;
    this.state.header.session_id = String(event.session_id);
    this.state.header.mode = payload.mode;
    this.state.header.capability_mask_version = payload.mask_version;
    this.state.header.manifest_ts_ns = event.ts_ns;
    this.state.mask.mask_id = payload.mask_id;
    this.state.mask.mask_version = payload.mask_version;
    this.state.mask.mask_hash = payload.mask_hash;
  }

  private observeHalt(event: EventOf<'HALT'> | EventOf<'WOULD_HALT'>): void {
    this.state.halt.emissions = [
      ...this.state.halt.emissions,
      {
        type: event.type,
        state: event.payload.state,
        reason: event.payload.reason,
        resolved: event.payload.resolved,
        ts_ns: event.ts_ns,
      },
    ].slice(-5);
  }

  private observeValidatorIssue(event: EventOf<'VALIDATOR_ISSUE'>): void {
    const payload = event.payload;
    this.state.validators.issues = [
      ...this.state.validators.issues,
      {
        validator_id: payload.validator_id,
        severity: payload.severity,
        emitted_ts_ns: payload.emitted_ts_ns,
        code: payload.code,
        message: payload.message,
        source_event_type: payload.source_event_type,
      },
    ].slice(-5);

    if (payload.validator_id === 'EXEC-VALIDATOR-07') {
      this.state.mask.drift_status = payload.code === 'execution_mask_drift' ? 'drift_detected' : 'ok';
      this.state.mask.drift_code = payload.code;
      this.state.mask.drift_severity = payload.severity;
      this.state.mask.drift_ts_ns = payload.emitted_ts_ns;
    }
  }

  private observeQuarantineEntered(event: EventOf<'ORDER_QUARANTINE_ENTERED'>): void {
    const payload = event.payload;
    const summary: QuarantineOrderSummary = {
      intent_id: String(payload.intent_id),
      previous_state: payload.previous_state,
      quarantine_reason: payload.quarantine_reason,
      broker_order_id: payload.broker_order_id,
      instrument_symbol: payload.instrument_symbol,
      open_quarantine_count: payload.open_quarantine_count,
      escalation_required: payload.escalation_required === true,
      is_provisional: payload.is_provisional === true,
      entered_ts_ns: event.ts_ns,
    };
    this.quarantineOrdersByIntent.set(summary.intent_id, summary);
    this.state.quarantine.open_quarantine_count = payload.open_quarantine_count;
    this.state.quarantine.escalation_required = this.hasEscalationRequired();
    this.state.quarantine.orders = this.sortedQuarantineOrders();
  }

  private observeQuarantineCleared(event: EventOf<'ORDER_QUARANTINE_CLEARED'>): void {
    for (const intentId of event.payload.resolved_intent_ids) {
      this.quarantineOrdersByIntent.delete(String(intentId));
    }
    this.state.quarantine.open_quarantine_count = event.payload.open_quarantine_count;
    this.state.quarantine.escalation_required = this.hasEscalationRequired();
    this.state.quarantine.orders = this.sortedQuarantineOrders();
  }

  private captureSloSnapshot(): void {
    if (this.burnRateEvaluator === undefined) {
      return;
    }
    const result = this.burnRateEvaluator.evaluateWithAnomalies();
    this.recordSloTransitions(result.transitions);
    this.state.slo.metrics = result.evaluations.map((evaluation) =>
      this.sloMetricPanelState(evaluation),
    );
  }

  private sloMetricPanelState(evaluation: SloEvaluation): SloMetricPanelState {
    const transition = this.lastSloTransitionByMetric.get(evaluation.metric_name);
    return {
      metric_name: evaluation.metric_name,
      state: evaluation.aggregate_state,
      last_transition_ts_ns: transition?.transitioned_ts_ns,
      is_provisional: evaluation.is_provisional,
      breach_eligibility: evaluation.breach_eligibility,
      windows: evaluation.contributing_windows.map((window) => ({
        window_id: window.window_id,
        state: window.state,
        sample_count: window.sample_count,
        sample_count_floor: window.sample_count_floor,
        percentile_value: window.percentile_value,
        budget_threshold_ms: window.budget_threshold_ms,
      })),
    };
  }

  private recordSloTransitions(transitions: readonly SloStateTransition[]): void {
    for (const transition of transitions) {
      const key = [
        transition.metric_name,
        transition.from_state,
        transition.to_state,
        String(transition.transitioned_ts_ns),
      ].join('|');
      if (this.seenSloTransitionKeys.has(key)) {
        continue;
      }
      this.seenSloTransitionKeys.add(key);
      this.lastSloTransitionByMetric.set(transition.metric_name, transition);
    }
  }

  private captureLatencySnapshot(): void {
    if (this.latencyRegistry === undefined) {
      return;
    }
    this.state.latency.metrics = LATENCY_HISTOGRAM_METRIC_NAMES.map((metricName) =>
      this.latencyMetricPanelState(metricName),
    );
    this.state.latency.ack_intent_cache_misses = this.latencyRegistry.ackIntentCacheMisses();
  }

  private latencyMetricPanelState(metricName: LatencyHistogramMetricName): LatencyMetricPanelState {
    const labels = this.labelsForLatencyMetric(metricName);
    const series = this.latencyRegistry?.histogramSnapshot(metricName, labels);
    const bucketBounds = PROVISIONAL_LATENCY_HISTOGRAM_BUCKETS_MS;
    const bucketCounts = series?.bucketCounts ?? Array.from({ length: bucketBounds.length + 1 }, () => 0);
    const count = series?.count ?? 0;
    return {
      metric_name: metricName,
      labels,
      count,
      p50_ms: histogramQuantile(bucketBounds, bucketCounts, 0.5),
      p95_ms: histogramQuantile(bucketBounds, bucketCounts, 0.95),
      p99_ms: histogramQuantile(bucketBounds, bucketCounts, 0.99),
      bucket_utilization: bucketUtilization(bucketCounts, bucketBounds.length),
    };
  }

  private labelsForLatencyMetric(metricName: LatencyHistogramMetricName): Readonly<Record<string, string>> {
    if (metricName !== 'qfa_strategy_decision_ms') {
      return {};
    }
    const strategyId = this.state.header.strategy_id;
    return strategyId === undefined ? {} : { strategy_id: strategyId };
  }

  private captureSubmissionGateSnapshot(): void {
    if (this.submissionGate === undefined) {
      return;
    }
    this.state.quarantine.open_quarantine_count = this.submissionGate.open_quarantine_count;
    this.state.quarantine.escalation_required = this.hasEscalationRequired();
    this.state.halt.current_block_sources = [...this.submissionGate.active_block_sources].sort();
  }

  private sortedQuarantineOrders(): readonly QuarantineOrderSummary[] {
    return [...this.quarantineOrdersByIntent.values()].sort((left, right) =>
      left.intent_id.localeCompare(right.intent_id),
    );
  }

  private hasEscalationRequired(): boolean {
    return [...this.quarantineOrdersByIntent.values()].some((order) => order.escalation_required);
  }
}

type EventOf<TType extends CurrentOperatorConsoleEventType> = Extract<
  AnyJournalEventEnvelope,
  { readonly type: TType; readonly payload: JournalEventPayloadFor<TType> }
>;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
interface MutableOperatorConsoleState {
  header: Mutable<HeaderPanelState>;
  slo: { metrics: SloMetricPanelState[] };
  quarantine: {
    open_quarantine_count: number;
    escalation_required: boolean;
    orders: readonly QuarantineOrderSummary[];
  };
  halt: {
    emissions: HaltEmissionSummary[];
    current_block_sources: readonly string[];
  };
  validators: { issues: ValidatorIssueSummary[] };
  latency: {
    metrics: LatencyMetricPanelState[];
    ack_intent_cache_misses: number;
  };
  mask: Mutable<MaskPanelState>;
  future_panel_slots: readonly FutureOperatorPanelSlot[];
};

function histogramQuantile(
  bucketBounds: readonly number[],
  cumulativeBucketCounts: readonly number[],
  quantile: number,
): number | undefined {
  const total = cumulativeBucketCounts[cumulativeBucketCounts.length - 1] ?? 0;
  if (!Number.isFinite(total) || total <= 0) {
    return undefined;
  }
  const target = Math.ceil(total * quantile);
  for (let index = 0; index < cumulativeBucketCounts.length; index += 1) {
    if ((cumulativeBucketCounts[index] ?? 0) >= target) {
      return bucketBounds[index] ?? bucketBounds[bucketBounds.length - 1];
    }
  }
  return bucketBounds[bucketBounds.length - 1];
}

function bucketUtilization(
  cumulativeBucketCounts: readonly number[],
  finiteBucketCount: number,
): string {
  if (finiteBucketCount === 0) {
    return '0/0';
  }
  let used = 0;
  let previous = 0;
  for (let index = 0; index < finiteBucketCount; index += 1) {
    const current = cumulativeBucketCounts[index] ?? 0;
    if (current > previous) {
      used += 1;
    }
    previous = current;
  }
  return `${used}/${finiteBucketCount}`;
}
