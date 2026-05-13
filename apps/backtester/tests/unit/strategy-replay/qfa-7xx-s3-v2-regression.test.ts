import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  replayStrategies,
} from '../../../src/strategy-replay/index.js';
import { REPLAY_BARS } from './fixtures.js';

const S3_V2_STRATEGY_IDS = [
  'regime_shock_reversion_short_v2',
] as const;

describe('QFA-7xx-S3-v2 replay regression baseline', () => {
  it('locks regime_shock_reversion_short_v2 against QFA-301 replay drift', async () => {
    const result = await replayStrategies({
      strategy_ids: S3_V2_STRATEGY_IDS,
      bars: REPLAY_BARS,
    });
    const evaluations = result.evaluations as readonly ReplayEvaluationBehavior[];

    for (const strategyId of S3_V2_STRATEGY_IDS) {
      const baseline = readBaseline(strategyId);
      expect(extractBehavior(evaluations.filter((entry) => entry.strategy_id === strategyId)))
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
      'qfa-7xx-s3-v2-replay-baseline',
      `${strategyId}-baseline.json`,
    ),
    'utf8',
  )) as BaselineArtifact;
}

interface ReplayEvaluationBehavior {
  readonly strategy_id: string;
  readonly bar_id: string;
  readonly ts_ns: bigint;
  readonly evaluation: {
    readonly gate_state: string | null;
    readonly reasons: readonly string[];
    readonly candidate?: unknown;
  };
  readonly candidate?: unknown;
}

function extractBehavior(evaluations: readonly ReplayEvaluationBehavior[]): readonly unknown[] {
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
