import { describe, expect, it } from 'vitest';

import {
  META_LABEL_FEATURE_NAMES,
  assertFeatureSpecMatches,
  buildMetaLabelFeatures,
} from '../../../src/meta-labeling/meta-label-features.js';

describe('meta-label feature builder', () => {
  it('encodes a known signal in canonical order', () => {
    const vector = buildMetaLabelFeatures({
      side: 'long',
      regime_label: 'high',
      vix_value: 18.5,
      vix_fresh: true,
      signed_shock_value: 1.25,
      signed_shock_anchor: 0,
      signed_shock_sigma: 1,
      spread_bucket: '2-tick',
      queue_ahead_bucket: '6-20',
    });
    // Must match the Python encoder's expected vector for the same input
    // (scripts/strategy-gen/meta_labeling/tests/test_train_meta_label.py).
    expect(vector).toEqual([1, 1, 0, 0, 18.5, 1, 1.25, 0, 1, 2, 2]);
    expect(vector.length).toBe(META_LABEL_FEATURE_NAMES.length);
  });

  it('passes missing numerics through as null and unknown buckets as ordinal 0', () => {
    const vector = buildMetaLabelFeatures({
      side: 'short',
      regime_label: 'unknown',
      vix_value: null,
      vix_fresh: false,
      signed_shock_value: null,
      signed_shock_anchor: null,
      signed_shock_sigma: null,
      spread_bucket: 'unknown',
      queue_ahead_bucket: 'unknown',
    });
    expect(vector).toEqual([0, 0, 0, 0, null, 0, null, null, null, 0, 0]);
  });

  it('fails closed when a feature-spec order diverges', () => {
    expect(() => assertFeatureSpecMatches({ feature_names: ['side_is_long'] })).toThrow();
    expect(() =>
      assertFeatureSpecMatches({ feature_names: [...META_LABEL_FEATURE_NAMES] }),
    ).not.toThrow();
  });
});
