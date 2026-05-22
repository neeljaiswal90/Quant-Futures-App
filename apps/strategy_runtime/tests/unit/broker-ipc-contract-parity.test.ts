import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { stableJsonStringify, type JsonValue } from '../../src/contracts/index.js';
import {
  BROKER_IPC_COMMAND_MESSAGE_TYPES_FORBIDDING_IDEMPOTENCY_KEY,
  BROKER_IPC_COMMAND_MESSAGE_TYPES_REQUIRING_IDEMPOTENCY_KEY,
  BROKER_IPC_FAILURE_STATES,
  BROKER_IPC_SCHEMA_VERSION,
  BROKER_IPC_SDK_NAMES,
  buildBrokerIpcContractExport,
  stableBrokerIpcContractJson,
  validateBrokerIpcEnvelope,
} from '../../src/execution/brokers/broker-ipc-contract.js';

const PYTHON = process.env.PYTHON ?? 'python';

function pythonContractJson(): string {
  const result = spawnSync(
    PYTHON,
    ['-m', 'services.broker_session_sidecar.contracts.broker_ipc_contract', '--export-json'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Python broker IPC contract export failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function pythonContract(): Record<string, unknown> {
  return JSON.parse(pythonContractJson()) as Record<string, unknown>;
}

function baseEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: BROKER_IPC_SCHEMA_VERSION,
    message_type: 'submit_order',
    direction: 'command',
    run_id: 'run-1',
    session_id: 'session-1',
    correlation_id: 'corr-1',
    causation_id: 'cause-1',
    idempotency_key: 'idem-1',
    event_ts_ns: 1776965227000000000n,
    adapter_version: 'broker-ipc-v1',
    payload: {},
    ...overrides,
  };
}

describe('QFA-612 broker IPC contract parity', () => {
  it('keeps TS source-of-truth and Python mirror canonically equivalent', () => {
    expect(stableBrokerIpcContractJson()).toBe(
      stableJsonStringify(JSON.parse(pythonContractJson())),
    );
    expect(stableBrokerIpcContractJson()).toBe(
      stableJsonStringify(buildBrokerIpcContractExport() as unknown as JsonValue),
    );
  });

  it('publishes the v1 message, failure-state, transport, and telemetry contract', () => {
    const contract = buildBrokerIpcContractExport();

    expect(contract.schema_version).toBe(1);
    expect(contract.transport).toEqual({
      framing: 'json_lines',
      line_separator: 'LF',
      bigint_fields_serialized_as: 'decimal_string',
      multiline_messages: false,
    });
    expect(contract.command_message_types_requiring_idempotency_key).toEqual(
      BROKER_IPC_COMMAND_MESSAGE_TYPES_REQUIRING_IDEMPOTENCY_KEY,
    );
    expect(contract.command_message_types_forbidding_idempotency_key).toEqual(
      BROKER_IPC_COMMAND_MESSAGE_TYPES_FORBIDDING_IDEMPOTENCY_KEY,
    );
    expect(contract.failure_states).toEqual(BROKER_IPC_FAILURE_STATES);
    expect(contract.failure_states).toContain('order_path_not_yet_implemented');
    expect(contract.failure_states).toContain('account_id_not_in_allowlist');
    expect(contract.command_message_types_forbidding_idempotency_key).toContain('query_account_list');
    expect(contract.event_message_types).toContain('account_list_snapshot');
    expect(contract.sdk_names).toEqual(BROKER_IPC_SDK_NAMES);
    expect(contract.sdk_names).toEqual(['pyrithmic', 'async-rithmic']);
    expect(contract.sdk_names).toEqual(pythonContract().sdk_names);
    expect(contract.failure_payload_fields).toEqual([
      'failure_state',
      'rp_code',
      'rp_message_redacted',
      'reason',
      'recoverable',
      'correlated_command_idempotency_key',
      'qfa_broker_sidecar_ipc_ms',
    ]);
    expect(contract.failure_payload_fields).toEqual(pythonContract().failure_payload_fields);
    expect(contract.account_list_payload_fields).toEqual(['accounts', 'snapshot_ts_ns']);
    expect(contract.account_payload_fields).toEqual([
      'fcm_id',
      'ib_id',
      'account_id',
      'account_name',
      'account_currency',
      'account_auto_liquidate',
    ]);
    expect(contract.account_list_payload_fields).toEqual(pythonContract().account_list_payload_fields);
    expect(contract.account_payload_fields).toEqual(pythonContract().account_payload_fields);
    expect(contract.optional_telemetry_fields).toContain('qfa_broker_sidecar_ipc_ms');
    expect(contract.bigint_fields).toContain('boot_ts_ns');
    expect(contract.bigint_fields).toContain('snapshot_ts_ns');
  });

  it('validates command idempotency requirements and forbidden idempotency keys', () => {
    expect(validateBrokerIpcEnvelope(baseEnvelope()).ok).toBe(true);

    expect(
      validateBrokerIpcEnvelope(baseEnvelope({ idempotency_key: undefined })).issues,
    ).toContainEqual({
      path: '$.idempotency_key',
      code: 'invalid_field_type',
      message: 'must be a non-empty string',
    });

    expect(
      validateBrokerIpcEnvelope(
        baseEnvelope({
          message_type: 'heartbeat',
          idempotency_key: 'forbidden',
        }),
      ).issues,
    ).toContainEqual({
      path: '$.idempotency_key',
      code: 'forbidden_field',
      message: 'must be omitted for this message_type',
    });
  });

  it('validates boot identity payload and event idempotency rules', () => {
    const result = validateBrokerIpcEnvelope(
      baseEnvelope({
        message_type: 'boot_identity',
        direction: 'event',
        idempotency_key: undefined,
        payload: {
          adapter_version: 'broker-ipc-v1',
          sdk_name: 'async-rithmic',
          sdk_version: '1.2.3',
          protocol_environment: 'rithmic_paper',
          gateway_url_redacted: 'rituz00100.rithmic.com:443',
          boot_ts_ns: '1776965227000000000',
          process_id: 1234,
          schema_version: BROKER_IPC_SCHEMA_VERSION,
          qfa_broker_sidecar_ipc_ms: 12.5,
        },
      }),
    );

    expect(result.ok).toBe(true);
  });

  it('rejects mismatched direction, invalid timestamps, and unknown failure states', () => {
    const result = validateBrokerIpcEnvelope(
      baseEnvelope({
        message_type: 'broker_error',
        direction: 'command',
        idempotency_key: undefined,
        event_ts_ns: '-1',
        payload: {
          failure_state: 'unknown_state',
          reason: 'broker returned an unknown state',
          recoverable: false,
          qfa_broker_sidecar_ipc_ms: -1,
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual([
      '$.direction',
      '$.event_ts_ns',
      '$.payload.failure_state',
      '$.payload.qfa_broker_sidecar_ipc_ms',
    ]);
  });

  it('requires recoverable for failure payloads', () => {
    const result = validateBrokerIpcEnvelope(
      baseEnvelope({
        message_type: 'broker_error',
        direction: 'event',
        idempotency_key: undefined,
        payload: {
          failure_state: 'broker_disconnected',
          reason: 'heartbeat expired',
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      path: '$.payload.recoverable',
      code: 'missing_required_field',
      message: 'is required',
    });
  });

  it('validates broker_error payloads with all optional diagnostic fields', () => {
    const result = validateBrokerIpcEnvelope(
      baseEnvelope({
        message_type: 'broker_error',
        direction: 'event',
        idempotency_key: undefined,
        payload: {
          failure_state: 'broker_disconnected',
          rp_code: 'RP-123',
          rp_message_redacted: 'connection closed by gateway [redacted]',
          reason: 'gateway disconnected',
          recoverable: true,
          correlated_command_idempotency_key: 'idem-1',
          qfa_broker_sidecar_ipc_ms: 3.5,
        },
      }),
    );

    expect(result.ok).toBe(true);
  });

  it('rejects non-string rp_code failure diagnostics', () => {
    const result = validateBrokerIpcEnvelope(
      baseEnvelope({
        message_type: 'broker_error',
        direction: 'event',
        idempotency_key: undefined,
        payload: {
          failure_state: 'broker_disconnected',
          rp_code: 123,
          reason: 'gateway disconnected',
          recoverable: true,
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      path: '$.payload.rp_code',
      code: 'invalid_field_type',
      message: 'must be a string when present',
    });
  });

  it('validates account list snapshots', () => {
    const result = validateBrokerIpcEnvelope(
      baseEnvelope({
        message_type: 'account_list_snapshot',
        direction: 'event',
        idempotency_key: undefined,
        payload: {
          accounts: [
            {
              fcm_id: 'TEST_FCM',
              ib_id: 'TEST_IB',
              account_id: 'TEST_ACCT_001',
              account_name: 'Synthetic account',
              account_currency: 'USD',
              account_auto_liquidate: false,
            },
          ],
          snapshot_ts_ns: '1776965227000000000',
        },
      }),
    );

    expect(result.ok).toBe(true);
  });

  it('rejects malformed account list snapshots', () => {
    const result = validateBrokerIpcEnvelope(
      baseEnvelope({
        message_type: 'account_list_snapshot',
        direction: 'event',
        idempotency_key: undefined,
        payload: {
          accounts: [{ fcm_id: 'TEST_FCM', ib_id: 42, account_id: 'TEST_ACCT_001' }],
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toContain('$.payload.accounts[0].ib_id');
    expect(result.issues.map((issue) => issue.path)).toContain('$.payload.snapshot_ts_ns');
  });
});
