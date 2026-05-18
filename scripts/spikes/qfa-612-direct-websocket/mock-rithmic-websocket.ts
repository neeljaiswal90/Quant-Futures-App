import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as tls from "node:tls";
import type { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;
type BinaryBuffer = Buffer<ArrayBufferLike>;

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MOCK_CERT_PASSPHRASE = "qfa612-mock-only";
const DEFAULT_TIMEOUT_MS = 2_500;

export const SPIKE_DIR = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(SPIKE_DIR, "fixtures");

export const RITHMIC_ENV_KEYS = [
  "RITHMIC_USERNAME",
  "RITHMIC_PASSWORD",
  "RITHMIC_APP_NAME",
  "RITHMIC_APP_VERSION",
  "RITHMIC_SYSTEM_NAME",
  "RITHMIC_FCM_ID",
  "RITHMIC_IB_ID",
  "RITHMIC_ACCOUNT_ID",
] as const;

interface Frame {
  opcode: number;
  payload: BinaryBuffer;
  fin: boolean;
  masked: boolean;
}

interface FrameWriteEvidence {
  opcode: number;
  payloadBytes: number;
  masked: boolean;
}

interface CloseEvidence {
  code?: number;
  reason?: string;
  orderly: boolean;
}

interface Waiter<T> {
  label: string;
  predicate: (value: T) => boolean;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export function credentialPresence(): JsonRecord {
  const byKey = Object.fromEntries(
    RITHMIC_ENV_KEYS.map((key) => [key, Boolean(process.env[key])]),
  );
  return {
    allRequiredPresent: RITHMIC_ENV_KEYS.every((key) => Boolean(process.env[key])),
    byKey,
  };
}

export function spikeModeEvidence(): JsonRecord {
  return {
    mode: "mock",
    reason:
      "No real Rithmic endpoint is encoded in this research spike; Rithmic credential values are env-only and never logged.",
    credentialPresence: credentialPresence(),
  };
}

export function buildAuthLoginMessage(): JsonRecord {
  return {
    type: "auth.login",
    requestId: randomUUID(),
    credentials: {
      username: process.env.RITHMIC_USERNAME ?? "__mock_username__",
      password: process.env.RITHMIC_PASSWORD ?? "__mock_password__",
      appName: process.env.RITHMIC_APP_NAME ?? "QFA-612-SPIKE",
      appVersion: process.env.RITHMIC_APP_VERSION ?? "0.0.0-spike",
      systemName: process.env.RITHMIC_SYSTEM_NAME ?? "MOCK-RITHMIC-SYSTEM",
      fcmId: process.env.RITHMIC_FCM_ID ?? "MOCK-FCM",
      ibId: process.env.RITHMIC_IB_ID ?? "MOCK-IB",
      accountId: process.env.RITHMIC_ACCOUNT_ID ?? "MOCK-ACCOUNT",
    },
  };
}

export function sanitizeForLog(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForLog(entry));
  }

  if (value && typeof value === "object") {
    const sanitized: JsonRecord = {};
    for (const [key, entry] of Object.entries(value as JsonRecord)) {
      if (isSensitiveKey(key)) {
        sanitized[key] = entry ? "<redacted:present>" : "<redacted:missing>";
      } else {
        sanitized[key] = sanitizeForLog(entry);
      }
    }
    return sanitized;
  }

  return value;
}

export async function writeJsonlFixture(fileName: string, records: JsonRecord[]): Promise<void> {
  await mkdir(FIXTURES_DIR, { recursive: true });
  const lines = records.map((record, index) =>
    JSON.stringify(
      sanitizeForLog({
        eventIndex: index + 1,
        ...record,
      }),
    ),
  );
  await writeFile(join(FIXTURES_DIR, fileName), `${lines.join("\n")}\n`, "utf8");
}

export async function startMockServer(): Promise<MockRithmicWebSocketServer> {
  const server = new MockRithmicWebSocketServer();
  await server.start();
  return server;
}

export class MockRithmicWebSocketServer {
  private server?: tls.Server;
  private sockets = new Set<TLSSocket>();
  private peers = new Set<WebSocketPeer>();

  port = 0;
  url = "";

  async start(): Promise<void> {
    const pfx = generateEphemeralPfx();

    this.server = tls.createServer(
      {
        pfx,
        passphrase: MOCK_CERT_PASSPHRASE,
        minVersion: "TLSv1.2",
      },
      (socket) => this.handleSocket(socket),
    );

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(0, "127.0.0.1", () => {
        const address = this.server?.address();
        if (!address || typeof address === "string") {
          reject(new Error("Mock TLS WebSocket server did not expose a TCP port."));
          return;
        }
        this.port = address.port;
        this.url = `wss://127.0.0.1:${this.port}/rprotocol`;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const peer of this.peers) {
      peer.destroy();
    }
    for (const socket of this.sockets) {
      socket.destroy();
    }

    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
  }

  dropActiveConnection(): boolean {
    const firstPeer = this.peers.values().next().value as WebSocketPeer | undefined;
    if (!firstPeer) {
      return false;
    }
    firstPeer.destroy();
    return true;
  }

  safeEndpoint(): JsonRecord {
    return {
      scheme: "wss",
      host: "127.0.0.1",
      port: this.port,
      path: "/rprotocol",
    };
  }

  private handleSocket(socket: TLSSocket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));

    let requestBuffer = Buffer.alloc(0);
    const onHandshakeData = (chunk: Buffer) => {
      requestBuffer = Buffer.concat([requestBuffer, chunk]);
      const headerEnd = requestBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      socket.off("data", onHandshakeData);
      const rawHead = requestBuffer.subarray(0, headerEnd).toString("utf8");
      const leftover = requestBuffer.subarray(headerEnd + 4);
      const request = parseHttpUpgradeRequest(rawHead);

      if (request.method !== "GET" || !request.headers["sec-websocket-key"]) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }

      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}${WEBSOCKET_GUID}`)
        .digest("base64");

      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "Sec-WebSocket-Protocol: rprotocol.mock.v1",
          "\r\n",
        ].join("\r\n"),
      );

      const peer = new WebSocketPeer(socket, false);
      this.peers.add(peer);
      socket.once("close", () => this.peers.delete(peer));
      const state = createConnectionState();

      peer.on("text", (text: string) => {
        const message = JSON.parse(text) as JsonRecord;
        this.handleMessage(peer, state, message);
      });
      peer.on("ping", (payload: Buffer) => peer.sendPong(payload));

      if (leftover.length > 0) {
        peer.acceptData(leftover);
      }
    };

    socket.on("data", onHandshakeData);
  }

  private handleMessage(peer: WebSocketPeer, state: ConnectionState, message: JsonRecord): void {
    switch (message.type) {
      case "auth.login": {
        state.authenticated = true;
        peer.sendJson({
          type: "auth.ack",
          requestId: message.requestId,
          sessionId: state.sessionId,
          heartbeatIntervalMs: 1_000,
          permissions: ["market-data", "order-entry-sim"],
          serverTimeNs: nowNs(),
          protocol: "mock-rprotocol-json-over-websocket-v1",
        });
        return;
      }

      case "market.subscribe": {
        requireAuthenticated(state);
        const instrument = String(message.instrument ?? "MNQH6");
        peer.sendJson({
          type: "market.snapshot",
          seq: 1,
          instrument,
          encoding: "mock-rprotocol-json",
          book: {
            bids: [{ price: 19_750.25, quantity: 4 }],
            asks: [{ price: 19_750.5, quantity: 7 }],
          },
          exchangeTimeNs: nowNs(),
        });
        peer.sendJson({
          type: "market.delta",
          seq: 2,
          instrument,
          op: "upsert",
          side: "bid",
          price: 19_750.0,
          quantity: 6,
          exchangeTimeNs: nowNs(),
        });
        return;
      }

      case "heartbeat.ping": {
        requireAuthenticated(state);
        state.lastHeartbeatSeq = Number(message.seq ?? 0);
        peer.sendJson({
          type: "heartbeat.ack",
          seq: state.lastHeartbeatSeq,
          receivedAtNs: nowNs(),
        });
        return;
      }

      case "recover.request": {
        requireAuthenticated(state);
        const lastSeq = Number(message.lastSeq ?? 0);
        const recovered = [
          {
            type: "market.delta",
            seq: lastSeq + 1,
            instrument: "MNQH6",
            op: "upsert",
            side: "ask",
            price: 19_751.0,
            quantity: 5,
            exchangeTimeNs: nowNs(),
          },
          {
            type: "market.delta",
            seq: lastSeq + 2,
            instrument: "MNQH6",
            op: "delete",
            side: "bid",
            price: 19_750.0,
            exchangeTimeNs: nowNs(),
          },
        ];
        peer.sendJson({
          type: "recover.ack",
          requestedLastSeq: lastSeq,
          recoveredCount: recovered.length,
          recoveryMode: "mock-gap-replay",
        });
        for (const event of recovered) {
          peer.sendJson(event);
        }
        return;
      }

      case "order.intent": {
        requireAuthenticated(state);
        const clientOrderId = String(message.clientOrderId ?? randomUUID());
        if (message.forceReject === true) {
          peer.sendJson({
            type: "order.reject",
            clientOrderId,
            reasonCode: "MOCK_RISK_REJECT",
            reason: "Mock risk check rejected the order intent.",
            exchangeTimeNs: nowNs(),
          });
          return;
        }

        const brokerOrderId = `MOCK-${randomUUID()}`;
        peer.sendJson({
          type: "order.ack",
          clientOrderId,
          brokerOrderId,
          ackStatus: "ACCEPTED_BY_ORDER_PLANT",
          exchangeTimeNs: nowNs(),
        });
        peer.sendJson({
          type: "order.fill",
          clientOrderId,
          brokerOrderId,
          fillId: `FILL-${randomUUID()}`,
          filledQuantity: message.quantity ?? 1,
          fillPrice: message.limitPrice ?? 19_750.25,
          exchangeTimeNs: nowNs(),
        });
        return;
      }

      case "session.logout": {
        requireAuthenticated(state);
        peer.sendJson({
          type: "session.logout.ack",
          sessionId: state.sessionId,
          status: "BYE",
          exchangeTimeNs: nowNs(),
        });
        setTimeout(() => peer.sendClose(1000, "mock logout complete"), 10);
        return;
      }

      default:
        peer.sendJson({
          type: "error",
          code: "MOCK_UNKNOWN_MESSAGE",
          messageType: message.type,
        });
    }
  }
}

export class DirectWebSocketClient {
  private peer?: WebSocketPeer;
  private messages: JsonRecord[] = [];
  private messageWaiters: Waiter<JsonRecord>[] = [];
  private pongs: string[] = [];
  private pongWaiters: Waiter<string>[] = [];
  private closeWaiters: Array<(value: CloseEvidence) => void> = [];
  private lastClose: CloseEvidence = { orderly: false };

  constructor(private readonly url: string) {}

  async connect(): Promise<JsonRecord> {
    const target = new URL(this.url);
    const host = target.hostname;
    const port = Number(target.port);
    const path = `${target.pathname}${target.search}`;
    const socket = tls.connect({
      host,
      port,
      servername: "localhost",
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });

    const secWebSocketKey = randomBytes(16).toString("base64");
    socket.write(
      [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${secWebSocketKey}`,
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Protocol: rprotocol.mock.v1",
        "\r\n",
      ].join("\r\n"),
    );

    const handshake = await this.readHandshakeResponse(socket, secWebSocketKey);
    this.peer = new WebSocketPeer(socket, true);
    this.peer.on("text", (text: string) => this.dispatchMessage(JSON.parse(text) as JsonRecord));
    this.peer.on("ping", (payload: Buffer) => this.peer?.sendPong(payload));
    this.peer.on("pong", (payload: Buffer) => this.dispatchPong(payload.toString("utf8")));
    this.peer.on("closeFrame", (close: CloseEvidence) => {
      this.lastClose = close;
    });
    this.peer.on("socketClose", () => {
      const close = this.lastClose;
      for (const resolve of this.closeWaiters.splice(0)) {
        resolve(close);
      }
    });

    if ((handshake.leftover as Buffer).length > 0) {
      this.peer.acceptData(handshake.leftover as Buffer);
    }

    return {
      url: this.url,
      tlsProtocol: socket.getProtocol(),
      cipherName: socket.getCipher().name,
      authorized: socket.authorized,
      authorizationError: socket.authorizationError,
      httpStatus: handshake.httpStatus,
      secWebSocketAcceptVerified: handshake.secWebSocketAcceptVerified,
      negotiatedProtocol: handshake.negotiatedProtocol,
    };
  }

  sendJson(message: JsonRecord): FrameWriteEvidence {
    return this.requirePeer().sendJson(message);
  }

  sendPing(payload: string): FrameWriteEvidence {
    return this.requirePeer().sendPing(Buffer.from(payload, "utf8"));
  }

  waitForMessage(
    predicate: (message: JsonRecord) => boolean,
    label: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<JsonRecord> {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) {
      const [message] = this.messages.splice(index, 1);
      return Promise.resolve(message);
    }

    return new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.messageWaiters = this.messageWaiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error(`Timed out waiting for ${label}.`));
      }, timeoutMs);
      this.messageWaiters.push({ label, predicate, resolve, reject, timer });
    });
  }

  waitForPong(payload: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    const index = this.pongs.indexOf(payload);
    if (index >= 0) {
      const [pong] = this.pongs.splice(index, 1);
      return Promise.resolve(pong);
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pongWaiters = this.pongWaiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error(`Timed out waiting for pong ${payload}.`));
      }, timeoutMs);
      this.pongWaiters.push({
        label: `pong ${payload}`,
        predicate: (entry) => entry === payload,
        resolve,
        reject,
        timer,
      });
    });
  }

  async close(code = 1000, reason = "client close"): Promise<CloseEvidence> {
    this.requirePeer().sendClose(code, reason);
    return this.waitForClose();
  }

  waitForClose(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CloseEvidence> {
    return new Promise<CloseEvidence>((resolve) => {
      const timer = setTimeout(() => {
        this.closeWaiters = this.closeWaiters.filter((waiter) => waiter !== wrappedResolve);
        resolve(this.lastClose);
      }, timeoutMs);
      const wrappedResolve = (value: CloseEvidence) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.closeWaiters.push(wrappedResolve);
    });
  }

  destroy(): void {
    this.peer?.destroy();
  }

  private async readHandshakeResponse(
    socket: TLSSocket,
    secWebSocketKey: string,
  ): Promise<JsonRecord & { leftover: Buffer }> {
    let responseBuffer = Buffer.alloc(0);

    return new Promise((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        responseBuffer = Buffer.concat([responseBuffer, chunk]);
        const headerEnd = responseBuffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }

        socket.off("data", onData);
        socket.off("error", reject);

        const rawHead = responseBuffer.subarray(0, headerEnd).toString("utf8");
        const leftover = responseBuffer.subarray(headerEnd + 4);
        const response = parseHttpResponse(rawHead);
        const expectedAccept = createHash("sha1")
          .update(`${secWebSocketKey}${WEBSOCKET_GUID}`)
          .digest("base64");

        if (response.status !== 101) {
          reject(new Error(`Expected HTTP 101, received ${response.status}.`));
          return;
        }

        resolve({
          httpStatus: response.status,
          secWebSocketAcceptVerified:
            response.headers["sec-websocket-accept"] === expectedAccept,
          negotiatedProtocol: response.headers["sec-websocket-protocol"] ?? null,
          leftover,
        });
      };

      socket.on("data", onData);
      socket.once("error", reject);
    });
  }

  private requirePeer(): WebSocketPeer {
    if (!this.peer) {
      throw new Error("WebSocket client is not connected.");
    }
    return this.peer;
  }

  private dispatchMessage(message: JsonRecord): void {
    const waiterIndex = this.messageWaiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = this.messageWaiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    this.messages.push(message);
  }

  private dispatchPong(payload: string): void {
    const waiterIndex = this.pongWaiters.findIndex((waiter) => waiter.predicate(payload));
    if (waiterIndex >= 0) {
      const [waiter] = this.pongWaiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(payload);
      return;
    }
    this.pongs.push(payload);
  }
}

class WebSocketPeer extends EventEmitter {
  private parser = new FrameParser();
  private closeSent = false;

  constructor(
    private readonly socket: TLSSocket,
    private readonly maskOutgoing: boolean,
  ) {
    super();
    socket.on("data", (chunk) => this.acceptData(chunk));
    socket.on("close", () => this.emit("socketClose"));
    socket.on("error", (error) => this.emit("socketError", error));
  }

  acceptData(chunk: Buffer): void {
    for (const frame of this.parser.push(chunk)) {
      this.handleFrame(frame);
    }
  }

  sendJson(message: JsonRecord): FrameWriteEvidence {
    return this.sendText(JSON.stringify(message));
  }

  sendText(text: string): FrameWriteEvidence {
    return this.writeFrame(0x1, Buffer.from(text, "utf8"));
  }

  sendPing(payload: Buffer): FrameWriteEvidence {
    return this.writeFrame(0x9, payload);
  }

  sendPong(payload: Buffer): FrameWriteEvidence {
    return this.writeFrame(0xa, payload);
  }

  sendClose(code = 1000, reason = ""): FrameWriteEvidence {
    if (this.closeSent) {
      return { opcode: 0x8, payloadBytes: 0, masked: this.maskOutgoing };
    }
    this.closeSent = true;
    const reasonBuffer = Buffer.from(reason, "utf8");
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    const evidence = this.writeFrame(0x8, payload);
    setTimeout(() => this.socket.end(), 10);
    return evidence;
  }

  destroy(): void {
    this.socket.destroy();
  }

  private writeFrame(opcode: number, payload: Buffer): FrameWriteEvidence {
    this.socket.write(encodeFrame(opcode, payload, this.maskOutgoing));
    return { opcode, payloadBytes: payload.length, masked: this.maskOutgoing };
  }

  private handleFrame(frame: Frame): void {
    switch (frame.opcode) {
      case 0x1:
        this.emit("text", frame.payload.toString("utf8"));
        return;
      case 0x8: {
        const close = decodeClosePayload(frame.payload);
        this.emit("closeFrame", close);
        if (!this.closeSent) {
          this.sendClose(close.code ?? 1000, close.reason ?? "");
        }
        return;
      }
      case 0x9:
        this.emit("ping", frame.payload);
        return;
      case 0xa:
        this.emit("pong", frame.payload);
        return;
      default:
        this.emit("unsupportedFrame", frame);
    }
  }
}

class FrameParser {
  private buffer: BinaryBuffer = Buffer.alloc(0);

  push(chunk: BinaryBuffer): Frame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];

    while (true) {
      const parsed = tryReadFrame(this.buffer);
      if (!parsed) {
        break;
      }
      frames.push(parsed.frame);
      this.buffer = parsed.rest;
    }

    return frames;
  }
}

interface ConnectionState {
  authenticated: boolean;
  sessionId: string;
  lastHeartbeatSeq: number;
}

function createConnectionState(): ConnectionState {
  return {
    authenticated: false,
    sessionId: `mock-session-${randomUUID()}`,
    lastHeartbeatSeq: 0,
  };
}

function requireAuthenticated(state: ConnectionState): void {
  if (!state.authenticated) {
    throw new Error("Mock R-Protocol request arrived before auth.login.");
  }
}

function parseHttpUpgradeRequest(rawHead: string): {
  method: string;
  path: string;
  headers: Record<string, string>;
} {
  const [requestLine, ...headerLines] = rawHead.split("\r\n");
  const [method, path] = requestLine.split(" ");
  return {
    method,
    path,
    headers: parseHeaders(headerLines),
  };
}

function parseHttpResponse(rawHead: string): { status: number; headers: Record<string, string> } {
  const [statusLine, ...headerLines] = rawHead.split("\r\n");
  return {
    status: Number(statusLine.split(" ")[1]),
    headers: parseHeaders(headerLines),
  };
}

function parseHeaders(lines: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    headers[line.slice(0, separator).trim().toLowerCase()] = line
      .slice(separator + 1)
      .trim();
  }
  return headers;
}

function tryReadFrame(buffer: BinaryBuffer): { frame: Frame; rest: BinaryBuffer } | null {
  if (buffer.length < 2) {
    return null;
  }

  const firstByte = buffer[0];
  const secondByte = buffer[1];
  const fin = Boolean(firstByte & 0x80);
  const opcode = firstByte & 0x0f;
  const masked = Boolean(secondByte & 0x80);
  let length = secondByte & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("WebSocket frame too large for this spike parser.");
    }
    length = Number(bigLength);
    offset += 8;
  }

  let mask: BinaryBuffer | undefined;
  if (masked) {
    if (buffer.length < offset + 4) {
      return null;
    }
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) {
    return null;
  }

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }

  return {
    frame: { opcode, payload, fin, masked },
    rest: buffer.subarray(offset + length),
  };
}

function encodeFrame(opcode: number, payload: BinaryBuffer, mask: boolean): BinaryBuffer {
  const length = payload.length;
  const lengthBytes = length < 126 ? 0 : length <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + (mask ? 4 : 0));
  header[0] = 0x80 | opcode;

  let offset = 2;
  if (length < 126) {
    header[1] = length;
  } else if (length <= 0xffff) {
    header[1] = 126;
    header.writeUInt16BE(length, offset);
    offset += 2;
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), offset);
    offset += 8;
  }

  if (!mask) {
    return Buffer.concat([header, payload]);
  }

  header[1] |= 0x80;
  const maskKey = randomBytes(4);
  maskKey.copy(header, offset);
  const maskedPayload = Buffer.from(payload);
  for (let index = 0; index < maskedPayload.length; index += 1) {
    maskedPayload[index] ^= maskKey[index % 4];
  }

  return Buffer.concat([header, maskedPayload]);
}

function decodeClosePayload(payload: BinaryBuffer): CloseEvidence {
  if (payload.length < 2) {
    return { orderly: true };
  }
  return {
    code: payload.readUInt16BE(0),
    reason: payload.subarray(2).toString("utf8"),
    orderly: true,
  };
}

function isSensitiveKey(key: string): boolean {
  return /(password|username|appName|appVersion|systemName|fcmId|ibId|accountId|token|secret|authorization)/i.test(
    key,
  );
}

function nowNs(): string {
  return `${BigInt(Date.now()) * 1_000_000n}`;
}

function generateEphemeralPfx(): Buffer {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$rsa = [System.Security.Cryptography.RSA]::Create(2048)
$req = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
  'CN=localhost',
  $rsa,
  [System.Security.Cryptography.HashAlgorithmName]::SHA256,
  [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$req.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $false))
$req.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment, $false))
$oids = [System.Security.Cryptography.OidCollection]::new()
$oids.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1')) | Out-Null
$req.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids, $false))
$sanBuilder = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$sanBuilder.AddDnsName('localhost')
$sanBuilder.AddIpAddress([System.Net.IPAddress]::Parse('127.0.0.1'))
$req.CertificateExtensions.Add($sanBuilder.Build())
$cert = $req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddHours(6))
$pfx = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, '${MOCK_CERT_PASSPHRASE}')
[Console]::Out.Write([Convert]::ToBase64String($pfx))
$rsa.Dispose()
$cert.Dispose()
`;

  const errors: string[] = [];
  for (const command of ["pwsh", "powershell"]) {
    const result = spawnSync(command, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });

    if (result.status === 0 && result.stdout.trim()) {
      return Buffer.from(result.stdout.trim(), "base64");
    }

    errors.push(
      `${command}: ${
        result.error?.message ?? result.stderr.trim() ?? `exit status ${result.status}`
      }`,
    );
  }

  throw new Error(
    `Unable to generate ephemeral mock TLS certificate for QFA-612 spike. ${errors.join("; ")}`,
  );
}
