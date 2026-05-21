import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { stableJsonStringify, type JsonValue } from '../../src/contracts/index.js';
import {
  BROKER_IPC_COMMAND_MESSAGE_TYPES_FORBIDDING_IDEMPOTENCY_KEY,
  BROKER_IPC_COMMAND_MESSAGE_TYPES_REQUIRING_IDEMPOTENCY_KEY,
  BROKER_IPC_FAILURE_STATES,
  BROKER_IPC_SCHEMA_VERSION,
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
    expect(contract.optional_telemetry_fields).toContain('qfa_broker_sidecar_ipc_ms');
    expect(contract.bigint_fields).toContain('boot_ts_ns');
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
          sdk_name: 'pyrithmic',
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
});
