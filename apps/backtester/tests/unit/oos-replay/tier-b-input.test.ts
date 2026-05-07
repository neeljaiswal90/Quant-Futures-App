import { describe, expect, it } from 'vitest';
import {
  buildTierBOosInputSpec,
  OosReplayInputError,
} from '../../../src/oos-replay/index.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('QFA-403 Tier B OOS input spec', () => {
  it('builds a Tier B input spec for an actual Tier B corpus', () => {
    const spec = buildTierBOosInputSpec({
      data_mode: 'tier_b_corpus',
      corpus_manifests: [{ event_schemas: ['mbp-1', 'trades'] }],
      corpus_manifest_hashes: [HASH_A],
      fidelity_status: 'passed',
    });

    expect(spec).toEqual({
      spec_schema_version: 1,
      data_mode: 'tier_b_corpus',
      required_schemas: ['mbp-1', 'trades'],
      corpus_manifest_hashes: [HASH_A],
      fidelity_status: 'passed',
    });
  });

  it('builds a Tier A projection spec using MBP-1 + trades', () => {
    const spec = buildTierBOosInputSpec({
      data_mode: 'tier_b_projection_from_tier_a',
      corpus_manifests: [
        { event_schemas: ['trades', 'mbp-1', 'mbp-10', 'mbo'] },
        { event_schemas: ['trades', 'mbp-1', 'mbp-10', 'mbo'] },
      ],
      corpus_manifest_hashes: [HASH_A, HASH_B],
    });

    expect(spec.data_mode).toBe('tier_b_projection_from_tier_a');
    expect(spec.required_schemas).toEqual(['mbp-1', 'trades']);
    expect(spec.fidelity_status).toBe('pending');
  });

  it('rejects missing MBP-1 schema', () => {
    expect(() =>
      buildTierBOosInputSpec({
        data_mode: 'tier_b_projection_from_tier_a',
        corpus_manifests: [{ event_schemas: ['trades', 'mbp-10'] }],
        corpus_manifest_hashes: [HASH_A],
      }),
    ).toThrow(OosReplayInputError);
  });

  it('rejects missing trades schema', () => {
    expect(() =>
      buildTierBOosInputSpec({
        data_mode: 'tier_b_projection_from_tier_a',
        corpus_manifests: [{ event_schemas: ['mbp-1', 'mbp-10'] }],
        corpus_manifest_hashes: [HASH_A],
      }),
    ).toThrow(/trades/);
  });
});
