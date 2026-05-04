// Module under test: contracts/vix-series and config/vix-series-loader; ticket QFA-110.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigValidationError, loadVixSeries } from '../../../src/config/index.js';
import {
  bucketByVixQuartile,
  computeVixQuartileBoundaries,
  lookupVixOnDate,
} from '../../../src/contracts/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const fixturePath = join(
  repoRoot,
  'apps/strategy_runtime/tests/fixtures/vix-series/vix-series.fixture.json',
);
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('QFA-110 VIX series loader', () => {
  it('round-trip loads a normalized VIX fixture', () => {
    const series = loadVixSeries(fixturePath);

    expect(series).toMatchObject({
      manifest_schema_version: 1,
      source: 'FRED',
      series_id: 'VIXCLS',
      start_date: '1990-01-02',
      end_date: '1990-01-15',
      record_count: 10,
      has_missing: true,
      missing_count: 1,
      sha256: '7b1d9382dddf6c6452eac0971e62a4044eb1f983243c0ee13516361aea49911f',
    });
    expect(series.observations).toHaveLength(10);
    expect(series.observations[4]).toEqual({ date: '1990-01-08', value: null });
    expect(Object.isFrozen(series)).toBe(true);
    expect(Object.isFrozen(series.observations)).toBe(true);
  });

  it('keeps the observations hash stable across repeated loads', () => {
    const first = loadVixSeries(fixturePath);
    const second = loadVixSeries(fixturePath);

    expect(first.sha256).toBe(second.sha256);
  });

  it('computes quartile boundaries from non-null observations', () => {
    const series = loadVixSeries(fixturePath);
    const boundaries = computeVixQuartileBoundaries(series);

    expect(boundaries).toEqual({
      q1_high: 19.22,
      q2_high: 19.91,
      q3_high: 20.11,
      sample_count: 9,
      excluded_null_count: 1,
    });
    expect(boundaries.q1_high).toBeLessThan(boundaries.q2_high);
    expect(boundaries.q2_high).toBeLessThan(boundaries.q3_high);
  });

  it('buckets VIX values deterministically at quartile boundaries', () => {
    const boundaries = computeVixQuartileBoundaries(loadVixSeries(fixturePath));

    expect(bucketByVixQuartile(10, boundaries)).toBe('Q1_low');
    expect(bucketByVixQuartile(boundaries.q1_high, boundaries)).toBe('Q1_low');
    expect(bucketByVixQuartile(boundaries.q1_high + 0.01, boundaries)).toBe('Q2');
    expect(bucketByVixQuartile(boundaries.q2_high, boundaries)).toBe('Q2');
    expect(bucketByVixQuartile(boundaries.q2_high + 0.01, boundaries)).toBe('Q3');
    expect(bucketByVixQuartile(boundaries.q3_high, boundaries)).toBe('Q3');
    expect(bucketByVixQuartile(boundaries.q3_high + 0.01, boundaries)).toBe('Q4_high');
  });

  it('looks up VIX values by date while preserving null observations', () => {
    const series = loadVixSeries(fixturePath);

    expect(lookupVixOnDate(series, '1990-01-03')).toBe(18.19);
    expect(lookupVixOnDate(series, '1990-01-08')).toBeNull();
    expect(lookupVixOnDate(series, '2099-01-01')).toBeNull();
  });

  it('is path-agnostic for identical series contents', () => {
    const directory = makeTempDirectory();
    const firstPath = join(directory, 'one', 'vix-series.json');
    const secondPath = join(directory, 'two', 'renamed-vix-series.json');
    const text = readFileSync(fixturePath, 'utf8');
    writeNestedFile(firstPath, text);
    writeNestedFile(secondPath, text);

    expect(loadVixSeries(firstPath).sha256).toBe(loadVixSeries(secondPath).sha256);
  });

  it('rejects a missing required field with a descriptive error path', () => {
    const malformed = readFixtureObject();
    delete (malformed as Record<string, unknown>).observations;
    const path = writeTempSeries('missing-observations.json', malformed);

    expect(() => loadVixSeries(path)).toThrow(ConfigValidationError);
    try {
      loadVixSeries(path);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).message).toContain('vix_series.observations');
    }
  });

  it('rejects wrong observation types with a descriptive error path', () => {
    const malformed = readFixtureObject() as {
      readonly observations: Array<Record<string, unknown>>;
    };
    malformed.observations[0].value = '17.24';
    const path = writeTempSeries('wrong-observation-type.json', malformed);

    expect(() => loadVixSeries(path)).toThrow(ConfigValidationError);
    try {
      loadVixSeries(path);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).message).toContain('vix_series.observations.0.value');
    }
  });

  it('rejects a stale observations hash', () => {
    const malformed = readFixtureObject() as Record<string, unknown>;
    malformed.sha256 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const path = writeTempSeries('bad-hash.json', malformed);

    expect(() => loadVixSeries(path)).toThrow(ConfigValidationError);
    try {
      loadVixSeries(path);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).message).toContain('vix_series.sha256');
    }
  });
});

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qfa-vix-series-'));
  tempDirectories.push(directory);
  return directory;
}

function writeNestedFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function writeTempSeries(fileName: string, series: unknown): string {
  const path = join(makeTempDirectory(), fileName);
  writeFileSync(path, `${JSON.stringify(series, null, 2)}\n`, 'utf8');
  return path;
}

function readFixtureObject(): unknown {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
}
