import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

type Scalar = string | number | boolean;

interface SearchSpec {
  readonly version: number;
  readonly generation_run_id: string;
  readonly family: string;
  readonly base_strategy_id: string;
  readonly base_config: string;
  readonly strategy_id_template: string;
  readonly trial_budget: number;
  readonly effective_trial_method: string;
  readonly search_seed: string;
  readonly generation_policy: Readonly<Record<string, Scalar>>;
  readonly corpus: Readonly<Record<string, Scalar>>;
  readonly parameters: Readonly<Record<string, readonly Scalar[]>>;
}

interface CandidateRecord {
  readonly candidate_strategy_id: string;
  readonly base_strategy_id: string;
  readonly candidate_config_path: string;
  readonly parameter_lock_hash: string;
  readonly search_space_hash: string;
  readonly corpus_fingerprint: string;
  readonly parameters: Readonly<Record<string, Scalar>>;
}

const DEFAULT_SPEC = 'config/strategy-gen/regime_shock_reversion_short_v2.search.yaml';
const GENERATED_TS = 'apps/strategy_runtime/src/contracts/generated-candidate-strategy-ids.ts';
const CANDIDATE_DIR = 'config/strategies/_candidates';
const ARTIFACT_ROOT = 'artifacts/strategy-generation';

function main(): number {
  const specPath = argumentValue('--spec') ?? DEFAULT_SPEC;
  const dryRun = process.argv.includes('--dry-run');
  const spec = parseSearchSpec(readFileSync(specPath, 'utf8'), specPath);
  if (spec.generation_policy.eligible !== true) {
    throw new Error(`generation policy refuses ${spec.family}: ${String(spec.generation_policy.reason)}`);
  }
  const baseConfig = parseStrategyConfig(readFileSync(spec.base_config, 'utf8'), spec.base_config);
  const candidates = buildCandidates(spec, baseConfig.parameters);
  const generationRoot = join(ARTIFACT_ROOT, spec.generation_run_id);
  const candidateManifest = buildCandidateManifest(spec, candidates);
  const trialManifest = buildTrialAccountingManifest(spec, candidates);

  if (!dryRun) {
    mkdirSync(CANDIDATE_DIR, { recursive: true });
    mkdirSync(generationRoot, { recursive: true });
    for (const candidate of candidates) {
      writeText(candidate.candidate_config_path, renderCandidateYaml(candidate));
    }
    writeText(GENERATED_TS, renderGeneratedCandidateContract(candidates));
    writeJson(join(generationRoot, 'candidate-manifest.json'), candidateManifest);
    writeJson(join(generationRoot, 'trial-accounting-manifest.json'), trialManifest);
  }

  console.log(JSON.stringify({
    generation_run_id: spec.generation_run_id,
    candidate_count: candidates.length,
    trial_budget: spec.trial_budget,
    dry_run: dryRun,
  }, null, 2));
  return 0;
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function buildCandidates(
  spec: SearchSpec,
  baseParameters: Readonly<Record<string, Scalar>>,
): readonly CandidateRecord[] {
  const searchSpaceHash = sha256(stableJson({
    base_strategy_id: spec.base_strategy_id,
    parameters: spec.parameters,
    corpus: spec.corpus,
  }));
  const corpusFingerprint = String(spec.corpus.corpus_fingerprint);
  const combinations = cartesianParameters(spec.parameters).slice(0, spec.trial_budget);
  return combinations.map((overrides) => {
    const parameters = {
      ...baseParameters,
      ...overrides,
    };
    const hash8 = sha256(stableJson({
      base_strategy_id: spec.base_strategy_id,
      parameters,
      search_space_hash: searchSpaceHash,
    })).slice(0, 8);
    const candidateStrategyId = spec.strategy_id_template.replace('{hash8}', hash8);
    const candidateConfigPath = `${CANDIDATE_DIR}/${candidateStrategyId}.yaml`;
    return {
      candidate_strategy_id: candidateStrategyId,
      base_strategy_id: spec.base_strategy_id,
      candidate_config_path: candidateConfigPath,
      parameter_lock_hash: parameterLockHash(candidateStrategyId, parameters),
      search_space_hash: searchSpaceHash,
      corpus_fingerprint: corpusFingerprint,
      parameters,
    };
  });
}

function cartesianParameters(
  parameters: Readonly<Record<string, readonly Scalar[]>>,
): readonly Readonly<Record<string, Scalar>>[] {
  const entries = Object.entries(parameters);
  const output: Array<Record<string, Scalar>> = [{}];
  for (const [name, values] of entries) {
    const next: Array<Record<string, Scalar>> = [];
    for (const existing of output) {
      for (const value of values) {
        next.push({ ...existing, [name]: value });
      }
    }
    output.splice(0, output.length, ...next);
  }
  return output;
}

function buildCandidateManifest(spec: SearchSpec, candidates: readonly CandidateRecord[]) {
  return {
    schema_version: 1,
    generation_run_id: spec.generation_run_id,
    base_family: spec.family,
    base_strategy_id: spec.base_strategy_id,
    search_seed: spec.search_seed,
    trial_budget: spec.trial_budget,
    candidate_count: candidates.length,
    candidates: candidates.map((candidate) => ({
      schema_version: 1,
      generation_run_id: spec.generation_run_id,
      base_family: spec.family,
      base_strategy_id: spec.base_strategy_id,
      candidate_strategy_id: candidate.candidate_strategy_id,
      candidate_config_path: candidate.candidate_config_path,
      base_generator_strategy_id: candidate.base_strategy_id,
      parameter_lock_hash: candidate.parameter_lock_hash,
      search_space_hash: candidate.search_space_hash,
      corpus_fingerprint: candidate.corpus_fingerprint,
    })),
  };
}

function buildTrialAccountingManifest(spec: SearchSpec, candidates: readonly CandidateRecord[]) {
  return {
    schema_version: 1,
    generation_run_id: spec.generation_run_id,
    effective_trial_method: spec.effective_trial_method,
    manual_declared_effective_trials: spec.trial_budget,
    distinct_window_fingerprint_tuples: candidates.length,
    scored_candidate_count: candidates.length,
    gated_candidate_count: candidates.length,
    constraint_invalid_candidate_count: 0,
    search_space_hash: candidates[0]?.search_space_hash ?? sha256(stableJson(spec.parameters)),
    search_seed: spec.search_seed,
    corpus_fingerprint: String(spec.corpus.corpus_fingerprint),
    candidate_strategy_ids_gated: candidates.map((candidate) => candidate.candidate_strategy_id),
  };
}

function renderCandidateYaml(candidate: CandidateRecord): string {
  return [
    'version: 1',
    `strategy_id: ${candidate.candidate_strategy_id}`,
    'parameters:',
    ...Object.entries(candidate.parameters)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `  ${name}: ${String(value)}`),
    '',
  ].join('\n');
}

function renderGeneratedCandidateContract(candidates: readonly CandidateRecord[]): string {
  const ids = candidates.map((candidate) => candidate.candidate_strategy_id).sort();
  const mappings = candidates
    .slice()
    .sort((left, right) => left.candidate_strategy_id.localeCompare(right.candidate_strategy_id))
    .map((candidate) => `  ${JSON.stringify(candidate.candidate_strategy_id)}: ${JSON.stringify(candidate.base_strategy_id)},`);
  return `import type {
  ActiveStrategyId,
  RegisteredInactiveStrategyId,
} from './strategy-ids.js';

/**
 * Generated by scripts/strategy-gen/emit-tier1-candidates.ts.
 *
 * Do not hand-edit candidate entries; rerun the emitter with the committed
 * search spec so IDs, base mappings, and trial accounting stay in sync.
 */
export const GENERATED_CANDIDATE_STRATEGY_IDS = [
${ids.map((id) => `  ${JSON.stringify(id)},`).join('\n')}
] as const;

export type GeneratedCandidateStrategyId =
  (typeof GENERATED_CANDIDATE_STRATEGY_IDS)[number];

export type GeneratedCandidateBaseStrategyId =
  | ActiveStrategyId
  | RegisteredInactiveStrategyId;

export const GENERATED_CANDIDATE_BASE_STRATEGY_IDS = {
${mappings.join('\n')}
} as const satisfies
  Readonly<Record<GeneratedCandidateStrategyId, GeneratedCandidateBaseStrategyId>>;

const GENERATED_CANDIDATE_STRATEGY_ID_SET = new Set<string>(
  GENERATED_CANDIDATE_STRATEGY_IDS,
);

export function isGeneratedCandidateStrategyId(
  value: string,
): value is GeneratedCandidateStrategyId {
  return GENERATED_CANDIDATE_STRATEGY_ID_SET.has(value);
}

export function getGeneratedCandidateBaseStrategyId(
  value: GeneratedCandidateStrategyId,
): GeneratedCandidateBaseStrategyId {
  const baseStrategyId = (
    GENERATED_CANDIDATE_BASE_STRATEGY_IDS as Readonly<Record<string, GeneratedCandidateBaseStrategyId>>
  )[value];
  if (baseStrategyId === undefined) {
    throw new Error(\`generated candidate \${value} is missing a base strategy mapping\`);
  }
  return baseStrategyId;
}
`;
}

function parseSearchSpec(contents: string, filePath: string): SearchSpec {
  const root = parseSimpleYaml(contents, filePath);
  const parametersRecord = requireRecord(root.parameters, `${filePath}.parameters`);
  const parameters: Record<string, readonly Scalar[]> = {};
  for (const [name, value] of Object.entries(parametersRecord)) {
    const record = requireRecord(value, `${filePath}.parameters.${name}`);
    const values = record.values;
    if (!Array.isArray(values) || values.length === 0 || !values.every(isScalar)) {
      throw new Error(`${filePath}.parameters.${name}.values must be a non-empty scalar list`);
    }
    parameters[name] = values;
  }
  return {
    version: requireNumber(root.version, `${filePath}.version`),
    generation_run_id: requireString(root.generation_run_id, `${filePath}.generation_run_id`),
    family: requireString(root.family, `${filePath}.family`),
    base_strategy_id: requireString(root.base_strategy_id, `${filePath}.base_strategy_id`),
    base_config: requireString(root.base_config, `${filePath}.base_config`),
    strategy_id_template: requireString(root.strategy_id_template, `${filePath}.strategy_id_template`),
    trial_budget: requireNumber(root.trial_budget, `${filePath}.trial_budget`),
    effective_trial_method: requireString(root.effective_trial_method, `${filePath}.effective_trial_method`),
    search_seed: requireString(root.search_seed, `${filePath}.search_seed`),
    generation_policy: requireScalarRecord(root.generation_policy, `${filePath}.generation_policy`),
    corpus: requireScalarRecord(root.corpus, `${filePath}.corpus`),
    parameters,
  };
}

function parseStrategyConfig(contents: string, filePath: string) {
  const root = parseSimpleYaml(contents, filePath);
  return {
    strategy_id: requireString(root.strategy_id, `${filePath}.strategy_id`),
    parameters: requireScalarRecord(root.parameters, `${filePath}.parameters`),
  };
}

function parseSimpleYaml(contents: string, filePath: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; object: Record<string, unknown> }> = [
    { indent: 0, object: root },
  ];
  for (const [zeroIndex, raw] of contents.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = stripComment(raw);
    if (line.trim() === '') continue;
    const match = /^(\s*)([A-Za-z0-9_]+):(?:\s*(.*))?$/.exec(line);
    if (match === null) {
      throw new Error(`${filePath}:${zeroIndex + 1} unsupported YAML line`);
    }
    const indent = match[1]!.length;
    while (stack.length > 1 && indent < stack[stack.length - 1]!.indent) stack.pop();
    const frame = stack[stack.length - 1]!;
    if (indent !== frame.indent) {
      throw new Error(`${filePath}:${zeroIndex + 1} unsupported indentation`);
    }
    const key = match[2]!;
    const rawValue = match[3] ?? '';
    if (rawValue.trim() === '') {
      const child: Record<string, unknown> = {};
      frame.object[key] = child;
      stack.push({ indent: indent + 2, object: child });
      continue;
    }
    frame.object[key] = parseScalarOrList(rawValue.trim());
  }
  return root;
}

function stripComment(line: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && quote === undefined) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = undefined;
      continue;
    }
    if (char === '#' && quote === undefined && (index === 0 || line[index - 1] === ' ')) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseScalarOrList(value: string): unknown {
  if (value.includes(',')) {
    return value.split(',').map((item) => parseScalar(item.trim()));
  }
  return parseScalar(value);
}

function parseScalar(value: string): Scalar {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireScalarRecord(value: unknown, path: string): Readonly<Record<string, Scalar>> {
  const record = requireRecord(value, path);
  for (const [key, scalar] of Object.entries(record)) {
    if (!isScalar(scalar)) {
      throw new Error(`${path}.${key} must be a scalar`);
    }
  }
  return record as Readonly<Record<string, Scalar>>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${path} must be a non-empty string`);
  return value;
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} must be finite number`);
  return value;
}

function isScalar(value: unknown): value is Scalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function parameterLockHash(strategyId: string, parameters: Readonly<Record<string, Scalar>>): string {
  return sha256(stableJson({
    parameter_lock_algorithm: 'qfa611_parameter_struct_v1',
    strategy_id: strategyId,
    parameters,
  }));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function writeJson(path: string, value: unknown): void {
  writeText(path, `${stableJson(value)}\n`);
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, value.replace(/\r\n/g, '\n'), 'utf8');
}

main();
