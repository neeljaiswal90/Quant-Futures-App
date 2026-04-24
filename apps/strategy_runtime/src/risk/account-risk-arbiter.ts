import type { SessionId } from '../contracts/ids.js';
import type { UnixNs } from '../contracts/time.js';

export const SESSION_RISK_ARBITER_VERSION = 'session_risk_arbiter_v1' as const;

export type CircuitBreakerState = 'inactive' | 'active';

export type SessionRiskReason =
  | 'session_risk:circuit_breaker_active'
  | 'session_risk:daily_realized_loss_limit_reached'
  | 'session_risk:max_open_trade_count_reached'
  | 'session_risk:max_trades_per_session_reached'
  | 'session_risk:circuit_breaker_manually_activated';

export interface SessionRiskPolicy {
  readonly max_daily_realized_loss_usd: number;
  readonly max_open_trade_count: number;
  readonly max_trades_per_session: number;
  readonly circuit_breaker_enabled: boolean;
  readonly reset_circuit_breaker_on_new_session: boolean;
}

export const DEFAULT_SESSION_RISK_POLICY: SessionRiskPolicy = {
  max_daily_realized_loss_usd: 1_000,
  max_open_trade_count: 3,
  max_trades_per_session: 12,
  circuit_breaker_enabled: true,
  reset_circuit_breaker_on_new_session: true,
};

export interface SessionRiskState {
  readonly session_id: SessionId;
  readonly account_ref: string;
  readonly symbol: string;
  readonly realized_pnl_usd: number;
  readonly open_trade_count: number;
  readonly closed_trade_count: number;
  readonly rejected_trade_count: number;
  readonly circuit_breaker_state: CircuitBreakerState;
  readonly circuit_breaker_reason?: SessionRiskReason;
  readonly last_transition_ts_ns: UnixNs;
}

export interface CreateSessionRiskStateInput {
  readonly session_id: SessionId;
  readonly account_ref: string;
  readonly symbol: string;
  readonly event_ts_ns: UnixNs;
}

export type SessionRiskStateUpdate =
  | {
    readonly kind: 'trade_opened';
    readonly event_ts_ns: UnixNs;
  }
  | {
    readonly kind: 'trade_closed';
    readonly realized_pnl_delta_usd: number;
    readonly event_ts_ns: UnixNs;
  }
  | {
    readonly kind: 'trade_rejected';
    readonly event_ts_ns: UnixNs;
  }
  | {
    readonly kind: 'circuit_breaker_activate';
    readonly reason: SessionRiskReason;
    readonly event_ts_ns: UnixNs;
  }
  | {
    readonly kind: 'circuit_breaker_clear';
    readonly event_ts_ns: UnixNs;
  };

export interface SessionRiskEvaluation {
  readonly allowed: boolean;
  readonly reasons: readonly SessionRiskReason[];
  readonly state: SessionRiskState;
  readonly policy: SessionRiskPolicy;
}

export interface ExistingPositionManagementEvaluation {
  readonly allowed: true;
  readonly reasons: readonly ['session_risk:existing_position_management_allowed'];
  readonly state: SessionRiskState;
}

export interface CircuitBreakerEvaluation {
  readonly state: SessionRiskState;
  readonly transitioned: boolean;
  readonly from: CircuitBreakerState;
  readonly to: CircuitBreakerState;
  readonly reason?: SessionRiskReason;
}

export interface SessionRiskStateSummary {
  readonly session_id: SessionId;
  readonly account_ref: string;
  readonly symbol: string;
  readonly realized_pnl_usd: number;
  readonly open_trade_count: number;
  readonly closed_trade_count: number;
  readonly rejected_trade_count: number;
  readonly circuit_breaker_state: CircuitBreakerState;
  readonly circuit_breaker_reason?: SessionRiskReason;
  readonly last_transition_ts_ns: UnixNs;
}

export function createSessionRiskState(
  input: CreateSessionRiskStateInput,
): SessionRiskState {
  if (input.account_ref.trim() === '') {
    throw new Error('account_ref must be a non-empty string');
  }
  if (input.symbol.trim() === '') {
    throw new Error('symbol must be a non-empty string');
  }
  return {
    session_id: input.session_id,
    account_ref: input.account_ref,
    symbol: input.symbol,
    realized_pnl_usd: 0,
    open_trade_count: 0,
    closed_trade_count: 0,
    rejected_trade_count: 0,
    circuit_breaker_state: 'inactive',
    last_transition_ts_ns: input.event_ts_ns,
  };
}

export function resetSessionRiskState(input: {
  readonly previous: SessionRiskState;
  readonly session_id: SessionId;
  readonly symbol?: string;
  readonly event_ts_ns: UnixNs;
  readonly policy?: Partial<SessionRiskPolicy>;
}): SessionRiskState {
  const policy = resolveSessionRiskPolicy(input.policy);
  const shouldClearBreaker =
    policy.reset_circuit_breaker_on_new_session ||
    input.previous.circuit_breaker_state === 'inactive';

  return {
    session_id: input.session_id,
    account_ref: input.previous.account_ref,
    symbol: input.symbol ?? input.previous.symbol,
    realized_pnl_usd: 0,
    open_trade_count: 0,
    closed_trade_count: 0,
    rejected_trade_count: 0,
    circuit_breaker_state: shouldClearBreaker ? 'inactive' : input.previous.circuit_breaker_state,
    circuit_breaker_reason: shouldClearBreaker ? undefined : input.previous.circuit_breaker_reason,
    last_transition_ts_ns: input.event_ts_ns,
  };
}

export function updateSessionRiskState(
  state: SessionRiskState,
  update: SessionRiskStateUpdate,
  policyOverrides?: Partial<SessionRiskPolicy>,
): SessionRiskState {
  if (update.kind === 'trade_opened') {
    return evaluateSessionCircuitBreaker({
      state: {
        ...state,
        open_trade_count: state.open_trade_count + 1,
      },
      event_ts_ns: update.event_ts_ns,
      policy: policyOverrides,
    }).state;
  }

  if (update.kind === 'trade_closed') {
    assertFinite(update.realized_pnl_delta_usd, 'realized_pnl_delta_usd');
    return applyRealizedPnl({
      state: {
        ...state,
        open_trade_count: Math.max(0, state.open_trade_count - 1),
        closed_trade_count: state.closed_trade_count + 1,
      },
      realized_pnl_delta_usd: update.realized_pnl_delta_usd,
      event_ts_ns: update.event_ts_ns,
      policy: policyOverrides,
    });
  }

  if (update.kind === 'trade_rejected') {
    return {
      ...state,
      rejected_trade_count: state.rejected_trade_count + 1,
    };
  }

  if (update.kind === 'circuit_breaker_activate') {
    return activateSessionCircuitBreaker({
      state,
      reason: update.reason,
      event_ts_ns: update.event_ts_ns,
    }).state;
  }

  return clearSessionCircuitBreaker({
    state,
    event_ts_ns: update.event_ts_ns,
  }).state;
}

export function applyRealizedPnl(input: {
  readonly state: SessionRiskState;
  readonly realized_pnl_delta_usd: number;
  readonly event_ts_ns: UnixNs;
  readonly policy?: Partial<SessionRiskPolicy>;
}): SessionRiskState {
  assertFinite(input.realized_pnl_delta_usd, 'realized_pnl_delta_usd');
  const next = {
    ...input.state,
    realized_pnl_usd: roundCurrency(
      input.state.realized_pnl_usd + input.realized_pnl_delta_usd,
    ),
  };
  return evaluateSessionCircuitBreaker({
    state: next,
    event_ts_ns: input.event_ts_ns,
    policy: input.policy,
  }).state;
}

export function evaluateSessionCircuitBreaker(input: {
  readonly state: SessionRiskState;
  readonly event_ts_ns: UnixNs;
  readonly policy?: Partial<SessionRiskPolicy>;
}): CircuitBreakerEvaluation {
  const policy = resolveSessionRiskPolicy(input.policy);
  const realizedLossUsd = Math.max(0, -input.state.realized_pnl_usd);
  if (
    policy.circuit_breaker_enabled &&
    realizedLossUsd >= policy.max_daily_realized_loss_usd
  ) {
    return activateSessionCircuitBreaker({
      state: input.state,
      reason: 'session_risk:daily_realized_loss_limit_reached',
      event_ts_ns: input.event_ts_ns,
    });
  }

  return {
    state: input.state,
    transitioned: false,
    from: input.state.circuit_breaker_state,
    to: input.state.circuit_breaker_state,
    reason: input.state.circuit_breaker_reason,
  };
}

export function canOpenNewTrade(
  state: SessionRiskState,
  policyOverrides?: Partial<SessionRiskPolicy>,
): SessionRiskEvaluation {
  const policy = resolveSessionRiskPolicy(policyOverrides);
  const reasons: SessionRiskReason[] = [];
  const realizedLossUsd = Math.max(0, -state.realized_pnl_usd);
  const totalTradesOpened = state.open_trade_count + state.closed_trade_count;

  if (policy.circuit_breaker_enabled && state.circuit_breaker_state === 'active') {
    reasons.push('session_risk:circuit_breaker_active');
  }
  if (realizedLossUsd >= policy.max_daily_realized_loss_usd) {
    reasons.push('session_risk:daily_realized_loss_limit_reached');
  }
  if (state.open_trade_count >= policy.max_open_trade_count) {
    reasons.push('session_risk:max_open_trade_count_reached');
  }
  if (totalTradesOpened >= policy.max_trades_per_session) {
    reasons.push('session_risk:max_trades_per_session_reached');
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    state,
    policy,
  };
}

export function canManageExistingPosition(
  state: SessionRiskState,
): ExistingPositionManagementEvaluation {
  return {
    allowed: true,
    reasons: ['session_risk:existing_position_management_allowed'],
    state,
  };
}

export function activateSessionCircuitBreaker(input: {
  readonly state: SessionRiskState;
  readonly reason: SessionRiskReason;
  readonly event_ts_ns: UnixNs;
}): CircuitBreakerEvaluation {
  if (input.state.circuit_breaker_state === 'active') {
    return {
      state: input.state,
      transitioned: false,
      from: 'active',
      to: 'active',
      reason: input.state.circuit_breaker_reason,
    };
  }
  return {
    state: {
      ...input.state,
      circuit_breaker_state: 'active',
      circuit_breaker_reason: input.reason,
      last_transition_ts_ns: input.event_ts_ns,
    },
    transitioned: true,
    from: 'inactive',
    to: 'active',
    reason: input.reason,
  };
}

export function clearSessionCircuitBreaker(input: {
  readonly state: SessionRiskState;
  readonly event_ts_ns: UnixNs;
}): CircuitBreakerEvaluation {
  if (input.state.circuit_breaker_state === 'inactive') {
    return {
      state: input.state,
      transitioned: false,
      from: 'inactive',
      to: 'inactive',
    };
  }
  return {
    state: {
      ...input.state,
      circuit_breaker_state: 'inactive',
      circuit_breaker_reason: undefined,
      last_transition_ts_ns: input.event_ts_ns,
    },
    transitioned: true,
    from: 'active',
    to: 'inactive',
  };
}

export function summarizeSessionRiskState(
  state: SessionRiskState,
): SessionRiskStateSummary {
  return {
    session_id: state.session_id,
    account_ref: state.account_ref,
    symbol: state.symbol,
    realized_pnl_usd: state.realized_pnl_usd,
    open_trade_count: state.open_trade_count,
    closed_trade_count: state.closed_trade_count,
    rejected_trade_count: state.rejected_trade_count,
    circuit_breaker_state: state.circuit_breaker_state,
    circuit_breaker_reason: state.circuit_breaker_reason,
    last_transition_ts_ns: state.last_transition_ts_ns,
  };
}

export function resolveSessionRiskPolicy(
  overrides: Partial<SessionRiskPolicy> = {},
): SessionRiskPolicy {
  const policy = {
    ...DEFAULT_SESSION_RISK_POLICY,
    ...overrides,
  };
  validateSessionRiskPolicy(policy);
  return policy;
}

export function validateSessionRiskPolicy(policy: SessionRiskPolicy): void {
  validatePositive(policy.max_daily_realized_loss_usd, 'max_daily_realized_loss_usd');
  validatePositive(policy.max_open_trade_count, 'max_open_trade_count');
  validatePositive(policy.max_trades_per_session, 'max_trades_per_session');
  if (policy.max_trades_per_session < policy.max_open_trade_count) {
    throw new Error('max_trades_per_session must be >= max_open_trade_count');
  }
}

function validatePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}
