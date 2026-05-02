import { createHash } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import { diffConsoleSnapshots, coalesceTelemetryDeltas } from './coalesce.js';
import { authenticateRestRequest } from './auth.js';
import { assertJsonSafe, stableJsonStringify } from './json-safe.js';
import { nextSequence, type ConsoleDelta, type ConsoleStreamFrame } from '../types/delta.js';
import type { OperatorConsoleServerConfig } from '../runtime/config.js';
import type { ConsoleSnapshot } from '../types/snapshot.js';
import type { ConsoleRestDataSource } from './rest.js';

export interface ConsoleWebSocketHealth {
  readonly ws_client_count: number;
  readonly ws_backpressure: boolean;
  readonly dropped_critical_frame_count: number;
}

export interface OperatorConsoleWebSocketStream {
  readonly getHealth: () => ConsoleWebSocketHealth;
  readonly close: () => void;
}

export interface OperatorConsoleWebSocketStreamOptions {
  readonly server: Server;
  readonly config: OperatorConsoleServerConfig;
  readonly data_source: ConsoleRestDataSource;
  readonly poll_ms: number;
  readonly coalesce_ms?: number;
  readonly max_buffered_bytes?: number;
}

interface StreamClient {
  readonly socket: Socket;
  seq: string;
  ready: boolean;
  receive_buffer: Buffer;
  pending_telemetry: readonly ConsoleDelta[];
  pending_telemetry_last_event_id: string | null;
  telemetry_timer: ReturnType<typeof setTimeout> | undefined;
}

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const DEFAULT_WS_COALESCE_MS = 250;
const DEFAULT_MAX_BUFFERED_BYTES = 1_000_000;
const CLOSE_NORMAL = Buffer.from([0x88, 0x00]);

export function attachOperatorConsoleWebSocketStream(
  options: OperatorConsoleWebSocketStreamOptions,
): OperatorConsoleWebSocketStream {
  return new OperatorConsoleWebSocketStreamImpl(options).attach();
}

class OperatorConsoleWebSocketStreamImpl implements OperatorConsoleWebSocketStream {
  private readonly clients = new Set<StreamClient>();
  private readonly coalesceMs: number;
  private readonly maxBufferedBytes: number;
  private currentSnapshot: ConsoleSnapshot | null = null;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private wsBackpressure = false;
  private droppedCriticalFrameCount = 0;
  private closed = false;

  public constructor(private readonly options: OperatorConsoleWebSocketStreamOptions) {
    this.coalesceMs = options.coalesce_ms ?? DEFAULT_WS_COALESCE_MS;
    this.maxBufferedBytes = options.max_buffered_bytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  }

  public attach(): OperatorConsoleWebSocketStream {
    this.options.server.on('upgrade', this.handleUpgrade);
    return this;
  }

  public getHealth = (): ConsoleWebSocketHealth => ({
    ws_client_count: this.clients.size,
    ws_backpressure: this.wsBackpressure,
    dropped_critical_frame_count: this.droppedCriticalFrameCount,
  });

  public close = (): void => {
    this.closed = true;
    this.options.server.off('upgrade', this.handleUpgrade);
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const client of this.clients) {
      this.closeClient(client);
    }
  };

  private readonly handleUpgrade = (request: IncomingMessage, socket: Socket): void => {
    const url = new URL(request.url ?? '/', 'http://operator-console.local');
    if (url.pathname !== '/stream') {
      rejectUpgrade(socket, 404, 'not_found', 'unknown operator console WebSocket endpoint');
      return;
    }

    const auth = authenticateRestRequest(this.options.config, request);
    if (!auth.ok) {
      rejectUpgrade(
        socket,
        auth.status_code ?? 403,
        auth.status_code === 401 ? 'unauthorized' : 'forbidden',
        auth.message ?? 'request is not authorized',
      );
      return;
    }

    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string' || request.headers.upgrade?.toLowerCase() !== 'websocket') {
      rejectUpgrade(socket, 400, 'bad_request', 'invalid WebSocket upgrade request');
      return;
    }

    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '',
      '',
    ].join('\r\n'));

    void this.acceptClient(socket);
  };

  private async acceptClient(socket: Socket): Promise<void> {
    const client: StreamClient = {
      socket,
      seq: '0',
      ready: false,
      receive_buffer: Buffer.alloc(0),
      pending_telemetry: [],
      pending_telemetry_last_event_id: null,
      telemetry_timer: undefined,
    };

    this.clients.add(client);
    socket.on('data', (chunk) => this.handleClientData(client, chunk));
    socket.on('close', () => this.removeClient(client));
    socket.on('error', () => this.removeClient(client));

    try {
      const snapshot = await this.refreshAndBroadcast(client);
      this.sendSnapshot(client, snapshot);
      client.ready = true;
      this.startPolling();
    } catch {
      this.closeClient(client);
    }
  }

  private startPolling(): void {
    if (this.pollTimer !== undefined || this.closed) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.pollAndBroadcast();
    }, this.options.poll_ms);
  }

  private async pollAndBroadcast(): Promise<void> {
    if (this.clients.size === 0 || this.polling || this.closed) {
      return;
    }

    this.polling = true;
    try {
      await this.refreshAndBroadcast();
    } finally {
      this.polling = false;
    }
  }

  private async refreshAndBroadcast(skipClient?: StreamClient): Promise<ConsoleSnapshot> {
    const nextSnapshot = await this.options.data_source.refresh();
    const previousSnapshot = this.currentSnapshot;
    this.currentSnapshot = nextSnapshot;

    if (previousSnapshot === null) {
      return nextSnapshot;
    }

    const batch = diffConsoleSnapshots(previousSnapshot, nextSnapshot);
    for (const delta of batch.immediate) {
      this.broadcastDelta(delta, nextSnapshot, false, skipClient);
    }
    if (batch.telemetry.length > 0) {
      this.queueTelemetry(batch.telemetry, nextSnapshot, skipClient);
    }
    return nextSnapshot;
  }

  private broadcastDelta(
    delta: ConsoleDelta,
    snapshot: ConsoleSnapshot,
    telemetry: boolean,
    skipClient?: StreamClient,
  ): void {
    for (const client of this.clients) {
      if (client === skipClient || !client.ready) {
        continue;
      }
      this.sendDelta(client, delta, snapshot.generated_from.last_event_id, telemetry);
    }
  }

  private queueTelemetry(
    deltas: readonly ConsoleDelta[],
    snapshot: ConsoleSnapshot,
    skipClient?: StreamClient,
  ): void {
    for (const client of this.clients) {
      if (client === skipClient || !client.ready) {
        continue;
      }

      client.pending_telemetry = coalesceTelemetryDeltas(client.pending_telemetry, deltas);
      client.pending_telemetry_last_event_id = snapshot.generated_from.last_event_id;
      if (client.telemetry_timer !== undefined) {
        continue;
      }

      client.telemetry_timer = setTimeout(() => {
        client.telemetry_timer = undefined;
        const pending = client.pending_telemetry;
        const lastEventId = client.pending_telemetry_last_event_id;
        client.pending_telemetry = [];
        client.pending_telemetry_last_event_id = null;
        for (const delta of pending) {
          this.sendDelta(client, delta, lastEventId, true);
        }
      }, this.coalesceMs);
    }
  }

  private sendSnapshot(client: StreamClient, snapshot: ConsoleSnapshot): void {
    const seq = nextSequence(client.seq);
    this.sendFrame(client, { kind: 'snapshot', seq, snapshot }, true);
    client.seq = seq;
  }

  private sendDelta(
    client: StreamClient,
    delta: ConsoleDelta,
    lastEventId: string | null,
    telemetry: boolean,
  ): void {
    const baseSeq = client.seq;
    const seq = nextSequence(baseSeq);
    const frame = {
      kind: 'delta',
      seq,
      base_seq: baseSeq,
      last_event_id: lastEventId,
      delta,
    } as const satisfies ConsoleStreamFrame;

    if (!this.sendFrame(client, frame, false, telemetry)) {
      return;
    }
    client.seq = seq;
  }

  private sendResyncRequired(client: StreamClient, reason: 'gap' | 'backpressure' | 'schema_mismatch'): void {
    const seq = nextSequence(client.seq);
    this.sendFrame(client, { kind: 'resync_required', seq, reason }, true);
    client.seq = seq;
  }

  private sendFrame(
    client: StreamClient,
    frame: ConsoleStreamFrame,
    force: boolean,
    telemetry = false,
  ): boolean {
    assertJsonSafe(frame);
    const payload = stableJsonStringify(frame);
    const projectedBytes = client.socket.bufferSize + Buffer.byteLength(payload);
    if (!force && projectedBytes > this.maxBufferedBytes) {
      this.wsBackpressure = true;
      if (!telemetry) {
        this.droppedCriticalFrameCount += 1;
        this.sendResyncRequired(client, 'backpressure');
      }
      return false;
    }

    const accepted = client.socket.write(encodeTextFrame(payload));
    if (!accepted) {
      this.wsBackpressure = true;
    }
    return true;
  }

  private handleClientData(client: StreamClient, chunk: Buffer): void {
    client.receive_buffer = Buffer.concat([client.receive_buffer, chunk]);
    const parsed = parseClientFrames(client.receive_buffer);
    client.receive_buffer = parsed.remaining;
    for (const frame of parsed.frames) {
      if (frame.opcode === 0x8) {
        this.closeClient(client);
        return;
      }
      if (frame.opcode === 0x9) {
        client.socket.write(encodeFrame(0xA, frame.payload));
      }
    }
  }

  private removeClient(client: StreamClient): void {
    if (client.telemetry_timer !== undefined) {
      clearTimeout(client.telemetry_timer);
    }
    this.clients.delete(client);
    if (this.clients.size === 0 && this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private closeClient(client: StreamClient): void {
    if (!client.socket.destroyed) {
      client.socket.write(CLOSE_NORMAL);
      client.socket.end();
    }
    this.removeClient(client);
  }
}

function rejectUpgrade(
  socket: Socket,
  status: number,
  error: string,
  message: string,
): void {
  const body = stableJsonStringify({ error, message });
  socket.write([
    `HTTP/1.1 ${status} ${httpStatusText(status)}`,
    'Connection: close',
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n'));
  socket.end();
}

function acceptKey(key: string): string {
  return createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
}

function encodeTextFrame(payload: string): Buffer {
  return encodeFrame(0x1, Buffer.from(payload, 'utf8'));
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const first = 0x80 | opcode;
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([first, payload.length]), payload]);
  }
  if (payload.length <= 0xFFFF) {
    const header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = first;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

interface ParsedClientFrame {
  readonly opcode: number;
  readonly payload: Buffer;
}

function parseClientFrames(buffer: Buffer): {
  readonly frames: readonly ParsedClientFrame[];
  readonly remaining: Buffer;
} {
  const frames: ParsedClientFrame[] = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset]!;
    const second = buffer[offset + 1]!;
    const masked = (second & 0x80) !== 0;
    let payloadLength = second & 0x7F;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (buffer.length - offset < 4) {
        break;
      }
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (buffer.length - offset < 10) {
        break;
      }
      const length = buffer.readBigUInt64BE(offset + 2);
      if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
        break;
      }
      payloadLength = Number(length);
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + payloadLength;
    if (buffer.length - offset < frameLength) {
      break;
    }

    let payload = buffer.subarray(offset + headerLength + maskLength, offset + frameLength);
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      payload = unmask(payload, mask);
    }

    frames.push({ opcode: first & 0x0F, payload });
    offset += frameLength;
  }

  return { frames, remaining: buffer.subarray(offset) };
}

function unmask(payload: Buffer, mask: Buffer): Buffer {
  const output = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    output[index] = payload[index]! ^ mask[index % 4]!;
  }
  return output;
}

function httpStatusText(status: number): string {
  switch (status) {
    case 400:
      return 'Bad Request';
    case 401:
      return 'Unauthorized';
    case 403:
      return 'Forbidden';
    case 404:
      return 'Not Found';
    default:
      return 'Error';
  }
}
