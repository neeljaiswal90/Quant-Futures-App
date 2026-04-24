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
