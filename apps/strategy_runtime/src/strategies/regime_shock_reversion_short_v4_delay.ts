import {
  DEFAULT_REGIME_SHOCK_REVERSION_SHORT_V4_DELAY_CONFIG,
  getStrategyParameters,
  type RegimeShockReversionShortV4DelayStrategyParameters,
} from '../config/index.js';
import type {
  StrategyEvaluationInput,
  StrategyFeatureSnapshot,
  StrategyGenerationResult,
} from './types.js';
import {
  firstBaseRegimeShockReversionShortV4Rejection,
  generateRegimeShockReversionShortV4,
  meetsRegimeShockThreshold,
  roundV4DiagnosticValue,
} from './regime_shock_reversion_short_v4_common.js';

const STRATEGY_ID = 'regime_shock_reversion_short_v4_delay' as const;

export const REGIME_SHOCK_REVERSION_SHORT_V4_DELAY_DEFAULTS =
  DEFAULT_REGIME_SHOCK_REVERSION_SHORT_V4_DELAY_CONFIG;

export function generateRegimeShockReversionShortV4Delay(
  input: StrategyEvaluationInput,
): StrategyGenerationResult {
  const parameters = getStrategyParameters(input.strategy_config, STRATEGY_ID);
  return generateRegimeShockReversionShortV4(
    input,
    STRATEGY_ID,
    parameters,
    (snapshot, params, reasons) => firstRegimeShockReversionShortV4DelayRejection(
      snapshot,
      params as RegimeShockReversionShortV4DelayStrategyParameters,
      reasons,
    ),
  );
}

export function firstRegimeShockReversionShortV4DelayRejection(
  snapshot: StrategyFeatureSnapshot,
  parameters: RegimeShockReversionShortV4DelayStrategyParameters,
  reasons: string[] = [],
): string | undefined {
  if (
    !Number.isSafeInteger(parameters.entry_confirmation_delay_bars)
    || parameters.entry_confirmation_delay_bars <= 0
  ) {
    return `${STRATEGY_ID}:entry_confirmation_delay_bars_invalid`;
  }

  const baseRejection = firstBaseRegimeShockReversionShortV4Rejection(
    snapshot,
    parameters,
    reasons,
    STRATEGY_ID,
  );
  if (baseRejection !== undefined) {
    return baseRejection;
  }

  const recentValues = snapshot.context.signed_shock_vwap_recent_values;
  if (recentValues === null) {
    return `${STRATEGY_ID}:recent_signed_shock_unavailable`;
  }
  const delayedIndex = recentValues.length - 1 - parameters.entry_confirmation_delay_bars;
  if (delayedIndex < 0) {
    return `${STRATEGY_ID}:recent_signed_shock_insufficient_history`;
  }
  const delayedShock = recentValues[delayedIndex];
  if (delayedShock === null) {
    return `${STRATEGY_ID}:delayed_signed_shock_unavailable`;
  }
  reasons.push(`signed_shock_vwap_delay_${parameters.entry_confirmation_delay_bars}:${roundV4DiagnosticValue(delayedShock)}`);
  if (!meetsRegimeShockThreshold(snapshot.context.regime_label, delayedShock, parameters)) {
    return `${STRATEGY_ID}:delay_confirmation_not_armed`;
  }

  return undefined;
}
