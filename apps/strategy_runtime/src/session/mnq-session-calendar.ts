import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigValidationError } from '../config/errors.js';
import {
  checkUnknownKeys,
  parseSimpleYaml,
  readLiteral,
  readRecord,
  readString,
  requireRecord,
  throwIfIssues,
} from '../config/simple-yaml.js';
import type { ConfigValidationIssue } from '../config/types.js';
import type { SessionId } from '../contracts/ids.js';
import type { SessionPhase } from '../contracts/market.js';
import type { UnixNs } from '../contracts/time.js';
import {
  addDaysToDate,
  formatDate,
  newYorkLocalTimeToUnixNs,
  parseClockTime,
  type ClockTime,
  type LocalDateParts,
  type NewYorkLocalTime,
  unixNsToNewYorkLocalTime,
} from './time-utils.js';

export const MNQ_SESSION_CALENDAR_SCHEMA_VERSION = 1 as const;
export const DEFAULT_MNQ_SESSION_CALENDAR_PATH = 'config/session/mnq-session-calendar.yaml';
export const MNQ_TRADING_TIMEZONE = 'America/New_York' as const;
export const MNQ_EXCHANGE = 'CME' as const;
export const MNQ_INSTRUMENT_ROOT = 'MNQ' as const;

export const MNQ_SESSION_PHASES = ['rth', 'eth', 'maintenance', 'closed'] as const;
export type MnqSessionPhase = typeof MNQ_SESSION_PHASES[number];

export const MNQ_SESSION_BLOCK_REASONS = [
  'maintenance_halt',
  'outside_rth',
  'session_closed',
] as const;
export type MnqSessionBlockReason = typeof MNQ_SESSION_BLOCK_REASONS[number];

export interface MnqSessionWindow {
  readonly start: ClockTime;
  readonly end: ClockTime;
}

export interface MnqEthWindow extends MnqSessionWindow {
  readonly trading_day_roll: ClockTime;
}

export interface MnqSessionOverride {
  readonly id: string;
  readonly date: string;
  readonly phase: MnqSessionPhase;
  readonly reason: string;
  readonly start?: ClockTime;
  readonly end?: ClockTime;
}

export interface MnqSessionCalendarConfig {
  readonly version: typeof MNQ_SESSION_CALENDAR_SCHEMA_VERSION;
  readonly instrument_root: typeof MNQ_INSTRUMENT_ROOT;
  readonly exchange: typeof MNQ_EXCHANGE;
  readonly timezone: typeof MNQ_TRADING_TIMEZONE;
  readonly rth: MnqSessionWindow;
  readonly eth: MnqEthWindow;
  readonly maintenance: MnqSessionWindow;
  readonly overrides: readonly MnqSessionOverride[];
  readonly source_file: string;
}

export interface MnqSessionPhaseEvaluation {
  readonly timestamp_ns: UnixNs;
  readonly timezone: typeof MNQ_TRADING_TIMEZONE;
  readonly local: NewYorkLocalTime;
  readonly phase: MnqSessionPhase;
  readonly journal_phase: SessionPhase;
  readonly trading_date: string;
  readonly session_id: SessionId;
  readonly is_rth: boolean;
  readonly is_eth: boolean;
  readonly is_maintenance_halt: boolean;
  readonly is_session_closed: boolean;
  readonly candidate_eligible: boolean;
  readonly block_reason?: MnqSessionBlockReason;
  readonly reasons: readonly MnqSessionBlockReason[];
}

export interface SessionRiskResetBoundary {
  readonly session_id: SessionId;
  readonly trading_date: string;
  readonly reset_ts_ns: UnixNs;
  readonly reset_phase: 'rth_open';
}

export interface LoadMnqSessionCalendarOptions {
  readonly path?: string;
  readonly cwd?: string;
  readonly required?: boolean;
}

export function loadMnqSessionCalendarConfig(
  options: LoadMnqSessionCalendarOptions = {},
): MnqSessionCalendarConfig {
  const cwd = options.cwd ?? process.cwd();
  const requestedPath = options.path ?? DEFAULT_MNQ_SESSION_CALENDAR_PATH;
  const path = resolve(cwd, requestedPath);
  if (!existsSync(path)) {
    if (options.required === false) {
      return DEFAULT_MNQ_SESSION_CALENDAR_CONFIG;
    }
    throw new ConfigValidationError([
      { path: 'session_calendar.path', message: `cannot read ${path}` },
    ], 'Invalid MNQ session calendar');
  }
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError([
      { path: 'session_calendar.path', message: `cannot read ${path}: ${message}` },
    ], 'Invalid MNQ session calendar');
  }
  return parseMnqSessionCalendarConfig(
    parseSimpleYaml(contents, path, 'Invalid MNQ session calendar'),
    path,
  );
}

export function validateMnqSessionCalendarConfig(
  config: MnqSessionCalendarConfig,
): readonly ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  if (config.version !== MNQ_SESSION_CALENDAR_SCHEMA_VERSION) {
    issues.push({ path: '$.version', message: `expected ${MNQ_SESSION_CALENDAR_SCHEMA_VERSION}` });
  }
  if (config.instrument_root !== MNQ_INSTRUMENT_ROOT) {
    issues.push({ path: '$.instrument_root', message: `expected ${MNQ_INSTRUMENT_ROOT}` });
  }
  if (config.exchange !== MNQ_EXCHANGE) {
    issues.push({ path: '$.exchange', message: `expected ${MNQ_EXCHANGE}` });
  }
  if (config.timezone !== MNQ_TRADING_TIMEZONE) {
    issues.push({ path: '$.timezone', message: `expected ${MNQ_TRADING_TIMEZONE}` });
  }
  for (const override of config.overrides) {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(override.date)) {
      issues.push({ path: `$.overrides.${override.id}.date`, message: 'expected YYYY-MM-DD' });
    }
    if ((override.start === undefined) !== (override.end === undefined)) {
      issues.push({
        path: `$.overrides.${override.id}`,
        message: 'start_time and end_time must be provided together',
      });
    }
  }
  return issues.sort(compareIssues);
}

export function getMnqSessionPhase(
  config: MnqSessionCalendarConfig,
  timestampNs: UnixNs,
): MnqSessionPhaseEvaluation {
  const local = unixNsToNewYorkLocalTime(timestampNs);
  const phase = determineSessionPhase(config, local);
  const tradingDate = getTradingDate(config, local);
  const journalPhase = toJournalSessionPhase(phase);
  const reasons = getSessionBlockReasons(phase);
  const sessionId = `${tradingDate}-${phase === 'rth' ? 'rth' : 'eth'}` as SessionId;
  return {
    timestamp_ns: timestampNs,
    timezone: config.timezone,
    local,
    phase,
    journal_phase: journalPhase,
    trading_date: tradingDate,
    session_id: sessionId,
    is_rth: phase === 'rth',
    is_eth: phase === 'eth',
    is_maintenance_halt: phase === 'maintenance',
    is_session_closed: phase === 'closed',
    candidate_eligible: phase === 'rth',
    ...(reasons[0] === undefined ? {} : { block_reason: reasons[0] }),
    reasons,
  };
}

export function isRth(config: MnqSessionCalendarConfig, timestampNs: UnixNs): boolean {
  return getMnqSessionPhase(config, timestampNs).phase === 'rth';
}

export function isEth(config: MnqSessionCalendarConfig, timestampNs: UnixNs): boolean {
  return getMnqSessionPhase(config, timestampNs).phase === 'eth';
}

export function isMaintenanceHalt(config: MnqSessionCalendarConfig, timestampNs: UnixNs): boolean {
  return getMnqSessionPhase(config, timestampNs).phase === 'maintenance';
}

export function getSessionRiskResetBoundary(
  config: MnqSessionCalendarConfig,
  timestampNs: UnixNs,
): SessionRiskResetBoundary {
  const evaluation = getMnqSessionPhase(config, timestampNs);
  const [year, month, day] = evaluation.trading_date.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  return {
    session_id: `${evaluation.trading_date}-rth` as SessionId,
    trading_date: evaluation.trading_date,
    reset_ts_ns: newYorkLocalTimeToUnixNs(
      { year, month, day } satisfies LocalDateParts,
      config.rth.start.minute_of_day,
    ),
    reset_phase: 'rth_open',
  };
}

function clock(hour: number, minute: number): ClockTime {
  return { hour, minute, minute_of_day: hour * 60 + minute };
}

function parseMnqSessionCalendarConfig(
  input: unknown,
  sourceFile: string,
): MnqSessionCalendarConfig {
  const issues: ConfigValidationIssue[] = [];
  const root = requireRecord(input, '$', issues);
  checkUnknownKeys(root, '$', [
    'version',
    'instrument_root',
    'exchange',
    'timezone',
    'rth',
    'eth',
    'maintenance',
    'overrides',
  ], issues);
  readVersion(root, '$', issues);
  const config: MnqSessionCalendarConfig = {
    version: MNQ_SESSION_CALENDAR_SCHEMA_VERSION,
    instrument_root: readLiteral(root, 'instrument_root', '$', [MNQ_INSTRUMENT_ROOT], issues),
    exchange: readLiteral(root, 'exchange', '$', [MNQ_EXCHANGE], issues),
    timezone: readLiteral(root, 'timezone', '$', [MNQ_TRADING_TIMEZONE], issues),
    rth: parseSessionWindow(readRecord(root, 'rth', '$', issues), '$.rth', issues),
    eth: parseEthWindow(readRecord(root, 'eth', '$', issues), '$.eth', issues),
    maintenance: parseSessionWindow(
      readRecord(root, 'maintenance', '$', issues),
      '$.maintenance',
      issues,
    ),
    overrides: parseOverrides(readRecord(root, 'overrides', '$', issues), issues),
    source_file: sourceFile,
  };
  issues.push(...validateMnqSessionCalendarConfig(config));
  throwIfIssues(issues, 'Invalid MNQ session calendar');
  return config;
}

function parseSessionWindow(
  record: Record<string, unknown>,
  path: string,
  issues: ConfigValidationIssue[],
): MnqSessionWindow {
  checkUnknownKeys(record, path, ['start_time', 'end_time'], issues);
  return {
    start: parseClockTime(record.start_time, `${path}.start_time`, issues),
    end: parseClockTime(record.end_time, `${path}.end_time`, issues),
  };
}

function parseEthWindow(
  record: Record<string, unknown>,
  path: string,
  issues: ConfigValidationIssue[],
): MnqEthWindow {
  checkUnknownKeys(record, path, ['start_time', 'end_time', 'trading_day_roll_time'], issues);
  return {
    start: parseClockTime(record.start_time, `${path}.start_time`, issues),
    end: parseClockTime(record.end_time, `${path}.end_time`, issues),
    trading_day_roll: parseClockTime(
      record.trading_day_roll_time,
      `${path}.trading_day_roll_time`,
      issues,
    ),
  };
}

function parseOverrides(
  record: Record<string, unknown>,
  issues: ConfigValidationIssue[],
): readonly MnqSessionOverride[] {
  return Object.keys(record).sort().map((id) => {
    const path = `$.overrides.${id}`;
    const override = requireRecord(record[id], path, issues);
    checkUnknownKeys(override, path, ['date', 'phase', 'start_time', 'end_time', 'reason'], issues);
    return {
      id,
      date: readString(override, 'date', path, issues),
      phase: readLiteral(override, 'phase', path, MNQ_SESSION_PHASES, issues),
      reason: readString(override, 'reason', path, issues),
      ...(override.start_time === undefined ? {} : {
        start: parseClockTime(override.start_time, `${path}.start_time`, issues),
      }),
      ...(override.end_time === undefined ? {} : {
        end: parseClockTime(override.end_time, `${path}.end_time`, issues),
      }),
    };
  });
}

function determineSessionPhase(
  config: MnqSessionCalendarConfig,
  local: NewYorkLocalTime,
): MnqSessionPhase {
  const closedOverride = config.overrides.find(
    (override) => override.date === local.date && override.phase === 'closed',
  );
  if (closedOverride !== undefined && isOverrideActive(closedOverride, local.minute_of_day)) {
    return 'closed';
  }

  const weeklyPhase = determineWeeklyPhase(config, local);
  if (weeklyPhase === 'closed') {
    return 'closed';
  }
  const rthEnd = getRthEndMinute(config, local.date);
  if (
    local.day_of_week >= 1 &&
    local.day_of_week <= 5 &&
    local.minute_of_day >= config.rth.start.minute_of_day &&
    local.minute_of_day < rthEnd
  ) {
    return 'rth';
  }
  if (
    local.day_of_week >= 1 &&
    local.day_of_week <= 4 &&
    local.minute_of_day >= config.maintenance.start.minute_of_day &&
    local.minute_of_day < config.maintenance.end.minute_of_day
  ) {
    return 'maintenance';
  }
  return weeklyPhase;
}

function determineWeeklyPhase(
  config: MnqSessionCalendarConfig,
  local: NewYorkLocalTime,
): MnqSessionPhase {
  const minute = local.minute_of_day;
  if (local.day_of_week === 6) return 'closed';
  if (local.day_of_week === 0) {
    return minute >= config.eth.start.minute_of_day ? 'eth' : 'closed';
  }
  if (local.day_of_week === 5 && minute >= config.maintenance.start.minute_of_day) {
    return 'closed';
  }
  if (
    local.day_of_week >= 1 &&
    local.day_of_week <= 4 &&
    minute >= config.maintenance.start.minute_of_day &&
    minute < config.maintenance.end.minute_of_day
  ) {
    return 'maintenance';
  }
  return 'eth';
}

function getRthEndMinute(config: MnqSessionCalendarConfig, date: string): number {
  const override = config.overrides.find(
    (candidate) => candidate.date === date && candidate.phase === 'rth' && candidate.end !== undefined,
  );
  return override?.end?.minute_of_day ?? config.rth.end.minute_of_day;
}

function isOverrideActive(override: MnqSessionOverride, minuteOfDay: number): boolean {
  if (override.start === undefined || override.end === undefined) {
    return true;
  }
  if (override.start.minute_of_day <= override.end.minute_of_day) {
    return minuteOfDay >= override.start.minute_of_day && minuteOfDay < override.end.minute_of_day;
  }
  return minuteOfDay >= override.start.minute_of_day || minuteOfDay < override.end.minute_of_day;
}

function getTradingDate(config: MnqSessionCalendarConfig, local: NewYorkLocalTime): string {
  const localDate = { year: local.year, month: local.month, day: local.day };
  if (local.minute_of_day >= config.eth.trading_day_roll.minute_of_day) {
    return formatDate(addDaysToDate(localDate, 1));
  }
  return local.date;
}

function toJournalSessionPhase(phase: MnqSessionPhase): SessionPhase {
  return phase;
}

function getSessionBlockReasons(phase: MnqSessionPhase): readonly MnqSessionBlockReason[] {
  if (phase === 'maintenance') return ['maintenance_halt'];
  if (phase === 'closed') return ['session_closed'];
  if (phase === 'eth') return ['outside_rth'];
  return [];
}

function readVersion(
  record: Record<string, unknown>,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  if (record.version !== MNQ_SESSION_CALENDAR_SCHEMA_VERSION) {
    issues.push({ path: `${path}.version`, message: `expected ${MNQ_SESSION_CALENDAR_SCHEMA_VERSION}` });
  }
}

function compareIssues(left: ConfigValidationIssue, right: ConfigValidationIssue): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  if (left.message < right.message) return -1;
  if (left.message > right.message) return 1;
  return 0;
}

export const DEFAULT_MNQ_SESSION_CALENDAR_CONFIG = {
  version: MNQ_SESSION_CALENDAR_SCHEMA_VERSION,
  instrument_root: MNQ_INSTRUMENT_ROOT,
  exchange: MNQ_EXCHANGE,
  timezone: MNQ_TRADING_TIMEZONE,
  rth: { start: clock(9, 30), end: clock(16, 0) },
  eth: { start: clock(18, 0), end: clock(17, 0), trading_day_roll: clock(18, 0) },
  maintenance: { start: clock(17, 0), end: clock(18, 0) },
  overrides: [
    {
      id: 'example_early_close',
      date: '2026-11-27',
      phase: 'rth',
      reason: 'example_early_close',
      start: clock(9, 30),
      end: clock(13, 0),
    },
    {
      id: 'example_holiday',
      date: '2026-12-25',
      phase: 'closed',
      reason: 'example_holiday',
    },
  ],
  source_file: 'default-mnq-session-calendar',
} as const satisfies MnqSessionCalendarConfig;
