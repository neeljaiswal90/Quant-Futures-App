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
        ask_px: 18500.5,
        ...extraPayload,
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
      expect((ingested[0]?.event.payload as Record<string, unknown>).exchange_event_ts_ns).toBe(
        ingested[0]?.event.ts_ns,
      );
      expect(typeof (ingested[0]?.event.payload as Record<string, unknown>).sidecar_recv_ts_ns).toBe(
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
