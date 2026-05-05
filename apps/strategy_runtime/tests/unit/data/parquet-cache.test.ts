// Module under test: data/parquet-cache; ticket QFA-103.
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeParquetCacheKey,
  getCachedRecords,
  getDefaultCacheRoot,
  readCachedRecords,
} from '../../../src/data/parquet-cache.js';
import { writeParquetCache } from '../../../src/data/parquet-cache-write.js';
import { loadDbnFile } from '../../../src/data/dbn-loader.js';

const FIXTURE_DIR = resolve('apps/strategy_runtime/tests/fixtures/dbn');
const REAL_MBO_PATH = 'D:/qfa-cache/databento/tier-a-feb-mar-2026/2026-02-03-rth/mbo.dbn.zst';
const TEST_CACHE_ROOT = resolve('.tmp', 'qfa-103-cache-tests');
const RUN_REAL_ARCHIVE_SMOKE = process.env.QFA_RUN_REAL_ARCHIVE_SMOKE === '1';

async function collectDbn(path: string, schema: Parameters<typeof loadDbnFile>[1]) {
  const records = [];
  for await (const record of loadDbnFile(path, schema)) {
    records.push(record);
  }
  return records;
}

async function collectCached(path: string, schema: Parameters<typeof readCachedRecords>[1]) {
  const records = [];
  for await (const record of readCachedRecords(path, schema)) {
    records.push(record);
  }
  return records;
}

afterEach(() => {
  rmSync(TEST_CACHE_ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.QFA_PARQUET_CACHE_ROOT;
});

describe('QFA-103 parquet cache', () => {
  it('builds cache on miss and hits on second read', async () => {
    const fixturePath = resolve(FIXTURE_DIR, 'mbo-minimal.dbn');
    const first = await getCachedRecords(fixturePath, 'mbo', { cacheRoot: TEST_CACHE_ROOT });
    const second = await getCachedRecords(fixturePath, 'mbo', { cacheRoot: TEST_CACHE_ROOT });
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.cacheKey).toBe(first.cacheKey);
    expect(second.contentHash).toBe(first.contentHash);
    expect(existsSync(first.parquetPath)).toBe(true);
    expect(existsSync(`${first.parquetPath}.sha256`)).toBe(true);
  });

  it('forceRebuild rewrites an existing cache artifact', async () => {
    const fixturePath = resolve(FIXTURE_DIR, 'trades-minimal.dbn');
    const initial = await getCachedRecords(fixturePath, 'trades', { cacheRoot: TEST_CACHE_ROOT });
    const rebuilt = await getCachedRecords(fixturePath, 'trades', { cacheRoot: TEST_CACHE_ROOT, forceRebuild: true });
    expect(initial.cacheKey).toBe(rebuilt.cacheKey);
    expect(rebuilt.cacheHit).toBe(false);
  });

  it('rebuilds a cache artifact when the content hash sidecar no longer matches', async () => {
    const fixturePath = resolve(FIXTURE_DIR, 'tbbo-minimal.dbn');
    const built = await getCachedRecords(fixturePath, 'tbbo', { cacheRoot: TEST_CACHE_ROOT });
    writeFileSync(`${built.parquetPath}.sha256`, 'deadbeef\n', 'utf8');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rebuilt = await getCachedRecords(fixturePath, 'tbbo', { cacheRoot: TEST_CACHE_ROOT });
    expect(rebuilt.cacheHit).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('keeps final parquet absent when a write fails before atomic rename', async () => {
    const fixturePath = resolve(FIXTURE_DIR, 'ohlcv-1m-minimal.dbn');
    const { cacheKey } = await computeParquetCacheKey(fixturePath, 'ohlcv-1m');
    const finalPath = resolve(TEST_CACHE_ROOT, 'ohlcv-1m', `${cacheKey}.parquet`);
    await expect(
      writeParquetCache(fixturePath, 'ohlcv-1m', finalPath, {
        beforeCommit: () => {
          throw new Error('simulated pre-rename crash');
        },
      }),
    ).rejects.toThrow('simulated pre-rename crash');
    expect(existsSync(finalPath)).toBe(false);
  });

  it('round-trips every fixture schema through parquet cache', async () => {
    const fixtures = [
      ['mbo-minimal.dbn', 'mbo'],
      ['mbp-1-minimal.dbn', 'mbp-1'],
      ['mbp-10-minimal.dbn', 'mbp-10'],
      ['trades-minimal.dbn', 'trades'],
      ['tbbo-minimal.dbn', 'tbbo'],
      ['bbo-1s-minimal.dbn', 'bbo'],
      ['ohlcv-1m-minimal.dbn', 'ohlcv-1m'],
      ['definition-minimal.dbn', 'definition'],
      ['statistics-minimal.dbn', 'statistics'],
      ['status-minimal.dbn', 'status'],
    ] as const;

    for (const [fileName, schema] of fixtures) {
      const fixturePath = resolve(FIXTURE_DIR, fileName);
      const expected = await collectDbn(fixturePath, schema);
      const source = await getCachedRecords(fixturePath, schema, { cacheRoot: TEST_CACHE_ROOT });
      const actual = await collectCached(source.parquetPath, schema);
      expect(actual).toEqual(expected);
    }
  });

  it('returns configured default cache root from environment override', () => {
    process.env.QFA_PARQUET_CACHE_ROOT = 'X:/custom-parquet-cache';
    expect(getDefaultCacheRoot()).toBe('X:/custom-parquet-cache');
  });
});

describe.skipIf(!RUN_REAL_ARCHIVE_SMOKE || !existsSync(REAL_MBO_PATH))('QFA-103 real Tier A archive smoke', () => {
  it('builds and reads back a real MBO parquet cache artifact', async () => {
    const source = await getCachedRecords(REAL_MBO_PATH, 'mbo', { cacheRoot: TEST_CACHE_ROOT });
    let count = 0;
    for await (const record of readCachedRecords(source.parquetPath, 'mbo')) {
      expect(record.schema).toBe('mbo');
      count += 1;
      if (count === 3) {
        break;
      }
    }
    expect(count).toBeGreaterThan(0);
  }, 180_000);
});

