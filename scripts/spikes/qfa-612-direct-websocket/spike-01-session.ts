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
    area: "session establishment",
    step: "mock_tls_websocket_server_started",
    result: "PASS",
    mode: spikeModeEvidence(),
    endpoint: server.safeEndpoint(),
  });

  client = new DirectWebSocketClient(server.url);
  const handshake = await client.connect();
  records.push({
    area: "session establishment",
    step: "tls_plus_websocket_upgrade",
    result: "PASS",
    evidence: handshake,
  });

  const auth = buildAuthLoginMessage();
  const authFrame = client.sendJson(auth);
  records.push({
    area: "session establishment",
    step: "auth_login_sent",
    result: "PASS",
    frame: authFrame,
    message: sanitizeForLog(auth),
  });

  const ack = await client.waitForMessage((message) => message.type === "auth.ack", "auth ack");
  records.push({
    area: "session establishment",
    step: "auth_ack_decoded",
    result: "PASS",
    message: sanitizeForLog(ack),
  });

  await client.close(1000, "session spike complete");
} finally {
  client?.destroy();
  await server.stop();
}

await writeJsonlFixture("spike-01-session.jsonl", records);
console.log("Wrote fixtures/spike-01-session.jsonl");
