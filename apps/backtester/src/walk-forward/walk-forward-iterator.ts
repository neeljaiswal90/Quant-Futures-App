import { makeSessionDateRange, validateSessionList } from './session-ranges.js';
import type {
  SessionDateRange,
  WalkForwardPlan,
  WalkForwardPolicy,
  WalkForwardWindow,
} from './types.js';
import type { WalkForwardIssue } from './walk-forward-error.js';
import { throwWalkForwardIssues } from './walk-forward-error.js';

export function validateWalkForwardPolicy(policy: WalkForwardPolicy): void {
  const issues = collectWalkForwardPolicyIssues(policy);
  if (issues.length > 0) {
    throwWalkForwardIssues(issues);
  }
}

export function buildWalkForwardPlan(
  sessions: readonly string[],
  policy: WalkForwardPolicy,
): WalkForwardPlan {
  validateWalkForwardPolicy(policy);
  validateSessionList(sessions);

  const spanSessions =
    policy.train_sessions + policy.validation_sessions + policy.test_sessions;

  if (sessions.length < policy.min_required_sessions) {
    throwWalkForwardIssues([
      {
        path: 'sessions',
        code: 'insufficient_sessions',
        message: `sessions length ${sessions.length} is below min_required_sessions ${policy.min_required_sessions}`,
      },
    ]);
  }

  if (sessions.length <= spanSessions) {
    throwWalkForwardIssues([
      {
        path: 'sessions',
        code: 'insufficient_sessions',
        message: 'half-open walk-forward windows require one exclusive end-session boundary after the test window',
      },
    ]);
  }

  const windows: WalkForwardWindow[] = [];

  for (
    let startIndex = 0, sequence = 1;
    startIndex + spanSessions < sessions.length;
    startIndex += policy.step_sessions, sequence += 1
  ) {
    const trainStart = startIndex;
    const trainEnd = trainStart + policy.train_sessions;
    const validationStart = trainEnd;
    const validationEnd = validationStart + policy.validation_sessions;
    const testStart = validationEnd;
    const testEnd = testStart + policy.test_sessions;

    const train = makeSessionDateRange(sessions, trainStart, trainEnd);
    const validation = makeSessionDateRange(sessions, validationStart, validationEnd);
    const test = makeSessionDateRange(sessions, testStart, testEnd);

    windows.push({
      sequence,
      train,
      validation,
      test,
      window_id: deriveWalkForwardWindowId(sequence, train, validation, test),
    });
  }

  return {
    policy: { ...policy },
    sessions: [...sessions],
    windows,
  };
}

export function deriveWalkForwardWindowId(
  sequence: number,
  train: SessionDateRange,
  validation: SessionDateRange,
  test: SessionDateRange,
): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throwWalkForwardIssues([
      {
        path: 'sequence',
        code: 'invalid_policy',
        message: 'window sequence must be a positive safe integer',
      },
    ]);
  }

  return [
    'wf',
    '1',
    String(sequence),
    train.start_session,
    train.end_session,
    validation.start_session,
    validation.end_session,
    test.start_session,
    test.end_session,
  ].join('-');
}

function collectWalkForwardPolicyIssues(
  policy: WalkForwardPolicy,
): readonly WalkForwardIssue[] {
  const issues: WalkForwardIssue[] = [];

  if (policy.policy_version !== 1) {
    issues.push({
      path: 'policy.policy_version',
      code: 'invalid_policy',
      message: 'policy_version must be 1',
    });
  }

  collectPositiveIntegerIssue(issues, 'policy.train_sessions', policy.train_sessions);
  collectNonNegativeIntegerIssue(
    issues,
    'policy.validation_sessions',
    policy.validation_sessions,
  );
  collectPositiveIntegerIssue(issues, 'policy.test_sessions', policy.test_sessions);
  collectPositiveIntegerIssue(issues, 'policy.step_sessions', policy.step_sessions);
  collectPositiveIntegerIssue(
    issues,
    'policy.min_required_sessions',
    policy.min_required_sessions,
  );

  if (
    Number.isSafeInteger(policy.train_sessions) &&
    Number.isSafeInteger(policy.validation_sessions) &&
    Number.isSafeInteger(policy.test_sessions) &&
    Number.isSafeInteger(policy.min_required_sessions)
  ) {
    const required =
      policy.train_sessions + policy.validation_sessions + policy.test_sessions;

    if (policy.min_required_sessions < required) {
      issues.push({
        path: 'policy.min_required_sessions',
        code: 'invalid_policy',
        message: 'min_required_sessions must be at least train + validation + test sessions',
      });
    }
  }

  return issues;
}

function collectPositiveIntegerIssue(
  issues: WalkForwardIssue[],
  path: string,
  value: number,
): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    issues.push({
      path,
      code: 'invalid_policy',
      message: 'value must be a positive safe integer',
    });
  }
}

function collectNonNegativeIntegerIssue(
  issues: WalkForwardIssue[],
  path: string,
  value: number,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    issues.push({
      path,
      code: 'invalid_policy',
      message: 'value must be a non-negative safe integer',
    });
  }
}
