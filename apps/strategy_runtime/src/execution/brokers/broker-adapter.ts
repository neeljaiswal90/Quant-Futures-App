import type {
  EventId,
  JournalEventEnvelope,
  JournalEventPayloadFor,
  UnixNs,
} from '../../contracts/index.js';

export type RuntimeMode = 'paper' | 'live';
export type PlantScope = 'ORDER_PLANT';
export type BrokerAdapterKind = 'MOCK_ORDER_PLANT';
export type Unsubscribe = () => void;

export type OrderIntentEventEnvelope = JournalEventEnvelope<
  'ORDER_INTENT',
  JournalEventPayloadFor<'ORDER_INTENT'>
>;

export type BrokerAckEventType =
  | 'ORDER_ACK_SUBMISSION'
  | 'ORDER_ACK_FILL'
  | 'ORDER_ACK_CANCEL'
  | 'ORDER_BROKER_REJECT';

export interface BrokerAckEnvelopeFor<TType extends BrokerAckEventType> {
  readonly type: TType;
  readonly ts_ns: UnixNs;
  readonly payload: JournalEventPayloadFor<TType>;
  readonly event_id?: EventId;
  readonly broker_intent_correlation_id?: string;
}

export type BrokerAckEnvelope = {
  readonly [TType in BrokerAckEventType]: BrokerAckEnvelopeFor<TType>;
}[BrokerAckEventType];

export type BrokerSessionEvent =
  | {
      readonly type: 'SESSION_MANIFEST';
      readonly ts_ns: UnixNs;
      readonly payload: JournalEventPayloadFor<'SESSION_MANIFEST'>;
    }
  | {
      readonly type: 'RECONNECT_STATE';
      readonly ts_ns: UnixNs;
      readonly previous_state: BrokerReconnectState;
      readonly state: BrokerReconnectState;
      readonly reason?: BrokerRejectSubreason;
      readonly retry_budget_config: BrokerReconnectPolicyConfig;
    };

export interface BrokerCancelRequest {
  readonly intent_id: EventId;
  readonly submission_ack_id: EventId;
}

export interface BrokerAdapter {
  readonly plant_scope: PlantScope;
  readonly mode: RuntimeMode;
  start(): Promise<void>;
  stop(): Promise<void>;
  submitIntent(
    intent: OrderIntentEventEnvelope,
  ): Promise<{ readonly accepted: boolean; readonly broker_intent_correlation_id: string }>;
  requestCancel(request: BrokerCancelRequest): Promise<{ readonly accepted: boolean }>;
  subscribeAckEvents(handler: (event: BrokerAckEnvelope) => void): Unsubscribe;
  subscribeSessionEvents(handler: (event: BrokerSessionEvent) => void): Unsubscribe;
}

export const BROKER_REJECT_SUBREASONS = [
  'auth.invalid_credentials',
  'auth.session_expired',
  'credentials.missing',
  'credentials.resolver_unavailable',
  'permission.order_submit_denied',
  'permission.cancel_denied',
  'entitlement.symbol_denied',
  'risk.local_reject',
  'risk.broker_reject',
  'broker.unavailable',
  'broker.protocol_error',
  'reconnect.retry_budget_exhausted',
  'reconnect.session_lost',
  'unknown',
] as const;

export type BrokerRejectSubreason = (typeof BROKER_REJECT_SUBREASONS)[number];

export const BROKER_RECONNECT_STATES = [
  'DISCONNECTED',
  'CONNECTING',
  'CONNECTED',
  'RECONNECTING',
  'RECOVERING',
  'FAILED',
] as const;

export type BrokerReconnectState = (typeof BROKER_RECONNECT_STATES)[number];

export type BrokerReconnectJitterMode = 'none' | 'seeded';
export type BrokerReconnectPolicyConfigValue = number | string | boolean | null;

export interface BrokerReconnectPolicyConfig {
  readonly [key: string]: BrokerReconnectPolicyConfigValue;
  readonly max_attempts: number;
  readonly initial_delay_ms: number;
  readonly max_delay_ms: number;
  readonly retry_budget_ms: number;
  readonly jitter: BrokerReconnectJitterMode;
}

export const DEFAULT_BROKER_RECONNECT_POLICY_CONFIG: BrokerReconnectPolicyConfig = {
  max_attempts: 3,
  initial_delay_ms: 250,
  max_delay_ms: 2_000,
  retry_budget_ms: 10_000,
  jitter: 'seeded',
};

export const BROKER_RECONNECT_TRANSITIONS = {
  DISCONNECTED: ['CONNECTING'],
  CONNECTING: ['CONNECTED', 'RECONNECTING', 'FAILED'],
  CONNECTED: ['RECONNECTING', 'DISCONNECTED'],
  RECONNECTING: ['CONNECTED', 'RECOVERING', 'FAILED'],
  RECOVERING: ['CONNECTED', 'RECONNECTING', 'FAILED'],
  FAILED: ['DISCONNECTED'],
} as const satisfies Readonly<Record<BrokerReconnectState, readonly BrokerReconnectState[]>>;

export function canTransitionBrokerReconnectState(
  from: BrokerReconnectState,
  to: BrokerReconnectState,
): boolean {
  return (BROKER_RECONNECT_TRANSITIONS[from] as readonly BrokerReconnectState[]).includes(to);
}
