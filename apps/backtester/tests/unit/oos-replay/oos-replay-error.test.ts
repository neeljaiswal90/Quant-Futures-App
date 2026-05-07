import { describe, expect, it } from 'vitest';
import {
  buildTierBOosInputSpec,
  OosReplayInputError,
} from '../../../src/oos-replay/index.js';

describe('QFA-403 OOS replay input errors', () => {
  it('surfaces aggregate issues with paths and codes', () => {
    try {
      buildTierBOosInputSpec({
        data_mode: 'tier_b_projection_from_tier_a',
        corpus_manifests: [{ event_schemas: [] }],
        corpus_manifest_hashes: ['not-a-hash'],
      });
      throw new Error('expected input error');
    } catch (error) {
      expect(error).toBeInstanceOf(OosReplayInputError);
      expect((error as OosReplayInputError).issues.map((issue) => issue.code)).toEqual([
        'missing_mbp1_schema',
        'missing_trades_schema',
        'missing_manifest_hash',
      ]);
    }
  });
});
