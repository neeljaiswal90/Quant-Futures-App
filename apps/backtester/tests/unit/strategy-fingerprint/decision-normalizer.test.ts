import { describe, expect, it } from 'vitest';

import { ACTIVE_STRATEGY_IDS } from '../../../../strategy_runtime/src/contracts/strategy-ids.js';
import type { StrategyReplayEvaluation } from '../../../src/strategy-replay/index.js';
import {
  normalizeStrategyReplayDecisions,
  StrategyFingerprintInputError,
} from '../../../src/strategy-fingerprint/index.js';
import {
  defaultStrategyReplayIds,
  replayStrategies,
} from '../../../src/strategy-replay/index.js';
import { REPLAY_BARS } from '../strategy-replay/fixtures.js';

describe('strategy fingerprint decision normalizer', () => {
  it('normalizes QFA-301 replay evaluations into fingerprint decisions', async () => {
    const replay = await replayFixture();
    const decisions = normalizeStrategyReplayDecisions(replay.evaluations);

    expect(decisions).toHaveLength(REPLAY_BARS.length * ACTIVE_STRATEGY_IDS.length);
    expect(decisions.slice(0, ACTIVE_STRATEGY_IDS.length).map((decision) => decision.strategy_id)).toEqual(
      ACTIVE_STRATEGY_IDS,
    );
    expect(
      decisions
        .filter((decision) => decision.strategy_id === ACTIVE_STRATEGY_IDS[0])
        .map((decision) => decision.sequence),
    ).toEqual([1, 2, 3, 4]);
    expect(decisions[0]).toMatchObject({
      sequence: 1,
      bar_id: 'bar-001',
      strategy_id: ACTIVE_STRATEGY_IDS[0],
    });
  });

  it('rejects unknown strategy_id values', async () => {
    const replay = await replayFixture();
    const malformed = [
      {
        ...replay.evaluations[0]!,
        strategy_id: 'breakout_retest_short',
      },
    ] as unknown as readonly StrategyReplayEvaluation[];

    expectFingerprintIssue(() => normalizeStrategyReplayDecisions(malformed), 'unknown_strategy_id');
  });

  it('rejects missing bar_id values', async () => {
    const replay = await replayFixture();
    const malformed = [
      {
        ...replay.evaluations[0]!,
        bar_id: '',
      },
    ] as unknown as readonly StrategyReplayEvaluation[];

    expectFingerprintIssue(() => normalizeStrategyReplayDecisions(malformed), 'missing_bar_id');
  });

  it('rejects missing ts_ns values', async () => {
    const replay = await replayFixture();
    const malformed = [
      {
        ...replay.evaluations[0]!,
        ts_ns: undefined,
      },
    ] as unknown as readonly StrategyReplayEvaluation[];

    expectFingerprintIssue(() => normalizeStrategyReplayDecisions(malformed), 'missing_ts_ns');
  });

  it('rejects non-finite scores', async () => {
    const replay = await replayFixture();
    const malformed = [
      {
        ...replay.evaluations[0]!,
        evaluation: {
          ...replay.evaluations[0]!.evaluation,
          score: Number.POSITIVE_INFINITY,
        },
      },
    ] as unknown as readonly StrategyReplayEvaluation[];

    expectFingerprintIssue(() => normalizeStrategyReplayDecisions(malformed), 'non_finite_score');
  });
});

async function replayFixture() {
  return replayStrategies({
    strategy_ids: defaultStrategyReplayIds(),
    bars: REPLAY_BARS,
  });
}

function expectFingerprintIssue(
  callback: () => unknown,
  expectedCode: StrategyFingerprintInputError['issues'][number]['code'],
): void {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(StrategyFingerprintInputError);
    expect((error as StrategyFingerprintInputError).issues.map((issue) => issue.code)).toContain(
      expectedCode,
    );
    return;
  }

  throw new Error(`expected StrategyFingerprintInputError with ${expectedCode}`);
}
