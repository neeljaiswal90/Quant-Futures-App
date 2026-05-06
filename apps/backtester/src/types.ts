import type { BacktestWindow } from '../../strategy_runtime/src/contracts/run-spec.js';
import type { StrategyId } from '../../strategy_runtime/src/contracts/strategy-ids.js';
import type { UnixNsInput } from '../../strategy_runtime/src/contracts/time.js';
import type { DatabentoSchema } from '../../strategy_runtime/src/contracts/tier-policy.js';

export interface BacktestRunnerOptions {
  readonly corpus_manifest_path: string;
  readonly strategy_id: StrategyId | string;
  readonly bar_spec: string;
  readonly backtest_window: BacktestWindow;
  readonly determinism_seed: number;
  readonly output_dir: string;
  readonly run_started_at_ns: UnixNsInput;
  readonly runner_code_commit_sha: string;
  readonly runner_code_dirty: boolean;
  readonly session_id?: string;
  readonly input_schemas?: readonly DatabentoSchema[];
  readonly cache_root?: string;
  readonly force_rebuild_cache?: boolean;
  readonly repo_root?: string;
}

export interface BacktestRunResult {
  readonly run_id: string;
  readonly run_spec_hash: string;
  readonly journal_path: string;
  readonly event_count: number;
}
