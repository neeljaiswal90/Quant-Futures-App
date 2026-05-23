import type {
  Candidate,
  PriceTarget,
} from '../contracts/candidate.js';
import type {
  SimulatedFill,
} from '../contracts/execution.js';
import {
  makePositionId,
  type CandidateId,
  type FillId,
  type PositionId,
} from '../contracts/ids.js';
import type { Direction, InstrumentIdentity, PositionSide } from '../contracts/market.js';
import type { ManagementActionType, PositionStatus } from '../contracts/position.js';
import {
  ns,
  type UnixNs,
} from '../contracts/time.js';
import {
  computeInitialStopPolicy,
  getTargetPlanFromCandidate,
  type ManagementProfile,
  type ManagementProfileId,
} from './types.js';

const NS_PER_MINUTE = 60_000_000_000n;
const EPSILON = 0.000001;

export type TargetPositionLifecycleState = 'planned' | 'open' | 'closing' | 'closed';
export type TargetPositionTargetStatus = 'pending' | 'filled' | 'cancelled';

export interface TargetPositionTarget {
  readonly label: PriceTarget['label'];
  readonly price: number;
  readonly quantity: number;
  readonly filled_quantity: number;
  readonly quantity_fraction: number;
  readonly reward_risk: number;
  readonly minimum_reward_risk: number;
  readonly status: TargetPositionTargetStatus;
}

export interface TargetPositionBreakEvenState {
  readonly enabled: boolean;
  readonly trigger: ManagementProfile['break_even']['trigger'];
  readonly trigger_r?: number;
  readonly trigger_target_label?: PriceTarget['label'];
  readonly offset_ticks: number;
  readonly moved: boolean;
}

export interface TargetPositionTrailState {
  readonly enabled: boolean;
  readonly mode: ManagementProfile['trailing_stop']['mode'];
  readonly activation: ManagementProfile['trailing_stop']['activation'];
  readonly activation_r?: number;
  readonly activation_target_label?: PriceTarget['label'];
  readonly distance_ticks: number;
  readonly active: boolean;
}

export interface TargetPositionTimeStopState {
  readonly enabled: boolean;
  readonly max_hold_minutes: number;
  readonly opened_ts_ns: UnixNs;
  readonly deadline_ts_ns?: UnixNs;
  readonly pre_pt1_min_unrealized_r: number;
  readonly post_pt1_min_unrealized_r: number;
}

export interface TargetPositionFailSafeState {
  readonly enabled: boolean;
  readonly max_adverse_r: number;
  readonly max_spread_ticks: number;
}

export interface TargetPosition {
  readonly position_id: PositionId;
  readonly candidate_id: CandidateId;
  readonly fill_id?: FillId;
  readonly strategy_id: Candidate['strategy_id'];
  readonly instrument: InstrumentIdentity;
  readonly side: Extract<PositionSide, 'long' | 'short'>;
  readonly lifecycle_state: TargetPositionLifecycleState;
  readonly quantity: number;
  readonly remaining_quantity: number;
  readonly entry_price: number;
  readonly initial_stop_price: number;
  readonly active_stop_price: number;
  readonly risk_points: number;
  readonly pt1_touched: boolean;
  readonly targets: readonly TargetPositionTarget[];
  readonly break_even: TargetPositionBreakEvenState;
  readonly trailing_stop: TargetPositionTrailState;
  readonly time_stop: TargetPositionTimeStopState;
  readonly fail_safe: TargetPositionFailSafeState;
  readonly profile_id: ManagementProfileId;
  readonly profile_version: ManagementProfile['profile_version'];
  readonly profile_hash: ManagementProfile['profile_hash'];
  readonly opened_ts_ns: UnixNs;
  readonly updated_ts_ns: UnixNs;
  readonly realized_pnl_usd: number;
  readonly unrealized_pnl_usd: number;
  readonly reasons: readonly string[];
}

export interface BuildTargetPositionFromCandidateInput {
  readonly candidate: Candidate;
  readonly profile: ManagementProfile;
  readonly quantity: number;
  readonly opened_ts_ns: UnixNs;
  readonly position_id?: PositionId;
}

export interface ApplyExitFillToTargetPositionInput {
  readonly fill: SimulatedFill;
  readonly action_type: Extract<
    ManagementActionType,
    'TAKE_PARTIAL' | 'TAKE_PROFIT' | 'EXIT_FULL' | 'TIME_STOP_EXIT' | 'FAIL_SAFE_EXIT'
  >;
  readonly reason: string;
  readonly target_label?: PriceTarget['label'];
}

export interface PartialTargetQuantity {
  readonly label: PriceTarget['label'];
  readonly quantity: number;
  readonly quantity_fraction: number;
}

export interface ComputePartialTargetQuantitiesInput {
  readonly total_quantity: number;
  readonly profile: ManagementProfile;
}

export type TargetPositionValidationIssueCode =
  | 'invalid_field_value'
  | 'invalid_side_order'
  | 'invalid_target_order'
  | 'invalid_quantity'
  | 'invalid_profile_metadata'
  | 'invalid_lineage';

export interface TargetPositionValidationIssue {
  readonly path: string;
  readonly code: TargetPositionValidationIssueCode;
  readonly message: string;
}

export interface TargetPositionJournalSummaryTarget {
  readonly label: PriceTarget['label'];
  readonly price: number;
  readonly quantity: number;
  readonly filled_quantity: number;
  readonly reward_risk: number;
  readonly status: TargetPositionTargetStatus;
}

export interface TargetPositionJournalSummary {
  readonly position_id: PositionId;
  readonly candidate_id: CandidateId;
  readonly fill_id?: FillId;
  readonly profile_id: ManagementProfileId;
  readonly profile_version: ManagementProfile['profile_version'];
  readonly profile_hash: ManagementProfile['profile_hash'];
  readonly side: Extract<PositionSide, 'long' | 'short'>;
  readonly position_status: PositionStatus;
  readonly lifecycle_state: TargetPositionLifecycleState;
  readonly quantity: number;
  readonly remaining_quantity: number;
  readonly entry_price: number;
  readonly stop_price: number;
  readonly pt1_touched: boolean;
  readonly targets: readonly TargetPositionJournalSummaryTarget[];
  readonly realized_pnl_usd: number;
  readonly unrealized_pnl_usd: number;
  readonly updated_ts_ns: UnixNs;
}

export function buildTargetPositionFromCandidate(
  input: BuildTargetPositionFromCandidateInput,
): TargetPosition {
  return buildTargetPosition({
    candidate: input.candidate,
    profile: input.profile,
    position_id: input.position_id ?? makePositionId(`position-${input.candidate.candidate_id}`),
    quantity: input.quantity,
    entry_price: input.candidate.entry_price,
    opened_ts_ns: input.opened_ts_ns,
    updated_ts_ns: input.opened_ts_ns,
    lifecycle_state: 'planned',
  });
}

export function applyInitialFillToTargetPosition(
  position: TargetPosition,
  fill: SimulatedFill,
): TargetPosition {
  validateInitialFill(position, fill);
  const riskPoints = computeRiskPoints(position.side, fill.price, position.initial_stop_price);
  const partialQuantities = computePartialTargetQuantitiesFromFractions(
    fill.quantity,
    position.targets,
  );

  const openPosition = {
    ...position,
    fill_id: fill.fill_id,
    lifecycle_state: 'open',
    quantity: fill.quantity,
    remaining_quantity: fill.quantity,
    entry_price: fill.price,
    risk_points: riskPoints,
    pt1_touched: false,
    targets: position.targets.map((target) => {
      const quantity = partialQuantities.find((item) => item.label === target.label);
      if (quantity === undefined) {
        throw new Error(`partial quantity missing for target ${target.label}`);
      }
      return {
        ...target,
        quantity: quantity.quantity,
        filled_quantity: 0,
        reward_risk: computeTargetRewardRisk(
          position.side,
          fill.price,
          target.price,
          riskPoints,
        ),
        status: 'pending',
      };
    }),
    time_stop: {
      ...position.time_stop,
      opened_ts_ns: fill.filled_ts_ns,
      deadline_ts_ns: position.time_stop.enabled
        ? addMinutes(fill.filled_ts_ns, position.time_stop.max_hold_minutes)
        : undefined,
    },
    opened_ts_ns: fill.filled_ts_ns,
    updated_ts_ns: fill.filled_ts_ns,
    realized_pnl_usd: 0,
    unrealized_pnl_usd: 0,
    reasons: [
      ...position.reasons.filter((reason) => reason !== 'target_position:planned'),
      'target_position:open',
      'initial_fill:applied',
    ],
  } satisfies TargetPosition;

  const issues = validateTargetPosition(openPosition);
  if (issues.length > 0) {
    throw new Error(formatTargetPositionValidationErrors(issues));
  }
  return openPosition;
}

export function applyExitFillToTargetPosition(
  position: TargetPosition,
  input: ApplyExitFillToTargetPositionInput,
): TargetPosition {
  validateExitFill(position, input.fill);
  const nextRemainingQuantity = position.remaining_quantity - input.fill.quantity;
  const isFlat = nextRemainingQuantity === 0;
  const updatedTargets = updateTargetsForExit(position, {
    target_label: input.target_label,
    exit_quantity: input.fill.quantity,
    is_flat: isFlat,
  });
  const realizedPnlUsd = computeRealizedPnlUsd(position, input.fill.price, input.fill.quantity);
  const updated = {
    ...position,
    lifecycle_state: isFlat ? 'closed' : 'closing',
    remaining_quantity: nextRemainingQuantity,
    targets: updatedTargets,
    pt1_touched: position.pt1_touched || input.target_label === 'pt1',
    realized_pnl_usd: round6(position.realized_pnl_usd + realizedPnlUsd),
    unrealized_pnl_usd: isFlat
      ? 0
      : computeUnrealizedPnlUsd(position, input.fill.price, nextRemainingQuantity),
    updated_ts_ns: input.fill.filled_ts_ns,
    reasons: [
      ...position.reasons,
      `management_action:${input.action_type}:${input.reason}`,
      `exit_fill:${input.fill.fill_id}`,
    ],
  } satisfies TargetPosition;

  const issues = validateTargetPosition(updated);
  if (issues.length > 0) {
    throw new Error(formatTargetPositionValidationErrors(issues));
  }
  return updated;
}

export function computePartialTargetQuantities(
  input: ComputePartialTargetQuantitiesInput,
): readonly PartialTargetQuantity[] {
  return computePartialTargetQuantitiesFromFractions(input.total_quantity, input.profile.targets);
}

function computePartialTargetQuantitiesFromFractions(
  totalQuantity: number,
  targets: readonly { readonly label: PriceTarget['label']; readonly quantity_fraction: number }[],
): readonly PartialTargetQuantity[] {
  validatePositiveInteger(totalQuantity, 'total_quantity');
  const targetFractionTotal = round6(targets.reduce((sum, target) => sum + target.quantity_fraction, 0));
  if (targetFractionTotal > 1) {
    throw new Error('management target quantity fractions must not exceed 1');
  }

  let assignedQuantity = 0;
  return targets.map((target, index) => {
    const isLastTarget = index === targets.length - 1;
    const quantity =
      isLastTarget && targetFractionTotal === 1
        ? totalQuantity - assignedQuantity
        : Math.floor(totalQuantity * target.quantity_fraction);
    assignedQuantity += quantity;
    if (assignedQuantity > totalQuantity) {
      throw new Error('management partial target quantities exceed total quantity');
    }
    return {
      label: target.label,
      quantity,
      quantity_fraction: target.quantity_fraction,
    };
  });
}

export function validateTargetPosition(
  position: TargetPosition,
): readonly TargetPositionValidationIssue[] {
  const issues: TargetPositionValidationIssue[] = [];

  requireNonEmpty(position.position_id, '$.position_id', 'invalid_lineage', issues);
  requireNonEmpty(position.candidate_id, '$.candidate_id', 'invalid_lineage', issues);
  requireNonEmpty(position.profile_id, '$.profile_id', 'invalid_profile_metadata', issues);
  if (position.profile_version !== 1) {
    addIssue(issues, '$.profile_version', 'invalid_profile_metadata', 'must be 1');
  }
  if (position.side !== 'long' && position.side !== 'short') {
    addIssue(issues, '$.side', 'invalid_field_value', 'must be long or short');
  }
  if (!isPositiveInteger(position.quantity)) {
    addIssue(issues, '$.quantity', 'invalid_quantity', 'must be a positive integer');
  }
  if (
    !Number.isInteger(position.remaining_quantity) ||
    position.remaining_quantity < 0 ||
    position.remaining_quantity > position.quantity
  ) {
    addIssue(
      issues,
      '$.remaining_quantity',
      'invalid_quantity',
      'must be an integer between 0 and quantity',
    );
  }
  requirePositiveFinite(position.entry_price, '$.entry_price', issues);
  requirePositiveFinite(position.initial_stop_price, '$.initial_stop_price', issues);
  requirePositiveFinite(position.active_stop_price, '$.active_stop_price', issues);
  requirePositiveFinite(position.risk_points, '$.risk_points', issues);
  if (typeof position.pt1_touched !== 'boolean') {
    addIssue(issues, '$.pt1_touched', 'invalid_field_value', 'must be boolean');
  }

  validateSideMath(position, issues);
  validateTargetList(position, issues);
  validatePolicyMetadata(position, issues);

  return issues.sort(compareIssues);
}

export function summarizeTargetPositionForJournal(
  position: TargetPosition,
): TargetPositionJournalSummary {
  const issues = validateTargetPosition(position);
  if (issues.length > 0) {
    throw new Error(formatTargetPositionValidationErrors(issues));
  }
  return {
    position_id: position.position_id,
    candidate_id: position.candidate_id,
    fill_id: position.fill_id,
    profile_id: position.profile_id,
    profile_version: position.profile_version,
    profile_hash: position.profile_hash,
    side: position.side,
    position_status: toPositionStatus(position.lifecycle_state),
    lifecycle_state: position.lifecycle_state,
    quantity: position.quantity,
    remaining_quantity: position.remaining_quantity,
    entry_price: position.entry_price,
    stop_price: position.active_stop_price,
    pt1_touched: position.pt1_touched,
    targets: position.targets.map((target) => ({
      label: target.label,
      price: target.price,
      quantity: target.quantity,
      filled_quantity: target.filled_quantity,
      reward_risk: target.reward_risk,
      status: target.status,
    })),
    realized_pnl_usd: position.realized_pnl_usd,
    unrealized_pnl_usd: position.unrealized_pnl_usd,
    updated_ts_ns: position.updated_ts_ns,
  };
}

export function formatTargetPositionValidationErrors(
  issues: readonly TargetPositionValidationIssue[],
): string {
  return `target position validation failed: ${issues
    .map((issue) => `${issue.path} ${issue.message}`)
    .join('; ')}`;
}

function buildTargetPosition(input: {
  readonly candidate: Candidate;
  readonly profile: ManagementProfile;
  readonly position_id: PositionId;
  readonly quantity: number;
  readonly entry_price: number;
  readonly opened_ts_ns: UnixNs;
  readonly updated_ts_ns: UnixNs;
  readonly lifecycle_state: TargetPositionLifecycleState;
  readonly fill_id?: FillId;
}): TargetPosition {
  validatePositiveInteger(input.quantity, 'quantity');
  const stopPolicy = computeInitialStopPolicy(input.candidate, input.profile);
  const targetPlan = getTargetPlanFromCandidate(input.candidate, input.profile);
  const side = input.candidate.direction;
  const riskPoints = computeRiskPoints(side, input.entry_price, stopPolicy.stop_price);
  const partialQuantities = computePartialTargetQuantities({
    total_quantity: input.quantity,
    profile: input.profile,
  });
  const targets = targetPlan.targets.map((target) => {
    const quantity = partialQuantities.find((item) => item.label === target.label);
    if (quantity === undefined) {
      throw new Error(`partial quantity missing for target ${target.label}`);
    }
    return {
      label: target.label,
      price: target.price,
      quantity: quantity.quantity,
      filled_quantity: 0,
      quantity_fraction: quantity.quantity_fraction,
      reward_risk: computeTargetRewardRisk(side, input.entry_price, target.price, riskPoints),
      minimum_reward_risk: target.minimum_reward_risk,
      status: 'pending',
    } satisfies TargetPositionTarget;
  });
  const assignedTargetQuantity = targets.reduce((sum, target) => sum + target.quantity, 0);

  const position = {
    position_id: input.position_id,
    candidate_id: input.candidate.candidate_id,
    fill_id: input.fill_id,
    strategy_id: input.candidate.strategy_id,
    instrument: input.candidate.instrument,
    side,
    lifecycle_state: input.lifecycle_state,
    quantity: input.quantity,
    remaining_quantity: input.quantity,
    entry_price: input.entry_price,
    initial_stop_price: stopPolicy.stop_price,
    active_stop_price: stopPolicy.stop_price,
    risk_points: riskPoints,
    pt1_touched: false,
    targets,
    break_even: {
      enabled: input.profile.break_even.enabled,
      trigger: input.profile.break_even.trigger,
      trigger_r: input.profile.break_even.trigger_r,
      trigger_target_label:
        input.profile.break_even.trigger === 'after_pt1' ? 'pt1' : undefined,
      offset_ticks: input.profile.break_even.offset_ticks,
      moved: false,
    },
    trailing_stop: {
      enabled: input.profile.trailing_stop.enabled,
      mode: input.profile.trailing_stop.mode,
      activation: input.profile.trailing_stop.activation,
      activation_r: input.profile.trailing_stop.activation_r,
      activation_target_label:
        input.profile.trailing_stop.activation === 'after_pt1' ? 'pt1' : undefined,
      distance_ticks: input.profile.trailing_stop.distance_ticks,
      active: false,
    },
    time_stop: {
      enabled: input.profile.time_stop.enabled,
      max_hold_minutes: input.profile.time_stop.max_hold_minutes,
      opened_ts_ns: input.opened_ts_ns,
      deadline_ts_ns: input.profile.time_stop.enabled
        ? addMinutes(input.opened_ts_ns, input.profile.time_stop.max_hold_minutes)
        : undefined,
      pre_pt1_min_unrealized_r: input.profile.time_stop.pre_pt1_min_unrealized_r,
      post_pt1_min_unrealized_r: input.profile.time_stop.post_pt1_min_unrealized_r,
    },
    fail_safe: {
      enabled: input.profile.fail_safe.enabled,
      max_adverse_r: input.profile.fail_safe.max_adverse_r,
      max_spread_ticks: input.profile.fail_safe.max_spread_ticks,
    },
    profile_id: input.profile.profile_id,
    profile_version: input.profile.profile_version,
    profile_hash: input.profile.profile_hash,
    opened_ts_ns: input.opened_ts_ns,
    updated_ts_ns: input.updated_ts_ns,
    realized_pnl_usd: 0,
    unrealized_pnl_usd: 0,
    reasons: [
      `management_profile:${input.profile.profile_id}`,
      `target_position:${input.lifecycle_state}`,
      `partials_assigned:${assignedTargetQuantity}`,
    ],
  } satisfies TargetPosition;

  const issues = validateTargetPosition(position);
  if (issues.length > 0) {
    throw new Error(formatTargetPositionValidationErrors(issues));
  }
  return position;
}

function validateInitialFill(position: TargetPosition, fill: SimulatedFill): void {
  if (fill.instrument.symbol !== position.instrument.symbol) {
    throw new Error('initial fill instrument does not match target position instrument');
  }
  const expectedSide = position.side === 'long' ? 'buy' : 'sell';
  if (fill.side !== expectedSide) {
    throw new Error(`initial fill side ${fill.side} does not match target position ${position.side}`);
  }
  validatePositiveInteger(fill.quantity, 'fill.quantity');
  if (!Number.isFinite(fill.price) || fill.price <= 0) {
    throw new Error('fill.price must be positive finite');
  }
}

function validateExitFill(position: TargetPosition, fill: SimulatedFill): void {
  if (position.lifecycle_state === 'closed' || position.remaining_quantity <= 0) {
    throw new Error('exit fill cannot apply to a closed target position');
  }
  if (fill.instrument.symbol !== position.instrument.symbol) {
    throw new Error('exit fill instrument does not match target position instrument');
  }
  const expectedSide = position.side === 'long' ? 'sell' : 'buy';
  if (fill.side !== expectedSide) {
    throw new Error(`exit fill side ${fill.side} does not close target position ${position.side}`);
  }
  validatePositiveInteger(fill.quantity, 'fill.quantity');
  if (fill.quantity > position.remaining_quantity) {
    throw new Error('exit fill quantity exceeds target position remaining quantity');
  }
  if (!Number.isFinite(fill.price) || fill.price <= 0) {
    throw new Error('fill.price must be positive finite');
  }
}

function updateTargetsForExit(
  position: TargetPosition,
  input: {
    readonly target_label?: PriceTarget['label'];
    readonly exit_quantity: number;
    readonly is_flat: boolean;
  },
): readonly TargetPositionTarget[] {
  return position.targets.map((target) => {
    if (input.target_label !== undefined && target.label === input.target_label) {
      const filledQuantity = Math.min(target.quantity, target.filled_quantity + input.exit_quantity);
      return {
        ...target,
        filled_quantity: filledQuantity,
        status: filledQuantity >= target.quantity ? 'filled' : target.status,
      } satisfies TargetPositionTarget;
    }
    if (input.is_flat && target.status === 'pending') {
      return {
        ...target,
        status: 'cancelled',
      } satisfies TargetPositionTarget;
    }
    return target;
  });
}

function computeRealizedPnlUsd(
  position: TargetPosition,
  exitPrice: number,
  quantity: number,
): number {
  const points =
    position.side === 'long'
      ? exitPrice - position.entry_price
      : position.entry_price - exitPrice;
  return round6(points * quantity * position.instrument.point_value);
}

function computeUnrealizedPnlUsd(
  position: TargetPosition,
  markPrice: number,
  quantity: number,
): number {
  const points =
    position.side === 'long'
      ? markPrice - position.entry_price
      : position.entry_price - markPrice;
  return round6(points * quantity * position.instrument.point_value);
}

function computeRiskPoints(side: Direction, entry: number, stop: number): number {
  if (!Number.isFinite(entry) || !Number.isFinite(stop)) {
    throw new Error('entry and stop must be finite');
  }
  const risk = side === 'long' ? entry - stop : stop - entry;
  if (risk <= 0) {
    throw new Error(`${side} target position has invalid stop/entry ordering`);
  }
  return round6(risk);
}

function computeTargetRewardRisk(
  side: Direction,
  entry: number,
  target: number,
  riskPoints: number,
): number {
  const reward = side === 'long' ? target - entry : entry - target;
  return round6(reward / riskPoints);
}

function validateSideMath(
  position: TargetPosition,
  issues: TargetPositionValidationIssue[],
): void {
  if (position.side === 'long' && position.initial_stop_price >= position.entry_price) {
    addIssue(issues, '$.initial_stop_price', 'invalid_side_order', 'long stop must be below entry');
  }
  if (position.side === 'short' && position.initial_stop_price <= position.entry_price) {
    addIssue(issues, '$.initial_stop_price', 'invalid_side_order', 'short stop must be above entry');
  }
  const expectedRisk =
    position.side === 'long'
      ? position.entry_price - position.initial_stop_price
      : position.initial_stop_price - position.entry_price;
  if (Number.isFinite(expectedRisk) && Math.abs(round6(expectedRisk) - position.risk_points) > EPSILON) {
    addIssue(issues, '$.risk_points', 'invalid_field_value', 'does not match entry-stop distance');
  }
}

function validateTargetList(
  position: TargetPosition,
  issues: TargetPositionValidationIssue[],
): void {
  const pt1 = position.targets.find((target) => target.label === 'pt1');
  const pt2 = position.targets.find((target) => target.label === 'pt2');
  if (pt1 === undefined) {
    addIssue(issues, '$.targets.pt1', 'invalid_target_order', 'pt1 target is required');
  }
  if (pt2 === undefined) {
    addIssue(issues, '$.targets.pt2', 'invalid_target_order', 'pt2 target is required');
  }

  let targetQuantityTotal = 0;
  position.targets.forEach((target, index) => {
    const path = `$.targets[${index}]`;
    requirePositiveFinite(target.price, `${path}.price`, issues);
    if (!Number.isInteger(target.quantity) || target.quantity < 0) {
      addIssue(issues, `${path}.quantity`, 'invalid_quantity', 'must be a non-negative integer');
    }
    if (!Number.isInteger(target.filled_quantity) || target.filled_quantity < 0) {
      addIssue(issues, `${path}.filled_quantity`, 'invalid_quantity', 'must be a non-negative integer');
    }
    if (target.filled_quantity > target.quantity) {
      addIssue(issues, `${path}.filled_quantity`, 'invalid_quantity', 'must be <= quantity');
    }
    targetQuantityTotal += target.quantity;
    const reward = computeTargetRewardRisk(
      position.side,
      position.entry_price,
      target.price,
      position.risk_points,
    );
    if (Math.abs(reward - target.reward_risk) > EPSILON) {
      addIssue(issues, `${path}.reward_risk`, 'invalid_field_value', 'does not match target geometry');
    }
    if (position.side === 'long' && target.price <= position.entry_price) {
      addIssue(issues, `${path}.price`, 'invalid_side_order', 'long targets must be above entry');
    }
    if (position.side === 'short' && target.price >= position.entry_price) {
      addIssue(issues, `${path}.price`, 'invalid_side_order', 'short targets must be below entry');
    }
  });

  if (targetQuantityTotal > position.quantity) {
    addIssue(issues, '$.targets', 'invalid_quantity', 'target quantities exceed total quantity');
  }
  if (pt1 !== undefined && pt2 !== undefined) {
    if (position.side === 'long' && pt2.price <= pt1.price) {
      addIssue(issues, '$.targets', 'invalid_target_order', 'long target order must be pt1 < pt2');
    }
    if (position.side === 'short' && pt2.price >= pt1.price) {
      addIssue(issues, '$.targets', 'invalid_target_order', 'short target order must be pt1 > pt2');
    }
  }
}

function validatePolicyMetadata(
  position: TargetPosition,
  issues: TargetPositionValidationIssue[],
): void {
  if (position.break_even.enabled && position.break_even.offset_ticks < 0) {
    addIssue(issues, '$.break_even.offset_ticks', 'invalid_field_value', 'must be >= 0');
  }
  if (position.trailing_stop.enabled && position.trailing_stop.distance_ticks <= 0) {
    addIssue(issues, '$.trailing_stop.distance_ticks', 'invalid_field_value', 'must be > 0');
  }
  if (position.time_stop.enabled) {
    if (position.time_stop.max_hold_minutes <= 0) {
      addIssue(issues, '$.time_stop.max_hold_minutes', 'invalid_field_value', 'must be > 0');
    }
    if (position.time_stop.deadline_ts_ns === undefined) {
      addIssue(issues, '$.time_stop.deadline_ts_ns', 'invalid_field_value', 'is required when enabled');
    }
  }
  if (position.fail_safe.enabled) {
    if (position.fail_safe.max_adverse_r <= 0) {
      addIssue(issues, '$.fail_safe.max_adverse_r', 'invalid_field_value', 'must be > 0');
    }
    if (position.fail_safe.max_spread_ticks <= 0) {
      addIssue(issues, '$.fail_safe.max_spread_ticks', 'invalid_field_value', 'must be > 0');
    }
  }
}

function toPositionStatus(lifecycleState: TargetPositionLifecycleState): PositionStatus {
  if (lifecycleState === 'closing') return 'closing';
  if (lifecycleState === 'closed') return 'closed';
  return 'open';
}

function addMinutes(timestamp: UnixNs, minutes: number): UnixNs {
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new Error('time-stop minutes must be a non-negative integer');
  }
  return ns(BigInt(timestamp) + BigInt(minutes) * NS_PER_MINUTE);
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function validatePositiveInteger(value: number, label: string): void {
  if (!isPositiveInteger(value)) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function requirePositiveFinite(
  value: number,
  path: string,
  issues: TargetPositionValidationIssue[],
): void {
  if (!Number.isFinite(value) || value <= 0) {
    addIssue(issues, path, 'invalid_field_value', 'must be positive finite');
  }
}

function requireNonEmpty(
  value: unknown,
  path: string,
  code: TargetPositionValidationIssueCode,
  issues: TargetPositionValidationIssue[],
): void {
  if (typeof value !== 'string' || value.trim() === '') {
    addIssue(issues, path, code, 'must be a non-empty string');
  }
}

function addIssue(
  issues: TargetPositionValidationIssue[],
  path: string,
  code: TargetPositionValidationIssueCode,
  message: string,
): void {
  issues.push({ path, code, message });
}

function compareIssues(
  left: TargetPositionValidationIssue,
  right: TargetPositionValidationIssue,
): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  if (left.code < right.code) return -1;
  if (left.code > right.code) return 1;
  if (left.message < right.message) return -1;
  if (left.message > right.message) return 1;
  return 0;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
