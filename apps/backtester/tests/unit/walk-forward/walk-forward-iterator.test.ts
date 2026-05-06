import { describe, expect, it } from 'vitest';

import {
  buildWalkForwardPlan,
  deriveWalkForwardWindowId,
  validateWalkForwardPolicy,
  WalkForwardInputError,
  type WalkForwardPolicy,
} from '../../../src/walk-forward/index.js';

const defaultPolicy: WalkForwardPolicy = {
  policy_version: 1,
  train_sessions: 3,
  validation_sessions: 1,
  test_sessions: 1,
  step_sessions: 1,
  min_required_sessions: 5,
};

const exampleSessions = [
  '2026-02-02',
  '2026-02-03',
  '2026-02-04',
  '2026-02-05',
  '2026-02-06',
  '2026-02-09',
] as const;

describe('walk-forward iterator policy validation', () => {
  it('validates a correct fixed-size rolling policy', () => {
    expect(() => validateWalkForwardPolicy(defaultPolicy)).not.toThrow();
  });

  it('rejects zero train_sessions', () => {
    expect(() =>
      validateWalkForwardPolicy({ ...defaultPolicy, train_sessions: 0 }),
    ).toThrow(/policy.train_sessions/u);
  });

  it('rejects zero test_sessions', () => {
    expect(() =>
      validateWalkForwardPolicy({ ...defaultPolicy, test_sessions: 0 }),
    ).toThrow(/policy.test_sessions/u);
  });

  it('rejects zero step_sessions', () => {
    expect(() =>
      validateWalkForwardPolicy({ ...defaultPolicy, step_sessions: 0 }),
    ).toThrow(/policy.step_sessions/u);
  });

  it('rejects min_required_sessions smaller than train + validation + test', () => {
    expect(() =>
      validateWalkForwardPolicy({ ...defaultPolicy, min_required_sessions: 4 }),
    ).toThrow(/min_required_sessions/u);
  });
});

describe('buildWalkForwardPlan', () => {
  it('builds one deterministic half-open window from the dispatch example', () => {
    const plan = buildWalkForwardPlan(exampleSessions, defaultPolicy);

    expect(plan.windows).toHaveLength(1);
    expect(plan.windows[0]).toEqual({
      sequence: 1,
      window_id:
        'wf-1-1-2026-02-02-2026-02-05-2026-02-05-2026-02-06-2026-02-06-2026-02-09',
      train: {
        start_session: '2026-02-02',
        end_session: '2026-02-05',
      },
      validation: {
        start_session: '2026-02-05',
        end_session: '2026-02-06',
      },
      test: {
        start_session: '2026-02-06',
        end_session: '2026-02-09',
      },
    });
  });

  it('builds multiple fixed-size rolling windows', () => {
    const plan = buildWalkForwardPlan(
      [
        '2026-02-02',
        '2026-02-03',
        '2026-02-04',
        '2026-02-05',
        '2026-02-06',
        '2026-02-09',
        '2026-02-10',
        '2026-02-11',
      ],
      {
        policy_version: 1,
        train_sessions: 2,
        validation_sessions: 1,
        test_sessions: 1,
        step_sessions: 2,
        min_required_sessions: 4,
      },
    );

    expect(plan.windows.map((window) => window.sequence)).toEqual([1, 2]);
    expect(plan.windows.map((window) => window.train.start_session)).toEqual([
      '2026-02-02',
      '2026-02-04',
    ]);
    expect(plan.windows.map((window) => window.test.end_session)).toEqual([
      '2026-02-06',
      '2026-02-10',
    ]);
  });

  it('stops when not enough sessions remain for another complete half-open window', () => {
    const plan = buildWalkForwardPlan(
      [
        '2026-02-02',
        '2026-02-03',
        '2026-02-04',
        '2026-02-05',
        '2026-02-06',
        '2026-02-09',
        '2026-02-10',
      ],
      {
        policy_version: 1,
        train_sessions: 2,
        validation_sessions: 1,
        test_sessions: 1,
        step_sessions: 1,
        min_required_sessions: 4,
      },
    );

    expect(plan.windows).toHaveLength(3);
    expect(plan.windows.at(-1)?.test.end_session).toBe('2026-02-10');
  });

  it('rejects insufficient sessions when no exclusive end boundary exists', () => {
    expect(() =>
      buildWalkForwardPlan(
        ['2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05', '2026-02-06'],
        defaultPolicy,
      ),
    ).toThrow(/exclusive end-session boundary/u);
  });

  it('derives deterministic window IDs', () => {
    const plan = buildWalkForwardPlan(exampleSessions, defaultPolicy);
    const window = plan.windows[0]!;

    expect(
      deriveWalkForwardWindowId(1, window.train, window.validation, window.test),
    ).toBe(window.window_id);
  });

  it('repeated identical inputs produce deeply equal plans', () => {
    expect(buildWalkForwardPlan(exampleSessions, defaultPolicy)).toEqual(
      buildWalkForwardPlan(exampleSessions, defaultPolicy),
    );
  });

  it('changing policy changes the deterministic plan', () => {
    const plan = buildWalkForwardPlan(exampleSessions, defaultPolicy);
    const changed = buildWalkForwardPlan(exampleSessions, {
      ...defaultPolicy,
      train_sessions: 2,
      validation_sessions: 2,
    });

    expect(changed).not.toEqual(plan);
    expect(changed.windows[0]?.window_id).not.toBe(plan.windows[0]?.window_id);
  });

  it('rejects changed session order instead of silently sorting', () => {
    expect(() =>
      buildWalkForwardPlan(
        [
          '2026-02-02',
          '2026-02-04',
          '2026-02-03',
          '2026-02-05',
          '2026-02-06',
          '2026-02-09',
        ],
        defaultPolicy,
      ),
    ).toThrow(WalkForwardInputError);
  });

  it('does not mutate the caller session array', () => {
    const sessions = [...exampleSessions];
    const before = [...sessions];

    const plan = buildWalkForwardPlan(sessions, defaultPolicy);
    sessions.reverse();

    expect(before).toEqual(exampleSessions);
    expect(plan.sessions).toEqual(exampleSessions);
  });

  it('supports zero-length validation windows with a shared boundary', () => {
    const plan = buildWalkForwardPlan(exampleSessions, {
      policy_version: 1,
      train_sessions: 3,
      validation_sessions: 0,
      test_sessions: 1,
      step_sessions: 1,
      min_required_sessions: 4,
    });

    expect(plan.windows[0]?.validation).toEqual({
      start_session: '2026-02-05',
      end_session: '2026-02-05',
    });
    expect(plan.windows[0]?.test).toEqual({
      start_session: '2026-02-05',
      end_session: '2026-02-06',
    });
  });
});
