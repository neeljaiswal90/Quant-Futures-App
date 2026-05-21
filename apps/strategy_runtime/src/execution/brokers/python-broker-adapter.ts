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

export const BROKER_IPC_SCHEMA_VERSION = 1;

const DEFAULT_BOOT_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;
const NS_PER_MS = 1_000_000n;

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
  readonly resolve: (result: { readonly accepted: boolean; readonly broker_intent_correlation_id?: string }) => void;
  readonly reject: (error: Error) => void;
}

// TODO(QFA-612-BROKER-00): replace these minimal IPC replicas with the shared BROKER-00 TS contract.
type BrokerIpcMessage =
  | BrokerIpcBootIdentity
  | BrokerIpcShutdownComplete
  | BrokerIpcOrderPathNotYetImplemented
  | BrokerIpcOrderAccepted
  | BrokerIpcOrderFill
  | BrokerIpcOrderCancelled
  | BrokerIpcOrderRejected
  | BrokerIpcBrokerError
  | BrokerIpcHeartbeat;

interface BrokerIpcBase {
  readonly schema_version: number;
  readonly message_type: string;
  readonly correlation_id?: string;
  readonly event_ts_ns?: UnixNs;
}

interface BrokerIpcBootIdentity extends BrokerIpcBase {
  readonly message_type: 'boot_identity';
  readonly boot_ts_ns: UnixNs;
  readonly broker_session_id: string;
}

interface BrokerIpcShutdownComplete extends BrokerIpcBase {
  readonly message_type: 'shutdown_complete';
}

interface BrokerIpcOrderPathNotYetImplemented extends BrokerIpcBase {
  readonly message_type: 'order_path_not_yet_implemented';
  readonly reason?: string;
}

interface BrokerIpcOrderAccepted extends BrokerIpcBase {
  readonly message_type: 'order_accepted';
  readonly intent_id: EventId;
  readonly submission_ack_id?: EventId;
  readonly broker_order_id: string;
  readonly broker_account_id: string;
  readonly instrument_symbol: string;
}

interface BrokerIpcOrderFill extends BrokerIpcBase {
  readonly message_type: 'order_partially_filled' | 'order_filled';
  readonly intent_id: EventId;
  readonly submission_ack_id: EventId;
  readonly fill_ack_id?: EventId;
  readonly broker_order_id: string;
  readonly broker_account_id: string;
  readonly instrument_symbol: string;
  readonly fill_qty: number;
  readonly fill_price: number;
}

interface BrokerIpcOrderCancelled extends BrokerIpcBase {
  readonly message_type: 'order_cancelled';
  readonly intent_id: EventId;
  readonly submission_ack_id: EventId;
  readonly cancel_ack_id?: EventId;
  readonly broker_order_id: string;
  readonly broker_account_id: string;
  readonly cancel_reason?: JournalEventPayloadFor<'ORDER_ACK_CANCEL'>['cancel_reason'];
}

interface BrokerIpcOrderRejected extends BrokerIpcBase {
  readonly message_type: 'order_rejected';
  readonly intent_id: EventId;
  readonly broker_order_id?: string;
  readonly broker_account_id: string;
  readonly reject_reason_code: string;
  readonly reject_subreason?: string;
  readonly reject_message_redacted?: string;
}

interface BrokerIpcBrokerError extends BrokerIpcBase {
  readonly message_type: 'broker_error';
  readonly failure_state?: string;
  readonly code?: string;
  readonly message?: string;
}

interface BrokerIpcHeartbeat extends BrokerIpcBase {
  readonly message_type: 'heartbeat';
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
    this.writeCommand({
      schema_version: BROKER_IPC_SCHEMA_VERSION,
      message_type: 'shutdown',
      correlation_id: this.nextCorrelationId('shutdown'),
    });

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
    this.writeCommand({
      schema_version: BROKER_IPC_SCHEMA_VERSION,
      message_type: 'submit_intent',
      correlation_id: correlationId,
      idempotency_key: String(intent.event_id),
      intent,
    });
    const result = await this.awaitCommandResult(correlationId, 'submit');
    return {
      accepted: result.accepted,
      broker_intent_correlation_id: correlationId,
    };
  }

  async requestCancel(request: BrokerCancelRequest): Promise<{ readonly accepted: boolean }> {
    this.requireRunning();
    const correlationId = this.nextCorrelationId('cancel');
    this.writeCommand({
      schema_version: BROKER_IPC_SCHEMA_VERSION,
      message_type: 'request_cancel',
      correlation_id: correlationId,
      idempotency_key: `${request.intent_id}:${request.submission_ack_id}`,
      request,
    });
    const result = await this.awaitCommandResult(correlationId, 'cancel');
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

    if (!isBrokerIpcMessage(parsed)) {
      this.emitValidatorIssue('broker_ipc_schema_invalid', 'sidecar stdout message failed minimal IPC validation');
      return;
    }

    this.markActivity();
    if (parsed.schema_version !== BROKER_IPC_SCHEMA_VERSION) {
      this.emitValidatorIssue(
        'broker_ipc_schema_version_mismatch',
        `expected ${BROKER_IPC_SCHEMA_VERSION}, received ${parsed.schema_version}`,
      );
      if (parsed.message_type === 'boot_identity') {
        this.failBoot(new Error('Python broker sidecar IPC schema version mismatch'));
      }
      return;
    }

    this.dispatchMessage(parsed);
  }

  private dispatchMessage(message: BrokerIpcMessage): void {
    switch (message.message_type) {
      case 'boot_identity':
        this.handleBootIdentity(message);
        return;
      case 'shutdown_complete':
        this.shutdownResolver?.resolve();
        this.child?.kill('SIGTERM');
        return;
      case 'order_path_not_yet_implemented':
        this.emitValidatorIssue(
          'order_path_not_yet_implemented',
          message.reason ?? 'Python broker sidecar order path is not implemented',
        );
        this.resolvePending(message.correlation_id, { accepted: false });
        return;
      case 'order_accepted':
        this.emitAck({
          type: 'ORDER_ACK_SUBMISSION',
          ts_ns: message.event_ts_ns ?? this.nowNs(),
          payload: {
            intent_id: message.intent_id,
            submission_ack_id:
              message.submission_ack_id ?? makeEventId(`python-submission-ack-${message.correlation_id ?? message.intent_id}`),
            broker_order_id: message.broker_order_id,
            broker_account_id: message.broker_account_id,
            instrument_symbol: message.instrument_symbol,
          },
          broker_intent_correlation_id: message.correlation_id,
        });
        this.resolvePending(message.correlation_id, { accepted: true });
        return;
      case 'order_partially_filled':
      case 'order_filled':
        this.emitAck({
          type: 'ORDER_ACK_FILL',
          ts_ns: message.event_ts_ns ?? this.nowNs(),
          payload: {
            intent_id: message.intent_id,
            submission_ack_id: message.submission_ack_id,
            fill_ack_id:
              message.fill_ack_id ?? makeEventId(`python-fill-ack-${message.correlation_id ?? message.intent_id}`),
            broker_order_id: message.broker_order_id,
            broker_account_id: message.broker_account_id,
            instrument_symbol: message.instrument_symbol,
            fill_qty: message.fill_qty,
            fill_price: message.fill_price,
            fill_kind: message.message_type === 'order_filled' ? 'FULL' : 'PARTIAL',
          },
          broker_intent_correlation_id: message.correlation_id,
        });
        return;
      case 'order_cancelled':
        this.emitAck({
          type: 'ORDER_ACK_CANCEL',
          ts_ns: message.event_ts_ns ?? this.nowNs(),
          payload: {
            intent_id: message.intent_id,
            submission_ack_id: message.submission_ack_id,
            cancel_ack_id:
              message.cancel_ack_id ?? makeEventId(`python-cancel-ack-${message.correlation_id ?? message.intent_id}`),
            broker_order_id: message.broker_order_id,
            broker_account_id: message.broker_account_id,
            cancel_reason: message.cancel_reason ?? 'CLIENT_REQUESTED',
          },
          broker_intent_correlation_id: message.correlation_id,
        });
        this.resolvePending(message.correlation_id, { accepted: true });
        return;
      case 'order_rejected':
        this.emitAck({
          type: 'ORDER_BROKER_REJECT',
          ts_ns: message.event_ts_ns ?? this.nowNs(),
          payload: {
            intent_id: message.intent_id,
            ...(message.broker_order_id === undefined ? {} : { broker_order_id: message.broker_order_id }),
            broker_account_id: message.broker_account_id,
            reject_reason_code: message.reject_reason_code,
            ...(message.reject_subreason === undefined ? {} : { reject_subreason: message.reject_subreason }),
            reject_message_redacted: message.reject_message_redacted ?? '[redacted]',
          },
          broker_intent_correlation_id: message.correlation_id,
        });
        this.resolvePending(message.correlation_id, { accepted: false });
        return;
      case 'broker_error':
        if (message.failure_state === 'sidecar_unavailable') {
          this.markSidecarUnavailable(message.code ?? 'broker_error');
          return;
        }
        this.emitValidatorIssue(
          message.code ?? 'broker_error',
          message.message ?? 'Python broker sidecar reported broker_error',
        );
        this.resolvePending(message.correlation_id, { accepted: false });
        return;
      case 'heartbeat':
        return;
      default:
        assertNeverMessage(message);
    }
  }

  private handleBootIdentity(message: BrokerIpcBootIdentity): void {
    this.brokerSessionId = message.broker_session_id;
    this.running = true;
    if (this.bootTimer !== undefined) {
      clearTimeout(this.bootTimer);
      this.bootTimer = undefined;
    }
    const mask = buildExecutionCapabilityMask();
    this.emitSession({
      type: 'SESSION_MANIFEST',
      ts_ns: message.boot_ts_ns,
      payload: {
        mask_id: mask.mask_id,
        mask_version: mask.mask_version,
        mask_hash: mask.mask_hash,
        reconnect_policy_config: this.reconnectPolicyConfig,
        plant_scope: 'ORDER_PLANT',
        mode: this.mode,
        timestamp_anchor: 'broker_exchange_ts_ns',
        broker_session_id: message.broker_session_id,
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

  private markSidecarUnavailable(reason: string): void {
    if (this.stopping) {
      return;
    }
    this.submissionGate?.requestBlock('broker_reconciliation_in_progress');
    this.emitValidatorIssue(
      'sidecar_unavailable',
      `Python broker sidecar unavailable: ${reason}`,
      { failure_state: 'sidecar_unavailable' },
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

  private awaitCommandResult(correlationId: string, kind: PendingCommandKind): Promise<{
    readonly accepted: boolean;
    readonly broker_intent_correlation_id?: string;
  }> {
    return new Promise((resolve, reject) => {
      this.pendingCommands.set(correlationId, { kind, resolve, reject });
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

  private writeCommand(command: Readonly<Record<string, unknown>>): void {
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

function isBrokerIpcMessage(value: unknown): value is BrokerIpcMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.schema_version === 'number' && typeof record.message_type === 'string';
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

function assertNeverMessage(message: never): never {
  throw new Error(`Unhandled broker IPC message: ${String(message)}`);
}
