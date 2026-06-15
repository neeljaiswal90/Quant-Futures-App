import {
  createBrokerJournalEventEnvelope,
  createJournalEventEnvelope,
  makeCausationId,
  makeCorrelationId,
  makeEventId,
  type AnyJournalEventEnvelope,
  type BrokerJournalEventEnvelope,
  type EventId,
  type JournalEventPayloadFor,
  type RunId,
  type SessionId,
  type UnixNs,
} from '../../contracts/index.js';
import { captureLocalTimestampNs } from '../../observability/local-timestamp.js';
import type { BoundedAckLatencyObserver } from '../../observability/latency-sli.js';
import {
  buildExecutionCapabilityMask,
  evaluateExecutionCapability,
  type ExecutionCapability,
  type ExecutionCapabilityDecision,
  type ExecutionCapabilityMask,
  type ExecutionUseContext,
} from '../execution-capability-mask.js';
import {
  OrderLifecycleStateMachine,
  SubmissionGate,
  type OrderLifecycleEmittedEvent,
} from '../order-lifecycle-state-machine.js';
import type {
  BrokerAckEnvelope,
  BrokerAdapter,
  BrokerCancelRequest,
  BrokerSessionEvent,
  OrderIntentEventEnvelope,
  PlantScope,
  RuntimeMode,
} from './broker-adapter.js';

export type BrokerAdapterRuntimeDispatchResult =
  | {
      readonly accepted: true;
      readonly broker_intent_correlation_id: string;
    }
  | {
      readonly accepted: false;
      readonly reason:
        | 'submission_gate_blocked'
        | 'plant_scope_denied'
        | 'capability_denied'
        | 'credential_unavailable'
        | 'adapter_rejected';
      readonly detail?: string;
      readonly capability_decision?: ExecutionCapabilityDecision;
    };

export interface BrokerCredentialLookupRequest {
  readonly mode: RuntimeMode;
  readonly plant_scope: PlantScope;
}

export interface BrokerCredentialLookupResult {
  readonly available: boolean;
  readonly vault_evidence: boolean;
  readonly resolver: string;
  readonly redacted_account_ref?: string;
}

export interface BrokerCredentialLookup {
  resolveOrderPlantCredentials(
    request: BrokerCredentialLookupRequest,
  ): Promise<BrokerCredentialLookupResult>;
}

export const qfa620CredentialLookupStub: BrokerCredentialLookup = {
  async resolveOrderPlantCredentials(
    request: BrokerCredentialLookupRequest,
  ): Promise<BrokerCredentialLookupResult> {
    // TODO(QFA-620): replace this no-secret stub with the scoped credential resolver.
    return {
      available: request.mode === 'paper',
      vault_evidence: false,
      resolver: 'QFA-620_STUB_NO_SECRET_MATERIAL',
      redacted_account_ref: 'paper-account-ref-redacted',
    };
  },
};

export interface BrokerAckTimeoutPolicy {
  readonly enabled: boolean;
  readonly submission_ack_timeout_ms?: number;
  readonly cancel_ack_timeout_ms?: number;
  readonly max_cancel_attempts?: number;
}

export interface BrokerAdapterRuntimeIntegrationOptions {
  readonly adapter: BrokerAdapter;
  readonly run_id: RunId;
  readonly session_id: SessionId;
  readonly submission_gate: SubmissionGate;
  readonly event_sink: (event: AnyJournalEventEnvelope) => void;
  readonly execution_mask?: ExecutionCapabilityMask;
  readonly credential_lookup?: BrokerCredentialLookup;
  readonly ack_latency_observer?: Pick<BoundedAckLatencyObserver, 'observe'>;
  readonly capture_local_timestamp_ns?: () => UnixNs;
  readonly ack_timeout_policy?: BrokerAckTimeoutPolicy;
  readonly order_lifecycle?: OrderLifecycleStateMachine;
}

export class BrokerAdapterRuntimeIntegration {
  private readonly adapter: BrokerAdapter;
  private readonly runId: RunId;
  private readonly sessionId: SessionId;
  private readonly submissionGate: SubmissionGate;
  private readonly eventSink: (event: AnyJournalEventEnvelope) => void;
  private readonly executionMask: ExecutionCapabilityMask;
  private readonly credentialLookup: BrokerCredentialLookup;
  private readonly ackLatencyObserver?: Pick<BoundedAckLatencyObserver, 'observe'>;
  private readonly captureLocalTimestamp: () => UnixNs;
  private readonly ackTimeoutPolicy: BrokerAckTimeoutPolicy;
  private readonly orderLifecycle?: OrderLifecycleStateMachine;
  private readonly intentsByEventId = new Map<string, OrderIntentEventEnvelope>();
  private readonly correlationIdByIntentEventId = new Map<string, string>();
  private readonly brokerOrderIdByIntentEventId = new Map<string, string>();
  private readonly accountIdByIntentEventId = new Map<string, string>();
  private readonly activeBrokerIntentEventIds = new Set<string>();
  private readonly ackTimeoutTimersByIntentEventId = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly unsubscribers: (() => void)[] = [];
  private lifecycleEventSequence = 0;
  private sessionEventSequence = 0;

  constructor(options: BrokerAdapterRuntimeIntegrationOptions) {
    this.adapter = options.adapter;
    this.runId = options.run_id;
    this.sessionId = options.session_id;
    this.submissionGate = options.submission_gate;
    this.eventSink = options.event_sink;
    this.executionMask = options.execution_mask ?? buildExecutionCapabilityMask();
    this.credentialLookup = options.credential_lookup ?? qfa620CredentialLookupStub;
    this.ackLatencyObserver = options.ack_latency_observer;
    this.captureLocalTimestamp = options.capture_local_timestamp_ns ?? captureLocalTimestampNs;
    this.ackTimeoutPolicy = options.ack_timeout_policy ?? { enabled: false };
    this.orderLifecycle =
      options.order_lifecycle ??
      (this.ackTimeoutPolicy.enabled
        ? new OrderLifecycleStateMachine({
            submission_gate: this.submissionGate,
            submission_ack_timeout_ms: this.ackTimeoutPolicy.submission_ack_timeout_ms,
            cancel_ack_timeout_ms: this.ackTimeoutPolicy.cancel_ack_timeout_ms,
            max_cancel_attempts: this.ackTimeoutPolicy.max_cancel_attempts,
            emit: (event) => this.emitLifecycleEvent(event),
          })
        : undefined);
  }

  async start(): Promise<void> {
    this.unsubscribers.push(
      this.adapter.subscribeAckEvents((event) => this.handleAckEvent(event)),
      this.adapter.subscribeSessionEvents((event) => this.handleSessionEvent(event)),
    );
    await this.adapter.start();
  }

  async stop(): Promise<void> {
    for (const timer of this.ackTimeoutTimersByIntentEventId.values()) {
      clearTimeout(timer);
    }
    this.ackTimeoutTimersByIntentEventId.clear();
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
    await this.adapter.stop();
  }

  async handleOrderIntent(
    intent: OrderIntentEventEnvelope,
  ): Promise<BrokerAdapterRuntimeDispatchResult> {
    if (intent.type !== 'ORDER_INTENT') {
      throw new Error(`Broker adapter runtime can only dispatch ORDER_INTENT events, received ${intent.type}`);
    }

    const intentKey = String(intent.event_id);
    const existingCorrelationId = this.correlationIdByIntentEventId.get(intentKey);
    if (existingCorrelationId !== undefined) {
      return {
        accepted: true,
        broker_intent_correlation_id: existingCorrelationId,
      };
    }
    if (this.intentsByEventId.has(intentKey)) {
      return {
        accepted: false,
        reason: 'adapter_rejected',
        detail: 'duplicate_order_intent_dispatch_in_progress',
      };
    }

    this.ackLatencyObserver?.observe(intent);

    const gate = this.submissionGate.acquire();
    if (!gate.allowed) {
      return {
        accepted: false,
        reason: 'submission_gate_blocked',
        detail: gate.reason,
      };
    }

    if (this.adapter.plant_scope !== 'ORDER_PLANT') {
      return {
        accepted: false,
        reason: 'plant_scope_denied',
        detail: `unsupported plant_scope ${this.adapter.plant_scope}`,
      };
    }

    const plantDecision = this.evaluateCapability(
      this.adapter.mode === 'paper' ? 'order_plant_paper' : 'order_plant_live',
      this.adapter.mode === 'paper' ? 'paper_order_submit' : 'live_order_submit',
    );
    if (!plantDecision.allowed) {
      return {
        accepted: false,
        reason: 'capability_denied',
        capability_decision: plantDecision,
      };
    }

    const submitDecision = this.evaluateCapability(
      'submit',
      this.adapter.mode === 'paper' ? 'paper_order_submit' : 'live_order_submit',
    );
    if (!submitDecision.allowed) {
      return {
        accepted: false,
        reason: 'capability_denied',
        capability_decision: submitDecision,
      };
    }

    const credentials = await this.credentialLookup.resolveOrderPlantCredentials({
      mode: this.adapter.mode,
      plant_scope: this.adapter.plant_scope,
    });
    if (!credentials.available) {
      return {
        accepted: false,
        reason: 'credential_unavailable',
        detail: credentials.resolver,
      };
    }

    this.intentsByEventId.set(intentKey, intent);
    this.orderLifecycle?.createPendingIntent({ intent_id: intent.event_id });

    const submitResult = await this.adapter.submitIntent(intent);
    if (!submitResult.accepted) {
      this.intentsByEventId.delete(intentKey);
      return { accepted: false, reason: 'adapter_rejected' };
    }

    this.correlationIdByIntentEventId.set(
      intentKey,
      submitResult.broker_intent_correlation_id,
    );
    this.activeBrokerIntentEventIds.add(intentKey);
    this.orderLifecycle?.markSubmitted(intent.event_id);
    this.schedulePendingAckTimeout(intent.event_id);

    return {
      accepted: true,
      broker_intent_correlation_id: submitResult.broker_intent_correlation_id,
    };
  }

  async requestCancel(request: BrokerCancelRequest): Promise<{ readonly accepted: boolean }> {
    const decision = this.evaluateCapability('cancel_replace', 'cancel_replace');
    if (!decision.allowed) {
      return { accepted: false };
    }

    const intentKey = String(request.intent_id);
    const brokerOrderId = this.brokerOrderIdByIntentEventId.get(intentKey);
    const accountId = this.accountIdByIntentEventId.get(intentKey);
    if (brokerOrderId === undefined || accountId === undefined) {
      this.emitCancelLineageValidatorIssue(request, {
        has_broker_order_id: brokerOrderId !== undefined,
        has_broker_account_id: accountId !== undefined,
      });
      return { accepted: false };
    }
    const enrichedRequest: BrokerCancelRequest = {
      ...request,
      broker_order_id: brokerOrderId,
      account_id: accountId,
    };

    const result = await this.adapter.requestCancel(enrichedRequest);
    if (result.accepted) {
      this.orderLifecycle?.requestCancel(request.intent_id);
      this.schedulePendingAckTimeout(request.intent_id);
    }
    return result;
  }

  private handleAckEvent(event: BrokerAckEnvelope): void {
    const lineageAccepted = this.rememberSubmissionAck(event);
    if (!lineageAccepted) {
      this.eventSink(this.toBrokerJournalEnvelope(event));
      return;
    }
    this.clearAckTimeoutForTerminalEvent(event);
    this.applyLifecycleAck(event);
    this.applyTerminalAckState(event);

    const envelope = this.toBrokerJournalEnvelope(event);
    this.eventSink(envelope);
    this.ackLatencyObserver?.observe(envelope);
  }

  private rememberSubmissionAck(event: BrokerAckEnvelope): boolean {
    if (event.type !== 'ORDER_ACK_SUBMISSION') {
      return true;
    }
    const intentKey = String(event.payload.intent_id);
    const existingBrokerOrderId = this.brokerOrderIdByIntentEventId.get(intentKey);
    const existingAccountId = this.accountIdByIntentEventId.get(intentKey);
    const brokerOrderConflict =
      existingBrokerOrderId !== undefined &&
      existingBrokerOrderId !== event.payload.broker_order_id;
    const accountConflict =
      existingAccountId !== undefined &&
      existingAccountId !== event.payload.broker_account_id;
    if (brokerOrderConflict || accountConflict) {
      this.emitDuplicateSubmissionAckLineageValidatorIssue(event, {
        existing_broker_order_id: existingBrokerOrderId,
        incoming_broker_order_id: event.payload.broker_order_id,
        existing_broker_account_id: existingAccountId,
        incoming_broker_account_id: event.payload.broker_account_id,
      });
      this.submissionGate.requestBlock('broker_reconciliation_in_progress');
      return false;
    }
    this.brokerOrderIdByIntentEventId.set(intentKey, event.payload.broker_order_id);
    this.accountIdByIntentEventId.set(intentKey, event.payload.broker_account_id);
    return true;
  }

  private emitCancelLineageValidatorIssue(
    request: BrokerCancelRequest,
    details: {
      readonly has_broker_order_id: boolean;
      readonly has_broker_account_id: boolean;
    },
  ): void {
    this.sessionEventSequence += 1;
    const emittedTsNs = this.captureLocalTimestamp();
    const payload: JournalEventPayloadFor<'VALIDATOR_ISSUE'> = {
      validator_id: 'EXEC-VALIDATOR-09',
      severity: 'fatal',
      emitted_ts_ns: emittedTsNs,
      code: 'broker_cancel_missing_submission_lineage',
      message: 'cancel request requires remembered broker_order_id and broker_account_id before adapter cancel',
      session_family_id: this.sessionId,
      details: {
        intent_id: String(request.intent_id),
        submission_ack_id: String(request.submission_ack_id),
        ...details,
      },
    };

    this.eventSink(
      createJournalEventEnvelope({
        event_id: makeEventId(`broker-cancel-validator-issue-${this.sessionEventSequence}`),
        type: 'VALIDATOR_ISSUE',
        ts_ns: emittedTsNs,
        run_id: this.runId,
        session_id: this.sessionId,
        causation_id: makeCausationId(request.intent_id),
        payload,
      }),
    );
  }

  private emitDuplicateSubmissionAckLineageValidatorIssue(
    event: Extract<BrokerAckEnvelope, { readonly type: 'ORDER_ACK_SUBMISSION' }>,
    details: {
      readonly existing_broker_order_id?: string;
      readonly incoming_broker_order_id: string;
      readonly existing_broker_account_id?: string;
      readonly incoming_broker_account_id: string;
    },
  ): void {
    this.sessionEventSequence += 1;
    const emittedTsNs = this.captureLocalTimestamp();
    const payload: JournalEventPayloadFor<'VALIDATOR_ISSUE'> = {
      validator_id: 'EXEC-VALIDATOR-09',
      severity: 'fatal',
      emitted_ts_ns: emittedTsNs,
      code: 'broker_duplicate_submission_ack_lineage_conflict',
      message: 'duplicate ORDER_ACK_SUBMISSION for intent has conflicting broker lineage',
      session_family_id: this.sessionId,
      details: {
        intent_id: String(event.payload.intent_id),
        submission_ack_id: String(event.payload.submission_ack_id),
        ...details,
      },
    };

    this.eventSink(
      createJournalEventEnvelope({
        event_id: makeEventId(`broker-duplicate-submission-ack-validator-issue-${this.sessionEventSequence}`),
        type: 'VALIDATOR_ISSUE',
        ts_ns: emittedTsNs,
        run_id: this.runId,
        session_id: this.sessionId,
        causation_id: makeCausationId(event.payload.intent_id),
        payload,
      }),
    );
  }

  private handleSessionEvent(event: BrokerSessionEvent): void {
    if (event.type === 'SESSION_MANIFEST') {
      this.eventSink(
        createJournalEventEnvelope({
          event_id: makeEventId(`session-manifest-${event.payload.broker_session_id}`),
          type: 'SESSION_MANIFEST',
          ts_ns: event.ts_ns,
          run_id: this.runId,
          session_id: this.sessionId,
          payload: event.payload,
        }),
      );
      return;
    }

    if (event.type === 'RECONNECT_STATE') {
      const payload = normalizeReconnectStatePayload(event);
      this.updateReconciliationGateForReconnectState(payload);
      this.sessionEventSequence += 1;
      this.eventSink(
        createJournalEventEnvelope({
          event_id: makeEventId(`broker-session-reconnect-state-${this.sessionEventSequence}`),
          type: 'RECONNECT_STATE',
          ts_ns: event.ts_ns,
          run_id: this.runId,
          session_id: this.sessionId,
          payload,
        }),
      );
    }

    if (event.type === 'VALIDATOR_ISSUE') {
      this.sessionEventSequence += 1;
      this.eventSink(
        createJournalEventEnvelope({
          event_id: makeEventId(`broker-session-validator-issue-${this.sessionEventSequence}`),
          type: 'VALIDATOR_ISSUE',
          ts_ns: event.ts_ns,
          run_id: this.runId,
          session_id: this.sessionId,
          payload: event.payload,
        }),
      );
    }
  }

  private updateReconciliationGateForReconnectState(
    payload: JournalEventPayloadFor<'RECONNECT_STATE'>,
  ): void {
    if (payload.state === 'CONNECTED') {
      if (this.activeBrokerIntentEventIds.size === 0) {
        this.submissionGate.releaseBlock('broker_reconciliation_in_progress');
      } else {
        this.submissionGate.requestBlock('broker_reconciliation_in_progress');
      }
      return;
    }
    this.submissionGate.requestBlock('broker_reconciliation_in_progress');
  }

  private toBrokerJournalEnvelope(
    event: BrokerAckEnvelope,
  ): AnyJournalEventEnvelope {
    switch (event.type) {
      case 'ORDER_ACK_SUBMISSION':
        return createBrokerJournalEventEnvelope({
          ...this.brokerEnvelopeBase(event),
          type: 'ORDER_ACK_SUBMISSION',
          payload: event.payload,
        });
      case 'ORDER_ACK_FILL':
        return createBrokerJournalEventEnvelope({
          ...this.brokerEnvelopeBase(event),
          type: 'ORDER_ACK_FILL',
          payload: event.payload,
        });
      case 'ORDER_ACK_CANCEL':
        return createBrokerJournalEventEnvelope({
          ...this.brokerEnvelopeBase(event),
          type: 'ORDER_ACK_CANCEL',
          payload: event.payload,
        });
      case 'ORDER_BROKER_REJECT':
        return createBrokerJournalEventEnvelope({
          ...this.brokerEnvelopeBase(event),
          type: 'ORDER_BROKER_REJECT',
          payload: event.payload,
        });
      default:
        return assertNeverAckEvent(event);
    }
  }

  private brokerEnvelopeBase(event: BrokerAckEnvelope) {
    const intent = this.intentsByEventId.get(String(event.payload.intent_id));
    const correlationId =
      event.broker_intent_correlation_id ??
      this.correlationIdByIntentEventId.get(String(event.payload.intent_id));

    return {
      event_id: event.event_id ?? this.eventIdForAck(event),
      ts_ns: event.ts_ns,
      ts_ns_local: this.captureLocalTimestamp(),
      run_id: intent?.run_id ?? this.runId,
      session_id: intent?.session_id ?? this.sessionId,
      causation_id: this.causationIdForAck(event),
      ...(correlationId === undefined ? {} : { correlation_id: makeCorrelationId(correlationId) }),
    };
  }

  private eventIdForAck(event: BrokerAckEnvelope): EventId {
    switch (event.type) {
      case 'ORDER_ACK_SUBMISSION':
        return makeEventId(`broker-order-ack-submission-${event.payload.submission_ack_id}`);
      case 'ORDER_ACK_FILL':
        return makeEventId(`broker-order-ack-fill-${event.payload.fill_ack_id}`);
      case 'ORDER_ACK_CANCEL':
        return makeEventId(`broker-order-ack-cancel-${event.payload.cancel_ack_id}`);
      case 'ORDER_BROKER_REJECT':
        return makeEventId(`broker-order-reject-${event.payload.intent_id}`);
      default:
        return assertNeverAckEvent(event);
    }
  }

  private causationIdForAck(event: BrokerAckEnvelope) {
    switch (event.type) {
      case 'ORDER_ACK_SUBMISSION':
      case 'ORDER_BROKER_REJECT':
        return makeCausationId(event.payload.intent_id);
      case 'ORDER_ACK_FILL':
      case 'ORDER_ACK_CANCEL':
        return makeCausationId(event.payload.submission_ack_id);
      default:
        return assertNeverAckEvent(event);
    }
  }

  private evaluateCapability(
    capability: ExecutionCapability,
    useContext: ExecutionUseContext,
  ): ExecutionCapabilityDecision {
    return evaluateExecutionCapability({
      capability,
      useContext,
      sessionMode: this.adapter.mode,
      scopingSurface: 'account',
      mask: this.executionMask,
    });
  }

  private schedulePendingAckTimeout(intentId: EventId): void {
    if (!this.ackTimeoutPolicy.enabled || this.orderLifecycle === undefined) {
      return;
    }

    const key = String(intentId);
    const existing = this.ackTimeoutTimersByIntentEventId.get(key);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.ackTimeoutTimersByIntentEventId.delete(key);
    }

    const timeoutMs = this.orderLifecycle.pendingAckTimeoutMs(intentId);
    const timer = setTimeout(() => {
      this.ackTimeoutTimersByIntentEventId.delete(key);
      try {
        this.orderLifecycle?.ackTimeout(intentId);
      } catch {
        // Timeout callbacks are best-effort; state may already be terminal.
      }
    }, timeoutMs);
    timer.unref?.();
    this.ackTimeoutTimersByIntentEventId.set(key, timer);
  }

  private clearAckTimeoutForTerminalEvent(event: BrokerAckEnvelope): void {
    const key = String(event.payload.intent_id);
    const timer = this.ackTimeoutTimersByIntentEventId.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.ackTimeoutTimersByIntentEventId.delete(key);
    }
  }

  private applyLifecycleAck(event: BrokerAckEnvelope): void {
    if (this.orderLifecycle === undefined) {
      return;
    }
    switch (event.type) {
      case 'ORDER_ACK_SUBMISSION':
        this.orderLifecycle.ackSubmission(event.payload);
        return;
      case 'ORDER_ACK_FILL':
        this.orderLifecycle.ackFill(event.payload);
        return;
      case 'ORDER_ACK_CANCEL':
        this.orderLifecycle.ackCancel(event.payload);
        return;
      case 'ORDER_BROKER_REJECT':
        this.orderLifecycle.brokerReject(event.payload);
        return;
      default:
        assertNeverAckEvent(event);
    }
  }

  private applyTerminalAckState(event: BrokerAckEnvelope): void {
    switch (event.type) {
      case 'ORDER_ACK_SUBMISSION':
        return;
      case 'ORDER_ACK_FILL':
        if (event.payload.fill_kind === 'FULL') {
          this.activeBrokerIntentEventIds.delete(String(event.payload.intent_id));
        }
        return;
      case 'ORDER_ACK_CANCEL':
      case 'ORDER_BROKER_REJECT':
        this.activeBrokerIntentEventIds.delete(String(event.payload.intent_id));
        return;
      default:
        assertNeverAckEvent(event);
    }
  }

  private emitLifecycleEvent(event: OrderLifecycleEmittedEvent): void {
    this.lifecycleEventSequence += 1;
    switch (event.type) {
      case 'ORDER_QUARANTINE_ENTERED':
        this.eventSink(
          createJournalEventEnvelope({
            event_id: makeEventId(
              `broker-lifecycle-${event.type.toLowerCase()}-${this.lifecycleEventSequence}`,
            ),
            type: event.type,
            ts_ns: this.captureLocalTimestamp(),
            run_id: this.runId,
            session_id: this.sessionId,
            payload: event.payload,
            causation_id: makeCausationId(event.payload.intent_id),
          }),
        );
        return;
      case 'ORDER_QUARANTINE_CLEARED': {
        const intentId = event.payload.resolved_intent_ids[0];
        this.eventSink(
          createJournalEventEnvelope({
            event_id: makeEventId(
              `broker-lifecycle-${event.type.toLowerCase()}-${this.lifecycleEventSequence}`,
            ),
            type: event.type,
            ts_ns: this.captureLocalTimestamp(),
            run_id: this.runId,
            session_id: this.sessionId,
            payload: event.payload,
            ...(intentId === undefined ? {} : { causation_id: makeCausationId(intentId) }),
          }),
        );
        return;
      }
      default:
        return;
    }
  }
}

function assertNeverAckEvent(value: never): never {
  throw new Error(`Unhandled broker ACK event: ${String(value)}`);
}

function normalizeReconnectStatePayload(
  event: Extract<BrokerSessionEvent, { readonly type: 'RECONNECT_STATE' }>,
): JournalEventPayloadFor<'RECONNECT_STATE'> {
  if ('payload' in event) {
    return event.payload;
  }
  return {
    previous_state: event.previous_state,
    state: event.state,
    phase: event.state === 'FAILED' ? 'exhausted' : 'attempt',
    max_attempts: Number(event.retry_budget_config.max_attempts),
    retry_budget_config: event.retry_budget_config,
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    terminal: event.state === 'FAILED',
    blocked_submission_gate: event.state !== 'CONNECTED',
  };
}
