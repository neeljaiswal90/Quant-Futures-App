import { describe, expect, it } from 'vitest';
import type {
  EventId,
  OrderAckFillPayload,
  OrderAckSubmissionPayload,
} from '../../src/contracts/index.js';
import {
  DEFAULT_CANCEL_ACK_TIMEOUT_MS,
  DEFAULT_SUBMISSION_ACK_TIMEOUT_MS,
  MockBrokerReconciliationClient,
  OrderLifecycleStateMachine,
  PROVISIONAL_CANCEL_ACK_SLO,
  type OrderLifecycleEmittedEvent,
  type QuarantineCounter,
  type QuarantineCounterContext,
} from '../../src/execution/order-lifecycle-state-machine.js';

const INTENT_1 = 'order-intent-cancel-1' as EventId;

describe('QFA-632 cancel ACK timeout policy', () => {
  it('uses the cancel ACK timeout for cancel-pending orders, not the submission default', () => {
    const machine = new OrderLifecycleStateMachine();
    machine.createPendingIntent({ intent_id: INTENT_1 });
    machine.markSubmitted(INTENT_1);

    expect(machine.pendingAckTimeoutMs(INTENT_1)).toBe(DEFAULT_SUBMISSION_ACK_TIMEOUT_MS);

    machine.ackSubmission(submissionAck());
    const cancelPending = machine.requestCancel(INTENT_1);

    expect(cancelPending.state).toBe('pending_ack');
    expect(machine.pendingAckTimeoutMs(INTENT_1)).toBe(DEFAULT_CANCEL_ACK_TIMEOUT_MS);
    expect(DEFAULT_CANCEL_ACK_TIMEOUT_MS).toBeLessThan(DEFAULT_SUBMISSION_ACK_TIMEOUT_MS);
  });

  it('quarantines on cancel ACK timeout and blocks new submissions', () => {
    const events: OrderLifecycleEmittedEvent[] = [];
    const counter = new RecordingQuarantineCounter();
    const machine = ackedMachine({
      quarantine_counter: counter,
      emit: (event) => events.push(event),
    });

    machine.requestCancel(INTENT_1);
    const snapshot = machine.ackTimeout(INTENT_1);

    expect(snapshot).toMatchObject({
      state: 'quarantined',
      quarantine_reason: 'cancel_ack_timeout',
      cancel_attempt_count: 1,
    });
    expect(machine.submission_gate.acquire()).toEqual({
      allowed: false,
      reason: 'quarantine_active',
      open_quarantine_count: 1,
    });
    expect(counter.incrementContexts).toEqual([
      { intent_id: INTENT_1, reason: 'cancel_ack_timeout' },
    ]);
    expect(events).toContainEqual({
      type: 'ORDER_QUARANTINE_ENTERED',
      payload: expect.objectContaining({
        intent_id: INTENT_1,
        quarantine_reason: 'cancel_ack_timeout',
        timeout_ms: DEFAULT_CANCEL_ACK_TIMEOUT_MS,
        cancel_attempt_count: 1,
        max_cancel_attempts: 3,
        escalation_required: false,
        is_provisional: true,
      }),
    });
  });

  it('re-issues cancel after pending reconciliation and increments cancel attempt count', () => {
    const events: OrderLifecycleEmittedEvent[] = [];
    const machine = cancelQuarantinedMachine({
      reconciliation_client: new MockBrokerReconciliationClient({
        [INTENT_1]: {
          dispatch: 'pending',
          broker_order_id: 'broker-order-1',
          broker_account_id: 'paper-account-1',
          instrument_symbol: 'MNQM6',
        },
      }),
      cancel_pending_order: () => undefined,
      emit: (event) => events.push(event),
    });

    const snapshot = machine.reconcileQuarantinedOrder(INTENT_1);

    expect(snapshot).toMatchObject({
      state: 'pending_ack',
      cancel_requested: true,
      cancel_attempt_count: 2,
    });
    expect(events).toContainEqual({
      type: 'ORDER_CANCEL_INTENT',
      payload: expect.objectContaining({
        intent_id: INTENT_1,
        cancel_attempt_count: 2,
        max_cancel_attempts: 3,
        is_provisional: true,
      }),
    });
    expect(machine.submission_gate.acquire()).toEqual({
      allowed: false,
      reason: 'quarantine_active',
      open_quarantine_count: 1,
    });
  });

  it('adopts broker partial state after cancel quarantine and withdraws cancel intent state', () => {
    const events: OrderLifecycleEmittedEvent[] = [];
    const machine = cancelQuarantinedMachine({
      reconciliation_client: new MockBrokerReconciliationClient({
        [INTENT_1]: {
          dispatch: 'partial',
          broker_order_id: 'broker-order-1',
          broker_account_id: 'paper-account-1',
          instrument_symbol: 'MNQM6',
          fill_qty: 1,
          fill_price: 18500.25,
        },
      }),
      emit: (event) => events.push(event),
    });

    const snapshot = machine.reconcileQuarantinedOrder(INTENT_1);

    expect(snapshot).toMatchObject({
      state: 'partial_fill',
      cancel_requested: false,
    });
    expect(events).toContainEqual({
      type: 'ORDER_ACK_FILL',
      payload: expect.objectContaining({
        intent_id: INTENT_1,
        fill_kind: 'PARTIAL',
      } satisfies Partial<OrderAckFillPayload>),
    });
    expect(machine.submission_gate.acquire()).toEqual({ allowed: true });
  });

  it('adopts broker filled state after cancel quarantine and clears quarantine', () => {
    const machine = cancelQuarantinedMachine({
      reconciliation_client: new MockBrokerReconciliationClient({
        [INTENT_1]: {
          dispatch: 'filled',
          broker_order_id: 'broker-order-1',
          broker_account_id: 'paper-account-1',
          instrument_symbol: 'MNQM6',
          fill_qty: 1,
          fill_price: 18500.25,
        },
      }),
    });

    const snapshot = machine.reconcileQuarantinedOrder(INTENT_1);

    expect(snapshot.state).toBe('filled');
    expect(snapshot.cancel_requested).toBe(false);
    expect(machine.submission_gate.acquire()).toEqual({ allowed: true });
  });

  it('locks into quarantined escalation after max cancel attempts are exhausted', () => {
    const events: OrderLifecycleEmittedEvent[] = [];
    const machine = cancelQuarantinedMachine({
      reconciliation_client: new MockBrokerReconciliationClient({
        [INTENT_1]: {
          dispatch: 'pending',
          broker_order_id: 'broker-order-1',
          broker_account_id: 'paper-account-1',
          instrument_symbol: 'MNQM6',
        },
      }),
      cancel_pending_order: () => undefined,
      emit: (event) => events.push(event),
    });

    expect(machine.reconcileQuarantinedOrder(INTENT_1).cancel_attempt_count).toBe(2);
    machine.cancelAckTimeout(INTENT_1);
    expect(machine.reconcileQuarantinedOrder(INTENT_1).cancel_attempt_count).toBe(3);
    const escalated = machine.cancelAckTimeout(INTENT_1);

    expect(escalated).toMatchObject({
      state: 'quarantined',
      cancel_attempt_count: 3,
      escalation_required: true,
    });
    expect(machine.reconcileQuarantinedOrder(INTENT_1)).toMatchObject({
      state: 'quarantined',
      escalation_required: true,
    });
    expect(events.filter((event) => event.type === 'ORDER_CANCEL_INTENT')).toHaveLength(2);
    expect(machine.submission_gate.acquire()).toEqual({
      allowed: false,
      reason: 'quarantine_active',
      open_quarantine_count: 1,
    });
  });

  it('exports the provisional cancel ACK SLO budget for registry consolidation', () => {
    expect(PROVISIONAL_CANCEL_ACK_SLO).toEqual({
      metric_name: 'qfa_order_ack_cancel_ms',
      windows: [
        {
          window_id: '5m',
          window_duration_ms: 300_000,
          sample_count_floor: 0,
          p95_budget_ms: 500,
        },
        {
          window_id: '1h',
          window_duration_ms: 3_600_000,
          sample_count_floor: 0,
          p95_budget_ms: 500,
        },
      ],
      is_provisional: true,
      breach_eligibility: 'not_applicable_until_phase_6_ack',
    });
  });
});

function ackedMachine(
  options: ConstructorParameters<typeof OrderLifecycleStateMachine>[0] = {},
): OrderLifecycleStateMachine {
  const machine = new OrderLifecycleStateMachine(options);
  machine.createPendingIntent({ intent_id: INTENT_1 });
  machine.markSubmitted(INTENT_1);
  machine.ackSubmission(submissionAck());
  return machine;
}

function cancelQuarantinedMachine(
  options: ConstructorParameters<typeof OrderLifecycleStateMachine>[0] = {},
): OrderLifecycleStateMachine {
  const machine = ackedMachine(options);
  machine.requestCancel(INTENT_1);
  machine.cancelAckTimeout(INTENT_1);
  return machine;
}

function submissionAck(intentId: EventId = INTENT_1): OrderAckSubmissionPayload {
  return {
    intent_id: intentId,
    submission_ack_id: `submission-ack-${intentId}` as EventId,
    broker_order_id: `broker-${intentId}`,
    broker_account_id: 'paper-account-1',
    instrument_symbol: 'MNQM6',
  };
}

class RecordingQuarantineCounter implements QuarantineCounter {
  readonly incrementContexts: QuarantineCounterContext[] = [];
  private openCount = 0;

  increment(context?: QuarantineCounterContext): number {
    if (context !== undefined) {
      this.incrementContexts.push(context);
    }
    this.openCount += 1;
    return this.openCount;
  }

  decrement(): number {
    this.openCount -= 1;
    return this.openCount;
  }

  value(): number {
    return this.openCount;
  }
}
