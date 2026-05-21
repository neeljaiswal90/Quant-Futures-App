import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { buildExecutionCapabilityMask } from '../execution-capability-mask.js';
import { SubmissionGate } from '../order-lifecycle-state-machine.js';
import {
  makeEventId,
  ns,
  reviveTimestampNsFields,
  type EventId,
  type JournalEventPayloadFor,
  type UnixNs,
} from '../../contracts/index.js';
import {
  DEFAULT_BROKER_RECONNECT_POLICY_CONFIG,
  type BrokerAckEnvelope,
  type BrokerAdapter,
  type BrokerCancelRequest,
  type BrokerReconnectPolicyConfig,
  type BrokerSessionEvent,
  type OrderIntentEventEnvelope,
  type PlantScope,
  type RuntimeMode,
  type Unsubscribe,
} from './broker-adapter.js';
import {
  BROKER_IPC_SCHEMA_VERSION,
  validateBrokerIpcEnvelope,
  type BrokerIpcEnvelope,
  type BrokerIpcFailurePayload,
} from './broker-ipc-contract.js';

const DEFAULT_BOOT_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;
const NS_PER_MS = 1_000_000n;
const ADAPTER_VERSION = 'qfa-612-broker-02-ts-adapter';

export interface PythonBrokerAdapterOptions {
  readonly mode?: RuntimeMode;
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly credentials_env?: Readonly<Record<string, string | undefined>>;
  readonly boot_timeout_ms?: number;
  readonly shutdown_timeout_ms?: number;
  readonly heartbeat_timeout_ms?: number;
  readonly reconnect_policy_config?: BrokerReconnectPolicyConfig;
  readonly submission_gate?: SubmissionGate;
  readonly now_ns?: () => UnixNs;
}

type PendingCommandKind = 'submit' | 'cancel';

interface PendingCommand {
  readonly kind: PendingCommandKind;
  readonly idempotency_key: string;
  readonly resolve: (result: { readonly accepted: boolean; readonly broker_intent_correlation_id?: string }) => void;
  readonly reject: (error: Error) => void;
}

export class PythonBrokerAdapter implements BrokerAdapter {
  readonly plant_scope: PlantScope = 'ORDER_PLANT';
  readonly mode: RuntimeMode;

  private readonly executable: string;
  private readonly args: readonly string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly bootTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly reconnectPolicyConfig: BrokerReconnectPolicyConfig;
  private readonly submissionGate?: SubmissionGate;
  private readonly nowNs: () => UnixNs;
  private readonly ackHandlers = new Set<(event: BrokerAckEnvelope) => void>();
  private readonly sessionHandlers = new Set<(event: BrokerSessionEvent) => void>();
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = '';
  private bootResolver?: { readonly resolve: () => void; readonly reject: (error: Error) => void };
  private shutdownResolver?: { readonly resolve: () => void; readonly reject: (error: Error) => void };
  private bootTimer?: ReturnType<typeof setTimeout>;
  private shutdownTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private running = false;
  private stopping = false;
  private brokerSessionId = 'python-broker-session-pending';
  private commandSequence = 0;

  constructor(options: PythonBrokerAdapterOptions = {}) {
    this.mode = options.mode ?? 'paper';
    this.executable = options.executable ?? 'python';
    this.args = options.args ?? ['-m', 'broker_session_sidecar'];
    this.env = {
      ...process.env,
      ...options.env,
      ...options.credentials_env,
    };
    this.bootTimeoutMs = positiveMs(options.boot_timeout_ms, DEFAULT_BOOT_TIMEOUT_MS, 'boot_timeout_ms');
    this.shutdownTimeoutMs = positiveMs(
      options.shutdown_timeout_ms,
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
      'shutdown_timeout_ms',
    );
    this.heartbeatTimeoutMs = positiveMs(
      options.heartbeat_timeout_ms,
      DEFAULT_HEARTBEAT_TIMEOUT_MS,
      'heartbeat_timeout_ms',
    );
    this.reconnectPolicyConfig =
      options.reconnect_policy_config ?? DEFAULT_BROKER_RECONNECT_POLICY_CONFIG;
    this.submissionGate = options.submission_gate;
    this.nowNs = options.now_ns ?? (() => ns(BigInt(Date.now()) * NS_PER_MS));
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    if (this.child !== undefined) {
      throw new Error('PythonBrokerAdapter sidecar process already exists');
    }

    this.child = spawn(this.executable, [...this.args], {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.handleStdoutChunk(chunk));
    this.child.stdout.on('close', () => this.markSidecarUnavailable('stdout_closed'));
    this.child.stderr.on('data', () => undefined);
    this.child.once('exit', (code, signal) => this.handleExit(code, signal));
    this.child.once('error', (error) => this.failBoot(error));

    await new Promise<void>((resolve, reject) => {
      this.bootResolver = { resolve, reject };
      this.bootTimer = setTimeout(() => {
        this.bootTimer = undefined;
        this.failBoot(new Error('Python broker sidecar boot_identity timeout'));
      }, this.bootTimeoutMs);
      this.bootTimer.unref?.();
    });
  }

  async stop(): Promise<void> {
    if (this.child === undefined) {
      this.running = false;
      return;
    }

    this.stopping = true;
    this.clearHeartbeatTimer();
    this.writeCommand(this.commandEnvelope('shutdown', this.nextCorrelationId('shutdown'), {}, undefined));

    await new Promise<void>((resolve, reject) => {
      this.shutdownResolver = { resolve, reject };
      this.shutdownTimer = setTimeout(() => {
        this.shutdownTimer = undefined;
        this.child?.kill('SIGTERM');
        const killTimer = setTimeout(() => this.child?.kill('SIGKILL'), this.shutdownTimeoutMs);
        killTimer.unref?.();
      }, this.shutdownTimeoutMs);
      this.shutdownTimer.unref?.();
    });
  }

  async submitIntent(
    intent: OrderIntentEventEnvelope,
  ): Promise<{ readonly accepted: boolean; readonly broker_intent_correlation_id: string }> {
    this.requireRunning();
    const correlationId = this.nextCorrelationId('submit');
    const idempotencyKey = String(intent.event_id);
    this.writeCommand(this.commandEnvelope('submit_order', correlationId, { intent }, idempotencyKey));
    const result = await this.awaitCommandResult(correlationId, 'submit', idempotencyKey);
    return {
      accepted: result.accepted,
      broker_intent_correlation_id: correlationId,
    };
  }

  async requestCancel(request: BrokerCancelRequest): Promise<{ readonly accepted: boolean }> {
    this.requireRunning();
    const correlationId = this.nextCorrelationId('cancel');
    const idempotencyKey = `${request.intent_id}:${request.submission_ack_id}`;
    this.writeCommand(this.commandEnvelope('cancel_order', correlationId, { request }, idempotencyKey));
    const result = await this.awaitCommandResult(correlationId, 'cancel', idempotencyKey);
    return { accepted: result.accepted };
  }

  subscribeAckEvents(handler: (event: BrokerAckEnvelope) => void): Unsubscribe {
    this.ackHandlers.add(handler);
    return () => {
      this.ackHandlers.delete(handler);
    };
  }

  subscribeSessionEvents(handler: (event: BrokerSessionEvent) => void): Unsubscribe {
    this.sessionHandlers.add(handler);
    return () => {
      this.sessionHandlers.delete(handler);
    };
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (newlineIndex < 0) {
        return;
      }
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line !== '') {
        this.handleStdoutLine(line);
      }
    }
  }

  private handleStdoutLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = reviveTimestampNsFields(JSON.parse(line));
    } catch (error) {
      this.emitValidatorIssue('broker_ipc_malformed_json', messageFrom(error));
      return;
    }

    const validation = validateBrokerIpcEnvelope(parsed);
    if (!validation.ok || validation.envelope === undefined) {
      const messageType = messageTypeOf(parsed);
      const schemaVersion = schemaVersionOf(parsed);
      this.emitValidatorIssue(
        schemaVersion !== BROKER_IPC_SCHEMA_VERSION
          ? 'broker_ipc_schema_version_mismatch'
          : 'broker_ipc_schema_invalid',
        `sidecar stdout message failed BROKER-00 IPC validation: ${validation.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join('; ')}`,
      );
      if (messageType === 'boot_identity' && schemaVersion !== BROKER_IPC_SCHEMA_VERSION) {
        this.failBoot(new Error('Python broker sidecar IPC schema version mismatch'));
      }
      return;
    }

    this.markActivity();
    this.dispatchMessage(validation.envelope);
  }

  private dispatchMessage(message: BrokerIpcEnvelope): void {
    switch (message.message_type) {
      case 'boot_identity':
        this.handleBootIdentity(message);
        return;
      case 'shutdown_complete':
        this.shutdownResolver?.resolve();
        this.child?.kill('SIGTERM');
        return;
      case 'order_accepted':
      case 'order_acknowledged': {
        const payload = orderAcceptedPayload(message);
        this.emitAck({
          type: 'ORDER_ACK_SUBMISSION',
          ts_ns: ns(message.event_ts_ns),
          payload: {
            intent_id: payload.intent_id,
            submission_ack_id:
              payload.submission_ack_id ?? makeEventId(`python-submission-ack-${message.correlation_id}`),
            broker_order_id: payload.broker_order_id,
            broker_account_id: payload.broker_account_id,
            instrument_symbol: payload.instrument_symbol,
          },
          broker_intent_correlation_id: message.correlation_id,
        });
        this.resolvePending(message.correlation_id, { accepted: true });
        return;
      }
      case 'order_partially_filled':
      case 'order_filled': {
        const payload = orderFillPayload(message);
        this.emitAck({
          type: 'ORDER_ACK_FILL',
          ts_ns: ns(message.event_ts_ns),
          payload: {
            intent_id: payload.intent_id,
            submission_ack_id: payload.submission_ack_id,
            fill_ack_id:
              payload.fill_ack_id ?? makeEventId(`python-fill-ack-${message.correlation_id}`),
            broker_order_id: payload.broker_order_id,
            broker_account_id: payload.broker_account_id,
            instrument_symbol: payload.instrument_symbol,
            fill_qty: payload.fill_qty,
            fill_price: payload.fill_price,
            fill_kind: message.message_type === 'order_filled' ? 'FULL' : 'PARTIAL',
          },
          broker_intent_correlation_id: message.correlation_id,
        });
        return;
      }
      case 'order_cancelled': {
        const payload = orderCancelledPayload(message);
        this.emitAck({
          type: 'ORDER_ACK_CANCEL',
          ts_ns: ns(message.event_ts_ns),
          payload: {
            intent_id: payload.intent_id,
            submission_ack_id: payload.submission_ack_id,
            cancel_ack_id:
              payload.cancel_ack_id ?? makeEventId(`python-cancel-ack-${message.correlation_id}`),
            broker_order_id: payload.broker_order_id,
            broker_account_id: payload.broker_account_id,
            cancel_reason: payload.cancel_reason ?? 'CLIENT_REQUESTED',
          },
          broker_intent_correlation_id: message.correlation_id,
        });
        this.resolvePending(message.correlation_id, { accepted: true });
        return;
      }
      case 'order_rejected': {
        const payload = orderRejectedPayload(message);
        const failure = failurePayload(message);
        this.emitValidatorIssue(failure.failure_state, failure.reason, failureDetails(failure));
        this.emitAck({
          type: 'ORDER_BROKER_REJECT',
          ts_ns: ns(message.event_ts_ns),
          payload: {
            intent_id: payload.intent_id,
            ...(payload.broker_order_id === undefined ? {} : { broker_order_id: payload.broker_order_id }),
            broker_account_id: payload.broker_account_id,
            reject_reason_code: failure.rp_code ?? failure.failure_state,
            reject_subreason: failure.failure_state,
            reject_message_redacted: failure.rp_message_redacted ?? failure.reason,
          },
          broker_intent_correlation_id: message.correlation_id,
        });
        this.resolvePending(message.correlation_id, { accepted: false });
        return;
      }
      case 'broker_error':
      case 'connection_lost':
      case 'cancel_rejected': {
        const failure = failurePayload(message);
        if (failure.failure_state === 'sidecar_unavailable') {
          this.markSidecarUnavailable(failure.reason, failure);
          return;
        }
        if (failure.failure_state === 'order_path_not_yet_implemented') {
          this.emitValidatorIssue(failure.failure_state, failure.reason, failureDetails(failure));
          this.resolvePending(message.correlation_id, { accepted: false });
          return;
        }
        this.emitValidatorIssue(
          failure.rp_code ?? failure.failure_state,
          failure.reason,
          failureDetails(failure),
        );
        this.resolvePending(message.correlation_id, { accepted: false });
        return;
      }
      case 'heartbeat_pong':
      case 'recovered':
      case 'cancel_pending':
      case 'position_snapshot':
      case 'reconciliation_snapshot':
        return;
      default:
        throw new Error(`Unhandled broker IPC message: ${String(message.message_type)}`);
    }
  }

  private handleBootIdentity(message: BrokerIpcEnvelope): void {
    const payload = bootIdentityPayload(message);
    this.brokerSessionId = message.session_id;
    this.running = true;
    if (this.bootTimer !== undefined) {
      clearTimeout(this.bootTimer);
      this.bootTimer = undefined;
    }
    const mask = buildExecutionCapabilityMask();
    this.emitSession({
      type: 'SESSION_MANIFEST',
      ts_ns: ns(payload.boot_ts_ns),
      payload: {
        mask_id: mask.mask_id,
        mask_version: mask.mask_version,
        mask_hash: mask.mask_hash,
        reconnect_policy_config: this.reconnectPolicyConfig,
        plant_scope: 'ORDER_PLANT',
        mode: this.mode,
        timestamp_anchor: 'broker_exchange_ts_ns',
        broker_session_id: message.session_id,
        adapter_kind: 'PYTHON_RITHMIC_ORDER_PLANT',
      },
    });
    this.markActivity();
    this.bootResolver?.resolve();
    this.bootResolver = undefined;
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasStopping = this.stopping;
    this.running = false;
    this.child = undefined;
    this.clearHeartbeatTimer();
    if (this.shutdownTimer !== undefined) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = undefined;
    }
    this.shutdownResolver?.resolve();
    this.shutdownResolver = undefined;
    if (!wasStopping) {
      this.markSidecarUnavailable(`exit:${code ?? signal ?? 'unknown'}`);
    }
    for (const [correlationId, pending] of this.pendingCommands.entries()) {
      pending.reject(new Error(`Python broker sidecar exited before ${pending.kind} completed`));
      this.pendingCommands.delete(correlationId);
    }
  }

  private markSidecarUnavailable(reason: string, failure?: BrokerIpcFailurePayload): void {
    if (this.stopping) {
      return;
    }
    const payload = failure ?? {
      failure_state: 'sidecar_unavailable',
      reason: `Python broker sidecar unavailable: ${reason}`,
      recoverable: false,
    } satisfies BrokerIpcFailurePayload;
    this.submissionGate?.requestBlock('broker_reconciliation_in_progress');
    this.emitValidatorIssue(
      payload.failure_state,
      payload.reason,
      failureDetails(payload),
    );
    for (const [correlationId, pending] of this.pendingCommands.entries()) {
      pending.resolve({ accepted: false });
      this.pendingCommands.delete(correlationId);
    }
  }

  private markActivity(): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = undefined;
      this.markSidecarUnavailable('heartbeat_timeout');
    }, this.heartbeatTimeoutMs);
    this.heartbeatTimer.unref?.();
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer !== undefined) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private awaitCommandResult(correlationId: string, kind: PendingCommandKind, idempotencyKey: string): Promise<{
    readonly accepted: boolean;
    readonly broker_intent_correlation_id?: string;
  }> {
    return new Promise((resolve, reject) => {
      this.pendingCommands.set(correlationId, { kind, idempotency_key: idempotencyKey, resolve, reject });
    });
  }

  private resolvePending(
    correlationId: string | undefined,
    result: { readonly accepted: boolean; readonly broker_intent_correlation_id?: string },
  ): void {
    if (correlationId === undefined) {
      return;
    }
    const pending = this.pendingCommands.get(correlationId);
    if (pending === undefined) {
      return;
    }
    this.pendingCommands.delete(correlationId);
    pending.resolve(result);
  }

  private commandEnvelope(
    messageType: 'submit_order' | 'cancel_order' | 'shutdown',
    correlationId: string,
    payload: Readonly<Record<string, unknown>>,
    idempotencyKey: string | undefined,
  ): BrokerIpcEnvelope {
    return {
      schema_version: BROKER_IPC_SCHEMA_VERSION,
      message_type: messageType,
      direction: 'command',
      run_id: 'qfa-612-broker-02',
      session_id: this.brokerSessionId,
      correlation_id: correlationId,
      causation_id: correlationId,
      ...(idempotencyKey === undefined ? {} : { idempotency_key: idempotencyKey }),
      event_ts_ns: this.nowNs(),
      adapter_version: ADAPTER_VERSION,
      payload,
    };
  }

  private writeCommand(command: BrokerIpcEnvelope): void {
    this.child?.stdin.write(`${JSON.stringify(command, stringifyBigint)}\n`);
  }

  private emitAck(event: BrokerAckEnvelope): void {
    for (const handler of this.ackHandlers) {
      handler(event);
    }
  }

  private emitSession(event: BrokerSessionEvent): void {
    for (const handler of this.sessionHandlers) {
      handler(event);
    }
  }

  private emitValidatorIssue(
    code: string,
    message: string,
    details: JournalEventPayloadFor<'VALIDATOR_ISSUE'>['details'] = {},
  ): void {
    this.emitSession({
      type: 'VALIDATOR_ISSUE',
      ts_ns: this.nowNs(),
      payload: {
        validator_id: 'EXEC-VALIDATOR-08',
        severity: code === 'sidecar_unavailable' ? 'fatal' : 'error',
        emitted_ts_ns: this.nowNs(),
        code,
        message,
        session_family_id: this.brokerSessionId,
        details,
      },
    });
  }

  private failBoot(error: Error): void {
    if (this.bootTimer !== undefined) {
      clearTimeout(this.bootTimer);
      this.bootTimer = undefined;
    }
    this.bootResolver?.reject(error);
    this.bootResolver = undefined;
    this.child?.kill('SIGTERM');
  }

  private requireRunning(): void {
    if (!this.running || this.child === undefined) {
      throw new Error('PythonBrokerAdapter must be started before use');
    }
  }

  private nextCorrelationId(prefix: string): string {
    this.commandSequence += 1;
    return `python-broker-${prefix}-${this.commandSequence}`;
  }
}

function messageTypeOf(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>).message_type;
}

function schemaVersionOf(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>).schema_version;
}

function stringifyBigint(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function positiveMs(value: number | undefined, defaultValue: number, name: string): number {
  const resolved = value ?? defaultValue;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordPayload(message: BrokerIpcEnvelope): Record<string, unknown> {
  return message.payload !== null && typeof message.payload === 'object' && !Array.isArray(message.payload)
    ? message.payload as Record<string, unknown>
    : {};
}

function bootIdentityPayload(message: BrokerIpcEnvelope): {
  readonly boot_ts_ns: UnixNs | bigint | number | string;
} {
  const payload = recordPayload(message);
  return {
    boot_ts_ns: payload.boot_ts_ns as UnixNs | bigint | number | string,
  };
}

function orderAcceptedPayload(message: BrokerIpcEnvelope): {
  readonly intent_id: EventId;
  readonly submission_ack_id?: EventId;
  readonly broker_order_id: string;
  readonly broker_account_id: string;
  readonly instrument_symbol: string;
} {
  const payload = recordPayload(message);
  return {
    intent_id: payload.intent_id as EventId,
    submission_ack_id: payload.submission_ack_id as EventId | undefined,
    broker_order_id: String(payload.broker_order_id),
    broker_account_id: String(payload.broker_account_id),
    instrument_symbol: String(payload.instrument_symbol),
  };
}

function orderFillPayload(message: BrokerIpcEnvelope): {
  readonly intent_id: EventId;
  readonly submission_ack_id: EventId;
  readonly fill_ack_id?: EventId;
  readonly broker_order_id: string;
  readonly broker_account_id: string;
  readonly instrument_symbol: string;
  readonly fill_qty: number;
  readonly fill_price: number;
} {
  const payload = recordPayload(message);
  return {
    intent_id: payload.intent_id as EventId,
    submission_ack_id: payload.submission_ack_id as EventId,
    fill_ack_id: payload.fill_ack_id as EventId | undefined,
    broker_order_id: String(payload.broker_order_id),
    broker_account_id: String(payload.broker_account_id),
    instrument_symbol: String(payload.instrument_symbol),
    fill_qty: Number(payload.fill_qty),
    fill_price: Number(payload.fill_price),
  };
}

function orderCancelledPayload(message: BrokerIpcEnvelope): {
  readonly intent_id: EventId;
  readonly submission_ack_id: EventId;
  readonly cancel_ack_id?: EventId;
  readonly broker_order_id: string;
  readonly broker_account_id: string;
  readonly cancel_reason?: JournalEventPayloadFor<'ORDER_ACK_CANCEL'>['cancel_reason'];
} {
  const payload = recordPayload(message);
  return {
    intent_id: payload.intent_id as EventId,
    submission_ack_id: payload.submission_ack_id as EventId,
    cancel_ack_id: payload.cancel_ack_id as EventId | undefined,
    broker_order_id: String(payload.broker_order_id),
    broker_account_id: String(payload.broker_account_id),
    cancel_reason: payload.cancel_reason as JournalEventPayloadFor<'ORDER_ACK_CANCEL'>['cancel_reason'] | undefined,
  };
}

function orderRejectedPayload(message: BrokerIpcEnvelope): {
  readonly intent_id: EventId;
  readonly broker_order_id?: string;
  readonly broker_account_id: string;
} {
  const payload = recordPayload(message);
  return {
    intent_id: payload.intent_id as EventId,
    broker_order_id: payload.broker_order_id as string | undefined,
    broker_account_id: String(payload.broker_account_id),
  };
}

function failurePayload(message: BrokerIpcEnvelope): BrokerIpcFailurePayload {
  return recordPayload(message) as unknown as BrokerIpcFailurePayload;
}

function failureDetails(payload: BrokerIpcFailurePayload): JournalEventPayloadFor<'VALIDATOR_ISSUE'>['details'] {
  return {
    failure_state: payload.failure_state,
    reason: payload.reason,
    recoverable: payload.recoverable,
    ...(payload.rp_code === undefined ? {} : { rp_code: payload.rp_code }),
    ...(payload.rp_message_redacted === undefined ? {} : { rp_message_redacted: payload.rp_message_redacted }),
    ...(payload.correlated_command_idempotency_key === undefined
      ? {}
      : { correlated_command_idempotency_key: payload.correlated_command_idempotency_key }),
    ...(payload.qfa_broker_sidecar_ipc_ms === undefined
      ? {}
      : { qfa_broker_sidecar_ipc_ms: payload.qfa_broker_sidecar_ipc_ms }),
  };
}

function assertNeverMessage(message: never): never {
  throw new Error(`Unhandled broker IPC message: ${String(message)}`);
}
