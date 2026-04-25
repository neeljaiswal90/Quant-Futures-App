import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigValidationError } from '../../src/config/index.js';
import { ns } from '../../src/contracts/index.js';
import {
  evaluateMnqSessionEligibility,
  evaluateRoll,
  getActiveMnqContract,
  getMnqSessionPhase,
  getSessionRiskResetBoundary,
  isEth,
  isMaintenanceHalt,
  isRth,
  loadMnqRollCalendarConfig,
  loadMnqSessionCalendarConfig,
  shouldBlockNewEntriesForRoll,
  shouldFlattenBeforeRoll,
} from '../../src/session/index.js';

const RTH_TS = ns('1776952800000000000');
const ETH_TS = ns('1776983400000000000');
const MAINTENANCE_TS = ns('1776979800000000000');
const CLOSED_TS = ns('1777132800000000000');
const SUNDAY_CLOSED_TS = ns('1777237200000000000');
const SUNDAY_ETH_TS = ns('1777242600000000000');
const ROLL_PRE_TS = ns('1781269200000000000');
const ROLL_BLOCK_TS = ns('1781270400000000000');
const ROLL_FLATTEN_TS = ns('1781270760000000000');
const ROLL_CUTOVER_TS = ns('1781271000000000000');
const ROLL_POST_BLOCK_TS = ns('1781271600000000000');
const ROLL_POST_TS = ns('1781272800000000000');

const tempDirs: string[] = [];

function makeTempRoot() {
  const directory = mkdtempSync(join(tmpdir(), 'quant-mnq-01-'));
  tempDirs.push(directory);
  return directory;
}

function writeTempFile(contents: string, fileName: string): { readonly root: string; readonly fileName: string } {
  const root = makeTempRoot();
  writeFileSync(join(root, fileName), contents);
  return { root, fileName };
}

describe('MNQ-01 session and roll calendar policy', () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('detects RTH, ETH, maintenance halt, and closed phases', () => {
    const config = loadMnqSessionCalendarConfig();

    expect(isRth(config, RTH_TS)).toBe(true);
    expect(getMnqSessionPhase(config, RTH_TS)).toMatchObject({
      phase: 'rth',
      journal_phase: 'rth',
      candidate_eligible: true,
      trading_date: '2026-04-23',
    });
    expect(isEth(config, ETH_TS)).toBe(true);
    expect(getMnqSessionPhase(config, ETH_TS)).toMatchObject({
      phase: 'eth',
      journal_phase: 'eth',
      candidate_eligible: false,
      block_reason: 'outside_rth',
      trading_date: '2026-04-24',
    });
    expect(isMaintenanceHalt(config, MAINTENANCE_TS)).toBe(true);
    expect(getMnqSessionPhase(config, MAINTENANCE_TS).block_reason).toBe('maintenance_halt');
    expect(getMnqSessionPhase(config, CLOSED_TS)).toMatchObject({
      phase: 'closed',
      block_reason: 'session_closed',
    });
    expect(getMnqSessionPhase(config, SUNDAY_CLOSED_TS).phase).toBe('closed');
    expect(getMnqSessionPhase(config, SUNDAY_ETH_TS)).toMatchObject({
      phase: 'eth',
      journal_phase: 'eth',
      trading_date: '2026-04-27',
    });
  });

  it('returns a deterministic RTH risk reset boundary', () => {
    const config = loadMnqSessionCalendarConfig();
    const boundary = getSessionRiskResetBoundary(config, ETH_TS);

    expect(boundary).toEqual({
      session_id: '2026-04-24-rth',
      trading_date: '2026-04-24',
      reset_ts_ns: ns('1777037400000000000'),
      reset_phase: 'rth_open',
    });
  });

  it('selects active contracts and roll phases deterministically', () => {
    const config = loadMnqRollCalendarConfig();

    expect(getActiveMnqContract(config, ROLL_PRE_TS)).toBe('MNQM6');
    expect(evaluateRoll(config, ROLL_PRE_TS)).toMatchObject({
      active_contract: 'MNQM6',
      next_contract: 'MNQU6',
      roll_phase: 'pre_roll',
      block_new_entries: false,
      flatten_required: false,
    });
    expect(shouldBlockNewEntriesForRoll(config, ROLL_BLOCK_TS)).toBe(true);
    expect(shouldFlattenBeforeRoll(config, ROLL_FLATTEN_TS)).toBe(true);
    expect(evaluateRoll(config, ROLL_FLATTEN_TS).reasons).toEqual([
      'roll_flatten_window',
      'roll_block_window',
    ]);
    expect(evaluateRoll(config, ROLL_CUTOVER_TS)).toMatchObject({
      active_contract: 'MNQU6',
      roll_phase: 'roll_block',
      block_reason: 'roll_block_window',
    });
    expect(evaluateRoll(config, ROLL_POST_BLOCK_TS).block_new_entries).toBe(true);
    expect(evaluateRoll(config, ROLL_POST_TS)).toMatchObject({
      active_contract: 'MNQU6',
      roll_phase: 'post_roll',
      block_new_entries: false,
      flatten_required: false,
    });
  });

  it('combines session and roll policy into an ORCH-ready eligibility summary', () => {
    const sessionCalendar = loadMnqSessionCalendarConfig();
    const rollCalendar = loadMnqRollCalendarConfig();
    const normal = evaluateMnqSessionEligibility({
      sessionCalendar,
      rollCalendar,
      timestamp_ns: RTH_TS,
    });
    const rollBlocked = evaluateMnqSessionEligibility({
      sessionCalendar,
      rollCalendar,
      timestamp_ns: ROLL_FLATTEN_TS,
    });
    const ethBlocked = evaluateMnqSessionEligibility({
      sessionCalendar,
      rollCalendar,
      timestamp_ns: ETH_TS,
    });

    expect(normal).toMatchObject({
      active_contract: 'MNQM6',
      session_phase: 'rth',
      roll_phase: 'normal',
      candidate_eligible: true,
    });
    expect(rollBlocked).toMatchObject({
      active_contract: 'MNQM6',
      next_contract: 'MNQU6',
      session_phase: 'eth',
      roll_phase: 'roll_block',
      candidate_eligible: false,
      flatten_required: true,
      block_reason: 'outside_rth',
    });
    expect(rollBlocked.reasons).toEqual([
      'outside_rth',
      'roll_flatten_window',
      'roll_block_window',
    ]);
    expect(ethBlocked).toMatchObject({
      session_phase: 'eth',
      candidate_eligible: false,
      block_reason: 'outside_rth',
    });
  });

  it('rejects invalid roll calendars with clear paths', () => {
    const source = readFileSync('config/session/mnq-roll-calendar.yaml', 'utf8')
      .replace('next_contract: MNQU6', 'next_contract: MNQK6');
    const { root, fileName } = writeTempFile(source, 'mnq-roll-calendar.yaml');

    expect(() => loadMnqRollCalendarConfig({ cwd: root, path: fileName })).toThrow(ConfigValidationError);
    try {
      loadMnqRollCalendarConfig({ cwd: root, path: fileName });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues).toContainEqual({
        path: '$.periods.mnqm6_to_mnqu6.next_contract',
        message: 'expected MNQ quarterly contract symbol',
      });
    }
  });

  it('rejects overlapping roll calendars', () => {
    const source = readFileSync('config/session/mnq-roll-calendar.yaml', 'utf8')
      .replace(
        'roll_start_ts_ns: "1788528600000000000"',
        'roll_start_ts_ns: "1781271600000000000"',
      );
    const { root, fileName } = writeTempFile(source, 'mnq-roll-overlap.yaml');

    expect(() => loadMnqRollCalendarConfig({ cwd: root, path: fileName })).toThrow(ConfigValidationError);
    try {
      loadMnqRollCalendarConfig({ cwd: root, path: fileName });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues).toContainEqual({
        path: '$.periods.mnqu6_to_mnqz6.roll_start_ts_ns',
        message: 'roll window overlaps mnqm6_to_mnqu6',
      });
    }
  });

  it('rejects invalid session calendar values', () => {
    const source = readFileSync('config/session/mnq-session-calendar.yaml', 'utf8')
      .replace('timezone: America/New_York', 'timezone: America/Chicago');
    const { root, fileName } = writeTempFile(source, 'mnq-session-calendar.yaml');

    expect(() => loadMnqSessionCalendarConfig({ cwd: root, path: fileName })).toThrow(ConfigValidationError);
    try {
      loadMnqSessionCalendarConfig({ cwd: root, path: fileName });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues).toContainEqual({
        path: '$.timezone',
        message: 'expected one of: America/New_York',
      });
    }
  });

  it('keeps eligibility output byte-stable across repeated runs', () => {
    const sessionCalendar = loadMnqSessionCalendarConfig();
    const rollCalendar = loadMnqRollCalendarConfig();
    const input = { sessionCalendar, rollCalendar, timestamp_ns: ROLL_FLATTEN_TS };

    const first = evaluateMnqSessionEligibility(input);
    const second = evaluateMnqSessionEligibility(input);

    expect(first).toEqual(second);
    expect(deterministicStringify(first)).toBe(deterministicStringify(second));
  });

  it('keeps session modules free of deterministic-output hazards', () => {
    const sessionDir = join(process.cwd(), 'apps/strategy_runtime/src/session');
    const patterns = [
      'Date.now',
      'new Date(',
      'Math.random',
      'toLocaleString',
      'localeCompare',
    ];

    for (const file of readdirSync(sessionDir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(sessionDir, file), 'utf8');
      for (const pattern of patterns) {
        expect(source, `${file} must not contain ${pattern}`).not.toContain(pattern);
      }
    }
  });
});

function deterministicStringify(value: unknown): string {
  if (typeof value === 'bigint') {
    return JSON.stringify(value.toString());
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }
  if (value === undefined) {
    return '';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => deterministicStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${deterministicStringify(record[key])}`)
    .join(',')}}`;
}
