import { getGeneratedCandidateBaseStrategyId } from '../contracts/generated-candidate-strategy-ids.js';
import {
  ACTIVE_STRATEGY_IDS,
  ANY_STRATEGY_IDS,
  CANDIDATE_STRATEGY_IDS,
  parseAnyStrategyId,
  type ActiveStrategyId,
  type AnyStrategyId,
  type CandidateStrategyId,
  type RegisteredInactiveStrategyId,
  type StrategyId,
} from '../contracts/strategy-ids.js';
import type { Direction } from '../contracts/market.js';
import { makeCandidateId, makeStrategyEvaluationId } from '../contracts/ids.js';
import type { StrategyRuntimeConfig } from '../config/index.js';
import { generateBreakoutRetestLong } from './breakout_retest_long.js';
import { generateBreakdownRetestShort } from './breakdown_retest_short.js';
import { generateLiquiditySweepReversalLong } from './liquidity_sweep_reversal_long.js';
import { generateLiquiditySweepReversalShort } from './liquidity_sweep_reversal_short.js';
import { generateRegimeMeanReversionLong } from './regime_mean_reversion_long.js';
import { generateRegimeMeanReversionShort } from './regime_mean_reversion_short.js';
import { generateRegimeShockReversionShortV2 } from './regime_shock_reversion_short_v2.js';
import { generateOpeningRangeBoxBreakoutLongPriorDownNoLateShadow } from './opening_range_box_breakout_long.js';
import { generateRegimeShockReversionShortV2Utc1618Exclusion } from './regime_shock_reversion_short_v2_utc_16_18_exclusion.js';
import { generateRegimeShockReversionShortV3 } from './regime_shock_reversion_short_v3.js';
import { generateRegimeShockReversionShortV4Delay } from './regime_shock_reversion_short_v4_delay.js';
import { generateRegimeShockReversionShortV4Persist } from './regime_shock_reversion_short_v4_persist.js';
import { generateRegimeShockReversionShortV5StrictDeadline } from './regime_shock_reversion_short_v5_strict_deadline.js';
import { generateRegimeShockReversionShortV5TrailAtDeadline } from './regime_shock_reversion_short_v5_trail_at_deadline.js';
import { generateTrendPullbackLong } from './trend_pullback_long.js';
import { generateTrendPullbackShort } from './trend_pullback_short.js';
import { generateVwapOvernightReversalLong } from './vwap_overnight_reversal_long.js';
import { generateVwapOvernightReversalShort } from './vwap_overnight_reversal_short.js';
import type {
  ActiveStrategyGenerator,
  StrategyGenerationResult,
  StrategyRegistryEntry,
  StrategySetupFamily,
} from './types.js';

const STATIC_STRATEGY_REGISTRY_ENTRIES = {
  trend_pullback_long: {
    strategy_id: 'trend_pullback_long',
    display_name: 'Trend Pullback Long',
    direction: 'long',
    setup_family: 'trend_pullback',
    implementation_status: 'active',
    extraction_ticket: 'STRAT-02',
    synthetic_fixture_id: 'fixture_trend_pullback_long',
    enabled_in_v1: false,
  },
  trend_pullback_short: {
    strategy_id: 'trend_pullback_short',
    display_name: 'Trend Pullback Short',
    direction: 'short',
    setup_family: 'trend_pullback',
    implementation_status: 'active',
    extraction_ticket: 'STRAT-03',
    synthetic_fixture_id: 'fixture_trend_pullback_short',
    enabled_in_v1: false,
  },
  breakout_retest_long: {
    strategy_id: 'breakout_retest_long',
    display_name: 'Breakout Retest Long',
    direction: 'long',
    setup_family: 'breakout_retest',
    implementation_status: 'active',
    extraction_ticket: 'STRAT-04',
    synthetic_fixture_id: 'fixture_breakout_retest_long',
    enabled_in_v1: false,
  },
  breakdown_retest_short: {
    strategy_id: 'breakdown_retest_short',
    display_name: 'Breakdown Retest Short',
    direction: 'short',
    setup_family: 'breakout_retest',
    implementation_status: 'active',
    extraction_ticket: 'STRAT-05',
    synthetic_fixture_id: 'fixture_breakdown_retest_short',
    enabled_in_v1: false,
  },
  regime_mean_reversion_long: {
    strategy_id: 'regime_mean_reversion_long',
    display_name: 'Regime Mean Reversion Long',
    direction: 'long',
    setup_family: 'regime_mean_reversion',
    implementation_status: 'active',
    extraction_ticket: 'QFA-7xx-S3',
    synthetic_fixture_id: 'fixture_regime_mean_reversion_long',
    enabled_in_v1: false,
  },
  regime_mean_reversion_short: {
    strategy_id: 'regime_mean_reversion_short',
    display_name: 'Regime Mean Reversion Short',
    direction: 'short',
    setup_family: 'regime_mean_reversion',
    implementation_status: 'active',
    extraction_ticket: 'QFA-7xx-S3',
    synthetic_fixture_id: 'fixture_regime_mean_reversion_short',
    enabled_in_v1: false,
  },
  liquidity_sweep_reversal_long: {
    strategy_id: 'liquidity_sweep_reversal_long',
    display_name: 'Liquidity Sweep Reversal Long',
    direction: 'long',
    setup_family: 'liquidity_sweep_reversal',
    implementation_status: 'active',
    extraction_ticket: 'QFA-7xx-S2',
    synthetic_fixture_id: 'fixture_liquidity_sweep_reversal_long',
    enabled_in_v1: false,
  },
  liquidity_sweep_reversal_short: {
    strategy_id: 'liquidity_sweep_reversal_short',
    display_name: 'Liquidity Sweep Reversal Short',
    direction: 'short',
    setup_family: 'liquidity_sweep_reversal',
    implementation_status: 'active',
    extraction_ticket: 'QFA-7xx-S2',
    synthetic_fixture_id: 'fixture_liquidity_sweep_reversal_short',
    enabled_in_v1: false,
  },
  vwap_overnight_reversal_long: {
    strategy_id: 'vwap_overnight_reversal_long',
    display_name: 'VWAP Overnight Reversal Long',
    direction: 'long',
    setup_family: 'vwap_overnight_reversal',
    implementation_status: 'active',
    extraction_ticket: 'QFA-7xx-S1',
    synthetic_fixture_id: 'fixture_vwap_overnight_reversal_long',
    enabled_in_v1: false,
  },
  vwap_overnight_reversal_short: {
    strategy_id: 'vwap_overnight_reversal_short',
    display_name: 'VWAP Overnight Reversal Short',
    direction: 'short',
    setup_family: 'vwap_overnight_reversal',
    implementation_status: 'active',
    extraction_ticket: 'QFA-7xx-S1',
    synthetic_fixture_id: 'fixture_vwap_overnight_reversal_short',
    enabled_in_v1: false,
  },
  regime_shock_reversion_short_v2: {
    strategy_id: 'regime_shock_reversion_short_v2',
    display_name: 'Regime Shock Reversion Short V2',
    direction: 'short',
    setup_family: 'regime_shock_reversion',
    implementation_status: 'active',
    extraction_ticket: 'QFA-7xx-S3-v2',
    synthetic_fixture_id: 'fixture_regime_shock_reversion_short_v2',
    enabled_in_v1: false,
  },
  regime_shock_reversion_short_v2_utc_16_18_exclusion: {
    strategy_id: 'regime_shock_reversion_short_v2_utc_16_18_exclusion',
    display_name: 'Regime Shock Reversion Short V2 UTC 16-18 Exclusion',
    direction: 'short',
    setup_family: 'regime_shock_reversion',
    implementation_status: 'active',
    extraction_ticket: 'V2-PF-C-LATE-AM-REGISTERED-INACTIVE-IMPL-01',
    synthetic_fixture_id: 'fixture_regime_shock_reversion_short_v2_utc_16_18_exclusion',
    enabled_in_v1: false,
  },
  opening_range_box_breakout_long: {
    strategy_id: 'opening_range_box_breakout_long',
    display_name: 'Opening Range Box Breakout Long',
    direction: 'long',
    setup_family: 'opening_range_box',
    implementation_status: 'active',
    extraction_ticket: 'QFA-ORB-PRIOR-DOWN-SHADOW-01',
    synthetic_fixture_id: 'fixture_opening_range_box_breakout_long',
    enabled_in_v1: false,
  },
  regime_shock_reversion_short_v3: {
    strategy_id: 'regime_shock_reversion_short_v3',
    display_name: 'Regime Shock Reversion Short V3',
    direction: 'short',
    setup_family: 'regime_shock_reversion',
    implementation_status: 'active',
    extraction_ticket: 'CYCLE4-V3-IMPL',
    synthetic_fixture_id: 'fixture_regime_shock_reversion_short_v3',
    enabled_in_v1: false,
  },
  regime_shock_reversion_short_v4_delay: {
    strategy_id: 'regime_shock_reversion_short_v4_delay',
    display_name: 'Regime Shock Reversion Short V4 Delay',
    direction: 'short',
    setup_family: 'regime_shock_reversion',
    implementation_status: 'active',
    extraction_ticket: 'CYCLE4-V4-COMBINED-01',
    synthetic_fixture_id: 'fixture_regime_shock_reversion_short_v4_delay',
    enabled_in_v1: false,
  },
  regime_shock_reversion_short_v4_persist: {
    strategy_id: 'regime_shock_reversion_short_v4_persist',
    display_name: 'Regime Shock Reversion Short V4 Persist',
    direction: 'short',
    setup_family: 'regime_shock_reversion',
    implementation_status: 'active',
    extraction_ticket: 'CYCLE4-V4-COMBINED-01',
    synthetic_fixture_id: 'fixture_regime_shock_reversion_short_v4_persist',
    enabled_in_v1: false,
  },
  regime_shock_reversion_short_v5_strict_deadline: {
    strategy_id: 'regime_shock_reversion_short_v5_strict_deadline',
    display_name: 'Regime Shock Reversion Short V5 Strict Deadline',
    direction: 'short',
    setup_family: 'regime_shock_reversion',
    implementation_status: 'active',
    extraction_ticket: 'STRAT-V5-DEADLINE-VARIANTS-01',
    synthetic_fixture_id: 'fixture_regime_shock_reversion_short_v5_strict_deadline',
    enabled_in_v1: false,
  },
  regime_shock_reversion_short_v5_trail_at_deadline: {
    strategy_id: 'regime_shock_reversion_short_v5_trail_at_deadline',
    display_name: 'Regime Shock Reversion Short V5 Trail At Deadline',
    direction: 'short',
    setup_family: 'regime_shock_reversion',
    implementation_status: 'active',
    extraction_ticket: 'STRAT-V5-DEADLINE-VARIANTS-01',
    synthetic_fixture_id: 'fixture_regime_shock_reversion_short_v5_trail_at_deadline',
    enabled_in_v1: false,
  },
} as const satisfies Record<
  ActiveStrategyId | RegisteredInactiveStrategyId,
  StrategyRegistryEntry
>;

const GENERATED_CANDIDATE_REGISTRY_ENTRIES = buildGeneratedCandidateRegistryEntries();

const STRATEGY_REGISTRY_ENTRIES = {
  ...STATIC_STRATEGY_REGISTRY_ENTRIES,
  ...GENERATED_CANDIDATE_REGISTRY_ENTRIES,
} as Readonly<Partial<Record<AnyStrategyId, StrategyRegistryEntry>>>;

export const STRATEGY_REGISTRY: Readonly<Partial<Record<AnyStrategyId, StrategyRegistryEntry>>> =
  STRATEGY_REGISTRY_ENTRIES;

const ACTIVE_STRATEGY_GENERATORS: Partial<Record<StrategyId, ActiveStrategyGenerator>> = {};

const STATIC_STRATEGY_GENERATORS: Partial<
  Record<ActiveStrategyId | RegisteredInactiveStrategyId, ActiveStrategyGenerator>
> = {
  trend_pullback_long: generateTrendPullbackLong,
  trend_pullback_short: generateTrendPullbackShort,
  breakout_retest_long: generateBreakoutRetestLong,
  breakdown_retest_short: generateBreakdownRetestShort,
  regime_mean_reversion_long: generateRegimeMeanReversionLong,
  regime_mean_reversion_short: generateRegimeMeanReversionShort,
  liquidity_sweep_reversal_long: generateLiquiditySweepReversalLong,
  liquidity_sweep_reversal_short: generateLiquiditySweepReversalShort,
  vwap_overnight_reversal_long: generateVwapOvernightReversalLong,
  vwap_overnight_reversal_short: generateVwapOvernightReversalShort,
  regime_shock_reversion_short_v2: generateRegimeShockReversionShortV2,
  regime_shock_reversion_short_v2_utc_16_18_exclusion: generateRegimeShockReversionShortV2Utc1618Exclusion,
  opening_range_box_breakout_long: generateOpeningRangeBoxBreakoutLongPriorDownNoLateShadow,
  regime_shock_reversion_short_v3: generateRegimeShockReversionShortV3,
  regime_shock_reversion_short_v4_delay: generateRegimeShockReversionShortV4Delay,
  regime_shock_reversion_short_v4_persist: generateRegimeShockReversionShortV4Persist,
  regime_shock_reversion_short_v5_strict_deadline: generateRegimeShockReversionShortV5StrictDeadline,
  regime_shock_reversion_short_v5_trail_at_deadline: generateRegimeShockReversionShortV5TrailAtDeadline,
};

const STRATEGY_GENERATORS: Partial<Record<AnyStrategyId, ActiveStrategyGenerator>> = {
  ...STATIC_STRATEGY_GENERATORS,
  ...buildGeneratedCandidateGenerators(),
};

function buildGeneratedCandidateRegistryEntries(): Readonly<Record<CandidateStrategyId, StrategyRegistryEntry>> {
  const entries: Record<string, StrategyRegistryEntry> = {};
  for (const strategyId of CANDIDATE_STRATEGY_IDS) {
    const baseStrategyId = getGeneratedCandidateBaseStrategyId(strategyId);
    const baseEntry = STATIC_STRATEGY_REGISTRY_ENTRIES[baseStrategyId];
    if (baseEntry === undefined) {
      throw new Error(`generated candidate ${strategyId} references unknown base strategy ${baseStrategyId}`);
    }
    entries[strategyId] = {
      ...baseEntry,
      strategy_id: strategyId,
      display_name: `${baseEntry.display_name} Generated Candidate`,
      enabled_in_v1: false,
    };
  }
  return Object.freeze(entries) as Readonly<Record<CandidateStrategyId, StrategyRegistryEntry>>;
}

function buildGeneratedCandidateGenerators(): Partial<Record<CandidateStrategyId, ActiveStrategyGenerator>> {
  const entries: Record<string, ActiveStrategyGenerator> = {};
  for (const strategyId of CANDIDATE_STRATEGY_IDS) {
    const baseStrategyId = getGeneratedCandidateBaseStrategyId(strategyId);
    const generator = STATIC_STRATEGY_GENERATORS[baseStrategyId];
    if (generator === undefined) {
      throw new Error(`generated candidate ${strategyId} base strategy ${baseStrategyId} has no generator`);
    }
    entries[strategyId] = (input) => rewriteGeneratedCandidateResult(
      strategyId,
      baseStrategyId,
      generator({
        ...input,
        strategy_id: baseStrategyId,
        strategy_config: strategyConfigWithGeneratedParameters(
          input.strategy_config,
          strategyId,
          baseStrategyId,
        ),
      }),
    );
  }
  return entries;
}

function strategyConfigWithGeneratedParameters(
  strategyConfig: StrategyRuntimeConfig | undefined,
  candidateStrategyId: CandidateStrategyId,
  baseStrategyId: ActiveStrategyId | RegisteredInactiveStrategyId,
): StrategyRuntimeConfig | undefined {
  const candidateParameters = strategyConfig?.strategies[candidateStrategyId];
  if (strategyConfig === undefined || candidateParameters === undefined) {
    return strategyConfig;
  }
  return {
    ...strategyConfig,
    strategies: {
      ...strategyConfig.strategies,
      [baseStrategyId]: candidateParameters,
    },
  } as StrategyRuntimeConfig;
}

function rewriteGeneratedCandidateResult(
  candidateStrategyId: CandidateStrategyId,
  baseStrategyId: ActiveStrategyId | RegisteredInactiveStrategyId,
  result: StrategyGenerationResult,
): StrategyGenerationResult {
  const evaluation = {
    ...result.evaluation,
    strategy_evaluation_id: makeStrategyEvaluationId(
      `${result.evaluation.strategy_evaluation_id}-${candidateStrategyId}`,
    ),
    strategy_id: candidateStrategyId,
    reasons: [
      `generated_candidate_base:${baseStrategyId}`,
      ...result.evaluation.reasons,
    ],
  };
  if (result.candidate === undefined) {
    return { evaluation };
  }
  return {
    evaluation,
    candidate: {
      ...result.candidate,
      candidate_id: makeCandidateId(`${result.candidate.candidate_id}-${candidateStrategyId}`),
      strategy_id: candidateStrategyId,
      setup_type: candidateStrategyId,
      reasons: [
        `generated_candidate_base:${baseStrategyId}`,
        ...result.candidate.reasons,
      ],
    },
  };
}
export function listStrategyRegistryEntries(): readonly StrategyRegistryEntry[] {
  return ACTIVE_STRATEGY_IDS.map((strategyId) => {
    const entry = STRATEGY_REGISTRY[strategyId];
    if (entry === undefined) {
      throw new Error(`strategy ${strategyId} is missing a registry entry`);
    }
    return entry;
  });
}

export function listAllStrategyRegistryEntries(): readonly StrategyRegistryEntry[] {
  return ANY_STRATEGY_IDS.map((strategyId) => {
    const entry = STRATEGY_REGISTRY[strategyId];
    if (entry === undefined) {
      throw new Error(`strategy ${strategyId} is missing a registry entry`);
    }
    return entry;
  });
}

export function getStrategyRegistryEntry(strategyId: StrategyId | string): StrategyRegistryEntry {
  const parsed = parseAnyStrategyId(strategyId);
  const entry = STRATEGY_REGISTRY[parsed];
  if (entry === undefined) {
    throw new Error(`strategy ${parsed} is missing a registry entry`);
  }
  return entry;
}

export function listStrategyIdsByDirection(direction: Direction): readonly StrategyId[] {
  void direction;
  return [];
}

export function listStrategyIdsBySetupFamily(
  setupFamily: StrategySetupFamily,
): readonly StrategyId[] {
  void setupFamily;
  return [];
}

export function listExecutableStrategyIds(): readonly StrategyId[] {
  return ACTIVE_STRATEGY_IDS.filter((strategyId) => strategyId in ACTIVE_STRATEGY_GENERATORS);
}

export function getActiveStrategyGenerator(strategyId: StrategyId | string): ActiveStrategyGenerator {
  const parsed = parseAnyStrategyId(strategyId);
  const generator = STRATEGY_GENERATORS[parsed];
  if (generator === undefined) {
    throw new Error(`strategy ${parsed} is pending extraction and is not executable`);
  }
  return generator;
}

export function getStrategyGenerator(strategyId: StrategyId | string): ActiveStrategyGenerator {
  const parsed = parseAnyStrategyId(strategyId);
  const generator = STRATEGY_GENERATORS[parsed];
  if (generator === undefined) {
    throw new Error(`strategy ${parsed} is pending extraction and is not executable`);
  }
  return generator;
}

export function validateStrategyRegistry(): readonly string[] {
  const issues: string[] = [];
  const registeredIds = Object.keys(STRATEGY_REGISTRY).sort();
  const allIds = [...ANY_STRATEGY_IDS].sort();

  if (registeredIds.join('|') !== allIds.join('|')) {
    issues.push(
      `registered strategy ids ${registeredIds.join(',')} do not match all strategy ids ${allIds.join(',')}`,
    );
  }

  for (const strategyId of ANY_STRATEGY_IDS) {
    const entry = STRATEGY_REGISTRY[strategyId];
    if (entry === undefined) {
      issues.push(`${strategyId} is missing a registry entry`);
      continue;
    }
    if (entry.strategy_id !== strategyId) {
      issues.push(`${strategyId} registry entry has mismatched strategy_id ${entry.strategy_id}`);
    }
    const hasGenerator = strategyId in STRATEGY_GENERATORS;
    if (entry.implementation_status === 'active' && !hasGenerator) {
      issues.push(`${strategyId} is active but has no generator`);
    }
    if (entry.implementation_status === 'pending_extraction' && hasGenerator) {
      issues.push(`${strategyId} has a generator but is still pending_extraction`);
    }
    const isActiveRoster = ACTIVE_STRATEGY_IDS.includes(strategyId as never);
    const hasActiveGenerator = strategyId in ACTIVE_STRATEGY_GENERATORS;
    if (!isActiveRoster && hasActiveGenerator) {
      issues.push(`${strategyId} is not in ACTIVE_STRATEGY_IDS but is in ACTIVE_STRATEGY_GENERATORS`);
    }
    if (entry.enabled_in_v1 !== isActiveRoster) {
      issues.push(`${strategyId} enabled_in_v1=${entry.enabled_in_v1} does not match active roster membership`);
    }
  }

  return issues;
}

