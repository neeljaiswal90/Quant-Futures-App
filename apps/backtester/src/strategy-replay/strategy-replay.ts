import { ACTIVE_STRATEGY_IDS, parseStrategyId, type StrategyId } from '../../../strategy_runtime/src/contracts/strategy-ids.js';
import type { BuiltBar } from '../../../strategy_runtime/src/data/bar-builder/index.js';
import { getActiveStrategyGenerator } from '../../../strategy_runtime/src/strategies/index.js';
import { buildReplayFeatureSnapshot } from './feature-bridge.js';
import type {
  StrategyReplayEvaluation,
  StrategyReplayOptions,
  StrategyReplayResult,
  StrategyReplaySanityResult,
} from './types.js';

export async function replayStrategies(
  options: StrategyReplayOptions,
): Promise<StrategyReplayResult> {
  const strategyIds = resolveStrategyIds(options.strategy_ids);
  const bars = sortBars(await collectBars(options.bars));
  const summaryByStrategy = new Map<StrategyId, MutableSummary>();

  for (const strategyId of strategyIds) {
    summaryByStrategy.set(strategyId, {
      strategy_id: strategyId,
      bars_evaluated: 0,
      evaluations_emitted: 0,
      errors: [],
    });
  }

  const evaluations: StrategyReplayEvaluation[] = [];
  const history: BuiltBar[] = [];

  for (const bar of bars) {
    history.push(bar);
    const bridged = buildReplayFeatureSnapshot(bar, history);

    for (const strategyId of strategyIds) {
      const summary = summaryByStrategy.get(strategyId);
      if (summary === undefined) {
        throw new Error(`missing replay summary for ${strategyId}`);
      }
      summary.bars_evaluated += 1;

      try {
        const result = getActiveStrategyGenerator(strategyId)({
          strategy_id: strategyId,
          snapshot: bridged.snapshot,
        });

        evaluations.push({
          strategy_id: strategyId,
          bar_id: bar.bar_id,
          ts_ns: bar.last_record_ts_ns,
          evaluation: result.evaluation,
          ...(result.candidate === undefined ? {} : { candidate: result.candidate }),
        });
        summary.evaluations_emitted += 1;
      } catch (error) {
        summary.errors.push(`${bar.bar_id}: ${errorMessage(error)}`);
      }
    }
  }

  return {
    evaluations,
    summary: strategyIds.map((strategyId) => freezeSummary(summaryByStrategy.get(strategyId)!)),
  };
}

export function defaultStrategyReplayIds(): readonly StrategyId[] {
  return [...ACTIVE_STRATEGY_IDS];
}

function resolveStrategyIds(strategyIds: readonly (StrategyId | string)[]): readonly StrategyId[] {
  return strategyIds.map((strategyId) => parseStrategyId(strategyId));
}

async function collectBars(
  bars: AsyncIterable<BuiltBar> | readonly BuiltBar[],
): Promise<readonly BuiltBar[]> {
  if (Symbol.asyncIterator in bars) {
    const collected: BuiltBar[] = [];
    for await (const bar of bars) {
      collected.push(bar);
    }
    return collected;
  }

  return [...bars];
}

function sortBars(bars: readonly BuiltBar[]): readonly BuiltBar[] {
  return [...bars].sort((left, right) => {
    if (left.last_record_ts_ns < right.last_record_ts_ns) return -1;
    if (left.last_record_ts_ns > right.last_record_ts_ns) return 1;
    return left.bar_id.localeCompare(right.bar_id);
  });
}

interface MutableSummary {
  readonly strategy_id: StrategyId;
  bars_evaluated: number;
  evaluations_emitted: number;
  readonly errors: string[];
}

function freezeSummary(summary: MutableSummary): StrategyReplaySanityResult {
  return {
    strategy_id: summary.strategy_id,
    bars_evaluated: summary.bars_evaluated,
    evaluations_emitted: summary.evaluations_emitted,
    errors: [...summary.errors],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
