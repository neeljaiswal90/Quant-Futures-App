import { describe, expect, it } from 'vitest';
import {
  BurnRateEvaluator,
  histogramP95,
  unixNsFromMsForTests,
  type SloWindowState,
} from '../../src/observability/burn-rate-evaluator.js';
import type { SloDefinition } from '../../src/observability/slo-registry.js';

describe('QFA-627 burn-rate evaluator', () => {
  it('passes when the window meets the floor and p95 is within budget', () => {
    const { evaluator } = evaluatorFor([definition('metric_pass', [
      window('5m', { floor: 2, budget: 30 }),
    ])]);

    evaluator.observeSampleAt('metric_pass', 10, 1_000);
    evaluator.observeSampleAt('metric_pass', 20, 1_001);

    expect(stateOf(evaluator.evaluate(), 'metric_pass')).toBe('pass');
  });

  it('breaches when the window meets the floor and p95 exceeds budget', () => {
    const { evaluator } = evaluatorFor([definition('metric_breach', [
      window('5m', { floor: 2, budget: 15 }),
    ])]);

    evaluator.observeSampleAt('metric_breach', 10, 1_000);
    evaluator.observeSampleAt('metric_breach', 20, 1_001);

    expect(stateOf(evaluator.evaluate(), 'metric_breach')).toBe('breach');
  });

  it('reports insufficient_data when the sample count is below floor', () => {
    const { evaluator } = evaluatorFor([definition('metric_sparse', [
      window('5m', { floor: 3, budget: 30 }),
    ])]);

    evaluator.observeSampleAt('metric_sparse', 10, 1_000);
    evaluator.observeSampleAt('metric_sparse', 20, 1_001);

    const evaluation = evaluationOf(evaluator.evaluate(), 'metric_sparse');
    expect(evaluation.aggregate_state).toBe('insufficient_data');
    expect(evaluation.contributing_windows[0]).toMatchObject({
      sample_count: 2,
      sample_count_floor: 3,
    });
  });

  it('aggregates multi-window pass plus breach to breach', () => {
    const { evaluator } = evaluatorFor([definition('metric_mixed', [
      window('5m', { floor: 1, budget: 50 }),
      window('1h', { floor: 1, budget: 10 }),
    ])]);

    evaluator.observeSampleAt('metric_mixed', 20, 1_000);

    expect(stateOf(evaluator.evaluate(), 'metric_mixed')).toBe('breach');
  });

  it('aggregates multi-window breach plus pass to breach', () => {
    const { evaluator } = evaluatorFor([definition('metric_mixed', [
      window('5m', { floor: 1, budget: 10 }),
      window('1h', { floor: 1, budget: 50 }),
    ])]);

    evaluator.observeSampleAt('metric_mixed', 20, 1_000);

    expect(stateOf(evaluator.evaluate(), 'metric_mixed')).toBe('breach');
  });

  it('aggregates pass plus insufficient_data to insufficient_data', () => {
    const { evaluator } = evaluatorFor([definition('metric_partial', [
      window('5m', { floor: 1, budget: 50 }),
      window('1h', { floor: 2, budget: 50 }),
    ])]);

    evaluator.observeSampleAt('metric_partial', 20, 1_000);

    expect(stateOf(evaluator.evaluate(), 'metric_partial')).toBe('insufficient_data');
  });

  it('escalates strategy decision to breach when event-loop companion breaches', () => {
    const { evaluator } = evaluatorFor([
      definition('qfa_strategy_decision_ms', [
        window('5m', { floor: 1, budget: 25 }),
      ], { companion: 'qfa_event_loop_lag_ms' }),
      definition('qfa_event_loop_lag_ms', [
        window('5m', { floor: 1, budget: 5 }),
      ]),
    ]);

    evaluator.observeSampleAt('qfa_strategy_decision_ms', 10, 1_000);
    evaluator.observeSampleAt('qfa_event_loop_lag_ms', 20, 1_000);

    const evaluation = evaluationOf(evaluator.evaluate(), 'qfa_strategy_decision_ms');
    expect(evaluation.aggregate_state).toBe('breach');
    expect(evaluation.companion_metric_states?.[0]?.state).toBe('breach');
  });

  it('caps strategy decision at insufficient_data when the event-loop companion lacks data', () => {
    const { evaluator } = evaluatorFor([
      definition('qfa_strategy_decision_ms', [
        window('5m', { floor: 1, budget: 25 }),
      ], { companion: 'qfa_event_loop_lag_ms' }),
      definition('qfa_event_loop_lag_ms', [
        window('5m', { floor: 1, budget: 5 }),
      ]),
    ]);

    evaluator.observeSampleAt('qfa_strategy_decision_ms', 10, 1_000);

    expect(stateOf(evaluator.evaluate(), 'qfa_strategy_decision_ms')).toBe('insufficient_data');
  });

  it('preserves provisional and not-applicable breach eligibility through ACK SLO results', () => {
    const { evaluator } = evaluatorFor([definition('qfa_order_ack_submission_ms', [
      window('5m', { floor: 1, budget: 1_000 }),
    ], { eligibility: 'not_applicable_until_phase_6_ack' })]);

    evaluator.observeSampleAt('qfa_order_ack_submission_ms', 200, 1_000);

    const evaluation = evaluationOf(evaluator.evaluate(), 'qfa_order_ack_submission_ms');
    expect(evaluation.aggregate_state).toBe('pass');
    expect(evaluation.breach_eligibility).toBe('not_applicable_until_phase_6_ack');
    expect(evaluation.contributing_windows[0]?.breach_eligibility).toBe(
      'not_applicable_until_phase_6_ack',
    );
    expect(evaluation.is_provisional).toBe(true);
  });

  it('emits state transitions exactly once when the aggregate changes', () => {
    const transitions: unknown[] = [];
    const { evaluator } = evaluatorFor([definition('metric_transition', [
      window('5m', { floor: 1, budget: 25 }),
    ])]);
    evaluator.subscribe((nextTransitions) => transitions.push(...nextTransitions));

    evaluator.observeSampleAt('metric_transition', 10, 1_000);
    expect(stateOf(evaluator.evaluate(), 'metric_transition')).toBe('pass');
    expect(transitions).toEqual([]);

    evaluator.observeSampleAt('metric_transition', 50, 1_001);
    expect(stateOf(evaluator.evaluate(), 'metric_transition')).toBe('breach');
    expect(transitions).toEqual([
      expect.objectContaining({
        metric_name: 'metric_transition',
        from_state: 'pass',
        to_state: 'breach',
      }),
    ]);

    expect(stateOf(evaluator.evaluate(), 'metric_transition')).toBe('breach');
    expect(transitions).toHaveLength(1);
  });

  it('emits a structured sustained insufficient_data anomaly after the configured duration', () => {
    let nowMs = 0;
    const evaluator = new BurnRateEvaluator({
      definitions: [definition('metric_stale', [
        window('5m', { floor: 1, budget: 25 }),
      ])],
      sustained_insufficient_data_alert_after_ms: 24 * 60 * 60 * 1_000,
      now_ms: () => nowMs,
      now_ns: () => unixNsFromMsForTests(nowMs),
    });

    expect(evaluator.evaluateWithAnomalies().anomalies).toEqual([]);
    nowMs = 24 * 60 * 60 * 1_000 + 1;
    expect(evaluator.evaluateWithAnomalies().anomalies).toEqual([
      expect.objectContaining({
        metric_name: 'metric_stale',
        anomaly_code: 'sustained_insufficient_data',
        sustained_duration_ms: 24 * 60 * 60 * 1_000 + 1,
      }),
    ]);
    expect(evaluator.evaluateWithAnomalies().anomalies).toEqual([]);
  });

  it('estimates p95 from cumulative histogram bucket counts', () => {
    expect(histogramP95([10, 25, 50], [2, 19, 20])).toBe(25);
    expect(histogramP95([10, 25, 50], [0, 0, 0])).toBeUndefined();
  });
});

function evaluatorFor(definitions: readonly SloDefinition[]): { readonly evaluator: BurnRateEvaluator } {
  return {
    evaluator: new BurnRateEvaluator({
      definitions,
      now_ms: () => 1_000,
      now_ns: () => unixNsFromMsForTests(1_000),
    }),
  };
}

function definition(
  metricName: string,
  windows: readonly SloDefinition['windows'][number][],
  options: {
    readonly companion?: string;
    readonly eligibility?: SloDefinition['breach_eligibility'];
  } = {},
): SloDefinition {
  return {
    metric_name: metricName,
    windows,
    ...(options.companion === undefined ? {} : { companion_metric_name: options.companion }),
    is_provisional: true,
    breach_eligibility: options.eligibility ?? 'eligible',
  };
}

function window(
  windowId: string,
  options: {
    readonly floor: number;
    readonly budget: number;
    readonly duration?: number;
  },
): SloDefinition['windows'][number] {
  return {
    window_id: windowId,
    window_duration_ms: options.duration ?? (windowId === '1h' ? 3_600_000 : 300_000),
    sample_count_floor: options.floor,
    p95_budget_ms: options.budget,
  };
}

function evaluationOf(
  evaluations: readonly ReturnType<BurnRateEvaluator['evaluate']>[number][],
  metricName: string,
): ReturnType<BurnRateEvaluator['evaluate']>[number] {
  const evaluation = evaluations.find((candidate) => candidate.metric_name === metricName);
  expect(evaluation).toBeDefined();
  return evaluation!;
}

function stateOf(
  evaluations: readonly ReturnType<BurnRateEvaluator['evaluate']>[number][],
  metricName: string,
): SloWindowState {
  return evaluationOf(evaluations, metricName).aggregate_state;
}
