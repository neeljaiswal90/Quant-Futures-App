import { stableJsonStringify, type JsonValue } from '../../contracts/index.js';

export const BROKER_IPC_SCHEMA_VERSION = 1 as const;

export const BROKER_IPC_DIRECTIONS = ['command', 'event'] as const;
export type BrokerIpcDirection = (typeof BROKER_IPC_DIRECTIONS)[number];

export const BROKER_IPC_COMMAND_MESSAGE_TYPES_REQUIRING_IDEMPOTENCY_KEY = [
  'submit_order',
  'cancel_order',
  'query_order',
  'request_reconciliation_snapshot',
] as const;

export const BROKER_IPC_COMMAND_MESSAGE_TYPES_FORBIDDING_IDEMPOTENCY_KEY = [
  'subscribe_order_events',
  'heartbeat',
  'shutdown',
] as const;

export const BROKER_IPC_COMMAND_MESSAGE_TYPES = [
  ...BROKER_IPC_COMMAND_MESSAGE_TYPES_REQUIRING_IDEMPOTENCY_KEY,
  ...BROKER_IPC_COMMAND_MESSAGE_TYPES_FORBIDDING_IDEMPOTENCY_KEY,
] as const;

export type BrokerIpcCommandMessageType = (typeof BROKER_IPC_COMMAND_MESSAGE_TYPES)[number];

export const BROKER_IPC_EVENT_MESSAGE_TYPES = [
  'boot_identity',
  'order_accepted',
  'order_rejected',
  'order_acknowledged',
  'order_partially_filled',
  'order_filled',
  'cancel_pending',
  'order_cancelled',
  'cancel_rejected',
  'broker_error',
  'connection_lost',
  'recovered',
  'position_snapshot',
  'reconciliation_snapshot',
  'heartbeat_pong',
  'shutdown_complete',
] as const;

export type BrokerIpcEventMessageType = (typeof BROKER_IPC_EVENT_MESSAGE_TYPES)[number];
export type BrokerIpcMessageType = BrokerIpcCommandMessageType | BrokerIpcEventMessageType;

export const BROKER_IPC_FAILURE_STATES = [
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

export type BrokerIpcFailureState = (typeof BROKER_IPC_FAILURE_STATES)[number];

export const BROKER_IPC_PROTOCOL_ENVIRONMENTS = [
  'rithmic_test',
  'rithmic_paper',
  'rithmic_live',
] as const;

export type BrokerIpcProtocolEnvironment = (typeof BROKER_IPC_PROTOCOL_ENVIRONMENTS)[number];

export const BROKER_IPC_SDK_NAMES = ['pyrithmic', 'async-rithmic'] as const;
export type BrokerIpcSdkName = (typeof BROKER_IPC_SDK_NAMES)[number];

export interface BrokerIpcEnvelope<TPayload = unknown> {
  readonly schema_version: typeof BROKER_IPC_SCHEMA_VERSION;
  readonly message_type: BrokerIpcMessageType;
  readonly direction: BrokerIpcDirection;
  readonly run_id: string;
  readonly session_id: string;
  readonly correlation_id: string;
  readonly causation_id: string;
  readonly idempotency_key?: string;
  readonly event_ts_ns: bigint | number | string;
  readonly adapter_version: string;
  readonly payload: TPayload;
}

export interface BrokerIpcBootIdentityPayload {
  readonly adapter_version: string;
  readonly sdk_name: BrokerIpcSdkName;
  readonly sdk_version: string;
  readonly protocol_environment: BrokerIpcProtocolEnvironment;
  readonly gateway_url_redacted: string;
  readonly boot_ts_ns: bigint | number | string;
  readonly process_id: number;
  readonly schema_version: typeof BROKER_IPC_SCHEMA_VERSION;
}

export interface BrokerIpcFailurePayload {
  readonly failure_state: BrokerIpcFailureState;
  readonly rp_code?: string;
  readonly rp_message_redacted?: string;
  readonly reason: string;
  readonly recoverable: boolean;
  readonly correlated_command_idempotency_key?: string;
  readonly qfa_broker_sidecar_ipc_ms?: number;
}

export interface BrokerIpcTelemetryPayload {
  readonly qfa_broker_sidecar_ipc_ms?: number;
}

export type BrokerIpcValidationIssueCode =
  | 'invalid_envelope'
  | 'unsupported_schema_version'
  | 'unsupported_message_type'
  | 'invalid_direction'
  | 'missing_required_field'
  | 'forbidden_field'
  | 'invalid_field_type'
  | 'invalid_field_value';

export interface BrokerIpcValidationIssue {
  readonly path: string;
  readonly code: BrokerIpcValidationIssueCode;
  readonly message: string;
}

export interface BrokerIpcValidationResult {
  readonly ok: boolean;
  readonly envelope?: BrokerIpcEnvelope;
  readonly issues: readonly BrokerIpcValidationIssue[];
}

export interface BrokerIpcContractExport {
  readonly schema_version: typeof BROKER_IPC_SCHEMA_VERSION;
  readonly transport: {
    readonly framing: 'json_lines';
    readonly line_separator: 'LF';
    readonly bigint_fields_serialized_as: 'decimal_string';
    readonly multiline_messages: false;
  };
  readonly directions: readonly BrokerIpcDirection[];
  readonly command_message_types: readonly BrokerIpcCommandMessageType[];
  readonly command_message_types_requiring_idempotency_key: readonly BrokerIpcCommandMessageType[];
  readonly command_message_types_forbidding_idempotency_key: readonly BrokerIpcCommandMessageType[];
  readonly event_message_types: readonly BrokerIpcEventMessageType[];
  readonly failure_states: readonly BrokerIpcFailureState[];
  readonly protocol_environments: readonly BrokerIpcProtocolEnvironment[];
  readonly sdk_names: readonly BrokerIpcSdkName[];
  readonly envelope_fields: readonly string[];
  readonly bigint_fields: readonly string[];
  readonly boot_identity_payload_fields: readonly string[];
  readonly failure_payload_fields: readonly string[];
  readonly optional_telemetry_fields: readonly string[];
}

/**
 * Broker IPC JSON Lines transport convention:
 * one JSON object per line, LF terminated, no multiline records. In-memory
 * nanosecond fields may be bigint/number/string, but JSONL transport serializes
 * bigint nanosecond fields as unsigned decimal strings.
 */
export function buildBrokerIpcContractExport(): BrokerIpcContractExport {
  return {
    schema_version: BROKER_IPC_SCHEMA_VERSION,
    transport: {
      framing: 'json_lines',
      line_separator: 'LF',
      bigint_fields_serialized_as: 'decimal_string',
      multiline_messages: false,
    },
    directions: BROKER_IPC_DIRECTIONS,
    command_message_types: BROKER_IPC_COMMAND_MESSAGE_TYPES,
    command_message_types_requiring_idempotency_key:
      BROKER_IPC_COMMAND_MESSAGE_TYPES_REQUIRING_IDEMPOTENCY_KEY,
    command_message_types_forbidding_idempotency_key:
      BROKER_IPC_COMMAND_MESSAGE_TYPES_FORBIDDING_IDEMPOTENCY_KEY,
    event_message_types: BROKER_IPC_EVENT_MESSAGE_TYPES,
    failure_states: BROKER_IPC_FAILURE_STATES,
    protocol_environments: BROKER_IPC_PROTOCOL_ENVIRONMENTS,
    sdk_names: BROKER_IPC_SDK_NAMES,
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
    bigint_fields: ['event_ts_ns', 'boot_ts_ns'],
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
    failure_payload_fields: [
      'failure_state',
      'rp_code',
      'rp_message_redacted',
      'reason',
      'recoverable',
      'correlated_command_idempotency_key',
      'qfa_broker_sidecar_ipc_ms',
    ],
    optional_telemetry_fields: ['qfa_broker_sidecar_ipc_ms'],
  };
}

export const BROKER_IPC_CONTRACT = buildBrokerIpcContractExport();

export function stableBrokerIpcContractJson(): string {
  return stableJsonStringify(BROKER_IPC_CONTRACT as unknown as JsonValue);
}

export function validateBrokerIpcEnvelope(value: unknown): BrokerIpcValidationResult {
  const issues: BrokerIpcValidationIssue[] = [];
  const envelope = requireRecord(value, '$', issues);
  if (envelope === undefined) {
    return { ok: false, issues };
  }

  if (envelope.schema_version !== BROKER_IPC_SCHEMA_VERSION) {
    addIssue(
      issues,
      '$.schema_version',
      'unsupported_schema_version',
      `must be ${BROKER_IPC_SCHEMA_VERSION}`,
    );
  }

  const messageType = envelope.message_type;
  const isCommand = isBrokerIpcCommandMessageType(messageType);
  const isEvent = isBrokerIpcEventMessageType(messageType);
  if (!isCommand && !isEvent) {
    addIssue(
      issues,
      '$.message_type',
      'unsupported_message_type',
      `unsupported broker IPC message_type: ${String(messageType)}`,
    );
  }

  if (isCommand && envelope.direction !== 'command') {
    addIssue(issues, '$.direction', 'invalid_direction', 'command message requires command direction');
  } else if (isEvent && envelope.direction !== 'event') {
    addIssue(issues, '$.direction', 'invalid_direction', 'event message requires event direction');
  } else if (!isCommand && !isEvent && !isBrokerIpcDirection(envelope.direction)) {
    addIssue(issues, '$.direction', 'invalid_direction', 'must be command or event');
  }

  requireNonEmptyString(envelope.run_id, '$.run_id', issues);
  requireNonEmptyString(envelope.session_id, '$.session_id', issues);
  requireNonEmptyString(envelope.correlation_id, '$.correlation_id', issues);
  requireNonEmptyString(envelope.causation_id, '$.causation_id', issues);
  requireNonEmptyString(envelope.adapter_version, '$.adapter_version', issues);
  requireTimestamp(envelope.event_ts_ns, '$.event_ts_ns', issues);

  if (isCommand && requiresIdempotencyKey(messageType)) {
    requireNonEmptyString(envelope.idempotency_key, '$.idempotency_key', issues);
  }
  if (
    ((isCommand && forbidsIdempotencyKey(messageType)) || isEvent) &&
    envelope.idempotency_key !== undefined
  ) {
    addIssue(issues, '$.idempotency_key', 'forbidden_field', 'must be omitted for this message_type');
  }

  if (!Object.hasOwn(envelope, 'payload')) {
    addIssue(issues, '$.payload', 'missing_required_field', 'is required');
  } else {
    const payload = requireRecord(envelope.payload, '$.payload', issues);
    if (payload !== undefined) {
      if (messageType === 'boot_identity') {
        validateBootIdentityPayload(payload, issues);
      }
      if (
        messageType === 'broker_error' ||
        messageType === 'connection_lost' ||
        messageType === 'order_rejected' ||
        messageType === 'cancel_rejected'
      ) {
        validateFailurePayload(payload, issues);
      }
      validateOptionalIpcLatency(payload, issues);
    }
  }

  return {
    ok: issues.length === 0,
    ...(issues.length === 0 ? { envelope: value as BrokerIpcEnvelope } : {}),
    issues: issues.sort(compareIssues),
  };
}

export function isBrokerIpcCommandMessageType(value: unknown): value is BrokerIpcCommandMessageType {
  return typeof value === 'string' && BROKER_IPC_COMMAND_MESSAGE_TYPES.includes(value as never);
}

export function isBrokerIpcEventMessageType(value: unknown): value is BrokerIpcEventMessageType {
  return typeof value === 'string' && BROKER_IPC_EVENT_MESSAGE_TYPES.includes(value as never);
}

export function isBrokerIpcDirection(value: unknown): value is BrokerIpcDirection {
  return typeof value === 'string' && BROKER_IPC_DIRECTIONS.includes(value as never);
}

function requiresIdempotencyKey(messageType: BrokerIpcCommandMessageType): boolean {
  return BROKER_IPC_COMMAND_MESSAGE_TYPES_REQUIRING_IDEMPOTENCY_KEY.includes(messageType as never);
}

function forbidsIdempotencyKey(messageType: BrokerIpcCommandMessageType): boolean {
  return BROKER_IPC_COMMAND_MESSAGE_TYPES_FORBIDDING_IDEMPOTENCY_KEY.includes(messageType as never);
}

function validateBootIdentityPayload(
  payload: Record<string, unknown>,
  issues: BrokerIpcValidationIssue[],
): void {
  requireNonEmptyString(payload.adapter_version, '$.payload.adapter_version', issues);
  if (!BROKER_IPC_SDK_NAMES.includes(payload.sdk_name as never)) {
    addIssue(
      issues,
      '$.payload.sdk_name',
      'invalid_field_value',
      `must be one of: ${BROKER_IPC_SDK_NAMES.join(', ')}`,
    );
  }
  requireNonEmptyString(payload.sdk_version, '$.payload.sdk_version', issues);
  if (!BROKER_IPC_PROTOCOL_ENVIRONMENTS.includes(payload.protocol_environment as never)) {
    addIssue(
      issues,
      '$.payload.protocol_environment',
      'invalid_field_value',
      `must be one of: ${BROKER_IPC_PROTOCOL_ENVIRONMENTS.join(', ')}`,
    );
  }
  requireNonEmptyString(payload.gateway_url_redacted, '$.payload.gateway_url_redacted', issues);
  requireTimestamp(payload.boot_ts_ns, '$.payload.boot_ts_ns', issues);
  requireNonNegativeInteger(payload.process_id, '$.payload.process_id', issues);
  if (payload.schema_version !== BROKER_IPC_SCHEMA_VERSION) {
    addIssue(
      issues,
      '$.payload.schema_version',
      'unsupported_schema_version',
      `must be ${BROKER_IPC_SCHEMA_VERSION}`,
    );
  }
}

function validateFailurePayload(
  payload: Record<string, unknown>,
  issues: BrokerIpcValidationIssue[],
): void {
  if (!Object.hasOwn(payload, 'failure_state')) {
    addIssue(issues, '$.payload.failure_state', 'missing_required_field', 'is required');
  } else if (!BROKER_IPC_FAILURE_STATES.includes(payload.failure_state as never)) {
    addIssue(
      issues,
      '$.payload.failure_state',
      'invalid_field_value',
      `must be one of: ${BROKER_IPC_FAILURE_STATES.join(', ')}`,
    );
  }
  requireRequiredString(payload, 'reason', '$.payload.reason', issues);
  requireRequiredBoolean(payload, 'recoverable', '$.payload.recoverable', issues);
  optionalString(payload.rp_code, '$.payload.rp_code', issues);
  optionalString(payload.rp_message_redacted, '$.payload.rp_message_redacted', issues);
  optionalString(
    payload.correlated_command_idempotency_key,
    '$.payload.correlated_command_idempotency_key',
    issues,
  );
}

function validateOptionalIpcLatency(
  payload: Record<string, unknown>,
  issues: BrokerIpcValidationIssue[],
): void {
  const value = payload.qfa_broker_sidecar_ipc_ms;
  if (
    value !== undefined &&
    (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
  ) {
    addIssue(
      issues,
      '$.payload.qfa_broker_sidecar_ipc_ms',
      'invalid_field_value',
      'must be a non-negative finite number when present',
    );
  }
}

function requireRecord(
  value: unknown,
  path: string,
  issues: BrokerIpcValidationIssue[],
): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    addIssue(issues, path, 'invalid_envelope', 'must be an object');
    return undefined;
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(
  value: unknown,
  path: string,
  issues: BrokerIpcValidationIssue[],
): void {
  if (typeof value !== 'string' || value.trim() === '') {
    addIssue(issues, path, 'invalid_field_type', 'must be a non-empty string');
  }
}

function requireRequiredString(
  record: Record<string, unknown>,
  fieldName: string,
  path: string,
  issues: BrokerIpcValidationIssue[],
): void {
  if (!Object.hasOwn(record, fieldName)) {
    addIssue(issues, path, 'missing_required_field', 'is required');
    return;
  }
  requireNonEmptyString(record[fieldName], path, issues);
}

function requireRequiredBoolean(
  record: Record<string, unknown>,
  fieldName: string,
  path: string,
  issues: BrokerIpcValidationIssue[],
): void {
  if (!Object.hasOwn(record, fieldName)) {
    addIssue(issues, path, 'missing_required_field', 'is required');
    return;
  }
  if (typeof record[fieldName] !== 'boolean') {
    addIssue(issues, path, 'invalid_field_type', 'must be a boolean');
  }
}

function optionalString(
  value: unknown,
  path: string,
  issues: BrokerIpcValidationIssue[],
): void {
  if (value !== undefined && typeof value !== 'string') {
    addIssue(issues, path, 'invalid_field_type', 'must be a string when present');
  }
}

function requireTimestamp(
  value: unknown,
  path: string,
  issues: BrokerIpcValidationIssue[],
): void {
  if (typeof value === 'bigint') {
    if (value >= 0n) {
      return;
    }
  } else if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) {
      return;
    }
  } else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    return;
  }
  addIssue(
    issues,
    path,
    'invalid_field_value',
    'must be a non-negative bigint, safe integer, or unsigned decimal string',
  );
}

function requireNonNegativeInteger(
  value: unknown,
  path: string,
  issues: BrokerIpcValidationIssue[],
): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    addIssue(issues, path, 'invalid_field_value', 'must be a non-negative safe integer');
  }
}

function addIssue(
  issues: BrokerIpcValidationIssue[],
  path: string,
  code: BrokerIpcValidationIssueCode,
  message: string,
): void {
  issues.push({ path, code, message });
}

function compareIssues(left: BrokerIpcValidationIssue, right: BrokerIpcValidationIssue): number {
  return left.path.localeCompare(right.path) || left.code.localeCompare(right.code);
}
