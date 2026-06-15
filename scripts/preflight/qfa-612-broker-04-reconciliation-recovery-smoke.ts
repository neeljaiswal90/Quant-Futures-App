import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
  type AnyJournalEventEnvelope,
  type EventId,
  type JournalEventPayloadFor,
  type UnixNs,
} from '../../apps/strategy_runtime/src/contracts/index.js';
import {
  DEFAULT_BROKER_RECONNECT_POLICY_CONFIG,
  type BrokerAckEnvelope,
  type BrokerAdapter,
  type BrokerCancelRequest,
  type BrokerReconnectState,
  type BrokerSessionEvent,
  type OrderIntentEventEnvelope,
} from '../../apps/strategy_runtime/src/execution/brokers/broker-adapter.js';
import { BrokerAdapterRuntimeIntegration } from '../../apps/strategy_runtime/src/execution/brokers/broker-adapter-runtime.js';
import { SubmissionGate } from '../../apps/strategy_runtime/src/execution/order-lifecycle-state-machine.js';

const TICKET = 'QFA-612-BROKER-04-RECONCILIATION-RECOVERY-SMOKE-01';
const DETERMINATION_PASS = 'BROKER_RECONCILIATION_RECOVERY_SMOKE_PASSED_MOCK_GUARDS';
const DETERMINATION_FAIL = 'BROKER_RECONCILIATION_RECOVERY_SMOKE_FAILED_MOCK_GUARDS';
const REPO_ROOT = process.cwd();
const ARTIFACT_DIR = path.join(REPO_ROOT, 'artifacts', 'broker', 'qfa-612-broker-04-reconciliation-recovery-smoke-01');
const BOUNDED_JSONL = path.join(ARTIFACT_DIR, 'bounded-broker-reconciliation-recovery-smoke.jsonl');
const REPORT_JSON = path.join(ARTIFACT_DIR, 'broker-reconciliation-recovery-smoke-report.json');
const REPORT_MD = path.join(ARTIFACT_DIR, 'broker-reconciliation-recovery-smoke-report.md');
const MEMO_PATH = path.join(REPO_ROOT, 'docs', 'research', 'qfa-612-broker-04-reconciliation-recovery-smoke-01.md');
const BACKLOG_PATH = path.join(REPO_ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');
const RUN_ID = makeRunId('run-qfa-612-broker-04-reconciliation-recovery-smoke-01');
const SESSION_ID = makeSessionId('session-qfa-612-broker-04-reconciliation-recovery-smoke-01');
const BASE_TS_NS = 1781510400000000000n;
const SUBSTRATE = 'origin/main@4052473e9333a147b48b75a380d1cbbc2b760478';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface ScenarioResult {
  readonly name: string;
  readonly passed: boolean;
  readonly details: Record<string, Json>;
  readonly event_counts: Record<string, number>;
}

class ScriptedRecoveryAdapter implements BrokerAdapter {
  readonly plant_scope = 'ORDER_PLANT' as const;
  readonly mode = 'paper' as const;
  readonly ackHandlers = new Set<(event: BrokerAckEnvelope) => void>();
  readonly sessionHandlers = new Set<(event: BrokerSessionEvent) => void>();
  submittedIntentCount = 0;
  cancelRequestCount = 0;
  private ackSequence = 0;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async submitIntent(intent: OrderIntentEventEnvelope): Promise<{ readonly accepted: boolean; readonly broker_intent_correlation_id: string }> {
    this.submittedIntentCount += 1;
    this.emitSubmissionAck(intent, {
      broker_order_id: `BROKER-${String(intent.event_id)}`,
      broker_account_id: 'RITHMIC_TEST_ACCOUNT_HASHED_IN_REPORT',
    });
    return { accepted: true, broker_intent_correlation_id: `corr-${String(intent.event_id)}` };
  }

  async requestCancel(request: BrokerCancelRequest): Promise<{ readonly accepted: boolean }> {
    this.cancelRequestCount += 1;
    this.ackSequence += 1;
    this.ackHandlers.forEach((handler) => handler({
      type: 'ORDER_ACK_CANCEL',
      ts_ns: timestamp(this.ackSequence),
      broker_intent_correlation_id: `corr-${String(request.intent_id)}`,
      payload: {
        intent_id: request.intent_id,
        submission_ack_id: request.submission_ack_id,
        cancel_ack_id: makeEventId(`cancel-${request.intent_id}`),
        broker_order_id: request.broker_order_id ?? 'BROKER_UNKNOWN',
        broker_account_id: request.account_id ?? 'ACCOUNT_UNKNOWN',
        cancel_reason: 'CLIENT_REQUESTED',
      },
    }));
    return { accepted: true };
  }

  subscribeAckEvents(handler: (event: BrokerAckEnvelope) => void): () => void {
    this.ackHandlers.add(handler);
    return () => this.ackHandlers.delete(handler);
  }

  subscribeSessionEvents(handler: (event: BrokerSessionEvent) => void): () => void {
    this.sessionHandlers.add(handler);
    return () => this.sessionHandlers.delete(handler);
  }

  emitSubmissionAck(
    intent: OrderIntentEventEnvelope,
    lineage: { readonly broker_order_id: string; readonly broker_account_id: string },
  ): void {
    this.ackSequence += 1;
    this.ackHandlers.forEach((handler) => handler({
      type: 'ORDER_ACK_SUBMISSION',
      ts_ns: timestamp(this.ackSequence),
      broker_intent_correlation_id: `corr-${String(intent.event_id)}`,
      payload: {
        intent_id: intent.event_id,
        submission_ack_id: makeEventId(`submission-${intent.event_id}`),
        broker_order_id: lineage.broker_order_id,
        broker_account_id: lineage.broker_account_id,
        instrument_symbol: 'MNQM6',
      },
    }));
  }

  emitReconnectState(state: BrokerReconnectState): void {
    this.ackSequence += 1;
    this.sessionHandlers.forEach((handler) => handler({
      type: 'RECONNECT_STATE',
      ts_ns: timestamp(this.ackSequence),
      payload: {
        previous_state: state === 'CONNECTED' ? 'RECONNECTING' : 'CONNECTED',
        state,
        phase: state === 'CONNECTED' ? 'success' : 'attempt',
        max_attempts: 3,
        retry_budget_config: DEFAULT_BROKER_RECONNECT_POLICY_CONFIG,
        terminal: state === 'FAILED',
        blocked_submission_gate: state !== 'CONNECTED',
      },
    }));
  }
}

function timestamp(offset: number): UnixNs {
  return ns(BASE_TS_NS + BigInt(offset));
}

function localTimestampSource(): () => UnixNs {
  let offset = 10_000n;
  return () => ns(BASE_TS_NS + offset++);
}

function runtimeFor(adapter: ScriptedRecoveryAdapter, gate: SubmissionGate, events: AnyJournalEventEnvelope[]): BrokerAdapterRuntimeIntegration {
  return new BrokerAdapterRuntimeIntegration({
    adapter,
    run_id: RUN_ID,
    session_id: SESSION_ID,
    submission_gate: gate,
    event_sink: (event) => events.push(event),
    capture_local_timestamp_ns: localTimestampSource(),
    ack_timeout_policy: { enabled: false },
  });
}

function makeIntent(label: string): OrderIntentEventEnvelope {
  return createJournalEventEnvelope({
    event_id: makeEventId(label),
    type: 'ORDER_INTENT',
    ts_ns: timestamp(0),
    run_id: RUN_ID,
    session_id: SESSION_ID,
    causation_id: makeCausationId(`sizing-${label}`),
    payload: {
      order_intent_id: makeOrderIntentId(`order-${label}`),
      candidate_id: makeCandidateId(`candidate-${label}`),
      sizing_decision_id: makeSizingDecisionId(`sizing-${label}`),
      account_id: 'RITHMIC_TEST_ACCOUNT_HASHED_IN_REPORT',
      instrument_symbol: 'MNQM6',
      exchange: 'CME',
      side: 'buy',
      order_type: 'limit',
      quantity: 1,
      limit_price: 1,
      time_in_force: 'day',
    },
  });
}

async function scenarioIdempotentRedispatch(): Promise<ScenarioResult> {
  const adapter = new ScriptedRecoveryAdapter();
  const gate = new SubmissionGate();
  const events: AnyJournalEventEnvelope[] = [];
  const runtime = runtimeFor(adapter, gate, events);
  await runtime.start();
  const intent = makeIntent('intent-idempotent-redispatch');
  const first = await runtime.handleOrderIntent(intent);
  const second = await runtime.handleOrderIntent(intent);
  await runtime.stop();
  const passed = first.accepted && second.accepted &&
    first.broker_intent_correlation_id === second.broker_intent_correlation_id &&
    adapter.submittedIntentCount === 1 &&
    countEvents(events).ORDER_ACK_SUBMISSION === 1;
  return {
    name: 'idempotent_redispatch',
    passed,
    details: {
      first_accepted: first.accepted,
      second_accepted: second.accepted,
      same_correlation_id: first.accepted && second.accepted ? first.broker_intent_correlation_id === second.broker_intent_correlation_id : false,
      adapter_submit_count: adapter.submittedIntentCount,
    },
    event_counts: countEvents(events),
  };
}

async function scenarioConflictingDuplicateAck(): Promise<ScenarioResult> {
  const adapter = new ScriptedRecoveryAdapter();
  const gate = new SubmissionGate();
  const events: AnyJournalEventEnvelope[] = [];
  const runtime = runtimeFor(adapter, gate, events);
  await runtime.start();
  const intent = makeIntent('intent-conflicting-duplicate-ack');
  await runtime.handleOrderIntent(intent);
  adapter.emitSubmissionAck(intent, {
    broker_order_id: 'BROKER-CONFLICT',
    broker_account_id: 'RITHMIC_TEST_ACCOUNT_HASHED_IN_REPORT',
  });
  const gateState = gate.acquire();
  await runtime.stop();
  const validatorIssue = events.find((event) => event.type === 'VALIDATOR_ISSUE');
  const issuePayload = validatorIssue?.payload as JournalEventPayloadFor<'VALIDATOR_ISSUE'> | undefined;
  const passed = gateState.allowed === false &&
    gateState.reason === 'broker_reconciliation_in_progress_active' &&
    issuePayload?.code === 'broker_duplicate_submission_ack_lineage_conflict';
  return {
    name: 'conflicting_duplicate_submission_ack',
    passed,
    details: {
      gate_allowed: gateState.allowed,
      gate_reason: gateState.allowed ? null : gateState.reason,
      validator_code: issuePayload?.code ?? null,
    },
    event_counts: countEvents(events),
  };
}

async function scenarioReconnectReleaseWithoutActiveOrder(): Promise<ScenarioResult> {
  const adapter = new ScriptedRecoveryAdapter();
  const gate = new SubmissionGate();
  const events: AnyJournalEventEnvelope[] = [];
  const runtime = runtimeFor(adapter, gate, events);
  await runtime.start();
  adapter.emitReconnectState('RECONNECTING');
  const blocked = gate.acquire();
  adapter.emitReconnectState('CONNECTED');
  const released = gate.acquire();
  await runtime.stop();
  const passed = blocked.allowed === false &&
    blocked.reason === 'broker_reconciliation_in_progress_active' &&
    released.allowed === true;
  return {
    name: 'reconnect_release_without_active_order',
    passed,
    details: {
      blocked_allowed: blocked.allowed,
      blocked_reason: blocked.allowed ? null : blocked.reason,
      released_allowed: released.allowed,
    },
    event_counts: countEvents(events),
  };
}

async function scenarioReconnectKeepsBlockedWithActiveOrder(): Promise<ScenarioResult> {
  const adapter = new ScriptedRecoveryAdapter();
  const gate = new SubmissionGate();
  const events: AnyJournalEventEnvelope[] = [];
  const runtime = runtimeFor(adapter, gate, events);
  await runtime.start();
  const intent = makeIntent('intent-active-reconnect');
  await runtime.handleOrderIntent(intent);
  adapter.emitReconnectState('RECONNECTING');
  adapter.emitReconnectState('CONNECTED');
  const activeGate = gate.acquire();
  const cancelResult = await runtime.requestCancel({
    intent_id: intent.event_id,
    submission_ack_id: makeEventId(`submission-${intent.event_id}`),
  });
  adapter.emitReconnectState('CONNECTED');
  const releasedGate = gate.acquire();
  await runtime.stop();
  const passed = activeGate.allowed === false &&
    activeGate.reason === 'broker_reconciliation_in_progress_active' &&
    cancelResult.accepted === true &&
    releasedGate.allowed === true &&
    countEvents(events).ORDER_ACK_CANCEL === 1;
  return {
    name: 'reconnect_keeps_blocked_with_active_order_then_releases_after_cancel',
    passed,
    details: {
      active_gate_allowed: activeGate.allowed,
      active_gate_reason: activeGate.allowed ? null : activeGate.reason,
      cancel_accepted: cancelResult.accepted,
      released_gate_allowed_after_cancel: releasedGate.allowed,
    },
    event_counts: countEvents(events),
  };
}

async function main(): Promise<void> {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  mkdirSync(path.dirname(MEMO_PATH), { recursive: true });

  const scenarios = [
    await scenarioIdempotentRedispatch(),
    await scenarioConflictingDuplicateAck(),
    await scenarioReconnectReleaseWithoutActiveOrder(),
    await scenarioReconnectKeepsBlockedWithActiveOrder(),
  ];
  const pass = scenarios.every((scenario) => scenario.passed);
  const determination = pass ? DETERMINATION_PASS : DETERMINATION_FAIL;

  const boundedRecords = [
    { record_type: 'RUN_MANIFEST', ticket: TICKET, determination, substrate: SUBSTRATE },
    ...scenarios.map((scenario) => ({ record_type: 'SCENARIO_RESULT', ...scenario })),
    {
      record_type: 'AUTHORITY_LOCKS',
      broker_network_action_run: false,
      order_plant_submit_cancel_run: false,
      production_account_used: false,
      live_trading_authority_created: false,
      phase_6_authority_created: false,
      roster_mutated: false,
      marketable_order_authority: false,
      fill_target: false,
      automatic_shutdown_flattening: false,
      net_position_exposure_created: false,
    },
  ];
  const boundedJsonl = boundedRecords.map((record) => stableJson(record)).join('\n') + '\n';
  writeFileSync(BOUNDED_JSONL, boundedJsonl, 'utf8');

  const report = {
    ticket: TICKET,
    determination,
    worktree: REPO_ROOT,
    substrate: SUBSTRATE,
    scope: 'MOCK_BROKER_RUNTIME_RECONCILIATION_RECOVERY_SMOKE_NO_NETWORK',
    scenarios,
    success_criteria: {
      idempotent_redispatch_submit_count: 1,
      duplicate_ack_conflict_blocks_submission_gate: true,
      reconnect_without_active_order_releases_gate: true,
      reconnect_with_active_order_keeps_gate_blocked_until_cancel: true,
    },
    authority_locks: boundedRecords.at(-1),
    output_hashes: {
      bounded_jsonl_lf_sha256: sha256Lf(boundedJsonl),
    },
  };
  const reportJson = stableJson(report) + '\n';
  writeFileSync(REPORT_JSON, reportJson, 'utf8');
  const reportMd = markdownReport(report, boundedJsonl, reportJson);
  writeFileSync(REPORT_MD, reportMd, 'utf8');
  const memoText = memo(report, boundedJsonl, reportJson, reportMd);
  writeFileSync(MEMO_PATH, memoText, 'utf8');
  updateBacklog();

  console.log(JSON.stringify({
    state: 'PENDING_REVIEW',
    ticket: TICKET,
    determination,
    scenarios: scenarios.map((scenario) => ({ name: scenario.name, passed: scenario.passed })),
    bounded_jsonl_lf_sha256: sha256Lf(boundedJsonl),
    report_json_lf_sha256: sha256Lf(reportJson),
    report_md_lf_sha256: sha256Lf(reportMd),
    memo_lf_sha256: sha256Lf(memoText),
  }, null, 2));
}

function markdownReport(report: Record<string, unknown>, boundedJsonl: string, reportJson: string): string {
  const scenarios = report.scenarios as readonly ScenarioResult[];
  const rows = scenarios.map((scenario) =>
    `| ${scenario.name} | ${scenario.passed ? 'PASS' : 'FAIL'} | ${stableJson(scenario.details)} |`,
  ).join('\n');
  return `# ${TICKET}\n\n` +
    `## Determination\n\n\`\`\`text\n${String(report.determination)}\n\`\`\`\n\n` +
    `## Scenario results\n\n| Scenario | Result | Details |\n|---|---|---|\n${rows}\n\n` +
    `## Boundary\n\nThis smoke uses a scripted mock BrokerAdapter only. It does not run ORDER_PLANT, Rithmic, broker network, submit/cancel, production account, live authority, Phase 6 authority, or roster mutation.\n\n` +
    `## Output hashes\n\n\`\`\`text\nbounded_jsonl_lf_sha256 = ${sha256Lf(boundedJsonl)}\nreport_json_lf_sha256 = ${sha256Lf(reportJson)}\n\`\`\`\n`;
}

function memo(report: Record<string, unknown>, boundedJsonl: string, reportJson: string, reportMd: string): string {
  return `# ${TICKET}\n\n` +
    `STATE: PENDING-REVIEW\n\n` +
    `Determination:\n\n\`\`\`text\n${String(report.determination)}\n\`\`\`\n\n` +
    `Implemented a bounded mock broker-runtime recovery smoke proving idempotent redispatch, conflicting duplicate submission ACK fail-closed behavior, reconnect submission-gate blocking, and reconnect gate release after no active broker intent remains.\n\n` +
    `Authority boundary preserved: no ORDER_PLANT submit/cancel, no broker/network action, no production account, no live broker authority, no Phase 6 authority, no roster mutation, no marketable order authority, no fill target, and no net position exposure.\n\n` +
    `Output hashes:\n\n\`\`\`text\nbounded_jsonl_lf_sha256 = ${sha256Lf(boundedJsonl)}\nreport_json_lf_sha256 = ${sha256Lf(reportJson)}\nreport_md_lf_sha256 = ${sha256Lf(reportMd)}\n\`\`\`\n\n` +
    `Recommended next ticket:\n\n\`\`\`text\nQFA-612-PAPER-TRADING-START-RTH-2026-06-15-SCOPE-01\n\`\`\`\n`;
}

function updateBacklog(): void {
  const row = 'QFA-612-BROKER-04-RECONCILIATION-RECOVERY-SMOKE-01,P1,0.5,QFA-612-BROKER-04-RECONCILIATION-RECOVERY-IMPL-01,Run bounded mock broker runtime reconciliation recovery smoke for idempotent redispatch duplicate ACK conflict reconnect gate block release behavior while preserving no broker network live Phase 6 roster or production authority,broker_order_plant_lifecycle';
  const existing = existsSync(BACKLOG_PATH) ? readFileSync(BACKLOG_PATH, 'utf8') : '';
  if (existing.includes('QFA-612-BROKER-04-RECONCILIATION-RECOVERY-SMOKE-01')) return;
  const next = existing.endsWith('\n') || existing.length === 0 ? existing + row + '\n' : existing + '\n' + row + '\n';
  writeFileSync(BACKLOG_PATH, next, 'utf8');
}

function countEvents(events: readonly AnyJournalEventEnvelope[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
      result[key] = sortJson(entry);
    }
    return result;
  }
  return value;
}

function sha256Lf(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
