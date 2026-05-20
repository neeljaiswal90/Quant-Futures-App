import type { LatencyHistogramMetricName } from './latency-sli.js';

export type SloBreachEligibility = 'eligible' | 'not_applicable_until_phase_6_ack';

export interface SloWindowDefinition {
  readonly window_id: string;
  readonly window_duration_ms: number;
  readonly sample_count_floor: number;
  readonly p95_budget_ms: number;
}

export interface SloDefinition {
  readonly metric_name: string;
  readonly windows: readonly SloWindowDefinition[];
  readonly companion_metric_name?: string;
  readonly is_provisional: boolean;
  readonly breach_eligibility: SloBreachEligibility;
}

export const DEFAULT_SLO_WINDOWS = {
  fast_5m_ms: 300_000,
  slow_1h_ms: 3_600_000,
} as const;

const STRATEGY_DECISION_SAMPLE_FLOORS = {
  fast_5m: 20,
  slow_1h: 100,
} as const;

const PHASE_6_ACK_SAMPLE_FLOORS = {
  fast_5m: 0,
  slow_1h: 0,
} as const;

export const PROVISIONAL_LATENCY_SLO_DEFINITIONS = [
  {
    metric_name: 'qfa_strategy_decision_ms',
    windows: [
      {
        window_id: '5m',
        window_duration_ms: DEFAULT_SLO_WINDOWS.fast_5m_ms,
        sample_count_floor: STRATEGY_DECISION_SAMPLE_FLOORS.fast_5m,
        p95_budget_ms: 25,
      },
      {
        window_id: '1h',
        window_duration_ms: DEFAULT_SLO_WINDOWS.slow_1h_ms,
        sample_count_floor: STRATEGY_DECISION_SAMPLE_FLOORS.slow_1h,
        p95_budget_ms: 25,
      },
    ],
    companion_metric_name: 'qfa_event_loop_lag_ms',
    is_provisional: true,
    breach_eligibility: 'eligible',
  },
  {
    metric_name: 'qfa_event_loop_lag_ms',
    windows: [
      {
        window_id: '5m',
        window_duration_ms: DEFAULT_SLO_WINDOWS.fast_5m_ms,
        sample_count_floor: STRATEGY_DECISION_SAMPLE_FLOORS.fast_5m,
        p95_budget_ms: 25,
      },
      {
        window_id: '1h',
        window_duration_ms: DEFAULT_SLO_WINDOWS.slow_1h_ms,
        sample_count_floor: STRATEGY_DECISION_SAMPLE_FLOORS.slow_1h,
        p95_budget_ms: 25,
      },
    ],
    is_provisional: true,
    breach_eligibility: 'eligible',
  },
  {
    metric_name: 'qfa_snapshot_to_submit_ms',
    windows: [
      {
        window_id: '5m',
        window_duration_ms: DEFAULT_SLO_WINDOWS.fast_5m_ms,
        sample_count_floor: PHASE_6_ACK_SAMPLE_FLOORS.fast_5m,
        p95_budget_ms: 100,
      },
      {
        window_id: '1h',
        window_duration_ms: DEFAULT_SLO_WINDOWS.slow_1h_ms,
        sample_count_floor: PHASE_6_ACK_SAMPLE_FLOORS.slow_1h,
        p95_budget_ms: 100,
      },
    ],
    is_provisional: true,
    breach_eligibility: 'not_applicable_until_phase_6_ack',
  },
  {
    metric_name: 'qfa_order_ack_submission_ms',
    windows: [
      {
        window_id: '5m',
        window_duration_ms: DEFAULT_SLO_WINDOWS.fast_5m_ms,
        sample_count_floor: PHASE_6_ACK_SAMPLE_FLOORS.fast_5m,
        p95_budget_ms: 1_000,
      },
      {
        window_id: '1h',
        window_duration_ms: DEFAULT_SLO_WINDOWS.slow_1h_ms,
        sample_count_floor: PHASE_6_ACK_SAMPLE_FLOORS.slow_1h,
        p95_budget_ms: 1_000,
      },
    ],
    is_provisional: true,
    breach_eligibility: 'not_applicable_until_phase_6_ack',
  },
] as const satisfies readonly SloDefinition[];

export class SloRegistry {
  private readonly definitions = new Map<string, SloDefinition>();

  constructor(definitions: readonly SloDefinition[] = PROVISIONAL_LATENCY_SLO_DEFINITIONS) {
    for (const definition of definitions) {
      this.registerSlo(definition);
    }
  }

  registerSlo(definition: SloDefinition): void {
    assertSloDefinition(definition);
    this.definitions.set(definition.metric_name, definition);
  }

  get(metricName: string): SloDefinition | undefined {
    return this.definitions.get(metricName);
  }

  require(metricName: string): SloDefinition {
    const definition = this.get(metricName);
    if (definition === undefined) {
      throw new Error(`unknown SLO metric: ${metricName}`);
    }
    return definition;
  }

  list(): readonly SloDefinition[] {
    return [...this.definitions.values()].sort((left, right) =>
      left.metric_name.localeCompare(right.metric_name),
    );
  }
}

export function createDefaultSloRegistry(): SloRegistry {
  return new SloRegistry();
}

export function registerLatencyHistogramSlo(
  registry: SloRegistry,
  definition: SloDefinition & { readonly metric_name: LatencyHistogramMetricName },
): void {
  registry.registerSlo(definition);
}

function assertSloDefinition(definition: SloDefinition): void {
  if (definition.metric_name.trim() === '') {
    throw new Error('SLO metric_name must be non-empty');
  }
  if (definition.windows.length === 0) {
    throw new Error(`SLO ${definition.metric_name} must define at least one window`);
  }
  const seenWindowIds = new Set<string>();
  for (const window of definition.windows) {
    if (window.window_id.trim() === '') {
      throw new Error(`SLO ${definition.metric_name} has empty window_id`);
    }
    if (seenWindowIds.has(window.window_id)) {
      throw new Error(`SLO ${definition.metric_name} has duplicate window_id ${window.window_id}`);
    }
    seenWindowIds.add(window.window_id);
    if (!Number.isSafeInteger(window.window_duration_ms) || window.window_duration_ms <= 0) {
      throw new Error(`SLO ${definition.metric_name}/${window.window_id} has invalid duration`);
    }
    if (!Number.isSafeInteger(window.sample_count_floor) || window.sample_count_floor < 0) {
      throw new Error(`SLO ${definition.metric_name}/${window.window_id} has invalid floor`);
    }
    if (!Number.isFinite(window.p95_budget_ms) || window.p95_budget_ms <= 0) {
      throw new Error(`SLO ${definition.metric_name}/${window.window_id} has invalid p95 budget`);
    }
  }
}
