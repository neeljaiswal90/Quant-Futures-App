import type { CandidateSetup, SetupFamily, SetupType, StrategyEvaluation } from '../../contracts/candidate.js';

export function buildStrategyRejection(
  setupType: SetupType,
  setupFamily: SetupFamily,
  reason: string,
): StrategyEvaluation {
  return {
    setupType,
    setupFamily,
    candidate: null,
    rejectionReasonPrimary: reason,
    rejectionReasonAll: [reason],
  };
}

export function withSetupCandidate(
  setupType: SetupType,
  setupFamily: SetupFamily,
  candidate: CandidateSetup,
): StrategyEvaluation {
  return {
    setupType,
    setupFamily,
    candidate,
    rejectionReasonPrimary: null,
    rejectionReasonAll: [],
  };
}
