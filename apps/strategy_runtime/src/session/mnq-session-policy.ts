import type { SessionPhase } from '../contracts/market.js';
import type { UnixNs } from '../contracts/time.js';
import {
  getMnqSessionPhase,
  type MnqSessionBlockReason,
  type MnqSessionCalendarConfig,
  type MnqSessionPhase,
} from './mnq-session-calendar.js';
import {
  evaluateRoll,
  type MnqRollCalendarConfig,
  type MnqRollPhase,
  type MnqRollReasonCode,
} from './mnq-roll-calendar.js';

export type MnqEligibilityReason = MnqSessionBlockReason | MnqRollReasonCode;

export interface MnqSessionEligibility {
  readonly timestamp_ns: UnixNs;
  readonly active_contract: string;
  readonly next_contract?: string;
  readonly session_phase: MnqSessionPhase;
  readonly journal_phase: SessionPhase;
  readonly roll_phase: MnqRollPhase;
  readonly candidate_eligible: boolean;
  readonly block_reason?: MnqEligibilityReason;
  readonly reasons: readonly MnqEligibilityReason[];
  readonly flatten_required: boolean;
  readonly trading_date: string;
  readonly session_id: string;
  readonly local_date: string;
  readonly local_time: string;
  readonly summary: MnqSessionEligibilitySummary;
}

export interface MnqSessionEligibilitySummary {
  readonly instrument_root: 'MNQ';
  readonly exchange: 'CME';
  readonly active_contract: string;
  readonly next_contract?: string;
  readonly session_phase: MnqSessionPhase;
  readonly journal_phase: SessionPhase;
  readonly roll_phase: MnqRollPhase;
  readonly candidate_eligible: boolean;
  readonly flatten_required: boolean;
  readonly block_reason?: MnqEligibilityReason;
  readonly reasons: readonly MnqEligibilityReason[];
}

export function evaluateMnqSessionEligibility(input: {
  readonly sessionCalendar: MnqSessionCalendarConfig;
  readonly rollCalendar: MnqRollCalendarConfig;
  readonly timestamp_ns: UnixNs;
}): MnqSessionEligibility {
  const session = getMnqSessionPhase(input.sessionCalendar, input.timestamp_ns);
  const roll = evaluateRoll(input.rollCalendar, input.timestamp_ns);
  const reasons = [...session.reasons, ...roll.reasons] satisfies MnqEligibilityReason[];
  const candidateEligible = session.candidate_eligible && !roll.block_new_entries && !roll.flatten_required;
  const blockReason = reasons[0];
  const summary: MnqSessionEligibilitySummary = {
    instrument_root: 'MNQ',
    exchange: 'CME',
    active_contract: roll.active_contract,
    ...(roll.next_contract === undefined ? {} : { next_contract: roll.next_contract }),
    session_phase: session.phase,
    journal_phase: session.journal_phase,
    roll_phase: roll.roll_phase,
    candidate_eligible: candidateEligible,
    flatten_required: roll.flatten_required,
    ...(blockReason === undefined ? {} : { block_reason: blockReason }),
    reasons,
  };
  return {
    timestamp_ns: input.timestamp_ns,
    active_contract: roll.active_contract,
    ...(roll.next_contract === undefined ? {} : { next_contract: roll.next_contract }),
    session_phase: session.phase,
    journal_phase: session.journal_phase,
    roll_phase: roll.roll_phase,
    candidate_eligible: candidateEligible,
    ...(blockReason === undefined ? {} : { block_reason: blockReason }),
    reasons,
    flatten_required: roll.flatten_required,
    trading_date: session.trading_date,
    session_id: session.session_id,
    local_date: session.local.date,
    local_time: session.local.time,
    summary,
  };
}
