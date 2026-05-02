import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createOperatorConsoleRestServer, type ConsoleRestDataSource } from '../src/transport/rest.js';
import {
  attachOperatorConsoleWebSocketStream,
  type OperatorConsoleWebSocketStream,
} from '../src/transport/ws.js';
import { resolveServerConfigFromEnv, type OperatorConsoleServerConfig } from '../src/runtime/config.js';
import { CONSOLE_SNAPSHOT_SCHEMA_VERSION, type ConsoleSnapshot } from '../src/types/snapshot.js';

interface StartedServer {
  readonly server: Server;
  readonly stream: OperatorConsoleWebSocketStream;
  readonly base_url: string;
  readonly port: number;
}

const started: StartedServer[] = [];

describe('operator console WebSocket stream', () => {
  afterEach(async () => {
    await Promise.all(started.splice(0).map(async ({ server, stream }) => {
      stream.close();
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
    }));
  });

  it('sends a full snapshot on connect and immediate lifecycle/alert deltas with sequence metadata', async () => {
    const base = snapshot();
    const updated = snapshot({
      generated_from: {
        ...base.generated_from,
        last_event_id: 'fill-1',
        last_event_ts_ns: '1700000000000000100',
        event_count: 2,
      },
      trades: {
        rows: [{
          event_id: 'fill-1',
          type: 'SIM_FILL',
          ts_ns: '1700000000000000100',
          summary: 'SIM_FILL fill-1',
        }],
      },
      alerts: [{
        id: 'alert-1',
        severity: 'warning',
        message: 'lifecycle warning',
        event_id: 'fill-1',
      }],
    });
    const server = await startServer(sequenceDataSource([base, updated]), {
      poll_ms: 5,
      coalesce_ms: 100,
    });
    const { ws, inbox } = await openWebSocket(`${server.base_url.replace('http:', 'ws:')}/stream`);

    const first = await inbox.next('connect snapshot');
    expect(first.kind).toBe('snapshot');
    expect(first.seq).toBe('1');
    expect((first.snapshot as Record<string, unknown>).schema_version).toBe(1);

    const trade = await inbox.next('trade delta');
    expect(trade.kind).toBe('delta');
    expect(trade.seq).toBe('2');
    expect(trade.base_seq).toBe('1');
    expect(trade.last_event_id).toBe('fill-1');
    expect(((trade.delta as Record<string, unknown>).row as Record<string, unknown>).event_id).toBe('fill-1');

    const alert = await inbox.next('alert delta');
    expect(alert.kind).toBe('delta');
    expect(alert.seq).toBe('3');
    expect(alert.base_seq).toBe('2');
    expect((alert.delta as Record<string, unknown>).kind).toBe('alert');
    ws.close();
  });

  it('coalesces telemetry deltas at the configured cadence', async () => {
    const base = snapshot();
    const telemetryOne = snapshot({
      generated_from: {
        ...base.generated_from,
        last_event_id: 'quote-1',
        event_count: 1,
      },
      data_pipeline: {
        ...base.data_pipeline,
        source_event_count: 1,
        by_type: { QUOTE: 1 },
      },
    });
    const telemetryTwo = snapshot({
      generated_from: {
        ...base.generated_from,
        last_event_id: 'quote-2',
        event_count: 2,
      },
      data_pipeline: {
        ...base.data_pipeline,
        source_event_count: 2,
        by_type: { QUOTE: 2 },
      },
    });
    const server = await startServer(sequenceDataSource([base, telemetryOne, telemetryTwo]), {
      poll_ms: 5,
      coalesce_ms: 50,
    });
    const { ws, inbox } = await openWebSocket(`${server.base_url.replace('http:', 'ws:')}/stream`);

    expect((await inbox.next('connect snapshot')).kind).toBe('snapshot');
    const coalesced = await inbox.next('coalesced telemetry');
    expect(coalesced.kind).toBe('delta');
    expect(coalesced.seq).toBe('2');
    expect(coalesced.base_seq).toBe('1');
    expect(coalesced.last_event_id).toBe('quote-2');
    expect((coalesced.delta as Record<string, unknown>).kind).toBe('data_pipeline');
    expect(((coalesced.delta as Record<string, unknown>).patch as Record<string, unknown>).source_event_count)
      .toBe(2);
    ws.close();
  });

  it('enforces remote bearer auth and origin checks during upgrade', async () => {
    const config = resolveServerConfigFromEnv({
      QFA_CONSOLE_BIND: '0.0.0.0',
      OPERATOR_CONSOLE_ALLOW_REMOTE: 'true',
      OPERATOR_CONSOLE_AUTH_TOKEN: 'secret',
      OPERATOR_CONSOLE_ORIGIN_ALLOWLIST: 'https://ops.example',
    });
    const server = await startServer(sequenceDataSource([snapshot()]), {
      config,
      poll_ms: 20,
      coalesce_ms: 20,
    });

    await expect(rawWebSocketHandshake(server.port, {
      Origin: 'https://ops.example',
    })).resolves.toContain('HTTP/1.1 401 Unauthorized');

    await expect(rawWebSocketHandshake(server.port, {
      Authorization: 'Bearer secret',
      Origin: 'https://evil.example',
    })).resolves.toContain('HTTP/1.1 403 Forbidden');

    await expect(rawWebSocketHandshake(server.port, {
      Authorization: 'Bearer secret',
      Origin: 'https://ops.example',
    })).resolves.toContain('HTTP/1.1 101 Switching Protocols');
  });

  it('reports backpressure and sends resync_required when a critical delta cannot be preserved', async () => {
    const base = snapshot();
    const updated = snapshot({
      generated_from: {
        ...base.generated_from,
        last_event_id: 'fill-1',
        event_count: 1,
      },
      trades: {
        rows: [{
          event_id: 'fill-1',
          type: 'SIM_FILL',
          ts_ns: '1700000000000000100',
          summary: 'SIM_FILL fill-1',
        }],
      },
    });
    const server = await startServer(sequenceDataSource([base, updated]), {
      poll_ms: 5,
      coalesce_ms: 100,
      max_buffered_bytes: 1,
    });
    const { ws, inbox } = await openWebSocket(`${server.base_url.replace('http:', 'ws:')}/stream`);

    expect((await inbox.next('connect snapshot')).kind).toBe('snapshot');
    const resync = await inbox.next('resync frame');
    expect(resync.kind).toBe('resync_required');
    expect(resync.reason).toBe('backpressure');
    expect(server.stream.getHealth()).toMatchObject({
      ws_backpressure: true,
      dropped_critical_frame_count: 1,
    });
    ws.close();
  });
});

async function startServer(
  dataSource: ConsoleRestDataSource,
  options: {
    readonly config?: OperatorConsoleServerConfig;
    readonly poll_ms: number;
    readonly coalesce_ms: number;
    readonly max_buffered_bytes?: number;
  },
): Promise<StartedServer> {
  const config = options.config ?? resolveServerConfigFromEnv({});
  const server = createOperatorConsoleRestServer({ config, data_source: dataSource });
  const stream = attachOperatorConsoleWebSocketStream({
    server,
    config,
    data_source: dataSource,
    poll_ms: options.poll_ms,
    coalesce_ms: options.coalesce_ms,
    max_buffered_bytes: options.max_buffered_bytes,
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', resolveListen);
  });

  const address = server.address() as AddressInfo;
  const result = {
    server,
    stream,
    port: address.port,
    base_url: `http://127.0.0.1:${address.port}`,
  };
  started.push(result);
  return result;
}

function sequenceDataSource(snapshots: readonly ConsoleSnapshot[]): ConsoleRestDataSource {
  let index = 0;
  return {
    refresh: () => {
      const snapshotIndex = Math.min(index, snapshots.length - 1);
      index += 1;
      return snapshots[snapshotIndex]!;
    },
    history: () => {
      throw new Error('history is not used by WebSocket tests');
    },
  };
}

async function openWebSocket(url: string): Promise<{ readonly ws: WebSocket; readonly inbox: WebSocketInbox }> {
  const ws = new WebSocket(url);
  const inbox = new WebSocketInbox(ws);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    ws.addEventListener('open', () => resolveOpen(), { once: true });
    ws.addEventListener('error', () => rejectOpen(new Error('WebSocket failed to open')), { once: true });
  });
  return { ws, inbox };
}

class WebSocketInbox {
  private readonly queue: Record<string, unknown>[] = [];
  private readonly waiters: ((message: Record<string, unknown>) => void)[] = [];

  public constructor(ws: WebSocket) {
    ws.addEventListener('message', (message) => {
      void this.record(message);
    });
  }

  public async next(label: string): Promise<Record<string, unknown>> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return queued;
    }
    return await new Promise<Record<string, unknown>>((resolveMessage, rejectMessage) => {
      const timeout = setTimeout(() => {
        rejectMessage(new Error(`timed out waiting for ${label}`));
      }, 1_000);
      this.waiters.push((message) => {
        clearTimeout(timeout);
        resolveMessage(message);
      });
    });
  }

  private async record(event: MessageEvent): Promise<void> {
    const message = JSON.parse(await messageText(event.data)) as Record<string, unknown>;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(message);
      return;
    }
    this.queue.push(message);
  }
}

async function messageText(data: unknown): Promise<string> {
  if (typeof data === 'string') {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  if (data instanceof Blob) {
    return await data.text();
  }
  return String(data);
}

async function rawWebSocketHandshake(
  port: number,
  headers: Readonly<Record<string, string>>,
): Promise<string> {
  return await new Promise<string>((resolveHandshake, rejectHandshake) => {
    const socket = connect({ host: '127.0.0.1', port });
    let response = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      rejectHandshake(new Error('timed out waiting for WebSocket handshake'));
    }, 1_000);

    socket.on('connect', () => {
      const key = randomBytes(16).toString('base64');
      const headerLines = Object.entries(headers).map(([keyName, value]) => `${keyName}: ${value}`);
      socket.write([
        'GET /stream HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        ...headerLines,
        '',
        '',
      ].join('\r\n'));
    });

    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (response.includes('\r\n\r\n')) {
        clearTimeout(timeout);
        socket.destroy();
        resolveHandshake(response);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timeout);
      rejectHandshake(error);
    });
  });
}

function snapshot(overrides: Partial<ConsoleSnapshot> = {}): ConsoleSnapshot {
  const base: ConsoleSnapshot = {
    schema_version: CONSOLE_SNAPSHOT_SCHEMA_VERSION,
    run_id: 'run-1',
    session_id: 'session-1',
    generated_from: {
      journal_path: 'journal.jsonl',
      journal_path_redacted: false,
      last_event_id: null,
      last_event_ts_ns: null,
      event_count: 0,
    },
    data_pipeline: {
      source_event_count: 0,
      by_type: {},
      last_event_age_ms: { status: 'unavailable', reason: 'no events yet' },
      malformed_or_schema_invalid_count: 0,
    },
    strategies: [],
    trades: { rows: [] },
    positions: [],
    pnl: {
      realized_pnl_usd: { status: 'unavailable', reason: 'no explicit lifecycle fact' },
      unrealized_pnl_usd: { status: 'unavailable', reason: 'no quote mark' },
      source: 'unavailable',
    },
    risk: {
      circuit_breaker_state: { status: 'unavailable', reason: 'no risk gate yet' },
      daily_loss_usage: { status: 'unavailable', reason: 'no daily_loss_usage fact' },
      open_trade_count: { status: 'unavailable', reason: 'no risk gate yet' },
      rejected_trade_count: { status: 'unavailable', reason: 'no risk gate yet' },
    },
    latency: {
      last_event_lag_ms: { status: 'unavailable', reason: 'no events yet' },
      telemetry_only: true,
    },
    alerts: [],
    system_health: {
      server_status: 'running',
      ws_client_count: 0,
      ws_backpressure: false,
      dropped_critical_frame_count: 0,
      checkpoint_status: { status: 'unavailable', reason: 'not started' },
    },
    feature_surface: {
      mask_version: 5,
      mask_id: 'feature-availability-mask-v5-adr0003-data-mbo03-advisory-policy',
      mask_hash: 'sha256:test',
      mask_source: 'fallback',
      field_tiers: {},
      partition_counts: {
        authoritative: 0,
        subscope: 0,
        diagnostic_only: 0,
        shadow_only: 0,
        advisory_only: 0,
        blocked: 0,
        available: 0,
      },
      recent_violations: [],
    },
  };

  return {
    ...base,
    ...overrides,
    generated_from: {
      ...base.generated_from,
      ...overrides.generated_from,
    },
    data_pipeline: {
      ...base.data_pipeline,
      ...overrides.data_pipeline,
    },
    trades: {
      ...base.trades,
      ...overrides.trades,
    },
    system_health: {
      ...base.system_health,
      ...overrides.system_health,
    },
  };
}
