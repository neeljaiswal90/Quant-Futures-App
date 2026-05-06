import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createJournalEventEnvelope,
  type AnyJournalEventEnvelope,
  type JournalEventEnvelope,
  type JournalEventPayloadFor,
} from '../../../../strategy_runtime/src/contracts/events/index.js';
import {
  makeCandidateId,
  makeCausationId,
  makeEventId,
  makeFeatureSnapshotId,
  makeFillId,
  makeOrderIntentId,
  makeRunId,
  makeSessionId,
  makeSizingDecisionId,
} from '../../../../strategy_runtime/src/contracts/ids.js';
import { ns } from '../../../../strategy_runtime/src/contracts/time.js';
import {
  buildTradeLedger,
  TradeLedgerInputError,
} from '../../../src/trade-ledger/index.js';

const INSTRUMENT_CONTEXT = { instrument_id: 12345, raw_symbol: 'MNQH6' };

describe('QFA-203 trade ledger reducer', () => {
  it('returns an empty ledger for no fill events', () => {
    expect(buildTradeLedger([], { run_id: 'run-empty' })).toEqual({
      run_id: 'run-empty',
      executions: [],
      closed_trades: [],
      open_positions: [],
    });
  });

  it('maps SIM_FILL events to deterministic execution rows', () => {
    const ledger = buildTradeLedger([simFillEvent({ sequence: 1 })], {
      instrument_context: INSTRUMENT_CONTEXT,
    });

    expect(ledger.executions).toHaveLength(1);
    expect(ledger.executions[0]).toMatchObject({
      execution_id: 'execution-sim-fill-fill-1',
      instrument_id: 12345,
      raw_symbol: 'MNQH6',
      instrument_identity_source: 'ledger_options',
      strategy_id: null,
    });
    expect(ledger.open_positions).toHaveLength(1);
  });

  it('is replay-deterministic for identical input', () => {
    const events = [
      candidateEvent(),
      orderIntentEvent(),
      simFillEvent({ sequence: 1, side: 'buy', quantity: 1, price: 100 }),
      simFillEvent({ sequence: 2, side: 'sell', quantity: 1, price: 105 }),
    ];

    expect(buildTradeLedger(events, { instrument_context: INSTRUMENT_CONTEXT })).toEqual(
      buildTradeLedger(events, { instrument_context: INSTRUMENT_CONTEXT }),
    );
  });

  it('preserves deterministic journal-order execution output', () => {
    const ledger = buildTradeLedger([
      simFillEvent({ sequence: 1, side: 'buy', quantity: 1 }),
      simFillEvent({ sequence: 2, side: 'buy', quantity: 1 }),
    ], { instrument_context: INSTRUMENT_CONTEXT });

    expect(ledger.executions.map((execution) => execution.execution_id)).toEqual([
      'execution-sim-fill-fill-1',
      'execution-sim-fill-fill-2',
    ]);
  });

  it('recovers strategy_id through CANDIDATE -> ORDER_INTENT -> SIM_FILL chain', () => {
    const ledger = buildTradeLedger([
      candidateEvent(),
      orderIntentEvent(),
      simFillEvent({ sequence: 1 }),
    ], { instrument_context: INSTRUMENT_CONTEXT });

    expect(ledger.executions[0]!.strategy_id).toBe('breakout_retest_long');
    expect(ledger.open_positions[0]!.strategy_id).toBe('breakout_retest_long');
  });

  it('leaves strategy_id null when the recovery chain is absent', () => {
    const ledger = buildTradeLedger([simFillEvent({ sequence: 1 })], {
      instrument_context: INSTRUMENT_CONTEXT,
    });

    expect(ledger.executions[0]!.strategy_id).toBeNull();
  });

  it('groups an open and close into a ClosedTrade with realized_pnl null', () => {
    const ledger = buildTradeLedger([
      candidateEvent(),
      orderIntentEvent(),
      simFillEvent({ sequence: 1, side: 'buy', quantity: 2, price: 100 }),
      simFillEvent({ sequence: 2, side: 'sell', quantity: 2, price: 105 }),
    ], { instrument_context: INSTRUMENT_CONTEXT });

    expect(ledger.open_positions).toEqual([]);
    expect(ledger.closed_trades).toHaveLength(1);
    expect(ledger.closed_trades[0]).toMatchObject({
      trade_id: 'trade-run-ledger-1',
      side: 'long',
      entry_quantity: 2,
      exit_quantity: 2,
      average_entry_price: 100,
      average_exit_price: 105,
      realized_pnl: null,
      instrument_identity_source: 'ledger_options',
    });
  });

  it('aggregates partial fills into one position and closed trade', () => {
    const ledger = buildTradeLedger([
      simFillEvent({ sequence: 1, side: 'buy', quantity: 1, price: 100 }),
      simFillEvent({ sequence: 2, side: 'buy', quantity: 2, price: 102 }),
      simFillEvent({ sequence: 3, side: 'sell', quantity: 3, price: 105 }),
    ], { instrument_context: INSTRUMENT_CONTEXT });

    expect(ledger.closed_trades).toHaveLength(1);
    expect(ledger.closed_trades[0]!.entry_quantity).toBe(3);
    expect(ledger.closed_trades[0]!.exit_quantity).toBe(3);
    expect(ledger.closed_trades[0]!.average_entry_price).toBeCloseTo(101.333333, 5);
  });

  it('explicitly handles sell without an open long as a short position', () => {
    const ledger = buildTradeLedger([
      simFillEvent({ sequence: 1, side: 'sell', quantity: 2, price: 100 }),
    ], { instrument_context: INSTRUMENT_CONTEXT });

    expect(ledger.open_positions).toHaveLength(1);
    expect(ledger.open_positions[0]).toMatchObject({
      side: 'short',
      quantity_open: 2,
    });
  });

  it('handles position flips by closing the old side and opening the new side', () => {
    const ledger = buildTradeLedger([
      simFillEvent({ sequence: 1, side: 'buy', quantity: 1, price: 100 }),
      simFillEvent({ sequence: 2, side: 'sell', quantity: 2, price: 99 }),
    ], { instrument_context: INSTRUMENT_CONTEXT });

    expect(ledger.closed_trades).toHaveLength(1);
    expect(ledger.closed_trades[0]!.side).toBe('long');
    expect(ledger.open_positions).toHaveLength(1);
    expect(ledger.open_positions[0]).toMatchObject({
      side: 'short',
      quantity_open: 1,
    });
  });

  it('fails closed when instrument identity is missing', () => {
    expect(() => buildTradeLedger([simFillEvent({ sequence: 1 })])).toThrow(
      TradeLedgerInputError,
    );
    expect(() => buildTradeLedger([simFillEvent({ sequence: 1 })])).toThrow(
      'missing_instrument_identity',
    );
  });

  it('ignores non-fill events except for deterministic recovery context', () => {
    const ledger = buildTradeLedger([candidateEvent(), orderIntentEvent()], {
      instrument_context: INSTRUMENT_CONTEXT,
    });

    expect(ledger.executions).toEqual([]);
    expect(ledger.closed_trades).toEqual([]);
    expect(ledger.open_positions).toEqual([]);
  });

  it('does not introduce nondeterministic runtime calls in trade-ledger source', () => {
    const sourceRoot = join(process.cwd(), 'apps/backtester/src/trade-ledger');
    const source = readSourceFiles(sourceRoot).join('\n');

    expect(source).not.toMatch(/Date\.now|Math\.random|randomUUID|crypto\.randomUUID/);
  });
});

function candidateEvent(): AnyJournalEventEnvelope {
  return createJournalEventEnvelope({
    event_id: makeEventId('candidate-event-1'),
    type: 'CANDIDATE',
    ts_ns: ns(1n),
    run_id: makeRunId('run-ledger'),
    session_id: makeSessionId('session-ledger'),
    payload: {
      candidate_id: makeCandidateId('candidate-1'),
      strategy_id: 'breakout_retest_long',
      feature_snapshot_id: makeFeatureSnapshotId('feature-1'),
      direction: 'long',
      status: 'proposed',
      entry_price: 100,
      stop_price: 95,
      targets: [],
      confidence: 1,
      reasons: ['fixture'],
    },
  }) as AnyJournalEventEnvelope;
}

function orderIntentEvent(): AnyJournalEventEnvelope {
  return createJournalEventEnvelope({
    event_id: makeEventId('order-intent-order-1'),
    type: 'ORDER_INTENT',
    ts_ns: ns(2n),
    run_id: makeRunId('run-ledger'),
    session_id: makeSessionId('session-ledger'),
    payload: {
      order_intent_id: makeOrderIntentId('order-1'),
      candidate_id: makeCandidateId('candidate-1'),
      sizing_decision_id: makeSizingDecisionId('sizing-1'),
      side: 'buy',
      order_type: 'market',
      quantity: 1,
      time_in_force: 'ioc',
    },
  }) as AnyJournalEventEnvelope;
}

function simFillEvent(input: {
  readonly sequence: number;
  readonly side?: JournalEventPayloadFor<'SIM_FILL'>['side'];
  readonly quantity?: number;
  readonly price?: number;
}): JournalEventEnvelope<'SIM_FILL', JournalEventPayloadFor<'SIM_FILL'>> {
  return createJournalEventEnvelope({
    event_id: makeEventId(`sim-fill-fill-${input.sequence}`),
    type: 'SIM_FILL',
    ts_ns: ns(BigInt(10 + input.sequence)),
    run_id: makeRunId('run-ledger'),
    session_id: makeSessionId('session-ledger'),
    causation_id: makeCausationId('order-intent-order-1'),
    payload: {
      fill_id: makeFillId(`fill-${input.sequence}`),
      order_intent_id: makeOrderIntentId('order-1'),
      side: input.side ?? 'buy',
      quantity: input.quantity ?? 1,
      price: input.price ?? 100,
      liquidity: 'taker',
    },
  });
}

function readSourceFiles(root: string): string[] {
  return readdirSync(root)
    .flatMap((entry) => {
      const path = join(root, entry);
      if (statSync(path).isDirectory()) {
        return readSourceFiles(path);
      }
      if (!entry.endsWith('.ts')) {
        return [];
      }
      return [readFileSync(path, 'utf8')];
    });
}
