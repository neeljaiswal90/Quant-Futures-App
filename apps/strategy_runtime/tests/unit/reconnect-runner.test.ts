import { describe, expect, it, vi } from 'vitest';
import { ns, type JournalEventPayloadFor } from '../../src/contracts/index.js';
import {
  RECONNECT_BACKOFF_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_WORST_CASE_MS,
  ReconnectRunner,
  reconnectDelayForAttempt,
  type ReconnectRunnerEvent,
} from '../../src/execution/reconnect/reconnect-runner.js';
import { SubmissionGate } from '../../src/execution/order-lifecycle-state-machine.js';

describe('ReconnectRunner', () => {
  it('blocks submission during reconnect and releases on success with manifest phase', async () => {
    vi.useFakeTimers();
    try {
      const gate = new SubmissionGate();
      const events: ReconnectRunnerEvent[] = [];
      const runner = new ReconnectRunner({
        submission_gate: gate,
        manifest_payload: manifestPayload(),
        attempt_timeout_ms: 0,
        jitter_seed: 'success-seed',
        now_ns: () => ns(1_800_000_000_000_000_000n),
        emit: (event) => events.push(event),
        reconnect: async ({ attempt }) => ({
          connected: attempt === 2,
          broker_session_id: 'reconnected-session',
        }),
      });

      const resultPromise = runner.handleDisconnect('fixture_disconnect');
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(resultPromise).resolves.toEqual({ status: 'reconnected', attempt: 2 });

      expect(gate.acquire()).toEqual({ allowed: true });
      expect(events.filter((event) => event.type === 'RECONNECT_STATE').map((event) => event.payload.phase)).toEqual([
        'disconnect',
        'attempt',
        'backoff',
        'attempt',
        'success',
      ]);
      expect(events.find((event) => event.type === 'SESSION_MANIFEST')).toMatchObject({
        payload: {
          broker_session_id: 'reconnected-session',
          session_phase: 'reconnect_success',
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps reconnect_in_progress blocked after retry exhaustion', async () => {
    vi.useFakeTimers();
    try {
      const gate = new SubmissionGate();
      const events: ReconnectRunnerEvent[] = [];
      const runner = new ReconnectRunner({
        submission_gate: gate,
        manifest_payload: manifestPayload(),
        attempt_timeout_ms: 0,
        jitter_seed: 'exhaustion-seed',
        emit: (event) => events.push(event),
        reconnect: async () => ({ connected: false, reason: 'still_down' }),
      });

      const resultPromise = runner.handleDisconnect();
      await vi.advanceTimersByTimeAsync(120_000);
      await expect(resultPromise).resolves.toEqual({
        status: 'exhausted',
        attempts: RECONNECT_MAX_ATTEMPTS,
      });

      expect(gate.acquire()).toMatchObject({
        allowed: false,
        reason: 'reconnect_in_progress_active',
        active_block_sources: ['reconnect_in_progress'],
      });
      expect(events.at(-2)).toMatchObject({
        type: 'RECONNECT_STATE',
        payload: {
          phase: 'exhausted',
          state: 'FAILED',
          terminal: true,
        },
      });
      expect(events.at(-1)).toMatchObject({
        type: 'SESSION_MANIFEST',
        payload: {
          session_phase: 'reconnect_exhausted',
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses deterministic seeded jitter bounded to 1000ms and documents the 91s budget', async () => {
    vi.useFakeTimers();
    try {
      const backoffsA = await exhaustedBackoffsForSeed('same-seed');
      const backoffsB = await exhaustedBackoffsForSeed('same-seed');

      expect(backoffsA).toEqual(backoffsB);
      expect(backoffsA).toHaveLength(RECONNECT_BACKOFF_MS.length);
      backoffsA.forEach((delay, index) => {
        expect(delay).toBeGreaterThanOrEqual(RECONNECT_BACKOFF_MS[index]!);
        expect(delay).toBeLessThanOrEqual(RECONNECT_BACKOFF_MS[index]! + 1_000);
      });
      expect(reconnectDelayForAttempt(99, 50_000)).toBe(17_000);
      expect(RECONNECT_WORST_CASE_MS).toBe(91_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

async function exhaustedBackoffsForSeed(seed: string): Promise<number[]> {
  const events: ReconnectRunnerEvent[] = [];
  const runner = new ReconnectRunner({
    submission_gate: new SubmissionGate(),
    manifest_payload: manifestPayload(),
    attempt_timeout_ms: 0,
    jitter_seed: seed,
    emit: (event) => events.push(event),
    reconnect: async () => ({ connected: false }),
  });
  const promise = runner.handleDisconnect();
  await vi.advanceTimersByTimeAsync(120_000);
  await promise;
  return events
    .filter((event): event is Extract<ReconnectRunnerEvent, { readonly type: 'RECONNECT_STATE' }> =>
      event.type === 'RECONNECT_STATE' && event.payload.phase === 'backoff')
    .map((event) => event.payload.next_attempt_delay_ms ?? 0);
}

function manifestPayload(): JournalEventPayloadFor<'SESSION_MANIFEST'> {
  return {
    mask_id: 'mask',
    mask_version: 1,
    mask_hash: 'hash',
    reconnect_policy_config: {},
    plant_scope: 'ORDER_PLANT',
    mode: 'paper',
    timestamp_anchor: 'dual',
    broker_session_id: 'session',
    adapter_kind: 'MOCK_ORDER_PLANT',
  };
}
