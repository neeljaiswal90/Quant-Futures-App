import { createServer, type Server } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import type {
  AnyJournalEventEnvelope,
  BrokerJournalEventEnvelope,
  JournalEventEnvelope,
  JournalEventPayloadFor,
  UnixNs,
} from '../contracts/index.js';
import type { StrategyId } from '../contracts/strategy-ids.js';

export const PROVISIONAL_LATENCY_BUCKET_MARKER =
  'PROVISIONAL QFA-626 buckets pending QFA-631 post-paper ratification' as const;

export const PROVISIONAL_LATENCY_HISTOGRAM_BUCKETS_MS = [
  0.5,
  1,
  2.5,
  5,
  10,
  25,
  50,
  100,
  250,
  500,
  1_000,
  2_500,
  5_000,
] as const;

export const PRIMARY_LATENCY_HISTOGRAM_METRIC_NAMES = [
  'qfa_strategy_decision_ms',
  'qfa_event_loop_lag_ms',
  'qfa_snapshot_to_submit_ms',
  'qfa_order_ack_submission_ms',
  'qfa_order_ack_cancel_ms',
] as const;

export const LATENCY_HISTOGRAM_METRIC_NAMES = [
  ...PRIMARY_LATENCY_HISTOGRAM_METRIC_NAMES,
  'qfa_order_ack_fill_ms',
] as const;

export type LatencyHistogramMetricName = (typeof LATENCY_HISTOGRAM_METRIC_NAMES)[number];

export interface LatencyHistogramConfig {
  readonly default_buckets_ms?: readonly number[];
  readonly buckets_ms_by_metric?: Partial<Record<LatencyHistogramMetricName, readonly number[]>>;
}

export interface LatencyMetricsEndpointConfig {
  readonly enabled?: boolean;
  readonly port?: number;
}

export interface ResolveLatencyMetricsEndpointOptions {
  readonly env?: Record<string, string | undefined>;
  readonly config?: LatencyMetricsEndpointConfig;
}

export interface ResolvedLatencyMetricsEndpointConfig {
  readonly enabled: boolean;
  readonly host: '127.0.0.1';
  readonly port: number;
}

export interface StartLatencyMetricsEndpointOptions extends ResolveLatencyMetricsEndpointOptions {
  readonly registry?: LatencySliRegistry;
}

export interface LatencyMetricsEndpointAddress {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly url: string;
}

export interface LatencyMetricsEndpoint {
  readonly server: Server;
  readonly ready: Promise<LatencyMetricsEndpointAddress>;
  readonly close: () => Promise<void>;
}

export interface AckLatencyObserverOptions {
  readonly registry?: LatencySliRegistry;
  readonly max_cache_entries?: number;
}

export interface EventLoopLagSamplerOptions {
  readonly registry?: LatencySliRegistry;
  readonly interval_ms?: number;
  readonly resolution_ms?: number;
}

export interface EventLoopLagSampler {
  readonly stop: () => void;
}

interface HistogramDescriptor {
  readonly name: LatencyHistogramMetricName;
  readonly help: string;
  readonly label_names: readonly string[];
}

export interface HistogramSeries {
  readonly labels: Readonly<Record<string, string>>;
  readonly bucketCounts: number[];
  sum: number;
  count: number;
}

type OrderIntentEnvelope = JournalEventEnvelope<
  'ORDER_INTENT',
  JournalEventPayloadFor<'ORDER_INTENT'>
>;
type OrderAckSubmissionEnvelope = BrokerJournalEventEnvelope<
  'ORDER_ACK_SUBMISSION',
  JournalEventPayloadFor<'ORDER_ACK_SUBMISSION'>
>;
type OrderAckCancelEnvelope = BrokerJournalEventEnvelope<
  'ORDER_ACK_CANCEL',
  JournalEventPayloadFor<'ORDER_ACK_CANCEL'>
>;
type OrderAckFillEnvelope = BrokerJournalEventEnvelope<
  'ORDER_ACK_FILL',
  JournalEventPayloadFor<'ORDER_ACK_FILL'>
>;

const DEFAULT_METRICS_PORT = 9_469;
const DEFAULT_ACK_CACHE_ENTRIES = 4_096;
const DEFAULT_EVENT_LOOP_LAG_INTERVAL_MS = 1_000;
const DEFAULT_EVENT_LOOP_LAG_RESOLUTION_MS = 20;

const HISTOGRAM_DESCRIPTORS: Record<LatencyHistogramMetricName, HistogramDescriptor> = {
  qfa_strategy_decision_ms: {
    name: 'qfa_strategy_decision_ms',
    help:
      `Strategy generator/evaluator compute duration in milliseconds by bounded strategy_id. ${PROVISIONAL_LATENCY_BUCKET_MARKER}.`,
    label_names: ['strategy_id'],
  },
  qfa_event_loop_lag_ms: {
    name: 'qfa_event_loop_lag_ms',
    help:
      `Node event-loop lag companion SLI in milliseconds. ${PROVISIONAL_LATENCY_BUCKET_MARKER}.`,
    label_names: [],
  },
  qfa_snapshot_to_submit_ms: {
    name: 'qfa_snapshot_to_submit_ms',
    help:
      `Feature snapshot to order submit latency in milliseconds. ${PROVISIONAL_LATENCY_BUCKET_MARKER}.`,
    label_names: [],
  },
  qfa_order_ack_submission_ms: {
    name: 'qfa_order_ack_submission_ms',
    help:
      `Submission ACK latency in milliseconds from ORDER_INTENT to local broker ACK receipt. ${PROVISIONAL_LATENCY_BUCKET_MARKER}.`,
    label_names: [],
  },
  qfa_order_ack_cancel_ms: {
    name: 'qfa_order_ack_cancel_ms',
    help:
      `Cancel ACK latency in milliseconds from submission ACK lineage to local cancel ACK receipt. ${PROVISIONAL_LATENCY_BUCKET_MARKER}.`,
    label_names: [],
  },
  qfa_order_ack_fill_ms: {
    name: 'qfa_order_ack_fill_ms',
    help:
      `Diagnostic fill ACK latency in milliseconds from submission ACK lineage to local fill ACK receipt; no SLA tag. ${PROVISIONAL_LATENCY_BUCKET_MARKER}.`,
    label_names: [],
  },
};

class PrometheusHistogram {
  readonly name: LatencyHistogramMetricName;
  readonly help: string;
  readonly bucketsMs: readonly number[];
  private readonly labelNames: readonly string[];
  private readonly series = new Map<string, HistogramSeries>();

  constructor(descriptor: HistogramDescriptor, bucketsMs: readonly number[]) {
    this.name = descriptor.name;
    this.help = descriptor.help;
    this.labelNames = descriptor.label_names;
    this.bucketsMs = normalizeBuckets(bucketsMs);
    if (this.labelNames.length === 0) {
      this.getSeries({});
    }
  }

  observe(valueMs: number, labels: Readonly<Record<string, string>> = {}): void {
    if (!Number.isFinite(valueMs) || valueMs < 0) {
      return;
    }
    const series = this.getSeries(labels);
    for (let index = 0; index < this.bucketsMs.length; index += 1) {
      if (valueMs <= this.bucketsMs[index]!) {
        series.bucketCounts[index] += 1;
      }
    }
    series.bucketCounts[this.bucketsMs.length] += 1;
    series.sum += valueMs;
    series.count += 1;
  }

  exportPrometheusLines(): string[] {
    const lines = [
      `# HELP ${this.name} ${escapeHelp(this.help)}`,
      `# TYPE ${this.name} histogram`,
    ];
    const orderedSeries = [...this.series.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
    for (const [, series] of orderedSeries) {
      for (let index = 0; index < this.bucketsMs.length; index += 1) {
        lines.push(
          `${this.name}_bucket${formatLabels(series.labels, { le: formatBucketLe(this.bucketsMs[index]!) })} ${series.bucketCounts[index]!}`,
        );
      }
      lines.push(
        `${this.name}_bucket${formatLabels(series.labels, { le: '+Inf' })} ${series.bucketCounts[this.bucketsMs.length]!}`,
      );
      lines.push(`${this.name}_sum${formatLabels(series.labels)} ${formatNumber(series.sum)}`);
      lines.push(`${this.name}_count${formatLabels(series.labels)} ${series.count}`);
    }
    return lines;
  }

  getSeriesSnapshot(labels: Readonly<Record<string, string>> = {}): HistogramSeries | undefined {
    const key = this.seriesKey(labels);
    const series = this.series.get(key);
    if (series === undefined) {
      return undefined;
    }
    return {
      labels: { ...series.labels },
      bucketCounts: [...series.bucketCounts],
      sum: series.sum,
      count: series.count,
    };
  }

  private getSeries(labels: Readonly<Record<string, string>>): HistogramSeries {
    const key = this.seriesKey(labels);
    const existing = this.series.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const normalizedLabels: Record<string, string> = {};
    for (const labelName of this.labelNames) {
      const value = labels[labelName];
      if (value === undefined || value === '') {
        throw new Error(`${this.name} requires label ${labelName}`);
      }
      normalizedLabels[labelName] = value;
    }
    const next: HistogramSeries = {
      labels: normalizedLabels,
      bucketCounts: Array.from({ length: this.bucketsMs.length + 1 }, () => 0),
      sum: 0,
      count: 0,
    };
    this.series.set(key, next);
    return next;
  }

  private seriesKey(labels: Readonly<Record<string, string>>): string {
    return this.labelNames.map((labelName) => `${labelName}=${labels[labelName] ?? ''}`).join('\n');
  }
}

class PrometheusCounter {
  private value = 0;

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  increment(amount = 1): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }
    this.value += amount;
  }

  getValue(): number {
    return this.value;
  }

  exportPrometheusLines(): string[] {
    return [
      `# HELP ${this.name} ${escapeHelp(this.help)}`,
      `# TYPE ${this.name} counter`,
      `${this.name} ${formatNumber(this.value)}`,
    ];
  }
}

export class LatencySliRegistry {
  private readonly histograms = new Map<LatencyHistogramMetricName, PrometheusHistogram>();
  private readonly ackIntentCacheMissCounter = new PrometheusCounter(
    'qfa_ack_intent_cache_miss_total',
    'ACK latency observer cache misses; observations are skipped on miss.',
  );

  constructor(config: LatencyHistogramConfig = {}) {
    for (const metricName of LATENCY_HISTOGRAM_METRIC_NAMES) {
      this.histograms.set(
        metricName,
        new PrometheusHistogram(
          HISTOGRAM_DESCRIPTORS[metricName],
          config.buckets_ms_by_metric?.[metricName] ??
            config.default_buckets_ms ??
            PROVISIONAL_LATENCY_HISTOGRAM_BUCKETS_MS,
        ),
      );
    }
  }

  recordStrategyDecisionMs(strategyId: StrategyId, durationMs: number): void {
    this.histogram('qfa_strategy_decision_ms').observe(durationMs, {
      strategy_id: strategyId,
    });
  }

  recordEventLoopLagMs(durationMs: number): void {
    this.histogram('qfa_event_loop_lag_ms').observe(durationMs);
  }

  recordSnapshotToSubmitMs(durationMs: number): void {
    this.histogram('qfa_snapshot_to_submit_ms').observe(durationMs);
  }

  recordSnapshotToSubmitNs(snapshotTsNs: UnixNs, submitTsNs: UnixNs): void {
    this.observeDurationNs('qfa_snapshot_to_submit_ms', snapshotTsNs, submitTsNs);
  }

  recordOrderAckSubmissionMs(durationMs: number): void {
    this.histogram('qfa_order_ack_submission_ms').observe(durationMs);
  }

  recordOrderAckSubmissionNs(intentTsNs: UnixNs, ackLocalTsNs: UnixNs): void {
    this.observeDurationNs('qfa_order_ack_submission_ms', intentTsNs, ackLocalTsNs);
  }

  recordOrderAckCancelMs(durationMs: number): void {
    this.histogram('qfa_order_ack_cancel_ms').observe(durationMs);
  }

  recordOrderAckCancelNs(submissionAckLocalTsNs: UnixNs, cancelAckLocalTsNs: UnixNs): void {
    this.observeDurationNs('qfa_order_ack_cancel_ms', submissionAckLocalTsNs, cancelAckLocalTsNs);
  }

  recordOrderAckFillMs(durationMs: number): void {
    this.histogram('qfa_order_ack_fill_ms').observe(durationMs);
  }

  recordOrderAckFillNs(submissionAckLocalTsNs: UnixNs, fillAckLocalTsNs: UnixNs): void {
    this.observeDurationNs('qfa_order_ack_fill_ms', submissionAckLocalTsNs, fillAckLocalTsNs);
  }

  incrementAckIntentCacheMiss(): void {
    this.ackIntentCacheMissCounter.increment();
  }

  ackIntentCacheMisses(): number {
    return this.ackIntentCacheMissCounter.getValue();
  }

  histogramSnapshot(
    metricName: LatencyHistogramMetricName,
    labels: Readonly<Record<string, string>> = {},
  ): HistogramSeries | undefined {
    return this.histogram(metricName).getSeriesSnapshot(labels);
  }

  exportPrometheusMetrics(): string {
    const lines: string[] = [];
    for (const metricName of LATENCY_HISTOGRAM_METRIC_NAMES) {
      lines.push(...this.histogram(metricName).exportPrometheusLines());
    }
    lines.push(...this.ackIntentCacheMissCounter.exportPrometheusLines());
    return `${lines.join('\n')}\n`;
  }

  private observeDurationNs(
    metricName: LatencyHistogramMetricName,
    startTsNs: UnixNs,
    endTsNs: UnixNs,
  ): void {
    const durationMs = durationNsToMs(startTsNs, endTsNs);
    if (durationMs === undefined) {
      return;
    }
    this.histogram(metricName).observe(durationMs);
  }

  private histogram(metricName: LatencyHistogramMetricName): PrometheusHistogram {
    const histogram = this.histograms.get(metricName);
    if (histogram === undefined) {
      throw new Error(`unknown latency histogram metric: ${metricName}`);
    }
    return histogram;
  }
}

export class BoundedAckLatencyObserver {
  private readonly registry: LatencySliRegistry;
  private readonly maxCacheEntries: number;
  private readonly intentSubmittedTsNsByEventId = new Map<string, UnixNs>();
  private readonly submissionAckLocalTsNsByAckId = new Map<string, UnixNs>();

  constructor(options: AckLatencyObserverOptions = {}) {
    this.registry = options.registry ?? getDefaultLatencySliRegistry();
    this.maxCacheEntries = options.max_cache_entries ?? DEFAULT_ACK_CACHE_ENTRIES;
    if (!Number.isSafeInteger(this.maxCacheEntries) || this.maxCacheEntries < 1) {
      throw new Error('ACK latency observer max_cache_entries must be a positive safe integer');
    }
  }

  observe(event: AnyJournalEventEnvelope): void {
    switch (event.type) {
      case 'ORDER_INTENT':
        this.observeOrderIntent(event as OrderIntentEnvelope);
        return;
      case 'ORDER_ACK_SUBMISSION':
        this.observeOrderAckSubmission(event as OrderAckSubmissionEnvelope);
        return;
      case 'ORDER_ACK_CANCEL':
        this.observeOrderAckCancel(event as OrderAckCancelEnvelope);
        return;
      case 'ORDER_ACK_FILL':
        this.observeOrderAckFill(event as OrderAckFillEnvelope);
        return;
      default:
        return;
    }
  }

  private observeOrderIntent(event: OrderIntentEnvelope): void {
    rememberBounded(
      this.intentSubmittedTsNsByEventId,
      String(event.event_id),
      event.ts_ns,
      this.maxCacheEntries,
    );
  }

  private observeOrderAckSubmission(event: OrderAckSubmissionEnvelope): void {
    rememberBounded(
      this.submissionAckLocalTsNsByAckId,
      String(event.payload.submission_ack_id),
      event.ts_ns_local,
      this.maxCacheEntries,
    );

    const intentTsNs = this.intentSubmittedTsNsByEventId.get(String(event.payload.intent_id));
    if (intentTsNs === undefined) {
      this.registry.incrementAckIntentCacheMiss();
      return;
    }
    this.registry.recordOrderAckSubmissionNs(intentTsNs, event.ts_ns_local);
  }

  private observeOrderAckCancel(event: OrderAckCancelEnvelope): void {
    const submissionAckLocalTsNs = this.submissionAckLocalTsNsByAckId.get(
      String(event.payload.submission_ack_id),
    );
    if (submissionAckLocalTsNs === undefined) {
      this.registry.incrementAckIntentCacheMiss();
      return;
    }
    this.registry.recordOrderAckCancelNs(submissionAckLocalTsNs, event.ts_ns_local);
  }

  private observeOrderAckFill(event: OrderAckFillEnvelope): void {
    const submissionAckLocalTsNs = this.submissionAckLocalTsNsByAckId.get(
      String(event.payload.submission_ack_id),
    );
    if (submissionAckLocalTsNs === undefined) {
      this.registry.incrementAckIntentCacheMiss();
      return;
    }
    this.registry.recordOrderAckFillNs(submissionAckLocalTsNs, event.ts_ns_local);
  }
}

let defaultLatencySliRegistry = new LatencySliRegistry();

export function getDefaultLatencySliRegistry(): LatencySliRegistry {
  return defaultLatencySliRegistry;
}

export function resetDefaultLatencySliRegistryForTests(
  config: LatencyHistogramConfig = {},
): LatencySliRegistry {
  defaultLatencySliRegistry = new LatencySliRegistry(config);
  return defaultLatencySliRegistry;
}

export function resolveLatencyMetricsEndpointConfig(
  options: ResolveLatencyMetricsEndpointOptions = {},
): ResolvedLatencyMetricsEndpointConfig {
  const env = options.env ?? process.env;
  const envEnabled = env.QFA_METRICS_ENABLED?.trim().toLowerCase() === 'true';
  const enabled = options.config?.enabled === true || envEnabled;
  const port = options.config?.port ?? parseMetricsPort(env.QFA_METRICS_PORT);
  return {
    enabled,
    host: '127.0.0.1',
    port,
  };
}

export function startLatencyMetricsEndpoint(
  options: StartLatencyMetricsEndpointOptions = {},
): LatencyMetricsEndpoint | undefined {
  const resolved = resolveLatencyMetricsEndpointConfig(options);
  if (!resolved.enabled) {
    return undefined;
  }

  const registry = options.registry ?? getDefaultLatencySliRegistry();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${resolved.host}`);
    if (request.method !== 'GET' || url.pathname !== '/metrics') {
      response.statusCode = 404;
      response.end('not found\n');
      return;
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    response.end(registry.exportPrometheusMetrics());
  });

  const ready = new Promise<LatencyMetricsEndpointAddress>((resolve, reject) => {
    server.once('error', reject);
    server.listen(resolved.port, resolved.host, () => {
      server.off('error', reject);
      const address = server.address() as AddressInfo;
      resolve({
        host: resolved.host,
        port: address.port,
        url: `http://${resolved.host}:${address.port}/metrics`,
      });
    });
  });

  return {
    server,
    ready,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

export function startEventLoopLagSampler(
  options: EventLoopLagSamplerOptions = {},
): EventLoopLagSampler {
  const registry = options.registry ?? getDefaultLatencySliRegistry();
  const histogram = monitorEventLoopDelay({
    resolution: options.resolution_ms ?? DEFAULT_EVENT_LOOP_LAG_RESOLUTION_MS,
  });
  histogram.enable();
  const interval = setInterval(() => {
    if (Number.isFinite(histogram.mean)) {
      registry.recordEventLoopLagMs(histogram.mean / 1_000_000);
    }
    histogram.reset();
  }, options.interval_ms ?? DEFAULT_EVENT_LOOP_LAG_INTERVAL_MS);
  interval.unref();

  return {
    stop: () => {
      clearInterval(interval);
      histogram.disable();
    },
  };
}

function normalizeBuckets(buckets: readonly number[]): readonly number[] {
  const normalized = [...buckets];
  if (normalized.length === 0) {
    throw new Error('latency histogram buckets must not be empty');
  }
  for (const bucket of normalized) {
    if (!Number.isFinite(bucket) || bucket <= 0) {
      throw new Error('latency histogram buckets must be positive finite milliseconds');
    }
  }
  normalized.sort((left, right) => left - right);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index] === normalized[index - 1]) {
      throw new Error('latency histogram buckets must be unique');
    }
  }
  return normalized;
}

function durationNsToMs(startTsNs: UnixNs, endTsNs: UnixNs): number | undefined {
  const durationNs = BigInt(endTsNs) - BigInt(startTsNs);
  if (durationNs < 0n) {
    return undefined;
  }
  return Number(durationNs) / 1_000_000;
}

function rememberBounded<TKey, TValue>(
  cache: Map<TKey, TValue>,
  key: TKey,
  value: TValue,
  maxEntries: number,
): void {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next();
    if (oldest.done === true) {
      return;
    }
    cache.delete(oldest.value);
  }
}

function parseMetricsPort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_METRICS_PORT;
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error('QFA_METRICS_PORT must be an integer from 0 through 65535');
  }
  return port;
}

function formatLabels(
  labels: Readonly<Record<string, string>>,
  extraLabels: Readonly<Record<string, string>> = {},
): string {
  const entries = [...Object.entries(labels), ...Object.entries(extraLabels)];
  if (entries.length === 0) {
    return '';
  }
  return `{${entries
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(',')}}`;
}

function formatBucketLe(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/\n/gu, '\\n').replace(/"/gu, '\\"');
}

function escapeHelp(value: string): string {
  return value.replace(/\n/gu, ' ');
}
