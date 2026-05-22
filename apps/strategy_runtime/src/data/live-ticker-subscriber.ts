import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EOL } from 'node:os';
import {
  createJournalEventEnvelope,
  makeCorrelationId,
  makeEventId,
  ns,
  reviveTimestampNsFields,
  type AnyJournalEventEnvelope,
  type JournalEventPayloadFor,
  type RunId,
  type SessionId,
  type UnixNs,
} from '../contracts/index.js';
import { SubmissionGate } from '../execution/order-lifecycle-state-machine.js';
import {
  TICKER_IPC_SCHEMA_VERSION,
  validateTickerIpcEnvelope,
  type TickerIpcEnvelope,
  type TickerIpcFailurePayload,
} from './ticker-ipc-contract.js';

const DEFAULT_BOOT_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;
const ADAPTER_VERSION = 'qfa-633-live-ticker-ts-subscriber';

export interface LiveTickerSubscriptionConfig {
  readonly symbol: string;
  readonly exchange: string;
}

export interface LiveTickerSubscriberOptions {
  readonly run_id: RunId;
  readonly session_id: SessionId;
  readonly subscriptions?: readonly LiveTickerSubscriptionConfig[];
  readonly event_sink: (event: AnyJournalEventEnvelope) => void | Promise<void>;
  readonly submission_gate?: SubmissionGate;
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly credentials_env?: Readonly<Record<string, string | undefined>>;
  readonly boot_timeout_ms?: number;
  readonly shutdown_timeout_ms?: number;
  readonly heartbeat_timeout_ms?: number;
  readonly now_ns?: () => UnixNs;
}

export class LiveTickerSubscriber {
  private readonly runId: RunId;
  private readonly sessionId: SessionId;
  private readonly subscriptions: readonly LiveTickerSubscriptionConfig[];
  private readonly eventSink: (event: AnyJournalEventEnvelope) => void | Promise<void>;
  private readonly submissionGate?: SubmissionGate;
  private readonly executable: string;
  private readonly args: readonly string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly bootTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly nowNs: () => UnixNs;
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = '';
  private bootResolver?: { readonly resolve: () => void; readonly reject: (error: Error) => void };
  private shutdownResolver?: { readonly resolve: () => void; readonly reject: (error: Error) => void };
  private bootTimer?: ReturnType<typeof setTimeout>;
  private shutdownTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private running = false;
  private sequence = 0;

  constructor(options: LiveTickerSubscriberOptions) {
    this.runId = options.run_id;
    this.sessionId = options.session_id;
    this.subscriptions = options.subscriptions ?? [{ symbol: 'MNQM6', exchange: 'CME' }];
    this.eventSink = options.event_sink;
    this.submissionGate = options.submission_gate;
    this.executable = options.executable ?? 'python';
    this.args = options.args ?? ['-m', 'ticker_session_sidecar'];
    this.env = {
      ...process.env,
      ...(options.env ?? {}),
      ...(options.credentials_env ?? {}),
      QFA_RUN_ID: String(this.runId),
      QFA_SESSION_ID: String(this.sessionId),
      QFA_TICKER_SYMBOL: this.subscriptions[0]?.symbol ?? 'MNQM6',
      QFA_TICKER_EXCHANGE: this.subscriptions[0]?.exchange ?? 'CME',
    };
    this.bootTimeoutMs = options.boot_timeout_ms ?? DEFAULT_BOOT_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdown_timeout_ms ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.heartbeatTimeoutMs = options.heartbeat_timeout_ms ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.nowNs = options.now_ns ?? (() => ns(BigInt(Date.now()) * 1_000_000n));
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.stopping = false;
    this.child = spawn(this.executable, [...this.args], {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.handleStdoutChunk(chunk));
    this.child.stderr.on('data', (chunk: string) => {
      if (chunk.trim() !== '') {
        this.emitValidatorIssue('ticker_sidecar_stderr', chunk.trim(), { stream: 'stderr' });
      }
    });
    this.child.on('exit', (code, signal) => this.handleExit(code, signal));
    this.child.on('error', (error) => this.failBoot(error));

    await new Promise<void>((resolve, reject) => {
      this.bootResolver = { resolve, reject };
      this.bootTimer = setTimeout(() => {
        this.failBoot(new Error('live ticker sidecar boot_identity timeout'));
      }, this.bootTimeoutMs);
      this.bootTimer.unref?.();
    });
  }

  async stop(): Promise<void> {
    if (this.child === undefined) return;
    this.stopping = true;
    this.clearHeartbeatTimer();
    this.writeCommand('shutdown', { reason: 'client_stop' }, 'shutdown');
    await new Promise<void>((resolve) => {
      this.shutdownResolver = { resolve, reject: () => resolve() };
      this.shutdownTimer = setTimeout(() => {
        this.child?.kill('SIGTERM');
        setTimeout(() => this.child?.kill('SIGKILL'), this.shutdownTimeoutMs).unref?.();
        resolve();
      }, this.shutdownTimeoutMs);
      this.shutdownTimer.unref?.();
    });
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line !== '') this.handleStdoutLine(line);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleStdoutLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = reviveTimestampNsFields(JSON.parse(line));
    } catch (error) {
      this.emitValidatorIssue('ticker_ipc_malformed_json', messageFrom(error));
      return;
    }
    const validation = validateTickerIpcEnvelope(parsed);
    if (!validation.ok || validation.envelope === undefined) {
      const schemaVersion = schemaVersionOf(parsed);
      const messageType = messageTypeOf(parsed);
      this.emitValidatorIssue(
        schemaVersion !== TICKER_IPC_SCHEMA_VERSION
          ? 'ticker_ipc_schema_version_mismatch'
          : 'ticker_ipc_schema_invalid',
        `ticker sidecar stdout message failed TICKER IPC validation: ${validation.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join('; ')}`,
      );
      if (messageType === 'boot_identity' && schemaVersion !== TICKER_IPC_SCHEMA_VERSION) {
        this.failBoot(new Error('ticker sidecar IPC schema version mismatch'));
      }
      return;
    }
    this.markActivity();
    this.dispatchMessage(validation.envelope);
  }

  private dispatchMessage(message: TickerIpcEnvelope): void {
    switch (message.message_type) {
      case 'boot_identity':
        this.handleBootIdentity();
        return;
      case 'shutdown_complete':
        this.shutdownResolver?.resolve();
        this.child?.kill('SIGTERM');
        return;
      case 'subscription_accepted':
      case 'subscription_snapshot':
      case 'heartbeat_pong':
      case 'recovered':
        return;
      case 'tick_quote':
        this.emitQuote(message);
        return;
      case 'tick_trade':
        this.emitTrade(message);
        return;
      case 'tick_book_rebuild':
        this.emitBookRebuild(message);
        return;
      case 'subscription_rejected':
      case 'broker_error':
      case 'connection_lost': {
        const failure = failurePayload(message);
        this.emitValidatorIssue(failure.failure_state, failure.reason, failureDetails(failure));
        if (message.message_type === 'connection_lost' || failure.failure_state === 'sidecar_unavailable') {
          this.markSidecarUnavailable(failure.reason, failure);
        }
        return;
      }
      default:
        this.emitValidatorIssue('ticker_ipc_unhandled_message', `Unhandled ticker IPC message: ${String(message.message_type)}`);
    }
  }

  private handleBootIdentity(): void {
    this.running = true;
    if (this.bootTimer !== undefined) {
      clearTimeout(this.bootTimer);
      this.bootTimer = undefined;
    }
    this.bootResolver?.resolve();
    this.bootResolver = undefined;
    for (const subscription of this.subscriptions.slice(1)) {
      this.writeCommand('subscribe_symbol', { ...subscription }, `subscribe-${subscription.symbol}-${subscription.exchange}`);
    }
  }

  private emitQuote(message: TickerIpcEnvelope): void {
    const payload = message.payload as Record<string, unknown>;
    this.emitEvent(createJournalEventEnvelope({
      event_id: makeEventId(`live-ticker-quote-${++this.sequence}`),
      type: 'QUOTE',
      ts_ns: ns(message.event_ts_ns),
      run_id: this.runId,
      session_id: this.sessionId,
      correlation_id: makeCorrelationId(message.correlation_id),
      payload: {
        exchange_event_ts_ns: ns(payload.tick_ts_ns as string | bigint | number),
        sidecar_recv_ts_ns: ns(payload.sidecar_recv_ts_ns as string | bigint | number),
        ...(payload.rithmic_publish_ts_ns === undefined ? {} : { rithmic_publish_ts_ns: ns(payload.rithmic_publish_ts_ns as string | bigint | number) }),
        bid_px: numberField(payload.bid_px),
        bid_qty: numberField(payload.bid_qty),
        ask_px: numberField(payload.ask_px),
        ask_qty: numberField(payload.ask_qty),
        authority: 'authoritative' as const,
      },
    }) as AnyJournalEventEnvelope);
  }

  private emitTrade(message: TickerIpcEnvelope): void {
    const payload = message.payload as Record<string, unknown>;
    const aggressor = payload.aggressor_side === 'buy' || payload.aggressor_side === 'sell'
      ? payload.aggressor_side
      : 'unknown';
    this.emitEvent(createJournalEventEnvelope({
      event_id: makeEventId(`live-ticker-trade-${++this.sequence}`),
      type: 'TRADE',
      ts_ns: ns(message.event_ts_ns),
      run_id: this.runId,
      session_id: this.sessionId,
      correlation_id: makeCorrelationId(message.correlation_id),
      payload: {
        exchange_event_ts_ns: ns(payload.tick_ts_ns as string | bigint | number),
        sidecar_recv_ts_ns: ns(payload.sidecar_recv_ts_ns as string | bigint | number),
        ...(payload.rithmic_publish_ts_ns === undefined ? {} : { rithmic_publish_ts_ns: ns(payload.rithmic_publish_ts_ns as string | bigint | number) }),
        ...(payload.trade_id === undefined ? {} : { trade_id: String(payload.trade_id) }),
        price: numberField(payload.price),
        quantity: numberField(payload.quantity),
        aggressor_side: aggressor as 'buy' | 'sell' | 'unknown',
      },
    }) as AnyJournalEventEnvelope);
  }

  private emitBookRebuild(message: TickerIpcEnvelope): void {
    const payload = message.payload as Record<string, unknown>;
    this.emitEvent(createJournalEventEnvelope({
      event_id: makeEventId(`live-ticker-book-rebuild-${++this.sequence}`),
      type: 'BOOK_REBUILD',
      ts_ns: ns(message.event_ts_ns),
      run_id: this.runId,
      session_id: this.sessionId,
      correlation_id: makeCorrelationId(message.correlation_id),
      payload: {
        exchange_event_ts_ns: ns(payload.tick_ts_ns as string | bigint | number),
        sidecar_recv_ts_ns: ns(payload.sidecar_recv_ts_ns as string | bigint | number),
        authority: 'authoritative' as const,
        reason: 'ticker_sidecar_book_rebuild',
        warmup_complete: true,
      },
    }) as AnyJournalEventEnvelope);
  }

  private writeCommand(messageType: string, payload: Record<string, unknown>, correlationId: string): void {
    this.child?.stdin.write(`${JSON.stringify({
      schema_version: TICKER_IPC_SCHEMA_VERSION,
      message_type: messageType,
      direction: 'command',
      run_id: String(this.runId),
      session_id: String(this.sessionId),
      correlation_id: correlationId,
      causation_id: correlationId,
      event_ts_ns: this.nowNs().toString(),
      adapter_version: ADAPTER_VERSION,
      payload,
    }, stringifyBigint)}\n`);
  }

  private emitEvent(event: AnyJournalEventEnvelope): void {
    void Promise.resolve(this.eventSink(event)).catch((error) => {
      this.emitValidatorIssue('ticker_event_sink_failed', messageFrom(error));
    });
  }

  private emitValidatorIssue(
    code: string,
    message: string,
    details: JournalEventPayloadFor<'VALIDATOR_ISSUE'>['details'] = {},
  ): void {
    this.emitEvent(createJournalEventEnvelope({
      event_id: makeEventId(`live-ticker-validator-issue-${++this.sequence}`),
      type: 'VALIDATOR_ISSUE',
      ts_ns: this.nowNs(),
      run_id: this.runId,
      session_id: this.sessionId,
      payload: {
        validator_id: 'EXEC-VALIDATOR-08' as const,
        severity: code === 'sidecar_unavailable' ? 'fatal' as const : 'error' as const,
        emitted_ts_ns: this.nowNs(),
        code,
        message,
        details,
      },
    }) as AnyJournalEventEnvelope);
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

  private markSidecarUnavailable(reason: string, failure?: TickerIpcFailurePayload): void {
    if (this.stopping) return;
    this.submissionGate?.requestBlock('broker_reconciliation_in_progress');
    if (failure === undefined) {
      this.emitValidatorIssue('sidecar_unavailable', `ticker sidecar unavailable: ${reason}`, { reason });
    }
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
    if (!wasStopping) this.markSidecarUnavailable(`exit:${code ?? signal ?? 'unknown'}`);
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
}

function failurePayload(message: TickerIpcEnvelope): TickerIpcFailurePayload {
  const payload = message.payload as Partial<TickerIpcFailurePayload>;
  return {
    failure_state: payload.failure_state ?? 'broker_disconnected',
    reason: payload.reason ?? 'ticker sidecar failure',
    recoverable: payload.recoverable ?? true,
    ...(payload.rp_code === undefined ? {} : { rp_code: payload.rp_code }),
    ...(payload.rp_message_redacted === undefined ? {} : { rp_message_redacted: payload.rp_message_redacted }),
    ...(payload.correlated_command_idempotency_key === undefined
      ? {}
      : { correlated_command_idempotency_key: payload.correlated_command_idempotency_key }),
  };
}

function failureDetails(payload: TickerIpcFailurePayload): JournalEventPayloadFor<'VALIDATOR_ISSUE'>['details'] {
  return {
    failure_state: payload.failure_state,
    recoverable: payload.recoverable,
    ...(payload.rp_code === undefined ? {} : { rp_code: payload.rp_code }),
    ...(payload.rp_message_redacted === undefined ? {} : { rp_message_redacted: payload.rp_message_redacted }),
    ...(payload.correlated_command_idempotency_key === undefined
      ? {}
      : { correlated_command_idempotency_key: payload.correlated_command_idempotency_key }),
  };
}

function schemaVersionOf(value: unknown): number | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as { schema_version?: number }).schema_version
    : undefined;
}

function messageTypeOf(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as { message_type?: string }).message_type
    : undefined;
}

function numberField(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringifyBigint(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function messageFrom(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error).split(EOL).join(' ');
}
