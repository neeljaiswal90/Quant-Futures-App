import { describe, expect, it } from 'vitest';
import {
  applyConsoleDelta,
  applyConsoleStreamFrame,
  createUnavailableSnapshot,
  isConsoleStreamFrame,
} from '../src/lib/console-state.js';
import {
  parseConsoleStreamMessage,
  reconnectDelayMs,
} from '../src/hooks/useLiveDeltas.js';
import type { ConsoleDelta, ConsoleStreamFrame } from '../../server/src/types/delta.js';

describe('operator console live-state helpers', () => {
  it('applies aggregate deltas without raw journal envelope state', () => {
    const snapshot = createUnavailableSnapshot('test fixture');
    const delta: ConsoleDelta = {
      kind: 'trade',
      row: {
        event_id: 'fill-1',
        type: 'SIM_FILL',
        ts_ns: '1700000000000000100',
        summary: 'SIM_FILL fill-1',
      },
    };

    const next = applyConsoleDelta(snapshot, delta);

    expect(next.trades.rows).toHaveLength(1);
    expect(next.trades.rows[0]?.event_id).toBe('fill-1');
    expect(JSON.stringify(next)).not.toContain('"payload"');
    expect(JSON.stringify(next)).not.toContain('"event"');
  });

  it('updates stream sequence state and detects base-sequence gaps', () => {
    const snapshot = createUnavailableSnapshot('test fixture');
    const frame: ConsoleStreamFrame = {
      kind: 'delta',
      seq: '2',
      base_seq: '1',
      last_event_id: 'alert-1',
      delta: {
        kind: 'alert',
        alert: {
          id: 'alert-1',
          severity: 'warning',
          message: 'fixture warning',
          event_id: 'alert-1',
        },
      },
    };

    const applied = applyConsoleStreamFrame(snapshot, '1', frame);
    expect(applied.last_seq).toBe('2');
    expect(applied.resync_required).toBe(false);
    expect(applied.snapshot.alerts).toHaveLength(1);

    const gap = applyConsoleStreamFrame(snapshot, '9', frame);
    expect(gap.last_seq).toBe('9');
    expect(gap.resync_required).toBe(true);
    expect(gap.snapshot.alerts).toHaveLength(0);
  });

  it('recognizes stream frame wrappers only', () => {
    expect(isConsoleStreamFrame({ kind: 'snapshot', seq: '1', snapshot: {} })).toBe(true);
    expect(isConsoleStreamFrame({ type: 'SIM_FILL', payload: {} })).toBe(false);
    expect(isConsoleStreamFrame(null)).toBe(false);
  });

  it('caps WebSocket reconnect backoff', () => {
    expect(reconnectDelayMs(0, 250, 1_000)).toBe(250);
    expect(reconnectDelayMs(1, 250, 1_000)).toBe(500);
    expect(reconnectDelayMs(2, 250, 1_000)).toBe(1_000);
    expect(reconnectDelayMs(8, 250, 1_000)).toBe(1_000);
  });

  it('parses text stream frames and rejects binary payloads', () => {
    const frame: ConsoleStreamFrame = {
      kind: 'resync_required',
      seq: '3',
      reason: 'backpressure',
    };

    expect(parseConsoleStreamMessage(JSON.stringify(frame))).toEqual(frame);
    expect(() => parseConsoleStreamMessage(new ArrayBuffer(8))).toThrow('binary stream frames are unsupported');
  });
});
