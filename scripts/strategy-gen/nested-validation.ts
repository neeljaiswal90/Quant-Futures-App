import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  DataSplitSessionRef,
  DataSplitSpine,
} from './data-split-spine.js';

export interface NestedValidationFold {
  readonly fold_index: number;
  readonly role: 'validation';
  readonly session_count: number;
  readonly sessions: readonly DataSplitSessionRef[];
}

export interface NestedValidationManifest {
  readonly schema_version: 1;
  readonly generation_run_id: string;
  readonly fold_policy: 'round_robin_validation_sessions_v1';
  readonly fold_count: number;
  readonly validation_session_count: number;
  readonly folds: readonly NestedValidationFold[];
}

export function buildNestedValidationManifest(input: {
  readonly spine: DataSplitSpine;
  readonly foldCount: number;
}): NestedValidationManifest {
  if (!Number.isInteger(input.foldCount) || input.foldCount <= 0) {
    throw new Error('--nested-validation-folds must be a positive integer');
  }
  const validationSessions = input.spine.validation.sessions
    .slice()
    .sort((left, right) => left.session_id.localeCompare(right.session_id));
  if (validationSessions.length < input.foldCount) {
    throw new Error(
      `nested validation requires at least one validation session per fold: sessions=${validationSessions.length} folds=${input.foldCount}`,
    );
  }
  const folds: NestedValidationFold[] = Array.from({ length: input.foldCount }, (_, index) => ({
    fold_index: index,
    role: 'validation',
    session_count: 0,
    sessions: [],
  }));
  for (const [index, session] of validationSessions.entries()) {
    const fold = folds[index % input.foldCount]!;
    const sessions = [...fold.sessions, session];
    folds[index % input.foldCount] = {
      ...fold,
      session_count: sessions.length,
      sessions,
    };
  }
  return {
    schema_version: 1,
    generation_run_id: input.spine.generation_run_id,
    fold_policy: 'round_robin_validation_sessions_v1',
    fold_count: input.foldCount,
    validation_session_count: validationSessions.length,
    folds,
  };
}

export function writeNestedValidationManifest(path: string, manifest: NestedValidationManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stableJson(manifest)}\n`, 'utf8');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}
