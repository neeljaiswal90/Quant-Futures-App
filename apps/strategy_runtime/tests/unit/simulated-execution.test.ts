import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  makeSizingDecisionId,
  ns,
  type Candidate,
  type SizingDecision,
  type StrategyId,
} from '../../src/contracts/index.js';
import {
  createEntryOrderIntent,
  createSimulatedExecutionAdapter,
  toOrderIntentEventPayload,
  toSimFillEventPayload,
  type SimulatedExecutionMarketState,
} from '../../src/execution/index.js';
import {
  loadVenueCostTable,
} from '../../src/risk/index.js';
import {
  getActiveStrategyGenerator,
} from '../../src/strategies/index.js';
import { STRATEGY_SYNTHETIC_FIXTURES } from '../fixtures/strategies/synthetic-feature-snapshots.js';

const SUBMITTED_TS_NS = ns('1776957600000000000');
const MARKET_TS_NS = ns('1776957600001000000');

function candidate(strategyId: StrategyId = 'trend_pullback_long'): Candidate {
  const result = getActiveStrategyGenerator(strategyId)({
    strategy_id: strategyId,
    snapshot: STRATEGY_SYNTHETIC_FIXTURES[strategyId].snapshot,
  });
  if (result.candidate === undefined) {
    throw new Error(`expected ${strategyId} fixture candidate`);
  }
  return result.candidate;
}

function sizing(candidateInput: Candidate, quantity = 2): SizingDecision {
  return {
    sizing_decision_id: makeSizingDecisionId(`sizing-${candidateInput.candidate_id}`),
    candidate_id: candidateInput.candidate_id,
    decided_ts_ns: SUBMITTED_TS_NS,
    quantity,
    risk_usd: 35,
    risk_points: candidateInput.risk_points,
    config: candidateInput.config,
  };
}

function marketFor(candidateInput: Candidate): SimulatedExecutionMarketState {
  return {
    instrument: candidateInput.instrument,
    ts_ns: MARKET_TS_NS,
    bid_px: candidateInput.entry_price - 0.25,
    ask_px: candidateInput.entry_price,
    last_trade_price: candidateInput.entry_price,
  };
}

describe('SIM-01 deterministic simulated execution adapter', () => {
  it('creates entry order intents from candidate and sizing decisions', () => {
    const inputCandidate = candidate();
    const inputSizing = sizing(inputCandidate, 3);
    const intent = createEntryOrderIntent({
      candidate: inputCandidate,
      sizing: inputSizing,
      submitted_ts_ns: SUBMITTED_TS_NS,
      order_type: 'limit',
      limit_price: inputCandidate.entry_price,
    });

    expect(intent).toMatchObject({
      order_intent_id: `order-${inputCandidate.candidate_id}-${inputSizing.sizing_decision_id}`,
      candidate_id: inputCandidate.candidate_id,
      sizing_decision_id: inputSizing.sizing_decision_id,
      side: 'buy',
      type: 'limit',
      quantity: 3,
      limit_price: inputCandidate.entry_price,
      time_in_force: 'day',
      submitted_ts_ns: SUBMITTED_TS_NS,
      config: inputCandidate.config,
    });
    expect(toOrderIntentEventPayload(intent)).toMatchObject({
      order_intent_id: intent.order_intent_id,
      candidate_id: inputCandidate.candidate_id,
      order_type: 'limit',
      quantity: 3,
    });
  });

  it('fills marketable buy orders against BBO with deterministic slippage and costs', async () => {
    const inputCandidate = candidate();
    const intent = createEntryOrderIntent({
      candidate: inputCandidate,
      sizing: sizing(inputCandidate, 2),
      submitted_ts_ns: SUBMITTED_TS_NS,
    });
    const adapter = createSimulatedExecutionAdapter({
      venue_costs: loadVenueCostTable(),
      config: { marketable_slippage_points: 0.25 },
    });

    const result = await adapter.submit({
      intent,
      market: marketFor(inputCandidate),
    });

    expect(result.status).toBe('filled');
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]).toMatchObject({
      fill_id: `fill-${intent.order_intent_id}-1`,
      order_intent_id: intent.order_intent_id,
      side: 'buy',
      quantity: 2,
      price: inputCandidate.entry_price + 0.25,
      liquidity: 'taker',
      slippage_points: 0.25,
      exchange_fee_usd: 0.7,
      commission_usd: 0.8,
      filled_ts_ns: MARKET_TS_NS,
      config: inputCandidate.config,
    });
    expect(toSimFillEventPayload(result.fills[0]!)).toMatchObject({
      fill_id: result.fills[0]!.fill_id,
      order_intent_id: intent.order_intent_id,
      price: inputCandidate.entry_price + 0.25,
      exchange_fee_usd: 0.7,
      commission_usd: 0.8,
    });
  });

  it('accepts resting day limits without inventing model-free fills', async () => {
    const inputCandidate = candidate();
    const intent = createEntryOrderIntent({
      candidate: inputCandidate,
      sizing: sizing(inputCandidate, 1),
      submitted_ts_ns: SUBMITTED_TS_NS,
      order_type: 'limit',
      limit_price: inputCandidate.entry_price - 1,
      time_in_force: 'day',
    });
    const adapter = createSimulatedExecutionAdapter({
      venue_costs: loadVenueCostTable(),
    });

    const result = await adapter.submit({
      intent,
      market: marketFor(inputCandidate),
    });

    expect(result).toEqual({
      order_intent_id: intent.order_intent_id,
      status: 'accepted',
      submitted_ts_ns: SUBMITTED_TS_NS,
      fills: [],
      reject_reason: undefined,
    });
  });

  it('caps marketable limit slippage at the limit price', async () => {
    const inputCandidate = candidate();
    const intent = createEntryOrderIntent({
      candidate: inputCandidate,
      sizing: sizing(inputCandidate, 1),
      submitted_ts_ns: SUBMITTED_TS_NS,
      order_type: 'limit',
      limit_price: inputCandidate.entry_price,
      time_in_force: 'ioc',
    });
    const adapter = createSimulatedExecutionAdapter({
      venue_costs: loadVenueCostTable(),
      config: { marketable_slippage_points: 0.25 },
    });

    const result = await adapter.submit({
      intent,
      market: marketFor(inputCandidate),
    });

    expect(result.status).toBe('filled');
    expect(result.fills[0]?.price).toBe(inputCandidate.entry_price);
    expect(result.fills[0]?.slippage_points).toBe(0);
  });

  it('fills triggered sell stop-market orders with adverse slippage', async () => {
    const inputCandidate = candidate('trend_pullback_short');
    const intent = createEntryOrderIntent({
      candidate: inputCandidate,
      sizing: sizing(inputCandidate, 1),
      submitted_ts_ns: SUBMITTED_TS_NS,
      order_type: 'stop_market',
      stop_price: inputCandidate.entry_price,
      time_in_force: 'day',
    });
    const market: SimulatedExecutionMarketState = {
      instrument: inputCandidate.instrument,
      ts_ns: MARKET_TS_NS,
      bid_px: inputCandidate.entry_price,
      ask_px: inputCandidate.entry_price + 0.25,
      last_trade_price: inputCandidate.entry_price,
    };
    const adapter = createSimulatedExecutionAdapter({
      venue_costs: loadVenueCostTable(),
      config: { marketable_slippage_points: 0.25 },
    });

    const result = await adapter.submit({ intent, market });

    expect(result.status).toBe('filled');
    expect(result.fills[0]).toMatchObject({
      side: 'sell',
      price: inputCandidate.entry_price - 0.25,
      slippage_points: 0.25,
      liquidity: 'taker',
    });
  });

  it('rejects invalid inputs with structured order results instead of throwing', async () => {
    const inputCandidate = candidate();
    const intent = createEntryOrderIntent({
      candidate: inputCandidate,
      sizing: sizing(inputCandidate, 1),
      submitted_ts_ns: SUBMITTED_TS_NS,
    });
    const adapter = createSimulatedExecutionAdapter({
      venue_costs: loadVenueCostTable(),
    });

    const result = await adapter.submit({
      intent,
      market: {
        ...marketFor(inputCandidate),
        bid_px: inputCandidate.entry_price + 1,
        ask_px: inputCandidate.entry_price,
      },
    });

    expect(result).toEqual({
      order_intent_id: intent.order_intent_id,
      status: 'rejected',
      submitted_ts_ns: SUBMITTED_TS_NS,
      fills: [],
      reject_reason: 'bid_above_ask',
    });
  });

  it('keeps execution modules free of deterministic-output hazards', () => {
    const executionDir = join(process.cwd(), 'apps/strategy_runtime/src/execution');
    const patterns = [
      'Date.now',
      'new Date(',
      'Math.random',
      'toLocaleString',
      'localeCompare',
    ];

    for (const file of readdirSync(executionDir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(executionDir, file), 'utf8');
      for (const pattern of patterns) {
        expect(source, `${file} must not contain ${pattern}`).not.toContain(pattern);
      }
    }
  });
});
