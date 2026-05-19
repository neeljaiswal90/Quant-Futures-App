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
let reconnectClient: DirectWebSocketClient | undefined;

try {
  records.push({
    area: "reconnect semantics",
    step: "mock_reconnect_plan",
    result: "PASS",
    mode: spikeModeEvidence(),
    cases: ["orderly close and reconnect", "disorderly socket drop and sequence recovery"],
  });

  client = new DirectWebSocketClient(server.url);
  await client.connect();
  client.sendJson(buildAuthLoginMessage());
  await client.waitForMessage((message) => message.type === "auth.ack", "auth ack");

  const logoutFrame = client.sendJson({ type: "session.logout", reason: "orderly reconnect probe" });
  const logoutAck = await client.waitForMessage(
    (message) => message.type === "session.logout.ack",
    "logout ack",
  );
  const orderlyClose = await client.waitForClose();
  records.push({
    area: "reconnect semantics",
    step: "orderly_reconnect_baseline",
    result: orderlyClose.code === 1000 ? "PASS" : "FAIL",
    frame: logoutFrame,
    ack: sanitizeForLog(logoutAck),
    close: orderlyClose,
  });

  reconnectClient = new DirectWebSocketClient(server.url);
  await reconnectClient.connect();
  reconnectClient.sendJson(buildAuthLoginMessage());
  await reconnectClient.waitForMessage((message) => message.type === "auth.ack", "re-auth ack");
  const subscribeFrame = reconnectClient.sendJson({
    type: "market.subscribe",
    requestId: "reconnect-probe-001",
    instrument: "MNQH6",
  });
  const snapshot = await reconnectClient.waitForMessage(
    (message) => message.type === "market.snapshot",
    "snapshot before drop",
  );
  const lastSeq = Number(snapshot.seq);

  records.push({
    area: "reconnect semantics",
    step: "pre_drop_sequence_observed",
    result: "PASS",
    frame: subscribeFrame,
    lastSeq,
    message: sanitizeForLog(snapshot),
  });

  const dropped = server.dropActiveConnection();
  const disorderlyClose = await reconnectClient.waitForClose();
  records.push({
    area: "reconnect semantics",
    step: "disorderly_drop_detected",
    result: dropped ? "PASS" : "FAIL",
    close: disorderlyClose,
  });

  reconnectClient = new DirectWebSocketClient(server.url);
  await reconnectClient.connect();
  reconnectClient.sendJson(buildAuthLoginMessage());
  await reconnectClient.waitForMessage((message) => message.type === "auth.ack", "re-auth ack 2");
  const recoverFrame = reconnectClient.sendJson({
    type: "recover.request",
    requestId: "recover-after-drop-001",
    lastSeq,
  });
  const recoverAck = await reconnectClient.waitForMessage(
    (message) => message.type === "recover.ack",
    "recover ack",
  );
  const recoveredOne = await reconnectClient.waitForMessage(
    (message) => message.type === "market.delta" && message.seq === lastSeq + 1,
    "recovered event one",
  );
  const recoveredTwo = await reconnectClient.waitForMessage(
    (message) => message.type === "market.delta" && message.seq === lastSeq + 2,
    "recovered event two",
  );

  records.push({
    area: "reconnect semantics",
    step: "sequence_recovery_after_disorderly_drop",
    result: "PASS",
    frame: recoverFrame,
    ack: sanitizeForLog(recoverAck),
    recovered: [sanitizeForLog(recoveredOne), sanitizeForLog(recoveredTwo)],
  });

  await reconnectClient.close(1000, "reconnect spike complete");
} finally {
  client?.destroy();
  reconnectClient?.destroy();
  await server.stop();
}

await writeJsonlFixture("spike-04-reconnect.jsonl", records);
console.log("Wrote fixtures/spike-04-reconnect.jsonl");
