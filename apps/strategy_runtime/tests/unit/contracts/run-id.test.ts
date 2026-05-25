// Module under test: contracts/run-id; ticket QFA-115 Session 2a.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  deriveBarToken,
  deriveRunId,
  deriveStrategyToken,
  deriveWindowToken,
} from '../../../src/contracts/run-id.js';
import type { BacktestWindow } from '../../../src/contracts/run-spec.js';
import {
  ACTIVE_STRATEGY_IDS,
  ALL_STRATEGY_IDS,
  type StrategyId,
} from '../../../src/contracts/strategy-ids.js';
import { buildBacktestWindow, buildMinimalRunSpec } from './helpers/run-spec-builder.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const fixtureDir = join(repoRoot, 'apps/strategy_runtime/tests/fixtures/run-spec');

describe('QFA-115 deriveRunId — fixture cross-check', () => {
  it('produces the exact run-id recorded in minimal-runspec.run-id.txt', () => {
    const expected = readFileSync(join(fixtureDir, 'minimal-runspec.run-id.txt'), 'utf8').trim();
    const { run_id } = deriveRunId(buildMinimalRunSpec());
    expect(run_id).toBe(expected);
  });

  it('returns the run_spec_hash alongside the run_id', () => {
    const { run_id, run_spec_hash } = deriveRunId(buildMinimalRunSpec());
    expect(run_spec_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(run_id).toContain(run_spec_hash.slice(0, 12));
  });
});

describe('QFA-115 deriveRunId — grammar shape', () => {
  it('uses bt- prefix with lowercased instrument_root', () => {
    const { run_id } = deriveRunId(buildMinimalRunSpec());
    expect(run_id.startsWith('bt-mnq-')).toBe(true);
  });

  it('hash12 segment is exactly 12 lowercase hex chars', () => {
    const { run_id } = deriveRunId(buildMinimalRunSpec());
    const segments = run_id.split('-');
    const hash12 = segments[segments.length - 1]!;
    expect(hash12).toMatch(/^[a-f0-9]{12}$/u);
    expect(hash12.length).toBe(12);
  });

  it('1m vs 5m bar_spec produces different run_id at the bar token position', () => {
    const baseline = buildMinimalRunSpec();
    const oneMin = deriveRunId(baseline).run_id;
    const fiveMin = deriveRunId({ ...baseline, bar_spec: '5m' }).run_id;
    expect(oneMin).not.toBe(fiveMin);
    expect(oneMin).toContain('-1m-');
    expect(fiveMin).toContain('-5m-');
  });
});

describe('QFA-115 deriveBarToken (Q-2.5)', () => {
  it.each([
    ['1m', '1m'],
    ['5m', '5m'],
    ['15m', '15m'],
    ['1h', '1h'],
    ['1d', '1d'],
    ['30s', '30s'],
  ])('time bar %s -> %s (pass-through)', (input, expected) => {
    expect(deriveBarToken(input)).toBe(expected);
  });

  it.each([
    ['tick:ticks:100', 'tick100'],
    ['tick:ticks:1', 'tick1'],
    ['tick:volume:1000', 'vol1000'],
    ['tick:volume:5000', 'vol5000'],
    ['tick:dollar:50000', 'dol50000'],
    ['tick:dollar:1', 'dol1'],
  ])('tick bar %s -> %s', (input, expected) => {
    expect(deriveBarToken(input)).toBe(expected);
  });

  it.each(['', '01m', '1M', 'tick:foo:100', 'tick:ticks:0', '1minute'])(
    'rejects invalid %s',
    (input) => {
      expect(() => deriveBarToken(input)).toThrow();
    },
  );
});

describe('QFA-115 deriveWindowToken (Q-2.4)', () => {
  it('session single-day -> s + YYYYMMDD', () => {
    const w: BacktestWindow = buildBacktestWindow({
      mode: 'session',
      start: '2026-02-02',
      end: '2026-02-02',
    });
    expect(deriveWindowToken(w)).toBe('s20260202');
  });

  it('session multi-day -> s + start + - + end', () => {
    const w: BacktestWindow = buildBacktestWindow({
      mode: 'session',
      start: '2026-02-02',
      end: '2026-02-06',
    });
    expect(deriveWindowToken(w)).toBe('s20260202-20260206');
  });

  it('instant single-instant -> i + YYYYMMDDTHHMMSSZ', () => {
    const w: BacktestWindow = buildBacktestWindow({
      mode: 'instant',
      start: '2026-02-02T14:30:00Z',
      end: '2026-02-02T14:30:00Z',
    });
    expect(deriveWindowToken(w)).toBe('i20260202T143000Z');
  });

  it('instant multi-instant -> i + start + - + end', () => {
    const w: BacktestWindow = buildBacktestWindow({
      mode: 'instant',
      start: '2026-02-02T14:30:00Z',
      end: '2026-02-02T21:00:00Z',
    });
    expect(deriveWindowToken(w)).toBe('i20260202T143000Z-20260202T210000Z');
  });

  it('rejects malformed session date', () => {
    const w: BacktestWindow = buildBacktestWindow({
      mode: 'session',
      start: '2026-02',
      end: '2026-02-02',
    });
    expect(() => deriveWindowToken(w)).toThrow();
  });

  it('rejects instant without Z suffix', () => {
    const w: BacktestWindow = buildBacktestWindow({
      mode: 'instant',
      start: '2026-02-02T14:30:00',
      end: '2026-02-02T21:00:00Z',
    });
    expect(() => deriveWindowToken(w)).toThrow();
  });
});

describe('QFA-115 Q-2.4 deriveWindowToken instant-mode rejection (no fractional seconds)', () => {
  it('rejects instant-mode start with fractional seconds', () => {
    const w: BacktestWindow = buildBacktestWindow({
      mode: 'instant',
      start: '2026-02-02T14:30:00.000Z',
      end: '2026-02-02T21:00:00Z',
    });
    expect(() => deriveWindowToken(w)).toThrow(/instant-mode start/u);
  });

  it('rejects instant-mode end with fractional seconds', () => {
    const w: BacktestWindow = buildBacktestWindow({
      mode: 'instant',
      start: '2026-02-02T14:30:00Z',
      end: '2026-02-02T21:00:00.500Z',
    });
    expect(() => deriveWindowToken(w)).toThrow(/instant-mode end/u);
  });
});

describe('QFA-115 deriveStrategyToken (Q-2.2 + A1)', () => {
  it('throws on empty strategy_ids', () => {
    expect(() => deriveStrategyToken([])).toThrow();
  });

  it.each([
    ['trend_pullback_long', 'tp_long'],
    ['trend_pullback_short', 'tp_short'],
    ['breakout_retest_long', 'bro_long'],
    ['breakdown_retest_short', 'bro_short'],
    ['regime_shock_reversion_short_v5_strict_deadline', 'rsr_short_v5_sd'],
    ['regime_shock_reversion_short_v5_trail_at_deadline', 'rsr_short_v5_td'],
  ])('single-strategy [%s] -> %s', (id, expected) => {
    expect(deriveStrategyToken([id as StrategyId])).toBe(expected);
  });

  it.each([
    [2, 'multi2'],
    [3, 'multi3'],
  ])('multi-strategy with count %d -> %s', (count, expected) => {
    const ids = ACTIVE_STRATEGY_IDS.slice(0, count) as readonly StrategyId[];
    expect(deriveStrategyToken(ids)).toBe(expected);
  });

  // A1 deferral coverage: STRATEGY_ID_TO_RUN_ID_ABBREV must have an entry
  // for every member of the StrategyId union. If a future StrategyId is
  // added without updating the table, this test fails at compile time
  // (Record<StrategyId, string> requires complete keying) and at runtime
  // (the abbreviation lookup throws). Both signals point future contributors
  // at the right place.
  it('every registered StrategyId has a run-id abbreviation', () => {
    for (const id of ALL_STRATEGY_IDS) {
      expect(() => deriveStrategyToken([id as StrategyId])).not.toThrow();
    }
  });
});
