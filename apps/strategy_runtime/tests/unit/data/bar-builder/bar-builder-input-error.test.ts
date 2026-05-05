import { describe, expect, it } from 'vitest';
import {
  BarBuilderInputError,
  type BarBuilderErrorCode,
} from '../../../../src/data/bar-builder/bar-builder-input-error.js';

/**
 * Module under test: src/data/bar-builder/bar-builder-input-error.ts
 * Ticket: QFA-104 Session 2a
 */

describe('QFA-104 BarBuilderInputError', () => {
  it('aggregates issues into a structured error', () => {
    const error = new BarBuilderInputError([
      { path: '$.bar_spec', code: 'unsupported_bar_spec', message: 'unsupported' },
      { path: '$.input_schemas', code: 'incompatible_input_schema', message: 'incompatible' },
    ]);
    expect(error.issues).toHaveLength(2);
    expect(error.message).toContain('$.bar_spec [unsupported_bar_spec]: unsupported');
    expect(error.message).toContain('$.input_schemas [incompatible_input_schema]: incompatible');
  });

  it('covers all declared error codes', () => {
    const codes: readonly BarBuilderErrorCode[] = [
      'unsupported_bar_spec',
      'unrecognized_manifest_symbol',
      'incompatible_input_schema',
      'manifest_concrete_mismatch',
      'manifest_continuous_rule_mismatch',
      'incompatible_root',
      'subminute_from_ohlcv',
      'roll_unsplittable_aggregate',
    ];
    expect(codes).toHaveLength(8);
  });

  it('uses the configured heading', () => {
    const error = new BarBuilderInputError(
      [{ path: '$.bar_spec', code: 'unsupported_bar_spec', message: 'unsupported' }],
      'Custom heading',
    );
    expect(error.message.startsWith('Custom heading:')).toBe(true);
  });
});
