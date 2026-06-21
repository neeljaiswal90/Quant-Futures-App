import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  assertHeldOutAccessAllowed,
  buildDataSplitSpine,
  writeDataSplitSpine,
} from './data-split-spine.js';
import {
  selectInLoopSurvivors,
  writeInLoopSelectionArtifacts,
} from './in-loop-survivor-selection.js';
import {
  buildNestedValidationManifest,
  writeNestedValidationManifest,
} from './nested-validation.js';

const DEFAULT_SPEC = 'config/strategy-gen/regime_shock_reversion_short_v2.search.yaml';
const DEFAULT_MANIFESTS = [
  'config/research/manifests/manifest-feb-2026.json',
  'config/research/manifests/manifest-mar-2026.json',
  'config/research/manifests/manifest-apr-2026.json',
];
const DEFAULT_REGIME_LABELS = 'artifacts/regime/regime-labels.json';
const DEFAULT_STRATEGY_CONFIG_DIR = 'config/strategies';
const STRATEGY_GENERATION_ROOT = 'artifacts/strategy-generation';

interface CliArgs {
  readonly spec: string;
  readonly manifests: readonly string[];
  readonly archiveRoot?: string;
  readonly regimeLabels: string;
  readonly strategyConfigDir: string;
  readonly initialEquityCents?: string;
  readonly skipHeldOut: boolean;
  readonly skipSelection: boolean;
  readonly allowHeldOutGate: boolean;
  readonly inLoopScoreInput?: string;
  readonly survivorCount?: number;
  readonly nestedValidationFolds: number;
}

interface CandidateManifest {
  readonly generation_run_id: string;
  readonly base_family: string;
  readonly candidates: readonly {
    readonly candidate_strategy_id: string;
    readonly parameter_lock_hash: string;
    readonly search_space_hash: string;
    readonly corpus_fingerprint: string;
  }[];
}

interface LockManifest {
  readonly strategies?: readonly {
    readonly strategy_id?: string;
    readonly parameter_lock_hash?: string;
  }[];
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const generationRunId = readTopLevelSpecScalar(args.spec, 'generation_run_id');
  const generationRoot = join(STRATEGY_GENERATION_ROOT, generationRunId);
  const candidateManifestPath = join(generationRoot, 'candidate-manifest.json');
  const trialAccountingManifestPath = join(generationRoot, 'trial-accounting-manifest.json');
  const parameterLockManifestPath = join(generationRoot, 'parameter-locks.json');
  const metadataByStrategyPath = join(generationRoot, 'held-out-metadata-by-strategy.json');
  const dataSplitSpinePath = join(generationRoot, 'data-split-spine.json');
  const nestedValidationManifestPath = join(generationRoot, 'nested-validation-manifest.json');
  const inLoopScoreLedgerPath = join(generationRoot, 'in-loop-scores.json');
  const survivorManifestPath = join(generationRoot, 'survivor-manifest.json');
  const heldOutDir = join('artifacts/held-out-validation', generationRunId);
  const selectionJsonOut = join(generationRoot, 'strategy-selection.json');
  const selectionMdOut = join(generationRoot, 'strategy-selection.md');

  runOrThrow(npxCommand(), ['tsx', 'scripts/strategy-gen/emit-tier1-candidates.ts', '--spec', args.spec]);

  const candidateManifest = readJson<CandidateManifest>(candidateManifestPath);
  const candidateIds = candidateManifest.candidates.map((candidate) => candidate.candidate_strategy_id);
  if (candidateIds.length === 0) {
    throw new Error(`candidate manifest emitted no candidates: ${candidateManifestPath}`);
  }

  runOrThrow(pythonCommand(), [
    'scripts/strategy-selection/qfa-611-emit-lock-manifest.py',
    '--cycle-id',
    generationRunId,
    '--strategy-config-dir',
    args.strategyConfigDir,
    '--strategy-ids',
    ...candidateIds,
    '--out',
    parameterLockManifestPath,
  ]);

  writeHeldOutMetadataByStrategy({
    candidateManifest,
    lockManifest: readJson<LockManifest>(parameterLockManifestPath),
    manifestPaths: args.manifests,
    outputPath: metadataByStrategyPath,
    regimeLabelsPath: args.regimeLabels,
  });
  const dataSplitSpine = buildDataSplitSpine({
    generationRunId,
    searchSpecPath: args.spec,
    manifestPaths: args.manifests,
    heldOutDir,
  });
  writeDataSplitSpine(dataSplitSpinePath, dataSplitSpine);
  const nestedValidationManifest = buildNestedValidationManifest({
    spine: dataSplitSpine,
    foldCount: args.nestedValidationFolds,
  });
  writeNestedValidationManifest(nestedValidationManifestPath, nestedValidationManifest);
  const gateRequiresSurvivors = !args.skipHeldOut || !args.skipSelection;
  const survivorCandidateIds = args.inLoopScoreInput === undefined
    ? candidateIds
    : selectAndWriteSurvivors({
      generationRunId,
      candidateIds,
      inLoopScoreInput: args.inLoopScoreInput,
      survivorCount: args.survivorCount,
      minValidationFoldScoreCount: nestedValidationManifest.fold_count,
      inLoopScoreLedgerPath,
      survivorManifestPath,
      trialAccountingManifestPath,
    });
  if (gateRequiresSurvivors && args.inLoopScoreInput === undefined) {
    throw new Error('held-out gate requires --in-loop-score-input so only TRAIN/VALIDATION-scored survivors reach QFA-410B/QFA-611');
  }

  if (!args.skipHeldOut) {
    assertHeldOutAccessAllowed({
      purpose: 'qfa410b_held_out_replay',
      allowHeldOutGate: args.allowHeldOutGate,
    });
    const qfa410bArgs = [
      'tsx',
      'scripts/qfa-410b-execute.mts',
      '--run-id',
      generationRunId,
      '--strategy-config-dir',
      args.strategyConfigDir,
      '--regime-labels',
      args.regimeLabels,
      '--metadata-by-strategy',
      metadataByStrategyPath,
      '--output-dir',
      heldOutDir,
      '--manifests',
      ...args.manifests,
      '--strategy-ids',
      ...survivorCandidateIds,
    ];
    if (args.archiveRoot !== undefined) {
      qfa410bArgs.push('--archive-root', args.archiveRoot);
    }
    if (args.initialEquityCents !== undefined) {
      qfa410bArgs.push('--initial-equity-cents', args.initialEquityCents);
    }
    runOrThrow(npxCommand(), qfa410bArgs);
  }

  if (!args.skipSelection) {
    assertHeldOutAccessAllowed({
      purpose: 'qfa611_gate',
      allowHeldOutGate: args.allowHeldOutGate,
    });
    runOrThrow(pythonCommand(), [
      'scripts/strategy-selection/qfa-611-strategy-selection.py',
      '--held-out-dir',
      heldOutDir,
      '--regime-labels',
      args.regimeLabels,
      '--lock-manifest',
      parameterLockManifestPath,
      '--trial-accounting-manifest',
      trialAccountingManifestPath,
      '--strategy-config-dir',
      args.strategyConfigDir,
      '--strategy-ids',
      ...survivorCandidateIds,
      '--json-out',
      selectionJsonOut,
      '--md-out',
      selectionMdOut,
    ]);
  }

  console.log(JSON.stringify({
    generation_run_id: generationRunId,
    candidate_count: candidateIds.length,
    survivor_count: survivorCandidateIds.length,
    candidate_manifest: candidateManifestPath,
    trial_accounting_manifest: trialAccountingManifestPath,
    parameter_lock_manifest: parameterLockManifestPath,
    data_split_spine: dataSplitSpinePath,
    nested_validation_manifest: nestedValidationManifestPath,
    in_loop_scores: args.inLoopScoreInput === undefined ? null : inLoopScoreLedgerPath,
    survivor_manifest: args.inLoopScoreInput === undefined ? null : survivorManifestPath,
    held_out_metadata_by_strategy: metadataByStrategyPath,
    held_out_dir: heldOutDir,
    strategy_selection_json: args.skipSelection ? null : selectionJsonOut,
    strategy_selection_md: args.skipSelection ? null : selectionMdOut,
  }, null, 2));
  return 0;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) {
      throw new Error(`unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    const items = values.get(key) ?? [];
    index += 1;
    while (index < argv.length && !argv[index]!.startsWith('--')) {
      items.push(argv[index]!);
      index += 1;
    }
    index -= 1;
    values.set(key, items);
  }
  const emitOnly = values.has('emit-only');
  return {
    spec: one(values, 'spec') ?? DEFAULT_SPEC,
    manifests: many(values, 'manifests', DEFAULT_MANIFESTS),
    archiveRoot: one(values, 'archive-root'),
    regimeLabels: one(values, 'regime-labels') ?? DEFAULT_REGIME_LABELS,
    strategyConfigDir: one(values, 'strategy-config-dir') ?? DEFAULT_STRATEGY_CONFIG_DIR,
    initialEquityCents: one(values, 'initial-equity-cents'),
    skipHeldOut: emitOnly || values.has('skip-held-out'),
    skipSelection: emitOnly || values.has('skip-selection'),
    allowHeldOutGate: values.has('allow-held-out-gate'),
    inLoopScoreInput: one(values, 'in-loop-score-input'),
    survivorCount: optionalPositiveInt(one(values, 'survivor-count'), '--survivor-count'),
    nestedValidationFolds: optionalPositiveInt(one(values, 'nested-validation-folds'), '--nested-validation-folds') ?? 3,
  };
}

function selectAndWriteSurvivors(input: {
  readonly generationRunId: string;
  readonly candidateIds: readonly string[];
  readonly inLoopScoreInput: string;
  readonly survivorCount?: number;
  readonly minValidationFoldScoreCount: number;
  readonly inLoopScoreLedgerPath: string;
  readonly survivorManifestPath: string;
  readonly trialAccountingManifestPath: string;
}): readonly string[] {
  const result = selectInLoopSurvivors({
    generationRunId: input.generationRunId,
    candidateIds: input.candidateIds,
    scoreInputPath: input.inLoopScoreInput,
    survivorCount: input.survivorCount,
    minValidationFoldScoreCount: input.minValidationFoldScoreCount,
  });
  writeInLoopSelectionArtifacts({
    scoreLedgerPath: input.inLoopScoreLedgerPath,
    survivorManifestPath: input.survivorManifestPath,
    result,
  });
  rewriteTrialAccountingForSurvivors(
    input.trialAccountingManifestPath,
    result.survivorCandidateIds,
  );
  return result.survivorCandidateIds;
}

function writeHeldOutMetadataByStrategy(input: {
  readonly candidateManifest: CandidateManifest;
  readonly lockManifest: LockManifest;
  readonly manifestPaths: readonly string[];
  readonly outputPath: string;
  readonly regimeLabelsPath: string;
}): void {
  const locks = new Map<string, string>();
  for (const strategy of input.lockManifest.strategies ?? []) {
    if (strategy.strategy_id !== undefined && strategy.parameter_lock_hash !== undefined) {
      locks.set(strategy.strategy_id, strategy.parameter_lock_hash);
    }
  }
  const metadata = Object.fromEntries(input.candidateManifest.candidates.map((candidate) => {
    const parameterLockHash = locks.get(candidate.candidate_strategy_id);
    if (parameterLockHash === undefined) {
      throw new Error(`missing parameter lock for generated candidate ${candidate.candidate_strategy_id}`);
    }
    return [candidate.candidate_strategy_id, {
      strategy_family: heldOutStrategyFamily(input.candidateManifest.base_family),
      parameter_lock_source: `strategy-gen:${input.candidateManifest.generation_run_id}`,
      parameter_lock_hash: parameterLockHash,
      input_substrate_hash: substrateHash(input.regimeLabelsPath, candidate.search_space_hash),
      input_manifest_hashes: inputManifestHashes(input.manifestPaths),
    }];
  }));
  writeJson(input.outputPath, metadata);
}

function inputManifestHashes(paths: readonly string[]) {
  const [feb, mar, apr] = paths.map((path) => sha256File(path));
  if (feb === undefined || mar === undefined || apr === undefined) {
    throw new Error('--manifests must provide exactly the Feb/Mar/Apr manifest spine expected by QFA-410B');
  }
  return { feb, mar, apr };
}

function heldOutStrategyFamily(value: string): 'continuation' | 'mean_reversion' | 'reversal' {
  const normalized = value.toLowerCase();
  if (normalized.includes('reversion') || normalized.includes('fade')) {
    return 'mean_reversion';
  }
  if (normalized.includes('reversal')) {
    return 'reversal';
  }
  return 'continuation';
}

function substrateHash(regimeLabelsPath: string, fallbackSeed: string): string {
  if (existsSync(regimeLabelsPath)) {
    return sha256File(regimeLabelsPath);
  }
  return sha256Text(`missing-regime-labels:${regimeLabelsPath}:${fallbackSeed}`);
}

function readTopLevelSpecScalar(path: string, key: string): string {
  const pattern = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm');
  const match = pattern.exec(readFileSync(path, 'utf8'));
  if (match === null) {
    throw new Error(`${path} missing top-level scalar ${key}`);
  }
  return unquote(match[1]!.trim());
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function runOrThrow(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    // Node >=20 rejects spawning .cmd/.bat shims (npx.cmd, python.exe via PATHEXT)
    // without a shell (EINVAL). The loop driver only runs on Windows where the
    // data lake lives, so shell-invocation is required here.
    shell: true,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit ${String(result.status)}`);
  }
}

function npxCommand(): string {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function pythonCommand(): string {
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

function many(
  values: ReadonlyMap<string, readonly string[]>,
  key: string,
  fallback: readonly string[],
): readonly string[] {
  return values.get(key) ?? fallback;
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

function optionalPositiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stableJson(value)}\n`, 'utf8');
}

function rewriteTrialAccountingForSurvivors(
  path: string,
  survivorCandidateIds: readonly string[],
): void {
  const manifest = readJson<Record<string, unknown>>(path);
  manifest.gated_candidate_count = survivorCandidateIds.length;
  manifest.candidate_strategy_ids_gated = [...survivorCandidateIds].sort();
  writeJson(path, manifest);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

main();
