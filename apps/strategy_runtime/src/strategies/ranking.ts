import type { Candidate, RewardRiskTarget } from '../contracts/candidate.js';
import type { CandidateId } from '../contracts/ids.js';
import type { RankEventPayload } from '../contracts/events/payloads.js';
import type { StrategyId } from '../contracts/strategy-ids.js';
import {
  CANDIDATE_RANKING_METHOD,
  DEFAULT_CANDIDATE_RANKING_CONFIG,
  getCandidateRankingParameters,
  type CandidateRankingParameters,
  type StrategyRuntimeConfig,
} from '../config/index.js';

export { CANDIDATE_RANKING_METHOD };
export const CANDIDATE_RANKING_DEFAULTS = DEFAULT_CANDIDATE_RANKING_CONFIG;
export const STRATEGY_TIE_BREAK_PRIORITY = DEFAULT_CANDIDATE_RANKING_CONFIG.strategy_priority;

export interface CandidateRankingInput {
  readonly candidates: readonly Candidate[];
  readonly limit?: number;
  readonly strategy_config?: StrategyRuntimeConfig;
  readonly ranking_config?: CandidateRankingParameters;
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
  const rankingConfig = input.ranking_config ?? getCandidateRankingParameters(input.strategy_config);
  const proposedCandidates = input.candidates.filter((candidate) => candidate.status === 'proposed');
  const ignoredCandidateIds = input.candidates
    .filter((candidate) => candidate.status !== 'proposed')
    .map((candidate) => candidate.candidate_id)
    .sort(compareCandidateIds);

  const ranked = proposedCandidates
    .map((candidate) => toCandidateWithRankFeatures(candidate, rankingConfig))
    .sort((left, right) => compareCandidatesForRanking(left, right, rankingConfig))
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

function toCandidateWithRankFeatures(
  candidate: Candidate,
  rankingConfig: CandidateRankingParameters,
): CandidateWithRankFeatures {
  const features = extractRankingFeatures(candidate, rankingConfig);
  return {
    candidate,
    features,
    score: computeCandidateRankingScore(features, rankingConfig),
  };
}

function extractRankingFeatures(
  candidate: Candidate,
  rankingConfig: CandidateRankingParameters,
): CandidateRankingFeatureVector {
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
    strategy_priority: rankingConfig.strategy_priority[candidate.strategy_id],
    candidate_id: candidate.candidate_id,
  };
}

function computeCandidateRankingScore(
  features: CandidateRankingFeatureVector,
  rankingConfig: CandidateRankingParameters,
): number {
  return round6(
    features.confidence * rankingConfig.confidence_weight
    + features.pt1_reward_risk * rankingConfig.pt1_reward_risk_weight
    + features.pt2_reward_risk * rankingConfig.pt2_reward_risk_weight
    + features.max_reward_risk * rankingConfig.max_reward_risk_weight
    - features.risk_points * rankingConfig.risk_points_penalty_weight,
  );
}

function compareCandidatesForRanking(
  left: CandidateWithRankFeatures,
  right: CandidateWithRankFeatures,
  rankingConfig: CandidateRankingParameters,
): number {
  void rankingConfig;
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
