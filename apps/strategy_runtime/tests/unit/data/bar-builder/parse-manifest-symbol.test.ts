import { describe, expect, it } from 'vitest';
import { BarBuilderInputError } from '../../../../src/data/bar-builder/bar-builder-input-error.js';
import { parseBarSpec } from '../../../../src/data/bar-builder/bar-spec.js';
import { parseManifestSymbol } from '../../../../src/data/bar-builder/manifest-symbol.js';

/**
 * Module under test: src/data/bar-builder/manifest-symbol.ts
 * Ticket: QFA-104 Session 2a
 */

describe('QFA-104 parseManifestSymbol', () => {
  it('parses volume continuous symbols', () => {
    expect(parseManifestSymbol('MNQ.v.0')).toEqual({
      type: 'continuous_symbol',
      root: 'MNQ',
      roll_rule: 'volume_front_month',
      rank: 0,
      raw_symbol: 'MNQ.v.0',
    });
  });

  it('parses calendar continuous symbols', () => {
    expect(parseManifestSymbol('MNQ.c.0')).toEqual({
      type: 'continuous_symbol',
      root: 'MNQ',
      roll_rule: 'calendar_front_month',
      rank: 0,
      raw_symbol: 'MNQ.c.0',
    });
  });

  it('parses concrete contracts', () => {
    expect(parseManifestSymbol('MNQH6')).toEqual({
      type: 'concrete_contract',
      root: 'MNQ',
      raw_symbol: 'MNQH6',
    });
    expect(parseManifestSymbol('MNQM6')).toEqual({
      type: 'concrete_contract',
      root: 'MNQ',
      raw_symbol: 'MNQM6',
    });
  });

  it('parses root-only symbols', () => {
    expect(parseManifestSymbol('MNQ')).toEqual({
      type: 'root',
      root: 'MNQ',
    });
  });

  it('rejects invalid month code symbols', () => {
    expect(() => parseManifestSymbol('MNQA6')).toThrow(BarBuilderInputError);
  });

  it('rejects missing year concrete symbols', () => {
    expect(() => parseManifestSymbol('MNQH')).toThrow(BarBuilderInputError);
  });

  it('rejects empty symbols', () => {
    expect(() => parseManifestSymbol('')).toThrow(BarBuilderInputError);
  });

  it('rejects invalid formats', () => {
    expect(() => parseManifestSymbol('invalid.format')).toThrow(BarBuilderInputError);
  });

  it('shares run-spec grammar expectations with parseBarSpec', () => {
    expect(parseBarSpec('1m').token).toBe('1m');
    expect(parseBarSpec('tick:ticks:100').token).toBe('tick100');
  });
});
