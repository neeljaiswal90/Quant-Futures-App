/**
 * Canonical meta-label feature encoder (inference side).
 *
 * MUST stay in lockstep with the Python trainer encoder in
 * scripts/strategy-gen/meta_labeling/train_meta_label.py (FEATURE_NAMES and
 * encode_features). The vector is produced in META_LABEL_FEATURE_NAMES order;
 * the xgboost model's split indices reference these positions.
 *
 * Missing numerics are passed through as `null` (the evaluator routes them via
 * each node's default direction) — matching the trainer, which encodes missing
 * numerics as NaN. Unknown categorical buckets map to ordinal 0.
 */

export const META_LABEL_FEATURE_NAMES = [
  'side_is_long',
  'regime_high',
  'regime_mid',
  'regime_low',
  'vix_value',
  'vix_fresh',
  'signed_shock_value',
  'signed_shock_anchor',
  'signed_shock_sigma',
  'spread_bucket_ord',
  'queue_ahead_bucket_ord',
] as const;

export const SPREAD_BUCKET_ORD: Readonly<Record<string, number>> = {
  unknown: 0,
  '1-tick': 1,
  '2-tick': 2,
  '3+ ticks': 3,
};

export const QUEUE_AHEAD_BUCKET_ORD: Readonly<Record<string, number>> = {
  unknown: 0,
  '1-5': 1,
  '6-20': 2,
  '21+': 3,
};

export interface MetaLabelFeatureInput {
  readonly side: 'long' | 'short';
  readonly regime_label: string | null;
  readonly vix_value: number | null;
  readonly vix_fresh: boolean;
  readonly signed_shock_value: number | null;
  readonly signed_shock_anchor: number | null;
  readonly signed_shock_sigma: number | null;
  readonly spread_bucket: string;
  readonly queue_ahead_bucket: string;
}

export function buildMetaLabelFeatures(input: MetaLabelFeatureInput): (number | null)[] {
  return [
    input.side === 'long' ? 1 : 0,
    input.regime_label === 'high' ? 1 : 0,
    input.regime_label === 'mid' ? 1 : 0,
    input.regime_label === 'low' ? 1 : 0,
    input.vix_value,
    input.vix_fresh ? 1 : 0,
    input.signed_shock_value,
    input.signed_shock_anchor,
    input.signed_shock_sigma,
    SPREAD_BUCKET_ORD[input.spread_bucket] ?? 0,
    QUEUE_AHEAD_BUCKET_ORD[input.queue_ahead_bucket] ?? 0,
  ];
}

/**
 * Fail closed if a loaded feature-spec's ordered names diverge from this
 * inference encoder — the model was trained against a different feature layout.
 */
export function assertFeatureSpecMatches(spec: { readonly feature_names?: unknown }): void {
  const names = spec.feature_names;
  if (
    !Array.isArray(names) ||
    names.length !== META_LABEL_FEATURE_NAMES.length ||
    names.some((name, index) => name !== META_LABEL_FEATURE_NAMES[index])
  ) {
    throw new Error(
      'meta-label feature-spec feature_names do not match the inference encoder; ' +
        'retrain or update the encoder',
    );
  }
}
