import { stableJsonStringify, type JsonValue } from '../contracts/index.js';

export const TICKER_IPC_SCHEMA_VERSION = 1 as const;

export const TICKER_IPC_DIRECTIONS = ['command', 'event'] as const;
export type TickerIpcDirection = (typeof TICKER_IPC_DIRECTIONS)[number];

export const TICKER_IPC_COMMAND_MESSAGE_TYPES = [
  'subscribe_symbol',
  'unsubscribe_symbol',
  'query_subscriptions',
  'heartbeat',
  'shutdown',
] as const;
export type TickerIpcCommandMessageType = (typeof TICKER_IPC_COMMAND_MESSAGE_TYPES)[number];

export const TICKER_IPC_EVENT_MESSAGE_TYPES = [
  'boot_identity',
  'subscription_accepted',
  'subscription_rejected',
  'tick_quote',
  'tick_trade',
  'tick_book_rebuild',
  'heartbeat_pong',
  'subscription_snapshot',
  'connection_lost',
  'recovered',
  'broker_error',
  'shutdown_complete',
] as const;
export type TickerIpcEventMessageType = (typeof TICKER_IPC_EVENT_MESSAGE_TYPES)[number];
export type TickerIpcMessageType = TickerIpcCommandMessageType | TickerIpcEventMessageType;

export const TICKER_IPC_FAILURE_STATES = [
  'sidecar_unavailable',
  'broker_disconnected',
  'auth_denied',
  'order_submit_rejected',
  'order_status_unknown',
  'position_reconciliation_failed',
  'duplicate_command_detected',
  'schema_version_incompatible',
  'order_path_not_yet_implemented',
] as const;
export type TickerIpcFailureState = (typeof TICKER_IPC_FAILURE_STATES)[number];

export const TICKER_IPC_PROTOCOL_ENVIRONMENTS = ['rithmic_test', 'rithmic_paper', 'rithmic_live'] as const;
export type TickerIpcProtocolEnvironment = (typeof TICKER_IPC_PROTOCOL_ENVIRONMENTS)[number];

export interface TickerIpcEnvelope<TPayload = unknown> {
  readonly schema_version: typeof TICKER_IPC_SCHEMA_VERSION;
  readonly message_type: TickerIpcMessageType;
  readonly direction: TickerIpcDirection;
  readonly run_id: string;
  readonly session_id: string;
  readonly correlation_id: string;
  readonly causation_id: string;
  readonly idempotency_key?: string;
  readonly event_ts_ns: bigint | number | string;
  readonly adapter_version: string;
  readonly payload: TPayload;
}

export interface TickerIpcBootIdentityPayload {
  readonly adapter_version: string;
  readonly sdk_name: 'pyrithmic';
  readonly sdk_version: string;
  readonly protocol_environment: TickerIpcProtocolEnvironment;
  readonly gateway_url_redacted: string;
  readonly boot_ts_ns: bigint | number | string;
  readonly process_id: number;
  readonly schema_version: typeof TICKER_IPC_SCHEMA_VERSION;
}

export interface TickerIpcFailurePayload {
  readonly failure_state: TickerIpcFailureState;
  readonly rp_code?: string;
  readonly rp_message_redacted?: string;
  readonly reason: string;
  readonly recoverable: boolean;
  readonly correlated_command_idempotency_key?: string;
}

export interface TickerIpcContractExport {
  readonly schema_version: typeof TICKER_IPC_SCHEMA_VERSION;
  readonly transport: {
    readonly framing: 'json_lines';
    readonly line_separator: 'LF';
    readonly bigint_fields_serialized_as: 'decimal_string';
    readonly multiline_messages: false;
  };
  readonly directions: readonly TickerIpcDirection[];
  readonly command_message_types: readonly TickerIpcCommandMessageType[];
  readonly command_message_types_forbidding_idempotency_key: readonly TickerIpcCommandMessageType[];
  readonly event_message_types: readonly TickerIpcEventMessageType[];
  readonly failure_states: readonly TickerIpcFailureState[];
  readonly protocol_environments: readonly TickerIpcProtocolEnvironment[];
  readonly envelope_fields: readonly string[];
  readonly bigint_fields: readonly string[];
  readonly boot_identity_payload_fields: readonly string[];
  readonly tick_quote_payload_fields: readonly string[];
  readonly tick_trade_payload_fields: readonly string[];
  readonly failure_payload_fields: readonly string[];
}

export interface TickerIpcValidationIssue {
  readonly path: string;
  readonly code:
    | 'invalid_envelope'
    | 'unsupported_schema_version'
    | 'unsupported_message_type'
    | 'invalid_direction'
    | 'missing_required_field'
    | 'forbidden_field'
    | 'invalid_field_type'
    | 'invalid_field_value';
  readonly message: string;
}

export interface TickerIpcValidationResult {
  readonly ok: boolean;
  readonly envelope?: TickerIpcEnvelope;
  readonly issues: readonly TickerIpcValidationIssue[];
}

export function buildTickerIpcContractExport(): TickerIpcContractExport {
  return {
    schema_version: TICKER_IPC_SCHEMA_VERSION,
    transport: {
      framing: 'json_lines',
      line_separator: 'LF',
      bigint_fields_serialized_as: 'decimal_string',
      multiline_messages: false,
    },
    directions: TICKER_IPC_DIRECTIONS,
    command_message_types: TICKER_IPC_COMMAND_MESSAGE_TYPES,
    command_message_types_forbidding_idempotency_key: TICKER_IPC_COMMAND_MESSAGE_TYPES,
    event_message_types: TICKER_IPC_EVENT_MESSAGE_TYPES,
    failure_states: TICKER_IPC_FAILURE_STATES,
    protocol_environments: TICKER_IPC_PROTOCOL_ENVIRONMENTS,
    envelope_fields: [
      'schema_version',
      'message_type',
      'direction',
      'run_id',
      'session_id',
      'correlation_id',
      'causation_id',
      'idempotency_key',
      'event_ts_ns',
      'adapter_version',
      'payload',
    ],
    bigint_fields: ['event_ts_ns', 'boot_ts_ns', 'tick_ts_ns'],
    boot_identity_payload_fields: [
      'adapter_version',
      'sdk_name',
      'sdk_version',
      'protocol_environment',
      'gateway_url_redacted',
      'boot_ts_ns',
      'process_id',
      'schema_version',
    ],
    tick_quote_payload_fields: [
      'symbol',
      'exchange',
      'tick_ts_ns',
      'sidecar_recv_ts_ns',
      'bid_px',
      'bid_qty',
      'ask_px',
      'ask_qty',
    ],
    tick_trade_payload_fields: [
      'symbol',
      'exchange',
      'tick_ts_ns',
      'sidecar_recv_ts_ns',
      'price',
      'quantity',
      'aggressor_side',
      'trade_id',
    ],
    failure_payload_fields: [
      'failure_state',
      'rp_code',
      'rp_message_redacted',
      'reason',
      'recoverable',
      'correlated_command_idempotency_key',
    ],
  };
}

export const TICKER_IPC_CONTRACT = buildTickerIpcContractExport();

export function stableTickerIpcContractJson(): string {
  return stableJsonStringify(TICKER_IPC_CONTRACT as unknown as JsonValue);
}

export function validateTickerIpcEnvelope(value: unknown): TickerIpcValidationResult {
  const issues: TickerIpcValidationIssue[] = [];
  const envelope = requireRecord(value, '$', issues);
  if (envelope === undefined) return { ok: false, issues };

  if (envelope.schema_version !== TICKER_IPC_SCHEMA_VERSION) {
    addIssue(issues, '$.schema_version', 'unsupported_schema_version', `must be ${TICKER_IPC_SCHEMA_VERSION}`);
  }

  const messageType = envelope.message_type;
  const isCommand = isTickerIpcCommandMessageType(messageType);
  const isEvent = isTickerIpcEventMessageType(messageType);
  if (!isCommand && !isEvent) {
    addIssue(issues, '$.message_type', 'unsupported_message_type', `unsupported ticker IPC message_type: ${String(messageType)}`);
  }
  if (isCommand && envelope.direction !== 'command') {
    addIssue(issues, '$.direction', 'invalid_direction', 'command message requires command direction');
  } else if (isEvent && envelope.direction !== 'event') {
    addIssue(issues, '$.direction', 'invalid_direction', 'event message requires event direction');
  } else if (!isCommand && !isEvent && !isTickerIpcDirection(envelope.direction)) {
    addIssue(issues, '$.direction', 'invalid_direction', 'must be command or event');
  }

  requireNonEmptyString(envelope.run_id, '$.run_id', issues);
  requireNonEmptyString(envelope.session_id, '$.session_id', issues);
  requireNonEmptyString(envelope.correlation_id, '$.correlation_id', issues);
  requireNonEmptyString(envelope.causation_id, '$.causation_id', issues);
  requireNonEmptyString(envelope.adapter_version, '$.adapter_version', issues);
  requireTimestamp(envelope.event_ts_ns, '$.event_ts_ns', issues);
  if (isCommand && envelope.idempotency_key !== undefined) {
    addIssue(issues, '$.idempotency_key', 'forbidden_field', 'ticker IPC commands must omit idempotency_key');
  }
  if (isEvent && envelope.idempotency_key !== undefined) {
    addIssue(issues, '$.idempotency_key', 'forbidden_field', 'events must omit idempotency_key');
  }

  if (!Object.hasOwn(envelope, 'payload')) {
    addIssue(issues, '$.payload', 'missing_required_field', 'is required');
  } else {
    const payload = requireRecord(envelope.payload, '$.payload', issues);
    if (payload !== undefined) {
      if (messageType === 'boot_identity') validateBootIdentityPayload(payload, issues);
      if (messageType === 'broker_error' || messageType === 'connection_lost' || messageType === 'subscription_rejected') {
        validateFailurePayload(payload, issues);
      }
      if (messageType === 'tick_quote') validateTickQuotePayload(payload, issues);
      if (messageType === 'tick_trade') validateTickTradePayload(payload, issues);
    }
  }

  return {
    ok: issues.length === 0,
    ...(issues.length === 0 ? { envelope: value as TickerIpcEnvelope } : {}),
    issues: issues.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code)),
  };
}

export function isTickerIpcCommandMessageType(value: unknown): value is TickerIpcCommandMessageType {
  return typeof value === 'string' && TICKER_IPC_COMMAND_MESSAGE_TYPES.includes(value as never);
}

export function isTickerIpcEventMessageType(value: unknown): value is TickerIpcEventMessageType {
  return typeof value === 'string' && TICKER_IPC_EVENT_MESSAGE_TYPES.includes(value as never);
}

export function isTickerIpcDirection(value: unknown): value is TickerIpcDirection {
  return typeof value === 'string' && TICKER_IPC_DIRECTIONS.includes(value as never);
}

function validateBootIdentityPayload(payload: Record<string, unknown>, issues: TickerIpcValidationIssue[]): void {
  requireNonEmptyString(payload.adapter_version, '$.payload.adapter_version', issues);
  if (payload.sdk_name !== 'pyrithmic') addIssue(issues, '$.payload.sdk_name', 'invalid_field_value', 'must be pyrithmic');
  requireNonEmptyString(payload.sdk_version, '$.payload.sdk_version', issues);
  if (!TICKER_IPC_PROTOCOL_ENVIRONMENTS.includes(payload.protocol_environment as never)) {
    addIssue(issues, '$.payload.protocol_environment', 'invalid_field_value', `must be one of: ${TICKER_IPC_PROTOCOL_ENVIRONMENTS.join(', ')}`);
  }
  requireNonEmptyString(payload.gateway_url_redacted, '$.payload.gateway_url_redacted', issues);
  requireTimestamp(payload.boot_ts_ns, '$.payload.boot_ts_ns', issues);
  requireNonNegativeInteger(payload.process_id, '$.payload.process_id', issues);
  if (payload.schema_version !== TICKER_IPC_SCHEMA_VERSION) {
    addIssue(issues, '$.payload.schema_version', 'unsupported_schema_version', `must be ${TICKER_IPC_SCHEMA_VERSION}`);
  }
}

function validateFailurePayload(payload: Record<string, unknown>, issues: TickerIpcValidationIssue[]): void {
  if (!Object.hasOwn(payload, 'failure_state')) {
    addIssue(issues, '$.payload.failure_state', 'missing_required_field', 'is required');
  } else if (!TICKER_IPC_FAILURE_STATES.includes(payload.failure_state as never)) {
    addIssue(issues, '$.payload.failure_state', 'invalid_field_value', `must be one of: ${TICKER_IPC_FAILURE_STATES.join(', ')}`);
  }
  requireRequiredString(payload, 'reason', '$.payload.reason', issues);
  requireRequiredBoolean(payload, 'recoverable', '$.payload.recoverable', issues);
  optionalString(payload.rp_code, '$.payload.rp_code', issues);
  optionalString(payload.rp_message_redacted, '$.payload.rp_message_redacted', issues);
  optionalString(payload.correlated_command_idempotency_key, '$.payload.correlated_command_idempotency_key', issues);
}

function validateTickQuotePayload(payload: Record<string, unknown>, issues: TickerIpcValidationIssue[]): void {
  requireNonEmptyString(payload.symbol, '$.payload.symbol', issues);
  requireNonEmptyString(payload.exchange, '$.payload.exchange', issues);
  requireTimestamp(payload.tick_ts_ns, '$.payload.tick_ts_ns', issues);
  requireTimestamp(payload.sidecar_recv_ts_ns, '$.payload.sidecar_recv_ts_ns', issues);
  requireNumber(payload.bid_px, '$.payload.bid_px', issues);
  requireNumber(payload.bid_qty, '$.payload.bid_qty', issues);
  requireNumber(payload.ask_px, '$.payload.ask_px', issues);
  requireNumber(payload.ask_qty, '$.payload.ask_qty', issues);
}

function validateTickTradePayload(payload: Record<string, unknown>, issues: TickerIpcValidationIssue[]): void {
  requireNonEmptyString(payload.symbol, '$.payload.symbol', issues);
  requireNonEmptyString(payload.exchange, '$.payload.exchange', issues);
  requireTimestamp(payload.tick_ts_ns, '$.payload.tick_ts_ns', issues);
  requireTimestamp(payload.sidecar_recv_ts_ns, '$.payload.sidecar_recv_ts_ns', issues);
  requireNumber(payload.price, '$.payload.price', issues);
  requireNumber(payload.quantity, '$.payload.quantity', issues);
  if (payload.aggressor_side !== undefined && !['buy', 'sell', 'unknown'].includes(String(payload.aggressor_side))) {
    addIssue(issues, '$.payload.aggressor_side', 'invalid_field_value', 'must be buy, sell, or unknown');
  }
  optionalString(payload.trade_id, '$.payload.trade_id', issues);
}

function requireRecord(value: unknown, path: string, issues: TickerIpcValidationIssue[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    addIssue(issues, path, 'invalid_envelope', 'must be an object');
    return undefined;
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, path: string, issues: TickerIpcValidationIssue[]): void {
  if (typeof value !== 'string' || value.trim() === '') addIssue(issues, path, 'invalid_field_type', 'must be a non-empty string');
}

function requireRequiredString(record: Record<string, unknown>, field: string, path: string, issues: TickerIpcValidationIssue[]): void {
  if (!Object.hasOwn(record, field)) {
    addIssue(issues, path, 'missing_required_field', 'is required');
    return;
  }
  requireNonEmptyString(record[field], path, issues);
}

function requireRequiredBoolean(record: Record<string, unknown>, field: string, path: string, issues: TickerIpcValidationIssue[]): void {
  if (!Object.hasOwn(record, field)) {
    addIssue(issues, path, 'missing_required_field', 'is required');
    return;
  }
  if (typeof record[field] !== 'boolean') addIssue(issues, path, 'invalid_field_type', 'must be a boolean');
}

function optionalString(value: unknown, path: string, issues: TickerIpcValidationIssue[]): void {
  if (value !== undefined && typeof value !== 'string') addIssue(issues, path, 'invalid_field_type', 'must be a string when present');
}

function requireNumber(value: unknown, path: string, issues: TickerIpcValidationIssue[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) addIssue(issues, path, 'invalid_field_type', 'must be a finite number');
}

function requireTimestamp(value: unknown, path: string, issues: TickerIpcValidationIssue[]): void {
  if (typeof value === 'bigint' && value >= 0n) return;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return;
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return;
  addIssue(issues, path, 'invalid_field_value', 'must be a non-negative bigint, safe integer, or unsigned decimal string');
}

function requireNonNegativeInteger(value: unknown, path: string, issues: TickerIpcValidationIssue[]): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) addIssue(issues, path, 'invalid_field_value', 'must be a non-negative safe integer');
}

function addIssue(issues: TickerIpcValidationIssue[], path: string, code: TickerIpcValidationIssue['code'], message: string): void {
  issues.push({ path, code, message });
}
