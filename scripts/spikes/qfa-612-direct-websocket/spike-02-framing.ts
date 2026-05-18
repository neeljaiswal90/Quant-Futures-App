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

try {
  records.push({
    area: "message framing and decoding",
    step: "mock_tls_websocket_server_started",
    result: "PASS",
    mode: spikeModeEvidence(),
    endpoint: server.safeEndpoint(),
  });

  client = new DirectWebSocketClient(server.url);
  await client.connect();
  client.sendJson(buildAuthLoginMessage());
  await client.waitForMessage((message) => message.type === "auth.ack", "auth ack");

  const subscribe = {
    type: "market.subscribe",
    requestId: "frame-probe-001",
    instrument: "MNQH6",
    depth: 1,
  };
  const frame = client.sendJson(subscribe);
  records.push({
    area: "message framing and decoding",
    step: "client_text_frame_masked",
    result: frame.masked ? "PASS" : "FAIL",
    frame,
    message: sanitizeForLog(subscribe),
  });

  const snapshot = await client.waitForMessage(
    (message) => message.type === "market.snapshot",
    "market snapshot",
  );
  const delta = await client.waitForMessage(
    (message) => message.type === "market.delta",
    "market delta",
  );

  records.push({
    area: "message framing and decoding",
    step: "snapshot_decoded",
    result: "PASS",
    message: snapshot,
  });
  records.push({
    area: "message framing and decoding",
    step: "delta_decoded",
    result: "PASS",
    message: delta,
  });

  await client.close(1000, "framing spike complete");
} finally {
  client?.destroy();
  await server.stop();
}

await writeJsonlFixture("spike-02-framing.jsonl", records);
console.log("Wrote fixtures/spike-02-framing.jsonl");
