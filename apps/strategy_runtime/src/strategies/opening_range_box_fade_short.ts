import {
  DEFAULT_OPENING_RANGE_BOX_FADE_SHORT_CONFIG,
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

export const OPENING_RANGE_BOX_FADE_SHORT_DEFAULTS = DEFAULT_OPENING_RANGE_BOX_FADE_SHORT_CONFIG;

const STRATEGY_ID = 'opening_range_box_fade_short' as const;

/**
 * 10 AM box FADE (short): false-breakout fade (mirror of fade_long). A post-box
 * bar poked its high above box_high + fade_poke_ticks but current price has
 * closed back inside the box (price <= box_high). Enter short inside the box;
 * stop above the poke high; target box mid / box low by RR.
 */
export function generateOpeningRangeBoxFadeShort(
  input: StrategyEvaluationInput,
): StrategyGenerationResult {
  if (input.strategy_id !== STRATEGY_ID) {
    throw new Error(`${STRATEGY_ID} generator received ${input.strategy_id}`);
  }
  const parameters = getStrategyParameters(input.strategy_config, STRATEGY_ID);
  return runOpeningRangeBoxFade(STRATEGY_ID, 'short', input, parameters);
}

export function firstOpeningRangeBoxFadeShortRejection(
  snapshot: StrategyFeatureSnapshot,
  parameters: OpeningRangeBoxStrategyParameters,
  reasons: string[] = [],
): string | undefined {
  return firstOpeningRangeBoxFadeRejection(STRATEGY_ID, 'short', snapshot, parameters, reasons);
}
