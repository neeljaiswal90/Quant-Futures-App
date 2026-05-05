// Module under test: data/dbn-binary; ticket QFA-102.
import { describe, expect, it } from 'vitest';
import { readAsciiChar, readFixedString, readInt32, readInt64, readUint16, readUint32, readUint64, readUint8 } from '../../../src/data/dbn-binary.js';
import { DbnFormatError } from '../../../src/data/dbn-errors.js';

describe('QFA-102 DBN binary readers', () => {
  const buffer = Buffer.from([
    0x7f,
    0x34, 0x12,
    0x78, 0x56, 0x34, 0x12,
    0xff, 0xff, 0xff, 0xff,
    0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
    0xf8, 0xff, 0xff, 0xff,
    0x48, 0x49, 0x00, 0x20,
    0x5a,
  ]);

  it('reads unsigned integer primitives little-endian', () => {
    expect(readUint8(buffer, 0).value).toBe(0x7f);
    expect(readUint16(buffer, 1).value).toBe(0x1234);
    expect(readUint32(buffer, 3).value).toBe(0x12345678);
    expect(readUint64(buffer, 11).value).toBe(0x0102030405060708n);
  });

  it('reads signed primitives little-endian', () => {
    expect(readInt32(buffer, 7).value).toBe(-1);
    expect(readInt64(Buffer.from([0xf8, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0).value).toBe(-8n);
  });

  it('reads fixed strings and chars', () => {
    expect(readFixedString(buffer, 23, 4).value).toBe('HI');
    expect(readAsciiChar(buffer, 27).value).toBe('Z');
  });

  it('throws DbnFormatError on under-read', () => {
    expect(() => readUint64(buffer, 25, 'fixture.dbn')).toThrow(DbnFormatError);
  });
});
