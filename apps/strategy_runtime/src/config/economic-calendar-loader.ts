import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type {
  Category,
  EconomicCalendar,
  EconomicCalendarEvent,
  LoadedEconomicCalendar,
  MarketImpactClass,
} from '../contracts/economic-calendar.js';
import { ConfigValidationError } from './errors.js';
import { stableStringify } from './hash.js';
import { checkUnknownKeys, parseSimpleYaml, throwIfIssues } from './simple-yaml.js';
import type { ConfigValidationIssue } from './types.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const TIME_PATTERN = /^\d{2}:\d{2}:\d{2}$/u;
const HTTPS_URL_PATTERN = /^https:\/\/\S+$/u;
const CATEGORIES = ['FOMC', 'CPI', 'NFP', 'OPEC'] as const;
const MARKET_IMPACT_CLASSES = ['high', 'medium', 'low'] as const;
const ROOT_KEYS = ['version', 'schema_version', 'source', 'editorial_notes', 'events'] as const;
const EVENT_KEYS = [
  'event_id',
  'category',
  'event_date',
  'event_time_utc',
  'description',
  'authoritative_source',
  'market_impact_class',
  'surprise_factor',
] as const;

/** Load, validate, hash, and freeze the manually curated economic calendar. */
export function loadEconomicCalendar(path: string): LoadedEconomicCalendar {
  let parsed: unknown;
  try {
    parsed = parseSimpleYaml(
      readFileSync(path, 'utf8'),
      path,
      'Invalid economic calendar',
    );
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError(
      [{ path: 'economic_calendar.path', message: `cannot read or parse ${path}: ${message}` }],
      'Invalid economic calendar',
    );
  }

  const issues: ConfigValidationIssue[] = [];
  validateEconomicCalendar(parsed, 'economic_calendar', issues);
  throwIfIssues(issues, 'Invalid economic calendar');

  const calendar = parsed as EconomicCalendar;
  const canonical = stableStringify(calendar);
  const loaded: LoadedEconomicCalendar = {
    ...calendar,
    config_hash: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    config_hash_algorithm: 'sha256',
    canonical_config_json: canonical,
  };
  return deepFreeze(loaded);
}

function validateEconomicCalendar(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
): asserts value is EconomicCalendar {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }
  checkUnknownKeys(value, path, ROOT_KEYS, issues);
  requireExactNumber(value, 'version', 1, path, issues);
  requireExactNumber(value, 'schema_version', 1, path, issues);
  requireExactString(value, 'source', 'manual_curation', path, issues);
  requireNonEmptyString(value, 'editorial_notes', path, issues);
  validateEvents(value.events, `${path}.events`, issues);
}

function validateEvents(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
): asserts value is readonly EconomicCalendarEvent[] {
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'must be an array' });
    return;
  }

  let priorDate: string | null = null;
  const eventIds = new Set<string>();
  value.forEach((item, index) => {
    const itemPath = `${path}.${index}`;
    if (!isRecord(item)) {
      issues.push({ path: itemPath, message: 'must be an object' });
      return;
    }
    checkUnknownKeys(item, itemPath, EVENT_KEYS, issues);
    validateEvent(item, itemPath, issues);
    if (typeof item.event_id === 'string') {
      if (eventIds.has(item.event_id)) {
        issues.push({ path: `${itemPath}.event_id`, message: 'must be unique' });
      }
      eventIds.add(item.event_id);
    }
    if (typeof item.event_date === 'string') {
      if (priorDate !== null && item.event_date < priorDate) {
        issues.push({ path: `${itemPath}.event_date`, message: 'events must be sorted by event_date ascending' });
      }
      priorDate = item.event_date;
    }
  });
}

function validateEvent(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
): asserts value is EconomicCalendarEvent {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }

  const category = requireCategory(value, 'category', path, issues);
  const eventDate = requireValidDate(value, 'event_date', path, issues);
  const eventId = requireNonEmptyString(value, 'event_id', path, issues);
  requireEventTime(value, 'event_time_utc', path, issues);
  requireNonEmptyString(value, 'description', path, issues);
  requireAuthoritativeSource(value, 'authoritative_source', path, issues);

  if (category !== null && eventDate !== null && eventId !== null) {
    const expectedId = `${category.toLowerCase()}-${eventDate}`;
    if (eventId !== expectedId) {
      issues.push({ path: `${path}.event_id`, message: `must be ${expectedId}` });
    }
  }

  if ('market_impact_class' in value) {
    requireMarketImpactClass(value, 'market_impact_class', path, issues);
  }
  if ('surprise_factor' in value) {
    const surpriseFactor = value.surprise_factor;
    if (typeof surpriseFactor !== 'number' || !Number.isFinite(surpriseFactor)) {
      issues.push({ path: `${path}.surprise_factor`, message: 'must be a finite number when present' });
    }
  }
}

function requireExactNumber(
  value: Record<string, unknown>,
  key: string,
  expected: number,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  if (value[key] !== expected) {
    issues.push({ path: `${path}.${key}`, message: `must be ${expected}` });
  }
}

function requireExactString(
  value: Record<string, unknown>,
  key: string,
  expected: string,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  if (value[key] !== expected) {
    issues.push({ path: `${path}.${key}`, message: `must be ${expected}` });
  }
}

function requireNonEmptyString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): string | null {
  if (typeof value[key] !== 'string' || value[key].trim() === '') {
    issues.push({ path: `${path}.${key}`, message: 'required non-empty string is missing or invalid' });
    return null;
  }
  return value[key];
}

function requireCategory(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): Category | null {
  if (typeof value[key] !== 'string' || !CATEGORIES.includes(value[key] as Category)) {
    issues.push({ path: `${path}.${key}`, message: `expected one of: ${CATEGORIES.join(', ')}` });
    return null;
  }
  return value[key] as Category;
}

function requireMarketImpactClass(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): MarketImpactClass | null {
  if (typeof value[key] !== 'string' || !MARKET_IMPACT_CLASSES.includes(value[key] as MarketImpactClass)) {
    issues.push({ path: `${path}.${key}`, message: `expected one of: ${MARKET_IMPACT_CLASSES.join(', ')}` });
    return null;
  }
  return value[key] as MarketImpactClass;
}

function requireValidDate(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): string | null {
  if (typeof value[key] !== 'string' || !DATE_PATTERN.test(value[key]) || !isValidDate(value[key])) {
    issues.push({ path: `${path}.${key}`, message: 'required valid YYYY-MM-DD string is missing or invalid' });
    return null;
  }
  return value[key];
}

function requireEventTime(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  const eventTime = value[key];
  if (eventTime === null) {
    return;
  }
  if (typeof eventTime !== 'string' || !TIME_PATTERN.test(eventTime) || !isValidTime(eventTime)) {
    issues.push({ path: `${path}.${key}`, message: 'must be HH:MM:SS or null' });
  }
}

function requireAuthoritativeSource(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  if (typeof value[key] !== 'string' || !HTTPS_URL_PATTERN.test(value[key])) {
    issues.push({ path: `${path}.${key}`, message: 'required official https source URL is missing or invalid' });
  }
}

function isValidDate(value: string): boolean {
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (month < 1 || month > 12) {
    return false;
  }
  const daysByMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysByMonth[month - 1]!;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isValidTime(value: string): boolean {
  const [hourText, minuteText, secondText] = value.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  return Number.isInteger(hour)
    && Number.isInteger(minute)
    && Number.isInteger(second)
    && hour >= 0
    && hour <= 23
    && minute >= 0
    && minute <= 59
    && second >= 0
    && second <= 59;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
