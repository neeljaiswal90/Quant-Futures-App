import {
  ACTIVE_STRATEGY_IDS,
  isStrategyId,
  type StrategyId,
} from '../../../strategy_runtime/src/contracts/strategy-ids.js';
import {
  REPLAY_SANITY_PLACEHOLDER_FIELDS,
  STRATEGY_REPLAY_FEATURE_SOURCE,
  type StrategyReplayEvaluation,
  type StrategyReplayResult,
} from '../strategy-replay/index.js';
import type {
  StrategyFingerprint,
  StrategyFingerprintSet,
} from '../strategy-fingerprint/index.js';
import {
  throwCapabilityAssessmentIssues,
  type CapabilityAssessmentIssue,
} from './capability-assessment-error.js';
import type {
  BuildCapabilityAssessmentOptions,
  CapabilityAssessmentSet,
  FeatureCapabilityStatus,
  StrategyCapabilityAssessment,
  StrategyCapabilityLimitation,
  StrategyCapabilityLimitationCode,
  StrategyFeatureCapability,
  StrategyFeatureCapabilityCategory,
} from './types.js';

const FEATURE_CATEGORY_ORDER: readonly StrategyFeatureCapabilityCategory[] = [
  'instrument',
  'session',
  'quote',
  'bars',
  'indicators',
  'structure',
  'microstructure',
  'config_lineage',
  'fingerprint',
] as const;

const LIMITATION_ORDER: readonly StrategyCapabilityLimitationCode[] = [
  'unknown_strategy_id',
  'replay_missing',
  'strategy_not_exercised',
  'fingerprint_missing',
  'empty_decision_sequence',
  'placeholder_session',
  'placeholder_quote',
  'placeholder_indicators',
  'placeholder_structure',
  'placeholder_microstructure',
  'config_lineage_unverified',
] as const;

const PLACEHOLDER_LIMITATIONS: ReadonlyMap<
  StrategyFeatureCapabilityCategory,
  StrategyCapabilityLimitationCode
> = new Map([
  ['session', 'placeholder_session'],
  ['quote', 'placeholder_quote'],
  ['indicators', 'placeholder_indicators'],
  ['structure', 'placeholder_structure'],
  ['microstructure', 'placeholder_microstructure'],
]);

export function buildCapabilityAssessmentSet(
  replay: StrategyReplayResult | readonly StrategyReplayEvaluation[],
  fingerprints: StrategyFingerprintSet,
  options: BuildCapabilityAssessmentOptions = {},
): CapabilityAssessmentSet {
  const evaluations = extractReplayEvaluations(replay);
  const strategyOrder = resolveStrategyOrder(
    options.strategy_order,
    options.allow_partial_strategy_order ?? false,
  );
  validateReplayStrategies(evaluations, strategyOrder);
  const fingerprintsByStrategy = indexFingerprints(fingerprints);
  const replayCounts = countReplayEvaluations(evaluations);
  const baseFeatures = resolveBaseFeatureCapabilities(options.feature_capabilities);

  return {
    assessment_set_schema_version: 1,
    assessments: strategyOrder.map((strategyId) =>
      buildStrategyAssessment(
        strategyId,
        replayCounts.get(strategyId) ?? 0,
        fingerprintsByStrategy.get(strategyId) ?? null,
        baseFeatures,
      ),
    ),
  };
}

function buildStrategyAssessment(
  strategyId: StrategyId,
  replayEvaluations: number,
  fingerprint: StrategyFingerprint | null,
  baseFeatures: readonly StrategyFeatureCapability[],
): StrategyCapabilityAssessment {
  const fingerprintFeature = buildFingerprintFeature(fingerprint);
  const features = sortFeatures([...baseFeatures, fingerprintFeature]);
  const limitations = buildLimitations(replayEvaluations, fingerprint, features);
  const status = deriveCapabilityStatus(replayEvaluations, fingerprint, features);

  return {
    assessment_schema_version: 1,
    strategy_id: strategyId,
    status,
    replay_evaluations: replayEvaluations,
    fingerprint_sha256: fingerprint?.fingerprint_sha256 ?? null,
    decision_count: fingerprint?.decision_count ?? null,
    features,
    limitations,
  };
}

function extractReplayEvaluations(
  replay: StrategyReplayResult | readonly StrategyReplayEvaluation[],
): readonly StrategyReplayEvaluation[] {
  if (Array.isArray(replay)) {
    return replay;
  }
  if (replay === null || typeof replay !== 'object') {
    throwCapabilityAssessmentIssues([
      {
        path: '$.replay',
        code: 'missing_replay_input',
        message: 'replay input must be a StrategyReplayResult or evaluation array',
      },
    ]);
  }
  const maybeReplay = replay as Partial<StrategyReplayResult>;
  if (!Array.isArray(maybeReplay.evaluations)) {
    throwCapabilityAssessmentIssues([
      {
        path: '$.replay.evaluations',
        code: 'malformed_replay_input',
        message: 'StrategyReplayResult.evaluations must be an array',
      },
    ]);
  }
  return maybeReplay.evaluations;
}

function resolveStrategyOrder(
  strategyOrder: readonly StrategyId[] | undefined,
  allowPartialStrategyOrder: boolean,
): readonly StrategyId[] {
  if (strategyOrder === undefined) {
    return [...ACTIVE_STRATEGY_IDS];
  }

  const issues: CapabilityAssessmentIssue[] = [];
  const seen = new Set<StrategyId>();
  strategyOrder.forEach((strategyId, index) => {
    const path = `$.strategy_order[${index}]`;
    if (!isStrategyId(strategyId)) {
      issues.push({
        path,
        code: 'unknown_strategy_id',
        message: `unknown strategy_id: ${String(strategyId)}`,
      });
      return;
    }
    if (seen.has(strategyId)) {
      issues.push({
        path,
        code: 'duplicate_strategy_id',
        message: `duplicate strategy_id: ${strategyId}`,
      });
      return;
    }
    seen.add(strategyId);
  });

  if (!allowPartialStrategyOrder) {
    const missing = ACTIVE_STRATEGY_IDS.filter((strategyId) => !seen.has(strategyId));
    for (const strategyId of missing) {
      issues.push({
        path: '$.strategy_order',
        code: 'malformed_replay_input',
        message: `strategy_order must include ${strategyId}`,
      });
    }
  }

  if (issues.length > 0) {
    throwCapabilityAssessmentIssues(issues);
  }
  return [...strategyOrder];
}

function validateReplayStrategies(
  evaluations: readonly StrategyReplayEvaluation[],
  strategyOrder: readonly StrategyId[],
): void {
  const issues: CapabilityAssessmentIssue[] = [];
  const allowed = new Set(strategyOrder);

  evaluations.forEach((evaluation, index) => {
    const strategyId = (evaluation as unknown as Record<string, unknown>).strategy_id;
    if (typeof strategyId !== 'string' || !isStrategyId(strategyId)) {
      issues.push({
        path: `$.replay.evaluations[${index}].strategy_id`,
        code: 'unknown_strategy_id',
        message: `unknown replay strategy_id: ${String(strategyId)}`,
      });
      return;
    }
    if (!allowed.has(strategyId)) {
      issues.push({
        path: `$.replay.evaluations[${index}].strategy_id`,
        code: 'malformed_replay_input',
        message: `replay evaluation strategy_id ${strategyId} is not in strategy_order`,
      });
    }
  });

  if (issues.length > 0) {
    throwCapabilityAssessmentIssues(issues);
  }
}

function indexFingerprints(
  fingerprints: StrategyFingerprintSet,
): ReadonlyMap<StrategyId, StrategyFingerprint> {
  const record = fingerprints as unknown as Record<string, unknown>;
  if (fingerprints === null || typeof fingerprints !== 'object') {
    throwCapabilityAssessmentIssues([
      {
        path: '$.fingerprints',
        code: 'missing_fingerprint_set',
        message: 'fingerprint set is required',
      },
    ]);
  }
  if (!Array.isArray(record.fingerprints)) {
    throwCapabilityAssessmentIssues([
      {
        path: '$.fingerprints.fingerprints',
        code: 'malformed_fingerprint_set',
        message: 'fingerprint set must contain a fingerprints array',
      },
    ]);
  }

  const issues: CapabilityAssessmentIssue[] = [];
  const byStrategy = new Map<StrategyId, StrategyFingerprint>();
  record.fingerprints.forEach((fingerprint, index) => {
    const path = `$.fingerprints.fingerprints[${index}]`;
    if (fingerprint === null || typeof fingerprint !== 'object') {
      issues.push({
        path,
        code: 'malformed_fingerprint_set',
        message: 'fingerprint entry must be an object',
      });
      return;
    }
    const strategyId = (fingerprint as Record<string, unknown>).strategy_id;
    if (typeof strategyId !== 'string' || !isStrategyId(strategyId)) {
      issues.push({
        path: `${path}.strategy_id`,
        code: 'unknown_strategy_id',
        message: `unknown fingerprint strategy_id: ${String(strategyId)}`,
      });
      return;
    }
    if (byStrategy.has(strategyId)) {
      issues.push({
        path: `${path}.strategy_id`,
        code: 'duplicate_strategy_id',
        message: `duplicate fingerprint for ${strategyId}`,
      });
      return;
    }
    const typedFingerprint = fingerprint as StrategyFingerprint;
    if (typedFingerprint.strategy_id !== strategyId) {
      issues.push({
        path: `${path}.strategy_id`,
        code: 'fingerprint_strategy_mismatch',
        message: `fingerprint strategy_id mismatch for ${strategyId}`,
      });
      return;
    }
    byStrategy.set(strategyId, typedFingerprint);
  });

  if (issues.length > 0) {
    throwCapabilityAssessmentIssues(issues);
  }

  return byStrategy;
}

function countReplayEvaluations(
  evaluations: readonly StrategyReplayEvaluation[],
): ReadonlyMap<StrategyId, number> {
  const counts = new Map<StrategyId, number>();
  for (const evaluation of evaluations) {
    counts.set(evaluation.strategy_id, (counts.get(evaluation.strategy_id) ?? 0) + 1);
  }
  return counts;
}

function resolveBaseFeatureCapabilities(
  featureCapabilities: readonly StrategyFeatureCapability[] | undefined,
): readonly StrategyFeatureCapability[] {
  if (featureCapabilities !== undefined) {
    return validateFeatureCapabilities(featureCapabilities);
  }

  const placeholder = (category: StrategyFeatureCapabilityCategory, details: string) => ({
    category,
    status: 'placeholder' as const,
    source: STRATEGY_REPLAY_FEATURE_SOURCE,
    details,
  });

  return sortFeatures([
    {
      category: 'instrument',
      status: 'real',
      source: 'BuiltBar',
      details: 'instrument identity is derived from the replay bar',
    },
    placeholder(
      'session',
      placeholderDetails(['session.trading_date', 'session.phase']),
    ),
    placeholder('quote', placeholderDetails(['quote.bid_px', 'quote.ask_px'])),
    {
      category: 'bars',
      status: 'real',
      source: 'BuiltBar',
      details: 'OHLCV bar values are derived from the replay bar',
    },
    placeholder('indicators', placeholderDetails(['indicators.supertrend_direction'])),
    placeholder(
      'structure',
      placeholderDetails([
        'structure.values.breakout_level',
        'structure.values.broken_support',
        'structure.values.retest_hold',
        'structure.values.retest_reject',
      ]),
    ),
    placeholder(
      'microstructure',
      placeholderDetails(['microstructure.l3_authority', 'microstructure.values.ofi_z']),
    ),
    {
      category: 'config_lineage',
      status: 'unverified',
      source: null,
      details: 'strategy config lineage is emitted by strategy defaults but not replay-verified',
    },
  ]);
}

function validateFeatureCapabilities(
  featureCapabilities: readonly StrategyFeatureCapability[],
): readonly StrategyFeatureCapability[] {
  const issues: CapabilityAssessmentIssue[] = [];
  const seen = new Set<StrategyFeatureCapabilityCategory>();
  const accepted: StrategyFeatureCapability[] = [];

  featureCapabilities.forEach((feature, index) => {
    const path = `$.feature_capabilities[${index}]`;
    if (!FEATURE_CATEGORY_ORDER.includes(feature.category)) {
      issues.push({
        path: `${path}.category`,
        code: 'malformed_replay_input',
        message: `unknown feature capability category: ${String(feature.category)}`,
      });
      return;
    }
    if (feature.category === 'fingerprint') {
      issues.push({
        path: `${path}.category`,
        code: 'malformed_fingerprint_set',
        message: 'fingerprint capability is derived from the fingerprint set',
      });
      return;
    }
    if (seen.has(feature.category)) {
      issues.push({
        path: `${path}.category`,
        code: 'malformed_replay_input',
        message: `duplicate feature capability category: ${feature.category}`,
      });
      return;
    }
    seen.add(feature.category);
    accepted.push({
      category: feature.category,
      status: validateFeatureStatus(feature.status, path, issues),
      source: feature.source,
      details: feature.details,
    });
  });

  for (const category of FEATURE_CATEGORY_ORDER) {
    if (category === 'fingerprint' || seen.has(category)) {
      continue;
    }
    issues.push({
      path: '$.feature_capabilities',
      code: 'malformed_replay_input',
      message: `feature capability inventory must include ${category}`,
    });
  }

  if (issues.length > 0) {
    throwCapabilityAssessmentIssues(issues);
  }

  return sortFeatures(accepted);
}

function validateFeatureStatus(
  status: FeatureCapabilityStatus,
  path: string,
  issues: CapabilityAssessmentIssue[],
): FeatureCapabilityStatus {
  const statuses: readonly FeatureCapabilityStatus[] = [
    'real',
    'placeholder',
    'unavailable',
    'not_required',
    'unverified',
  ];
  if (!statuses.includes(status)) {
    issues.push({
      path: `${path}.status`,
      code: 'malformed_replay_input',
      message: `unknown feature capability status: ${String(status)}`,
    });
  }
  return status;
}

function buildFingerprintFeature(
  fingerprint: StrategyFingerprint | null,
): StrategyFeatureCapability {
  if (fingerprint === null) {
    return {
      category: 'fingerprint',
      status: 'unavailable',
      source: null,
      details: 'QFA-302 fingerprint is missing for this strategy',
    };
  }
  return {
    category: 'fingerprint',
    status: 'real',
    source: 'qfa_strategy_fingerprint_sha256_v1',
    details: `fingerprint_sha256=${fingerprint.fingerprint_sha256}`,
  };
}

function buildLimitations(
  replayEvaluations: number,
  fingerprint: StrategyFingerprint | null,
  features: readonly StrategyFeatureCapability[],
): readonly StrategyCapabilityLimitation[] {
  const limitations: StrategyCapabilityLimitation[] = [];
  const add = (code: StrategyCapabilityLimitationCode, message: string) => {
    limitations.push({ code, message });
  };

  if (replayEvaluations === 0) {
    add('replay_missing', 'strategy has no replay evaluations');
    add('strategy_not_exercised', 'strategy was not exercised by the replay input');
  }
  if (fingerprint === null) {
    add('fingerprint_missing', 'strategy is missing a QFA-302 fingerprint');
  } else if (fingerprint.decision_count === 0) {
    add('empty_decision_sequence', 'strategy fingerprint has an empty decision sequence');
  }

  for (const feature of features) {
    if (feature.status === 'placeholder') {
      const limitationCode = PLACEHOLDER_LIMITATIONS.get(feature.category);
      if (limitationCode !== undefined) {
        add(limitationCode, `${feature.category} uses ${feature.source} placeholder data`);
      }
    }
    if (feature.category === 'config_lineage' && feature.status === 'unverified') {
      add('config_lineage_unverified', 'strategy config lineage is not replay-verified');
    }
  }

  return sortLimitations(limitations);
}

function deriveCapabilityStatus(
  replayEvaluations: number,
  fingerprint: StrategyFingerprint | null,
  features: readonly StrategyFeatureCapability[],
): StrategyCapabilityAssessment['status'] {
  if (replayEvaluations === 0 || fingerprint === null) {
    return 'blocked';
  }
  if (fingerprint.decision_count === 0) {
    return 'degraded_replay';
  }
  if (
    features.some(
      (feature) =>
        feature.status === 'placeholder' ||
        feature.status === 'unavailable' ||
        feature.status === 'unverified',
    )
  ) {
    return 'degraded_replay';
  }
  return 'ready_for_replay';
}

function sortFeatures(
  features: readonly StrategyFeatureCapability[],
): readonly StrategyFeatureCapability[] {
  return [...features].sort(
    (left, right) =>
      FEATURE_CATEGORY_ORDER.indexOf(left.category) -
      FEATURE_CATEGORY_ORDER.indexOf(right.category),
  );
}

function sortLimitations(
  limitations: readonly StrategyCapabilityLimitation[],
): readonly StrategyCapabilityLimitation[] {
  return [...limitations].sort((left, right) => {
    const codeOrder =
      LIMITATION_ORDER.indexOf(left.code) - LIMITATION_ORDER.indexOf(right.code);
    if (codeOrder !== 0) {
      return codeOrder;
    }
    return left.message.localeCompare(right.message);
  });
}

function placeholderDetails(fields: readonly string[]): string {
  const present = fields.filter((field) => REPLAY_SANITY_PLACEHOLDER_FIELDS.includes(field as never));
  return present.length === 0
    ? 'replay_sanity_v1 placeholder field'
    : `${present.join(', ')} are replay-sanity placeholders`;
}
