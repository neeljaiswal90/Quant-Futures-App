import { describe, expect, it } from 'vitest';
import { ModeTransitionValidator } from '../../../src/execution/validators/mode-transition.js';
import { event } from './helpers.js';

describe('EXEC-VALIDATOR-04 mode transitions', () => {
  it('accepts unchanged paper mode facts', () => {
    const validator = new ModeTransitionValidator();
    expect(validator.runOnSessionStart({ mode: 'paper' })).toEqual([]);

    expect(
      validator.runOnEvent(
        event('CONFIG', {
          config_hash: 'a'.repeat(64),
          config_version: 1,
          mode: 'paper',
        }),
      ),
    ).toEqual([]);
  });

  it('rejects direct paper/live changes without a two-step operator event', () => {
    const validator = new ModeTransitionValidator();
    expect(validator.runOnSessionStart({ mode: 'paper' })).toEqual([]);

    const issues = validator.runOnEvent(
      event('CONFIG', {
        config_hash: 'a'.repeat(64),
        config_version: 1,
        mode: 'live',
      }),
    );

    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'mode_transition_without_two_step_operator_event' }),
    );
  });

  it('accepts explicit prepare and commit operator transition events', () => {
    const validator = new ModeTransitionValidator();
    expect(validator.runOnSessionStart({ mode: 'paper' })).toEqual([]);

    expect(
      validator.runOnEvent(
        event('CONFIG', {
          config_hash: 'a'.repeat(64),
          config_version: 1,
          operator_action: 'mode_transition_prepare',
          from_mode: 'paper',
          to_mode: 'live',
        }),
      ),
    ).toEqual([]);
    expect(
      validator.runOnEvent(
        event('CONFIG', {
          config_hash: 'a'.repeat(64),
          config_version: 1,
          operator_action: 'mode_transition_commit',
          from_mode: 'paper',
          to_mode: 'live',
        }),
      ),
    ).toEqual([]);
    expect(
      validator.runOnEvent(
        event('CONFIG', {
          config_hash: 'a'.repeat(64),
          config_version: 1,
          mode: 'live',
        }),
      ),
    ).toEqual([]);
  });
});
