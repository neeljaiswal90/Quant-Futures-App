import {
  DEFAULT_REGIME_SHOCK_REVERSION_SHORT_V4_PERSIST_CONFIG,
  getStrategyParameters,
  type RegimeShockReversionShortV4PersistStrategyParameters,
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

const STRATEGY_ID = 'regime_shock_reversion_short_v4_persist' as const;

export const REGIME_SHOCK_REVERSION_SHORT_V4_PERSIST_DEFAULTS =
  DEFAULT_REGIME_SHOCK_REVERSION_SHORT_V4_PERSIST_CONFIG;

export function generateRegimeShockReversionShortV4Persist(
  input: StrategyEvaluationInput,
): StrategyGenerationResult {
  const parameters = getStrategyParameters(input.strategy_config, STRATEGY_ID);
  return generateRegimeShockReversionShortV4(
    input,
    STRATEGY_ID,
    parameters,
    (snapshot, params, reasons) => firstRegimeShockReversionShortV4PersistRejection(
      snapshot,
      params as RegimeShockReversionShortV4PersistStrategyParameters,
      reasons,
    ),
  );
}

export function firstRegimeShockReversionShortV4PersistRejection(
  snapshot: StrategyFeatureSnapshot,
  parameters: RegimeShockReversionShortV4PersistStrategyParameters,
  reasons: string[] = [],
): string | undefined {
  if (
    !Number.isSafeInteger(parameters.shock_persistence_bars)
    || parameters.shock_persistence_bars <= 0
  ) {
    return `${STRATEGY_ID}:shock_persistence_bars_invalid`;
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
  if (recentValues.length < parameters.shock_persistence_bars) {
    return `${STRATEGY_ID}:recent_signed_shock_insufficient_history`;
  }
  const persistentValues = recentValues.slice(-parameters.shock_persistence_bars);
  if (persistentValues.some((value) => value === null)) {
    return `${STRATEGY_ID}:persistent_signed_shock_unavailable`;
  }
  const confirmedValues = persistentValues as readonly number[];
  reasons.push(`signed_shock_vwap_persist_${parameters.shock_persistence_bars}:${confirmedValues.map(roundV4DiagnosticValue).join(',')}`);
  if (confirmedValues.some((value) => !meetsRegimeShockThreshold(snapshot.context.regime_label, value, parameters))) {
    return `${STRATEGY_ID}:shock_persistence_not_confirmed`;
  }

  return undefined;
}
