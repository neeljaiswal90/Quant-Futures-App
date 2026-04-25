import type { ConfigValidationIssue } from '../config/types.js';
import { ns, type UnixNs } from '../contracts/time.js';

export const MINUTE_NS = 60_000_000_000n;
const SECOND_NS = 1_000_000_000n;
const SECONDS_PER_DAY = 86_400;

export interface ClockTime {
  readonly hour: number;
  readonly minute: number;
  readonly minute_of_day: number;
}

export interface LocalDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface NewYorkLocalTime extends LocalDateParts {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly day_of_week: number;
  readonly minute_of_day: number;
  readonly date: string;
  readonly time: string;
  readonly utc_offset_minutes: -300 | -240;
}

export function parseConfigUnixNs(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
): UnixNs {
  if (typeof value !== 'string') {
    issues.push({ path, message: 'expected decimal string nanosecond timestamp' });
    return ns(0);
  }
  try {
    return ns(value);
  } catch {
    issues.push({ path, message: 'expected unsigned decimal nanosecond timestamp' });
    return ns(0);
  }
}

export function compareUnixNs(left: UnixNs, right: UnixNs): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function addMinutesToUnixNs(timestamp: UnixNs, minutes: number): UnixNs {
  return ns((timestamp as bigint) + BigInt(minutes) * MINUTE_NS);
}

export function parseClockTime(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
): ClockTime {
  if (typeof value !== 'string') {
    issues.push({ path, message: 'expected HH:MM clock time' });
    return { hour: 0, minute: 0, minute_of_day: 0 };
  }
  const match = /^([0-2][0-9]):([0-5][0-9])$/.exec(value);
  if (match === null) {
    issues.push({ path, message: 'expected HH:MM clock time' });
    return { hour: 0, minute: 0, minute_of_day: 0 };
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23) {
    issues.push({ path, message: 'hour must be <= 23' });
  }
  return { hour, minute, minute_of_day: hour * 60 + minute };
}

export function isMinuteInWindow(
  minuteOfDay: number,
  startMinute: number,
  endMinute: number,
): boolean {
  if (startMinute === endMinute) {
    return true;
  }
  if (startMinute < endMinute) {
    return minuteOfDay >= startMinute && minuteOfDay < endMinute;
  }
  return minuteOfDay >= startMinute || minuteOfDay < endMinute;
}

export function unixNsToNewYorkLocalTime(timestamp: UnixNs): NewYorkLocalTime {
  const utcSeconds = Number((timestamp as bigint) / SECOND_NS);
  const utcOffsetMinutes = isNewYorkDstAtUtc(utcSeconds) ? -240 : -300;
  const localSeconds = utcSeconds + utcOffsetMinutes * 60;
  const parts = unixSecondsToUtcParts(localSeconds);
  const minuteOfDay = parts.hour * 60 + parts.minute;
  return {
    ...parts,
    day_of_week: dayOfWeekFromDays(daysFromCivil(parts.year, parts.month, parts.day)),
    minute_of_day: minuteOfDay,
    date: formatDate(parts),
    time: formatClock(parts.hour, parts.minute),
    utc_offset_minutes: utcOffsetMinutes,
  };
}

export function newYorkLocalTimeToUnixNs(
  date: LocalDateParts,
  minuteOfDay: number,
): UnixNs {
  const offsetMinutes = isNewYorkDstAtLocal(date.year, date.month, date.day, minuteOfDay)
    ? -240
    : -300;
  const localSeconds = utcEpochSecondsFromParts(
    date.year,
    date.month,
    date.day,
    Math.floor(minuteOfDay / 60),
    minuteOfDay % 60,
    0,
  );
  return ns(BigInt(localSeconds - offsetMinutes * 60) * SECOND_NS);
}

export function addDaysToDate(date: LocalDateParts, days: number): LocalDateParts {
  return civilFromDays(daysFromCivil(date.year, date.month, date.day) + days);
}

export function formatDate(date: LocalDateParts): string {
  return `${date.year.toString().padStart(4, '0')}-${date.month
    .toString()
    .padStart(2, '0')}-${date.day.toString().padStart(2, '0')}`;
}

function unixSecondsToUtcParts(seconds: number): LocalDateParts & {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
} {
  const days = Math.floor(seconds / SECONDS_PER_DAY);
  const secondsOfDay = positiveModulo(seconds, SECONDS_PER_DAY);
  const date = civilFromDays(days);
  return {
    ...date,
    hour: Math.floor(secondsOfDay / 3_600),
    minute: Math.floor((secondsOfDay % 3_600) / 60),
    second: secondsOfDay % 60,
  };
}

function isNewYorkDstAtUtc(utcSeconds: number): boolean {
  const { year } = unixSecondsToUtcParts(utcSeconds);
  const startDay = nthWeekdayOfMonth(year, 3, 0, 2);
  const endDay = nthWeekdayOfMonth(year, 11, 0, 1);
  const startUtc = utcEpochSecondsFromParts(year, 3, startDay, 7, 0, 0);
  const endUtc = utcEpochSecondsFromParts(year, 11, endDay, 6, 0, 0);
  return utcSeconds >= startUtc && utcSeconds < endUtc;
}

function isNewYorkDstAtLocal(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
): boolean {
  if (month < 3 || month > 11) return false;
  if (month > 3 && month < 11) return true;
  if (month === 3) {
    const startDay = nthWeekdayOfMonth(year, 3, 0, 2);
    if (day < startDay) return false;
    if (day > startDay) return true;
    return minuteOfDay >= 120;
  }
  const endDay = nthWeekdayOfMonth(year, 11, 0, 1);
  if (day < endDay) return true;
  if (day > endDay) return false;
  return minuteOfDay < 120;
}

function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  occurrence: number,
): number {
  const firstDay = daysFromCivil(year, month, 1);
  const firstDow = dayOfWeekFromDays(firstDay);
  return 1 + positiveModulo(weekday - firstDow, 7) + (occurrence - 1) * 7;
}

function dayOfWeekFromDays(days: number): number {
  return positiveModulo(days + 4, 7);
}

function utcEpochSecondsFromParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number {
  return daysFromCivil(year, month, day) * SECONDS_PER_DAY + hour * 3_600 + minute * 60 + second;
}

function civilFromDays(daysSinceEpoch: number): LocalDateParts {
  let z = daysSinceEpoch + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  let year = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  year += month <= 2 ? 1 : 0;
  z = 0;
  return { year, month, day };
}

function daysFromCivil(yearInput: number, month: number, day: number): number {
  let year = yearInput;
  year -= month <= 2 ? 1 : 0;
  const era = Math.floor(year / 400);
  const yoe = year - era * 400;
  const monthPrime = month + (month > 2 ? -3 : 9);
  const doy = Math.floor((153 * monthPrime + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function formatClock(hour: number, minute: number): string {
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
}
