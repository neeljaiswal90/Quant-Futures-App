import { DbnFormatError } from './dbn-errors.js';

export interface ReadResult<T> {
  readonly value: T;
  readonly nextOffset: number;
}

function ensureReadable(
  buffer: Buffer,
  offset: number,
  width: number,
  filePath: string,
): void {
  if (offset < 0 || offset + width > buffer.length) {
    throw new DbnFormatError({
      filePath,
      byteOffset: offset,
      message: 'DBN buffer under-read',
      expected: `${width} bytes available`,
      actual: `${Math.max(buffer.length - offset, 0)} bytes available`,
    });
  }
}

export function readUint8(buffer: Buffer, offset: number, filePath = '<buffer>'): ReadResult<number> {
  ensureReadable(buffer, offset, 1, filePath);
  return { value: buffer.readUInt8(offset), nextOffset: offset + 1 };
}

export function readUint16(buffer: Buffer, offset: number, filePath = '<buffer>'): ReadResult<number> {
  ensureReadable(buffer, offset, 2, filePath);
  return { value: buffer.readUInt16LE(offset), nextOffset: offset + 2 };
}

export function readUint32(buffer: Buffer, offset: number, filePath = '<buffer>'): ReadResult<number> {
  ensureReadable(buffer, offset, 4, filePath);
  return { value: buffer.readUInt32LE(offset), nextOffset: offset + 4 };
}

export function readInt32(buffer: Buffer, offset: number, filePath = '<buffer>'): ReadResult<number> {
  ensureReadable(buffer, offset, 4, filePath);
  return { value: buffer.readInt32LE(offset), nextOffset: offset + 4 };
}

export function readUint64(buffer: Buffer, offset: number, filePath = '<buffer>'): ReadResult<bigint> {
  ensureReadable(buffer, offset, 8, filePath);
  return { value: buffer.readBigUInt64LE(offset), nextOffset: offset + 8 };
}

export function readInt64(buffer: Buffer, offset: number, filePath = '<buffer>'): ReadResult<bigint> {
  ensureReadable(buffer, offset, 8, filePath);
  return { value: buffer.readBigInt64LE(offset), nextOffset: offset + 8 };
}

export function readFixedString(
  buffer: Buffer,
  offset: number,
  length: number,
  filePath = '<buffer>',
): ReadResult<string> {
  ensureReadable(buffer, offset, length, filePath);
  const raw = buffer.subarray(offset, offset + length);
  const nullIndex = raw.indexOf(0);
  const slice = nullIndex === -1 ? raw : raw.subarray(0, nullIndex);
  return { value: slice.toString('utf8').trimEnd(), nextOffset: offset + length };
}

export function readAsciiChar(
  buffer: Buffer,
  offset: number,
  filePath = '<buffer>',
): ReadResult<string> {
  ensureReadable(buffer, offset, 1, filePath);
  return { value: buffer.toString('ascii', offset, offset + 1), nextOffset: offset + 1 };
}
