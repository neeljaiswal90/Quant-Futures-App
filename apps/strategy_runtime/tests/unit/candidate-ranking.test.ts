import { describe, expect, it } from 'vitest';
import {
  makeCandidateId,
  type Candidate,
  type StrategyId,
} from '../../src/contracts/index.js';
import {
  getActiveStrategyGenerator,
  rankCandidates,
  toRankEventPayload,
} from '../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../fixtures/strategies/synthetic-feature-snapshots.js';

const STRATEGY_IDS = [
  'trend_pullback_long',
  'trend_pullback_short',
  'breakout_retest_long',
  'breakdown_retest_short',
] as const satisfies readonly StrategyId[];

function generateCandidate(strategyId: StrategyId): Candidate {
  const result = getActiveStrategyGenerator(strategyId)({
    strategy_id: strategyId,
    snapshot: STRATEGY_SYNTHETIC_FIXTURES[strategyId].snapshot,
  });
  if (result.candidate === undefined) {
    throw new Error(`expected ${strategyId} fixture to emit a candidate`);
  }
  return result.candidate;
}

function generateAllFixtureCandidates(): readonly Candidate[] {
  return STRATEGY_IDS.map(generateCandidate);
}

function cloneCandidate(
  candidate: Candidate,
  overrides: Partial<Candidate>,
): Candidate {
  return {
    ...candidate,
    ...overrides,
  };
}

describe('STRAT-06 deterministic candidate ranking', () => {
  it('ranks all four V1 strategy candidates with deterministic score and tie-break metadata', () => {
    const result = rankCandidates({
      candidates: generateAllFixtureCandidates(),
    });

    expect(result.method).toBe('deterministic_v1_confidence_rr_risk_tiebreak_v1');
    expect(result.ranked_candidate_ids).toEqual([
      'candidate-fixture_trend_pullback_short-trend_pullback_short',
      'candidate-fixture_trend_pullback_long-trend_pullback_long',
      'candidate-fixture_breakout_retest_long-breakout_retest_long',
      'candidate-fixture_breakdown_retest_short-breakdown_retest_short',
    ]);
    expect(result.ranked_candidates.map((candidate) => candidate.rank)).toEqual([1, 2, 3, 4]);
    expect(result.ranked_candidates.map((candidate) => candidate.score)).toEqual([
      117.79855,
      116.78725,
      112.804575,
      112.245387,
    ]);
    expect(result.ranked_candidates[0]?.tie_break_keys).toEqual(
      expect.arrayContaining([
        'confidence:0.8372',
        'pt1_rr:2.2203',
        'pt2_rr:3.9831',
        'risk_points:7.375',
      ]),
    );
  });

  it('is stable across different input orders', () => {
    const candidates = generateAllFixtureCandidates();
    const first = rankCandidates({
      candidates,
    });
    const second = rankCandidates({
      candidates: [candidates[3]!, candidates[1]!, candidates[0]!, candidates[2]!],
    });

    expect(second.ranked_candidate_ids).toEqual(first.ranked_candidate_ids);
    expect(second.ranked_candidates).toEqual(first.ranked_candidates);
  });

  it('converts ranking results into the OBS-01 RANK payload shape', () => {
    const result = rankCandidates({
      candidates: generateAllFixtureCandidates(),
      limit: 2,
    });

    expect(toRankEventPayload(result)).toEqual({
      method: 'deterministic_v1_confidence_rr_risk_tiebreak_v1',
      ranked_candidate_ids: [
        'candidate-fixture_trend_pullback_short-trend_pullback_short',
        'candidate-fixture_trend_pullback_long-trend_pullback_long',
      ],
    });
  });

  it('ignores non-proposed candidates and keeps ignored ids deterministically sorted', () => {
    const candidates = generateAllFixtureCandidates();
    const expired = cloneCandidate(candidates[0]!, {
      candidate_id: makeCandidateId('candidate-z-expired'),
      status: 'expired',
    });
    const riskRejected = cloneCandidate(candidates[1]!, {
      candidate_id: makeCandidateId('candidate-a-risk-rejected'),
      status: 'risk_rejected',
    });

    const result = rankCandidates({
      candidates: [expired, ...candidates.slice(2), riskRejected],
    });

    expect(result.ignored_candidate_ids).toEqual([
      'candidate-a-risk-rejected',
      'candidate-z-expired',
    ]);
    expect(result.ranked_candidate_ids).not.toContain('candidate-a-risk-rejected');
    expect(result.ranked_candidate_ids).not.toContain('candidate-z-expired');
  });

  it('uses strategy priority and candidate id as final deterministic tie breakers', () => {
    const base = generateCandidate('trend_pullback_long');
    const trendLong = cloneCandidate(base, {
      candidate_id: makeCandidateId('candidate-c'),
      strategy_id: 'trend_pullback_long',
      setup_type: 'trend_pullback_long',
    });
    const trendShort = cloneCandidate(base, {
      candidate_id: makeCandidateId('candidate-b'),
      strategy_id: 'trend_pullback_short',
      setup_type: 'trend_pullback_short',
    });
    const anotherTrendLong = cloneCandidate(base, {
      candidate_id: makeCandidateId('candidate-a'),
      strategy_id: 'trend_pullback_long',
      setup_type: 'trend_pullback_long',
    });

    expect(rankCandidates({
      candidates: [trendShort, trendLong],
    }).ranked_candidate_ids).toEqual([
      'candidate-c',
      'candidate-b',
    ]);
    expect(rankCandidates({
      candidates: [trendLong, anotherTrendLong],
    }).ranked_candidate_ids).toEqual([
      'candidate-a',
      'candidate-c',
    ]);
  });

  it('rejects non-positive or fractional limits', () => {
    expect(() => rankCandidates({
      candidates: generateAllFixtureCandidates(),
      limit: 0,
    })).toThrow('candidate ranking limit must be a positive integer');
    expect(() => rankCandidates({
      candidates: generateAllFixtureCandidates(),
      limit: 1.5,
    })).toThrow('candidate ranking limit must be a positive integer');
  });
});
