// Module under test: contracts/run-spec; ticket QFA-115 Session 2a.
import { describe, expect, it } from 'vitest';
import {
  CONFIG_INPUT_ROLE_ORDER,
  CORPUS_INPUT_ROLE_ORDER,
  type ConfigInputRole,
  type CorpusInputRole,
} from '../../../src/contracts/run-spec.js';

describe('QFA-115 RunSpec — role-order constants', () => {
  it('CORPUS_INPUT_ROLE_ORDER lists every CorpusInputRole', () => {
    const everyRole: readonly CorpusInputRole[] = [
      'primary',
      'calibration',
      'validation',
      'held_out',
      'stress',
      'other',
    ];
    expect([...CORPUS_INPUT_ROLE_ORDER].sort()).toEqual([...everyRole].sort());
    expect(CORPUS_INPUT_ROLE_ORDER.length).toBe(everyRole.length);
  });

  it('CORPUS_INPUT_ROLE_ORDER preserves the locked Q-3.5 order', () => {
    expect(CORPUS_INPUT_ROLE_ORDER).toEqual([
      'primary',
      'calibration',
      'validation',
      'held_out',
      'stress',
      'other',
    ]);
  });

  it('CONFIG_INPUT_ROLE_ORDER lists every ConfigInputRole', () => {
    const everyRole: readonly ConfigInputRole[] = [
      'strategy',
      'strategy_shared',
      'risk',
      'management',
      'venue_cost',
      'session',
      'roll_policy',
      'walk_forward',
      'tier_policy',
      'economic_calendar_policy',
      'fill_model_config',
      'cost_model_config',
      'other',
    ];
    expect([...CONFIG_INPUT_ROLE_ORDER].sort()).toEqual([...everyRole].sort());
    expect(CONFIG_INPUT_ROLE_ORDER.length).toBe(everyRole.length);
  });

  it('CONFIG_INPUT_ROLE_ORDER preserves the locked Q-3.5 order', () => {
    expect(CONFIG_INPUT_ROLE_ORDER).toEqual([
      'strategy',
      'strategy_shared',
      'risk',
      'management',
      'venue_cost',
      'session',
      'roll_policy',
      'walk_forward',
      'tier_policy',
      'economic_calendar_policy',
      'fill_model_config',
      'cost_model_config',
      'other',
    ]);
  });
});
