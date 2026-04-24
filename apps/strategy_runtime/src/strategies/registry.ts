import { ACTIVE_STRATEGY_IDS, parseStrategyId, type StrategyId } from '../contracts/strategy-ids.js';
import type { Direction } from '../contracts/market.js';
import type { StrategyRegistryEntry, StrategySetupFamily } from './types.js';

const STRATEGY_REGISTRY_ENTRIES = {
  trend_pullback_long: {
    strategy_id: 'trend_pullback_long',
    display_name: 'Trend Pullback Long',
    direction: 'long',
    setup_family: 'trend_pullback',
    implementation_status: 'pending_extraction',
    extraction_ticket: 'STRAT-02',
    synthetic_fixture_id: 'fixture_trend_pullback_long',
    enabled_in_v1: true,
  },
  trend_pullback_short: {
    strategy_id: 'trend_pullback_short',
    display_name: 'Trend Pullback Short',
    direction: 'short',
    setup_family: 'trend_pullback',
    implementation_status: 'pending_extraction',
    extraction_ticket: 'STRAT-03',
    synthetic_fixture_id: 'fixture_trend_pullback_short',
    enabled_in_v1: true,
  },
  breakout_retest_long: {
    strategy_id: 'breakout_retest_long',
    display_name: 'Breakout Retest Long',
    direction: 'long',
    setup_family: 'breakout_retest',
    implementation_status: 'pending_extraction',
    extraction_ticket: 'STRAT-04',
    synthetic_fixture_id: 'fixture_breakout_retest_long',
    enabled_in_v1: true,
  },
  breakdown_retest_short: {
    strategy_id: 'breakdown_retest_short',
    display_name: 'Breakdown Retest Short',
    direction: 'short',
    setup_family: 'breakout_retest',
    implementation_status: 'pending_extraction',
    extraction_ticket: 'STRAT-05',
    synthetic_fixture_id: 'fixture_breakdown_retest_short',
    enabled_in_v1: true,
  },
} as const satisfies Record<StrategyId, StrategyRegistryEntry>;

export const STRATEGY_REGISTRY: Readonly<Record<StrategyId, StrategyRegistryEntry>> =
  STRATEGY_REGISTRY_ENTRIES;

export function listStrategyRegistryEntries(): readonly StrategyRegistryEntry[] {
  return ACTIVE_STRATEGY_IDS.map((strategyId) => STRATEGY_REGISTRY[strategyId]);
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

export function validateStrategyRegistry(): readonly string[] {
  const issues: string[] = [];
  const registeredIds = Object.keys(STRATEGY_REGISTRY).sort();
  const activeIds = [...ACTIVE_STRATEGY_IDS].sort();

  if (registeredIds.join('|') !== activeIds.join('|')) {
    issues.push(
      `registered strategy ids ${registeredIds.join(',')} do not match active ids ${activeIds.join(',')}`,
    );
  }

  for (const strategyId of ACTIVE_STRATEGY_IDS) {
    const entry = STRATEGY_REGISTRY[strategyId];
    if (entry.strategy_id !== strategyId) {
      issues.push(`${strategyId} registry entry has mismatched strategy_id ${entry.strategy_id}`);
    }
    if (entry.implementation_status !== 'pending_extraction') {
      issues.push(`${strategyId} should remain pending_extraction until its STRAT extraction lands`);
    }
  }

  return issues;
}
