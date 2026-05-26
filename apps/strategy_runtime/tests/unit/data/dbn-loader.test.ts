// Module under test: data/dbn-loader; ticket QFA-102.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DbnFormatError } from '../../../src/data/dbn-errors.js';
import { loadDbnFile, translateLegacyDbnPath } from '../../../src/data/dbn-loader.js';

const FIXTURE_DIR = resolve('apps/strategy_runtime/tests/fixtures/dbn');
const REAL_MBO_PATH =
  'D:/qfa-cache/databento/tier-a-feb-mar-2026/2026-02-03-rth/mbo.dbn.zst';
const ZSTD_FRAME_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

async function collectSchemas(path: string, schema: Parameters<typeof loadDbnFile>[1]) {
  const records = [];
  for await (const record of loadDbnFile(path, schema)) {
    records.push(record);
  }
  return records;
}

describe('QFA-102 DBN loader', () => {
  it('streams all records from a small MBO fixture', async () => {
    const records = await collectSchemas(resolve(FIXTURE_DIR, 'mbo-minimal.dbn'), 'mbo');
    expect(records).toHaveLength(3);
    expect(records.every((record) => record.schema === 'mbo')).toBe(true);
  });

  it('throws on schema mismatch between header and expected schema', async () => {
    await expect(
      collectSchemas(resolve(FIXTURE_DIR, 'mbo-minimal.dbn'), 'trades'),
    ).rejects.toThrow(DbnFormatError);
  });

  it('streams multi-frame zstd fixtures without buffering the full decompressed file', async () => {
    const records = await collectSchemas(
      resolve(FIXTURE_DIR, 'mbo-minimal-multiframe.dbn.zst'),
      'mbo',
    );
    expect(records).toHaveLength(3);
  });

  it('preserves record continuity when a multi-frame zstd boundary splits a DBN record', async () => {
    const uncompressed = await collectSchemas(resolve(FIXTURE_DIR, 'mbo-minimal.dbn'), 'mbo');
    const straddled = await collectSchemas(
      resolve(FIXTURE_DIR, 'mbo-multiframe-straddle.dbn.zst'),
      'mbo',
    );
    expect(straddled).toEqual(uncompressed);
  });

  it('uses exact zstd frame lengths when compressed payload contains frame magic bytes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'qfa-dbn-loader-'));
    try {
      const source = readFileSync(resolve(FIXTURE_DIR, 'mbo-minimal.dbn'));
      const recordsOffset = 8 + source.readUInt32LE(4);
      const recordLength = source[recordsOffset] * 4;
      const record = Buffer.from(source.subarray(recordsOffset, recordsOffset + recordLength));
      ZSTD_FRAME_MAGIC_BYTES.copy(record, 8);

      const compressed = zstdCompressSync(Buffer.concat([source.subarray(0, recordsOffset), record]));
      expect(compressed.indexOf(ZSTD_FRAME_MAGIC_BYTES, ZSTD_FRAME_MAGIC_BYTES.length)).toBeGreaterThan(0);

      const path = join(tempDir, 'embedded-frame-magic.dbn.zst');
      writeFileSync(path, compressed);

      const records = await collectSchemas(path, 'mbo');
      expect(records).toHaveLength(1);
      expect(records[0]?.schema).toBe('mbo');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('terminates cleanly at EOF', async () => {
    const records = await collectSchemas(resolve(FIXTURE_DIR, 'trades-minimal.dbn'), 'trades');
    expect(records).toHaveLength(5);
  });

  it('throws on truncated trailing record bytes', async () => {
    await expect(
      collectSchemas(resolve(FIXTURE_DIR, 'truncated-mid-record.dbn'), 'mbo'),
    ).rejects.toThrow(DbnFormatError);
  });

  it('translates legacy A: paths to D: before opening', async () => {
    const canonical = resolve(FIXTURE_DIR, 'mbo-minimal.dbn');
    const legacy = canonical.replace(/^D:/i, 'A:');
    expect(translateLegacyDbnPath(legacy)).toBe(canonical);
    const records = await collectSchemas(legacy, 'mbo');
    expect(records).toHaveLength(3);
  });

  it('accepts bbo-1s and bbo-1m headers when expected schema is bbo', async () => {
    const bbo1s = await collectSchemas(resolve(FIXTURE_DIR, 'bbo-1s-minimal.dbn'), 'bbo');
    const bbo1m = await collectSchemas(resolve(FIXTURE_DIR, 'bbo-1m-minimal.dbn'), 'bbo');
    expect(bbo1s[0]?.schema).toBe('bbo');
    expect(bbo1m[0]?.schema).toBe('bbo');
    if (bbo1s[0]?.schema !== 'bbo' || bbo1m[0]?.schema !== 'bbo') {
      throw new Error('Expected normalized bbo records');
    }
    expect(bbo1s[0].bbo_interval).toBe('1s');
    expect(bbo1m[0].bbo_interval).toBe('1m');
  });
});

describe.skipIf(!existsSync(REAL_MBO_PATH))('QFA-102 real Tier A archive smoke', () => {
  it('reads at least one real MBO record from the Tier A archive', async () => {
    let count = 0;
    for await (const record of loadDbnFile(REAL_MBO_PATH, 'mbo')) {
      expect(record.schema).toBe('mbo');
      count += 1;
      if (count === 3) {
        break;
      }
    }
    expect(count).toBeGreaterThan(0);
  });
});
