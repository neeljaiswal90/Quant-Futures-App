// Module under test: config/economic-calendar-loader; ticket QFA-111.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigValidationError, loadEconomicCalendar } from '../../../src/config/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const fixturePath = join(
  repoRoot,
  'apps/strategy_runtime/tests/fixtures/economic-calendar/economic-calendar.fixture.yaml',
);
const fullCalendarPath = join(repoRoot, 'config/research/economic-calendar.yaml');
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('QFA-111 economic calendar loader', () => {
  it('round-trip loads a manually curated calendar fixture', () => {
    const calendar = loadEconomicCalendar(fixturePath);

    expect(calendar).toMatchObject({
      version: 1,
      schema_version: 1,
      source: 'manual_curation',
    });
    expect(calendar.events).toHaveLength(8);
    expect(calendar.events[0]).toMatchObject({
      event_id: 'nfp-2025-12-05',
      category: 'NFP',
      event_date: '2025-12-05',
      authoritative_source: 'https://www.bls.gov/bls/news-release/empsit.htm',
    });
    expect(calendar.config_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(calendar.config_hash_algorithm).toBe('sha256');
    expect(Object.isFrozen(calendar)).toBe(true);
    expect(Object.isFrozen(calendar.events)).toBe(true);
  });

  it('keeps the config hash stable across repeated loads', () => {
    expect(loadEconomicCalendar(fixturePath).config_hash).toBe(loadEconomicCalendar(fixturePath).config_hash);
  });

  it('keeps the config hash stable across path and comment-only formatting changes', () => {
    const directory = makeTempDirectory();
    const firstPath = join(directory, 'one', 'economic-calendar.yaml');
    const secondPath = join(directory, 'two', 'renamed-economic-calendar.yaml');
    const text = readFileSync(fixturePath, 'utf8');
    writeNestedFile(firstPath, text);
    writeNestedFile(secondPath, `# path-agnostic copied fixture\n${text}\n`);

    expect(loadEconomicCalendar(firstPath).config_hash).toBe(loadEconomicCalendar(secondPath).config_hash);
  });

  it('loads the full source-backed calendar and validates locked category counts', () => {
    const calendar = loadEconomicCalendar(fullCalendarPath);
    const counts = countByCategory(calendar.events);

    expect(counts).toEqual({
      FOMC: 142,
      CPI: 216,
      NFP: 208,
      OPEC: 101,
    });
    expect(calendar.events).toHaveLength(667);
  });

  it('rejects an invalid event date with a descriptive path', () => {
    writeText(
      'bad-date.yaml',
      fixtureText().replace('event_date: 2025-12-05', 'event_date: 2025-13-05'),
    );

    expectInvalid('bad-date.yaml', 'economic_calendar.events.0.event_date');
  });

  it('rejects an unknown category with a descriptive path', () => {
    writeText('bad-category.yaml', fixtureText().replace('category: NFP', 'category: GDP'));

    expectInvalid('bad-category.yaml', 'economic_calendar.events.0.category');
  });

  it('rejects an event_id that does not match category and date', () => {
    writeText('bad-event-id.yaml', fixtureText().replace('event_id: nfp-2025-12-05', 'event_id: cpi-2025-12-05'));

    expectInvalid('bad-event-id.yaml', 'economic_calendar.events.0.event_id');
  });

  it('rejects missing source metadata with a descriptive path', () => {
    writeText(
      'missing-source.yaml',
      fixtureText().replace('    authoritative_source: https://www.bls.gov/bls/news-release/empsit.htm\n', ''),
    );

    expectInvalid('missing-source.yaml', 'economic_calendar.events.0.authoritative_source');
  });

  it('rejects unsorted events with a descriptive path', () => {
    writeText(
      'unsorted.yaml',
      fixtureText()
        .replace('event_date: 2025-12-05', 'event_date: 2025-12-20')
        .replace('event_id: nfp-2025-12-05', 'event_id: nfp-2025-12-20'),
    );

    expectInvalid('unsorted.yaml', 'economic_calendar.events.1.event_date');
  });
});

function countByCategory(events: readonly { readonly category: string }[]): Record<string, number> {
  return events.reduce<Record<string, number>>((counts, event) => {
    counts[event.category] = (counts[event.category] ?? 0) + 1;
    return counts;
  }, {});
}

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-economic-calendar-'));
  tempDirectories.push(directory);
  return directory;
}

function writeNestedFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function writeText(fileName: string, text: string): string {
  const path = join(makeTempDirectory(), fileName);
  writeFileSync(path, text, 'utf8');
  return path;
}

function expectInvalid(fileName: string, expectedPath: string): void {
  const path = join(tempDirectories[tempDirectories.length - 1]!, fileName);
  expect(() => loadEconomicCalendar(path)).toThrow(ConfigValidationError);
  try {
    loadEconomicCalendar(path);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect((error as ConfigValidationError).message).toContain(expectedPath);
  }
}

function fixtureText(): string {
  return readFileSync(fixturePath, 'utf8');
}
