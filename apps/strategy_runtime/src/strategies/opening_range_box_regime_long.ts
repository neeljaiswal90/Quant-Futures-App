import {
  DEFAULT_OPENING_RANGE_BOX_REGIME_LONG_CONFIG,
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

export const OPENING_RANGE_BOX_REGIME_LONG_DEFAULTS = DEFAULT_OPENING_RANGE_BOX_REGIME_LONG_CONFIG;

const STRATEGY_ID = 'opening_range_box_regime_long' as const;

/**
 * 10 AM box REGIME (long): dispatch breakout-vs-fade by trend/range. When the
 * structure trend is directional and adx_14 >= adx_trend_min we run the breakout
 * logic; otherwise (range) we run the false-breakdown fade. Reuses the shared
 * breakout/fade builders so logic is not duplicated.
 */
export function generateOpeningRangeBoxRegimeLong(
  input: StrategyEvaluationInput,
): StrategyGenerationResult {
  if (input.strategy_id !== STRATEGY_ID) {
    throw new Error(`${STRATEGY_ID} generator received ${input.strategy_id}`);
  }
  const parameters = getStrategyParameters(input.strategy_config, STRATEGY_ID);
  return selectOpeningRangeBoxMode(input.snapshot, parameters) === 'breakout'
    ? runOpeningRangeBoxBreakout(STRATEGY_ID, 'long', input, parameters)
    : runOpeningRangeBoxFade(STRATEGY_ID, 'long', input, parameters);
}

export function openingRangeBoxRegimeLongMode(
  snapshot: StrategyFeatureSnapshot,
  parameters: OpeningRangeBoxStrategyParameters,
): 'breakout' | 'fade' {
  return selectOpeningRangeBoxMode(snapshot, parameters);
}
