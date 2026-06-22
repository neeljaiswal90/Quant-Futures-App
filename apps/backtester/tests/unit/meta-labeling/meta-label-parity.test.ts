import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseMetaLabelModel,
  predictMetaLabelProbability,
} from '../../../src/meta-labeling/meta-label-model.js';

const FIXTURE_DIR = join(process.cwd(), 'apps/backtester/tests/unit/meta-labeling/fixtures');

interface ParitySample {
  readonly features: readonly (number | null)[];
  readonly proba: number;
}

describe('meta-label xgboost parity', () => {
  it('reproduces xgboost binary:logistic predictions within float32 tolerance', () => {
    const model = parseMetaLabelModel(
      JSON.parse(readFileSync(join(FIXTURE_DIR, 'model.json'), 'utf8')),
    );
    const samples = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'samples.json'), 'utf8'),
    ) as readonly ParitySample[];

    expect(samples.length).toBeGreaterThan(0);
    // xgboost.predict returns float32; 1e-5 confirms faithful reproduction
    // (including the missing-value default-direction sample).
    for (const sample of samples) {
      const predicted = predictMetaLabelProbability(model, sample.features);
      expect(Math.abs(predicted - sample.proba)).toBeLessThan(1e-5);
    }
  });

  it('fails closed on an unsupported objective', () => {
    expect(() =>
      parseMetaLabelModel({
        learner: {
          objective: { name: 'reg:squarederror' },
          learner_model_param: { num_feature: '8', base_score: '[5e-1]' },
          gradient_booster: { model: { trees: [{}] } },
        },
      }),
    ).toThrow(/unsupported objective/);
  });
});
