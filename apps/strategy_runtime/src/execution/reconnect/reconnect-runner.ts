import {
  ns,
  type JournalEventPayloadFor,
  type UnixNs,
} from '../../contracts/index.js';
import type { SubmissionGate } from '../order-lifecycle-state-machine.js';

export const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
export const RECONNECT_MAX_ATTEMPTS = 5;
export const RECONNECT_MAX_DELAY_MS = 30_000;
export const RECONNECT_JITTER_MAX_MS = 1_000;
export const RECONNECT_ATTEMPT_TIMEOUT_MS = 11_000;

// Worst-case reconnect budget is intentionally explicit for operators:
// five 11s attempt timeouts (55s) + capped exponential backoff
// (1s + 2s + 4s + 8s + 16s = 31s) + max jitter (5 * 1s = 5s) ~= 91s.
export const RECONNECT_WORST_CASE_MS =
  RECONNECT_MAX_ATTEMPTS * RECONNECT_ATTEMPT_TIMEOUT_MS +
  RECONNECT_BACKOFF_MS.reduce((sum, value) => sum + value, 0) +
  RECONNECT_MAX_ATTEMPTS * RECONNECT_JITTER_MAX_MS;

export interface ReconnectAttemptInput {
  readonly attempt: number;
  readonly max_attempts: number;
}

export interface ReconnectAttemptResult {
  readonly connected: boolean;
  readonly broker_session_id?: string;
  readonly reason?: string;
  readonly manifest_overrides?: Partial<JournalEventPayloadFor<'SESSION_MANIFEST'>>;
}

export interface ReconnectRunnerOptions {
  readonly submission_gate: Pick<SubmissionGate, 'requestBlock' | 'releaseBlock'>;
  readonly reconnect: (input: ReconnectAttemptInput) => Promise<ReconnectAttemptResult>;
  readonly manifest_payload: JournalEventPayloadFor<'SESSION_MANIFEST'> | (() => JournalEventPayloadFor<'SESSION_MANIFEST'>);
  readonly emit?: (event: ReconnectRunnerEvent) => void;
  readonly now_ms?: () => number;
  readonly now_ns?: () => UnixNs;
  readonly jitter_seed?: string;
  readonly attempt_timeout_ms?: number;
}

export type ReconnectRunnerEvent =
  | {
      readonly type: 'RECONNECT_STATE';
      readonly ts_ns: UnixNs;
      readonly payload: JournalEventPayloadFor<'RECONNECT_STATE'>;
    }
  | {
      readonly type: 'SESSION_MANIFEST';
      readonly ts_ns: UnixNs;
      readonly payload: JournalEventPayloadFor<'SESSION_MANIFEST'>;
    };

export type ReconnectRunnerResult =
  | {
      readonly status: 'reconnected';
      readonly attempt: number;
    }
  | {
      readonly status: 'exhausted';
      readonly attempts: number;
    };

export class ReconnectRunner {
  private readonly submissionGate: Pick<SubmissionGate, 'requestBlock' | 'releaseBlock'>;
  private readonly reconnectAttempt: (input: ReconnectAttemptInput) => Promise<ReconnectAttemptResult>;
  private readonly manifestPayload: JournalEventPayloadFor<'SESSION_MANIFEST'> | (() => JournalEventPayloadFor<'SESSION_MANIFEST'>);
  private readonly emitEvent: (event: ReconnectRunnerEvent) => void;
  private readonly nowMs: () => number;
  private readonly nowNs: () => UnixNs;
  private readonly jitter: SeededReconnectJitter;
  private readonly attemptTimeoutMs: number;
  private running = false;

  constructor(options: ReconnectRunnerOptions) {
    this.submissionGate = options.submission_gate;
    this.reconnectAttempt = options.reconnect;
    this.manifestPayload = options.manifest_payload;
    this.emitEvent = options.emit ?? (() => undefined);
    this.nowMs = options.now_ms ?? (() => Date.now());
    this.nowNs = options.now_ns ?? (() => ns(BigInt(this.nowMs()) * 1_000_000n));
    this.jitter = new SeededReconnectJitter(options.jitter_seed ?? 'qfa-616-reconnect');
    this.attemptTimeoutMs = options.attempt_timeout_ms ?? RECONNECT_ATTEMPT_TIMEOUT_MS;
  }

  async handleDisconnect(reason = 'broker_disconnect'): Promise<ReconnectRunnerResult> {
    if (this.running) {
      return { status: 'exhausted', attempts: 0 };
    }
    this.running = true;
    this.submissionGate.requestBlock('reconnect_in_progress');
    this.emitReconnectState({
      previous_state: 'CONNECTED',
      state: 'DISCONNECTED',
      phase: 'disconnect',
      attempt: 0,
      reason,
      blocked_submission_gate: true,
    });

    for (let attempt = 1; attempt <= RECONNECT_MAX_ATTEMPTS; attempt += 1) {
      this.emitReconnectState({
        previous_state: attempt === 1 ? 'DISCONNECTED' : 'RECONNECTING',
        state: 'RECONNECTING',
        phase: 'attempt',
        attempt,
        blocked_submission_gate: true,
      });

      const result = await this.withAttemptTimeout({ attempt, max_attempts: RECONNECT_MAX_ATTEMPTS });
      if (result.connected) {
        this.emitReconnectState({
          previous_state: 'RECONNECTING',
          state: 'CONNECTED',
          phase: 'success',
          attempt,
          reason: result.reason,
          blocked_submission_gate: false,
        });
        this.emitSessionManifest('reconnect_success', result);
        this.submissionGate.releaseBlock('reconnect_in_progress');
        this.running = false;
        return { status: 'reconnected', attempt };
      }

      const backoffMs = reconnectDelayForAttempt(attempt, this.jitter.nextJitterMs());
      this.emitReconnectState({
        previous_state: 'RECONNECTING',
        state: 'RECONNECTING',
        phase: 'backoff',
        attempt,
        backoff_ms: RECONNECT_BACKOFF_MS[attempt - 1],
        jitter_ms: backoffMs - RECONNECT_BACKOFF_MS[attempt - 1]!,
        next_attempt_delay_ms: backoffMs,
        reason: result.reason ?? 'attempt_failed',
        blocked_submission_gate: true,
      });
      await sleep(backoffMs);
    }

    this.emitReconnectState({
      previous_state: 'RECONNECTING',
      state: 'FAILED',
      phase: 'exhausted',
      attempt: RECONNECT_MAX_ATTEMPTS,
      reason: 'retry_budget_exhausted',
      terminal: true,
      blocked_submission_gate: true,
    });
    this.emitSessionManifest('reconnect_exhausted', {
      connected: false,
      reason: 'retry_budget_exhausted',
    });
    this.running = false;
    return { status: 'exhausted', attempts: RECONNECT_MAX_ATTEMPTS };
  }

  private async withAttemptTimeout(input: ReconnectAttemptInput): Promise<ReconnectAttemptResult> {
    if (this.attemptTimeoutMs <= 0) {
      return this.reconnectAttempt(input);
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.reconnectAttempt(input),
        new Promise<ReconnectAttemptResult>((resolve) => {
          timeout = setTimeout(() => {
            resolve({
              connected: false,
              reason: 'attempt_timeout',
            });
          }, this.attemptTimeoutMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  private emitReconnectState(
    payload: Omit<
      JournalEventPayloadFor<'RECONNECT_STATE'>,
      'max_attempts' | 'retry_budget_config'
    >,
  ): void {
    const tsNs = this.nowNs();
    this.emitEvent({
      type: 'RECONNECT_STATE',
      ts_ns: tsNs,
      payload: {
        ...payload,
        max_attempts: RECONNECT_MAX_ATTEMPTS,
        retry_budget_config: reconnectRetryBudgetConfig(),
      },
    });
  }

  private emitSessionManifest(
    sessionPhase: 'reconnect_success' | 'reconnect_exhausted',
    result: ReconnectAttemptResult,
  ): void {
    const base = typeof this.manifestPayload === 'function'
      ? this.manifestPayload()
      : this.manifestPayload;
    const tsNs = this.nowNs();
    this.emitEvent({
      type: 'SESSION_MANIFEST',
      ts_ns: tsNs,
      payload: {
        ...base,
        ...(result.manifest_overrides ?? {}),
        ...(result.broker_session_id === undefined ? {} : { broker_session_id: result.broker_session_id }),
        reconnect_policy_config: {
          ...base.reconnect_policy_config,
          ...reconnectRetryBudgetConfig(),
        },
        session_phase: sessionPhase,
      },
    });
  }
}

export function reconnectDelayForAttempt(attempt: number, jitterMs = 0): number {
  const base = RECONNECT_BACKOFF_MS[Math.max(0, Math.min(attempt - 1, RECONNECT_BACKOFF_MS.length - 1))]!;
  const boundedJitter = Math.max(0, Math.min(RECONNECT_JITTER_MAX_MS, Math.trunc(jitterMs)));
  return Math.min(RECONNECT_MAX_DELAY_MS, base + boundedJitter);
}

export function reconnectRetryBudgetConfig(): JournalEventPayloadFor<'RECONNECT_STATE'>['retry_budget_config'] {
  return {
    max_attempts: RECONNECT_MAX_ATTEMPTS,
    backoff_ms: RECONNECT_BACKOFF_MS.join(','),
    max_delay_ms: RECONNECT_MAX_DELAY_MS,
    jitter_max_ms: RECONNECT_JITTER_MAX_MS,
    attempt_timeout_ms: RECONNECT_ATTEMPT_TIMEOUT_MS,
    worst_case_ms: RECONNECT_WORST_CASE_MS,
  };
}

export class SeededReconnectJitter {
  private state: number;

  constructor(seed: string) {
    this.state = hashSeed(seed);
  }

  nextJitterMs(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) % (RECONNECT_JITTER_MAX_MS + 1);
  }
}

function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
