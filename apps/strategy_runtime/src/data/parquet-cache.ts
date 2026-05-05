import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabentoSchema } from '../contracts/tier-policy.js';
import type { DbnRecord } from './dbn-types.js';
import { translateLegacyDbnPath } from './dbn-loader.js';
import { purgeCorruptParquetCache, readParquetCache, verifyParquetCache } from './parquet-cache-read.js';
import { PARQUET_FORMAT_VERSION, ParquetCacheError } from './parquet-schemas.js';
import { writeParquetCache } from './parquet-cache-write.js';

export interface CachedRecordSource {
  readonly parquetPath: string;
  readonly cacheKey: string;
  readonly schema: DatabentoSchema;
  readonly recordCount: number;
  readonly byteSize: number;
  readonly contentHash: string;
  readonly cacheHit: boolean;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export function getDefaultCacheRoot(): string {
  if (process.env.QFA_PARQUET_CACHE_ROOT && process.env.QFA_PARQUET_CACHE_ROOT.trim() !== '') {
    return process.env.QFA_PARQUET_CACHE_ROOT;
  }
  if (process.platform === 'win32') {
    return 'D:/qfa-cache/parquet';
  }
  return join(homedir(), '.qfa-cache', 'parquet');
}

export async function computeParquetCacheKey(
  dbnPath: string,
  schema: DatabentoSchema,
): Promise<{ readonly dbnContentHash: string; readonly cacheKey: string }> {
  const dbnContentHash = await sha256File(translateLegacyDbnPath(dbnPath));
  const cacheKey = createHash('sha256')
    .update(`${dbnContentHash}:${schema}:${PARQUET_FORMAT_VERSION}`)
    .digest('hex')
    .slice(0, 32);
  return Object.freeze({ dbnContentHash, cacheKey });
}

export async function getCachedRecords(
  dbnPath: string,
  schema: DatabentoSchema,
  options: {
    readonly cacheRoot?: string;
    readonly forceRebuild?: boolean;
  } = {},
): Promise<CachedRecordSource> {
  const resolvedDbnPath = translateLegacyDbnPath(dbnPath);
  const cacheRoot = options.cacheRoot ?? getDefaultCacheRoot();
  mkdirSync(join(cacheRoot, schema), { recursive: true });
  const { cacheKey } = await computeParquetCacheKey(resolvedDbnPath, schema);
  const parquetPath = join(cacheRoot, schema, `${cacheKey}.parquet`);

  if (!options.forceRebuild && existsSync(parquetPath) && existsSync(`${parquetPath}.sha256`)) {
    try {
      const verified = await verifyParquetCache(parquetPath, schema);
      const byteSize = statSync(parquetPath).size;
      return Object.freeze({
        parquetPath,
        cacheKey,
        schema,
        recordCount: verified.recordCount,
        byteSize,
        contentHash: verified.contentHash,
        cacheHit: true,
      });
    } catch (error) {
      console.warn(`Parquet cache verification failed for ${parquetPath}; rebuilding cache.`, error);
      purgeCorruptParquetCache(parquetPath);
    }
  }

  const written = await writeParquetCache(resolvedDbnPath, schema, parquetPath);
  return Object.freeze({
    parquetPath,
    cacheKey,
    schema,
    recordCount: written.recordCount,
    byteSize: written.byteSize,
    contentHash: written.contentHash,
    cacheHit: false,
  });
}

export async function* readCachedRecords(
  parquetPath: string,
  schema: DatabentoSchema,
): AsyncIterableIterator<DbnRecord> {
  yield* readParquetCache(parquetPath, schema);
}
