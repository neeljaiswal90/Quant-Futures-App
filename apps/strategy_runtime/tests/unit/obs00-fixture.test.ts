import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  journalEventFromJsonLine,
  validateJournalEventEnvelope,
  type RuntimeEventType,
} from '../../src/contracts/index.js';
import { formatJournalJsonl } from '../../src/operator/formatter.js';
import {
  createJournalTransportConfig,
  JsonlJournalTransportIngestor,
  type IngestedJournalEvent,
  type QuarantinedJournalLine,
} from '../../src/transport/index.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(TEST_DIR, '..', 'fixtures', 'obs00');
const JOURNAL_PATH = join(FIXTURE_DIR, 'mini-journal.jsonl');
const MANIFEST_PATH = join(FIXTURE_DIR, 'manifest.json');
const REQUIRED_EVENT_TYPES: readonly RuntimeEventType[] = [
  'CONN',
  'FEED',
  'QUOTE',
  'TRADE',
  'BAR_CLOSE',
  'FEATURES',
  'STRUCTURE',
  'MICROSTRUCTURE',
  'STRAT_EVAL',
  'CANDIDATE',
  'RISK_GATE',
  'SIZING',
  'SIM_FILL',
  'POSITION',
  'MGMT_TICK',
  'GAP',
  'BOOK_REBUILD',
];

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Obs00Manifest {
  readonly fixture_id: string;
  readonly journal_file: string;
  readonly schema_version: number;
  readonly event_count: number;
  readonly first_event_ts_ns: string;
  readonly last_event_ts_ns: string;
  readonly journal_sha256_lf: string;
  readonly redaction_statement: string;
  readonly event_types: readonly string[];
}

function readFixtureJournal(): string {
  return readFileSync(JOURNAL_PATH, 'utf8').replace(/\r\n/g, '\n');
}

function readManifest(): Obs00Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Obs00Manifest;
}

function fixtureLines(): readonly string[] {
  return readFixtureJournal().trimEnd().split('\n');
}

describe('OBS-00 mini-journal fixture', () => {
  it('matches the committed manifest count and normalized checksum', () => {
    const manifest = readManifest();
    const journal = readFixtureJournal();
    const checksum = createHash('sha256').update(journal, 'utf8').digest('hex');

    expect(manifest.fixture_id).toBe('obs00-mini-journal-v1');
    expect(manifest.journal_file).toBe('mini-journal.jsonl');
    expect(manifest.schema_version).toBe(1);
    expect(manifest.first_event_ts_ns).toBe('1700000000000000000');
    expect(manifest.last_event_ts_ns).toBe('1700000001361000000');
    expect(fixtureLines()).toHaveLength(manifest.event_count);
    expect(checksum).toBe(manifest.journal_sha256_lf);
    expect(manifest.redaction_statement).toContain('No credentials');
  });

  it('contains the required OBS-00 event coverage and valid OBS-01 schemas', () => {
    const events = fixtureLines().map((line) => {
      const event = journalEventFromJsonLine(line);
      const validation = validateJournalEventEnvelope(event);
      expect(validation.issues).toEqual([]);
      expect(validation.ok).toBe(true);
      return event;
    });
    const eventTypes = new Set(events.map((event) => event.type));
    const manifest = readManifest();

    for (const requiredType of REQUIRED_EVENT_TYPES) {
      expect(eventTypes.has(requiredType)).toBe(true);
      expect(manifest.event_types).toContain(requiredType);
    }
  });

  it('formats deterministically across consecutive fixture runs', () => {
    const journal = readFixtureJournal();
    const first = formatJournalJsonl(journal);
    const second = formatJournalJsonl(journal);

    expect(first.exit_code).toBe(0);
    expect(first.stderr).toBe('');
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout).not.toContain('\u001b[');
    expect(first.stdout).toContain('state=warming');
    expect(first.stdout).toContain(' CANDIDATE ');
    expect(first.stdout).toContain(' SIM_FILL ');
    expect(first.stdout).toContain(' BOOK_REBUILD ');
  });

  it('supports fixture-backed formatter filters for candidate, fill, and position slices', () => {
    const result = formatJournalJsonl(readFixtureJournal(), {
      color: false,
      only_types: ['CANDIDATE', 'POSITION', 'SIM_FILL'],
    });
    const lines = result.stdout.trimEnd().split('\n');

    expect(result.exit_code).toBe(0);
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.split(' event=')[1]?.split(' ')[0])).toEqual([
      'candidate-1',
      'fill-1',
      'position-1',
    ]);
  });

  it('ingests through the JSONL transport without recomputing or quarantining events', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'qfa-obs00-fixture-'));
    tempDirectories.push(directory);
    const config = createJournalTransportConfig(join(directory, 'journal'));
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

    mkdirSync(config.journal_dir, { recursive: true });
    writeFileSync(join(config.journal_dir, 'obs00-mini-journal.jsonl'), readFixtureJournal(), 'utf8');
    const result = await ingestor.pollOnce();

    expect(result.events_ingested).toBe(readManifest().event_count);
    expect(result.malformed_lines).toBe(0);
    expect(quarantined).toEqual([]);
    expect(ingested.map((event) => event.event.event_id)).toEqual(
      fixtureLines().map((line) => journalEventFromJsonLine(line).event_id),
    );
    expect(ingested.map((event) => event.event.event_id)).toContain('candidate-1');
    expect(ingested.map((event) => event.event.event_id)).toContain('fill-1');
    expect(ingested.map((event) => event.event.event_id)).toContain('book-rebuild-1');
  });
});
