import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { InstrumentEventBus } from '../../src/orchestration/instrument-event-bus.js';
import {
  isRunnerShutdownAckMessage,
  isRunnerShutdownRequestMessage,
  requestGracefulShutdown,
} from '../../src/orchestration/runner-ipc.js';

class MockChild extends EventEmitter {
  connected = true;
  pid = 1234;
  public killed = false;

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    setTimeout(() => {
      this.emit('message', { type: 'shutdownAck', reason: (message as { reason: string }).reason });
      callback?.(null);
    }, 0);
    return true;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe('Runner IPC and event bus', () => {
  it('recognizes shutdown request and ack messages', () => {
    expect(isRunnerShutdownRequestMessage({ type: 'shutdown', reason: 'test' })).toBe(true);
    expect(isRunnerShutdownAckMessage({ type: 'shutdownAck', reason: 'test' })).toBe(true);
  });

  it('requests graceful shutdown and resolves on ack', async () => {
    const child = new MockChild();
    const outcome = await requestGracefulShutdown(
      child as unknown as Parameters<typeof requestGracefulShutdown>[0],
      'unit-test',
      { timeoutMs: 100 },
    );
    expect(outcome).toBe('acknowledged');
    expect(child.killed).toBe(false);
  });

  it('broadcasts instrument events to type listeners and all-listeners', () => {
    const bus = new InstrumentEventBus();
    let typed = 0;
    let any = 0;
    bus.on('signal_generated', () => { typed += 1; });
    bus.onAll(() => { any += 1; });
    bus.emit({
      type: 'signal_generated',
      instrument_id: 'MNQ',
      signal_id: 'S-1',
      direction: 'long',
      confidence: 8.2,
      verdict: 'accepted',
      timestamp: new Date().toISOString(),
    });
    expect(typed).toBe(1);
    expect(any).toBe(1);
  });
});
