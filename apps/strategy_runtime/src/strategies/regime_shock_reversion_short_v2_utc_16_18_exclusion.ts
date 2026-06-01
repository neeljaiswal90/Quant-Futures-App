import { getStrategyParameters } from '../config/index.js';
import { generateRegimeShockReversionShortV2WithParameters } from './regime_shock_reversion_short_v2.js';
import type { StrategyEvaluationInput, StrategyGenerationResult } from './types.js';

const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion' as const;

export function generateRegimeShockReversionShortV2Utc1618Exclusion(
  input: StrategyEvaluationInput,
): StrategyGenerationResult {
  if (input.strategy_id !== STRATEGY_ID) {
    throw new Error(`${STRATEGY_ID} generator received ${input.strategy_id}`);
  }

  const parameters = getStrategyParameters(input.strategy_config, STRATEGY_ID);
  const inherited = generateRegimeShockReversionShortV2WithParameters(input, STRATEGY_ID, parameters);
  const { evaluation } = inherited;

  if (inherited.candidate === undefined) {
    return { evaluation };
  }

  const utcHour = utcHourFromNs(input.snapshot.created_ts_ns);
  if (utcHour === 16 || utcHour === 17) {
    return {
      evaluation: {
        ...evaluation,
        gate_state: 'blocked',
        reasons: [
          `${STRATEGY_ID}:utc_16_18_exclusion`,
          `utc_hour:${utcHour}`,
          ...evaluation.reasons,
        ],
      },
    };
  }

  return {
    evaluation,
    candidate: inherited.candidate,
  };
}

function utcHourFromNs(tsNs: bigint): number {
  const hourNs = 3_600_000_000_000n;
  const dayNs = 24n * hourNs;
  const normalizedNs = ((tsNs % dayNs) + dayNs) % dayNs;
  return Number(normalizedNs / hourNs);
}

