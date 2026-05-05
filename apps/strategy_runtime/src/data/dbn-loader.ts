import { createReadStream } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import type { DatabentoSchema } from '../contracts/tier-policy.js';
import { DbnFormatError } from './dbn-errors.js';
import { parseDbnHeader } from './dbn-header.js';
import { parseDbnRecord } from './dbn-records.js';
import { DBN_HEADER_LENGTH_PREFIX_BYTES, DBN_RECORD_LENGTHS, type DbnRecord, type DbnWireSchema } from './dbn-types.js';

const ZSTD_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Translate legacy manifest-emitted archive paths from `A:\` to `D:\`.
 *
 * This implements the documented inventory rule locally inside the loader.
 * The rule is not yet a shared contract primitive elsewhere in the repo.
 */
export function translateLegacyDbnPath(path: string): string {
  if (/^[Aa]:\\/.test(path)) {
    return `D:${path.slice(2)}`;
  }
  if (/^[Aa]:\//.test(path)) {
    return `D:${path.slice(2)}`;
  }
  return path;
}

function isZstdPath(path: string): boolean {
  return path.toLowerCase().endsWith('.zst');
}

function findNextZstdFrameBoundary(buffer: Buffer): number {
  return buffer.indexOf(ZSTD_FRAME_MAGIC, ZSTD_FRAME_MAGIC.length);
}

async function* iterateFileChunks(path: string): AsyncIterableIterator<Buffer> {
  const fileStream = createReadStream(path, { highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of fileStream) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
  } finally {
    fileStream.destroy();
  }
}

async function* iterateZstdFrames(path: string): AsyncIterableIterator<Buffer> {
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  for await (const chunk of iterateFileChunks(path)) {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let boundary = findNextZstdFrameBoundary(pending);
    while (boundary > 0) {
      const frame = pending.subarray(0, boundary);
      pending = pending.subarray(boundary);
      yield Buffer.from(zstdDecompressSync(frame));
      boundary = findNextZstdFrameBoundary(pending);
    }
  }
  if (pending.length > 0) {
    yield Buffer.from(zstdDecompressSync(pending));
  }
}

function schemaMatchesExpected(actualWireSchema: DbnWireSchema, expected: DatabentoSchema): boolean {
  if (expected === 'bbo') {
    return actualWireSchema === 'bbo-1s' || actualWireSchema === 'bbo-1m';
  }
  return actualWireSchema === expected;
}

export async function* loadDbnFile(
  path: string,
  expectedSchema: DatabentoSchema,
): AsyncIterableIterator<DbnRecord> {
  const resolvedPath = translateLegacyDbnPath(path);
  const source = isZstdPath(resolvedPath)
    ? iterateZstdFrames(resolvedPath)
    : iterateFileChunks(resolvedPath);

  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let headerParsed = false;
  let recordSchema: DbnWireSchema | null = null;
  let recordLength = 0;
  let byteCursor = 0;

  for await (const chunk of source) {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);

    if (!headerParsed) {
      if (pending.length < DBN_HEADER_LENGTH_PREFIX_BYTES) {
        continue;
      }
      const metadataLength = pending.readUInt32LE(4);
      const recordsOffset = DBN_HEADER_LENGTH_PREFIX_BYTES + metadataLength;
      if (pending.length < recordsOffset) {
        continue;
      }
      const parsed = parseDbnHeader(pending.subarray(0, recordsOffset));
      if (!schemaMatchesExpected(parsed.header.wire_schema, expectedSchema)) {
        throw new DbnFormatError({
          filePath: resolvedPath,
          byteOffset: 0,
          message: 'DBN header schema does not match expected schema',
          expected: expectedSchema,
          actual: parsed.header.wire_schema,
        });
      }
      headerParsed = true;
      recordSchema = parsed.header.wire_schema;
      recordLength = DBN_RECORD_LENGTHS[recordSchema];
      pending = pending.subarray(recordsOffset);
      byteCursor = recordsOffset;
    }

    while (recordSchema !== null && pending.length >= recordLength) {
      const { record, nextOffset } = parseDbnRecord(
        pending,
        0,
        recordSchema,
        resolvedPath,
      );
      yield record;
      pending = pending.subarray(nextOffset);
      byteCursor += nextOffset;
    }
  }

  if (!headerParsed) {
    throw new DbnFormatError({
      filePath: resolvedPath,
      byteOffset: 0,
      message: 'DBN file ended before a complete header was available',
    });
  }

  if (pending.length > 0) {
    throw new DbnFormatError({
      filePath: resolvedPath,
      byteOffset: byteCursor,
      message: 'DBN file ended with a truncated record tail',
      expected: `${recordLength} bytes`,
      actual: `${pending.length} bytes`,
    });
  }
}
