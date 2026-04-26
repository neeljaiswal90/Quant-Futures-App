import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createJournalEventEnvelope,
  journalEventToJsonLine,
  makeCausationId,
  makeEventId,
  makeRunId,
  makeSessionId,
  ns,
  type JsonValue,
} from '../../src/contracts/index.js';
import {
  createJournalTransportConfig,
  JsonlJournalTransportIngestor,
  type IngestedJournalEvent,
  type JournalTransportConfig,
  type QuarantinedJournalLine,
} from '../../src/transport/index.js';
import type { RuntimeEventType } from '../../src/contracts/index.js';

const START_TS_NS = 1_700_000_000_000_000_000n;
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-journal-transport-'));
  tempDirectories.push(directory);
  return directory;
}

function makeTransportConfig(directory: string): JournalTransportConfig {
  return createJournalTransportConfig(join(directory, 'shared-journals'));
}

function ensureJournalDir(config: JournalTransportConfig): void {
  mkdirSync(config.journal_dir, { recursive: true });
}

function eventLine(
  eventId: string,
  sequence: number,
  causationId = 'cause-root',
  extraPayload: Record<string, JsonValue> = {},
): string {
  const exchangeTs = START_TS_NS + BigInt(sequence) * 1_000_000n;
  const sidecarRecvTs = exchangeTs + 2_000_000n;
  return journalEventToJsonLine(
    createJournalEventEnvelope({
      event_id: makeEventId(eventId),
      type: 'QUOTE',
      ts_ns: ns(exchangeTs),
      run_id: makeRunId('run-evt-00'),
      session_id: makeSessionId('2026-04-23-rth'),
      causation_id: makeCausationId(causationId),
      payload: {
        exchange_event_ts_ns: ns(exchangeTs),
        sidecar_recv_ts_ns: ns(sidecarRecvTs),
        bid_px: 18500.25,
        bid_qty: 12,
        ask_px: 18500.5,
        ask_qty: 9,
        ...extraPayload,
      } satisfies JsonValue,
    }),
  );
}

function derivedEventLine(
  eventId: string,
  type: RuntimeEventType,
  ts: bigint,
  causationId: string | undefined,
): string {
  return journalEventToJsonLine(
    createJournalEventEnvelope({
      event_id: makeEventId(eventId),
      type,
      ts_ns: ns(ts),
      run_id: makeRunId('run-evt-00'),
      session_id: makeSessionId('2026-04-23-rth'),
      payload: derivedPayload(type),
      ...(causationId === undefined ? {} : { causation_id: makeCausationId(causationId) }),
    }),
  );
}

function derivedPayload(type: RuntimeEventType): JsonValue {
  switch (type) {
    case 'FEATURES':
      return {
        feature_snapshot_id: 'feat-1',
        values: { sigma_pts: 4.5 },
      };
    case 'STRAT_EVAL':
      return {
        strategy_evaluation_id: 'eval-1',
        strategy_id: 'trend_pullback_long',
        feature_snapshot_id: 'feat-1',
        gate_state: 'armed',
        score: 0.72,
        reasons: ['fixture'],
      };
    case 'CANDIDATE':
      return {
        candidate_id: eventScopedId('candidate', type),
        strategy_id: 'trend_pullback_long',
        feature_snapshot_id: 'feat-1',
        direction: 'long',
        status: 'proposed',
        entry_price: 18501,
        stop_price: 18495,
        targets: [{ label: 'pt1', price: 18508, quantity_fraction: 0.5 }],
        confidence: 0.68,
        reasons: ['fixture'],
      };
    case 'RISK_GATE':
      return {
        risk_gate_decision_id: 'risk-1',
        candidate_id: 'candidate-CANDIDATE',
        status: 'pass',
        reasons: ['fixture'],
      };
    case 'ORDER_INTENT':
      return {
        order_intent_id: 'order-1',
        candidate_id: 'candidate-CANDIDATE',
        sizing_decision_id: 'sizing-1',
        side: 'buy',
        order_type: 'market',
        quantity: 1,
        time_in_force: 'ioc',
      };
    case 'SIM_FILL':
      return {
        fill_id: 'fill-1',
        order_intent_id: 'order-1',
        side: 'buy',
        quantity: 1,
        price: 18501.25,
        liquidity: 'taker',
        slippage_points: 0.25,
      };
    case 'EXEC_REJECT':
      return {
        execution_reject_id: 'exec-reject-order-1',
        order_intent_id: 'order-1',
        candidate_id: 'candidate-CANDIDATE',
        sizing_decision_id: 'sizing-1',
        status: 'rejected',
        reason: 'fixture_reject',
        execution_adapter: 'simulated',
        execution_version: 'simulated_execution_v1',
      };
    default:
      return {
        feature_snapshot_id: 'feat-1',
        values: { fixture: true },
      };
  }
}

function eventScopedId(prefix: string, type: RuntimeEventType): string {
  return `${prefix}-${type}`;
}

function systemEventLine(eventId: string, type: RuntimeEventType, ts: bigint): string {
  return journalEventToJsonLine(
    createJournalEventEnvelope({
      event_id: makeEventId(eventId),
      type,
      ts_ns: ns(ts),
      run_id: makeRunId('run-evt-00'),
      session_id: makeSessionId('2026-04-23-rth'),
      payload: {
        state: 'connected',
      } satisfies JsonValue,
    }),
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for journal transport watcher');
}

describe('EVT-00 JSONL journal transport', () => {
  it('file-watcher ingest preserves appended events in deterministic order', async () => {
    const directory = makeTempDir();
    const config = makeTransportConfig(directory);
    const ingested: IngestedJournalEvent[] = [];
    const ingestor = new JsonlJournalTransportIngestor(config, {
      onEvent: (event) => {
        ingested.push(event);
      },
    });
    const handle = await ingestor.start();

    try {
      writeFileSync(
        join(config.journal_dir, 'sidecar-session.jsonl'),
        `${eventLine('evt-1', 1)}${eventLine('evt-2', 2)}`,
        'utf8',
      );

      await waitFor(() => ingested.length === 2);

      expect(ingested.map((event) => event.event.event_id)).toEqual(['evt-1', 'evt-2']);
      expect(ingested.map((event) => event.source_file)).toEqual([
        'sidecar-session.jsonl',
        'sidecar-session.jsonl',
      ]);
      expect(ingested[0]?.event.run_id).toBe('run-evt-00');
      expect(ingested[0]?.event.session_id).toBe('2026-04-23-rth');
      expect(ingested[0]?.event.causation_id).toBe('cause-root');
      expect((ingested[0]?.event.payload as unknown as Record<string, unknown>).exchange_event_ts_ns).toBe(
        ingested[0]?.event.ts_ns,
      );
      expect(typeof (ingested[0]?.event.payload as unknown as Record<string, unknown>).sidecar_recv_ts_ns).toBe(
        'bigint',
      );
    } finally {
      await handle.stop();
    }
  });

  it('restart resumes from checkpoint without duplicate ingestion', async () => {
    const directory = makeTempDir();
    const config = makeTransportConfig(directory);
    const journalPath = join(config.journal_dir, 'sidecar-session.jsonl');
    const firstRunEvents: IngestedJournalEvent[] = [];
    const secondRunEvents: IngestedJournalEvent[] = [];

    const firstIngestor = new JsonlJournalTransportIngestor(config, {
      onEvent: (event) => {
        firstRunEvents.push(event);
      },
    });
    ensureJournalDir(config);
    writeFileSync(journalPath, eventLine('evt-1', 1), 'utf8');
    const firstPoll = await firstIngestor.pollOnce();

    const secondIngestor = new JsonlJournalTransportIngestor(config, {
      onEvent: (event) => {
        secondRunEvents.push(event);
      },
    });
    const replayPoll = await secondIngestor.pollOnce();
    appendFileSync(journalPath, eventLine('evt-2', 2), 'utf8');
    const appendedPoll = await secondIngestor.pollOnce();

    expect(firstPoll.events_ingested).toBe(1);
    expect(firstRunEvents.map((event) => event.event.event_id)).toEqual(['evt-1']);
    expect(replayPoll.events_ingested).toBe(0);
    expect(appendedPoll.events_ingested).toBe(1);
    expect(secondRunEvents.map((event) => event.event.event_id)).toEqual(['evt-2']);

    const checkpoint = JSON.parse(readFileSync(config.checkpoint_path, 'utf8')) as {
      files: Record<string, { line_number: number; last_event_id: string }>;
    };
    expect(checkpoint.files['sidecar-session.jsonl']).toMatchObject({
      line_number: 2,
      last_event_id: 'evt-2',
    });
  });

  it('quarantines malformed lines and continues ingesting later valid events', async () => {
    const directory = makeTempDir();
    const config = makeTransportConfig(directory);
    const ingested: IngestedJournalEvent[] = [];
    const quarantined: QuarantinedJournalLine[] = [];
    const ingestor = new JsonlJournalTransportIngestor(config, {
      onEvent: (event) => {
        ingested.push(event);
      },
      onMalformedLine: (line) => {
        quarantined.push(line);
      },
    });

    ensureJournalDir(config);
    writeFileSync(
      join(config.journal_dir, 'sidecar-session.jsonl'),
      `${eventLine('evt-1', 1)}{"schema_version":1,"type":"QUOTE"\n${eventLine('evt-2', 2)}`,
      'utf8',
    );
    const result = await ingestor.pollOnce();
    const replayResult = await ingestor.pollOnce();

    expect(result.events_ingested).toBe(2);
    expect(result.malformed_lines).toBe(1);
    expect(replayResult.events_ingested).toBe(0);
    expect(replayResult.malformed_lines).toBe(0);
    expect(ingested.map((event) => event.event.event_id)).toEqual(['evt-1', 'evt-2']);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toMatchObject({
      schema_version: 1,
      source_file: 'sidecar-session.jsonl',
      line_number: 2,
    });

    const quarantineFile = readFileSync(
      join(config.quarantine_dir, 'malformed-lines.jsonl'),
      'utf8',
    ).trim();
    expect(JSON.parse(quarantineFile)).toMatchObject({
      raw_line: '{"schema_version":1,"type":"QUOTE"',
      source_file: 'sidecar-session.jsonl',
    });
  });

  it('leaves partial trailing lines uncheckpointed until newline completion', async () => {
    const directory = makeTempDir();
    const config = makeTransportConfig(directory);
    const journalPath = join(config.journal_dir, 'sidecar-session.jsonl');
    const ingested: IngestedJournalEvent[] = [];
    const ingestor = new JsonlJournalTransportIngestor(config, {
      onEvent: (event) => {
        ingested.push(event);
      },
    });
    const completeLine = eventLine('evt-1', 1);
    const partialLine = eventLine('evt-2', 2).trimEnd();

    ensureJournalDir(config);
    writeFileSync(journalPath, `${completeLine}${partialLine}`, 'utf8');
    const firstPoll = await ingestor.pollOnce();
    appendFileSync(journalPath, '\n', 'utf8');
    const secondPoll = await ingestor.pollOnce();

    expect(firstPoll.events_ingested).toBe(1);
    expect(secondPoll.events_ingested).toBe(1);
    expect(ingested.map((event) => event.event.event_id)).toEqual(['evt-1', 'evt-2']);
  });

  it('rejects market-data events whose envelope ts_ns diverges from payload exchange_event_ts_ns', async () => {
    const directory = makeTempDir();
    const config = makeTransportConfig(directory);
    const quarantined: QuarantinedJournalLine[] = [];
    const exchangeTs = START_TS_NS;
    const badLine = journalEventToJsonLine(
      createJournalEventEnvelope({
        event_id: makeEventId('evt-bad-time'),
        type: 'QUOTE',
        ts_ns: ns(exchangeTs + 1n),
        run_id: makeRunId('run-evt-00'),
        session_id: makeSessionId('2026-04-23-rth'),
        payload: {
          exchange_event_ts_ns: ns(exchangeTs),
          sidecar_recv_ts_ns: ns(exchangeTs + 2_000_000n),
          bid_px: 18500.25,
          bid_qty: 12,
          ask_px: 18500.5,
          ask_qty: 9,
        } satisfies JsonValue,
      }),
    );
    const ingestor = new JsonlJournalTransportIngestor(config, {
      onEvent: () => {
        throw new Error('bad canonical timestamp event should not ingest');
      },
      onMalformedLine: (line) => {
        quarantined.push(line);
      },
    });

    ensureJournalDir(config);
    writeFileSync(join(config.journal_dir, 'sidecar-session.jsonl'), badLine, 'utf8');
    const result = await ingestor.pollOnce();

    expect(result.events_ingested).toBe(0);
    expect(result.malformed_lines).toBe(1);
    expect(quarantined[0]?.error).toBe(
      'market-data event ts_ns must equal payload.exchange_event_ts_ns',
    );
    expect(quarantined[0]?.error_message).toBe(
      'market-data event ts_ns must equal payload.exchange_event_ts_ns',
    );
  });

  it('quarantines source market-data events missing payload.exchange_event_ts_ns', async () => {
    const directory = makeTempDir();
    const config = makeTransportConfig(directory);
    const quarantined: QuarantinedJournalLine[] = [];
    const exchangeTs = START_TS_NS;
    const missingExchangeLine = journalEventToJsonLine(
      createJournalEventEnvelope({
        event_id: makeEventId('evt-missing-exchange'),
        type: 'QUOTE',
        ts_ns: ns(exchangeTs),
        run_id: makeRunId('run-evt-00'),
        session_id: makeSessionId('2026-04-23-rth'),
        payload: {
          sidecar_recv_ts_ns: ns(exchangeTs + 2_000_000n),
          bid_px: 18500.25,
          bid_qty: 12,
          ask_px: 18500.5,
          ask_qty: 9,
        } satisfies JsonValue,
      }),
    );
    const ingestor = new JsonlJournalTransportIngestor(config, {
      onEvent: () => {
        throw new Error('source market-data event without exchange timestamp should not ingest');
      },
      onMalformedLine: (line) => {
        quarantined.push(line);
      },
    });

    ensureJournalDir(config);
    writeFileSync(join(config.journal_dir, 'sidecar-session.jsonl'), missingExchangeLine, 'utf8');
    const result = await ingestor.pollOnce();

    expect(result.events_ingested).toBe(0);
    expect(result.malformed_lines).toBe(1);
    expect(quarantined[0]?.event_id).toBe('evt-missing-exchange');
    expect(quarantined[0]?.event_type).toBe('QUOTE');
    expect(quarantined[0]?.error_message).toContain('$.payload.exchange_event_ts_ns is required');
  });

  it('quarantines schema-invalid payload type mismatches before timestamp invariants', async () => {
    const directory = makeTempDir();
    const config = makeTransportConfig(directory);
    const quarantined: QuarantinedJournalLine[] = [];
    const ingestor = new JsonlJournalTransportIngestor(config, {
      onEvent: () => {
        throw new Error('schema-invalid event should not ingest');
      },
      onMalformedLine: (line) => {
        quarantined.push(line);
      },
    });

    ensureJournalDir(config);
    writeFileSync(
      join(config.journal_dir, 'sidecar-session.jsonl'),
      eventLine('evt-bad-payload', 1, 'cause-root', { bid_px: '18500.25' }),
      'utf8',
    );
    const result = await ingestor.pollOnce();

    expect(result.events_ingested).toBe(0);
    expect(result.malformed_lines).toBe(1);
    expect(quarantined[0]).toMatchObject({
      event_id: 'evt-bad-payload',
      event_type: 'QUOTE',
    });
    expect(quarantined[0]?.error_message).toContain('$.payload.bid_px must be a finite number');
  });

  it('accepts a CANDIDATE derived event with causation_id and matching STRAT_EVAL cause ts_ns', async () => {
    const directory = makeTempDir();
    const config = makeTransportConfig(directory);
    const ingested: IngestedJournalEvent[] = [];
    const sourceTs = START_TS_NS + 1_000_000n;
    const ingestor = new JsonlJournalTransportIngestor(config, {
      onEvent: (event) => {
        ingested.push(event);
      },
    });

    ensureJournalDir(config);
    writeFileSync(
      join(config.journal_dir, 'sidecar-session.jsonl'),
      `${eventLine('evt-source', 1)}${derivedEventLine('strat-1', 'STRAT_EVAL', sourceTs, 'evt-source')}${derivedEventLine('cand-1', 'CANDIDATE', sourceTs, 'strat-1')}`,
      'utf8',
    );
    const result = await ingestor.pollOnce();

    expect(result.events_ingested).toBe(3);
    expect(result.malformed_lines).toBe(0);
    expect(ingested.map((event) => event.event.event_id)).toEqual([
      'evt-source',
      'strat-1',
      'cand-1',
    ]);
    expect(ingested[1]?.event.ts_ns).toBe(ingested[0]?.event.ts_ns);
    expect(ingested[2]?.event.ts_ns).toBe(ingested[1]?.event.ts_ns);
  });

  it('accepts a SIM_FILL derived event with matching ORDER_INTENT causation ts_ns', async () => {
    const directory = makeTempDir();
    const config = makeTransportConfig(directory);
    const ingested: IngestedJournalEvent[] = [];
    const sourceTs = START_TS_NS + 1_000_000n;
    const ingestor = new JsonlJournalTransportIngestor(config, {
      onEvent: (event) => {
        ingested.push(event);
      },
    });

    ensureJournalDir(config);
    writeFileSync(
      join(config.journal_dir, 'sidecar-session.jsonl'),
      `${eventLine('evt-source', 1)}${derivedEventLine('cand-1', 'CANDIDATE', sourceTs, 'evt-source')}${derivedEventLine('order-1', 'ORDER_INTENT', sourceTs, 'cand-1')}${derivedEventLine('fill-1', 'SIM_FILL', sourceTs, 'order-1')}`,
      'utf8',
    );
    const result = await ingestor.pollOnce();

    expect(result.events_ingested).toBe(4);
    expect(result.malformed_lines).toBe(0);
    expect(ingested.map((event) => event.event.event_id)).toEqual([
      'evt-source',
      'cand-1',
      'order-1',
      'fill-1',
    ]);
    expect(ingested[3]?.event.ts_ns).toBe(ingested[2]?.event.ts_ns);
  });

  it('validates derived causation across deterministic journal file boundaries', async () => {
    const directory = makeTempDir();
    const config = makeTransportConfig(directory);
    const ingested: IngestedJournalEvent[] = [];
    const sourceTs = START_TS_NS + 1_000_000n;
    const ingestor = new JsonlJournalTransportIngestor(config, {
      onEvent: (event) => {
        ingested.push(event);
      },
    });

    ensureJournalDir(config);
    writeFileSync(join(config.journal_dir, '001-source.jsonl'), eventLine('evt-source', 1), 'utf8');
    writeFileSync(
      join(config.journal_dir, '002-derived.jsonl'),
      derivedEventLine('features-1', 'FEATURES', sourceTs, 'evt-source'),
      'utf8',
    );
    const result = await ingestor.pollOnce();

    expect(result.files_scanned).toEqual(['001-source.jsonl', '002-derived.jsonl']);
    expect(result.events_ingested).toBe(2);
    expect(result.malformed_lines).toBe(0);
    expect(ingested.map((event) => event.event.event_id)).toEqual(['evt-source', 'features-1']);
    expect(ingested[1]?.event.ts_ns).toBe(ingested[0]?.event.ts_ns);
  });

  it('quarantines a derived event with mismatched causation ts_ns', async () => {
    const directory = makeTempDir();
    const config = makeTransportConfig(directory);
    const quarantined: QuarantinedJournalLine[] = [];
    const sourceTs = START_TS_NS + 1_000_000n;
    const ingestor = new JsonlJournalTransportIngestor(config, {
      onEvent: () => undefined,
      onMalformedLine: (line) => {
        quarantined.push(line);
      },
    });

    ensureJournalDir(config);
    writeFileSync(
      join(config.journal_dir, 'sidecar-session.jsonl'),
      `${eventLine('evt-source', 1)}${derivedEventLine('cand-bad-ts', 'CANDIDATE', sourceTs + 1n, 'evt-source')}`,
      'utf8',
    );
    const result = await ingestor.pollOnce();

    expect(result.events_ingested).toBe(1);
    expect(result.malformed_lines).toBe(1);
    expect(quarantined[0]).toMatchObject({
      event_id: 'cand-bad-ts',
      causation_id: 'evt-source',
      event_type: 'CANDIDATE',
      error_message:
        'derived event CANDIDATE ts_ns must equal causation event evt-source ts_ns',
    });
  });

  it('quarantines derived events missing causation_id', async () => {
    const directory = makeTempDir();
    const config = makeTransportConfig(directory);
    const quarantined: QuarantinedJournalLine[] = [];
    const ingestor = new JsonlJournalTransportIngestor(config, {
      onEvent: () => undefined,
      onMalformedLine: (line) => {
        quarantined.push(line);
      },
    });

    ensureJournalDir(config);
    writeFileSync(
      join(config.journal_dir, 'sidecar-session.jsonl'),
      derivedEventLine('risk-no-cause', 'RISK_GATE', START_TS_NS, undefined),
      'utf8',
    );
    const result = await ingestor.pollOnce();

    expect(result.events_ingested).toBe(0);
    expect(result.malformed_lines).toBe(1);
    expect(quarantined[0]).toMatchObject({
      event_id: 'risk-no-cause',
      event_type: 'RISK_GATE',
    });
    expect(quarantined[0]?.error_message).toContain(
      '$.causation_id derived event RISK_GATE requires causation_id',
    );
  });

  it('quarantines derived events whose cause is absent from the recent buffer', async () => {
    const directory = makeTempDir();
    const config = makeTransportConfig(directory);
    const quarantined: QuarantinedJournalLine[] = [];
    const ingestor = new JsonlJournalTransportIngestor(config, {
      onEvent: () => undefined,
      onMalformedLine: (line) => {
        quarantined.push(line);
      },
    });

    ensureJournalDir(config);
    writeFileSync(
      join(config.journal_dir, 'sidecar-session.jsonl'),
      derivedEventLine('fill-missing-cause', 'SIM_FILL', START_TS_NS, 'order-not-seen'),
      'utf8',
    );
    const result = await ingestor.pollOnce();

    expect(result.events_ingested).toBe(0);
    expect(result.malformed_lines).toBe(1);
    expect(quarantined[0]).toMatchObject({
      event_id: 'fill-missing-cause',
      causation_id: 'order-not-seen',
      event_type: 'SIM_FILL',
      error_message:
        'derived event SIM_FILL causation_id order-not-seen is not in recent causation buffer',
    });
  });

  it('accepts system/control exempt events without causation_id', async () => {
    const directory = makeTempDir();
    const config = makeTransportConfig(directory);
    const ingested: IngestedJournalEvent[] = [];
    const ingestor = new JsonlJournalTransportIngestor(config, {
      onEvent: (event) => {
        ingested.push(event);
      },
    });

    ensureJournalDir(config);
    writeFileSync(
      join(config.journal_dir, 'sidecar-session.jsonl'),
      systemEventLine('conn-1', 'CONN', START_TS_NS),
      'utf8',
    );
    const result = await ingestor.pollOnce();

    expect(result.events_ingested).toBe(1);
    expect(result.malformed_lines).toBe(0);
    expect(ingested[0]?.event.type).toBe('CONN');
    expect(ingested[0]?.event.causation_id).toBeUndefined();
  });

  it('persists and evicts recent causation entries deterministically across restarts', async () => {
    const directory = makeTempDir();
    const config = {
      ...makeTransportConfig(directory),
      causation_buffer_capacity: 2,
    };
    const journalPath = join(config.journal_dir, 'sidecar-session.jsonl');
    const firstRunEvents: IngestedJournalEvent[] = [];
    const secondRunEvents: IngestedJournalEvent[] = [];
    const secondRunQuarantine: QuarantinedJournalLine[] = [];

    const firstIngestor = new JsonlJournalTransportIngestor(config, {
      onEvent: (event) => {
        firstRunEvents.push(event);
      },
    });
    ensureJournalDir(config);
    writeFileSync(
      journalPath,
      `${eventLine('evt-1', 1)}${eventLine('evt-2', 2)}${eventLine('evt-3', 3)}`,
      'utf8',
    );
    const firstResult = await firstIngestor.pollOnce();
    const firstCheckpoint = JSON.parse(readFileSync(config.checkpoint_path, 'utf8')) as {
      causation_buffer: readonly { event_id: string }[];
    };

    const secondIngestor = new JsonlJournalTransportIngestor(config, {
      onEvent: (event) => {
        secondRunEvents.push(event);
      },
      onMalformedLine: (line) => {
        secondRunQuarantine.push(line);
      },
    });
    appendFileSync(
      journalPath,
      `${derivedEventLine('cand-cause-2', 'CANDIDATE', START_TS_NS + 2_000_000n, 'evt-2')}${derivedEventLine('cand-cause-1', 'CANDIDATE', START_TS_NS + 1_000_000n, 'evt-1')}`,
      'utf8',
    );
    const secondResult = await secondIngestor.pollOnce();

    expect(firstResult.events_ingested).toBe(3);
    expect(firstCheckpoint.causation_buffer.map((entry) => entry.event_id)).toEqual([
      'evt-2',
      'evt-3',
    ]);
    expect(secondResult.events_ingested).toBe(1);
    expect(secondResult.malformed_lines).toBe(1);
    expect(secondRunEvents.map((event) => event.event.event_id)).toEqual(['cand-cause-2']);
    expect(secondRunQuarantine[0]).toMatchObject({
      event_id: 'cand-cause-1',
      causation_id: 'evt-1',
      error_message:
        'derived event CANDIDATE causation_id evt-1 is not in recent causation buffer',
    });
  });

  it('does not quarantine an incomplete malformed final line until it is newline-terminated', async () => {
    const directory = makeTempDir();
    const config = makeTransportConfig(directory);
    const journalPath = join(config.journal_dir, 'sidecar-session.jsonl');
    const quarantined: QuarantinedJournalLine[] = [];
    const ingestor = new JsonlJournalTransportIngestor(config, {
      onEvent: () => undefined,
      onMalformedLine: (line) => {
        quarantined.push(line);
      },
    });

    ensureJournalDir(config);
    writeFileSync(journalPath, `${eventLine('evt-1', 1)}{"schema_version":1`, 'utf8');
    const firstPoll = await ingestor.pollOnce();
    appendFileSync(journalPath, '\n', 'utf8');
    const secondPoll = await ingestor.pollOnce();

    expect(firstPoll.events_ingested).toBe(1);
    expect(firstPoll.malformed_lines).toBe(0);
    expect(firstPoll.checkpoint.files['sidecar-session.jsonl']).toMatchObject({
      line_number: 1,
      last_event_id: 'evt-1',
    });
    expect(secondPoll.events_ingested).toBe(0);
    expect(secondPoll.malformed_lines).toBe(1);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toMatchObject({
      line_number: 2,
      raw_line: '{"schema_version":1',
    });
  });

  it('tracks offsets in raw UTF-8 bytes instead of JavaScript string length', async () => {
    const directory = makeTempDir();
    const config = makeTransportConfig(directory);
    const journalPath = join(config.journal_dir, 'sidecar-session.jsonl');
    const firstLine = eventLine('evt-unicode', 1, 'cause-root', {
      note: 'microprice µ / rocket 🚀',
    });
    const malformedLine = '{"schema_version":1,"type":"QUOTE"';
    const quarantined: QuarantinedJournalLine[] = [];
    const ingestor = new JsonlJournalTransportIngestor(config, {
      onEvent: () => undefined,
      onMalformedLine: (line) => {
        quarantined.push(line);
      },
    });

    ensureJournalDir(config);
    writeFileSync(journalPath, `${firstLine}${malformedLine}\n`, 'utf8');
    const result = await ingestor.pollOnce();

    expect(result.events_ingested).toBe(1);
    expect(result.malformed_lines).toBe(1);
    expect(quarantined[0]).toMatchObject({
      byte_offset_start: Buffer.byteLength(firstLine, 'utf8'),
      byte_offset_end:
        Buffer.byteLength(firstLine, 'utf8') + Buffer.byteLength(`${malformedLine}\n`, 'utf8'),
    });
  });
});
