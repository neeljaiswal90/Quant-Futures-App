import { describe, expect, it } from 'vitest';
import { BarBuilderInputError } from '../../../../src/data/bar-builder/bar-builder-input-error.js';
import {
  checkManifestSymbol,
  parseManifestSymbol,
} from '../../../../src/data/bar-builder/manifest-symbol.js';
import { DEFAULT_MNQ_ROLL_POLICY } from '../../../../src/data/bar-builder/roll-policy.js';

/**
 * Module under test: src/data/bar-builder/manifest-symbol.ts
 * Ticket: QFA-104 Session 2a
 */

describe('QFA-104 checkManifestSymbol', () => {
  it('accepts matching concrete manifest and stream contract', () => {
    expect(
      checkManifestSymbol(
        parseManifestSymbol('MNQH6'),
        { instrument_id: 1, raw_symbol: 'MNQH6', root: 'MNQ' },
        DEFAULT_MNQ_ROLL_POLICY,
      ),
    ).toEqual({
      manifest_symbol: 'MNQH6',
      expectation_type: 'concrete_contract',
      status: 'matched',
      message: 'manifest concrete symbol matches the first resolved stream contract',
    });
  });

  it('throws on concrete mismatch', () => {
    expect(() =>
      checkManifestSymbol(
        parseManifestSymbol('MNQH6'),
        { instrument_id: 2, raw_symbol: 'MNQM6', root: 'MNQ' },
        DEFAULT_MNQ_ROLL_POLICY,
      ),
    ).toThrow(BarBuilderInputError);
    expect(() =>
      checkManifestSymbol(
        parseManifestSymbol('MNQH6'),
        { instrument_id: 2, raw_symbol: 'MNQM6', root: 'MNQ' },
        DEFAULT_MNQ_ROLL_POLICY,
      ),
    ).toThrow(/manifest_concrete_mismatch/);
  });

  it('accepts root-only manifests when roots are compatible', () => {
    expect(
      checkManifestSymbol(
        parseManifestSymbol('MNQ'),
        { instrument_id: 1, raw_symbol: 'MNQH6', root: 'MNQ' },
        DEFAULT_MNQ_ROLL_POLICY,
      ).status,
    ).toBe('roll_compatible');
  });

  it('accepts compatible continuous manifests', () => {
    expect(
      checkManifestSymbol(
        parseManifestSymbol('MNQ.v.0'),
        { instrument_id: 1, raw_symbol: 'MNQH6', root: 'MNQ' },
        DEFAULT_MNQ_ROLL_POLICY,
      ),
    ).toEqual({
      manifest_symbol: 'MNQ.v.0',
      expectation_type: 'continuous_symbol',
      status: 'roll_compatible',
      message: 'manifest continuous symbol is compatible with the resolved root and configured roll policy',
    });
  });

  it('throws on continuous rule mismatch', () => {
    expect(() =>
      checkManifestSymbol(
        parseManifestSymbol('MNQ.c.0'),
        { instrument_id: 1, raw_symbol: 'MNQH6', root: 'MNQ' },
        DEFAULT_MNQ_ROLL_POLICY,
      ),
    ).toThrow(/manifest_continuous_rule_mismatch/);
  });

  it('returns unverified when only instrument id is available', () => {
    expect(
      checkManifestSymbol(
        parseManifestSymbol('MNQH6'),
        { instrument_id: 12345, raw_symbol: null, root: null },
        DEFAULT_MNQ_ROLL_POLICY,
      ).status,
    ).toBe('unverified');
  });

  it('throws on incompatible root', () => {
    expect(() =>
      checkManifestSymbol(
        parseManifestSymbol('MNQ'),
        { instrument_id: 1, raw_symbol: 'ESH6', root: 'ES' },
        DEFAULT_MNQ_ROLL_POLICY,
      ),
    ).toThrow(/incompatible_root/);
  });
});
