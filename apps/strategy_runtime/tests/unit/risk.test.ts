import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  makeCandidateId,
  ns,
  type Candidate,
} from '../../src/contracts/index.js';
import {
  assessCandidateRisk,
  computeComposedSizing,
  computeTradeCosts,
  getContractSpec,
  loadVenueCostTable,
  makeQLiqHysteresisState,
  normalizeStopDistance,
  parseVenueCostTable,
  riskPerContractUsd,
  roundStopAwayFromEntry,
  type LiquidityInputs,
} from '../../src/risk/index.js';
import {
  getActiveStrategyGenerator,
} from '../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../fixtures/strategies/synthetic-feature-snapshots.js';

const DECIDED_TS_NS = ns('1776957600000000000');

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
        daily_realized_pnl_usd: -1_000,
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
