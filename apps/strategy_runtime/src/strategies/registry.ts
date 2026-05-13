import { ACTIVE_STRATEGY_IDS, ALL_STRATEGY_IDS, parseStrategyId, type StrategyId } from '../contracts/strategy-ids.js';
import type { Direction } from '../contracts/market.js';
import { generateBreakoutRetestLong } from './breakout_retest_long.js';
import { generateBreakdownRetestShort } from './breakdown_retest_short.js';
import { generateLiquiditySweepReversalLong } from './liquidity_sweep_reversal_long.js';
import { generateLiquiditySweepReversalShort } from './liquidity_sweep_reversal_short.js';
import { generateRegimeMeanReversionLong } from './regime_mean_reversion_long.js';
import { generateRegimeMeanReversionShort } from './regime_mean_reversion_short.js';
import { generateRegimeShockReversionShortV2 } from './regime_shock_reversion_short_v2.js';
import { generateTrendPullbackLong } from './trend_pullback_long.js';
import { generateTrendPullbackShort } from './trend_pullback_short.js';
import { generateVwapOvernightReversalLong } from './vwap_overnight_reversal_long.js';
import { generateVwapOvernightReversalShort } from './vwap_overnight_reversal_short.js';
import type {
  ActiveStrategyGenerator,
  StrategyRegistryEntry,
  StrategySetupFamily,
} from './types.js';

const STRATEGY_REGISTRY_ENTRIES = {
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
    enabled_in_v1: true,
  },
  vwap_overnight_reversal_short: {
    strategy_id: 'vwap_overnight_reversal_short',
    display_name: 'VWAP Overnight Reversal Short',
    direction: 'short',
    setup_family: 'vwap_overnight_reversal',
    implementation_status: 'active',
    extraction_ticket: 'QFA-7xx-S1',
    synthetic_fixture_id: 'fixture_vwap_overnight_reversal_short',
    enabled_in_v1: true,
  },
  regime_shock_reversion_short_v2: {
    strategy_id: 'regime_shock_reversion_short_v2',
    display_name: 'Regime Shock Reversion Short V2',
    direction: 'short',
    setup_family: 'regime_shock_reversion',
    implementation_status: 'active',
    extraction_ticket: 'QFA-7xx-S3-v2',
    synthetic_fixture_id: 'fixture_regime_shock_reversion_short_v2',
    enabled_in_v1: true,
  },
} as const satisfies Record<StrategyId, StrategyRegistryEntry>;

export const STRATEGY_REGISTRY: Readonly<Record<StrategyId, StrategyRegistryEntry>> =
  STRATEGY_REGISTRY_ENTRIES;

const ACTIVE_STRATEGY_GENERATORS: Partial<Record<StrategyId, ActiveStrategyGenerator>> = {
  vwap_overnight_reversal_long: generateVwapOvernightReversalLong,
  vwap_overnight_reversal_short: generateVwapOvernightReversalShort,
  regime_shock_reversion_short_v2: generateRegimeShockReversionShortV2,
};

const STRATEGY_GENERATORS: Partial<Record<StrategyId, ActiveStrategyGenerator>> = {
  trend_pullback_long: generateTrendPullbackLong,
  trend_pullback_short: generateTrendPullbackShort,
  breakout_retest_long: generateBreakoutRetestLong,
  breakdown_retest_short: generateBreakdownRetestShort,
  regime_mean_reversion_long: generateRegimeMeanReversionLong,
  regime_mean_reversion_short: generateRegimeMeanReversionShort,
  liquidity_sweep_reversal_long: generateLiquiditySweepReversalLong,
  liquidity_sweep_reversal_short: generateLiquiditySweepReversalShort,
  ...ACTIVE_STRATEGY_GENERATORS,
};

export function listStrategyRegistryEntries(): readonly StrategyRegistryEntry[] {
  return ACTIVE_STRATEGY_IDS.map((strategyId) => STRATEGY_REGISTRY[strategyId]);
}

export function listAllStrategyRegistryEntries(): readonly StrategyRegistryEntry[] {
  return ALL_STRATEGY_IDS.map((strategyId) => STRATEGY_REGISTRY[strategyId]);
}

export function getStrategyRegistryEntry(strategyId: StrategyId | string): StrategyRegistryEntry {
  return STRATEGY_REGISTRY[parseStrategyId(strategyId)];
}

export function listStrategyIdsByDirection(direction: Direction): readonly StrategyId[] {
  return listStrategyRegistryEntries()
    .filter((entry) => entry.direction === direction)
    .map((entry) => entry.strategy_id);
}

export function listStrategyIdsBySetupFamily(
  setupFamily: StrategySetupFamily,
): readonly StrategyId[] {
  return listStrategyRegistryEntries()
    .filter((entry) => entry.setup_family === setupFamily)
    .map((entry) => entry.strategy_id);
}

export function listExecutableStrategyIds(): readonly StrategyId[] {
  return ACTIVE_STRATEGY_IDS.filter((strategyId) => strategyId in ACTIVE_STRATEGY_GENERATORS);
}

export function getActiveStrategyGenerator(strategyId: StrategyId | string): ActiveStrategyGenerator {
  const parsed = parseStrategyId(strategyId);
  const generator = STRATEGY_GENERATORS[parsed];
  if (generator === undefined) {
    throw new Error(`strategy ${parsed} is pending extraction and is not executable`);
  }
  return generator;
}

export function getStrategyGenerator(strategyId: StrategyId | string): ActiveStrategyGenerator {
  const parsed = parseStrategyId(strategyId);
  const generator = STRATEGY_GENERATORS[parsed];
  if (generator === undefined) {
    throw new Error(`strategy ${parsed} is pending extraction and is not executable`);
  }
  return generator;
}

export function validateStrategyRegistry(): readonly string[] {
  const issues: string[] = [];
  const registeredIds = Object.keys(STRATEGY_REGISTRY).sort();
  const allIds = [...ALL_STRATEGY_IDS].sort();

  if (registeredIds.join('|') !== allIds.join('|')) {
    issues.push(
      `registered strategy ids ${registeredIds.join(',')} do not match all strategy ids ${allIds.join(',')}`,
    );
  }

  for (const strategyId of ALL_STRATEGY_IDS) {
    const entry = STRATEGY_REGISTRY[strategyId];
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
