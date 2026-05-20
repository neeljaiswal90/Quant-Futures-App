import { ns, type UnixNs } from '../contracts/index.js';
import { captureLocalTimestampNs } from './local-timestamp.js';
import {
  SloRegistry,
  type SloBreachEligibility,
  type SloDefinition,
  type SloWindowDefinition,
} from './slo-registry.js';

export type SloWindowState = 'pass' | 'breach' | 'insufficient_data';

export interface SloWindowEvaluation {
  readonly metric_name: string;
  readonly window_id: string;
  readonly state: SloWindowState;
  readonly sample_count: number;
  readonly sample_count_floor: number;
  readonly percentile_value?: number;
  readonly budget_threshold_ms?: number;
  readonly is_provisional: boolean;
  readonly breach_eligibility: SloBreachEligibility;
  readonly evaluated_ts_ns: UnixNs;
}

export interface SloEvaluation {
  readonly metric_name: string;
  readonly aggregate_state: SloWindowState;
  readonly contributing_windows: readonly SloWindowEvaluation[];
  readonly companion_metric_states?: readonly SloWindowEvaluation[];
  readonly is_provisional: boolean;
  readonly breach_eligibility: SloBreachEligibility;
  readonly evaluated_ts_ns: UnixNs;
}

export interface SloStateTransition {
  readonly metric_name: string;
  readonly from_state: SloWindowState;
  readonly to_state: SloWindowState;
  readonly transitioned_ts_ns: UnixNs;
  readonly is_provisional: boolean;
}

export interface SloAnomalyEvent {
  readonly metric_name: string;
  readonly anomaly_code: 'sustained_insufficient_data';
  readonly state: 'insufficient_data';
  readonly sustained_duration_ms: number;
  readonly threshold_ms: number;
  readonly emitted_ts_ns: UnixNs;
  readonly is_provisional: boolean;
}

export interface BurnRateEvaluationResult {
  readonly evaluations: readonly SloEvaluation[];
  readonly transitions: readonly SloStateTransition[];
  readonly anomalies: readonly SloAnomalyEvent[];
}

export interface BurnRateEvaluatorOptions {
  readonly registry?: SloRegistry;
  readonly definitions?: readonly SloDefinition[];
  readonly now_ms?: () => number;
  readonly now_ns?: () => UnixNs;
  readonly sustained_insufficient_data_alert_after_ms?: number;
}

interface TimedSample {
  readonly observed_at_ms: number;
  readonly value_ms: number;
}

const DEFAULT_SUSTAINED_INSUFFICIENT_DATA_ALERT_AFTER_MS = 24 * 60 * 60 * 1_000;

export class BurnRateEvaluator {
  private readonly registry: SloRegistry;
  private readonly nowMs: () => number;
  private readonly nowNs: () => UnixNs;
  private readonly sustainedInsufficientDataAlertAfterMs: number;
  private readonly samplesByMetricName = new Map<string, TimedSample[]>();
  private readonly previousAggregateStateByMetricName = new Map<string, SloWindowState>();
  private readonly insufficientDataSinceMsByMetricName = new Map<string, number>();
  private readonly emittedSustainedInsufficientDataByMetricName = new Set<string>();
  private readonly subscribers = new Set<
    (transitions: readonly SloStateTransition[]) => void
  >();

  constructor(options: BurnRateEvaluatorOptions = {}) {
    this.registry = options.registry ?? new SloRegistry(options.definitions);
    this.nowMs = options.now_ms ?? (() => Date.now());
    this.nowNs = options.now_ns ?? captureLocalTimestampNs;
    this.sustainedInsufficientDataAlertAfterMs =
      options.sustained_insufficient_data_alert_after_ms ??
      DEFAULT_SUSTAINED_INSUFFICIENT_DATA_ALERT_AFTER_MS;
  }

  registerSlo(definition: SloDefinition): void {
    this.registry.registerSlo(definition);
  }

  observeSample(metric_name: string, sample_ms: number): void {
    this.observeSampleAt(metric_name, sample_ms, this.nowMs());
  }

  observeSampleAt(metric_name: string, sample_ms: number, observed_at_ms: number): void {
    this.registry.require(metric_name);
    if (!Number.isFinite(sample_ms) || sample_ms < 0) {
      return;
    }
    if (!Number.isFinite(observed_at_ms)) {
      throw new Error('observed_at_ms must be finite');
    }
    const samples = this.samplesByMetricName.get(metric_name) ?? [];
    samples.push({ observed_at_ms, value_ms: sample_ms });
    this.samplesByMetricName.set(metric_name, samples);
  }

  evaluate(): readonly SloEvaluation[] {
    return this.evaluateWithAnomalies().evaluations;
  }

  evaluateWithAnomalies(): BurnRateEvaluationResult {
    const evaluatedAtMs = this.nowMs();
    const evaluatedTsNs = this.nowNs();
    const baseEvaluations = new Map<string, SloEvaluation>();

    for (const definition of this.registry.list()) {
      baseEvaluations.set(
        definition.metric_name,
        this.evaluateDefinition(definition, evaluatedAtMs, evaluatedTsNs),
      );
    }

    const finalEvaluations = new Map<string, SloEvaluation>();
    for (const definition of this.registry.list()) {
      const baseEvaluation = baseEvaluations.get(definition.metric_name)!;
      finalEvaluations.set(
        definition.metric_name,
        this.applyCompanionState(definition, baseEvaluation, baseEvaluations, evaluatedTsNs),
      );
    }

    const evaluations = [...finalEvaluations.values()].sort((left, right) =>
      left.metric_name.localeCompare(right.metric_name),
    );
    const transitions = this.collectTransitions(evaluations, evaluatedTsNs);
    const anomalies = this.collectSustainedInsufficientDataAnomalies(
      evaluations,
      evaluatedAtMs,
      evaluatedTsNs,
    );

    if (transitions.length > 0) {
      for (const subscriber of this.subscribers) {
        subscriber(transitions);
      }
    }

    this.pruneExpiredSamples(evaluatedAtMs);
    return { evaluations, transitions, anomalies };
  }

  subscribe(handler: (transitions: readonly SloStateTransition[]) => void): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  stopForTests(): void {
    this.subscribers.clear();
    this.samplesByMetricName.clear();
    this.previousAggregateStateByMetricName.clear();
    this.insufficientDataSinceMsByMetricName.clear();
    this.emittedSustainedInsufficientDataByMetricName.clear();
  }

  private evaluateDefinition(
    definition: SloDefinition,
    evaluatedAtMs: number,
    evaluatedTsNs: UnixNs,
  ): SloEvaluation {
    const windows = definition.windows.map((window) =>
      this.evaluateWindow(definition, window, evaluatedAtMs, evaluatedTsNs),
    );
    return {
      metric_name: definition.metric_name,
      aggregate_state: aggregateWindowStates(windows),
      contributing_windows: windows,
      is_provisional: definition.is_provisional,
      breach_eligibility: definition.breach_eligibility,
      evaluated_ts_ns: evaluatedTsNs,
    };
  }

  private evaluateWindow(
    definition: SloDefinition,
    window: SloWindowDefinition,
    evaluatedAtMs: number,
    evaluatedTsNs: UnixNs,
  ): SloWindowEvaluation {
    const samples = this.samplesForWindow(definition.metric_name, window, evaluatedAtMs);
    if (samples.length === 0 || samples.length < window.sample_count_floor) {
      return {
        metric_name: definition.metric_name,
        window_id: window.window_id,
        state: 'insufficient_data',
        sample_count: samples.length,
        sample_count_floor: window.sample_count_floor,
        is_provisional: definition.is_provisional,
        breach_eligibility: definition.breach_eligibility,
        evaluated_ts_ns: evaluatedTsNs,
      };
    }

    const percentileValue = percentile(samples.map((sample) => sample.value_ms), 0.95);
    return {
      metric_name: definition.metric_name,
      window_id: window.window_id,
      state: percentileValue <= window.p95_budget_ms ? 'pass' : 'breach',
      sample_count: samples.length,
      sample_count_floor: window.sample_count_floor,
      percentile_value: percentileValue,
      budget_threshold_ms: window.p95_budget_ms,
      is_provisional: definition.is_provisional,
      breach_eligibility: definition.breach_eligibility,
      evaluated_ts_ns: evaluatedTsNs,
    };
  }

  private samplesForWindow(
    metricName: string,
    window: SloWindowDefinition,
    evaluatedAtMs: number,
  ): readonly TimedSample[] {
    const samples = this.samplesByMetricName.get(metricName) ?? [];
    const cutoffMs = evaluatedAtMs - window.window_duration_ms;
    return samples.filter((sample) => sample.observed_at_ms >= cutoffMs);
  }

  private applyCompanionState(
    definition: SloDefinition,
    baseEvaluation: SloEvaluation,
    baseEvaluations: ReadonlyMap<string, SloEvaluation>,
    evaluatedTsNs: UnixNs,
  ): SloEvaluation {
    if (definition.companion_metric_name === undefined) {
      return baseEvaluation;
    }
    const companion = baseEvaluations.get(definition.companion_metric_name);
    if (companion === undefined) {
      return {
        ...baseEvaluation,
        aggregate_state: baseEvaluation.aggregate_state === 'breach'
          ? 'breach'
          : 'insufficient_data',
        companion_metric_states: [],
        evaluated_ts_ns: evaluatedTsNs,
      };
    }
    const aggregateState = combinePrimaryAndCompanionStates(
      baseEvaluation.aggregate_state,
      companion.aggregate_state,
    );
    return {
      ...baseEvaluation,
      aggregate_state: aggregateState,
      companion_metric_states: companion.contributing_windows,
      evaluated_ts_ns: evaluatedTsNs,
    };
  }

  private collectTransitions(
    evaluations: readonly SloEvaluation[],
    evaluatedTsNs: UnixNs,
  ): readonly SloStateTransition[] {
    const transitions: SloStateTransition[] = [];
    for (const evaluation of evaluations) {
      const previous = this.previousAggregateStateByMetricName.get(evaluation.metric_name);
      if (previous !== undefined && previous !== evaluation.aggregate_state) {
        transitions.push({
          metric_name: evaluation.metric_name,
          from_state: previous,
          to_state: evaluation.aggregate_state,
          transitioned_ts_ns: evaluatedTsNs,
          is_provisional: evaluation.is_provisional,
        });
      }
      this.previousAggregateStateByMetricName.set(
        evaluation.metric_name,
        evaluation.aggregate_state,
      );
    }
    return transitions;
  }

  private collectSustainedInsufficientDataAnomalies(
    evaluations: readonly SloEvaluation[],
    evaluatedAtMs: number,
    evaluatedTsNs: UnixNs,
  ): readonly SloAnomalyEvent[] {
    const anomalies: SloAnomalyEvent[] = [];
    for (const evaluation of evaluations) {
      if (evaluation.aggregate_state !== 'insufficient_data') {
        this.insufficientDataSinceMsByMetricName.delete(evaluation.metric_name);
        this.emittedSustainedInsufficientDataByMetricName.delete(evaluation.metric_name);
        continue;
      }
      const sinceMs = this.insufficientDataSinceMsByMetricName.get(evaluation.metric_name)
        ?? evaluatedAtMs;
      this.insufficientDataSinceMsByMetricName.set(evaluation.metric_name, sinceMs);
      const sustainedDurationMs = evaluatedAtMs - sinceMs;
      if (
        sustainedDurationMs >= this.sustainedInsufficientDataAlertAfterMs &&
        !this.emittedSustainedInsufficientDataByMetricName.has(evaluation.metric_name)
      ) {
        anomalies.push({
          metric_name: evaluation.metric_name,
          anomaly_code: 'sustained_insufficient_data',
          state: 'insufficient_data',
          sustained_duration_ms: sustainedDurationMs,
          threshold_ms: this.sustainedInsufficientDataAlertAfterMs,
          emitted_ts_ns: evaluatedTsNs,
          is_provisional: evaluation.is_provisional,
        });
        this.emittedSustainedInsufficientDataByMetricName.add(evaluation.metric_name);
      }
    }
    return anomalies;
  }

  private pruneExpiredSamples(evaluatedAtMs: number): void {
    const longestWindowMs = Math.max(
      ...this.registry.list().flatMap((definition) =>
        definition.windows.map((window) => window.window_duration_ms),
      ),
      0,
    );
    const cutoffMs = evaluatedAtMs - longestWindowMs;
    for (const [metricName, samples] of this.samplesByMetricName.entries()) {
      this.samplesByMetricName.set(
        metricName,
        samples.filter((sample) => sample.observed_at_ms >= cutoffMs),
      );
    }
  }
}

export function aggregateWindowStates(
  windows: readonly Pick<SloWindowEvaluation, 'state'>[],
): SloWindowState {
  if (windows.some((window) => window.state === 'breach')) {
    return 'breach';
  }
  if (windows.every((window) => window.state === 'pass')) {
    return 'pass';
  }
  return 'insufficient_data';
}

export function combinePrimaryAndCompanionStates(
  primary: SloWindowState,
  companion: SloWindowState,
): SloWindowState {
  if (primary === 'breach' || companion === 'breach') {
    return 'breach';
  }
  if (primary === 'pass' && companion === 'pass') {
    return 'pass';
  }
  return 'insufficient_data';
}

export function histogramP95(
  bucketUpperBoundsMs: readonly number[],
  cumulativeBucketCounts: readonly number[],
): number | undefined {
  if (bucketUpperBoundsMs.length === 0 || cumulativeBucketCounts.length === 0) {
    return undefined;
  }
  const total = cumulativeBucketCounts[cumulativeBucketCounts.length - 1]!;
  if (!Number.isFinite(total) || total <= 0) {
    return undefined;
  }
  const target = Math.ceil(total * 0.95);
  for (let index = 0; index < cumulativeBucketCounts.length; index += 1) {
    if ((cumulativeBucketCounts[index] ?? 0) >= target) {
      return bucketUpperBoundsMs[index] ?? bucketUpperBoundsMs[bucketUpperBoundsMs.length - 1];
    }
  }
  return bucketUpperBoundsMs[bucketUpperBoundsMs.length - 1];
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) {
    throw new Error('cannot compute percentile over empty values');
  }
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(ordered.length * quantile) - 1),
  );
  return ordered[index]!;
}

export function unixNsFromMsForTests(ms: number): UnixNs {
  return ns(BigInt(Math.trunc(ms)) * 1_000_000n);
}
