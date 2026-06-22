import { describe, expect, it } from 'vitest';

import type { MetaLabelFeatureInput } from '../../../src/meta-labeling/meta-label-features.js';
import { makeMetaLabelFilter } from '../../../src/meta-labeling/meta-label-gate.js';
import type { MetaLabelModel } from '../../../src/meta-labeling/meta-label-model.js';

// A trivial model whose every input yields probability 0.7
// (single leaf with weight 0; intercept = logit(0.7)).
const PROBABILITY = 0.7;
const MODEL: MetaLabelModel = {
  base_margin: Math.log(PROBABILITY / (1 - PROBABILITY)),
  num_feature: 11,
  trees: [
    {
      split_indices: [0],
      split_conditions: [0],
      left_children: [-1],
      right_children: [-1],
      default_left: [0],
      base_weights: [0],
    },
  ],
};

const INPUT: MetaLabelFeatureInput = {
  side: 'long',
  regime_label: 'high',
  vix_value: 18,
  vix_fresh: true,
  signed_shock_value: 1,
  signed_shock_anchor: 0,
  signed_shock_sigma: 1,
  spread_bucket: '1-tick',
  queue_ahead_bucket: '1-5',
};

describe('meta-label gate filter', () => {
  it('takes the signal when probability >= threshold', () => {
    expect(makeMetaLabelFilter(MODEL, 0.5)(INPUT)).toBe(true);
  });

  it('skips the signal when probability < threshold', () => {
    expect(makeMetaLabelFilter(MODEL, 0.8)(INPUT)).toBe(false);
  });
});
