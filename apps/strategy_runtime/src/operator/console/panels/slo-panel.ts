import {
  formatBoolean,
  formatMsUpperBound,
  formatNs,
  formatNumber,
  renderPanel,
  tone,
  toneForSloState,
} from '../ansi-renderer.js';
import type { SloMetricPanelState, SloPanelState } from '../console-state.js';

export function render(state: SloPanelState): string {
  if (state.metrics.length === 0) {
    return renderPanel('SLO', ['metrics=none source=BurnRateEvaluator']);
  }
  return renderPanel('SLO', state.metrics.map(renderMetric));
}

function renderMetric(metric: SloMetricPanelState): string {
  const state = tone(metric.state, toneForSloState(metric.state));
  const windows = metric.windows
    .map((window) => [
      window.window_id,
      window.state,
      `samples=${window.sample_count}/${window.sample_count_floor}`,
      `p95_ms=${formatMsUpperBound(window.percentile_value)}`,
      `budget_ms=${formatNumber(window.budget_threshold_ms)}`,
    ].join(':'))
    .join(' ');
  return [
    `metric=${metric.metric_name}`,
    `state=${state}`,
    `last_transition_ts_ns=${formatNs(metric.last_transition_ts_ns)}`,
    `provisional=${formatBoolean(metric.is_provisional)}`,
    `eligibility=${metric.breach_eligibility}`,
    `windows=[${windows}]`,
  ].join(' ');
}