import { isStrategyId, type StrategyId } from '../../../strategy_runtime/src/contracts/strategy-ids.js';
import type { UnixNs } from '../../../strategy_runtime/src/contracts/time.js';
import type { StrategyReplayEvaluation } from '../strategy-replay/index.js';
import {
  throwStrategyFingerprintIssues,
  type StrategyFingerprintIssue,
} from './strategy-fingerprint-error.js';
import type { StrategyFingerprintDecision } from './types.js';

export function normalizeStrategyReplayDecisions(
  evaluations: readonly StrategyReplayEvaluation[],
): readonly StrategyFingerprintDecision[] {
  const issues: StrategyFingerprintIssue[] = [];
  const sequenceByStrategy = new Map<StrategyId, number>();
  const decisions: StrategyFingerprintDecision[] = [];

  evaluations.forEach((evaluation, index) => {
    const path = `$[${index}]`;
    const record = evaluation as unknown as Record<string, unknown>;
    const strategyId = normalizeStrategyId(record.strategy_id, `${path}.strategy_id`, issues);
    const evaluationRecord = normalizeRecord(record.evaluation, `${path}.evaluation`, issues);

    const evaluationStrategyId =
      evaluationRecord === null
        ? null
        : normalizeStrategyId(
            evaluationRecord.strategy_id,
            `${path}.evaluation.strategy_id`,
            issues,
          );

    if (
      strategyId !== null &&
      evaluationStrategyId !== null &&
      strategyId !== evaluationStrategyId
    ) {
      issues.push({
        path: `${path}.evaluation.strategy_id`,
        code: 'strategy_mismatch',
        message: `evaluation strategy_id ${evaluationStrategyId} does not match ${strategyId}`,
      });
    }

    const barId = normalizeBarId(record.bar_id, `${path}.bar_id`, issues);
    const tsNs = normalizeUnixNs(record.ts_ns, `${path}.ts_ns`, issues);
    const gateState =
      evaluationRecord === null
        ? null
        : normalizeGateState(evaluationRecord.gate_state, `${path}.evaluation.gate_state`, issues);
    const score =
      evaluationRecord === null
        ? null
        : normalizeScore(evaluationRecord.score, `${path}.evaluation.score`, issues);
    const reasonCodes =
      evaluationRecord === null
        ? null
        : normalizeReasonCodes(evaluationRecord.reasons, `${path}.evaluation.reasons`, issues);
    const candidate = normalizeCandidate(record.candidate, path, strategyId, issues);

    if (
      strategyId === null ||
      barId === null ||
      tsNs === null ||
      gateState === undefined ||
      score === undefined ||
      reasonCodes === null ||
      candidate === null
    ) {
      return;
    }

    const sequence = (sequenceByStrategy.get(strategyId) ?? 0) + 1;
    sequenceByStrategy.set(strategyId, sequence);
    decisions.push({
      sequence,
      bar_id: barId,
      ts_ns: tsNs,
      strategy_id: strategyId,
      gate_state: gateState,
      score,
      candidate_present: candidate.candidate_present,
      candidate_id: candidate.candidate_id,
      reason_codes: reasonCodes,
    });
  });

  if (issues.length > 0) {
    throwStrategyFingerprintIssues(issues);
  }

  return decisions;
}

function normalizeStrategyId(
  value: unknown,
  path: string,
  issues: StrategyFingerprintIssue[],
): StrategyId | null {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({
      path,
      code: 'missing_strategy_id',
      message: 'strategy_id must be a non-empty string',
    });
    return null;
  }
  if (!isStrategyId(value)) {
    issues.push({
      path,
      code: 'unknown_strategy_id',
      message: `unknown strategy_id: ${value}`,
    });
    return null;
  }
  return value;
}

function normalizeRecord(
  value: unknown,
  path: string,
  issues: StrategyFingerprintIssue[],
): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({
      path,
      code: 'missing_decision_field',
      message: 'evaluation must be an object',
    });
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeBarId(
  value: unknown,
  path: string,
  issues: StrategyFingerprintIssue[],
): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({
      path,
      code: 'missing_bar_id',
      message: 'bar_id must be a non-empty string',
    });
    return null;
  }
  return value;
}

function normalizeUnixNs(
  value: unknown,
  path: string,
  issues: StrategyFingerprintIssue[],
): UnixNs | null {
  if (typeof value !== 'bigint') {
    issues.push({
      path,
      code: 'missing_ts_ns',
      message: 'ts_ns must be a UnixNs bigint value',
    });
    return null;
  }
  return value as UnixNs;
}

function normalizeGateState(
  value: unknown,
  path: string,
  issues: StrategyFingerprintIssue[],
): string | null | undefined {
  if (typeof value === 'undefined' || value === null) {
    issues.push({
      path,
      code: 'missing_decision_field',
      message: 'gate_state must be present for strategy fingerprinting',
    });
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({
      path,
      code: 'missing_decision_field',
      message: 'gate_state must be a non-empty string',
    });
    return undefined;
  }
  return value;
}

function normalizeScore(
  value: unknown,
  path: string,
  issues: StrategyFingerprintIssue[],
): number | null | undefined {
  if (typeof value === 'undefined' || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({
      path,
      code: 'non_finite_score',
      message: 'score must be a finite number when present',
    });
    return undefined;
  }
  if (Object.is(value, -0)) {
    issues.push({
      path,
      code: 'negative_zero_score',
      message: 'score must not be negative zero',
    });
    return undefined;
  }
  return value;
}

function normalizeReasonCodes(
  value: unknown,
  path: string,
  issues: StrategyFingerprintIssue[],
): readonly string[] | null {
  if (!Array.isArray(value)) {
    issues.push({
      path,
      code: 'missing_decision_field',
      message: 'reasons must be present as an array',
    });
    return null;
  }

  const reasonCodes: string[] = [];
  value.forEach((reason, index) => {
    if (typeof reason !== 'string' || reason.trim() === '') {
      issues.push({
        path: `${path}[${index}]`,
        code: 'invalid_reason_code',
        message: 'reason codes must be non-empty strings',
      });
      return;
    }
    reasonCodes.push(reason);
  });
  return reasonCodes;
}

interface NormalizedCandidate {
  readonly candidate_present: boolean;
  readonly candidate_id: string | null;
}

function normalizeCandidate(
  value: unknown,
  path: string,
  strategyId: StrategyId | null,
  issues: StrategyFingerprintIssue[],
): NormalizedCandidate | null {
  if (typeof value === 'undefined') {
    return {
      candidate_present: false,
      candidate_id: null,
    };
  }
  const candidate = normalizeRecord(value, `${path}.candidate`, issues);
  if (candidate === null) {
    return null;
  }

  const candidateId = candidate.candidate_id;
  if (typeof candidateId !== 'string' || candidateId.trim() === '') {
    issues.push({
      path: `${path}.candidate.candidate_id`,
      code: 'missing_decision_field',
      message: 'candidate_id must be a non-empty string when a candidate is present',
    });
    return null;
  }

  if (strategyId !== null) {
    const candidateStrategyId = candidate.strategy_id;
    if (typeof candidateStrategyId !== 'string' || !isStrategyId(candidateStrategyId)) {
      issues.push({
        path: `${path}.candidate.strategy_id`,
        code: 'unknown_strategy_id',
        message: 'candidate strategy_id must be a known strategy_id',
      });
      return null;
    }
    if (candidateStrategyId !== strategyId) {
      issues.push({
        path: `${path}.candidate.strategy_id`,
        code: 'strategy_mismatch',
        message: `candidate strategy_id ${candidateStrategyId} does not match ${strategyId}`,
      });
      return null;
    }
  }

  return {
    candidate_present: true,
    candidate_id: candidateId,
  };
}
