import type { Candidate, RewardRiskTarget } from '../contracts/candidate.js';
import type { CandidateId } from '../contracts/ids.js';
import type { RankEventPayload } from '../contracts/events/payloads.js';
import type { StrategyId } from '../contracts/strategy-ids.js';

export const CANDIDATE_RANKING_METHOD = 'deterministic_v1_confidence_rr_risk_tiebreak_v1' as const;

export const CANDIDATE_RANKING_DEFAULTS = {
  confidence_weight: 100,
  pt1_reward_risk_weight: 10,
  pt2_reward_risk_weight: 2,
  max_reward_risk_weight: 1,
  risk_points_penalty_weight: 0.01,
} as const;

export const STRATEGY_TIE_BREAK_PRIORITY: Readonly<Record<StrategyId, number>> = {
  trend_pullback_long: 10,
  trend_pullback_short: 20,
  breakout_retest_long: 30,
  breakdown_retest_short: 40,
} as const;

export interface CandidateRankingInput {
  readonly candidates: readonly Candidate[];
  readonly limit?: number;
}

export interface CandidateRankingFeatureVector {
  readonly confidence: number;
  readonly pt1_reward_risk: number;
  readonly pt2_reward_risk: number;
  readonly max_reward_risk: number;
  readonly risk_points: number;
  readonly strategy_priority: number;
  readonly candidate_id: CandidateId;
}

export interface RankedCandidate {
  readonly rank: number;
  readonly candidate: Candidate;
  readonly candidate_id: CandidateId;
  readonly strategy_id: StrategyId;
  readonly score: number;
  readonly features: CandidateRankingFeatureVector;
  readonly tie_break_keys: readonly string[];
}

export interface CandidateRankingResult {
  readonly method: typeof CANDIDATE_RANKING_METHOD;
  readonly ranked_candidate_ids: readonly CandidateId[];
  readonly ranked_candidates: readonly RankedCandidate[];
  readonly ignored_candidate_ids: readonly CandidateId[];
}

interface CandidateWithRankFeatures {
  readonly candidate: Candidate;
  readonly features: CandidateRankingFeatureVector;
  readonly score: number;
}

export function rankCandidates(input: CandidateRankingInput): CandidateRankingResult {
  const proposedCandidates = input.candidates.filter((candidate) => candidate.status === 'proposed');
  const ignoredCandidateIds = input.candidates
    .filter((candidate) => candidate.status !== 'proposed')
    .map((candidate) => candidate.candidate_id)
    .sort(compareCandidateIds);

  const ranked = proposedCandidates
    .map(toCandidateWithRankFeatures)
    .sort(compareCandidatesForRanking)
    .slice(0, normalizeLimit(input.limit))
    .map((rankedCandidate, index): RankedCandidate => ({
      rank: index + 1,
      candidate: rankedCandidate.candidate,
      candidate_id: rankedCandidate.candidate.candidate_id,
      strategy_id: rankedCandidate.candidate.strategy_id,
      score: rankedCandidate.score,
      features: rankedCandidate.features,
      tie_break_keys: [
        `score:${rankedCandidate.score}`,
        `confidence:${rankedCandidate.features.confidence}`,
        `pt1_rr:${rankedCandidate.features.pt1_reward_risk}`,
        `pt2_rr:${rankedCandidate.features.pt2_reward_risk}`,
        `max_rr:${rankedCandidate.features.max_reward_risk}`,
        `risk_points:${rankedCandidate.features.risk_points}`,
        `strategy_priority:${rankedCandidate.features.strategy_priority}`,
        `candidate_id:${rankedCandidate.features.candidate_id}`,
      ],
    }));

  return {
    method: CANDIDATE_RANKING_METHOD,
    ranked_candidate_ids: ranked.map((candidate) => candidate.candidate_id),
    ranked_candidates: ranked,
    ignored_candidate_ids: ignoredCandidateIds,
  };
}

export function toRankEventPayload(result: CandidateRankingResult): RankEventPayload {
  return {
    ranked_candidate_ids: result.ranked_candidate_ids,
    method: result.method,
  };
}

function toCandidateWithRankFeatures(candidate: Candidate): CandidateWithRankFeatures {
  const features = extractRankingFeatures(candidate);
  return {
    candidate,
    features,
    score: computeCandidateRankingScore(features),
  };
}

function extractRankingFeatures(candidate: Candidate): CandidateRankingFeatureVector {
  const pt1RewardRisk = getRewardRisk(candidate.reward_risk, 'pt1');
  const pt2RewardRisk = getRewardRisk(candidate.reward_risk, 'pt2');
  const maxRewardRisk = candidate.reward_risk.reduce(
    (max, target) => Math.max(max, normalizeFiniteNumber(target.reward_risk)),
    0,
  );

  return {
    confidence: normalizeFiniteNumber(candidate.confidence),
    pt1_reward_risk: pt1RewardRisk,
    pt2_reward_risk: pt2RewardRisk,
    max_reward_risk: maxRewardRisk,
    risk_points: normalizeFiniteNumber(candidate.risk_points),
    strategy_priority: STRATEGY_TIE_BREAK_PRIORITY[candidate.strategy_id],
    candidate_id: candidate.candidate_id,
  };
}

function computeCandidateRankingScore(features: CandidateRankingFeatureVector): number {
  return round6(
    features.confidence * CANDIDATE_RANKING_DEFAULTS.confidence_weight
    + features.pt1_reward_risk * CANDIDATE_RANKING_DEFAULTS.pt1_reward_risk_weight
    + features.pt2_reward_risk * CANDIDATE_RANKING_DEFAULTS.pt2_reward_risk_weight
    + features.max_reward_risk * CANDIDATE_RANKING_DEFAULTS.max_reward_risk_weight
    - features.risk_points * CANDIDATE_RANKING_DEFAULTS.risk_points_penalty_weight,
  );
}

function compareCandidatesForRanking(
  left: CandidateWithRankFeatures,
  right: CandidateWithRankFeatures,
): number {
  return (
    compareDescending(left.score, right.score)
    || compareDescending(left.features.confidence, right.features.confidence)
    || compareDescending(left.features.pt1_reward_risk, right.features.pt1_reward_risk)
    || compareDescending(left.features.pt2_reward_risk, right.features.pt2_reward_risk)
    || compareDescending(left.features.max_reward_risk, right.features.max_reward_risk)
    || compareAscending(left.features.risk_points, right.features.risk_points)
    || compareAscending(left.features.strategy_priority, right.features.strategy_priority)
    || compareCandidateIds(left.features.candidate_id, right.features.candidate_id)
  );
}

function getRewardRisk(
  rewardRiskTargets: readonly RewardRiskTarget[],
  label: RewardRiskTarget['label'],
): number {
  return normalizeFiniteNumber(
    rewardRiskTargets.find((target) => target.label === label)?.reward_risk ?? 0,
  );
}

function normalizeFiniteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('candidate ranking limit must be a positive integer');
  }
  return limit;
}

function compareDescending(left: number, right: number): number {
  if (left > right) return -1;
  if (left < right) return 1;
  return 0;
}

function compareAscending(left: number, right: number): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareCandidateIds(left: CandidateId, right: CandidateId): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
