import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabentoSchema } from '../contracts/tier-policy.js';
import type { DbnRecord } from './dbn-types.js';
import {
  PARQUET_BIGINT_ENCODING_KEY,
  PARQUET_BIGINT_ENCODING_VALUE,
  PARQUET_FORMAT_VERSION,
  PARQUET_FORMAT_VERSION_KEY,
  PARQUET_SCHEMA_KEY,
  ParquetCacheError,
  parquetToDbnRecord,
} from './parquet-schemas.js';

const require = createRequire(import.meta.url);
const parquet = require('parquetjs-lite') as {
  ParquetReader: {
    openFile(path: string): Promise<{
      getCursor(columnList?: unknown): { next(): Promise<Record<string, unknown> | null> };
      getMetadata(): Record<string, string>;
      getRowCount(): number;
      close(): Promise<void>;
    }>;
  };
};

export interface VerifiedParquetCache {
  readonly contentHash: string;
  readonly recordCount: number;
}

function toHashPath(parquetPath: string): string {
  return `${parquetPath}.sha256`;
}

async function computeFileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export async function verifyParquetCache(
  parquetPath: string,
  schema: DatabentoSchema,
): Promise<VerifiedParquetCache> {
  const hashPath = toHashPath(parquetPath);
  const expectedHash = readFileSync(hashPath, 'utf8').trim();
  const contentHash = await computeFileHash(parquetPath);
  if (contentHash !== expectedHash) {
    throw new ParquetCacheError(`Parquet cache hash mismatch for ${parquetPath}`);
  }

  const reader = await parquet.ParquetReader.openFile(parquetPath);
  try {
    const metadata = reader.getMetadata();
    if (metadata[PARQUET_BIGINT_ENCODING_KEY] !== PARQUET_BIGINT_ENCODING_VALUE) {
      throw new ParquetCacheError(`Unsupported bigint encoding metadata for ${parquetPath}`);
    }
    if (metadata[PARQUET_SCHEMA_KEY] !== schema) {
      throw new ParquetCacheError(`Parquet cache schema metadata mismatch for ${parquetPath}`);
    }
    if (metadata[PARQUET_FORMAT_VERSION_KEY] !== String(PARQUET_FORMAT_VERSION)) {
      throw new ParquetCacheError(`Parquet cache format version mismatch for ${parquetPath}`);
    }
    return Object.freeze({ contentHash, recordCount: reader.getRowCount() });
  } finally {
    await reader.close();
  }
}

export async function* readParquetCache(
  parquetPath: string,
  schema: DatabentoSchema,
): AsyncIterableIterator<DbnRecord> {
  await verifyParquetCache(parquetPath, schema);
  const reader = await parquet.ParquetReader.openFile(parquetPath);
  try {
    const cursor = reader.getCursor();
    while (true) {
      const row = await cursor.next();
      if (row === null) {
        break;
      }
      yield parquetToDbnRecord(row, schema);
    }
  } finally {
    await reader.close();
  }
}

export function purgeCorruptParquetCache(parquetPath: string): void {
  rmSync(parquetPath, { force: true });
  rmSync(toHashPath(parquetPath), { force: true });
}
