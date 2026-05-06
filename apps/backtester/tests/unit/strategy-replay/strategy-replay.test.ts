import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ACTIVE_STRATEGY_IDS } from '../../../../strategy_runtime/src/contracts/strategy-ids.js';
import {
  defaultStrategyReplayIds,
  replayStrategies,
} from '../../../src/strategy-replay/index.js';
import { REPLAY_BARS } from './fixtures.js';

describe('strategy replay sanity harness', () => {
  it('invokes all four existing strategy IDs', async () => {
    const result = await replayStrategies({
      strategy_ids: defaultStrategyReplayIds(),
      bars: REPLAY_BARS,
    });

    expect(result.summary.map((entry) => entry.strategy_id)).toEqual(ACTIVE_STRATEGY_IDS);
    expect(result.summary).toHaveLength(4);
    expect(result.summary.every((entry) => entry.bars_evaluated === REPLAY_BARS.length)).toBe(true);
    expect(result.summary.every((entry) => entry.errors.length === 0)).toBe(true);
  });

  it('emits deterministic result order by bar then explicit strategy order', async () => {
    const result = await replayStrategies({
      strategy_ids: ['breakout_retest_long', 'trend_pullback_short'],
      bars: [REPLAY_BARS[1]!, REPLAY_BARS[0]!],
    });

    expect(result.evaluations.map((evaluation) => `${evaluation.bar_id}:${evaluation.strategy_id}`)).toEqual([
      'bar-001:breakout_retest_long',
      'bar-001:trend_pullback_short',
      'bar-002:breakout_retest_long',
      'bar-002:trend_pullback_short',
    ]);
  });

  it('returns one sanity result per strategy for an empty bar stream', async () => {
    const result = await replayStrategies({
      strategy_ids: defaultStrategyReplayIds(),
      bars: [],
    });

    expect(result.evaluations).toEqual([]);
    expect(result.summary).toEqual(
      ACTIVE_STRATEGY_IDS.map((strategyId) => ({
        strategy_id: strategyId,
        bars_evaluated: 0,
        evaluations_emitted: 0,
        errors: [],
      })),
    );
  });

  it('rejects invalid strategy IDs through the existing parser', async () => {
    await expect(
      replayStrategies({
        strategy_ids: ['breakout_retest_short'],
        bars: REPLAY_BARS,
      }),
    ).rejects.toThrow(/Unknown strategy_id/u);
  });

  it('produces deeply equal replay results for identical inputs', async () => {
    const first = await replayStrategies({
      strategy_ids: defaultStrategyReplayIds(),
      bars: REPLAY_BARS,
    });
    const second = await replayStrategies({
      strategy_ids: defaultStrategyReplayIds(),
      bars: REPLAY_BARS,
    });

    expect(second).toEqual(first);
  });

  it('does not introduce nondeterministic runtime calls in strategy-replay source', () => {
    const sourceRoot = join(process.cwd(), 'apps/backtester/src/strategy-replay');
    const forbidden = /Date\.now|Math\.random|randomUUID|new Date\(/u;

    for (const fileName of readdirSync(sourceRoot)) {
      if (!fileName.endsWith('.ts')) continue;
      const source = readFileSync(join(sourceRoot, fileName), 'utf8');
      expect(source, fileName).not.toMatch(forbidden);
    }
  });
});
