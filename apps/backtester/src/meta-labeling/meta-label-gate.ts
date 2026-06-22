/**
 * Composes a trained meta-label model + the inference feature builder into a
 * take/skip filter for the real-archive replay gate
 * (RealArchiveBacktestOptions.meta_labeling_filter).
 *
 * The loop driver loads model.json, validates the feature-spec order against the
 * inference encoder, builds the filter here, and passes it to the runner; the
 * runner calls it per armed signal and skips the trade when it returns false.
 * Inference is pure TS (no Python at gate time).
 */

import { buildMetaLabelFeatures, type MetaLabelFeatureInput } from './meta-label-features.js';
import { metaLabelTake, type MetaLabelModel } from './meta-label-model.js';

export function makeMetaLabelFilter(
  model: MetaLabelModel,
  takeThreshold: number,
): (input: MetaLabelFeatureInput) => boolean {
  return (input) => metaLabelTake(model, buildMetaLabelFeatures(input), takeThreshold);
}
