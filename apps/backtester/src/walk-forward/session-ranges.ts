import type { SessionDateRange, SessionKeyConvention } from './types.js';
import type { WalkForwardIssue } from './walk-forward-error.js';
import { throwWalkForwardIssues } from './walk-forward-error.js';

const DATE_SESSION_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DATE_RTH_SESSION_PATTERN = /^(\d{4})-(\d{2})-(\d{2})-rth$/u;

export function validateSessionList(sessions: readonly string[]): void {
  const issues = collectSessionListIssues(sessions);
  if (issues.length > 0) {
    throwWalkForwardIssues(issues);
  }
}

export function collectSessionListIssues(
  sessions: readonly string[],
): readonly WalkForwardIssue[] {
  const issues: WalkForwardIssue[] = [];

  if (sessions.length === 0) {
    issues.push({
      path: 'sessions',
      code: 'empty_session_list',
      message: 'sessions must include at least one deterministic session key',
    });
    return issues;
  }

  let convention: SessionKeyConvention | null = null;
  const seen = new Set<string>();

  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index];
    const path = `sessions[${index}]`;

    if (typeof session !== 'string') {
      issues.push({
        path,
        code: 'invalid_session_id',
        message: 'session key must be a string',
      });
      continue;
    }

    const parsedConvention = parseSessionKeyConvention(session);
    if (parsedConvention === null) {
      issues.push({
        path,
        code: 'invalid_session_id',
        message: 'session key must be YYYY-MM-DD or YYYY-MM-DD-rth with a valid calendar date',
      });
      continue;
    }

    if (convention === null) {
      convention = parsedConvention;
    } else if (parsedConvention !== convention) {
      issues.push({
        path,
        code: 'invalid_session_id',
        message: 'session keys must use one convention per walk-forward plan',
      });
    }

    if (seen.has(session)) {
      issues.push({
        path,
        code: 'duplicate_session',
        message: `duplicate session key ${session}`,
      });
    }
    seen.add(session);

    const previousSession = sessions[index - 1];
    if (previousSession !== undefined && previousSession >= session) {
      issues.push({
        path,
        code: 'unsorted_sessions',
        message: 'sessions must be sorted ascending with no duplicates',
      });
    }
  }

  return issues;
}

export function makeSessionDateRange(
  sessions: readonly string[],
  startIndex: number,
  endIndex: number,
): SessionDateRange {
  if (startIndex < 0 || endIndex < 0 || startIndex >= sessions.length || endIndex >= sessions.length) {
    throwWalkForwardIssues([
      {
        path: 'sessions',
        code: 'insufficient_sessions',
        message: 'half-open ranges require an explicit exclusive end-session boundary',
      },
    ]);
  }

  const startSession = sessions[startIndex];
  const endSession = sessions[endIndex];

  if (startSession === undefined || endSession === undefined) {
    throwWalkForwardIssues([
      {
        path: 'sessions',
        code: 'insufficient_sessions',
        message: 'half-open ranges require an explicit exclusive end-session boundary',
      },
    ]);
  }

  return {
    start_session: startSession,
    end_session: endSession,
  };
}

export function parseSessionKeyConvention(session: string): SessionKeyConvention | null {
  const dateMatch = DATE_SESSION_PATTERN.exec(session);
  if (dateMatch !== null) {
    const [, year, month, day] = dateMatch;
    if (year === undefined || month === undefined || day === undefined) {
      return null;
    }
    return isValidCalendarDate(year, month, day) ? 'date' : null;
  }

  const rthMatch = DATE_RTH_SESSION_PATTERN.exec(session);
  if (rthMatch !== null) {
    const [, year, month, day] = rthMatch;
    if (year === undefined || month === undefined || day === undefined) {
      return null;
    }
    return isValidCalendarDate(year, month, day) ? 'date-rth' : null;
  }

  return null;
}

function isValidCalendarDate(yearText: string, monthText: string, dayText: string): boolean {
  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  const day = Number.parseInt(dayText, 10);

  if (year < 1 || month < 1 || month > 12 || day < 1) {
    return false;
  }

  return day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

function isLeapYear(year: number): boolean {
  return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
}
