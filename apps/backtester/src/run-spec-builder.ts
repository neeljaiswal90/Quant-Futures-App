import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  computeManifestHash,
  type CorpusInputRef,
  type NamedConfigLineageRef,
  type RunIdentity,
  type RunSpec,
} from '../../strategy_runtime/src/contracts/index.js';
import { loadCorpusManifest } from '../../strategy_runtime/src/config/corpus-manifest-loader.js';
import { deriveRunId } from '../../strategy_runtime/src/contracts/run-id.js';
import { validateRunSpec } from '../../strategy_runtime/src/contracts/run-spec-validate.js';
import { classifyCorpusTier, type DatabentoSchema } from '../../strategy_runtime/src/contracts/tier-policy.js';
import { makeConfigHash } from '../../strategy_runtime/src/contracts/ids.js';
import type { CorpusManifest } from '../../strategy_runtime/src/contracts/corpus-manifest.js';
import { parseStrategyId, type StrategyId } from '../../strategy_runtime/src/contracts/strategy-ids.js';
import type { BacktestRunnerOptions } from './types.js';

export interface BacktestDbnInputSource {
  readonly session_id: string;
  readonly schema: DatabentoSchema;
  readonly dbn_path: string;
}

export interface BuiltBacktestRunSpec {
  readonly manifest: CorpusManifest;
  readonly manifest_hash: string;
  readonly run_spec: RunSpec;
  readonly identity: RunIdentity;
  readonly strategy_id: StrategyId;
  readonly input_schemas: readonly DatabentoSchema[];
  readonly input_sources: readonly BacktestDbnInputSource[];
  readonly manifest_symbol: string;
}

const STRATEGY_CONFIG_PATHS: Readonly<Record<StrategyId, string>> = Object.freeze({
  trend_pullback_long: 'config/strategies/trend_pullback_long.yaml',
  trend_pullback_short: 'config/strategies/trend_pullback_short.yaml',
  breakout_retest_long: 'config/strategies/breakout_retest_long.yaml',
  breakdown_retest_short: 'config/strategies/breakdown_retest_short.yaml',
  regime_mean_reversion_long: 'config/strategies/regime_mean_reversion_long.yaml',
  regime_mean_reversion_short: 'config/strategies/regime_mean_reversion_short.yaml',
  liquidity_sweep_reversal_long: 'config/strategies/liquidity_sweep_reversal_long.yaml',
  liquidity_sweep_reversal_short: 'config/strategies/liquidity_sweep_reversal_short.yaml',
  vwap_overnight_reversal_long: 'config/strategies/vwap_overnight_reversal_long.yaml',
  vwap_overnight_reversal_short: 'config/strategies/vwap_overnight_reversal_short.yaml',
  regime_shock_reversion_short_v2: 'config/strategies/regime_shock_reversion_short_v2.yaml',
});

const RECOGNIZED_SCHEMAS: ReadonlySet<string> = new Set([
  'mbo',
  'mbp-10',
  'mbp-1',
  'trades',
  'tbbo',
  'bbo',
  'ohlcv-1m',
  'definition',
  'statistics',
  'status',
]);

export function buildRunSpecFromOptions(options: BacktestRunnerOptions): BuiltBacktestRunSpec {
  const strategyId = parseStrategyId(options.strategy_id);
  const manifest = loadCorpusManifest(options.corpus_manifest_path);
  const manifestHash = computeManifestHash(manifest);
  const tier = classifyCorpusTier(manifest);
  const inputSchemas = resolveInputSchemas(manifest, options.input_schemas);
  const inputSources = resolveInputSources(options.corpus_manifest_path, manifest, inputSchemas);
  const configInputs = buildConfigInputs(options.repo_root ?? process.cwd(), strategyId);
  const corpusInput: CorpusInputRef = {
    role: 'primary',
    manifest_hash: manifestHash,
    manifest_schema_version: manifest.manifest_schema_version,
    verification_report_hash: null,
    verification_status: 'not_run',
    tier: tier.effectiveTier,
    tier_classification: {
      classification_reason: tier.classification_reason,
      policy_source: 'runner_code',
      policy_ref: null,
    },
  };

  const runSpec: RunSpec = {
    run_spec_schema_version: 1,
    instrument_root: 'MNQ',
    bar_spec: options.bar_spec,
    backtest_window: options.backtest_window,
    determinism_seed: options.determinism_seed,
    strategy_ids: [strategyId],
    corpus_inputs: [corpusInput],
    config_inputs: configInputs,
    runner_code_commit_sha: options.runner_code_commit_sha,
    runner_code_dirty: options.runner_code_dirty,
  };

  validateRunSpec(runSpec);
  const identity = deriveRunId(runSpec);
  return Object.freeze({
    manifest,
    manifest_hash: manifestHash,
    run_spec: runSpec,
    identity,
    strategy_id: strategyId,
    input_schemas: Object.freeze([...inputSchemas]),
    input_sources: Object.freeze([...inputSources]),
    manifest_symbol: selectManifestSymbol(manifest),
  });
}

function resolveInputSchemas(
  manifest: CorpusManifest,
  requested: readonly DatabentoSchema[] | undefined,
): readonly DatabentoSchema[] {
  if (requested !== undefined) {
    if (requested.length === 0) {
      throw new Error('input_schemas must not be empty when provided');
    }
    return Object.freeze([...new Set(requested)]);
  }

  const available = new Set<string>();
  for (const session of manifest.sessions) {
    for (const schema of Object.keys(session.schemas)) {
      available.add(schema);
    }
  }

  if (available.has('trades')) return Object.freeze(['trades'] as const);
  if (available.has('ohlcv-1m')) return Object.freeze(['ohlcv-1m'] as const);
  throw new Error('manifest does not contain a default bar-builder input schema (trades or ohlcv-1m)');
}

function resolveInputSources(
  manifestPath: string,
  manifest: CorpusManifest,
  schemas: readonly DatabentoSchema[],
): readonly BacktestDbnInputSource[] {
  const manifestDir = dirname(resolve(manifestPath));
  const selected = new Set(schemas);
  const sources: BacktestDbnInputSource[] = [];

  for (const session of [...manifest.sessions].sort((left, right) => left.session_id.localeCompare(right.session_id))) {
    if (session.status !== 'complete') continue;
    for (const schema of schemas) {
      if (!selected.has(schema)) continue;
      const schemaFile = session.schemas[schema];
      if (schemaFile === undefined || schemaFile.status !== 'available') continue;
      sources.push({
        session_id: session.session_id,
        schema,
        dbn_path: resolveManifestDbnPath(manifestDir, schemaFile.path),
      });
    }
  }

  if (sources.length === 0) {
    throw new Error(`manifest has no available complete-session DBN files for schemas: ${schemas.join(', ')}`);
  }
  return Object.freeze(sources);
}

function selectManifestSymbol(manifest: CorpusManifest): string {
  const complete = manifest.sessions.find((session) => session.status === 'complete');
  return complete?.symbol ?? manifest.symbol;
}

function resolveManifestDbnPath(manifestDir: string, dbnPath: string): string {
  return isAbsolute(dbnPath) || /^[A-Za-z]:[\\/]/u.test(dbnPath) ? dbnPath : resolve(manifestDir, dbnPath);
}

function buildConfigInputs(repoRoot: string, strategyId: StrategyId): readonly NamedConfigLineageRef[] {
  return Object.freeze([
    configInput(repoRoot, 'strategy', STRATEGY_CONFIG_PATHS[strategyId]),
    configInput(repoRoot, 'strategy_shared', 'config/strategies/shared.yaml'),
    configInput(repoRoot, 'risk', 'config/risk/risk-policy.yaml'),
    configInput(repoRoot, 'management', 'config/management/profiles.yaml'),
  ]);
}

function configInput(
  repoRoot: string,
  role: NamedConfigLineageRef['role'],
  configPath: string,
): NamedConfigLineageRef {
  return {
    role,
    config_path: configPath,
    lineage: {
      config_hash: makeConfigHash(hashFile(resolve(repoRoot, configPath))),
      config_version: 1,
    },
  };
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function assertRecognizedDatabentoSchema(schema: string): asserts schema is DatabentoSchema {
  if (!RECOGNIZED_SCHEMAS.has(schema)) {
    throw new Error(`unrecognized Databento schema in manifest: ${schema}`);
  }
}
