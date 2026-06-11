import {
  DEFAULT_OPENING_RANGE_BOX_BREAKOUT_SHORT_CONFIG,
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

export const OPENING_RANGE_BOX_BREAKOUT_SHORT_DEFAULTS = DEFAULT_OPENING_RANGE_BOX_BREAKOUT_SHORT_CONFIG;

const STRATEGY_ID = 'opening_range_box_breakout_short' as const;

/**
 * 10 AM box BREAKOUT (short): mirror of the long. Arm a short when price closes
 * below the box low by a confirmation buffer (and within the chase limit). Stop
 * at the opposite box edge (box high + buffer); targets by RR.
 */
export function generateOpeningRangeBoxBreakoutShort(
  input: StrategyEvaluationInput,
): StrategyGenerationResult {
  if (input.strategy_id !== STRATEGY_ID) {
    throw new Error(`${STRATEGY_ID} generator received ${input.strategy_id}`);
  }
  const parameters = getStrategyParameters(input.strategy_config, STRATEGY_ID);
  return runOpeningRangeBoxBreakout(STRATEGY_ID, 'short', input, parameters);
}

export function firstOpeningRangeBoxBreakoutShortRejection(
  snapshot: StrategyFeatureSnapshot,
  parameters: OpeningRangeBoxStrategyParameters,
  reasons: string[] = [],
): string | undefined {
  return firstOpeningRangeBoxBreakoutRejection(STRATEGY_ID, 'short', snapshot, parameters, reasons);
}
