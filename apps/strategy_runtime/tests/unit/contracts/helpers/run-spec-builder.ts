// Test helper: construct minimal valid RunSpec values for QFA-115 tests.
// Mirror of `tests/fixtures/run-spec/minimal-runspec.input.json`.

import type { StrategyId } from '../../../../src/contracts/strategy-ids.js';
import type {
  BacktestWindow,
  ConfigInputRole,
  CorpusDataTier,
  CorpusInputRef,
  CorpusInputRole,
  CorpusTierClassificationRef,
  CorpusTierPolicySource,
  CorpusVerificationStatus,
  NamedConfigLineageRef,
  RunSpec,
} from '../../../../src/contracts/run-spec.js';

/** A baseline RunSpec matching the committed minimal fixture. Accepts
 * Partial<RunSpec> overrides for tests that vary specific fields. */
export function buildMinimalRunSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    run_spec_schema_version: 1,
    instrument_root: 'MNQ',
    bar_spec: '1m',
    backtest_window: buildBacktestWindow(),
    determinism_seed: 42,
    strategy_ids: ['trend_pullback_long'] as readonly StrategyId[],
    corpus_inputs: [buildCorpusInput()],
    config_inputs: [buildConfigInput()],
    runner_code_commit_sha: '0123456789abcdef0123456789abcdef01234567',
    runner_code_dirty: false,
    ...overrides,
  };
}

/** Build a typical session-mode backtest window. */
export function buildBacktestWindow(overrides: Partial<BacktestWindow> = {}): BacktestWindow {
  return {
    start: '2026-02-02',
    end: '2026-02-06',
    mode: 'session',
    inclusive_end: true,
    calendar: 'CME_US_INDEX_FUTURES',
    ...overrides,
  };
}

/** Build a single Tier A primary corpus input. */
export function buildCorpusInput(overrides: Partial<CorpusInputRef> = {}): CorpusInputRef {
  const role: CorpusInputRole = overrides.role ?? 'primary';
  const tier: CorpusDataTier = overrides.tier ?? 'A';
  return {
    role,
    manifest_hash: 'ba24ce7ab4fdd964a97e960eab0d8e89b5298f2bb4986d8afc332c5682d58dbe',
    manifest_schema_version: 1,
    verification_report_hash:
      '2fb89dcd871a4c4bb2bee335bf415be72a4a91a2ce8b35def89d504d1e87205c',
    verification_status: 'passed' as CorpusVerificationStatus,
    tier,
    tier_classification: buildTierClassification(),
    ...overrides,
  };
}

/** Build a runner-classified tier_classification. */
export function buildTierClassification(
  overrides: Partial<CorpusTierClassificationRef> = {},
): CorpusTierClassificationRef {
  const policy_source: CorpusTierPolicySource = overrides.policy_source ?? 'runner_code';
  return {
    classification_reason: 'Tier A: required schemas mbo, mbp-10 all present',
    policy_source,
    policy_ref: policy_source === 'runner_code' ? null : null,
    ...overrides,
  };
}

/** Build a single strategy-role config input. */
export function buildConfigInput(overrides: Partial<NamedConfigLineageRef> = {}): NamedConfigLineageRef {
  const role: ConfigInputRole = overrides.role ?? 'strategy';
  return {
    role,
    config_path: 'config/strategies/trend_pullback_long.yaml',
    lineage: {
      // Branded ConfigHash; the type-checker accepts hex strings via lineage.ts contract.
      config_hash:
        'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' as RunSpec['config_inputs'][number]['lineage']['config_hash'],
      config_version: 1,
    },
    ...overrides,
  };
}
