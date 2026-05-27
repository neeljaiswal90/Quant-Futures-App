import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ACTIVE_STRATEGY_IDS,
  type StrategyId,
} from '../../../../strategy_runtime/src/contracts/strategy-ids.js';
import type { StrategyReplayEvaluation } from '../../../src/strategy-replay/index.js';
import {
  computeStrategyFingerprintSet,
  STRATEGY_FINGERPRINT_ALGORITHM,
} from '../../../src/strategy-fingerprint/index.js';
import { replayStrategies } from '../../../src/strategy-replay/index.js';
import { REPLAY_BARS } from '../strategy-replay/fixtures.js';

const SHA_256_HEX = /^[a-f0-9]{64}$/u;
const EXPLICIT_REPLAY_STRATEGY_IDS = [
  'vwap_overnight_reversal_long',
  'vwap_overnight_reversal_short',
  'regime_shock_reversion_short_v2',
] as const satisfies readonly StrategyId[];

describe('strategy fingerprint computation', () => {
  it('computes one fingerprint per explicit registered-inactive research strategy', async () => {
    const replay = await replayFixture();
    const fingerprints = computeStrategyFingerprintSet(replay.evaluations, EXPLICIT_REPLAY_STRATEGY_IDS);

    expect(fingerprints.algorithm).toBe(STRATEGY_FINGERPRINT_ALGORITHM);
    expect(fingerprints.fingerprints.map((fingerprint) => fingerprint.strategy_id)).toEqual(
      EXPLICIT_REPLAY_STRATEGY_IDS,
    );
    expect(fingerprints.fingerprints.every((fingerprint) => fingerprint.decision_count === 4)).toBe(
      true,
    );
    expect(
      fingerprints.fingerprints.every(
        (fingerprint) =>
          SHA_256_HEX.test(fingerprint.decisions_sha256) &&
          SHA_256_HEX.test(fingerprint.fingerprint_sha256),
      ),
    ).toBe(true);
  });

  it('emits output order in explicit strategy order', async () => {
    const replay = await replayFixture(['breakout_retest_long', 'trend_pullback_long']);
    const fingerprints = computeStrategyFingerprintSet(replay.evaluations, [
      'breakout_retest_long',
      'trend_pullback_long',
    ]);

    expect(fingerprints.fingerprints.map((fingerprint) => fingerprint.strategy_id)).toEqual([
      'breakout_retest_long',
      'trend_pullback_long',
    ]);
  });

  it('produces identical fingerprints for identical replay output', async () => {
    const first = await replayFixture();
    const second = await replayFixture();

    expect(computeStrategyFingerprintSet(second.evaluations, EXPLICIT_REPLAY_STRATEGY_IDS)).toEqual(
      computeStrategyFingerprintSet(first.evaluations, EXPLICIT_REPLAY_STRATEGY_IDS),
    );
  });

  it('changes only the affected strategy fingerprint when one decision changes', async () => {
    const replay = await replayFixture();
    const before = computeStrategyFingerprintSet(replay.evaluations, EXPLICIT_REPLAY_STRATEGY_IDS);
    const changedStrategyId = replay.evaluations[0]!.strategy_id;
    const changedEvaluations = replay.evaluations.map((evaluation, index) =>
      index === 0
        ? {
            ...evaluation,
            evaluation: {
              ...evaluation.evaluation,
              reasons: [...evaluation.evaluation.reasons, 'qfa302_changed_reason'],
            },
          }
        : evaluation,
    );
    const after = computeStrategyFingerprintSet(changedEvaluations, EXPLICIT_REPLAY_STRATEGY_IDS);

    for (const strategyId of EXPLICIT_REPLAY_STRATEGY_IDS) {
      const prior = before.fingerprints.find((fingerprint) => fingerprint.strategy_id === strategyId);
      const next = after.fingerprints.find((fingerprint) => fingerprint.strategy_id === strategyId);
      expect(next).toBeDefined();
      expect(prior).toBeDefined();
      if (strategyId === changedStrategyId) {
        expect(next?.fingerprint_sha256).not.toBe(prior?.fingerprint_sha256);
      } else {
        expect(next?.fingerprint_sha256).toBe(prior?.fingerprint_sha256);
      }
    }
  });

  it('documents empty evaluation behavior', () => {
    expect(computeStrategyFingerprintSet([]).fingerprints).toEqual([]);

    const ordered = computeStrategyFingerprintSet([], ACTIVE_STRATEGY_IDS);
    expect(ACTIVE_STRATEGY_IDS).toEqual([]);
    expect(ordered.fingerprints).toHaveLength(ACTIVE_STRATEGY_IDS.length);
    expect(ordered.fingerprints.map((fingerprint) => fingerprint.decision_count)).toEqual(
      ACTIVE_STRATEGY_IDS.map(() => 0),
    );
  });

  it('uses the versioned fingerprint algorithm marker', () => {
    expect(STRATEGY_FINGERPRINT_ALGORITHM).toBe('qfa_strategy_fingerprint_sha256_v1');
  });

  it('does not introduce nondeterministic runtime calls in strategy-fingerprint source', () => {
    const sourceRoot = join(process.cwd(), 'apps/backtester/src/strategy-fingerprint');
    const forbidden = /Date\.now|Math\.random|randomUUID|new Date\(/u;

    for (const fileName of readdirSync(sourceRoot)) {
      if (!fileName.endsWith('.ts')) continue;
      const source = readFileSync(join(sourceRoot, fileName), 'utf8');
      expect(source, fileName).not.toMatch(forbidden);
    }
  });
});

async function replayFixture(
  strategyIds: readonly StrategyId[] = EXPLICIT_REPLAY_STRATEGY_IDS,
) {
  return replayStrategies({
    strategy_ids: strategyIds,
    bars: REPLAY_BARS,
  });
}

const _typeCheckEvaluation: readonly StrategyReplayEvaluation[] = [];
void _typeCheckEvaluation;
