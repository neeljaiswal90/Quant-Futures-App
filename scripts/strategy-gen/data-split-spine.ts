import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const STRATEGY_GEN_PARTITION_ROLES = [
  'train',
  'validation',
  'held_out',
  'paper',
] as const;

export type StrategyGenPartitionRole =
  (typeof STRATEGY_GEN_PARTITION_ROLES)[number];

export type HeldOutAccessPurpose =
  | 'qfa410b_held_out_replay'
  | 'qfa611_gate';

export interface DataSplitManifestInput {
  readonly manifestPath: string;
}

export interface DataSplitSpineInput {
  readonly generationRunId: string;
  readonly searchSpecPath: string;
  readonly manifestPaths: readonly string[];
  readonly heldOutDir: string;
  readonly paperPartitionId?: string;
}

export interface DataSplitSessionRef {
  readonly session_id: string;
  readonly source_split: string;
  readonly manifest_path: string;
  readonly manifest_hash: string;
  readonly status: string;
}

export interface DataSplitPartition {
  readonly role: StrategyGenPartitionRole;
  readonly source: string;
  readonly access_policy: string;
  readonly session_count: number;
  readonly sessions: readonly DataSplitSessionRef[];
}

export interface HeldOutPartitionDeclaration {
  readonly role: 'held_out';
  readonly source: string;
  readonly access_policy: 'sealed_until_qfa611_gate';
  readonly allowed_access_purposes: readonly HeldOutAccessPurpose[];
}

export interface PaperPartitionDeclaration {
  readonly role: 'paper';
  readonly source: string;
  readonly access_policy: 'human_gated_after_selection';
}

export interface DataSplitSpine {
  readonly schema_version: 1;
  readonly generation_run_id: string;
  readonly search_spec_path: string;
  readonly train: DataSplitPartition;
  readonly validation: DataSplitPartition;
  readonly held_out: HeldOutPartitionDeclaration;
  readonly paper: PaperPartitionDeclaration;
  readonly leakage_guard: {
    readonly held_out_reads_require_explicit_gate: true;
    readonly train_validation_loop_must_not_read_held_out: true;
    readonly paper_partition_has_no_loop_authority: true;
  };
}

interface CorpusManifest {
  readonly sessions?: readonly CorpusManifestSession[];
}

interface CorpusManifestSession {
  readonly session_id?: unknown;
  readonly split?: unknown;
  readonly status?: unknown;
}

export function buildDataSplitSpine(input: DataSplitSpineInput): DataSplitSpine {
  const manifestSessions = input.manifestPaths.flatMap((manifestPath) => {
    const manifestHash = sha256File(manifestPath);
    const manifest = readJson<CorpusManifest>(manifestPath);
    return (manifest.sessions ?? []).map((session) => ({
      session,
      manifestPath,
      manifestHash,
    }));
  });

  const trainSessions = manifestSessions
    .filter(({ session }) => session.split === 'calibration')
    .map(({ session, manifestPath, manifestHash }) => sessionRef(session, manifestPath, manifestHash));
  const validationSessions = manifestSessions
    .filter(({ session }) => session.split === 'validation')
    .map(({ session, manifestPath, manifestHash }) => sessionRef(session, manifestPath, manifestHash));

  if (trainSessions.length === 0) {
    throw new Error('strategy-gen data split spine requires at least one TRAIN/calibration session');
  }
  if (validationSessions.length === 0) {
    throw new Error('strategy-gen data split spine requires at least one VALIDATION session');
  }

  return {
    schema_version: 1,
    generation_run_id: input.generationRunId,
    search_spec_path: input.searchSpecPath,
    train: {
      role: 'train',
      source: 'corpus_manifest_split:calibration',
      access_policy: 'in_loop_scoring_allowed',
      session_count: trainSessions.length,
      sessions: stableSessions(trainSessions),
    },
    validation: {
      role: 'validation',
      source: 'corpus_manifest_split:validation',
      access_policy: 'in_loop_scoring_allowed_no_held_out',
      session_count: validationSessions.length,
      sessions: stableSessions(validationSessions),
    },
    held_out: {
      role: 'held_out',
      source: input.heldOutDir,
      access_policy: 'sealed_until_qfa611_gate',
      allowed_access_purposes: [
        'qfa410b_held_out_replay',
        'qfa611_gate',
      ],
    },
    paper: {
      role: 'paper',
      source: input.paperPartitionId ?? 'not_materialized',
      access_policy: 'human_gated_after_selection',
    },
    leakage_guard: {
      held_out_reads_require_explicit_gate: true,
      train_validation_loop_must_not_read_held_out: true,
      paper_partition_has_no_loop_authority: true,
    },
  };
}

export function assertHeldOutAccessAllowed(input: {
  readonly purpose: HeldOutAccessPurpose;
  readonly allowHeldOutGate: boolean;
}): void {
  if (!input.allowHeldOutGate) {
    throw new Error(
      `held-out access for ${input.purpose} requires --allow-held-out-gate; TRAIN/VALIDATION loop code must stay sealed`,
    );
  }
}

export function writeDataSplitSpine(path: string, spine: DataSplitSpine): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stableJson(spine)}\n`, 'utf8');
}

function sessionRef(
  session: CorpusManifestSession,
  manifestPath: string,
  manifestHash: string,
): DataSplitSessionRef {
  if (typeof session.session_id !== 'string' || session.session_id.trim() === '') {
    throw new Error(`${manifestPath} contains a split session without session_id`);
  }
  if (typeof session.split !== 'string' || session.split.trim() === '') {
    throw new Error(`${manifestPath} contains session ${session.session_id} without split`);
  }
  if (typeof session.status !== 'string' || session.status.trim() === '') {
    throw new Error(`${manifestPath} contains session ${session.session_id} without status`);
  }
  return {
    session_id: session.session_id,
    source_split: session.split,
    manifest_path: manifestPath,
    manifest_hash: manifestHash,
    status: session.status,
  };
}

function stableSessions(sessions: readonly DataSplitSessionRef[]): readonly DataSplitSessionRef[] {
  return sessions
    .slice()
    .sort((left, right) => left.session_id.localeCompare(right.session_id));
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}
