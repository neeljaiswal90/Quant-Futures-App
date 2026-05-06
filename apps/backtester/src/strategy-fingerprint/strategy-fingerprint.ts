import {
  ACTIVE_STRATEGY_IDS,
  isStrategyId,
  type StrategyId,
} from '../../../strategy_runtime/src/contracts/strategy-ids.js';
import { canonicalizeReproJson, sha256Utf8 } from '../repro-hash/index.js';
import type { StrategyReplayEvaluation } from '../strategy-replay/index.js';
import { normalizeStrategyReplayDecisions } from './decision-normalizer.js';
import {
  throwStrategyFingerprintIssues,
  type StrategyFingerprintIssue,
} from './strategy-fingerprint-error.js';
import {
  STRATEGY_FINGERPRINT_ALGORITHM,
  type StrategyFingerprint,
  type StrategyFingerprintDecision,
  type StrategyFingerprintSet,
} from './types.js';

const HEX_64 = /^[a-f0-9]{64}$/u;

export function computeStrategyFingerprint(
  strategyId: StrategyId,
  decisions: readonly StrategyFingerprintDecision[],
): StrategyFingerprint {
  validateStrategyId(strategyId, '$.strategy_id');
  validateFingerprintDecisions(strategyId, decisions);

  const decisionPayload = {
    algorithm: STRATEGY_FINGERPRINT_ALGORITHM,
    strategy_id: strategyId,
    decisions,
  };
  const decisionsSha256 = hashCanonicalPayload(decisionPayload);
  const fingerprintPayload = {
    fingerprint_schema_version: 1,
    algorithm: STRATEGY_FINGERPRINT_ALGORITHM,
    strategy_id: strategyId,
    decision_count: decisions.length,
    decisions_sha256: decisionsSha256,
  };
  const fingerprintSha256 = hashCanonicalPayload(fingerprintPayload);

  return {
    fingerprint_schema_version: 1,
    algorithm: STRATEGY_FINGERPRINT_ALGORITHM,
    strategy_id: strategyId,
    decision_count: decisions.length,
    decisions_sha256: decisionsSha256,
    fingerprint_sha256: fingerprintSha256,
  };
}

export function computeStrategyFingerprintSet(
  evaluations: readonly StrategyReplayEvaluation[],
  strategyOrder?: readonly StrategyId[],
): StrategyFingerprintSet {
  const decisions = normalizeStrategyReplayDecisions(evaluations);
  const resolvedStrategyOrder = resolveStrategyOrder(decisions, strategyOrder);
  const decisionsByStrategy = groupDecisionsByStrategy(decisions);
  validateNoOmittedStrategies(decisionsByStrategy, resolvedStrategyOrder);

  return {
    fingerprint_set_schema_version: 1,
    algorithm: STRATEGY_FINGERPRINT_ALGORITHM,
    fingerprints: resolvedStrategyOrder.map((strategyId) =>
      computeStrategyFingerprint(strategyId, decisionsByStrategy.get(strategyId) ?? []),
    ),
  };
}

function hashCanonicalPayload(value: unknown): string {
  const hash = sha256Utf8(canonicalizeReproJson(value));
  if (!HEX_64.test(hash)) {
    throw new Error(`strategy fingerprint hash was not lowercase sha256 hex: ${hash}`);
  }
  return hash;
}

function resolveStrategyOrder(
  decisions: readonly StrategyFingerprintDecision[],
  strategyOrder?: readonly StrategyId[],
): readonly StrategyId[] {
  if (strategyOrder !== undefined) {
    validateStrategyOrder(strategyOrder);
    return [...strategyOrder];
  }
  if (decisions.length === 0) {
    return [];
  }

  const present = new Set(decisions.map((decision) => decision.strategy_id));
  return ACTIVE_STRATEGY_IDS.filter((strategyId) => present.has(strategyId));
}

function validateStrategyOrder(strategyOrder: readonly StrategyId[]): void {
  const issues: StrategyFingerprintIssue[] = [];
  const seen = new Set<StrategyId>();

  strategyOrder.forEach((strategyId, index) => {
    const path = `$.strategy_order[${index}]`;
    if (!isStrategyId(strategyId)) {
      issues.push({
        path,
        code: 'unknown_strategy_id',
        message: `unknown strategy_id in fingerprint order: ${String(strategyId)}`,
      });
      return;
    }
    if (seen.has(strategyId)) {
      issues.push({
        path,
        code: 'strategy_mismatch',
        message: `duplicate strategy_id in fingerprint order: ${strategyId}`,
      });
      return;
    }
    seen.add(strategyId);
  });

  if (issues.length > 0) {
    throwStrategyFingerprintIssues(issues);
  }
}

function validateStrategyId(strategyId: StrategyId, path: string): void {
  if (!isStrategyId(strategyId)) {
    throwStrategyFingerprintIssues([
      {
        path,
        code: 'unknown_strategy_id',
        message: `unknown strategy_id: ${String(strategyId)}`,
      },
    ]);
  }
}

function validateFingerprintDecisions(
  strategyId: StrategyId,
  decisions: readonly StrategyFingerprintDecision[],
): void {
  const issues: StrategyFingerprintIssue[] = [];
  const seenSequences = new Set<number>();

  decisions.forEach((decision, index) => {
    const path = `$.decisions[${index}]`;
    if (decision.strategy_id !== strategyId) {
      issues.push({
        path: `${path}.strategy_id`,
        code: 'strategy_mismatch',
        message: `decision strategy_id ${decision.strategy_id} does not match ${strategyId}`,
      });
    }
    if (!Number.isSafeInteger(decision.sequence) || decision.sequence <= 0) {
      issues.push({
        path: `${path}.sequence`,
        code: 'duplicate_sequence',
        message: 'decision sequence must be a positive safe integer',
      });
    } else if (seenSequences.has(decision.sequence)) {
      issues.push({
        path: `${path}.sequence`,
        code: 'duplicate_sequence',
        message: `duplicate decision sequence ${decision.sequence}`,
      });
    } else {
      seenSequences.add(decision.sequence);
    }
    if (decision.sequence !== index + 1) {
      issues.push({
        path: `${path}.sequence`,
        code: 'duplicate_sequence',
        message: 'decision sequence must be contiguous in replay order',
      });
    }
  });

  if (issues.length > 0) {
    throwStrategyFingerprintIssues(issues);
  }
}

function groupDecisionsByStrategy(
  decisions: readonly StrategyFingerprintDecision[],
): ReadonlyMap<StrategyId, readonly StrategyFingerprintDecision[]> {
  const grouped = new Map<StrategyId, StrategyFingerprintDecision[]>();
  for (const decision of decisions) {
    const strategyDecisions = grouped.get(decision.strategy_id);
    if (strategyDecisions === undefined) {
      grouped.set(decision.strategy_id, [decision]);
      continue;
    }
    strategyDecisions.push(decision);
  }
  return grouped;
}

function validateNoOmittedStrategies(
  decisionsByStrategy: ReadonlyMap<StrategyId, readonly StrategyFingerprintDecision[]>,
  strategyOrder: readonly StrategyId[],
): void {
  const allowed = new Set(strategyOrder);
  const omitted = ACTIVE_STRATEGY_IDS.filter(
    (strategyId) => decisionsByStrategy.has(strategyId) && !allowed.has(strategyId),
  );
  if (omitted.length === 0) {
    return;
  }

  throwStrategyFingerprintIssues(
    omitted.map((strategyId) => ({
      path: '$.strategy_order',
      code: 'strategy_mismatch',
      message: `strategy_order omitted evaluations for ${strategyId}`,
    })),
  );
}
