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
const LIVE_ACCOUNT_ALLOWLIST = [
  {
    fcm_id: 'TEST_FCM',
    ib_id: 'TEST_IB',
    account_id: 'TEST_ACCT_001',
    label: 'Synthetic account',
    max_position_contracts: 2,
    daily_loss_cap_usd: 100,
    max_session_duration_ms: 60_000,
    time_of_day_restriction: 'unrestricted',
  },
] as const;

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

  it('rejects order intents missing account_id before sending to the sidecar when allowlist is configured', async () => {
    const { adapter, sessions } = adapterFor('clean_shutdown', {
      live_account_allowlist: LIVE_ACCOUNT_ALLOWLIST,
    });
    await adapter.start();

    const result = await adapter.submitIntent(orderIntent('intent-missing-account'));
    await adapter.stop();

    expect(result).toMatchObject({ accepted: false });
    expect(sessions.find((event) => event.type === 'VALIDATOR_ISSUE')).toMatchObject({
      payload: {
        validator_id: 'EXEC-VALIDATOR-09',
        code: 'order_intent_missing_account_id',
        severity: 'fatal',
      },
    });
  });

  it('accepts valid allowlisted account intent and preserves broker_account_id lineage', async () => {
    const { adapter, acks } = adapterFor('clean_shutdown', {
      live_account_allowlist: LIVE_ACCOUNT_ALLOWLIST,
    });
    await adapter.start();

    const result = await adapter.submitIntent(orderIntent('intent-allowlisted', 'TEST_ACCT_001'));
    await adapter.stop();

    expect(result).toMatchObject({ accepted: true });
    expect(acks.find((event) => event.type === 'ORDER_ACK_SUBMISSION')).toMatchObject({
      payload: { broker_account_id: 'TEST_ACCT_001' },
    });
  });

  it('rejects non-allowlisted account intents before sending to the sidecar', async () => {
    const { adapter, sessions } = adapterFor('clean_shutdown', {
      live_account_allowlist: LIVE_ACCOUNT_ALLOWLIST,
    });
    await adapter.start();

    const result = await adapter.submitIntent(orderIntent('intent-non-allowlisted', 'OTHER_ACCT'));
    await adapter.stop();

    expect(result).toMatchObject({ accepted: false });
    expect(sessions.find((event) => event.type === 'VALIDATOR_ISSUE')).toMatchObject({
      payload: {
        validator_id: 'EXEC-VALIDATOR-09',
        code: 'account_id_not_in_allowlist',
        severity: 'fatal',
      },
    });
  });

  it('uses the MNQ session calendar for RTH-only account restrictions', async () => {
    const { adapter, sessions } = adapterFor('clean_shutdown', {
      live_account_allowlist: [
        {
          ...LIVE_ACCOUNT_ALLOWLIST[0],
          time_of_day_restriction: 'rth_only',
        },
      ],
      now_ns: () => ns(1_780_585_080_000_000_000n),
    });
    await adapter.start();

    const result = await adapter.submitIntent(orderIntent('intent-rth-allowlisted', 'TEST_ACCT_001'));
    await adapter.stop();

    expect(result).toMatchObject({ accepted: true });
    expect(sessions.filter((event) => event.type === 'VALIDATOR_ISSUE')).toEqual([]);
  });

  it('rejects account cap breaches before sending to the sidecar', async () => {
    const { adapter, sessions } = adapterFor('clean_shutdown', {
      live_account_allowlist: LIVE_ACCOUNT_ALLOWLIST,
    });
    await adapter.start();

    const oversized = {
      ...orderIntent('intent-cap-breach', 'TEST_ACCT_001'),
      payload: {
        ...orderIntent('intent-cap-breach', 'TEST_ACCT_001').payload,
        quantity: 3,
      },
    } as OrderIntentEventEnvelope;
    const result = await adapter.submitIntent(oversized);
    await adapter.stop();

    expect(result).toMatchObject({ accepted: false });
    expect(sessions.find((event) => event.type === 'VALIDATOR_ISSUE')).toMatchObject({
      payload: {
        validator_id: 'EXEC-VALIDATOR-09',
        code: 'max_position_contracts_exceeded',
        severity: 'fatal',
      },
    });
  });

  it('engages kill switch on cross-account contamination', async () => {
    const gate = new SubmissionGate();
    const { adapter, sessions } = adapterFor('cross_account_mismatch', {
      live_account_allowlist: LIVE_ACCOUNT_ALLOWLIST,
      submission_gate: gate,
    });
    await adapter.start();

    await adapter.submitIntent(orderIntent('intent-cross-account', 'TEST_ACCT_001'));
    await adapter.stop();

    expect(sessions.find((event) => event.type === 'VALIDATOR_ISSUE')).toMatchObject({
      payload: {
        validator_id: 'EXEC-VALIDATOR-09',
        code: 'cross_account_contamination',
        severity: 'fatal',
      },
    });
    expect(gate.acquire()).toMatchObject({ allowed: false });
  });

  it('does not auto-submit flatten orders on adapter stop after a fill', async () => {
    const { adapter, sessions } = adapterFor('fill_then_shutdown', {
      live_account_allowlist: LIVE_ACCOUNT_ALLOWLIST,
    });
    await adapter.start();

    const result = await adapter.submitIntent(orderIntent('intent-filled', 'TEST_ACCT_001'));
    await adapter.stop();

    expect(result).toMatchObject({ accepted: true });
    expect(sessions.find((event) => event.type === 'VALIDATOR_ISSUE')).toBeUndefined();
  });

  it('verifies account_list_snapshot against the configured allowlist during boot when enabled', async () => {
    const { adapter } = adapterFor('account_snapshot_pass', {
      live_account_allowlist: LIVE_ACCOUNT_ALLOWLIST,
      account_list_verification_enabled: true,
    });

    await adapter.start();
    await adapter.stop();
  });

  it('rejects boot when account_list_snapshot is missing an allowlist entry', async () => {
    const { adapter, sessions } = adapterFor('account_snapshot_missing', {
      live_account_allowlist: LIVE_ACCOUNT_ALLOWLIST,
      account_list_verification_enabled: true,
    });

    await expect(adapter.start()).rejects.toThrow('account allowlist verification failed');
    expect(sessions.find((event) => event.type === 'VALIDATOR_ISSUE')).toMatchObject({
      payload: {
        validator_id: 'EXEC-VALIDATOR-09',
        code: 'account_allowlist_missing_from_broker_snapshot',
        severity: 'fatal',
      },
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

function orderIntent(eventId: string, accountId?: string): OrderIntentEventEnvelope {
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
      ...(accountId === undefined ? {} : { account_id: accountId }),
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
  if (command.message_type === "query_account_list") {
    send(envelope("account_list_snapshot", command.correlation_id, {
      accounts: scenario === "account_snapshot_missing" ? [] : [{
        fcm_id: "TEST_FCM",
        ib_id: "TEST_IB",
        account_id: "TEST_ACCT_001",
        account_name: "Synthetic account",
        account_currency: "USD",
        account_auto_liquidate: false
      }],
      snapshot_ts_ns: "1800000000001000000"
    }));
    return;
  }
  if (command.message_type !== "submit_order") return;
  if (scenario === "fill_then_shutdown" && String(command.idempotency_key || "").includes("auto-flatten")) {
    send(envelope("broker_error", command.correlation_id, {
      failure_state: "auto_flatten_unexpected",
      reason: "auto-flatten submit_order is not authorized by QFA-612-BROKER-03",
      recoverable: false
    }));
    return;
  }
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
  const brokerAccountId = scenario === "cross_account_mismatch"
    ? "OTHER_ACCT"
    : (command.payload.intent.payload.account_id || "paper-account");
  send(envelope("order_accepted", command.correlation_id, {
    intent_id: command.payload.intent.event_id,
    submission_ack_id: "submission-ack-1",
    broker_order_id: "PY-1",
    broker_account_id: brokerAccountId,
    instrument_symbol: "MNQM6"
  }));
  if (scenario === "fill_then_shutdown") {
    send(envelope("order_filled", command.correlation_id, {
      intent_id: command.payload.intent.event_id,
      submission_ack_id: "submission-ack-1",
      fill_ack_id: "fill-ack-1",
      broker_order_id: "PY-1",
      broker_account_id: brokerAccountId,
      instrument_symbol: "MNQM6",
      fill_qty: 1,
      fill_price: 19750.25
    }));
  }
}
`;
}
