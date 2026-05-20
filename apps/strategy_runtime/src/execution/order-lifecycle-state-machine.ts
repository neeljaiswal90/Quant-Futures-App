import type { EventId } from '../contracts/ids.js';
import type {
  OrderAckCancelPayload,
  OrderAckFillPayload,
  OrderAckSubmissionPayload,
  OrderBrokerRejectPayload,
  OrderQuarantineClearedPayload,
  OrderQuarantineEnteredPayload,
} from '../contracts/events/payloads.js';
import type { SloDefinition } from '../observability/slo-registry.js';

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

export const DEFAULT_SUBMISSION_ACK_TIMEOUT_MS = 2_000;
export const DEFAULT_CANCEL_ACK_TIMEOUT_MS = 1_000;
export const DEFAULT_MAX_CANCEL_ATTEMPTS = 3;

export const PROVISIONAL_CANCEL_ACK_SLO: SloDefinition = {
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
};

export const ORDER_LIFECYCLE_TRANSITIONS = {
  pending_intent: ['pending_ack'],
  pending_ack: ['acked_resting', 'cancelled', 'quarantined', 'broker_rejected'],
  acked_resting: ['pending_ack', 'partial_fill', 'filled', 'cancelled', 'quarantined'],
  partial_fill: ['pending_ack', 'partial_fill', 'filled', 'cancelled', 'quarantined'],
  filled: [],
  cancelled: [],
  quarantined: ['pending_ack', 'partial_fill', 'filled', 'cancelled', 'broker_rejected'],
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

export type SubmissionBlockSource =
  | 'quarantine'
  | 'slo_halt';

export type SubmissionGateAcquireResult =
  | {
      readonly allowed: true;
    }
  | {
      readonly allowed: false;
      readonly reason: 'quarantine_active' | 'slo_halt_active';
      readonly open_quarantine_count: number;
      readonly active_block_sources?: readonly SubmissionBlockSource[];
    };

export class SubmissionGate {
  private readonly counter: QuarantineCounter;
  private readonly activeBlockSources = new Set<SubmissionBlockSource>();

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
        ...this.activeBlockSourcesForResult(),
      };
    }
    if (this.activeBlockSources.has('slo_halt')) {
      return {
        allowed: false,
        reason: 'slo_halt_active',
        open_quarantine_count: openQuarantineCount,
        active_block_sources: this.active_block_sources,
      };
    }
    return { allowed: true };
  }

  requestBlock(source: SubmissionBlockSource): void {
    this.activeBlockSources.add(source);
  }

  releaseBlock(source: SubmissionBlockSource): void {
    this.activeBlockSources.delete(source);
  }

  blockFromQuarantine(context?: QuarantineCounterContext): number {
    const count = this.counter.increment(context);
    this.requestBlock('quarantine');
    return count;
  }

  unblockFromQuarantine(context?: QuarantineCounterContext): number {
    const count = this.counter.decrement(context);
    if (count === 0) {
      this.releaseBlock('quarantine');
    }
    return count;
  }

  get open_quarantine_count(): number {
    return this.counter.value();
  }

  get active_block_sources(): readonly SubmissionBlockSource[] {
    return [...this.activeBlockSources].sort();
  }

  private activeBlockSourcesForResult(): { readonly active_block_sources?: readonly SubmissionBlockSource[] } {
    const activeBlockSources = this.active_block_sources;
    return activeBlockSources.length > 1 ? { active_block_sources: activeBlockSources } : {};
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
  readonly cancel_attempt_count: number;
  readonly max_cancel_attempts: number;
  readonly is_provisional: true;
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
) => OrderAckCancelPayload | undefined;

export interface OrderLifecycleStateMachineOptions {
  readonly submission_gate?: SubmissionGate;
  readonly quarantine_counter?: QuarantineCounter;
  readonly reconciliation_client?: BrokerReconciliationClient;
  readonly cancel_pending_order?: PendingBrokerCancelHandler;
  readonly submission_ack_timeout_ms?: number;
  readonly cancel_ack_timeout_ms?: number;
  readonly max_cancel_attempts?: number;
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
  readonly cancel_attempt_count: number;
  readonly escalation_required: boolean;
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
  cancel_attempt_count: number;
  escalation_required: boolean;
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
  private readonly submissionAckTimeoutMs: number;
  private readonly cancelAckTimeoutMs: number;
  private readonly maxCancelAttempts: number;
  private readonly emitEvent: (event: OrderLifecycleEmittedEvent) => void;

  constructor(options: OrderLifecycleStateMachineOptions = {}) {
    this.submission_gate =
      options.submission_gate ?? new SubmissionGate(options.quarantine_counter);
    this.reconciliationClient = options.reconciliation_client;
    this.cancelPendingOrder = options.cancel_pending_order;
    this.submissionAckTimeoutMs = positiveSafeIntegerOrDefault(
      options.submission_ack_timeout_ms,
      DEFAULT_SUBMISSION_ACK_TIMEOUT_MS,
      'submission_ack_timeout_ms',
    );
    this.cancelAckTimeoutMs = positiveSafeIntegerOrDefault(
      options.cancel_ack_timeout_ms,
      DEFAULT_CANCEL_ACK_TIMEOUT_MS,
      'cancel_ack_timeout_ms',
    );
    this.maxCancelAttempts = positiveSafeIntegerOrDefault(
      options.max_cancel_attempts,
      DEFAULT_MAX_CANCEL_ATTEMPTS,
      'max_cancel_attempts',
    );
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
      cancel_attempt_count: 0,
      escalation_required: false,
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
    const wasUnderQuarantine = this.quarantinedIntentIds.has(order.intent_id);
    this.transition(order, nextState);
    applyBrokerIdentity(order, payload);
    if (wasUnderQuarantine) {
      order.cancel_requested = false;
    }
    this.emitEvent({ type: 'ORDER_ACK_FILL', payload });
    if (wasUnderQuarantine) {
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
    order.cancel_attempt_count += 1;
    this.transition(order, 'pending_ack');
    return snapshot(order);
  }

  ackCancel(payload: OrderAckCancelPayload): OrderLifecycleSnapshot {
    const order = this.requireOrder(payload.intent_id);
    const wasUnderQuarantine = this.quarantinedIntentIds.has(order.intent_id);
    this.transition(order, 'cancelled');
    applyBrokerIdentity(order, payload);
    order.cancel_requested = false;
    this.emitEvent({ type: 'ORDER_ACK_CANCEL', payload });
    if (wasUnderQuarantine) {
      this.releaseQuarantine(order, 'all_quarantines_resolved');
    }
    return snapshot(order);
  }

  brokerReject(payload: OrderBrokerRejectPayload): OrderLifecycleSnapshot {
    const order = this.requireOrder(payload.intent_id);
    const wasUnderQuarantine = this.quarantinedIntentIds.has(order.intent_id);
    this.transition(order, 'broker_rejected');
    applyBrokerIdentity(order, payload);
    order.cancel_requested = false;
    this.emitEvent({ type: 'ORDER_BROKER_REJECT', payload });
    if (wasUnderQuarantine) {
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

  pendingAckTimeoutMs(intentId: EventId): number {
    const order = this.requireOrder(intentId);
    if (order.state !== 'pending_ack') {
      throw illegalTransitionError(order, order.state);
    }
    return order.cancel_requested ? this.cancelAckTimeoutMs : this.submissionAckTimeoutMs;
  }

  ackTimeout(intentId: EventId): OrderLifecycleSnapshot {
    const order = this.requireOrder(intentId);
    if (order.state !== 'pending_ack') {
      throw illegalTransitionError(order, 'quarantined');
    }
    return order.cancel_requested
      ? this.enterQuarantine(order, 'cancel_ack_timeout')
      : this.enterQuarantine(order, 'submission_ack_timeout');
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

  get submission_ack_timeout_ms(): number {
    return this.submissionAckTimeoutMs;
  }

  get cancel_ack_timeout_ms(): number {
    return this.cancelAckTimeoutMs;
  }

  get max_cancel_attempts(): number {
    return this.maxCancelAttempts;
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
    if (reason === 'cancel_ack_timeout' && order.cancel_attempt_count >= this.maxCancelAttempts) {
      order.escalation_required = true;
    }
    const alreadyQuarantined = this.quarantinedIntentIds.has(order.intent_id);
    const openQuarantineCount = alreadyQuarantined
      ? this.submission_gate.open_quarantine_count
      : this.submission_gate.blockFromQuarantine({
          intent_id: order.intent_id,
          reason,
        });
    this.quarantinedIntentIds.add(order.intent_id);
    this.emitEvent({
      type: 'ORDER_QUARANTINE_ENTERED',
      payload: this.quarantineEnteredPayload(order, previousState, reason, openQuarantineCount),
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
    if (order.cancel_attempt_count >= this.maxCancelAttempts) {
      order.escalation_required = true;
      return snapshot(order);
    }

    const submissionAckId = result.submission_ack_id
      ?? order.submission_ack_id
      ?? syntheticSubmissionAckIdForReconciliation(order.intent_id);
    order.cancel_attempt_count += 1;
    const cancelIntent: OrderCancelIntentPayload = {
      intent_id: order.intent_id,
      submission_ack_id: submissionAckId,
      broker_order_id: result.broker_order_id,
      broker_account_id: result.broker_account_id,
      ...(result.instrument_symbol === undefined ? {} : { instrument_symbol: result.instrument_symbol }),
      cancel_attempt_count: order.cancel_attempt_count,
      max_cancel_attempts: this.maxCancelAttempts,
      is_provisional: true,
      cancel_reason: 'quarantine_reconciliation_pending',
    };

    order.submission_ack_id = submissionAckId;
    order.broker_order_id = result.broker_order_id;
    order.broker_account_id = result.broker_account_id;
    if (result.instrument_symbol !== undefined) {
      order.instrument_symbol = result.instrument_symbol;
    }

    this.emitEvent({ type: 'ORDER_CANCEL_INTENT', payload: cancelIntent });
    order.cancel_requested = true;
    this.transition(order, 'pending_ack');
    const cancelAck = this.cancelPendingOrder === undefined
      ? {
          intent_id: order.intent_id,
          submission_ack_id: submissionAckId,
          cancel_ack_id: syntheticCancelAckIdForReconciliation(order.intent_id),
          broker_order_id: result.broker_order_id,
          broker_account_id: result.broker_account_id,
          cancel_reason: 'CLIENT_REQUESTED',
        } satisfies OrderAckCancelPayload
      : this.cancelPendingOrder(cancelIntent);
    if (cancelAck === undefined) {
      return snapshot(order);
    }
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

  private quarantineEnteredPayload(
    order: OrderLifecycleRecord,
    previousState: QuarantineSourceState,
    reason: QuarantineReason,
    openQuarantineCount: number,
  ): OrderQuarantineEnteredPayload {
    const timeoutMs = reason === 'cancel_ack_timeout'
      ? this.cancelAckTimeoutMs
      : this.submissionAckTimeoutMs;
    return {
      intent_id: order.intent_id,
      previous_state: previousState,
      quarantine_reason: reason,
      open_quarantine_count: openQuarantineCount,
      timeout_ms: timeoutMs,
      ...(reason === 'cancel_ack_timeout'
        ? {
            cancel_attempt_count: order.cancel_attempt_count,
            max_cancel_attempts: this.maxCancelAttempts,
            escalation_required: order.escalation_required,
            is_provisional: true,
          }
        : {}),
      ...(order.broker_order_id === undefined ? {} : { broker_order_id: order.broker_order_id }),
      ...(order.broker_account_id === undefined ? {} : { broker_account_id: order.broker_account_id }),
      ...(order.instrument_symbol === undefined ? {} : { instrument_symbol: order.instrument_symbol }),
    };
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
    cancel_attempt_count: order.cancel_attempt_count,
    escalation_required: order.escalation_required,
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

function isQuarantineSourceState(state: OrderLifecycleState): state is QuarantineSourceState {
  return state === 'pending_ack' || state === 'acked_resting' || state === 'partial_fill';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function positiveSafeIntegerOrDefault(
  value: number | undefined,
  defaultValue: number,
  fieldName: string,
): number {
  const resolved = value ?? defaultValue;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${fieldName} must be a positive safe integer`);
  }
  return resolved;
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
