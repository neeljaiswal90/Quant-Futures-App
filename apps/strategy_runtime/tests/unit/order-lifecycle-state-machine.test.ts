import { describe, expect, it } from 'vitest';
import type {
  EventId,
  OrderAckFillPayload,
  OrderAckSubmissionPayload,
} from '../../src/contracts/index.js';
import {
  MockBrokerReconciliationClient,
  OrderLifecycleStateMachine,
  SubmissionGate,
  syntheticFillAckIdForReconciliation,
  type OrderLifecycleEmittedEvent,
} from '../../src/execution/order-lifecycle-state-machine.js';

const INTENT_1 = 'order-intent-1' as EventId;
const INTENT_2 = 'order-intent-2' as EventId;

function submissionAck(intentId: EventId = INTENT_1): OrderAckSubmissionPayload {
  return {
    intent_id: intentId,
    submission_ack_id: `submission-ack-${intentId}` as EventId,
    broker_order_id: `broker-${intentId}`,
    broker_account_id: 'paper-account-1',
    instrument_symbol: 'MNQM6',
  };
}

function fillAck(
  intentId: EventId = INTENT_1,
  fillKind: OrderAckFillPayload['fill_kind'] = 'FULL',
): OrderAckFillPayload {
  return {
    intent_id: intentId,
    submission_ack_id: `submission-ack-${intentId}` as EventId,
    fill_ack_id: `fill-ack-${intentId}-${fillKind}` as EventId,
    broker_order_id: `broker-${intentId}`,
    broker_account_id: 'paper-account-1',
    instrument_symbol: 'MNQM6',
    fill_qty: 1,
    fill_price: 18500.25,
    fill_kind: fillKind,
  };
}

function quarantinedMachine(
  intentId: EventId,
  options: ConstructorParameters<typeof OrderLifecycleStateMachine>[0] = {},
): OrderLifecycleStateMachine {
  const machine = new OrderLifecycleStateMachine(options);
  machine.createPendingIntent({ intent_id: intentId });
  machine.markSubmitted(intentId);
  machine.submissionAckTimeout(intentId);
  return machine;
}

describe('QFA-628 order lifecycle state machine', () => {
  it('runs the happy path from intent to full fill', () => {
    const events: OrderLifecycleEmittedEvent[] = [];
    const machine = new OrderLifecycleStateMachine({ emit: (event) => events.push(event) });

    expect(machine.createPendingIntent({ intent_id: INTENT_1 }).state).toBe('pending_intent');
    expect(machine.markSubmitted(INTENT_1).state).toBe('pending_ack');
    expect(machine.ackSubmission(submissionAck()).state).toBe('acked_resting');
    expect(machine.ackFill(fillAck()).state).toBe('filled');

    expect(machine.submission_gate.acquire()).toEqual({ allowed: true });
    expect(events.map((event) => event.type)).toEqual([
      'ORDER_ACK_SUBMISSION',
      'ORDER_ACK_FILL',
    ]);
  });

  it('quarantines and blocks new submissions on submission ACK timeout', () => {
    const gate = new SubmissionGate();
    const events: OrderLifecycleEmittedEvent[] = [];
    const machine = new OrderLifecycleStateMachine({
      submission_gate: gate,
      emit: (event) => events.push(event),
    });

    machine.createPendingIntent({ intent_id: INTENT_1 });
    machine.markSubmitted(INTENT_1);
    const snapshot = machine.submissionAckTimeout(INTENT_1);

    expect(snapshot.state).toBe('quarantined');
    expect(gate.acquire()).toEqual({
      allowed: false,
      reason: 'quarantine_active',
      open_quarantine_count: 1,
    });
    expect(events).toContainEqual({
      type: 'ORDER_QUARANTINE_ENTERED',
      payload: {
        intent_id: INTENT_1,
        previous_state: 'pending_ack',
        quarantine_reason: 'submission_ack_timeout',
        open_quarantine_count: 1,
      },
    });
  });

  it('reconciles broker-confirmed pending orders by cancelling them synchronously', () => {
    const events: OrderLifecycleEmittedEvent[] = [];
    const client = new MockBrokerReconciliationClient({
      [INTENT_1]: {
        dispatch: 'pending',
        submission_ack_id: 'submission-ack-reconciled' as EventId,
        broker_order_id: 'broker-order-1',
        broker_account_id: 'paper-account-1',
        instrument_symbol: 'MNQM6',
      },
    });
    const machine = quarantinedMachine(INTENT_1, {
      reconciliation_client: client,
      emit: (event) => events.push(event),
    });

    expect(machine.reconcileQuarantinedOrder(INTENT_1).state).toBe('cancelled');
    expect(machine.submission_gate.acquire()).toEqual({ allowed: true });
    expect(events.map((event) => event.type)).toEqual([
      'ORDER_QUARANTINE_ENTERED',
      'ORDER_CANCEL_INTENT',
      'ORDER_ACK_CANCEL',
      'ORDER_QUARANTINE_CLEARED',
    ]);
  });

  it('adopts broker partial state and emits a deterministic synthetic fill ACK id', () => {
    const events: OrderLifecycleEmittedEvent[] = [];
    const client = new MockBrokerReconciliationClient({
      [INTENT_1]: {
        dispatch: 'partial',
        broker_order_id: 'broker-order-1',
        broker_account_id: 'paper-account-1',
        instrument_symbol: 'MNQM6',
        fill_qty: 1,
        fill_price: 18500.25,
      },
    });
    const machine = quarantinedMachine(INTENT_1, {
      reconciliation_client: client,
      emit: (event) => events.push(event),
    });

    expect(machine.reconcileQuarantinedOrder(INTENT_1).state).toBe('partial_fill');
    expect(events).toContainEqual({
      type: 'ORDER_ACK_FILL',
      payload: {
        intent_id: INTENT_1,
        submission_ack_id: 'synthetic-submission-ack:order-intent-1',
        fill_ack_id: syntheticFillAckIdForReconciliation(INTENT_1, 'PARTIAL'),
        broker_order_id: 'broker-order-1',
        broker_account_id: 'paper-account-1',
        instrument_symbol: 'MNQM6',
        fill_qty: 1,
        fill_price: 18500.25,
        fill_kind: 'PARTIAL',
      },
    });
    expect(machine.submission_gate.acquire()).toEqual({ allowed: true });
  });

  it('adopts broker filled state', () => {
    const client = new MockBrokerReconciliationClient({
      [INTENT_1]: {
        dispatch: 'filled',
        fill_ack_id: 'broker-fill-ack-1' as EventId,
        broker_order_id: 'broker-order-1',
        broker_account_id: 'paper-account-1',
        instrument_symbol: 'MNQM6',
        fill_qty: 2,
        fill_price: 18502,
      },
    });
    const machine = quarantinedMachine(INTENT_1, { reconciliation_client: client });

    const snapshot = machine.reconcileQuarantinedOrder(INTENT_1);

    expect(snapshot.state).toBe('filled');
    expect(snapshot.broker_order_id).toBe('broker-order-1');
    expect(machine.submission_gate.acquire()).toEqual({ allowed: true });
  });

  it('keeps unknown broker reconciliation results quarantined', () => {
    const events: OrderLifecycleEmittedEvent[] = [];
    const client = new MockBrokerReconciliationClient({
      [INTENT_1]: { dispatch: 'unknown', detail: 'broker lookup inconclusive' },
    });
    const machine = quarantinedMachine(INTENT_1, {
      reconciliation_client: client,
      emit: (event) => events.push(event),
    });

    expect(machine.reconcileQuarantinedOrder(INTENT_1).state).toBe('quarantined');
    expect(machine.submission_gate.acquire()).toEqual({
      allowed: false,
      reason: 'quarantine_active',
      open_quarantine_count: 1,
    });
    expect(events.map((event) => event.type)).toEqual(['ORDER_QUARANTINE_ENTERED']);
  });

  it('clears two concurrent quarantines only after both resolve', () => {
    const events: OrderLifecycleEmittedEvent[] = [];
    const client = new MockBrokerReconciliationClient({
      [INTENT_1]: {
        dispatch: 'pending',
        broker_order_id: 'broker-order-1',
        broker_account_id: 'paper-account-1',
      },
      [INTENT_2]: {
        dispatch: 'pending',
        broker_order_id: 'broker-order-2',
        broker_account_id: 'paper-account-1',
      },
    });
    const machine = new OrderLifecycleStateMachine({
      reconciliation_client: client,
      emit: (event) => events.push(event),
    });

    for (const intentId of [INTENT_1, INTENT_2]) {
      machine.createPendingIntent({ intent_id: intentId });
      machine.markSubmitted(intentId);
      machine.submissionAckTimeout(intentId);
    }

    expect(machine.open_quarantine_count).toBe(2);
    expect(machine.reconcileQuarantinedOrder(INTENT_1).state).toBe('cancelled');
    expect(machine.open_quarantine_count).toBe(1);
    expect(events.filter((event) => event.type === 'ORDER_QUARANTINE_CLEARED')).toHaveLength(0);

    expect(machine.reconcileQuarantinedOrder(INTENT_2).state).toBe('cancelled');
    expect(machine.open_quarantine_count).toBe(0);
    expect(events.filter((event) => event.type === 'ORDER_QUARANTINE_CLEARED')).toHaveLength(1);
  });

  it('throws on illegal transitions', () => {
    const machine = new OrderLifecycleStateMachine();
    machine.createPendingIntent({ intent_id: INTENT_1 });

    expect(() => machine.ackFill(fillAck())).toThrow(
      'illegal order lifecycle transition for intent order-intent-1: pending_intent -> filled',
    );
    expect(() => machine.submissionAckTimeout(INTENT_1)).toThrow(
      'illegal order lifecycle transition for intent order-intent-1: pending_intent -> quarantined',
    );
  });
});
