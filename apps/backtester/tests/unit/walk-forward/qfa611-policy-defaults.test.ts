import { describe, expect, it } from 'vitest';

import {
  buildWalkForwardPlan,
  QFA611_DEFAULT_WALK_FORWARD_ARTIFACT_POLICY,
  QFA611_DEFAULT_WALK_FORWARD_POLICY,
} from '../../../src/walk-forward/index.js';

describe('QFA-611 walk-forward default policy', () => {
  it('locks ADR-0016 Cycle1 walk-forward defaults', () => {
    expect(QFA611_DEFAULT_WALK_FORWARD_POLICY).toEqual({
      policy_version: 1,
      train_sessions: 20,
      validation_sessions: 10,
      test_sessions: 5,
      step_sessions: 5,
      min_required_sessions: 35,
    });
    expect(QFA611_DEFAULT_WALK_FORWARD_ARTIFACT_POLICY).toEqual({
      policy_version: 1,
      train: 20,
      validation: 10,
      test: 5,
      step: 5,
      min_required_sessions: 35,
    });
  });

  it('builds test windows from the locked defaults', () => {
    const sessions = Array.from({ length: 41 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 1, 2 + index));
      return `${date.toISOString().slice(0, 10)}-rth`;
    });
    const plan = buildWalkForwardPlan(sessions, QFA611_DEFAULT_WALK_FORWARD_POLICY);

    expect(plan.policy).toEqual(QFA611_DEFAULT_WALK_FORWARD_POLICY);
    expect(plan.windows).toHaveLength(2);
    expect(plan.windows[0]).toMatchObject({
      sequence: 1,
      train: { start_session: sessions[0], end_session: sessions[20] },
      validation: { start_session: sessions[20], end_session: sessions[30] },
      test: { start_session: sessions[30], end_session: sessions[35] },
    });
  });
});
