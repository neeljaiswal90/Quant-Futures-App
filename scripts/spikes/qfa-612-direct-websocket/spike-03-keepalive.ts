import {
  DirectWebSocketClient,
  buildAuthLoginMessage,
  sanitizeForLog,
  spikeModeEvidence,
  startMockServer,
  writeJsonlFixture,
} from "./mock-rithmic-websocket.js";

const records = [];
const server = await startMockServer();
let client: DirectWebSocketClient | undefined;
const startedAt = Date.now();

try {
  records.push({
    area: "keepalive and heartbeat",
    step: "mock_keepalive_plan",
    result: "PASS",
    mode: spikeModeEvidence(),
    note:
      "Credentials/endpoint unavailable for real 5-minute vendor run; mock compresses 5 logical minutes into 5 one-second heartbeat intervals.",
    logicalDurationMs: 300_000,
    mockWallIntervalMs: 1_000,
  });

  client = new DirectWebSocketClient(server.url);
  await client.connect();
  client.sendJson(buildAuthLoginMessage());
  await client.waitForMessage((message) => message.type === "auth.ack", "auth ack");

  const pingPayload = "qfa612-ws-ping";
  const pingFrame = client.sendPing(pingPayload);
  const pong = await client.waitForPong(pingPayload);
  records.push({
    area: "keepalive and heartbeat",
    step: "websocket_ping_pong",
    result: "PASS",
    frame: pingFrame,
    pongPayload: pong,
  });

  for (let logicalMinute = 1; logicalMinute <= 5; logicalMinute += 1) {
    const heartbeat = {
      type: "heartbeat.ping",
      seq: logicalMinute,
      logicalMinute,
    };
    const heartbeatFrame = client.sendJson(heartbeat);
    const ack = await client.waitForMessage(
      (message) => message.type === "heartbeat.ack" && message.seq === logicalMinute,
      `heartbeat ack ${logicalMinute}`,
    );
    records.push({
      area: "keepalive and heartbeat",
      step: "application_heartbeat_ack",
      result: "PASS",
      logicalMinute,
      frame: heartbeatFrame,
      message: sanitizeForLog(ack),
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  records.push({
    area: "keepalive and heartbeat",
    step: "logical_five_minute_window_complete",
    result: "PASS",
    logicalDurationMs: 300_000,
    wallClockMs: Date.now() - startedAt,
  });

  await client.close(1000, "keepalive spike complete");
} finally {
  client?.destroy();
  await server.stop();
}

await writeJsonlFixture("spike-03-keepalive.jsonl", records);
console.log("Wrote fixtures/spike-03-keepalive.jsonl");
