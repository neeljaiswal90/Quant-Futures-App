import type { Category, EconomicCalendar, EconomicCalendarEvent } from './economic-calendar.js';

/** Return all events on the provided `YYYY-MM-DD` date. */
export function findEventsOnDate(
  cal: EconomicCalendar,
  date: string,
): readonly EconomicCalendarEvent[] {
  return cal.events.filter((event) => event.event_date === date);
}

/** Return the first event on or after `fromDate`, optionally restricted by category. */
export function findNextEvent(
  cal: EconomicCalendar,
  fromDate: string,
  category?: Category,
): EconomicCalendarEvent | null {
  return cal.events.find((event) => (
    event.event_date >= fromDate && (category === undefined || event.category === category)
  )) ?? null;
}

/** Return the most recent event strictly before `beforeDate`, optionally restricted by category. */
export function findPriorEvent(
  cal: EconomicCalendar,
  beforeDate: string,
  category?: Category,
): EconomicCalendarEvent | null {
  for (let index = cal.events.length - 1; index >= 0; index -= 1) {
    const event = cal.events[index]!;
    if (event.event_date < beforeDate && (category === undefined || event.category === category)) {
      return event;
    }
  }
  return null;
}

/** Count events in an inclusive date range, optionally restricted by category. */
export function countEventsInRange(
  cal: EconomicCalendar,
  startDate: string,
  endDate: string,
  category?: Category,
): number {
  return cal.events.filter((event) => (
    event.event_date >= startDate
    && event.event_date <= endDate
    && (category === undefined || event.category === category)
  )).length;
}
