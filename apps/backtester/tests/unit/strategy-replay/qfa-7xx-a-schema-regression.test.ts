import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ACTIVE_STRATEGY_IDS } from '../../../../strategy_runtime/src/contracts/strategy-ids.js';
import {
  defaultStrategyReplayIds,
  replayStrategies,
} from '../../../src/strategy-replay/index.js';
import { REPLAY_BARS } from './fixtures.js';

describe('QFA-7xx-A schema-only replay regression gate', () => {
  it('preserves existing strategy behavior against the pre-ticket QFA-301 baselines', async () => {
    const result = await replayStrategies({
      strategy_ids: defaultStrategyReplayIds(),
      bars: REPLAY_BARS,
    });

    expect(defaultStrategyReplayIds()).toEqual(ACTIVE_STRATEGY_IDS);
    for (const strategyId of defaultStrategyReplayIds()) {
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
      'qfa-7xx-a-regression-baseline',
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
}[]): readonly unknown[] {
  return evaluations.map((entry) => ({
    bar_id: entry.bar_id,
    candidate: candidateBehavior(entry.evaluation.candidate),
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
