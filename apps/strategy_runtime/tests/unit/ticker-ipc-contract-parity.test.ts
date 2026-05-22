import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { stableJsonStringify, type JsonValue } from '../../src/contracts/index.js';
import {
  TICKER_IPC_COMMAND_MESSAGE_TYPES,
  TICKER_IPC_FAILURE_STATES,
  TICKER_IPC_SCHEMA_VERSION,
  buildTickerIpcContractExport,
  stableTickerIpcContractJson,
  validateTickerIpcEnvelope,
} from '../../src/data/ticker-ipc-contract.js';

const PYTHON = process.env.PYTHON ?? 'python';

function pythonContractJson(): string {
  const result = spawnSync(
    PYTHON,
    ['-m', 'services.ticker_session_sidecar.contracts.ticker_ipc_contract', '--export-json'],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `Python ticker IPC contract export failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function baseEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: TICKER_IPC_SCHEMA_VERSION,
    message_type: 'subscribe_symbol',
    direction: 'command',
    run_id: 'run-1',
    session_id: 'session-1',
    correlation_id: 'corr-1',
    causation_id: 'cause-1',
    event_ts_ns: 1776965227000000000n,
    adapter_version: 'ticker-ipc-v1',
    payload: { symbol: 'MNQM6', exchange: 'CME' },
    ...overrides,
  };
}

describe('QFA-633 ticker IPC contract parity', () => {
  it('keeps TS source-of-truth and Python mirror canonically equivalent', () => {
    expect(stableTickerIpcContractJson()).toBe(stableJsonStringify(JSON.parse(pythonContractJson())));
    expect(stableTickerIpcContractJson()).toBe(
      stableJsonStringify(buildTickerIpcContractExport() as unknown as JsonValue),
    );
  });

  it('publishes the v1 ticker-only message and telemetry contract', () => {
    const contract = buildTickerIpcContractExport();
    expect(contract.schema_version).toBe(1);
    expect(contract.command_message_types).toEqual(TICKER_IPC_COMMAND_MESSAGE_TYPES);
    expect(contract.command_message_types_forbidding_idempotency_key).toEqual(TICKER_IPC_COMMAND_MESSAGE_TYPES);
    expect(contract.failure_states).toEqual(TICKER_IPC_FAILURE_STATES);
    expect(contract.bigint_fields).toContain('tick_ts_ns');
    expect(contract.event_message_types).toContain('tick_quote');
    expect(contract.event_message_types).toContain('tick_trade');
  });

  it('forbids idempotency keys on all ticker commands', () => {
    const result = validateTickerIpcEnvelope(baseEnvelope({ idempotency_key: 'not-allowed' }));
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      path: '$.idempotency_key',
      code: 'forbidden_field',
      message: 'ticker IPC commands must omit idempotency_key',
    });
  });

  it('validates tick quote payloads', () => {
    const result = validateTickerIpcEnvelope(baseEnvelope({
      message_type: 'tick_quote',
      direction: 'event',
      payload: {
        symbol: 'MNQM6',
        exchange: 'CME',
        tick_ts_ns: '1776965227000000000',
        sidecar_recv_ts_ns: '1776965227000001000',
        bid_px: 18000.25,
        bid_qty: 2,
        ask_px: 18000.5,
        ask_qty: 3,
      },
    }));
    expect(result.ok).toBe(true);
  });

  it('requires recoverable on structured failure payloads', () => {
    const result = validateTickerIpcEnvelope(baseEnvelope({
      message_type: 'broker_error',
      direction: 'event',
      payload: {
        failure_state: 'broker_disconnected',
        reason: 'heartbeat expired',
      },
    }));
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      path: '$.payload.recoverable',
      code: 'missing_required_field',
      message: 'is required',
    });
  });
});
