import type { ConfigLineageRef } from '../contracts/lineage.js';
import type { StrategyRuntimeConfig } from '../config/index.js';
import type {
  Candidate,
  StrategyEvaluation,
} from '../contracts/candidate.js';
import type {
  Bar,
  Direction,
  InstrumentIdentity,
  L3AuthorityState,
  SessionState,
} from '../contracts/market.js';
import type { FeatureSnapshotId, EventId } from '../contracts/ids.js';
import type { StrategyId } from '../contracts/strategy-ids.js';
import type { UnixNs } from '../contracts/time.js';

export type StrategySetupFamily = 'trend_pullback' | 'breakout_retest';

export type StrategyImplementationStatus = 'pending_extraction' | 'active';

export type StrategyScalarValue = number | string | boolean | null;

export type StrategyScalarMap = Readonly<Record<string, StrategyScalarValue>>;

export const OPENING_RANGE_MINUTES = 30 as const;

export type StrategyFeatureSnapshotRegime =
  | 'high'
  | 'mid'
  | 'low'
  | 'transition_pending'
  | 'unknown';

/**
 * Producer-side context extension for QFA-7xx-A / ADR-0022.
 *
 * OPENING_RANGE_MINUTES defaults to 30. Strategy variants that need a
 * different opening-range horizon must lock that choice in their own
 * parameter manifest; the shared snapshot producer remains schema-only.
 */
export interface StrategyFeatureSnapshotContext {
  readonly prior_day_close: number | null;
  readonly prior_day_high: number | null;
  readonly prior_day_low: number | null;
  readonly today_open: number | null;
  readonly vix_value: number | null;
  readonly vix_fresh: boolean;
  readonly regime_label: StrategyFeatureSnapshotRegime;
  readonly opening_range_high: number | null;
  readonly opening_range_low: number | null;
  readonly opening_range_minutes_elapsed: number;
}

export interface StrategyRegistryEntry {
  readonly strategy_id: StrategyId;
  readonly display_name: string;
  readonly direction: Direction;
  readonly setup_family: StrategySetupFamily;
  readonly implementation_status: StrategyImplementationStatus;
  readonly extraction_ticket: 'STRAT-02' | 'STRAT-03' | 'STRAT-04' | 'STRAT-05';
  readonly synthetic_fixture_id: StrategyFixtureId;
  readonly enabled_in_v1: true;
}

export type StrategyFixtureId =
  | 'fixture_trend_pullback_long'
  | 'fixture_trend_pullback_short'
  | 'fixture_breakout_retest_long'
  | 'fixture_breakdown_retest_short';

export interface StrategyFeatureSnapshot {
  readonly feature_snapshot_id: FeatureSnapshotId;
  readonly source_event_id: EventId;
  readonly created_ts_ns: UnixNs;
  readonly instrument: InstrumentIdentity;
  readonly session: SessionState;
  readonly quote: {
    readonly bid_px: number;
    readonly ask_px: number;
    readonly mid_px: number;
  };
  readonly last_trade_price: number;
  readonly bars: readonly Bar[];
  readonly indicators: StrategyScalarMap;
  readonly structure: {
    readonly trend: 'up' | 'down' | 'range' | 'unknown';
    readonly values: StrategyScalarMap;
  };
  readonly microstructure: {
    readonly l3_authority: L3AuthorityState;
    readonly values: StrategyScalarMap;
  };
  readonly context: StrategyFeatureSnapshotContext;
  readonly config: ConfigLineageRef;
}

export interface StrategyEvaluationInput {
  readonly strategy_id: StrategyId;
  readonly snapshot: StrategyFeatureSnapshot;
  readonly strategy_config?: StrategyRuntimeConfig;
}

export interface StrategyGenerationResult {
  readonly evaluation: StrategyEvaluation;
  readonly candidate?: Candidate;
}

export type ActiveStrategyGenerator = (
  input: StrategyEvaluationInput,
) => StrategyGenerationResult;
