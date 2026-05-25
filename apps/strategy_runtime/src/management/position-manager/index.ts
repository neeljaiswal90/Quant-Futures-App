import type {
  ManagementActionEventPayload,
  ManagementTickEventPayload,
  PositionEventPayload,
} from '../../contracts/events/payloads.js';
import {
  makeManagementActionId,
  type ManagementActionId,
} from '../../contracts/ids.js';
import type { ManagementActionType } from '../../contracts/position.js';
import type { UnixNs } from '../../contracts/time.js';
import type { ManagementProfile, V1ManagementActionType } from '../types.js';
import {
  summarizeTargetPositionForJournal,
  type TargetPosition,
} from '../target-position.js';
import { evaluateFailSafe } from './fail-safe.js';
import { evaluateStopHit, maybeMoveStopToBreakEven } from './stops.js';
import { applyTargetHits, computePositionUnrealizedPnlUsd, markPt1Touched } from './targets.js';
import { evaluateTimeStop } from './time-stops.js';
import { applyTrailingStop } from './trailing.js';

export const POSITION_MANAGER_VERSION = 'position_manager_fsm_v1' as const;

export type PositionManagerFsmState =
  | 'PLANNED'
  | 'OPEN'
  | 'PARTIAL'
  | 'BREAKEVEN_ARMED'
  | 'TRAILING_ACTIVE'
  | 'EXITED'
  | 'FAILED_SAFE_EXIT'
  | 'TIME_STOP_EXIT';

export interface PositionManagerMarketInput {
  readonly event_ts_ns: UnixNs;
  readonly mark_price: number;
  readonly high_price?: number;
  readonly low_price?: number;
  readonly bid_px?: number;
  readonly ask_px?: number;
  readonly authority?: 'unknown' | 'warming' | 'authoritative' | 'stale' | 'gap';
  readonly is_stale?: boolean;
}

export interface PositionManagerActionDraft {
  readonly action_type: V1ManagementActionType;
  readonly reason: string;
  readonly new_stop_price?: number;
  readonly exit_quantity?: number;
  readonly exit_price?: number;
  readonly target_label?: 'pt1' | 'pt2' | 'runner';
  readonly realized_pnl_usd?: number;
  readonly realized_r?: number;
}

export interface PositionManagerAction {
  readonly management_action_id: ManagementActionId;
  readonly action_type: V1ManagementActionType;
  readonly reason: string;
  readonly decided_ts_ns: UnixNs;
  readonly new_stop_price?: number;
  readonly exit_quantity?: number;
  readonly exit_price?: number;
  readonly target_label?: 'pt1' | 'pt2' | 'runner';
  readonly realized_pnl_usd?: number;
  readonly realized_r?: number;
}

export interface PositionManagerStepResult {
  readonly position: TargetPosition;
  readonly actions: readonly PositionManagerActionDraft[];
  readonly reasons: readonly string[];
  readonly terminal_reason?: 'stop_hit' | 'time_stop' | 'fail_safe' | 'target_exit';
}

export interface EvaluatePositionManagerInput {
  readonly position: TargetPosition;
  readonly profile: ManagementProfile;
  readonly market: PositionManagerMarketInput;
}

export interface PositionManagerEvaluation {
  readonly version: typeof POSITION_MANAGER_VERSION;
  readonly previous_position: TargetPosition;
  readonly updated_position: TargetPosition;
  readonly fsm_state: PositionManagerFsmState;
  readonly actions: readonly PositionManagerAction[];
  readonly position_event_payload: PositionEventPayload;
  readonly management_tick_payload: ManagementTickEventPayload;
  readonly management_action_payloads: readonly ManagementActionEventPayload[];
  readonly reasons: readonly string[];
}

export function evaluatePositionManager(
  input: EvaluatePositionManagerInput,
): PositionManagerEvaluation {
  const stages: PositionManagerStepResult[] = [];
  let current = input.position;
  let terminalReason: PositionManagerStepResult['terminal_reason'];

  const failSafe = evaluateFailSafe(current, input.profile, input.market);
  stages.push(failSafe);
  current = failSafe.position;
  terminalReason = failSafe.terminal_reason;

  if (terminalReason === undefined) {
    const pt1Touch = markPt1Touched(current, input.market);
    stages.push(pt1Touch);
    current = pt1Touch.position;
  }

  if (terminalReason === undefined) {
    const stop = evaluateStopHit(current, input.market);
    stages.push(stop);
    current = stop.position;
    terminalReason = stop.terminal_reason;
  }

  if (terminalReason === undefined) {
    const targets = applyTargetHits(current, input.market);
    stages.push(targets);
    current = targets.position;
    terminalReason = targets.terminal_reason;
  }

  if (terminalReason === undefined) {
    const timeStop = evaluateTimeStop(current, input.market);
    stages.push(timeStop);
    current = timeStop.position;
    terminalReason = timeStop.terminal_reason;
  }

  if (terminalReason === undefined) {
    const breakEven = maybeMoveStopToBreakEven(current, input.market);
    stages.push(breakEven);
    current = breakEven.position;
  }

  if (terminalReason === undefined) {
    const trailing = applyTrailingStop(current, input.market);
    stages.push(trailing);
    current = trailing.position;
  }

  const actionDrafts = stages.flatMap((stage) => stage.actions);
  const actions = materializeActions(current, actionDrafts, input.market.event_ts_ns);
  const reasons = uniqueReasons(stages.flatMap((stage) => stage.reasons));
  const fsmState = derivePositionManagerFsmState(current, terminalReason);

  return {
    version: POSITION_MANAGER_VERSION,
    previous_position: input.position,
    updated_position: current,
    fsm_state: fsmState,
    actions,
    position_event_payload: toPositionEventPayload(current),
    management_tick_payload: toManagementTickEventPayload(current, input.market),
    management_action_payloads: actions.map((action) => toManagementActionEventPayload(
      current,
      action,
    )),
    reasons: reasons.length > 0 ? reasons : ['position_manager:hold'],
  };
}

export function derivePositionManagerFsmState(
  position: TargetPosition,
  terminalReason?: PositionManagerStepResult['terminal_reason'],
): PositionManagerFsmState {
  if (terminalReason === 'fail_safe') return 'FAILED_SAFE_EXIT';
  if (terminalReason === 'time_stop') return 'TIME_STOP_EXIT';
  if (position.lifecycle_state === 'closed') return 'EXITED';
  if (position.lifecycle_state === 'planned') return 'PLANNED';
  if (position.trailing_stop.active) return 'TRAILING_ACTIVE';
  if (position.break_even.moved) return 'BREAKEVEN_ARMED';
  if (position.targets.some((target) => target.status === 'filled')) return 'PARTIAL';
  return 'OPEN';
}

export function toPositionEventPayload(position: TargetPosition): PositionEventPayload {
  const summary = summarizeTargetPositionForJournal(position);
  return {
    position_id: summary.position_id,
    candidate_id: summary.candidate_id,
    side: summary.remaining_quantity > 0 ? summary.side : 'flat',
    status: summary.position_status,
    quantity_open: summary.remaining_quantity,
    avg_entry_price: summary.entry_price,
    updated_ts_ns: summary.updated_ts_ns,
    ...(summary.at_deadline_extension === undefined
      ? {}
      : { at_deadline_extension: summary.at_deadline_extension }),
  };
}

export function toManagementTickEventPayload(
  position: TargetPosition,
  market: PositionManagerMarketInput,
): ManagementTickEventPayload {
  return {
    position_id: position.position_id,
    mark_price: market.mark_price,
    unrealized_pnl_usd: computePositionUnrealizedPnlUsd(position, market.mark_price),
  };
}

export function toManagementActionEventPayload(
  position: TargetPosition,
  action: PositionManagerAction,
): ManagementActionEventPayload {
  return {
    management_action_id: action.management_action_id,
    position_id: position.position_id,
    action_type: action.action_type as ManagementActionType,
    reason: action.reason,
    ...(action.new_stop_price !== undefined ? { new_stop_price: action.new_stop_price } : {}),
    ...(action.exit_quantity !== undefined ? { exit_quantity: action.exit_quantity } : {}),
    ...(action.target_label !== undefined ? { target_label: action.target_label } : {}),
    ...(action.exit_price !== undefined ? { exit_price: action.exit_price } : {}),
    ...(action.realized_pnl_usd !== undefined ? { realized_pnl_usd: action.realized_pnl_usd } : {}),
    ...(action.realized_r !== undefined ? { realized_r: action.realized_r } : {}),
  };
}

function materializeActions(
  position: TargetPosition,
  drafts: readonly PositionManagerActionDraft[],
  eventTsNs: UnixNs,
): readonly PositionManagerAction[] {
  return drafts.map((draft, index) => ({
    management_action_id: makeManagementActionId(
      `mgmt-${position.position_id}-${eventTsNs}-${String(index + 1).padStart(2, '0')}-${draft.action_type}`,
    ),
    action_type: draft.action_type,
    reason: draft.reason,
    decided_ts_ns: eventTsNs,
    ...(draft.new_stop_price !== undefined ? { new_stop_price: draft.new_stop_price } : {}),
    ...(draft.exit_quantity !== undefined ? { exit_quantity: draft.exit_quantity } : {}),
    ...(draft.exit_price !== undefined ? { exit_price: draft.exit_price } : {}),
    ...(draft.target_label !== undefined ? { target_label: draft.target_label } : {}),
    ...(draft.realized_pnl_usd !== undefined ? { realized_pnl_usd: draft.realized_pnl_usd } : {}),
    ...(draft.realized_r !== undefined ? { realized_r: draft.realized_r } : {}),
  }));
}

function uniqueReasons(reasons: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const reason of reasons) {
    if (!seen.has(reason)) {
      seen.add(reason);
      unique.push(reason);
    }
  }
  return unique;
}
