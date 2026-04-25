import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigValidationError } from '../config/errors.js';
import {
  checkUnknownKeys,
  parseSimpleYaml,
  readLiteral,
  readNonNegativeNumber,
  readRecord,
  readString,
  requireRecord,
  throwIfIssues,
} from '../config/simple-yaml.js';
import type { ConfigValidationIssue } from '../config/types.js';
import { ns, type UnixNs } from '../contracts/time.js';
import {
  addMinutesToUnixNs,
  compareUnixNs,
  parseConfigUnixNs,
} from './time-utils.js';

export const MNQ_ROLL_CALENDAR_SCHEMA_VERSION = 1 as const;
export const DEFAULT_MNQ_ROLL_CALENDAR_PATH = 'config/session/mnq-roll-calendar.yaml';
export const MNQ_CONTRACT_MONTH_CODES = ['H', 'M', 'U', 'Z'] as const;
export type MnqContractMonthCode = typeof MNQ_CONTRACT_MONTH_CODES[number];

export const MNQ_ROLL_PHASES = ['normal', 'pre_roll', 'roll_block', 'post_roll'] as const;
export type MnqRollPhase = typeof MNQ_ROLL_PHASES[number];

export const MNQ_ROLL_REASON_CODES = ['roll_block_window', 'roll_flatten_window'] as const;
export type MnqRollReasonCode = typeof MNQ_ROLL_REASON_CODES[number];

export interface MnqRollPolicy {
  readonly block_new_entries_before_cutover_minutes: number;
  readonly block_new_entries_after_cutover_minutes: number;
  readonly flatten_before_cutover_minutes: number;
}

export interface MnqRollPeriod {
  readonly id: string;
  readonly front_contract: string;
  readonly next_contract: string;
  readonly roll_start_ts_ns: UnixNs;
  readonly cutover_ts_ns: UnixNs;
  readonly roll_end_ts_ns: UnixNs;
  readonly expiry_ts_ns: UnixNs;
  readonly policy_note: string;
}

export interface MnqRollCalendarConfig {
  readonly version: typeof MNQ_ROLL_CALENDAR_SCHEMA_VERSION;
  readonly instrument_root: 'MNQ';
  readonly exchange: 'CME';
  readonly timezone: 'America/New_York';
  readonly policy: MnqRollPolicy;
  readonly contract_month_codes: Readonly<Record<MnqContractMonthCode, string>>;
  readonly periods: readonly MnqRollPeriod[];
  readonly source_file: string;
}

export interface MnqRollEvaluation {
  readonly timestamp_ns: UnixNs;
  readonly active_contract: string;
  readonly next_contract?: string;
  readonly roll_phase: MnqRollPhase;
  readonly in_roll_window: boolean;
  readonly block_new_entries: boolean;
  readonly flatten_required: boolean;
  readonly reasons: readonly MnqRollReasonCode[];
  readonly block_reason?: MnqRollReasonCode;
  readonly period_id?: string;
  readonly cutover_ts_ns?: UnixNs;
}

export interface LoadMnqRollCalendarOptions {
  readonly path?: string;
  readonly cwd?: string;
  readonly required?: boolean;
}

export function loadMnqRollCalendarConfig(
  options: LoadMnqRollCalendarOptions = {},
): MnqRollCalendarConfig {
  const cwd = options.cwd ?? process.cwd();
  const requestedPath = options.path ?? DEFAULT_MNQ_ROLL_CALENDAR_PATH;
  const path = resolve(cwd, requestedPath);
  if (!existsSync(path)) {
    if (options.required === false) {
      return DEFAULT_MNQ_ROLL_CALENDAR_CONFIG;
    }
    throw new ConfigValidationError([
      { path: 'roll_calendar.path', message: `cannot read ${path}` },
    ], 'Invalid MNQ roll calendar');
  }
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError([
      { path: 'roll_calendar.path', message: `cannot read ${path}: ${message}` },
    ], 'Invalid MNQ roll calendar');
  }
  return parseMnqRollCalendarConfig(
    parseSimpleYaml(contents, path, 'Invalid MNQ roll calendar'),
    path,
  );
}

export function validateMnqRollCalendarConfig(
  config: MnqRollCalendarConfig,
): readonly ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  if (config.version !== MNQ_ROLL_CALENDAR_SCHEMA_VERSION) {
    issues.push({ path: '$.version', message: `expected ${MNQ_ROLL_CALENDAR_SCHEMA_VERSION}` });
  }
  if (config.instrument_root !== 'MNQ') {
    issues.push({ path: '$.instrument_root', message: 'expected MNQ' });
  }
  if (config.exchange !== 'CME') {
    issues.push({ path: '$.exchange', message: 'expected CME' });
  }
  if (config.timezone !== 'America/New_York') {
    issues.push({ path: '$.timezone', message: 'expected America/New_York' });
  }
  validatePolicy(config.policy, issues);
  validateRollPeriods(config.periods, issues);
  return issues.sort(compareIssues);
}

export function getActiveMnqContract(
  config: MnqRollCalendarConfig,
  timestampNs: UnixNs,
): string {
  const ordered = [...config.periods].sort(comparePeriodsByCutover);
  let active = ordered[0]?.front_contract ?? 'MNQ';
  for (const period of ordered) {
    if (timestampNs >= period.cutover_ts_ns) {
      active = period.next_contract;
    }
  }
  return active;
}

export function getRollPhase(
  config: MnqRollCalendarConfig,
  timestampNs: UnixNs,
): MnqRollPhase {
  return evaluateRoll(config, timestampNs).roll_phase;
}

export function shouldBlockNewEntriesForRoll(
  config: MnqRollCalendarConfig,
  timestampNs: UnixNs,
): boolean {
  return evaluateRoll(config, timestampNs).block_new_entries;
}

export function shouldFlattenBeforeRoll(
  config: MnqRollCalendarConfig,
  timestampNs: UnixNs,
): boolean {
  return evaluateRoll(config, timestampNs).flatten_required;
}

export function evaluateRoll(
  config: MnqRollCalendarConfig,
  timestampNs: UnixNs,
): MnqRollEvaluation {
  const period = findRollPeriod(config, timestampNs);
  if (period === undefined) {
    return {
      timestamp_ns: timestampNs,
      active_contract: getActiveMnqContract(config, timestampNs),
      roll_phase: 'normal',
      in_roll_window: false,
      block_new_entries: false,
      flatten_required: false,
      reasons: [],
    };
  }

  const blockStart = addMinutesToUnixNs(
    period.cutover_ts_ns,
    -config.policy.block_new_entries_before_cutover_minutes,
  );
  const blockEnd = addMinutesToUnixNs(
    period.cutover_ts_ns,
    config.policy.block_new_entries_after_cutover_minutes,
  );
  const flattenStart = addMinutesToUnixNs(
    period.cutover_ts_ns,
    -config.policy.flatten_before_cutover_minutes,
  );
  const blockNewEntries = timestampNs >= blockStart && timestampNs <= blockEnd;
  const flattenRequired = timestampNs >= flattenStart && timestampNs < period.cutover_ts_ns;
  const reasons: MnqRollReasonCode[] = [];
  if (flattenRequired) reasons.push('roll_flatten_window');
  if (blockNewEntries) reasons.push('roll_block_window');
  return {
    timestamp_ns: timestampNs,
    active_contract: timestampNs < period.cutover_ts_ns
      ? period.front_contract
      : period.next_contract,
    next_contract: period.next_contract,
    roll_phase: getPhaseForPeriod(period, timestampNs, blockStart, blockEnd),
    in_roll_window: true,
    block_new_entries: blockNewEntries,
    flatten_required: flattenRequired,
    reasons,
    ...(reasons[0] === undefined ? {} : { block_reason: reasons[0] }),
    period_id: period.id,
    cutover_ts_ns: period.cutover_ts_ns,
  };
}

function parseMnqRollCalendarConfig(
  input: unknown,
  sourceFile: string,
): MnqRollCalendarConfig {
  const issues: ConfigValidationIssue[] = [];
  const root = requireRecord(input, '$', issues);
  checkUnknownKeys(root, '$', [
    'version',
    'instrument_root',
    'exchange',
    'timezone',
    'policy',
    'contract_month_codes',
    'periods',
  ], issues);
  readVersion(root, '$', issues);
  const contractMonthCodes = parseContractMonthCodes(
    readRecord(root, 'contract_month_codes', '$', issues),
    issues,
  );
  const config: MnqRollCalendarConfig = {
    version: MNQ_ROLL_CALENDAR_SCHEMA_VERSION,
    instrument_root: readLiteral(root, 'instrument_root', '$', ['MNQ'], issues),
    exchange: readLiteral(root, 'exchange', '$', ['CME'], issues),
    timezone: readLiteral(root, 'timezone', '$', ['America/New_York'], issues),
    policy: parseRollPolicy(readRecord(root, 'policy', '$', issues), issues),
    contract_month_codes: contractMonthCodes,
    periods: parseRollPeriods(readRecord(root, 'periods', '$', issues), issues),
    source_file: sourceFile,
  };
  issues.push(...validateMnqRollCalendarConfig(config));
  throwIfIssues(issues, 'Invalid MNQ roll calendar');
  return config;
}

function parseContractMonthCodes(
  record: Record<string, unknown>,
  issues: ConfigValidationIssue[],
): Readonly<Record<MnqContractMonthCode, string>> {
  checkUnknownKeys(record, '$.contract_month_codes', MNQ_CONTRACT_MONTH_CODES, issues);
  return {
    H: readString(record, 'H', '$.contract_month_codes', issues),
    M: readString(record, 'M', '$.contract_month_codes', issues),
    U: readString(record, 'U', '$.contract_month_codes', issues),
    Z: readString(record, 'Z', '$.contract_month_codes', issues),
  };
}

function parseRollPolicy(
  record: Record<string, unknown>,
  issues: ConfigValidationIssue[],
): MnqRollPolicy {
  checkUnknownKeys(record, '$.policy', [
    'block_new_entries_before_cutover_minutes',
    'block_new_entries_after_cutover_minutes',
    'flatten_before_cutover_minutes',
  ], issues);
  return {
    block_new_entries_before_cutover_minutes: readNonNegativeInteger(
      record,
      'block_new_entries_before_cutover_minutes',
      '$.policy',
      issues,
    ),
    block_new_entries_after_cutover_minutes: readNonNegativeInteger(
      record,
      'block_new_entries_after_cutover_minutes',
      '$.policy',
      issues,
    ),
    flatten_before_cutover_minutes: readNonNegativeInteger(
      record,
      'flatten_before_cutover_minutes',
      '$.policy',
      issues,
    ),
  };
}

function parseRollPeriods(
  record: Record<string, unknown>,
  issues: ConfigValidationIssue[],
): readonly MnqRollPeriod[] {
  return Object.keys(record).sort().map((id) => {
    const path = `$.periods.${id}`;
    const period = requireRecord(record[id], path, issues);
    checkUnknownKeys(period, path, [
      'front_contract',
      'next_contract',
      'roll_start_ts_ns',
      'cutover_ts_ns',
      'roll_end_ts_ns',
      'expiry_ts_ns',
      'policy_note',
    ], issues);
    return {
      id,
      front_contract: readString(period, 'front_contract', path, issues),
      next_contract: readString(period, 'next_contract', path, issues),
      roll_start_ts_ns: parseConfigUnixNs(period.roll_start_ts_ns, `${path}.roll_start_ts_ns`, issues),
      cutover_ts_ns: parseConfigUnixNs(period.cutover_ts_ns, `${path}.cutover_ts_ns`, issues),
      roll_end_ts_ns: parseConfigUnixNs(period.roll_end_ts_ns, `${path}.roll_end_ts_ns`, issues),
      expiry_ts_ns: parseConfigUnixNs(period.expiry_ts_ns, `${path}.expiry_ts_ns`, issues),
      policy_note: readString(period, 'policy_note', path, issues),
    };
  });
}

function validatePolicy(policy: MnqRollPolicy, issues: ConfigValidationIssue[]): void {
  for (const key of [
    'block_new_entries_before_cutover_minutes',
    'block_new_entries_after_cutover_minutes',
    'flatten_before_cutover_minutes',
  ] as const) {
    if (!Number.isInteger(policy[key]) || policy[key] < 0) {
      issues.push({ path: `$.policy.${key}`, message: 'expected non-negative integer minutes' });
    }
  }
  if (
    policy.flatten_before_cutover_minutes
    > policy.block_new_entries_before_cutover_minutes
  ) {
    issues.push({
      path: '$.policy.flatten_before_cutover_minutes',
      message: 'must be <= block_new_entries_before_cutover_minutes',
    });
  }
}

function validateRollPeriods(
  periods: readonly MnqRollPeriod[],
  issues: ConfigValidationIssue[],
): void {
  if (periods.length === 0) {
    issues.push({ path: '$.periods', message: 'at least one roll period is required' });
    return;
  }
  const seenPairs = new Set<string>();
  const seenContracts = new Set<string>();
  for (const period of periods) {
    const path = `$.periods.${period.id}`;
    validateContract(period.front_contract, `${path}.front_contract`, issues);
    validateContract(period.next_contract, `${path}.next_contract`, issues);
    const pair = `${period.front_contract}->${period.next_contract}`;
    if (seenPairs.has(pair)) {
      issues.push({ path, message: 'duplicate contract period' });
    }
    seenPairs.add(pair);
    const duplicateKey = `${period.front_contract}:${period.cutover_ts_ns.toString()}`;
    if (seenContracts.has(duplicateKey)) {
      issues.push({ path, message: 'duplicate contract cutover' });
    }
    seenContracts.add(duplicateKey);
    if (period.roll_start_ts_ns >= period.roll_end_ts_ns) {
      issues.push({ path, message: 'roll_start_ts_ns must be before roll_end_ts_ns' });
    }
    if (
      period.cutover_ts_ns < period.roll_start_ts_ns
      || period.cutover_ts_ns > period.roll_end_ts_ns
    ) {
      issues.push({ path: `${path}.cutover_ts_ns`, message: 'cutover must be inside roll window' });
    }
  }

  const ordered = [...periods].sort((left, right) => compareUnixNs(left.roll_start_ts_ns, right.roll_start_ts_ns));
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (previous.roll_end_ts_ns > current.roll_start_ts_ns) {
      issues.push({
        path: `$.periods.${current.id}.roll_start_ts_ns`,
        message: `roll window overlaps ${previous.id}`,
      });
    }
  }
}

function findRollPeriod(
  config: MnqRollCalendarConfig,
  timestampNs: UnixNs,
): MnqRollPeriod | undefined {
  return config.periods.find(
    (period) => timestampNs >= period.roll_start_ts_ns && timestampNs <= period.roll_end_ts_ns,
  );
}

function getPhaseForPeriod(
  period: MnqRollPeriod,
  timestampNs: UnixNs,
  blockStart: UnixNs,
  blockEnd: UnixNs,
): MnqRollPhase {
  if (timestampNs >= blockStart && timestampNs <= blockEnd) {
    return 'roll_block';
  }
  if (timestampNs < period.cutover_ts_ns) {
    return 'pre_roll';
  }
  return 'post_roll';
}

function validateContract(
  symbol: string,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  const match = /^MNQ([HMUZ])[0-9]$/.exec(symbol);
  if (match === null) {
    issues.push({ path, message: 'expected MNQ quarterly contract symbol' });
  }
}

function readNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): number {
  const value = readNonNegativeNumber(record, key, path, issues);
  if (!Number.isInteger(value)) {
    issues.push({ path: `${path}.${key}`, message: 'expected integer minutes' });
  }
  return value;
}

function comparePeriodsByCutover(left: MnqRollPeriod, right: MnqRollPeriod): number {
  const byCutover = compareUnixNs(left.cutover_ts_ns, right.cutover_ts_ns);
  if (byCutover !== 0) return byCutover;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function readVersion(
  record: Record<string, unknown>,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  if (record.version !== MNQ_ROLL_CALENDAR_SCHEMA_VERSION) {
    issues.push({ path: `${path}.version`, message: `expected ${MNQ_ROLL_CALENDAR_SCHEMA_VERSION}` });
  }
}

function compareIssues(left: ConfigValidationIssue, right: ConfigValidationIssue): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  if (left.message < right.message) return -1;
  if (left.message > right.message) return 1;
  return 0;
}

export const DEFAULT_MNQ_ROLL_CALENDAR_CONFIG = {
  version: MNQ_ROLL_CALENDAR_SCHEMA_VERSION,
  instrument_root: 'MNQ',
  exchange: 'CME',
  timezone: 'America/New_York',
  policy: {
    block_new_entries_before_cutover_minutes: 15,
    block_new_entries_after_cutover_minutes: 15,
    flatten_before_cutover_minutes: 5,
  },
  contract_month_codes: {
    H: 'March',
    M: 'June',
    U: 'September',
    Z: 'December',
  },
  periods: [
    {
      id: 'mnqm6_to_mnqu6',
      front_contract: 'MNQM6',
      next_contract: 'MNQU6',
      roll_start_ts_ns: ns('1780666200000000000'),
      cutover_ts_ns: ns('1781271000000000000'),
      roll_end_ts_ns: ns('1781899200000000000'),
      expiry_ts_ns: ns('1781875800000000000'),
      policy_note: 'June_2026_example_roll_window',
    },
    {
      id: 'mnqu6_to_mnqz6',
      front_contract: 'MNQU6',
      next_contract: 'MNQZ6',
      roll_start_ts_ns: ns('1788528600000000000'),
      cutover_ts_ns: ns('1789133400000000000'),
      roll_end_ts_ns: ns('1789761600000000000'),
      expiry_ts_ns: ns('1789738200000000000'),
      policy_note: 'September_2026_example_roll_window',
    },
  ],
  source_file: 'default-mnq-roll-calendar',
} as const satisfies MnqRollCalendarConfig;
