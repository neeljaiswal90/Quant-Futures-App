import {
  DEFAULT_OPENING_RANGE_BOX_REGIME_SHORT_CONFIG,
  getStrategyParameters,
  type OpeningRangeBoxStrategyParameters,
} from '../config/index.js';
import {
  runOpeningRangeBoxBreakout,
  runOpeningRangeBoxFade,
  selectOpeningRangeBoxMode,
} from './opening_range_box_common.js';
import type {
  StrategyEvaluationInput,
  StrategyFeatureSnapshot,
  StrategyGenerationResult,
} from './types.js';

export const OPENING_RANGE_BOX_REGIME_SHORT_DEFAULTS = DEFAULT_OPENING_RANGE_BOX_REGIME_SHORT_CONFIG;

const STRATEGY_ID = 'opening_range_box_regime_short' as const;

/**
 * 10 AM box REGIME (short): mirror of the long dispatcher. Trending (directional
 * trend + adx_14 >= adx_trend_min) → breakout short; range → false-breakout fade
 * short. Reuses the shared breakout/fade builders so logic is not duplicated.
 */
export function generateOpeningRangeBoxRegimeShort(
  input: StrategyEvaluationInput,
): StrategyGenerationResult {
  if (input.strategy_id !== STRATEGY_ID) {
    throw new Error(`${STRATEGY_ID} generator received ${input.strategy_id}`);
  }
  const parameters = getStrategyParameters(input.strategy_config, STRATEGY_ID);
  return selectOpeningRangeBoxMode(input.snapshot, parameters) === 'breakout'
    ? runOpeningRangeBoxBreakout(STRATEGY_ID, 'short', input, parameters)
    : runOpeningRangeBoxFade(STRATEGY_ID, 'short', input, parameters);
}

export function openingRangeBoxRegimeShortMode(
  snapshot: StrategyFeatureSnapshot,
  parameters: OpeningRangeBoxStrategyParameters,
): 'breakout' | 'fade' {
  return selectOpeningRangeBoxMode(snapshot, parameters);
}
