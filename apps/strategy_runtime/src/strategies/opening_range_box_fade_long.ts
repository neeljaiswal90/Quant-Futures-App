import {
  DEFAULT_OPENING_RANGE_BOX_FADE_LONG_CONFIG,
  getStrategyParameters,
  type OpeningRangeBoxStrategyParameters,
} from '../config/index.js';
import {
  firstOpeningRangeBoxFadeRejection,
  runOpeningRangeBoxFade,
} from './opening_range_box_common.js';
import type {
  StrategyEvaluationInput,
  StrategyFeatureSnapshot,
  StrategyGenerationResult,
} from './types.js';

export const OPENING_RANGE_BOX_FADE_LONG_DEFAULTS = DEFAULT_OPENING_RANGE_BOX_FADE_LONG_CONFIG;

const STRATEGY_ID = 'opening_range_box_fade_long' as const;

/**
 * 10 AM box FADE (long): false-breakdown fade. A post-box bar poked its low
 * below box_low - fade_poke_ticks but current price has closed back inside the
 * box (price >= box_low). Enter long inside the box; stop below the poke low;
 * target box mid / box high by RR.
 */
export function generateOpeningRangeBoxFadeLong(
  input: StrategyEvaluationInput,
): StrategyGenerationResult {
  if (input.strategy_id !== STRATEGY_ID) {
    throw new Error(`${STRATEGY_ID} generator received ${input.strategy_id}`);
  }
  const parameters = getStrategyParameters(input.strategy_config, STRATEGY_ID);
  return runOpeningRangeBoxFade(STRATEGY_ID, 'long', input, parameters);
}

export function firstOpeningRangeBoxFadeLongRejection(
  snapshot: StrategyFeatureSnapshot,
  parameters: OpeningRangeBoxStrategyParameters,
  reasons: string[] = [],
): string | undefined {
  return firstOpeningRangeBoxFadeRejection(STRATEGY_ID, 'long', snapshot, parameters, reasons);
}
