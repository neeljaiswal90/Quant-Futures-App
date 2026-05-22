import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRunId, makeSessionId, type AnyJournalEventEnvelope } from '../../src/contracts/index.js';
import { LiveTickerSubscriber } from '../../src/data/live-ticker-subscriber.js';
import { TICKER_IPC_SCHEMA_VERSION } from '../../src/data/ticker-ipc-contract.js';
import { SubmissionGate } from '../../src/execution/index.js';

const RUN_ID = makeRunId('run-qfa-633-live-ticker');
const SESSION_ID = makeSessionId('session-qfa-633-live-ticker');

function writeMockSidecar(mode: 'normal' | 'schema-mismatch' | 'malformed' | 'exit-after-boot'): string {
  const dir = mkdtempSync(join(tmpdir(), 'qfa-633-ticker-'));
  const script = join(dir, 'mock-sidecar.cjs');
  writeFileSync(script, `
const mode = ${JSON.stringify(mode)};
const schema = ${TICKER_IPC_SCHEMA_VERSION};
const runId = process.env.QFA_RUN_ID || 'run';
const sessionId = process.env.QFA_SESSION_ID || 'session';
function emit(message_type, payload, correlation_id = message_type, schema_version = schema) {
  process.stdout.write(JSON.stringify({
    schema_version,
    message_type,
    direction: 'event',
    run_id: runId,
    session_id: sessionId,
    correlation_id,
    causation_id: correlation_id,
    event_ts_ns: '1776965227000000000',
    adapter_version: 'mock-ticker-sidecar',
    payload,
  }) + '\\n');
}
if (mode === 'malformed') process.stdout.write('{not json\\n');
emit('boot_identity', {
  adapter_version: 'mock-ticker-sidecar',
  sdk_name: 'pyrithmic',
  sdk_version: 'mock',
  protocol_environment: 'rithmic_live',
  gateway_url_redacted: '[REDACTED:credential]',
  boot_ts_ns: '1776965227000000000',
  process_id: process.pid,
  schema_version: mode === 'schema-mismatch' ? 999 : schema,
}, 'boot', mode === 'schema-mismatch' ? 999 : schema);
if (mode === 'exit-after-boot') process.exit(3);
setTimeout(() => emit('subscription_accepted', { symbol: 'MNQM6', exchange: 'CME' }, 'initial-subscribe'), 5);
setTimeout(() => emit('tick_quote', {
  symbol: 'MNQM6',
  exchange: 'CME',
  tick_ts_ns: '1776965227000001000',
  sidecar_recv_ts_ns: '1776965227000002000',
  bid_px: 18000.25,
  bid_qty: 2,
  ask_px: 18000.5,
  ask_qty: 3,
}, 'tick-1'), 10);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (chunk.includes('shutdown')) {
    emit('shutdown_complete', { reason: 'client_stop' }, 'shutdown');
    setTimeout(() => process.exit(0), 5);
  }
});
`, 'utf8');
  return script;
}

async function eventually(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 500) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('LiveTickerSubscriber', () => {
  it('spawns a sidecar, accepts boot identity, and translates quote ticks', async () => {
    const events: AnyJournalEventEnvelope[] = [];
    const subscriber = new LiveTickerSubscriber({
      run_id: RUN_ID,
      session_id: SESSION_ID,
      executable: process.execPath,
      args: [writeMockSidecar('normal')],
      event_sink: (event) => {
        events.push(event);
      },
    });

    await subscriber.start();
    await eventually(() => events.some((event) => event.type === 'QUOTE'));
    await subscriber.stop();

    expect(events.find((event) => event.type === 'QUOTE')).toMatchObject({
      type: 'QUOTE',
      payload: {
        bid_px: 18000.25,
        ask_px: 18000.5,
        authority: 'authoritative',
      },
    });
  });

  it('rejects start on schema version mismatch and journals a validator issue', async () => {
    const events: AnyJournalEventEnvelope[] = [];
    const subscriber = new LiveTickerSubscriber({
      run_id: RUN_ID,
      session_id: SESSION_ID,
      executable: process.execPath,
      args: [writeMockSidecar('schema-mismatch')],
      event_sink: (event) => {
        events.push(event);
      },
      boot_timeout_ms: 200,
    });

    await expect(subscriber.start()).rejects.toThrow('schema version mismatch');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'VALIDATOR_ISSUE',
      payload: expect.objectContaining({ code: 'ticker_ipc_schema_version_mismatch' }),
    }));
  });

  it('journals malformed JSON without crashing', async () => {
    const events: AnyJournalEventEnvelope[] = [];
    const subscriber = new LiveTickerSubscriber({
      run_id: RUN_ID,
      session_id: SESSION_ID,
      executable: process.execPath,
      args: [writeMockSidecar('malformed')],
      event_sink: (event) => {
        events.push(event);
      },
    });

    await subscriber.start();
    await eventually(() => events.some((event) => event.type === 'QUOTE'));
    await subscriber.stop();

    expect(events).toContainEqual(expect.objectContaining({
      type: 'VALIDATOR_ISSUE',
      payload: expect.objectContaining({ code: 'ticker_ipc_malformed_json' }),
    }));
  });

  it('flips broker reconciliation block if the ticker sidecar exits mid-session', async () => {
    const events: AnyJournalEventEnvelope[] = [];
    const gate = new SubmissionGate();
    const subscriber = new LiveTickerSubscriber({
      run_id: RUN_ID,
      session_id: SESSION_ID,
      executable: process.execPath,
      args: [writeMockSidecar('exit-after-boot')],
      event_sink: (event) => {
        events.push(event);
      },
      submission_gate: gate,
    });

    await subscriber.start();
    await eventually(() => gate.active_block_sources.includes('broker_reconciliation_in_progress'));

    expect(gate.active_block_sources).toContain('broker_reconciliation_in_progress');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'VALIDATOR_ISSUE',
      payload: expect.objectContaining({ code: 'sidecar_unavailable' }),
    }));
  });
});
