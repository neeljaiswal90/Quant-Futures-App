import {
  DEFAULT_OPENING_RANGE_BOX_BREAKOUT_LONG_CONFIG,
  getStrategyParameters,
  type OpeningRangeBoxStrategyParameters,
} from '../config/index.js';
import {
  firstOpeningRangeBoxBreakoutRejection,
  runOpeningRangeBoxBreakout,
} from './opening_range_box_common.js';
import type {
  StrategyEvaluationInput,
  StrategyFeatureSnapshot,
  StrategyGenerationResult,
} from './types.js';

export const OPENING_RANGE_BOX_BREAKOUT_LONG_DEFAULTS = DEFAULT_OPENING_RANGE_BOX_BREAKOUT_LONG_CONFIG;

const STRATEGY_ID = 'opening_range_box_breakout_long' as const;

/**
 * 10 AM box BREAKOUT (long): once the 10:00 ET 5-min box is locked, arm a long
 * when price closes above the box high by a confirmation buffer (and hasn't
 * already run beyond the chase limit). Stop at the opposite box edge; targets by RR.
 */
export function generateOpeningRangeBoxBreakoutLong(
  input: StrategyEvaluationInput,
): StrategyGenerationResult {
  if (input.strategy_id !== STRATEGY_ID) {
    throw new Error(`${STRATEGY_ID} generator received ${input.strategy_id}`);
  }
  const parameters = getStrategyParameters(input.strategy_config, STRATEGY_ID);
  return runOpeningRangeBoxBreakout(STRATEGY_ID, 'long', input, parameters);
}

export function firstOpeningRangeBoxBreakoutLongRejection(
  snapshot: StrategyFeatureSnapshot,
  parameters: OpeningRangeBoxStrategyParameters,
  reasons: string[] = [],
): string | undefined {
  return firstOpeningRangeBoxBreakoutRejection(STRATEGY_ID, 'long', snapshot, parameters, reasons);
}
