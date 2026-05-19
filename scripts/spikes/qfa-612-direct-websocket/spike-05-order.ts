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
    area: "representative order lifecycle",
    step: "mock_order_lifecycle_plan",
    result: "PASS",
    mode: spikeModeEvidence(),
    messages: ["intent", "ACK", "fill", "reject"],
  });

  client = new DirectWebSocketClient(server.url);
  await client.connect();
  client.sendJson(buildAuthLoginMessage());
  await client.waitForMessage((message) => message.type === "auth.ack", "auth ack");

  const fillIntent = {
    type: "order.intent",
    clientOrderId: "QFA612-FILL-001",
    accountId: process.env.RITHMIC_ACCOUNT_ID ?? "MOCK-ACCOUNT",
    instrument: "MNQH6",
    side: "BUY",
    quantity: 1,
    orderType: "LIMIT",
    limitPrice: 19_750.25,
  };
  const fillIntentFrame = client.sendJson(fillIntent);
  records.push({
    area: "representative order lifecycle",
    step: "order_intent_sent_fill_case",
    result: "PASS",
    frame: fillIntentFrame,
    message: sanitizeForLog(fillIntent),
  });

  const ack = await client.waitForMessage(
    (message) => message.type === "order.ack" && message.clientOrderId === "QFA612-FILL-001",
    "order ack",
  );
  const fill = await client.waitForMessage(
    (message) => message.type === "order.fill" && message.clientOrderId === "QFA612-FILL-001",
    "order fill",
  );
  records.push({
    area: "representative order lifecycle",
    step: "order_ack_decoded",
    result: "PASS",
    message: sanitizeForLog(ack),
  });
  records.push({
    area: "representative order lifecycle",
    step: "order_fill_decoded",
    result: "PASS",
    message: sanitizeForLog(fill),
  });

  const rejectIntent = {
    type: "order.intent",
    clientOrderId: "QFA612-REJECT-001",
    accountId: process.env.RITHMIC_ACCOUNT_ID ?? "MOCK-ACCOUNT",
    instrument: "MNQH6",
    side: "SELL",
    quantity: 99,
    orderType: "LIMIT",
    limitPrice: 1,
    forceReject: true,
  };
  const rejectIntentFrame = client.sendJson(rejectIntent);
  const reject = await client.waitForMessage(
    (message) =>
      message.type === "order.reject" && message.clientOrderId === "QFA612-REJECT-001",
    "order reject",
  );
  records.push({
    area: "representative order lifecycle",
    step: "order_intent_sent_reject_case",
    result: "PASS",
    frame: rejectIntentFrame,
    message: sanitizeForLog(rejectIntent),
  });
  records.push({
    area: "representative order lifecycle",
    step: "order_reject_decoded",
    result: "PASS",
    message: sanitizeForLog(reject),
  });

  await client.close(1000, "order spike complete");
} finally {
  client?.destroy();
  await server.stop();
}

await writeJsonlFixture("spike-05-order.jsonl", records);
console.log("Wrote fixtures/spike-05-order.jsonl");
