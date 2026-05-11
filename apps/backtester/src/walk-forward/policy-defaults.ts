import type { WalkForwardPolicy } from './types.js';

export const QFA611_DEFAULT_WALK_FORWARD_POLICY: WalkForwardPolicy = Object.freeze({
  policy_version: 1,
  train_sessions: 20,
  validation_sessions: 10,
  test_sessions: 5,
  step_sessions: 5,
  min_required_sessions: 35,
});

export const QFA611_DEFAULT_WALK_FORWARD_ARTIFACT_POLICY = Object.freeze({
  policy_version: QFA611_DEFAULT_WALK_FORWARD_POLICY.policy_version,
  train: QFA611_DEFAULT_WALK_FORWARD_POLICY.train_sessions,
  validation: QFA611_DEFAULT_WALK_FORWARD_POLICY.validation_sessions,
  test: QFA611_DEFAULT_WALK_FORWARD_POLICY.test_sessions,
  step: QFA611_DEFAULT_WALK_FORWARD_POLICY.step_sessions,
  min_required_sessions: QFA611_DEFAULT_WALK_FORWARD_POLICY.min_required_sessions,
});
