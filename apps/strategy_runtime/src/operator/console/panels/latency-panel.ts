import {
  formatMsUpperBound,
  noneIfEmpty,
  renderPanel,
} from '../ansi-renderer.js';
import type { LatencyMetricPanelState, LatencyPanelState } from '../console-state.js';

export function render(state: LatencyPanelState): string {
  if (state.metrics.length === 0) {
    return renderPanel('Latency', ['metrics=none source=LatencySliRegistry']);
  }
  return renderPanel('Latency', [
    `ack_intent_cache_misses=${state.ack_intent_cache_misses}`,
    ...state.metrics.map(renderMetric),
  ]);
}

function renderMetric(metric: LatencyMetricPanelState): string {
  return [
    `metric=${metric.metric_name}`,
    `labels=${labelsString(metric.labels)}`,
    `count=${metric.count}`,
    `p50_ms=${formatMsUpperBound(metric.p50_ms)}`,
    `p95_ms=${formatMsUpperBound(metric.p95_ms)}`,
    `p99_ms=${formatMsUpperBound(metric.p99_ms)}`,
    `bucket_utilization=${metric.bucket_utilization}`,
  ].join(' ');
}

function labelsString(labels: Readonly<Record<string, string>>): string {
  const parts = Object.entries(labels).map(([key, value]) => `${key}:${value}`);
  return noneIfEmpty(parts);
}