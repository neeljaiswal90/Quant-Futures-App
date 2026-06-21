import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

import {
  computeInLoopSScore,
  type InLoopScoreInput,
  type InLoopScoreResult,
} from './in-loop-s-score.js';

export interface InLoopScoreInputFile {
  readonly schema_version: 1;
  readonly scores: readonly InLoopScoreInput[];
}

export interface InLoopScoreLedger {
  readonly schema_version: 1;
  readonly generation_run_id: string;
  readonly score_name: 'strategy_gen_in_loop_s_v1';
  readonly source_path: string;
  readonly score_count: number;
  readonly scores: readonly InLoopScoreResult[];
}

export interface InLoopSurvivor {
  readonly rank: number;
  readonly candidate_strategy_id: string;
  readonly score: number;
  readonly score_partition_role: 'validation';
}

export interface InLoopSurvivorManifest {
  readonly schema_version: 1;
  readonly generation_run_id: string;
  readonly selection_policy: 'top_validation_s_v1';
  readonly total_candidate_count: number;
  readonly scored_validation_candidate_count: number;
  readonly survivor_count: number;
  readonly rejected_unscored_candidate_ids: readonly string[];
  readonly survivors: readonly InLoopSurvivor[];
}

export interface SelectInLoopSurvivorsInput {
  readonly generationRunId: string;
  readonly candidateIds: readonly string[];
  readonly scoreInputPath: string;
  readonly survivorCount?: number;
}

export interface SelectInLoopSurvivorsResult {
  readonly scoreLedger: InLoopScoreLedger;
  readonly survivorManifest: InLoopSurvivorManifest;
  readonly survivorCandidateIds: readonly string[];
}

export function selectInLoopSurvivors(
  input: SelectInLoopSurvivorsInput,
): SelectInLoopSurvivorsResult {
  const candidateSet = new Set(input.candidateIds);
  const scoreInput = readScoreInput(input.scoreInputPath);
  const computedScores = scoreInput.scores.map((score) => {
    if (!candidateSet.has(score.candidate_strategy_id)) {
      throw new Error(`in-loop score input references unknown candidate ${score.candidate_strategy_id}`);
    }
    return computeInLoopSScore(score);
  });
  const validationScores = computedScores
    .filter((score) => score.partition_role === 'validation')
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.candidate_strategy_id.localeCompare(right.candidate_strategy_id);
    });
  if (validationScores.length === 0) {
    throw new Error('in-loop survivor selection requires at least one validation score');
  }
  const requestedSurvivorCount = input.survivorCount ?? validationScores.length;
  if (!Number.isInteger(requestedSurvivorCount) || requestedSurvivorCount <= 0) {
    throw new Error('--survivor-count must be a positive integer');
  }
  const survivors = validationScores
    .slice(0, Math.min(requestedSurvivorCount, validationScores.length))
    .map((score, index): InLoopSurvivor => ({
      rank: index + 1,
      candidate_strategy_id: score.candidate_strategy_id,
      score: score.score,
      score_partition_role: 'validation',
    }));
  const scoredValidationCandidateIds = new Set(validationScores.map((score) => score.candidate_strategy_id));
  const survivorCandidateIds = survivors.map((survivor) => survivor.candidate_strategy_id);
  return {
    scoreLedger: {
      schema_version: 1,
      generation_run_id: input.generationRunId,
      score_name: 'strategy_gen_in_loop_s_v1',
      source_path: input.scoreInputPath,
      score_count: computedScores.length,
      scores: computedScores,
    },
    survivorManifest: {
      schema_version: 1,
      generation_run_id: input.generationRunId,
      selection_policy: 'top_validation_s_v1',
      total_candidate_count: input.candidateIds.length,
      scored_validation_candidate_count: validationScores.length,
      survivor_count: survivors.length,
      rejected_unscored_candidate_ids: input.candidateIds
        .filter((candidateId) => !scoredValidationCandidateIds.has(candidateId))
        .sort(),
      survivors,
    },
    survivorCandidateIds,
  };
}

export function writeInLoopSelectionArtifacts(input: {
  readonly scoreLedgerPath: string;
  readonly survivorManifestPath: string;
  readonly result: SelectInLoopSurvivorsResult;
}): void {
  writeJson(input.scoreLedgerPath, input.result.scoreLedger);
  writeJson(input.survivorManifestPath, input.result.survivorManifest);
}

function readScoreInput(path: string): InLoopScoreInputFile {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<InLoopScoreInputFile>;
  if (parsed.schema_version !== 1) {
    throw new Error(`${path} must use in-loop score input schema_version=1`);
  }
  if (!Array.isArray(parsed.scores)) {
    throw new Error(`${path} must contain scores[]`);
  }
  return parsed as InLoopScoreInputFile;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stableJson(value)}\n`, 'utf8');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}
