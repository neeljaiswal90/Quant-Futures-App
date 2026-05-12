import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { StrategyId } from '../../../../strategy_runtime/src/contracts/strategy-ids.js';
import {
  replayStrategies,
} from '../../../src/strategy-replay/index.js';
import { REPLAY_BARS } from './fixtures.js';

const QFA_7XX_A2_REGRESSION_STRATEGY_IDS = [
  'trend_pullback_long',
  'trend_pullback_short',
  'breakout_retest_long',
  'breakdown_retest_short',
  'regime_mean_reversion_long',
  'regime_mean_reversion_short',
  'liquidity_sweep_reversal_long',
  'liquidity_sweep_reversal_short',
] as const satisfies readonly StrategyId[];

describe('QFA-7xx-A2 schema-only replay regression gate', () => {
  it('preserves all 8 active Cycle2 strategy behaviors against pre-ticket QFA-301 baselines', async () => {
    const result = await replayStrategies({
      strategy_ids: QFA_7XX_A2_REGRESSION_STRATEGY_IDS,
      bars: REPLAY_BARS,
    });

    for (const strategyId of QFA_7XX_A2_REGRESSION_STRATEGY_IDS) {
      const baseline = readBaseline(strategyId);
      expect(extractBehavior(result.evaluations.filter((entry) => entry.strategy_id === strategyId)))
        .toEqual(baseline.evaluations);
    }
  });
});

interface BaselineArtifact {
  readonly evaluations: readonly unknown[];
}

function readBaseline(strategyId: string): BaselineArtifact {
  return JSON.parse(readFileSync(
    join(
      process.cwd(),
      'apps',
      'backtester',
      'tests',
      'fixtures',
      'qfa-7xx-a2-regression-baseline',
      `${strategyId}-baseline.json`,
    ),
    'utf8',
  )) as BaselineArtifact;
}

function extractBehavior(evaluations: readonly {
  readonly strategy_id: string;
  readonly bar_id: string;
  readonly ts_ns: bigint;
  readonly evaluation: {
    readonly gate_state: string | null;
    readonly reasons: readonly string[];
    readonly candidate?: unknown;
  };
  readonly candidate?: unknown;
}[]): readonly unknown[] {
  return evaluations.map((entry) => ({
    bar_id: entry.bar_id,
    candidate: candidateBehavior(entry.candidate ?? entry.evaluation.candidate),
    gate_state: entry.evaluation.gate_state,
    reasons: entry.evaluation.reasons,
    strategy_id: entry.strategy_id,
    ts_ns: String(entry.ts_ns),
  }));
}

function candidateBehavior(candidate: unknown): unknown {
  if (candidate === null || candidate === undefined || typeof candidate !== 'object') {
    return null;
  }
  const record = candidate as {
    readonly confidence?: number | null;
    readonly entry_price?: number | null;
    readonly risk_points?: number | null;
    readonly side?: string | null;
    readonly stop_price?: number | null;
    readonly targets?: readonly { readonly price: number; readonly quantity_fraction: number }[];
  };
  return {
    confidence: record.confidence ?? null,
    entry_price: record.entry_price ?? null,
    risk_points: record.risk_points ?? null,
    side: record.side ?? null,
    stop_price: record.stop_price ?? null,
    targets: (record.targets ?? []).map((target) => ({
      price: target.price,
      quantity_fraction: target.quantity_fraction,
    })),
  };
}
