import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAppConfig } from '../../src/config/index.js';
import {
  createJournalEventEnvelope,
  journalEventFromJsonLine,
  makeCausationId,
  makeEventId,
  makeRunId,
  makeSessionId,
  ns,
  type JournalEventEnvelope,
  type JsonValue,
} from '../../src/contracts/index.js';
import {
  RuntimeEventBus,
  createStrategyRuntimeEngineContainer,
  type RuntimeEventBusDelivery,
} from '../../src/orchestration/index.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(TEST_DIR, '..', 'fixtures', 'obs00');
const JOURNAL_PATH = join(FIXTURE_DIR, 'mini-journal.jsonl');
const MANIFEST_PATH = join(FIXTURE_DIR, 'manifest.json');
const RUN_ID = makeRunId('run-orch-01');
const SESSION_ID = makeSessionId('2026-04-23-rth');
const TS_1 = ns(1_700_000_000_000_000_000n);
const TS_2 = ns(1_700_000_000_001_000_000n);

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Obs00Manifest {
  readonly event_count: number;
  readonly last_event_ts_ns: string;
}

function readFixtureJournal(): string {
  return readFileSync(JOURNAL_PATH, 'utf8').replace(/\r\n/g, '\n');
}

function readManifest(): Obs00Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Obs00Manifest;
}

function quoteEvent(eventId = 'quote-1', ts = TS_1): JournalEventEnvelope<'QUOTE', JsonValue> {
  return createJournalEventEnvelope({
    event_id: makeEventId(eventId),
    type: 'QUOTE',
    ts_ns: ts,
    run_id: RUN_ID,
    session_id: SESSION_ID,
    payload: {
      exchange_event_ts_ns: ts,
      sidecar_recv_ts_ns: ns(BigInt(ts) + 500_000n),
      bid_px: 18500.25,
      bid_qty: 12,
      ask_px: 18500.5,
      ask_qty: 8,
      authority: 'authoritative',
    } satisfies JsonValue,
  });
}

function featureEvent(
  causeId = 'quote-1',
  ts = TS_1,
): JournalEventEnvelope<'FEATURES', JsonValue> {
  return createJournalEventEnvelope({
    event_id: makeEventId('features-1'),
    type: 'FEATURES',
    ts_ns: ts,
    run_id: RUN_ID,
    session_id: SESSION_ID,
    causation_id: makeCausationId(causeId),
    payload: {
      feature_snapshot_id: 'feature-1',
      source_event_id: causeId,
      values: {
        ema9: 18500.75,
      },
    } satisfies JsonValue,
  });
}

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

describe('ORCH-01 runtime event bus and engine container', () => {
  it('routes events through TUI-01 channels in deterministic subscriber order', async () => {
    const bus = new RuntimeEventBus();
    const deliveries: string[] = [];
    bus.subscribeToSubscriberProfile('TUI', (delivery) => {
      deliveries.push(`tui:${delivery.sequence}:${delivery.event.type}:${delivery.channels.join('|')}`);
    });
    bus.subscribe({ channels: ['QUOTE_RAW'] }, (delivery) => {
      deliveries.push(`raw:${delivery.sequence}:${delivery.event.type}:${delivery.channels.join('|')}`);
    });
    bus.subscribe({ event_types: ['QUOTE'] }, (delivery) => {
      deliveries.push(`type:${delivery.sequence}:${delivery.event.type}`);
    });

    const result = await bus.publish(quoteEvent());

    expect(result.channels).toEqual(['MARKET', 'QUOTE_RAW']);
    expect(result.subscriber_count).toBe(3);
    expect(deliveries).toEqual([
      'tui:1:QUOTE:MARKET|QUOTE_RAW',
      'raw:1:QUOTE:MARKET|QUOTE_RAW',
      'type:1:QUOTE',
    ]);
    expect(bus.getHeadTsNs()).toBe(TS_1);
  });

  it('enforces source market-data canonical timestamps', async () => {
    const bus = new RuntimeEventBus();
    const mismatched = createJournalEventEnvelope({
      ...quoteEvent(),
      ts_ns: TS_2,
    });

    await expect(bus.publish(mismatched)).rejects.toThrow(
      'source market-data event ts_ns must equal payload.exchange_event_ts_ns',
    );
    expect(bus.snapshot().published_events).toBe(0);
  });

  it('enforces derived-event causation timestamp inheritance', async () => {
    const bus = new RuntimeEventBus();
    await bus.publish(quoteEvent());
    await expect(bus.publish(featureEvent())).resolves.toMatchObject({
      sequence: 2,
      subscriber_count: 0,
    });

    await expect(new RuntimeEventBus().publish(featureEvent())).rejects.toThrow(
      'causation_id quote-1 is not in event bus causation buffer',
    );

    const mismatchBus = new RuntimeEventBus();
    await mismatchBus.publish(quoteEvent());
    await expect(mismatchBus.publish(featureEvent('quote-1', TS_2))).rejects.toThrow(
      'derived event FEATURES ts_ns must equal causation event ts_ns',
    );
  });

  it('allows handlers to publish derived events caused by the currently delivered event', async () => {
    const bus = new RuntimeEventBus();
    const seen: string[] = [];
    bus.subscribe({ event_types: ['QUOTE'] }, async (delivery) => {
      seen.push(delivery.event.event_id);
      await bus.publish(featureEvent(String(delivery.event.event_id), delivery.event.ts_ns));
    });
    bus.subscribe({ event_types: ['FEATURES'] }, (delivery) => {
      seen.push(delivery.event.event_id);
    });

    await bus.publish(quoteEvent());

    expect(seen).toEqual(['quote-1', 'features-1']);
    expect(bus.snapshot().published_events).toBe(2);
  });

  it('deterministically evicts old causation entries by capacity', async () => {
    const bus = new RuntimeEventBus({ causation_buffer_capacity: 1 });
    await bus.publish(quoteEvent('quote-1', TS_1));
    await bus.publish(quoteEvent('quote-2', TS_2));

    await expect(bus.publish(featureEvent('quote-1', TS_1))).rejects.toThrow(
      'causation_id quote-1 is not in event bus causation buffer',
    );
    await expect(bus.publish(featureEvent('quote-2', TS_2))).resolves.toMatchObject({
      sequence: 3,
    });
  });

  it('creates an engine container from loaded config and publishes transport-ingested fixture events', async () => {
    const directory = tempDir('qfa-orch-01-');
    const journalDir = join(directory, 'journal');
    const config = loadAppConfig({
      configPath: 'config/app.example.json',
      cwd: process.cwd(),
      env: {
        QFA_JOURNAL_DIR: journalDir,
      },
    });
    const container = createStrategyRuntimeEngineContainer({ config });
    const tuiDeliveries: RuntimeEventBusDelivery[] = [];
    const allDeliveries: RuntimeEventBusDelivery[] = [];
    container.eventBus.subscribeToSubscriberProfile('TUI', (delivery) => {
      tuiDeliveries.push(delivery);
    });
    container.eventBus.subscribe({}, (delivery) => {
      allDeliveries.push(delivery);
    });
    const ingestor = container.createJournalIngestor();

    mkdirSync(container.journalTransportConfig.journal_dir, { recursive: true });
    writeFileSync(
      join(container.journalTransportConfig.journal_dir, 'obs00-mini-journal.jsonl'),
      readFixtureJournal(),
      'utf8',
    );
    const result = await ingestor.pollOnce();

    expect(result.events_ingested).toBe(readManifest().event_count);
    expect(result.malformed_lines).toBe(0);
    expect(allDeliveries).toHaveLength(readManifest().event_count);
    expect(tuiDeliveries).toHaveLength(readManifest().event_count - 1);
    expect(tuiDeliveries.map((delivery) => delivery.event.type)).not.toContain('CONFIG');
    expect(container.eventBus.getHeadTsNs()?.toString()).toBe(readManifest().last_event_ts_ns);
    expect(container.journalTransportConfig.journal_dir).toBe(journalDir);
  });

  it('keeps the bus pure and rejects schema-invalid events before delivery', async () => {
    const bus = new RuntimeEventBus();
    const delivered: JournalEventEnvelope[] = [];
    bus.subscribe({}, (delivery) => {
      delivered.push(delivery.event);
    });

    const invalid = journalEventFromJsonLine(
      '{"event_id":"bad","run_id":"run","session_id":"session","schema_version":1,"type":"QUOTE","ts_ns":"1700000000000000000","payload":{"exchange_event_ts_ns":"1700000000000000000","sidecar_recv_ts_ns":"1700000000000000000","bid_px":"bad","bid_qty":1,"ask_px":2,"ask_qty":3}}',
    );

    await expect(bus.publish(invalid)).rejects.toThrow(
      'journal event schema validation failed',
    );
    expect(delivered).toEqual([]);
    expect(bus.snapshot()).toEqual({
      published_events: 0,
      active_subscriptions: 1,
      head_ts_ns: undefined,
      causation_buffer_size: 0,
    });
  });
});
