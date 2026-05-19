import type { EventId } from '../contracts/ids.js';
import type {
  OrderAckCancelPayload,
  OrderAckFillPayload,
  OrderAckSubmissionPayload,
  OrderBrokerRejectPayload,
  OrderQuarantineClearedPayload,
  OrderQuarantineEnteredPayload,
} from '../contracts/events/payloads.js';

export const ORDER_LIFECYCLE_STATES = [
  'pending_intent',
  'pending_ack',
  'acked_resting',
  'partial_fill',
  'filled',
  'cancelled',
  'quarantined',
  'broker_rejected',
] as const;

export type OrderLifecycleState = (typeof ORDER_LIFECYCLE_STATES)[number];
export type QuarantineReason = 'submission_ack_timeout' | 'cancel_ack_timeout';
export type QuarantineSourceState = 'pending_ack' | 'acked_resting' | 'partial_fill';

export const ORDER_LIFECYCLE_TRANSITIONS = {
  pending_intent: ['pending_ack'],
  pending_ack: ['acked_resting', 'quarantined', 'broker_rejected'],
  acked_resting: ['partial_fill', 'filled', 'cancelled', 'quarantined'],
  partial_fill: ['partial_fill', 'filled', 'cancelled', 'quarantined'],
  filled: [],
  cancelled: [],
  quarantined: ['partial_fill', 'filled', 'cancelled', 'broker_rejected'],
  broker_rejected: [],
} as const satisfies Record<OrderLifecycleState, readonly OrderLifecycleState[]>;

export interface QuarantineCounterContext {
  readonly intent_id: EventId;
  readonly reason?: QuarantineReason;
}

export interface QuarantineCounter {
  increment(context?: QuarantineCounterContext): number;
  decrement(context?: QuarantineCounterContext): number;
  value(): number;
}

export class DeterministicInMemoryQuarantineCounter implements QuarantineCounter {
  private openQuarantineCount = 0;

  increment(_context?: QuarantineCounterContext): number {
    this.openQuarantineCount += 1;
    return this.openQuarantineCount;
  }

  decrement(_context?: QuarantineCounterContext): number {
    if (this.openQuarantineCount === 0) {
      throw new Error('quarantine counter underflow');
    }
    this.openQuarantineCount -= 1;
    return this.openQuarantineCount;
  }

  value(): number {
    return this.openQuarantineCount;
  }
}

export type SubmissionGateAcquireResult =
  | {
      readonly allowed: true;
    }
  | {
      readonly allowed: false;
      readonly reason: 'quarantine_active';
      readonly open_quarantine_count: number;
    };

export class SubmissionGate {
  private readonly counter: QuarantineCounter;

  constructor(counter: QuarantineCounter = new DeterministicInMemoryQuarantineCounter()) {
    this.counter = counter;
  }

  acquire(): SubmissionGateAcquireResult {
    const openQuarantineCount = this.open_quarantine_count;
    if (openQuarantineCount > 0) {
      return {
        allowed: false,
        reason: 'quarantine_active',
        open_quarantine_count: openQuarantineCount,
      };
    }
    return { allowed: true };
  }

  blockFromQuarantine(context?: QuarantineCounterContext): number {
    return this.counter.increment(context);
  }

  unblockFromQuarantine(context?: QuarantineCounterContext): number {
    return this.counter.decrement(context);
  }

  get open_quarantine_count(): number {
    return this.counter.value();
  }
}

export interface BrokerReconciliationRequest {
  readonly intent_id: EventId;
  readonly state: 'quarantined';
  readonly submission_ack_id?: EventId;
  readonly broker_order_id?: string;
  readonly broker_account_id?: string;
  readonly instrument_symbol?: string;
  readonly quarantine_reason?: QuarantineReason;
  readonly state_before_quarantine?: QuarantineSourceState;
}

export type BrokerReconciliationResult =
  | {
      readonly dispatch: 'pending';
      readonly submission_ack_id?: EventId;
      readonly broker_order_id: string;
      readonly broker_account_id: string;
      readonly instrument_symbol?: string;
    }
  | {
      readonly dispatch: 'partial';
      readonly submission_ack_id?: EventId;
      readonly fill_ack_id?: EventId;
      readonly broker_order_id: string;
      readonly broker_account_id: string;
      readonly instrument_symbol: string;
      readonly fill_qty: number;
      readonly fill_price: number;
    }
  | {
      readonly dispatch: 'filled';
      readonly submission_ack_id?: EventId;
      readonly fill_ack_id?: EventId;
      readonly broker_order_id: string;
      readonly broker_account_id: string;
      readonly instrument_symbol: string;
      readonly fill_qty: number;
      readonly fill_price: number;
    }
  | {
      readonly dispatch: 'rejected';
      readonly broker_order_id?: string;
      readonly broker_account_id: string;
      readonly reject_reason_code: string;
      readonly reject_subreason?: string;
      readonly reject_message_redacted: string;
    }
  | {
      readonly dispatch: 'unknown';
      readonly detail?: string;
    };

export interface BrokerReconciliationClient {
  reconcile(request: BrokerReconciliationRequest): BrokerReconciliationResult;
}

export class MockBrokerReconciliationClient implements BrokerReconciliationClient {
  private readonly results = new Map<string, BrokerReconciliationResult>();

  constructor(
    results:
      | ReadonlyMap<EventId, BrokerReconciliationResult>
      | Readonly<Record<string, BrokerReconciliationResult>> = {},
  ) {
    if (results instanceof Map) {
      for (const [intentId, result] of results.entries()) {
        this.results.set(intentId, result);
      }
    } else {
      for (const [intentId, result] of Object.entries(results)) {
        this.results.set(intentId, result);
      }
    }
  }

  reconcile(request: BrokerReconciliationRequest): BrokerReconciliationResult {
    return this.results.get(request.intent_id) ?? { dispatch: 'unknown' };
  }

  setResult(intentId: EventId, result: BrokerReconciliationResult): this {
    this.results.set(intentId, result);
    return this;
  }
}

export interface OrderCancelIntentPayload {
  readonly intent_id: EventId;
  readonly submission_ack_id: EventId;
  readonly broker_order_id: string;
  readonly broker_account_id: string;
  readonly instrument_symbol?: string;
  readonly cancel_reason: 'quarantine_reconciliation_pending';
}

export type OrderLifecycleEmittedEvent =
  | {
      readonly type: 'ORDER_ACK_SUBMISSION';
      readonly payload: OrderAckSubmissionPayload;
    }
  | {
      readonly type: 'ORDER_ACK_FILL';
      readonly payload: OrderAckFillPayload;
    }
  | {
      readonly type: 'ORDER_ACK_CANCEL';
      readonly payload: OrderAckCancelPayload;
    }
  | {
      readonly type: 'ORDER_BROKER_REJECT';
      readonly payload: OrderBrokerRejectPayload;
    }
  | {
      readonly type: 'ORDER_QUARANTINE_ENTERED';
      readonly payload: OrderQuarantineEnteredPayload;
    }
  | {
      readonly type: 'ORDER_QUARANTINE_CLEARED';
      readonly payload: OrderQuarantineClearedPayload;
    }
  | {
      readonly type: 'ORDER_CANCEL_INTENT';
      readonly payload: OrderCancelIntentPayload;
    };

export interface PendingBrokerCancelRequest extends OrderCancelIntentPayload {}
export type PendingBrokerCancelHandler = (
  request: PendingBrokerCancelRequest,
) => OrderAckCancelPayload;

export interface OrderLifecycleStateMachineOptions {
  readonly submission_gate?: SubmissionGate;
  readonly quarantine_counter?: QuarantineCounter;
  readonly reconciliation_client?: BrokerReconciliationClient;
  readonly cancel_pending_order?: PendingBrokerCancelHandler;
  readonly emit?: (event: OrderLifecycleEmittedEvent) => void;
}

export interface CreatePendingIntentInput {
  readonly intent_id: EventId;
}

export interface OrderLifecycleSnapshot {
  readonly intent_id: EventId;
  readonly state: OrderLifecycleState;
  readonly submission_ack_id?: EventId;
  readonly broker_order_id?: string;
  readonly broker_account_id?: string;
  readonly instrument_symbol?: string;
  readonly cancel_requested: boolean;
  readonly quarantine_reason?: QuarantineReason;
  readonly state_before_quarantine?: QuarantineSourceState;
}

interface OrderLifecycleRecord {
  intent_id: EventId;
  state: OrderLifecycleState;
  submission_ack_id?: EventId;
  broker_order_id?: string;
  broker_account_id?: string;
  instrument_symbol?: string;
  cancel_requested: boolean;
  quarantine_reason?: QuarantineReason;
  state_before_quarantine?: QuarantineSourceState;
}

export class OrderLifecycleStateMachine {
  readonly submission_gate: SubmissionGate;

  private readonly orders = new Map<string, OrderLifecycleRecord>();
  private readonly quarantinedIntentIds = new Set<string>();
  private readonly resolvedSinceLastClear: EventId[] = [];
  private readonly reconciliationClient?: BrokerReconciliationClient;
  private readonly cancelPendingOrder?: PendingBrokerCancelHandler;
  private readonly emitEvent: (event: OrderLifecycleEmittedEvent) => void;

  constructor(options: OrderLifecycleStateMachineOptions = {}) {
    this.submission_gate =
      options.submission_gate ?? new SubmissionGate(options.quarantine_counter);
    this.reconciliationClient = options.reconciliation_client;
    this.cancelPendingOrder = options.cancel_pending_order;
    this.emitEvent = options.emit ?? (() => undefined);
  }

  createPendingIntent(input: CreatePendingIntentInput): OrderLifecycleSnapshot {
    if (this.orders.has(input.intent_id)) {
      throw new Error(`order lifecycle already exists for intent ${input.intent_id}`);
    }

    const order: OrderLifecycleRecord = {
      intent_id: input.intent_id,
      state: 'pending_intent',
      cancel_requested: false,
    };
    this.orders.set(input.intent_id, order);
    return snapshot(order);
  }

  markSubmitted(intentId: EventId): OrderLifecycleSnapshot {
    const order = this.requireOrder(intentId);
    this.transition(order, 'pending_ack');
    return snapshot(order);
  }

  ackSubmission(payload: OrderAckSubmissionPayload): OrderLifecycleSnapshot {
    const order = this.requireOrder(payload.intent_id);
    this.transition(order, 'acked_resting');
    applyBrokerIdentity(order, payload);
    this.emitEvent({ type: 'ORDER_ACK_SUBMISSION', payload });
    return snapshot(order);
  }

  ackFill(payload: OrderAckFillPayload): OrderLifecycleSnapshot {
    const order = this.requireOrder(payload.intent_id);
    const nextState = payload.fill_kind === 'FULL' ? 'filled' : 'partial_fill';
    const wasQuarantined = order.state === 'quarantined';
    this.transition(order, nextState);
    applyBrokerIdentity(order, payload);
    this.emitEvent({ type: 'ORDER_ACK_FILL', payload });
    if (wasQuarantined) {
      this.releaseQuarantine(order, 'all_quarantines_resolved');
    }
    return snapshot(order);
  }

  requestCancel(intentId: EventId): OrderLifecycleSnapshot {
    const order = this.requireOrder(intentId);
    if (order.state !== 'acked_resting' && order.state !== 'partial_fill') {
      throw illegalTransitionError(order, order.state);
    }
    order.cancel_requested = true;
    return snapshot(order);
  }

  ackCancel(payload: OrderAckCancelPayload): OrderLifecycleSnapshot {
    const order = this.requireOrder(payload.intent_id);
    const wasQuarantined = order.state === 'quarantined';
    this.transition(order, 'cancelled');
    applyBrokerIdentity(order, payload);
    order.cancel_requested = false;
    this.emitEvent({ type: 'ORDER_ACK_CANCEL', payload });
    if (wasQuarantined) {
      this.releaseQuarantine(order, 'all_quarantines_resolved');
    }
    return snapshot(order);
  }

  brokerReject(payload: OrderBrokerRejectPayload): OrderLifecycleSnapshot {
    const order = this.requireOrder(payload.intent_id);
    const wasQuarantined = order.state === 'quarantined';
    this.transition(order, 'broker_rejected');
    applyBrokerIdentity(order, payload);
    this.emitEvent({ type: 'ORDER_BROKER_REJECT', payload });
    if (wasQuarantined) {
      this.releaseQuarantine(order, 'all_quarantines_resolved');
    }
    return snapshot(order);
  }

  submissionAckTimeout(intentId: EventId): OrderLifecycleSnapshot {
    const order = this.requireOrder(intentId);
    return this.enterQuarantine(order, 'submission_ack_timeout');
  }

  cancelAckTimeout(intentId: EventId): OrderLifecycleSnapshot {
    const order = this.requireOrder(intentId);
    return this.enterQuarantine(order, 'cancel_ack_timeout');
  }

  reconcileQuarantinedOrder(intentId: EventId): OrderLifecycleSnapshot {
    if (this.reconciliationClient === undefined) {
      throw new Error('broker reconciliation client is required');
    }
    const order = this.requireOrder(intentId);
    this.requireQuarantined(order);
    const result = this.reconciliationClient.reconcile(reconciliationRequest(order));
    return this.applyReconciliationResult(order, result);
  }

  applyReconciliationResult(
    intentIdOrOrder: EventId | OrderLifecycleSnapshot,
    result: BrokerReconciliationResult,
  ): OrderLifecycleSnapshot {
    const order = typeof intentIdOrOrder === 'string'
      ? this.requireOrder(intentIdOrOrder as EventId)
      : this.requireOrder(intentIdOrOrder.intent_id);
    this.requireQuarantined(order);

    switch (result.dispatch) {
      case 'unknown':
        return snapshot(order);
      case 'pending':
        return this.reconcileBrokerPending(order, result);
      case 'partial':
      case 'filled':
        return this.reconcileBrokerFill(order, result);
      case 'rejected':
        return this.reconcileBrokerRejected(order, result);
      default:
        return assertNeverReconciliationResult(result);
    }
  }

  operatorCloseQuarantine(
    intentId: EventId,
    terminalState: Extract<OrderLifecycleState, 'cancelled' | 'filled' | 'broker_rejected'> = 'cancelled',
  ): OrderLifecycleSnapshot {
    const order = this.requireOrder(intentId);
    this.requireQuarantined(order);
    this.transition(order, terminalState);
    this.releaseQuarantine(order, 'operator_close');
    return snapshot(order);
  }

  getOrderSnapshot(intentId: EventId): OrderLifecycleSnapshot {
    return snapshot(this.requireOrder(intentId));
  }

  get open_quarantine_count(): number {
    return this.submission_gate.open_quarantine_count;
  }

  private enterQuarantine(
    order: OrderLifecycleRecord,
    reason: QuarantineReason,
  ): OrderLifecycleSnapshot {
    if (!isQuarantineSourceState(order.state)) {
      throw illegalTransitionError(order, 'quarantined');
    }

    const previousState = order.state;
    this.transition(order, 'quarantined');
    order.quarantine_reason = reason;
    order.state_before_quarantine = previousState;
    const openQuarantineCount = this.submission_gate.blockFromQuarantine({
      intent_id: order.intent_id,
      reason,
    });
    this.quarantinedIntentIds.add(order.intent_id);
    this.emitEvent({
      type: 'ORDER_QUARANTINE_ENTERED',
      payload: quarantineEnteredPayload(order, previousState, reason, openQuarantineCount),
    });
    return snapshot(order);
  }

  private reconcileBrokerPending(
    order: OrderLifecycleRecord,
    result: Extract<BrokerReconciliationResult, { readonly dispatch: 'pending' }>,
  ): OrderLifecycleSnapshot {
    if (!isNonEmptyString(result.broker_order_id)) {
      return snapshot(order);
    }

    const submissionAckId = result.submission_ack_id
      ?? order.submission_ack_id
      ?? syntheticSubmissionAckIdForReconciliation(order.intent_id);
    const cancelIntent: OrderCancelIntentPayload = {
      intent_id: order.intent_id,
      submission_ack_id: submissionAckId,
      broker_order_id: result.broker_order_id,
      broker_account_id: result.broker_account_id,
      ...(result.instrument_symbol === undefined ? {} : { instrument_symbol: result.instrument_symbol }),
      cancel_reason: 'quarantine_reconciliation_pending',
    };

    order.submission_ack_id = submissionAckId;
    order.broker_order_id = result.broker_order_id;
    order.broker_account_id = result.broker_account_id;
    if (result.instrument_symbol !== undefined) {
      order.instrument_symbol = result.instrument_symbol;
    }

    this.emitEvent({ type: 'ORDER_CANCEL_INTENT', payload: cancelIntent });
    const cancelAck = this.cancelPendingOrder?.(cancelIntent) ?? {
      intent_id: order.intent_id,
      submission_ack_id: submissionAckId,
      cancel_ack_id: syntheticCancelAckIdForReconciliation(order.intent_id),
      broker_order_id: result.broker_order_id,
      broker_account_id: result.broker_account_id,
      cancel_reason: 'CLIENT_REQUESTED',
    };
    return this.ackCancel(cancelAck);
  }

  private reconcileBrokerFill(
    order: OrderLifecycleRecord,
    result: Extract<BrokerReconciliationResult, { readonly dispatch: 'partial' | 'filled' }>,
  ): OrderLifecycleSnapshot {
    const fillKind = result.dispatch === 'filled' ? 'FULL' : 'PARTIAL';
    const payload: OrderAckFillPayload = {
      intent_id: order.intent_id,
      submission_ack_id: result.submission_ack_id
        ?? order.submission_ack_id
        ?? syntheticSubmissionAckIdForReconciliation(order.intent_id),
      fill_ack_id: result.fill_ack_id
        ?? syntheticFillAckIdForReconciliation(order.intent_id, fillKind),
      broker_order_id: result.broker_order_id,
      broker_account_id: result.broker_account_id,
      instrument_symbol: result.instrument_symbol,
      fill_qty: result.fill_qty,
      fill_price: result.fill_price,
      fill_kind: fillKind,
    };
    return this.ackFill(payload);
  }

  private reconcileBrokerRejected(
    order: OrderLifecycleRecord,
    result: Extract<BrokerReconciliationResult, { readonly dispatch: 'rejected' }>,
  ): OrderLifecycleSnapshot {
    return this.brokerReject({
      intent_id: order.intent_id,
      ...(result.broker_order_id === undefined ? {} : { broker_order_id: result.broker_order_id }),
      broker_account_id: result.broker_account_id,
      reject_reason_code: result.reject_reason_code,
      ...(result.reject_subreason === undefined ? {} : { reject_subreason: result.reject_subreason }),
      reject_message_redacted: result.reject_message_redacted,
    });
  }

  private releaseQuarantine(
    order: OrderLifecycleRecord,
    clearReason: OrderQuarantineClearedPayload['clear_reason'],
  ): void {
    if (!this.quarantinedIntentIds.has(order.intent_id)) {
      return;
    }

    this.quarantinedIntentIds.delete(order.intent_id);
    order.quarantine_reason = undefined;
    order.state_before_quarantine = undefined;
    const openQuarantineCount = this.submission_gate.unblockFromQuarantine({
      intent_id: order.intent_id,
    });
    this.resolvedSinceLastClear.push(order.intent_id);

    if (openQuarantineCount === 0) {
      this.emitEvent({
        type: 'ORDER_QUARANTINE_CLEARED',
        payload: {
          clear_reason: clearReason,
          open_quarantine_count: 0,
          resolved_intent_ids: [...this.resolvedSinceLastClear],
        },
      });
      this.resolvedSinceLastClear.splice(0);
    }
  }

  private requireOrder(intentId: EventId): OrderLifecycleRecord {
    const order = this.orders.get(intentId);
    if (order === undefined) {
      throw new Error(`unknown order intent ${intentId}`);
    }
    return order;
  }

  private requireQuarantined(order: OrderLifecycleRecord): void {
    if (order.state !== 'quarantined') {
      throw illegalTransitionError(order, order.state);
    }
  }

  private transition(order: OrderLifecycleRecord, nextState: OrderLifecycleState): void {
    const allowedStates = ORDER_LIFECYCLE_TRANSITIONS[order.state] as readonly OrderLifecycleState[];
    if (!allowedStates.includes(nextState)) {
      throw illegalTransitionError(order, nextState);
    }
    order.state = nextState;
  }
}

export function syntheticSubmissionAckIdForReconciliation(intentId: EventId): EventId {
  return `synthetic-submission-ack:${intentId}` as EventId;
}

export function syntheticFillAckIdForReconciliation(
  intentId: EventId,
  fillKind: OrderAckFillPayload['fill_kind'],
): EventId {
  return `synthetic-fill-ack:${intentId}:${fillKind.toLowerCase()}` as EventId;
}

export function syntheticCancelAckIdForReconciliation(intentId: EventId): EventId {
  return `synthetic-cancel-ack:${intentId}` as EventId;
}

function reconciliationRequest(order: OrderLifecycleRecord): BrokerReconciliationRequest {
  return {
    intent_id: order.intent_id,
    state: 'quarantined',
    ...(order.submission_ack_id === undefined ? {} : { submission_ack_id: order.submission_ack_id }),
    ...(order.broker_order_id === undefined ? {} : { broker_order_id: order.broker_order_id }),
    ...(order.broker_account_id === undefined ? {} : { broker_account_id: order.broker_account_id }),
    ...(order.instrument_symbol === undefined ? {} : { instrument_symbol: order.instrument_symbol }),
    ...(order.quarantine_reason === undefined ? {} : { quarantine_reason: order.quarantine_reason }),
    ...(order.state_before_quarantine === undefined
      ? {}
      : { state_before_quarantine: order.state_before_quarantine }),
  };
}

function snapshot(order: OrderLifecycleRecord): OrderLifecycleSnapshot {
  return {
    intent_id: order.intent_id,
    state: order.state,
    cancel_requested: order.cancel_requested,
    ...(order.submission_ack_id === undefined ? {} : { submission_ack_id: order.submission_ack_id }),
    ...(order.broker_order_id === undefined ? {} : { broker_order_id: order.broker_order_id }),
    ...(order.broker_account_id === undefined ? {} : { broker_account_id: order.broker_account_id }),
    ...(order.instrument_symbol === undefined ? {} : { instrument_symbol: order.instrument_symbol }),
    ...(order.quarantine_reason === undefined ? {} : { quarantine_reason: order.quarantine_reason }),
    ...(order.state_before_quarantine === undefined
      ? {}
      : { state_before_quarantine: order.state_before_quarantine }),
  };
}

function applyBrokerIdentity(
  order: OrderLifecycleRecord,
  payload: Partial<{
    readonly submission_ack_id: EventId;
    readonly broker_order_id: string;
    readonly broker_account_id: string;
    readonly instrument_symbol: string;
  }>,
): void {
  if (payload.submission_ack_id !== undefined) {
    order.submission_ack_id = payload.submission_ack_id;
  }
  if (payload.broker_order_id !== undefined) {
    order.broker_order_id = payload.broker_order_id;
  }
  if (payload.broker_account_id !== undefined) {
    order.broker_account_id = payload.broker_account_id;
  }
  if (payload.instrument_symbol !== undefined) {
    order.instrument_symbol = payload.instrument_symbol;
  }
}

function quarantineEnteredPayload(
  order: OrderLifecycleRecord,
  previousState: QuarantineSourceState,
  reason: QuarantineReason,
  openQuarantineCount: number,
): OrderQuarantineEnteredPayload {
  return {
    intent_id: order.intent_id,
    previous_state: previousState,
    quarantine_reason: reason,
    open_quarantine_count: openQuarantineCount,
    ...(order.broker_order_id === undefined ? {} : { broker_order_id: order.broker_order_id }),
    ...(order.broker_account_id === undefined ? {} : { broker_account_id: order.broker_account_id }),
    ...(order.instrument_symbol === undefined ? {} : { instrument_symbol: order.instrument_symbol }),
  };
}

function isQuarantineSourceState(state: OrderLifecycleState): state is QuarantineSourceState {
  return state === 'pending_ack' || state === 'acked_resting' || state === 'partial_fill';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function illegalTransitionError(
  order: Pick<OrderLifecycleRecord, 'intent_id' | 'state'>,
  nextState: OrderLifecycleState,
): Error {
  return new Error(
    `illegal order lifecycle transition for intent ${order.intent_id}: ${order.state} -> ${nextState}`,
  );
}

function assertNeverReconciliationResult(result: never): never {
  throw new Error(`Unhandled broker reconciliation result: ${String(result)}`);
}
