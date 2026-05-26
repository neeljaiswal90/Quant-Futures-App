import { createReadStream } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import type { DatabentoSchema } from '../contracts/tier-policy.js';
import { DbnFormatError } from './dbn-errors.js';
import { parseDbnHeader } from './dbn-header.js';
import { parseDbnRecord } from './dbn-records.js';
import { DBN_HEADER_LENGTH_PREFIX_BYTES, DBN_RECORD_LENGTHS, type DbnRecord, type DbnWireSchema } from './dbn-types.js';

const ZSTD_FRAME_MAGIC = 0xfd2fb528;
const ZSTD_SKIPPABLE_FRAME_MAGIC_MIN = 0x184d2a50;
const ZSTD_SKIPPABLE_FRAME_MAGIC_MAX = 0x184d2a5f;

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

function isZstdSkippableFrameMagic(magic: number): boolean {
  return magic >= ZSTD_SKIPPABLE_FRAME_MAGIC_MIN && magic <= ZSTD_SKIPPABLE_FRAME_MAGIC_MAX;
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function zstdDictionaryIdFieldBytes(flag: number): number {
  switch (flag) {
    case 0:
      return 0;
    case 1:
      return 1;
    case 2:
      return 2;
    case 3:
      return 4;
    default:
      return 0;
  }
}

function zstdFrameContentSizeFieldBytes(flag: number, singleSegment: boolean): number {
  switch (flag) {
    case 0:
      return singleSegment ? 1 : 0;
    case 1:
      return 2;
    case 2:
      return 4;
    case 3:
      return 8;
    default:
      return 0;
  }
}

function tryGetZstdFrameLength(buffer: Buffer, filePath: string): number | null {
  if (buffer.length < 4) {
    return null;
  }

  const magic = buffer.readUInt32LE(0);
  if (isZstdSkippableFrameMagic(magic)) {
    if (buffer.length < 8) {
      return null;
    }
    const frameLength = 8 + buffer.readUInt32LE(4);
    return buffer.length >= frameLength ? frameLength : null;
  }

  if (magic !== ZSTD_FRAME_MAGIC) {
    throw new DbnFormatError({
      filePath,
      byteOffset: 0,
      message: 'Invalid ZSTD frame magic',
      expected: `0x${ZSTD_FRAME_MAGIC.toString(16)}`,
      actual: `0x${magic.toString(16)}`,
    });
  }

  if (buffer.length < 5) {
    return null;
  }

  const descriptor = buffer[4];
  const frameContentSizeFlag = descriptor >> 6;
  const singleSegment = (descriptor & 0x20) !== 0;
  const reservedBit = (descriptor & 0x08) !== 0;
  const checksumFlag = (descriptor & 0x04) !== 0;
  const dictionaryIdFlag = descriptor & 0x03;

  if (reservedBit) {
    throw new DbnFormatError({
      filePath,
      byteOffset: 4,
      message: 'Unsupported ZSTD frame descriptor',
      actual: `0x${descriptor.toString(16)}`,
    });
  }

  let cursor = 5;
  if (!singleSegment) {
    cursor += 1;
  }
  cursor += zstdDictionaryIdFieldBytes(dictionaryIdFlag);
  cursor += zstdFrameContentSizeFieldBytes(frameContentSizeFlag, singleSegment);

  if (buffer.length < cursor) {
    return null;
  }

  while (true) {
    if (buffer.length < cursor + 3) {
      return null;
    }

    const blockHeader = readUInt24LE(buffer, cursor);
    cursor += 3;

    const lastBlock = (blockHeader & 0x01) === 0x01;
    const blockType = (blockHeader >> 1) & 0x03;
    const blockSize = blockHeader >> 3;

    if (blockType === 3) {
      throw new DbnFormatError({
        filePath,
        byteOffset: cursor - 3,
        message: 'Unsupported ZSTD reserved block type',
      });
    }

    cursor += blockType === 1 ? 1 : blockSize;
    if (buffer.length < cursor) {
      return null;
    }

    if (lastBlock) {
      break;
    }
  }

  if (checksumFlag) {
    cursor += 4;
  }

  return buffer.length >= cursor ? cursor : null;
}

async function* iterateZstdFrames(path: string): AsyncIterableIterator<Buffer> {
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  for await (const chunk of iterateFileChunks(path)) {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let frameLength = tryGetZstdFrameLength(pending, path);
    while (frameLength !== null) {
      const frame = pending.subarray(0, frameLength);
      if (!isZstdSkippableFrameMagic(frame.readUInt32LE(0))) {
        yield Buffer.from(zstdDecompressSync(frame));
      }
      pending = pending.subarray(frameLength);
      frameLength = pending.length > 0 ? tryGetZstdFrameLength(pending, path) : null;
    }
  }
  if (pending.length > 0) {
    const frameLength = tryGetZstdFrameLength(pending, path);
    if (frameLength === null || frameLength !== pending.length) {
      throw new DbnFormatError({
        filePath: path,
        byteOffset: 0,
        message: 'ZSTD file ended with an incomplete frame tail',
      });
    }
    if (!isZstdSkippableFrameMagic(pending.readUInt32LE(0))) {
      yield Buffer.from(zstdDecompressSync(pending));
    }
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
