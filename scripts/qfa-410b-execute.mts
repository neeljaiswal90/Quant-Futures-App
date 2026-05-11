#!/usr/bin/env tsx
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTIVE_STRATEGY_IDS,
  parseStrategyId,
  type StrategyId,
} from '../apps/strategy_runtime/src/contracts/strategy-ids.js';
import { getActiveStrategyGenerator } from '../apps/strategy_runtime/src/strategies/registry.js';
import {
  executeHeldOutValidationAgainstArchive,
  type HeldOutValidationArtifactMetadata,
  type HeldOutValidationRealArchiveOptions,
} from '../apps/backtester/src/held-out-validation/index.js';
import type { RealArchiveSessionSource } from '../apps/backtester/src/real-archive-execution/index.js';
import {
  buildWalkForwardPlan,
  QFA611_DEFAULT_WALK_FORWARD_POLICY,
  type WalkForwardPlan,
  type WalkForwardPolicy,
} from '../apps/backtester/src/walk-forward/index.js';
import { canonicalizeReproJson } from '../apps/backtester/src/repro-hash/index.js';

const DEFAULT_MANIFESTS = [
  'config/research/manifests/manifest-feb-2026.json',
  'config/research/manifests/manifest-mar-2026.json',
  'config/research/manifests/manifest-apr-2026.json',
];
const DEFAULT_OUTPUT_DIR = 'artifacts/held-out-validation';
const DEFAULT_REGIME_LABELS = 'artifacts/regime/regime-labels.json';
const DEFAULT_INITIAL_EQUITY_CENTS = 5_000_000n;
const PARAMETER_LOCK_SOURCE = 'existing-roster-locked-as-of-qfa611-cycle1';

interface CliArgs {
  readonly archiveRoot?: string;
  readonly manifests: readonly string[];
  readonly outputDir: string;
  readonly strategyIds: readonly StrategyId[];
  readonly initialEquityCents: bigint;
  readonly runId: string;
  readonly walkForwardPolicyPath?: string;
  readonly metadataByStrategyPath?: string;
  readonly regimeLabelsPath: string;
}

interface ManifestSession {
  readonly session_id: string;
  readonly status: string;
  readonly symbol?: string;
  readonly raw_symbol?: string;
  readonly trading_date?: string;
  readonly rth_window?: {
    readonly start_ts_ns?: string;
    readonly end_ts_ns?: string;
  };
  readonly schemas?: Record<string, {
    readonly path?: string;
    readonly status?: string;
  }>;
}

interface CorpusManifest {
  readonly sessions?: readonly ManifestSession[];
}

interface RegimeLabelsArtifact {
  readonly labels?: readonly {
    readonly session_id: string;
    readonly confirmed_label?: string;
    readonly regime_label?: string;
  }[];
}

interface LockManifest {
  readonly strategies?: readonly {
    readonly strategy_id?: string;
    readonly parameter_lock_hash?: string;
  }[];
}

interface ExecuteDependencies {
  readonly execute?: typeof executeHeldOutValidationAgainstArchive;
  readonly archiveSessions?: readonly RealArchiveSessionSource[];
  readonly manifests?: readonly CorpusManifest[];
}

interface RunSummary {
  readonly run_id: string;
  readonly strategy_ids: readonly StrategyId[];
  readonly artifact_paths: readonly string[];
  readonly per_strategy: readonly {
    readonly strategy_id: StrategyId;
    readonly total_trades: number;
    readonly executed_windows: number;
    readonly failed_windows: number;
  }[];
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) {
      throw new Error(`unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    const list = values.get(key) ?? [];
    index += 1;
    while (index < argv.length && !argv[index]!.startsWith('--')) {
      list.push(argv[index]!);
      index += 1;
    }
    index -= 1;
    values.set(key, list);
  }

  const runId = one(values, 'run-id');
  if (runId === undefined || runId.trim() === '') {
    throw new Error('--run-id is required');
  }
  const strategyIds = many(values, 'strategy-ids')
    .map((value) => parseStrategyId(value));
  return {
    archiveRoot: one(values, 'archive-root'),
    manifests: many(values, 'manifests', DEFAULT_MANIFESTS),
    outputDir: one(values, 'output-dir') ?? DEFAULT_OUTPUT_DIR,
    strategyIds: strategyIds.length === 0 ? ACTIVE_STRATEGY_IDS : strategyIds,
    initialEquityCents: BigInt(one(values, 'initial-equity-cents') ?? DEFAULT_INITIAL_EQUITY_CENTS.toString()),
    runId,
    walkForwardPolicyPath: one(values, 'walk-forward-policy'),
    metadataByStrategyPath: one(values, 'metadata-by-strategy'),
    regimeLabelsPath: one(values, 'regime-labels') ?? DEFAULT_REGIME_LABELS,
  };
}

export async function runQfa410bExecute(
  args: CliArgs,
  dependencies: ExecuteDependencies = {},
): Promise<RunSummary> {
  await mkdir(args.outputDir, { recursive: true });
  const manifests = dependencies.manifests ?? args.manifests.map((path) => readJson<CorpusManifest>(path));
  const manifestHashes = inputManifestHashes(args.manifests);
  const sessions = dependencies.archiveSessions ?? archiveSessionsFromManifests({
    archiveRoot: args.archiveRoot,
    manifests,
    regimeBySession: loadRegimeLabels(args.regimeLabelsPath),
  });
  const sessionOrder = sessions.map((session) => session.session_id).sort();
  const policy = loadWalkForwardPolicy(args.walkForwardPolicyPath);
  const walkForwardPlan = buildWalkForwardPlan(sessionOrder, policy);
  const metadataByStrategy = loadMetadataByStrategy(args, manifestHashes);
  const execute = dependencies.execute ?? executeHeldOutValidationAgainstArchive;
  const artifactPaths: string[] = [];
  const perStrategy: RunSummary['per_strategy'][number][] = [];

  for (const strategyId of args.strategyIds) {
    try {
      const result = await execute({
        run_id: args.runId,
        input_spec: {
          spec_schema_version: 1,
          data_mode: 'tier_b_projection_from_tier_a',
          required_schemas: ['mbp-1', 'trades'],
          corpus_manifest_hashes: args.manifests.map((path) => sha256File(path)),
          fidelity_status: 'passed',
        },
        walk_forward_plan: walkForwardPlan,
        strategy_order: [strategyId],
        archive_sessions: sessions,
        run_started_at_ns: deterministicRunStartedAtNs(args.runId),
        initial_equity_cents: args.initialEquityCents,
        strategy_generators: { [strategyId]: getActiveStrategyGenerator(strategyId) },
        artifact_output: {
          output_dir: args.outputDir,
          metadata_by_strategy: { [strategyId]: metadataByStrategy[strategyId] },
        },
      } satisfies HeldOutValidationRealArchiveOptions);
      artifactPaths.push(...(result.artifact_paths ?? []));
      const strategy = result.per_strategy_real_records[0];
      perStrategy.push({
        strategy_id: strategyId,
        total_trades: strategy?.total_trades ?? 0,
        executed_windows: strategy?.windows.filter((window) => window.status === 'executed').length ?? 0,
        failed_windows: strategy?.windows.filter((window) => window.status === 'failed').length ?? 0,
      });
    } catch (error) {
      const path = join(args.outputDir, `${strategyId}-feb-mar-apr-2026.json`);
      writePartialEvidenceStub(path, strategyId, metadataByStrategy[strategyId], error);
      artifactPaths.push(path);
      perStrategy.push({
        strategy_id: strategyId,
        total_trades: 0,
        executed_windows: 0,
        failed_windows: 1,
      });
    }
  }

  return {
    run_id: args.runId,
    strategy_ids: args.strategyIds,
    artifact_paths: artifactPaths,
    per_strategy: perStrategy,
  };
}

export function archiveSessionsFromManifests(input: {
  readonly archiveRoot?: string;
  readonly manifests: readonly CorpusManifest[];
  readonly regimeBySession: ReadonlyMap<string, string>;
}): readonly RealArchiveSessionSource[] {
  const bySession = new Map<string, RealArchiveSessionSource>();
  for (const manifest of input.manifests) {
    for (const session of manifest.sessions ?? []) {
      if (session.status !== 'complete') continue;
      const trades = session.schemas?.trades;
      const mbp1 = session.schemas?.['mbp-1'];
      if (trades?.status !== 'available' || mbp1?.status !== 'available') continue;
      const tradesPath = resolveArchivePath(input.archiveRoot, session.session_id, trades.path);
      const mbp1Path = resolveArchivePath(input.archiveRoot, session.session_id, mbp1.path);
      if (tradesPath === undefined || mbp1Path === undefined) continue;
      bySession.set(session.session_id, {
        session_id: session.session_id,
        trading_date: session.trading_date ?? session.session_id.replace(/-rth$/, ''),
        raw_symbol: session.raw_symbol ?? session.symbol ?? 'MNQ',
        regime_label: knownRegime(input.regimeBySession.get(session.session_id)),
        rth_start_ts_ns: session.rth_window?.start_ts_ns,
        rth_end_ts_ns: session.rth_window?.end_ts_ns,
        trades_path: tradesPath,
        mbp1_path: mbp1Path,
      });
    }
  }
  return Object.freeze([...bySession.values()].sort((left, right) => left.session_id.localeCompare(right.session_id)));
}

export function deterministicRunStartedAtNs(runId: string): bigint {
  const digest = createHash('sha256').update(runId, 'utf8').digest('hex').slice(0, 15);
  return BigInt(`0x${digest}`);
}

function loadWalkForwardPolicy(path: string | undefined): WalkForwardPolicy {
  if (path === undefined) {
    return QFA611_DEFAULT_WALK_FORWARD_POLICY;
  }
  return readJson<WalkForwardPolicy>(path);
}

function loadMetadataByStrategy(
  args: CliArgs,
  manifestHashes: HeldOutValidationArtifactMetadata['input_manifest_hashes'],
): Record<StrategyId, HeldOutValidationArtifactMetadata> {
  if (args.metadataByStrategyPath !== undefined) {
    return readJson<Record<StrategyId, HeldOutValidationArtifactMetadata>>(args.metadataByStrategyPath);
  }
  const lockManifest = readJson<LockManifest>('artifacts/strategy-selection/qfa611-cycle1-parameter-locks.json');
  const locks = new Map<string, string>();
  for (const strategy of lockManifest.strategies ?? []) {
    if (strategy.strategy_id !== undefined && strategy.parameter_lock_hash !== undefined) {
      locks.set(strategy.strategy_id, strategy.parameter_lock_hash);
    }
  }
  const inputSubstrateHash = sha256File(args.regimeLabelsPath);
  return Object.fromEntries(args.strategyIds.map((strategyId) => {
    const parameterLockHash = locks.get(strategyId);
    if (parameterLockHash === undefined) {
      throw new Error(`missing lock manifest entry for ${strategyId}`);
    }
    return [strategyId, {
      strategy_family: 'continuation',
      parameter_lock_source: PARAMETER_LOCK_SOURCE,
      parameter_lock_hash: parameterLockHash,
      input_substrate_hash: inputSubstrateHash,
      input_manifest_hashes: manifestHashes,
    } satisfies HeldOutValidationArtifactMetadata];
  })) as Record<StrategyId, HeldOutValidationArtifactMetadata>;
}

function inputManifestHashes(paths: readonly string[]): HeldOutValidationArtifactMetadata['input_manifest_hashes'] {
  const [feb, mar, apr] = paths.map((path) => sha256File(path));
  if (feb === undefined || mar === undefined || apr === undefined) {
    throw new Error('--manifests must provide feb, mar, and apr paths');
  }
  return { feb, mar, apr };
}

function loadRegimeLabels(path: string): ReadonlyMap<string, string> {
  if (!existsSync(path)) {
    return new Map();
  }
  const artifact = readJson<RegimeLabelsArtifact>(path);
  return new Map((artifact.labels ?? []).map((session) => [
    session.session_id,
    session.confirmed_label ?? session.regime_label ?? 'unknown',
  ]));
}

function writePartialEvidenceStub(
  path: string,
  strategyId: StrategyId,
  metadata: HeldOutValidationArtifactMetadata,
  error: unknown,
): void {
  const payload = {
    schema_version: 1,
    methodology_id: 'qfa-410-v1',
    strategy_id: strategyId,
    strategy_family: metadata.strategy_family,
    strategy_fingerprint_sha256: null,
    parameter_lock_source: metadata.parameter_lock_source,
    parameter_lock_hash: metadata.parameter_lock_hash,
    capability_status: 'blocked',
    evidence_package_status: 'incomplete',
    failure_reason: error instanceof Error ? error.message : String(error),
    gating_pnl_basis: 'net',
    input_substrate_hash: metadata.input_substrate_hash,
    input_manifest_hashes: metadata.input_manifest_hashes,
  };
  writeFileSync(path, `${canonicalizeReproJson(payload)}\n`, 'utf8');
}

function knownRegime(value: string | undefined): RealArchiveSessionSource['regime_label'] {
  return value === 'high' || value === 'mid' || value === 'low' ? value : 'unknown';
}

function resolveArchivePath(
  archiveRoot: string | undefined,
  sessionId: string,
  manifestPath: string | undefined,
): string | undefined {
  if (manifestPath === undefined) {
    return undefined;
  }
  if (archiveRoot === undefined) {
    return manifestPath;
  }
  const sessionDir = basename(dirname(manifestPath)) || sessionId;
  return join(archiveRoot, sessionDir, basename(manifestPath));
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function one(values: ReadonlyMap<string, readonly string[]>, key: string): string | undefined {
  const items = values.get(key);
  if (items === undefined || items.length === 0) {
    return undefined;
  }
  if (items.length > 1) {
    throw new Error(`--${key} accepts one value`);
  }
  return items[0];
}

function many(
  values: ReadonlyMap<string, readonly string[]>,
  key: string,
  fallback: readonly string[] = [],
): readonly string[] {
  return values.get(key) ?? fallback;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const summary = await runQfa410bExecute(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
}
