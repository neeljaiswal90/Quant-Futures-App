// Module under test: contracts/economic-calendar-queries; ticket QFA-111.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadEconomicCalendar } from '../../../src/config/index.js';
import {
  countEventsInRange,
  findEventsOnDate,
  findNextEvent,
  findPriorEvent,
} from '../../../src/contracts/index.js';
import type { EconomicCalendar } from '../../../src/contracts/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const fixturePath = join(
  repoRoot,
  'apps/strategy_runtime/tests/fixtures/economic-calendar/economic-calendar.fixture.yaml',
);

describe('QFA-111 economic calendar query helpers', () => {
  it('finds all events on an exact date', () => {
    const calendar = loadEconomicCalendar(fixturePath);
    const events = findEventsOnDate(calendar, '2026-01-13');

    expect(events.map((event) => event.category)).toEqual(['CPI']);
    expect(findEventsOnDate(calendar, '2099-01-01')).toEqual([]);
  });

  it('finds the next event with inclusive boundary semantics', () => {
    const calendar = loadEconomicCalendar(fixturePath);

    expect(findNextEvent(calendar, '2026-01-13')?.event_id).toBe('cpi-2026-01-13');
    expect(findNextEvent(calendar, '2026-01-13', 'OPEC')?.event_id).toBe('opec-2026-02-03');
    expect(findNextEvent(calendar, '2027-01-01')).toBeNull();
  });

  it('finds the prior event with strict before-date semantics', () => {
    const calendar = loadEconomicCalendar(fixturePath);

    expect(findPriorEvent(calendar, '2026-01-13')?.event_id).toBe('nfp-2026-01-09');
    expect(findPriorEvent(calendar, '2026-01-13', 'CPI')?.event_id).toBe('cpi-2025-12-18');
    expect(findPriorEvent(calendar, '2025-01-01')).toBeNull();
  });

  it('counts events in inclusive date ranges', () => {
    const calendar = loadEconomicCalendar(fixturePath);

    expect(countEventsInRange(calendar, '2026-01-01', '2026-01-31')).toBe(3);
    expect(countEventsInRange(calendar, '2026-01-01', '2026-01-31', 'OPEC')).toBe(0);
    expect(countEventsInRange(calendar, '2024-01-01', '2024-12-31')).toBe(0);
  });

  it('handles empty calendars without throwing', () => {
    const empty: EconomicCalendar = {
      version: 1,
      schema_version: 1,
      source: 'manual_curation',
      editorial_notes: 'empty fixture',
      events: [],
    };

    expect(findEventsOnDate(empty, '2026-01-01')).toEqual([]);
    expect(findNextEvent(empty, '2026-01-01')).toBeNull();
    expect(findPriorEvent(empty, '2026-01-01')).toBeNull();
    expect(countEventsInRange(empty, '2026-01-01', '2026-12-31')).toBe(0);
  });
});
