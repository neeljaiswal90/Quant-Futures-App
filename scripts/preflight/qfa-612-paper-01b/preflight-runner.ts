import { join } from 'node:path';
import { writeCheckEvidence, summarizeJsonl } from './evidence-capture.js';

const evidenceRoot = 'scripts/preflight/qfa-612-paper-01b/evidence';
const rawRoot = join(evidenceRoot, 'raw-local');
const smoke = summarizeJsonl(join(rawRoot, 'smoke-probe.jsonl'));
const heartbeat = summarizeJsonl(join(rawRoot, 'heartbeat-300s-probe.jsonl'));

await writeCheckEvidence({
  check_id: 'check-01-tls-auth',
  title: 'Real TLS/WebSocket connect and authenticated RProtocol bootstrap',
  disposition: 'PASS_PARTIAL',
  evidence: ['RProtocol --list-systems returned the expected Rithmic Test system.', 'Authenticated 10s market-data smoke produced records with zero probe errors.'],
  notes: ['TLS/WebSocket/protobuf login path is proven by the existing TICKER_PLANT probe. The probe does not expose raw TLS cipher/auth ACK bytes as committed evidence.'],
});
await writeCheckEvidence({
  check_id: 'check-02-framing',
  title: 'Real market/order message framing decode',
  disposition: 'PASS_PARTIAL',
  evidence: [`Smoke summary: ${JSON.stringify(smoke)}`, `Heartbeat summary: ${JSON.stringify(heartbeat)}`],
  notes: ['Market LAST_TRADE/L1_QUOTE protobuf framing decoded successfully. ORDER_PLANT/order message framing is not exercised by the current probe.'],
});
await writeCheckEvidence({
  check_id: 'check-03-heartbeat-300s',
  title: 'Real heartbeat/liveness run for at least five wall-clock minutes',
  disposition: 'PASS',
  evidence: [`300s summary: ${JSON.stringify(heartbeat)}`],
  notes: ['The authenticated websocket/probe stayed alive for the full 300s capture with zero probe errors.'],
});
await writeCheckEvidence({
  check_id: 'check-04-reconnect',
  title: 'Real orderly and disorderly reconnect behavior',
  disposition: 'HOLD',
  evidence: [],
  notes: ['No real reconnect check was executed. Existing repo support has a mock reconnect spike and a TICKER_PLANT probe, but no real reconnect preflight harness for the test gateway.'],
});
await writeCheckEvidence({
  check_id: 'check-05-order-lifecycle',
  title: 'Real paper order ACK/fill/cancel/reject lifecycle',
  disposition: 'HOLD',
  evidence: [],
  notes: ['No paper order was placed. The available RProtocol probe is explicitly TICKER_PLANT-only and never connects to ORDER_PLANT.'],
});
await writeCheckEvidence({
  check_id: 'check-06-logout-close',
  title: 'Real logout and close semantics',
  disposition: 'PASS_PARTIAL',
  evidence: ['The authenticated 10s and 300s probes exited cleanly with process exit code 0.'],
  notes: ['The committed evidence does not include broker logout ACK/close-frame bytes. ORDER_PLANT session close semantics remain unproven.'],
});
