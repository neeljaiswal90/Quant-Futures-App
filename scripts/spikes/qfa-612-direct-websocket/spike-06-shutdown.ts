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
    area: "graceful shutdown",
    step: "mock_shutdown_plan",
    result: "PASS",
    mode: spikeModeEvidence(),
    expectedCloseCode: 1000,
  });

  client = new DirectWebSocketClient(server.url);
  await client.connect();
  client.sendJson(buildAuthLoginMessage());
  await client.waitForMessage((message) => message.type === "auth.ack", "auth ack");

  const logout = {
    type: "session.logout",
    requestId: "shutdown-probe-001",
    reason: "operator requested graceful shutdown",
  };
  const logoutFrame = client.sendJson(logout);
  const logoutAck = await client.waitForMessage(
    (message) => message.type === "session.logout.ack",
    "logout ack",
  );
  const close = await client.waitForClose();

  records.push({
    area: "graceful shutdown",
    step: "logout_ack_decoded",
    result: "PASS",
    frame: logoutFrame,
    message: sanitizeForLog(logoutAck),
  });
  records.push({
    area: "graceful shutdown",
    step: "websocket_close_observed",
    result: close.code === 1000 ? "PASS" : "FAIL",
    close,
  });
} finally {
  client?.destroy();
  await server.stop();
}

await writeJsonlFixture("spike-06-shutdown.jsonl", records);
console.log("Wrote fixtures/spike-06-shutdown.jsonl");
