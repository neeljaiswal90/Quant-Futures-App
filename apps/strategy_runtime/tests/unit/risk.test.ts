import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createJournalEventEnvelope,
  makeCausationId,
  makeCandidateId,
  makeEventId,
  makeRunId,
  makeSessionId,
  ns,
  validateJournalEventEnvelope,
  type Candidate,
} from '../../src/contracts/index.js';
import {
  activateSessionCircuitBreaker,
  applyRealizedPnl,
  assessCandidateRisk,
  canManageExistingPosition,
  canOpenNewTrade,
  computeComposedSizing,
  computeTradeCosts,
  createSessionRiskState,
  getContractSpec,
  loadVenueCostTable,
  makeQLiqHysteresisState,
  normalizeStopDistance,
  parseVenueCostTable,
  riskPerContractUsd,
  roundStopAwayFromEntry,
  resetSessionRiskState,
  toRiskGateEventPayload,
  updateSessionRiskState,
  type LiquidityInputs,
  type SessionRiskPolicy,
  type SessionRiskState,
} from '../../src/risk/index.js';
import {
  getActiveStrategyGenerator,
} from '../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../fixtures/strategies/synthetic-feature-snapshots.js';

const DECIDED_TS_NS = ns('1776957600000000000');
const NEXT_TS_NS = ns('1776957601000000000');
const SESSION_ID = makeSessionId('2026-04-23-rth');
const NEXT_SESSION_ID = makeSessionId('2026-04-24-rth');

const FRESH_LIQUIDITY: LiquidityInputs = {
  d_2ticks: 100,
  v_1s: 100,
  d_median_session: 100,
  is_fresh: true,
};

function fixtureCandidate(): Candidate {
  const result = getActiveStrategyGenerator('trend_pullback_long')({
    strategy_id: 'trend_pullback_long',
    snapshot: STRATEGY_SYNTHETIC_FIXTURES.trend_pullback_long.snapshot,
  });
  if (result.candidate === undefined) {
    throw new Error('expected trend pullback fixture candidate');
  }
  return result.candidate;
}

function cloneCandidate(candidate: Candidate, overrides: Partial<Candidate>): Candidate {
  return {
    ...candidate,
    ...overrides,
  };
}

function initialSessionRiskState(): SessionRiskState {
  return createSessionRiskState({
    session_id: SESSION_ID,
    account_ref: 'sim-account-1',
    symbol: 'MNQM6',
    event_ts_ns: DECIDED_TS_NS,
  });
}

const STRICT_SESSION_POLICY = {
  max_daily_realized_loss_usd: 500,
  max_open_trade_count: 2,
  max_trades_per_session: 4,
  circuit_breaker_enabled: true,
  reset_circuit_breaker_on_new_session: true,
} satisfies SessionRiskPolicy;

describe('RISK-01 contract specs and cost model', () => {
  it('resolves MNQ contract specs and normalizes tick-based risk math', () => {
    const mnq = getContractSpec('MNQM6');

    expect(mnq).toMatchObject({
      root: 'MNQ',
      tick_size: 0.25,
      point_value: 2,
      live_order_routing_allowed: false,
    });
    expect(normalizeStopDistance(0.1, mnq)).toBe(0.5);
    expect(riskPerContractUsd({
      stop_points: 7.25,
      contract: mnq,
      slippage_points_per_side: 0.75,
    })).toBe(17.5);
    expect(roundStopAwayFromEntry({
      entry_price: 100.5,
      raw_stop_price: 100.13,
      direction: 'long',
      contract: mnq,
    })).toBe(100);
    expect(roundStopAwayFromEntry({
      entry_price: 100,
      raw_stop_price: 100.13,
      direction: 'short',
      contract: mnq,
    })).toBe(100.25);
  });

  it('loads and validates venue cost assumptions from config/venue-costs.json', () => {
    const table = loadVenueCostTable();

    expect(table.effective_date).toBe('2026-01-01');
    expect(table.configs.MNQ).toMatchObject({
      root: 'MNQ',
      commission_per_side_per_contract_usd: 0.4,
      exchange_fees_per_side_per_contract_usd: 0.35,
    });
    expect(() => parseVenueCostTable({
      commission_schedule_effective_date: '2026-01-01',
      cost_assumption_source: 'test',
      contracts: {},
    })).toThrow('contracts.MNQ is required');
  });

  it('computes adverse slippage, fees, and net PnL deterministically', () => {
    const table = loadVenueCostTable();
    const costs = computeTradeCosts({
      contract: 'MNQ',
      venue_cost: table.configs.MNQ,
      direction: 'long',
      quantity: 2,
      planned_entry_price: 100,
      actual_entry_price: 100.25,
      planned_exit_price: 102,
      actual_exit_price: 101.75,
      entry_order_type: 'market',
      exit_order_type: 'limit',
      planned_worst_case_loss_usd: 10,
    });

    expect(costs).toMatchObject({
      cost_model_version: 'mnq_sim_cost_model_v1',
      contract_root: 'MNQ',
      commission_usd: 1.6,
      exchange_fees_usd: 1.4,
      entry_slippage_points: 0.25,
      exit_slippage_points: 0.25,
      slippage_usd: 2,
      total_cost_usd: 5,
      planned_gross_pnl_usd: 8,
      actual_gross_pnl_usd: 6,
      actual_net_pnl_usd: 3,
      r_gross: 0.6,
      r_net: 0.3,
    });
  });
});

describe('RISK-02 composed sizing and risk manager', () => {
  it('computes deterministic composed sizing with visible binding cap components', () => {
    const result = computeComposedSizing({
      equity_usd: 50_000,
      max_risk_per_trade_pct: 0.5,
      stop_points: 7.25,
      current_open_quantity: 0,
      max_net_position_per_symbol: 10,
      drawdown_today_usd: 0,
      daily_loss_limit_usd: 1_000,
      regime: 'strong_trend',
      n_eff: 1_000,
      direction: 'long',
      mode: 'signal_only',
      liquidity: FRESH_LIQUIDITY,
      now_ms: 0,
      hysteresis: makeQLiqHysteresisState(),
    }, getContractSpec('MNQ'));

    expect(result.quantity).toBe(4);
    expect(result.binding_cap).toBe('q_softcap');
    expect(result.q_risk).toBe(14);
    expect(result.q_liq).toBe(7);
    expect(result.q_softcap).toBe(4);
    expect(result.q_hardcap).toBe(10);
    expect(result.q_kelly).toBeNull();
  });

  it('turns an active candidate into deterministic sizing and a passing risk gate', () => {
    const candidate = fixtureCandidate();
    const assessment = assessCandidateRisk({
      candidate,
      decided_ts_ns: DECIDED_TS_NS,
      policy: {
        account_equity_usd: 50_000,
        max_risk_per_trade_pct: 0.5,
        max_daily_loss_pct: 2,
        min_reward_risk: 1,
        sizing_mode: 'signal_only',
      },
      state: {
        current_open_quantity: 0,
        daily_realized_pnl_usd: 0,
        drawdown_today_usd: 0,
        regime: 'strong_trend',
        n_eff: 1_000,
        liquidity: FRESH_LIQUIDITY,
        now_ms: 0,
      },
    });

    expect(assessment.sizing).toMatchObject({
      sizing_decision_id: `sizing-${candidate.candidate_id}`,
      candidate_id: candidate.candidate_id,
      decided_ts_ns: DECIDED_TS_NS,
      quantity: 4,
      risk_points: 7.25,
      risk_usd: 70,
      config: candidate.config,
    });
    expect(assessment.gate).toMatchObject({
      risk_gate_decision_id: `risk-${candidate.candidate_id}`,
      candidate_id: candidate.candidate_id,
      decided_ts_ns: DECIDED_TS_NS,
      status: 'pass',
      reasons: ['risk_gate:passed'],
      max_loss_usd: 70,
      config: candidate.config,
    });
  });

  it('rejects candidates that violate reward-risk, sizing, or daily loss gates', () => {
    const candidate = fixtureCandidate();
    const lowReward = cloneCandidate(candidate, {
      candidate_id: makeCandidateId('candidate-low-reward-risk'),
      reward_risk: [{ label: 'pt1', reward_risk: 0.5 }],
    });

    const lowRewardAssessment = assessCandidateRisk({
      candidate: lowReward,
      decided_ts_ns: DECIDED_TS_NS,
      policy: {
        min_reward_risk: 1,
        account_equity_usd: 50_000,
        max_risk_per_trade_pct: 0.5,
      },
      state: {
        current_open_quantity: 0,
        daily_realized_pnl_usd: 0,
        regime: 'strong_trend',
        n_eff: 1_000,
        liquidity: FRESH_LIQUIDITY,
        now_ms: 0,
      },
    });

    expect(lowRewardAssessment.gate.status).toBe('reject');
    expect(lowRewardAssessment.gate.reasons).toContain('risk_gate:reward_risk_below_minimum');

    const netCapAssessment = assessCandidateRisk({
      candidate,
      decided_ts_ns: DECIDED_TS_NS,
      policy: {
        max_net_position_per_symbol: 4,
      },
      state: {
        current_open_quantity: 4,
        daily_realized_pnl_usd: 0,
        regime: 'strong_trend',
        n_eff: 1_000,
        liquidity: FRESH_LIQUIDITY,
        now_ms: 0,
      },
    });

    expect(netCapAssessment.sizing.quantity).toBe(0);
    expect(netCapAssessment.gate.status).toBe('reject');
    expect(netCapAssessment.gate.reasons).toContain('net_position_cap_reached');

    const lossAssessment = assessCandidateRisk({
      candidate,
      decided_ts_ns: DECIDED_TS_NS,
      state: {
        current_open_quantity: 0,
        daily_realized_pnl_usd: -500,
        regime: 'strong_trend',
        n_eff: 1_000,
        liquidity: FRESH_LIQUIDITY,
        now_ms: 0,
      },
    });

    expect(lossAssessment.gate.status).toBe('reject');
    expect(lossAssessment.gate.reasons).toContain('risk_gate:daily_loss_limit_reached');
  });

  it('keeps active risk modules free of deterministic-output hazards', () => {
    const riskDir = join(process.cwd(), 'apps/strategy_runtime/src/risk');
    const patterns = [
      'Date.now',
      'new Date(',
      'Math.random',
      'toLocaleString',
      'localeCompare',
    ];

    for (const file of readdirSync(riskDir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(riskDir, file), 'utf8');
      for (const pattern of patterns) {
        expect(source, `${file} must not contain ${pattern}`).not.toContain(pattern);
      }
    }
  });
});

describe('RISK-03 session risk circuit breaker and trade-count controls', () => {
  it('allows new candidates when session risk is below all limits', () => {
    const candidate = fixtureCandidate();
    const state = initialSessionRiskState();
    const assessment = assessCandidateRisk({
      candidate,
      decided_ts_ns: DECIDED_TS_NS,
      policy: {
        session: STRICT_SESSION_POLICY,
      },
      state: {
        current_open_quantity: 0,
        daily_realized_pnl_usd: 0,
        session_risk: state,
        regime: 'strong_trend',
        n_eff: 1_000,
        liquidity: FRESH_LIQUIDITY,
        now_ms: 0,
      },
    });

    expect(canOpenNewTrade(state, STRICT_SESSION_POLICY)).toMatchObject({
      allowed: true,
      reasons: [],
    });
    expect(assessment.gate.status).toBe('pass');
    expect(assessment.gate.reasons).toEqual(['risk_gate:passed']);
  });

  it('activates the circuit breaker when realized daily loss breaches the limit', () => {
    const state = applyRealizedPnl({
      state: initialSessionRiskState(),
      realized_pnl_delta_usd: -500,
      event_ts_ns: NEXT_TS_NS,
      policy: STRICT_SESSION_POLICY,
    });
    const evaluation = canOpenNewTrade(state, STRICT_SESSION_POLICY);

    expect(state).toMatchObject({
      realized_pnl_usd: -500,
      circuit_breaker_state: 'active',
      circuit_breaker_reason: 'session_risk:daily_realized_loss_limit_reached',
      last_transition_ts_ns: NEXT_TS_NS,
    });
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.reasons).toEqual([
      'session_risk:circuit_breaker_active',
      'session_risk:daily_realized_loss_limit_reached',
    ]);
  });

  it('blocks new entries at the max open-trade count with stable rejection reasons', () => {
    const withOneOpen = updateSessionRiskState(
      initialSessionRiskState(),
      { kind: 'trade_opened', event_ts_ns: DECIDED_TS_NS },
      STRICT_SESSION_POLICY,
    );
    const withTwoOpen = updateSessionRiskState(
      withOneOpen,
      { kind: 'trade_opened', event_ts_ns: NEXT_TS_NS },
      STRICT_SESSION_POLICY,
    );

    expect(canOpenNewTrade(withTwoOpen, STRICT_SESSION_POLICY)).toEqual({
      allowed: false,
      reasons: ['session_risk:max_open_trade_count_reached'],
      state: withTwoOpen,
      policy: STRICT_SESSION_POLICY,
    });
  });

  it('blocks new entries while active but still allows existing-position management', () => {
    const active = activateSessionCircuitBreaker({
      state: initialSessionRiskState(),
      reason: 'session_risk:circuit_breaker_manually_activated',
      event_ts_ns: NEXT_TS_NS,
    }).state;

    expect(canOpenNewTrade(active, STRICT_SESSION_POLICY)).toMatchObject({
      allowed: false,
      reasons: ['session_risk:circuit_breaker_active'],
    });
    expect(canManageExistingPosition(active)).toEqual({
      allowed: true,
      reasons: ['session_risk:existing_position_management_allowed'],
      state: active,
    });
  });

  it('resets circuit breaker and counters at the next session when policy allows reset', () => {
    const active = activateSessionCircuitBreaker({
      state: {
        ...initialSessionRiskState(),
        realized_pnl_usd: -250,
        open_trade_count: 1,
        closed_trade_count: 2,
        rejected_trade_count: 1,
      },
      reason: 'session_risk:circuit_breaker_manually_activated',
      event_ts_ns: NEXT_TS_NS,
    }).state;

    expect(resetSessionRiskState({
      previous: active,
      session_id: NEXT_SESSION_ID,
      event_ts_ns: NEXT_TS_NS,
      policy: STRICT_SESSION_POLICY,
    })).toEqual({
      session_id: NEXT_SESSION_ID,
      account_ref: 'sim-account-1',
      symbol: 'MNQM6',
      realized_pnl_usd: 0,
      open_trade_count: 0,
      closed_trade_count: 0,
      rejected_trade_count: 0,
      circuit_breaker_state: 'inactive',
      circuit_breaker_reason: undefined,
      last_transition_ts_ns: NEXT_TS_NS,
    });
  });

  it('integrates session risk reasons into the pre-trade risk gate', () => {
    const candidate = fixtureCandidate();
    const blockedSession = {
      ...initialSessionRiskState(),
      open_trade_count: 2,
    };
    const first = assessCandidateRisk({
      candidate,
      decided_ts_ns: DECIDED_TS_NS,
      policy: {
        session: STRICT_SESSION_POLICY,
      },
      state: {
        current_open_quantity: 0,
        daily_realized_pnl_usd: 0,
        session_risk: blockedSession,
        regime: 'strong_trend',
        n_eff: 1_000,
        liquidity: FRESH_LIQUIDITY,
        now_ms: 0,
      },
    });
    const second = assessCandidateRisk({
      candidate,
      decided_ts_ns: DECIDED_TS_NS,
      policy: {
        session: STRICT_SESSION_POLICY,
      },
      state: {
        current_open_quantity: 0,
        daily_realized_pnl_usd: 0,
        session_risk: blockedSession,
        regime: 'strong_trend',
        n_eff: 1_000,
        liquidity: FRESH_LIQUIDITY,
        now_ms: 0,
      },
    });

    expect(first).toEqual(second);
    expect(first.gate.status).toBe('reject');
    expect(first.gate.reasons).toContain('session_risk:max_open_trade_count_reached');
  });

  it('projects session risk state into OBS-01 RISK_GATE payloads', () => {
    const candidate = fixtureCandidate();
    const state = activateSessionCircuitBreaker({
      state: initialSessionRiskState(),
      reason: 'session_risk:circuit_breaker_manually_activated',
      event_ts_ns: NEXT_TS_NS,
    }).state;
    const assessment = assessCandidateRisk({
      candidate,
      decided_ts_ns: DECIDED_TS_NS,
      policy: {
        session: STRICT_SESSION_POLICY,
      },
      state: {
        current_open_quantity: 0,
        daily_realized_pnl_usd: 0,
        session_risk: state,
        regime: 'strong_trend',
        n_eff: 1_000,
        liquidity: FRESH_LIQUIDITY,
        now_ms: 0,
      },
    });
    const event = createJournalEventEnvelope({
      event_id: makeEventId('risk-gate-session-risk-test'),
      type: 'RISK_GATE',
      ts_ns: DECIDED_TS_NS,
      run_id: makeRunId('run-risk-test'),
      session_id: SESSION_ID,
      causation_id: makeCausationId(candidate.candidate_id),
      payload: toRiskGateEventPayload(assessment.gate, state),
    });

    expect(validateJournalEventEnvelope(event)).toMatchObject({ ok: true, issues: [] });
    expect(event.payload).toMatchObject({
      risk_manager_version: 'risk_manager_v1',
      session_risk: {
        circuit_breaker_state: 'active',
        circuit_breaker_reason: 'session_risk:circuit_breaker_manually_activated',
        last_transition_ts_ns: NEXT_TS_NS,
      },
    });
  });
});
