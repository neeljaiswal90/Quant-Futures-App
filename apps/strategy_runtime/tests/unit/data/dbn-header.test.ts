// Module under test: data/dbn-header; ticket QFA-102.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DbnFormatError } from '../../../src/data/dbn-errors.js';
import { parseDbnHeader } from '../../../src/data/dbn-header.js';

const FIXTURE_DIR = resolve('apps/strategy_runtime/tests/fixtures/dbn');

describe('QFA-102 DBN header parser', () => {
  it('parses minimal MBO fixture metadata', () => {
    const buffer = readFileSync(resolve(FIXTURE_DIR, 'mbo-minimal.dbn'));
    const { header, recordsOffset } = parseDbnHeader(buffer);
    expect(header.version).toBe(1);
    expect(header.dataset).toBe('GLBX.MDP3');
    expect(header.schema).toBe('mbo');
    expect(header.wire_schema).toBe('mbo');
    expect(recordsOffset).toBe(header.records_offset);
    expect(recordsOffset).toBeGreaterThan(8);
  });

  it('normalizes bbo-1s wire schema to logical bbo', () => {
    const buffer = readFileSync(resolve(FIXTURE_DIR, 'bbo-1s-minimal.dbn'));
    const { header } = parseDbnHeader(buffer);
    expect(header.schema).toBe('bbo');
    expect(header.wire_schema).toBe('bbo-1s');
  });

  it('rejects malformed magic bytes', () => {
    const buffer = readFileSync(resolve(FIXTURE_DIR, 'malformed-magic.dbn'));
    expect(() => parseDbnHeader(buffer)).toThrow(DbnFormatError);
  });
});
