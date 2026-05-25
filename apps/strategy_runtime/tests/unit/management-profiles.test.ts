import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STRATEGY_IDS,
  createJournalEventEnvelope,
  makeCausationId,
  makeEventId,
  makeManagementActionId,
  makePositionId,
  makeRunId,
  makeSessionId,
  ns,
  validateJournalEventEnvelope,
  type Candidate,
  type StrategyId,
} from '../../src/contracts/index.js';
import {
  MANAGEMENT_ACTION_TYPES,
  V1_MANAGEMENT_PROFILES,
  assertValidManagementProfile,
  computeInitialStopPolicy,
  getTargetPlanFromCandidate,
  resolveManagementProfile,
  validateAllDefaultManagementProfiles,
  validateManagementProfile,
  type ManagementProfile,
} from '../../src/management/index.js';
import { getActiveStrategyGenerator } from '../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../fixtures/strategies/synthetic-feature-snapshots.js';

const TS_NS = ns('1776957600000000000');

function fixtureCandidate(strategyId: StrategyId): Candidate {
  const result = getActiveStrategyGenerator(strategyId)({
    strategy_id: strategyId,
    snapshot: STRATEGY_SYNTHETIC_FIXTURES[strategyId].snapshot,
  });
  if (result.candidate === undefined) {
    throw new Error(`expected ${strategyId} fixture candidate`);
  }
  return result.candidate;
}

function cloneProfile(
  profile: ManagementProfile,
  overrides: Partial<ManagementProfile>,
): ManagementProfile {
  return {
    ...profile,
    ...overrides,
  };
}

function cloneCandidate(candidate: Candidate, overrides: Partial<Candidate>): Candidate {
  return {
    ...candidate,
    ...overrides,
  };
}

describe('MGMT-01 management profile substrate', () => {
  it('resolves and validates a management profile for each active V1 strategy', () => {
    validateAllDefaultManagementProfiles();

    for (const strategyId of ACTIVE_STRATEGY_IDS) {
      const resolved = resolveManagementProfile(strategyId);

      expect(resolved).toMatchObject({
        strategy_id: strategyId,
        fallback_used: false,
      });
      expect(resolved.profile.strategy_id).toBe(strategyId);
      expect(validateManagementProfile(resolved.profile)).toEqual([]);
    }
  });

  it('builds deterministic target and initial-stop plans from journaled candidates', () => {
    const candidate = fixtureCandidate('breakout_retest_long');
    const profile = resolveManagementProfile(candidate.strategy_id).profile;

    const firstTargetPlan = getTargetPlanFromCandidate(candidate, profile);
    const secondTargetPlan = getTargetPlanFromCandidate(candidate, profile);
    const firstStopPlan = computeInitialStopPolicy(candidate, profile);
    const secondStopPlan = computeInitialStopPolicy(candidate, profile);

    expect(firstTargetPlan).toEqual(secondTargetPlan);
    expect(firstStopPlan).toEqual(secondStopPlan);
    expect(firstTargetPlan).toMatchObject({
      profile_id: 'breakout_retest_long_management_v1',
      profile_version: 1,
      strategy_id: 'breakout_retest_long',
      candidate_id: candidate.candidate_id,
      targets: [
        {
          label: 'pt1',
          action: 'TAKE_PARTIAL',
          management_quantity_fraction: 0.5,
        },
        {
          label: 'pt2',
          action: 'TAKE_PROFIT',
          management_quantity_fraction: 0.5,
        },
      ],
    });
    expect(firstStopPlan).toMatchObject({
      stop_price: candidate.stop_price,
      stop_widening_allowed: false,
      lock_to_candidate_stop: true,
    });
  });

  it('rejects invalid partial sizing and invalid target structure', () => {
    const validProfile = resolveManagementProfile('trend_pullback_long').profile;
    const invalidPartial = cloneProfile(validProfile, {
      partial_exit: {
        pt1_fraction: 0.8,
        pt2_fraction: 0.5,
        runner_fraction: 0,
      },
    });
    const invalidTargets = cloneProfile(validProfile, {
      targets: [
        {
          label: 'pt1',
          action: 'TAKE_PARTIAL',
          quantity_fraction: 0.5,
          minimum_reward_risk: 2,
        },
      ],
    });
    const invalidOrdering = cloneProfile(validProfile, {
      targets: [
        {
          label: 'pt1',
          action: 'TAKE_PARTIAL',
          quantity_fraction: 0.5,
          minimum_reward_risk: 2,
        },
        {
          label: 'pt2',
          action: 'TAKE_PROFIT',
          quantity_fraction: 0.5,
          minimum_reward_risk: 1,
        },
      ],
    });

    expect(validateManagementProfile(invalidPartial)).toContainEqual({
      path: '$.partial_exit',
      code: 'invalid_partial_exit_sizing',
      message: 'pt1_fraction + pt2_fraction + runner_fraction must equal 1',
    });
    expect(validateManagementProfile(invalidTargets)).toContainEqual({
      path: '$.targets.pt2',
      code: 'missing_required_target',
      message: 'pt2 target is required',
    });
    expect(validateManagementProfile(invalidOrdering)).toContainEqual({
      path: '$.targets',
      code: 'invalid_target_order',
      message: 'pt2 minimum_reward_risk must be >= pt1 minimum_reward_risk',
    });
  });

  it('rejects candidate target ordering and missing target facts without recomputing them', () => {
    const candidate = fixtureCandidate('trend_pullback_long');
    const profile = resolveManagementProfile(candidate.strategy_id).profile;
    const missingTarget = cloneCandidate(candidate, {
      targets: candidate.targets.filter((target) => target.label !== 'pt2'),
    });
    const badOrdering = cloneCandidate(candidate, {
      targets: [
        { label: 'pt1', price: candidate.entry_price + 10, quantity_fraction: 0.5 },
        { label: 'pt2', price: candidate.entry_price + 9, quantity_fraction: 0.5 },
      ],
    });

    expect(() => getTargetPlanFromCandidate(missingTarget, profile)).toThrow(
      'candidate target pt2 missing in journaled candidate',
    );
    expect(() => getTargetPlanFromCandidate(badOrdering, profile)).toThrow(
      'long management targets must be ordered entry < pt1 < pt2',
    );
  });

  it('uses a deterministic fallback for unknown strategies and can fail closed', () => {
    const first = resolveManagementProfile('legacy_shadow_scalper');
    const second = resolveManagementProfile('legacy_shadow_scalper');

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      strategy_id: 'legacy_shadow_scalper',
      fallback_used: true,
      profile: {
        profile_id: 'fallback_management_v1',
        strategy_id: 'fallback',
      },
    });
    expect(() => resolveManagementProfile('legacy_shadow_scalper', {
      allow_fallback: false,
    })).toThrow('Unknown strategy_id for management profile: legacy_shadow_scalper');
  });

  it('keeps the management action vocabulary stable and journal-schema ready', () => {
    expect(MANAGEMENT_ACTION_TYPES).toEqual([
      'HOLD',
      'MOVE_STOP',
      'TAKE_PARTIAL',
      'TAKE_PROFIT',
      'EXIT_FULL',
      'MARK_BREAKEVEN',
      'BREAKEVEN_ARMED',
      'ACTIVATE_TRAIL',
      'FAIL_SAFE_EXIT',
      'TIME_STOP_EXIT',
    ]);

    const event = createJournalEventEnvelope({
      event_id: makeEventId('mgmt-action-upper-vocabulary'),
      type: 'MGMT_ACTION',
      ts_ns: TS_NS,
      run_id: makeRunId('run-mgmt-01'),
      session_id: makeSessionId('2026-04-23-rth'),
      causation_id: makeCausationId('mgmt-tick-1'),
      payload: {
        management_action_id: makeManagementActionId('mgmt-action-upper-vocabulary'),
        position_id: makePositionId('position-mgmt-01'),
        action_type: 'MOVE_STOP',
        reason: 'management_profile:test_move_stop',
      },
    });

    expect(validateJournalEventEnvelope(event)).toMatchObject({ ok: true, issues: [] });
  });

  it('keeps active management modules free of deterministic-output hazards', () => {
    const managementDir = join(process.cwd(), 'apps/strategy_runtime/src/management');
    const patterns = [
      'Date.now',
      'new Date(',
      'Math.random',
      'toLocaleString',
      'localeCompare',
    ];

    for (const file of readdirSync(managementDir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(managementDir, file), 'utf8');
      for (const pattern of patterns) {
        expect(source, `${file} must not contain ${pattern}`).not.toContain(pattern);
      }
    }
  });

  it('throws clear validation errors for invalid profiles', () => {
    const profile = cloneProfile(V1_MANAGEMENT_PROFILES.trend_pullback_long, {
      initial_stop: {
        ...V1_MANAGEMENT_PROFILES.trend_pullback_long.initial_stop,
        min_stop_distance_ticks: 0,
      },
    });

    expect(() => assertValidManagementProfile(profile)).toThrow(
      'management profile validation failed: $.initial_stop.min_stop_distance_ticks must be > 0',
    );
  });
});
