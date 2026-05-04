/**
 * Runtime-enforceable encoding of the Databento data-tier taxonomy (ADR-002).
 *
 * The three-tier model:
 *   - Tier A: full microstructure ground truth (`mbo` and `mbp-10`).
 *     Used for fidelity validation and fill-model recalibration.
 *   - Tier B: book-aware microstructure without per-order depth
 *     (`mbp-1` and `trades` and `tbbo`). Used for 12-month historical
 *     backtests and OOS replay.
 *   - Tier C: aggregated bars (`ohlcv-1m`). Used for long-horizon model
 *     training (HMM, HAR-RV, GARCH).
 *
 * `SCHEMA_TIER_MAP` is the single source of truth for tier classification.
 * The runbook tier table at `docs/RUNBOOK-backtester.md#tier-policy` is
 * its human-readable view; both must agree. Any change to tier semantics
 * requires updating BOTH atomically.
 *
 * Reference schemas (`definition`, `statistics`, `status`) are listed in
 * `REFERENCE_SCHEMAS`. They are available across all tiers and do NOT
 * affect tier classification — `classifyCorpusTier` filters them out
 * before checking tier-required-schemas presence.
 *
 * Introduced in QFA-106 (Phase 0). Consumers wire in via QFA-102, QFA-104,
 * QFA-105; this module ships as a usable-but-unused policy primitive.
 */

import type { CorpusManifest } from './corpus-manifest.js';

/** A discrete data tier per ADR-002. Lower-rank tiers are richer. */
export type DataTier = 'A' | 'B' | 'C';

/**
 * Canonical Databento schema names recognized by the tier policy.
 * Matches the Databento catalog identifiers used in corpus manifests.
 */
export type DatabentoSchema =
  | 'mbo'
  | 'mbp-10'
  | 'mbp-1'
  | 'trades'
  | 'tbbo'
  | 'bbo'
  | 'ohlcv-1m'
  | 'definition'
  | 'statistics'
  | 'status';

/**
 * Maps each Databento schema to the data tier it is part of (in terms of
 * informational richness). A schema's tier in this map describes which
 * tier the schema is associated with, not whether its presence alone
 * satisfies a tier's requirements — see `TIER_REQUIRED_SCHEMAS` for that.
 */
export const SCHEMA_TIER_MAP: Readonly<Record<DatabentoSchema, DataTier>> = Object.freeze({
  mbo: 'A',
  'mbp-10': 'A',
  'mbp-1': 'B',
  trades: 'B',
  tbbo: 'B',
  bbo: 'B',
  'ohlcv-1m': 'C',
  definition: 'C',
  statistics: 'C',
  status: 'C',
});

/**
 * Numeric rank for tier ordering. Lower rank means richer data.
 * `TIER_RANK[corpus] <= TIER_RANK[required]` is the compatibility check.
 */
export const TIER_RANK: Readonly<Record<DataTier, number>> = Object.freeze({
  A: 0,
  B: 1,
  C: 2,
});

/**
 * Schemas required for a corpus to qualify as a given tier. A corpus
 * qualifies as tier X if it contains ALL of `TIER_REQUIRED_SCHEMAS[X]`.
 * Reference schemas (see `REFERENCE_SCHEMAS`) are not listed here and
 * do not contribute to tier classification.
 */
export const TIER_REQUIRED_SCHEMAS: Readonly<Record<DataTier, readonly DatabentoSchema[]>> =
  Object.freeze({
    A: Object.freeze(['mbo', 'mbp-10']) as readonly DatabentoSchema[],
    B: Object.freeze(['mbp-1', 'trades', 'tbbo']) as readonly DatabentoSchema[],
    C: Object.freeze(['ohlcv-1m']) as readonly DatabentoSchema[],
  });

/**
 * Reference data schemas. Their presence or absence does not affect the
 * tier classification of a corpus — `classifyCorpusTier` filters them
 * out before checking tier-required-schemas presence.
 */
export const REFERENCE_SCHEMAS: ReadonlySet<DatabentoSchema> = new Set<DatabentoSchema>([
  'definition',
  'statistics',
  'status',
]);

/** Result of classifying a corpus by its available schemas. */
export interface CorpusTierClassification {
  /** Best (lowest TIER_RANK) tier whose required schemas are all present. */
  readonly effectiveTier: DataTier;
  /** Schemas observed in the manifest, deduped, in stable enum order. */
  readonly availableSchemas: readonly DatabentoSchema[];
  /** Schema names observed but not in the recognized DatabentoSchema union. */
  readonly unrecognizedSchemas: readonly string[];
  /** Human-readable explanation of which schemas drove the classification. */
  readonly classification_reason: string;
}

/** Result of checking whether a corpus tier satisfies a required tier. */
export interface TierCompatibilityResult {
  /** True if the corpus tier is at least as rich as the required tier. */
  readonly compatible: boolean;
  /** Human-readable explanation of the compatibility result. */
  readonly reason: string;
}

const ALL_SCHEMAS_IN_ENUM_ORDER: readonly DatabentoSchema[] = Object.freeze([
  'mbo',
  'mbp-10',
  'mbp-1',
  'trades',
  'tbbo',
  'bbo',
  'ohlcv-1m',
  'definition',
  'statistics',
  'status',
]);

const RECOGNIZED_SCHEMA_SET: ReadonlySet<DatabentoSchema> = new Set<DatabentoSchema>(
  ALL_SCHEMAS_IN_ENUM_ORDER,
);

function isRecognizedSchema(value: string): value is DatabentoSchema {
  return (RECOGNIZED_SCHEMA_SET as ReadonlySet<string>).has(value);
}

/**
 * Classify a corpus manifest's effective data tier by walking its sessions,
 * uniting per-session schema keys, and selecting the best tier whose full
 * required schema set is present. Reference schemas are excluded from
 * tier-required-schemas checks.
 *
 * The function is pure and inexpensive; do not memoize. A corpus with no
 * recognized non-reference schemas (e.g., reference-only) classifies as
 * Tier C with a `classification_reason` documenting the default.
 */
export function classifyCorpusTier(manifest: CorpusManifest): CorpusTierClassification {
  const seen = new Set<string>();
  for (const session of manifest.sessions) {
    for (const schemaName of Object.keys(session.schemas)) {
      seen.add(schemaName);
    }
  }

  const recognized: DatabentoSchema[] = [];
  const unrecognized: string[] = [];
  for (const name of seen) {
    if (isRecognizedSchema(name)) {
      recognized.push(name);
    } else {
      unrecognized.push(name);
    }
  }

  const recognizedSet = new Set<DatabentoSchema>(recognized);
  const microstructure = recognized.filter((schema) => !REFERENCE_SCHEMAS.has(schema));
  const microstructureSet = new Set<DatabentoSchema>(microstructure);

  const orderedTiers: DataTier[] = ['A', 'B', 'C'];
  let effectiveTier: DataTier = 'C';
  let classificationReason = '';
  let matched = false;
  for (const tier of orderedTiers) {
    const required = TIER_REQUIRED_SCHEMAS[tier];
    const missing = required.filter((schema) => !microstructureSet.has(schema));
    if (missing.length === 0) {
      effectiveTier = tier;
      classificationReason = `Tier ${tier}: required schemas ${required.join(', ')} all present`;
      matched = true;
      break;
    }
  }

  if (!matched) {
    if (microstructure.length === 0) {
      classificationReason =
        'no microstructure schemas present; defaulted to Tier C';
    } else {
      classificationReason =
        `no tier's required-schemas set fully satisfied by available microstructure (${microstructure.join(', ')}); defaulted to Tier C`;
    }
  }

  // Stable order for downstream lineage hashing: enum order, deduped, recognized only.
  const availableSchemas = ALL_SCHEMAS_IN_ENUM_ORDER.filter((schema) => recognizedSet.has(schema));

  return Object.freeze({
    effectiveTier,
    availableSchemas: Object.freeze(availableSchemas) as readonly DatabentoSchema[],
    unrecognizedSchemas: Object.freeze([...unrecognized].sort()) as readonly string[],
    classification_reason: classificationReason,
  });
}

/**
 * Check whether a corpus tier satisfies a required tier. A corpus is
 * compatible with a required tier when the corpus tier is at least as
 * rich (TIER_RANK[corpus] <= TIER_RANK[required]).
 */
export function checkTierCompatibility(
  corpusTier: DataTier,
  requiredTier: DataTier,
): TierCompatibilityResult {
  const corpusRank = TIER_RANK[corpusTier];
  const requiredRank = TIER_RANK[requiredTier];
  const compatible = corpusRank <= requiredRank;
  const reason = compatible
    ? `corpus Tier ${corpusTier} (rank ${corpusRank}) satisfies required Tier ${requiredTier} (rank ${requiredRank})`
    : `corpus Tier ${corpusTier} (rank ${corpusRank}) is less rich than required Tier ${requiredTier} (rank ${requiredRank})`;
  return Object.freeze({ compatible, reason });
}

/**
 * Error thrown by downstream loaders when tier compatibility fails.
 * Carries the required tier, observed corpus tier, available schemas,
 * and the human-readable classification reason. No environment captured.
 */
export class TierPolicyError extends Error {
  /** Tier required by the consumer that detected the violation. */
  public readonly requiredTier: DataTier;
  /** Tier the corpus was classified as. */
  public readonly corpusTier: DataTier;
  /** Schemas the corpus declared, deduped, recognized only. */
  public readonly availableSchemas: readonly DatabentoSchema[];
  /** Human-readable classification reason from `classifyCorpusTier`. */
  public readonly classificationReason: string;

  constructor(args: {
    readonly requiredTier: DataTier;
    readonly corpusTier: DataTier;
    readonly availableSchemas: readonly DatabentoSchema[];
    readonly classificationReason: string;
    readonly message?: string;
  }) {
    const message =
      args.message
      ?? `Tier policy violation: corpus Tier ${args.corpusTier} cannot satisfy required Tier ${args.requiredTier} (${args.classificationReason})`;
    super(message);
    this.name = 'TierPolicyError';
    this.requiredTier = args.requiredTier;
    this.corpusTier = args.corpusTier;
    this.availableSchemas = args.availableSchemas;
    this.classificationReason = args.classificationReason;
  }
}
