import { describe, expect, it } from 'vitest';
import {
  createJournalEventEnvelope,
  makeCandidateId,
  makeCausationId,
  makeEventId,
  makeOrderIntentId,
  makeRunId,
  makeSessionId,
  makeSizingDecisionId,
  ns,
  type JournalEventPayloadFor,
  type UnixNs,
} from '../../src/contracts/index.js';
import { SubmissionGate } from '../../src/execution/order-lifecycle-state-machine.js';
import { BROKER_IPC_SCHEMA_VERSION } from '../../src/execution/brokers/broker-ipc-contract.js';
import {
  PythonBrokerAdapter,
} from '../../src/execution/brokers/python-broker-adapter.js';
import type {
  BrokerAckEnvelope,
  BrokerSessionEvent,
  OrderIntentEventEnvelope,
} from '../../src/execution/brokers/broker-adapter.js';

const RUN_ID = makeRunId('run-python-broker-adapter');
const SESSION_ID = makeSessionId('session-python-broker-adapter');
const BASE_TS_NS = ns(1_800_000_000_000_000_000n);

describe('PythonBrokerAdapter', () => {
  it('emits SESSION_MANIFEST from boot_identity', async () => {
    const { adapter, sessions } = adapterFor('boot');

    await adapter.start();
    await adapter.stop();

    expect(sessions.find((event) => event.type === 'SESSION_MANIFEST')).toMatchObject({
      payload: {
        broker_session_id: 'mock-python-session',
        adapter_kind: 'PYTHON_RITHMIC_ORDER_PLANT',
      },
    });
  });

  it('rejects start when boot_identity times out', async () => {
    const { adapter } = adapterFor('no_boot', { boot_timeout_ms: 30 });

    await expect(adapter.start()).rejects.toThrow('boot_identity timeout');
  });

  it('rejects start on schema version mismatch and emits VALIDATOR_ISSUE', async () => {
    const { adapter, sessions } = adapterFor('schema_mismatch');

    await expect(adapter.start()).rejects.toThrow('schema version mismatch');

    expect(sessions.find((event) => event.type === 'VALIDATOR_ISSUE')).toMatchObject({
      payload: { code: 'broker_ipc_schema_version_mismatch' },
    });
  });

  it('returns accepted false for order_path_not_yet_implemented and emits marker issue', async () => {
    const { adapter, sessions } = adapterFor('order_not_implemented');
    await adapter.start();

    const result = await adapter.submitIntent(orderIntent('intent-not-implemented'));
    await adapter.stop();

    expect(result).toMatchObject({ accepted: false });
    expect(sessions.find((event) => event.type === 'VALIDATOR_ISSUE')).toMatchObject({
      payload: { code: 'order_path_not_yet_implemented' },
    });
  });

  it('emits VALIDATOR_ISSUE for malformed JSON and keeps processing', async () => {
    const { adapter, sessions, acks } = adapterFor('malformed_then_ack');
    await adapter.start();

    const result = await adapter.submitIntent(orderIntent('intent-malformed'));
    await adapter.stop();

    expect(result).toMatchObject({ accepted: true });
    expect(sessions.find((event) => event.type === 'VALIDATOR_ISSUE')).toMatchObject({
      payload: { code: 'broker_ipc_malformed_json' },
    });
    expect(acks.find((event) => event.type === 'ORDER_ACK_SUBMISSION')).toMatchObject({
      payload: { broker_order_id: 'PY-1' },
    });
  });

  it('marks sidecar unavailable and blocks SubmissionGate when sidecar exits mid-session', async () => {
    const gate = new SubmissionGate();
    const { adapter, sessions } = adapterFor('exit_mid_session', { submission_gate: gate });

    await adapter.start();
    await eventually(() => {
      expect(sessions.find((event) => event.type === 'VALIDATOR_ISSUE')).toMatchObject({
        payload: { code: 'sidecar_unavailable' },
      });
    });

    expect(gate.acquire()).toMatchObject({
      allowed: false,
      reason: 'broker_reconciliation_in_progress_active',
    });
  });

  it('sends shutdown, waits for shutdown_complete, and resolves stop', async () => {
    const { adapter, sessions } = adapterFor('clean_shutdown');
    await adapter.start();

    await adapter.stop();

    expect(sessions.filter((event) => event.type === 'VALIDATOR_ISSUE')).toEqual([]);
  });
});

function adapterFor(
  scenario: string,
  overrides: Partial<ConstructorParameters<typeof PythonBrokerAdapter>[0]> = {},
): {
  readonly adapter: PythonBrokerAdapter;
  readonly sessions: BrokerSessionEvent[];
  readonly acks: BrokerAckEnvelope[];
} {
  const sessions: BrokerSessionEvent[] = [];
  const acks: BrokerAckEnvelope[] = [];
  const adapter = new PythonBrokerAdapter({
    executable: process.execPath,
    args: ['-e', mockSidecarScript(), scenario],
    boot_timeout_ms: 250,
    shutdown_timeout_ms: 100,
    heartbeat_timeout_ms: 1_000,
    now_ns: timestampSource(),
    ...overrides,
  });
  adapter.subscribeSessionEvents((event) => sessions.push(event));
  adapter.subscribeAckEvents((event) => acks.push(event));
  return { adapter, sessions, acks };
}

function orderIntent(eventId: string): OrderIntentEventEnvelope {
  return createJournalEventEnvelope({
    event_id: makeEventId(eventId),
    type: 'ORDER_INTENT',
    ts_ns: BASE_TS_NS,
    run_id: RUN_ID,
    session_id: SESSION_ID,
    causation_id: makeCausationId('sizing-1'),
    payload: {
      order_intent_id: makeOrderIntentId(`order-${eventId}`),
      candidate_id: makeCandidateId('candidate-1'),
      sizing_decision_id: makeSizingDecisionId('sizing-1'),
      side: 'buy',
      order_type: 'limit',
      quantity: 1,
      limit_price: 19_750.25,
      time_in_force: 'day',
    } satisfies JournalEventPayloadFor<'ORDER_INTENT'>,
  });
}

function timestampSource(): () => UnixNs {
  let offset = 0n;
  return () => {
    offset += 1_000_000n;
    return ns(BASE_TS_NS + offset);
  };
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 500;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function mockSidecarScript(): string {
  return String.raw`
const scenario = process.argv[1];
const schemaVersion = ${BROKER_IPC_SCHEMA_VERSION};
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
function envelope(messageType, correlationId, payload, overrides = {}) {
  return {
    schema_version: schemaVersion,
    message_type: messageType,
    direction: "event",
    run_id: "run-python-broker-adapter",
    session_id: "mock-python-session",
    correlation_id: correlationId,
    causation_id: correlationId,
    event_ts_ns: "1800000000001000000",
    adapter_version: "mock-sidecar-v1",
    payload,
    ...overrides
  };
}
function boot(version = schemaVersion) {
  send({
    schema_version: version,
    message_type: "boot_identity",
    direction: "event",
    run_id: "run-python-broker-adapter",
    session_id: "mock-python-session",
    correlation_id: "boot",
    causation_id: "boot",
    event_ts_ns: "1800000000000000000",
    adapter_version: "mock-sidecar-v1",
    payload: {
      adapter_version: "mock-sidecar-v1",
      sdk_name: "pyrithmic",
      sdk_version: "test",
      protocol_environment: "rithmic_paper",
      gateway_url_redacted: "mock-gateway",
      boot_ts_ns: "1800000000000000000",
      process_id: process.pid,
      schema_version: version
    }
  });
}
if (scenario === "no_boot") {
  setInterval(() => undefined, 1000);
} else if (scenario === "schema_mismatch") {
  boot(schemaVersion + 1);
} else {
  boot();
}
if (scenario === "exit_mid_session") {
  setTimeout(() => process.exit(17), 20);
}
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) handle(JSON.parse(line));
  }
});
function handle(command) {
  if (command.message_type === "shutdown") {
    send(envelope("shutdown_complete", command.correlation_id, {}, {
      event_ts_ns: "1800000000002000000"
    }));
    return;
  }
  if (command.message_type !== "submit_order") return;
  if (scenario === "order_not_implemented") {
    send(envelope("broker_error", command.correlation_id, {
      failure_state: "order_path_not_yet_implemented",
      reason: "order_path_not_yet_implemented",
      recoverable: false,
      correlated_command_idempotency_key: command.idempotency_key,
      qfa_broker_sidecar_ipc_ms: 1.5
    }));
    return;
  }
  if (scenario === "malformed_then_ack") {
    process.stdout.write("{not-json}\n");
  }
  send(envelope("order_accepted", command.correlation_id, {
    intent_id: command.payload.intent.event_id,
    submission_ack_id: "submission-ack-1",
    broker_order_id: "PY-1",
    broker_account_id: "paper-account",
    instrument_symbol: "MNQM6"
  }));
}
`;
}
