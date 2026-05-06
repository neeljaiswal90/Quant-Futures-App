import { describe, expect, it } from 'vitest';
import {
  canonicalizeReproJson,
  ReproHashInputError,
} from '../../../src/repro-hash/index.js';

describe('QFA-205 canonical_json_v1', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalizeReproJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":2}',
    );
    expect(canonicalizeReproJson({ a: { c: 3, d: 4 }, b: 2 })).toBe(
      canonicalizeReproJson({ b: 2, a: { d: 4, c: 3 } }),
    );
  });

  it('preserves array order', () => {
    expect(canonicalizeReproJson([1, 2])).not.toBe(canonicalizeReproJson([2, 1]));
  });

  it('type-tags bigint values and avoids bigint/string collision', () => {
    const bigintJson = canonicalizeReproJson({ x: 1n });
    const stringJson = canonicalizeReproJson({ x: '1' });

    expect(bigintJson).toBe('{"x":{"__qfa_type":"bigint","value":"1"}}');
    expect(bigintJson).not.toBe(stringJson);
  });

  it('does not normalize or mutate strings', () => {
    const composed = 'é';
    const decomposed = 'e\u0301';

    expect(canonicalizeReproJson({ value: composed })).not.toBe(
      canonicalizeReproJson({ value: decomposed }),
    );
  });

  it.each([
    ['undefined', { x: undefined }, 'undefined_value'],
    ['NaN', Number.NaN, 'non_finite_number'],
    ['Infinity', Number.POSITIVE_INFINITY, 'non_finite_number'],
    ['-Infinity', Number.NEGATIVE_INFINITY, 'non_finite_number'],
    ['negative zero', -0, 'negative_zero'],
    ['Date', new Date('2026-01-01T00:00:00Z'), 'date_value_forbidden'],
    ['function', () => 1, 'unsupported_value'],
    ['symbol', Symbol('x'), 'unsupported_value'],
  ])('rejects %s', (_label, value, code) => {
    expect(() => canonicalizeReproJson(value)).toThrow(ReproHashInputError);
    expect(() => canonicalizeReproJson(value)).toThrow(code);
  });

  it('rejects sparse arrays and symbol-keyed object properties', () => {
    const sparse = [1, , 3];
    const symbolKeyed = { x: 1, [Symbol('hidden')]: 2 };

    expect(() => canonicalizeReproJson(sparse)).toThrow('undefined_value');
    expect(() => canonicalizeReproJson(symbolKeyed)).toThrow('unsupported_value');
  });
});
