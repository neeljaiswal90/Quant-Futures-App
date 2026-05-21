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

    this.intentsByEventId.set(String(intent.event_id), intent);
    this.orderLifecycle?.createPendingIntent({ intent_id: intent.event_id });

    const submitResult = await this.adapter.submitIntent(intent);
    if (!submitResult.accepted) {
      this.intentsByEventId.delete(String(intent.event_id));
      return { accepted: false, reason: 'adapter_rejected' };
    }

    this.correlationIdByIntentEventId.set(
      String(intent.event_id),
      submitResult.broker_intent_correlation_id,
    );
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

    const result = await this.adapter.requestCancel(request);
    if (result.accepted) {
      this.orderLifecycle?.requestCancel(request.intent_id);
      this.schedulePendingAckTimeout(request.intent_id);
    }
    return result;
  }

  private handleAckEvent(event: BrokerAckEnvelope): void {
    this.clearAckTimeoutForTerminalEvent(event);
    this.applyLifecycleAck(event);

    const envelope = this.toBrokerJournalEnvelope(event);
    this.eventSink(envelope);
    this.ackLatencyObserver?.observe(envelope);
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
