import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { DatabentoSchema } from '../contracts/tier-policy.js';
import { loadDbnFile } from './dbn-loader.js';
import {
  PARQUET_BIGINT_ENCODING_KEY,
  PARQUET_BIGINT_ENCODING_VALUE,
  PARQUET_FORMAT_VERSION,
  PARQUET_FORMAT_VERSION_KEY,
  PARQUET_SCHEMA_KEY,
  PARQUET_SCHEMAS,
  dbnToParquetRecord,
} from './parquet-schemas.js';

const require = createRequire(import.meta.url);
const parquet = require('parquetjs-lite') as {
  ParquetWriter: {
    openStream(schema: unknown, outputStream: NodeJS.WritableStream, options?: Record<string, unknown>): Promise<{
      appendRow(row: Record<string, unknown>): Promise<void>;
      close(): Promise<void>;
      setMetadata(key: string, value: string): void;
      setRowGroupSize(size: number): void;
    }>;
  };
};

export interface WriteParquetCacheResult {
  readonly parquetPath: string;
  readonly hashPath: string;
  readonly recordCount: number;
  readonly byteSize: number;
  readonly contentHash: string;
}

export interface WriteParquetCacheOptions {
  readonly beforeCommit?: (tmpPath: string) => Promise<void> | void;
}

function toHashPath(parquetPath: string): string {
  return `${parquetPath}.sha256`;
}

export async function writeParquetCache(
  dbnPath: string,
  schema: DatabentoSchema,
  parquetPath: string,
  options: WriteParquetCacheOptions = {},
): Promise<WriteParquetCacheResult> {
  const tmpPath = `${parquetPath}.tmp`;
  const hashPath = toHashPath(parquetPath);
  mkdirSync(dirname(parquetPath), { recursive: true });
  rmSync(tmpPath, { force: true });

  const hashingPassThrough = new PassThrough();
  const fileStream = createWriteStream(tmpPath);
  const fileFinished = finished(fileStream);
  const hash = createHash('sha256');
  hashingPassThrough.on('data', (chunk: Buffer) => hash.update(chunk));
  hashingPassThrough.pipe(fileStream);

  const writer = await parquet.ParquetWriter.openStream(
    PARQUET_SCHEMAS[schema],
    hashingPassThrough,
    { useDataPageV2: false },
  );
  writer.setMetadata(PARQUET_BIGINT_ENCODING_KEY, PARQUET_BIGINT_ENCODING_VALUE);
  writer.setMetadata(PARQUET_SCHEMA_KEY, schema);
  writer.setMetadata(PARQUET_FORMAT_VERSION_KEY, String(PARQUET_FORMAT_VERSION));
  writer.setRowGroupSize(8192);

  let recordCount = 0;
  try {
    for await (const record of loadDbnFile(dbnPath, schema)) {
      await writer.appendRow(dbnToParquetRecord(record));
      recordCount += 1;
    }
    await writer.close();
    await fileFinished;
    const contentHash = hash.digest('hex');
    if (options.beforeCommit) {
      await options.beforeCommit(tmpPath);
    }
    renameSync(tmpPath, parquetPath);
    writeFileSync(hashPath, `${contentHash}\n`, 'utf8');
    const byteSize = statSync(parquetPath).size;
    return Object.freeze({ parquetPath, hashPath, recordCount, byteSize, contentHash });
  } catch (error) {
    fileStream.destroy();
    rmSync(tmpPath, { force: true });
    throw error;
  }
}
