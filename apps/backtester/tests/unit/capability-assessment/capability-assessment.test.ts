import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ACTIVE_STRATEGY_IDS,
  type StrategyId,
} from '../../../../strategy_runtime/src/contracts/strategy-ids.js';
import {
  buildCapabilityAssessmentSet,
  CapabilityAssessmentInputError,
  type StrategyFeatureCapability,
} from '../../../src/capability-assessment/index.js';
import {
  computeStrategyFingerprintSet,
  type StrategyFingerprintSet,
} from '../../../src/strategy-fingerprint/index.js';
import {
  defaultStrategyReplayIds,
  replayStrategies,
  type StrategyReplayEvaluation,
} from '../../../src/strategy-replay/index.js';
import { REPLAY_BARS } from '../strategy-replay/fixtures.js';

describe('strategy capability assessment', () => {
  it('builds one assessment per strategy in ACTIVE_STRATEGY_IDS order', async () => {
    const { replay, fingerprints } = await replayAndFingerprint();
    const assessment = buildCapabilityAssessmentSet(replay, fingerprints);

    expect(assessment.assessment_set_schema_version).toBe(1);
    expect(assessment.assessments.map((entry) => entry.strategy_id)).toEqual(
      ACTIVE_STRATEGY_IDS,
    );
    expect(assessment.assessments.every((entry) => entry.replay_evaluations === 4)).toBe(
      true,
    );
    expect(assessment.assessments.every((entry) => entry.fingerprint_sha256 !== null)).toBe(
      true,
    );
  });

  it('supports explicit strategy_order', async () => {
    const { replay, fingerprints } = await replayAndFingerprint();
    const reversed = [...ACTIVE_STRATEGY_IDS].reverse();
    const assessment = buildCapabilityAssessmentSet(replay, fingerprints, {
      strategy_order: reversed,
    });

    expect(assessment.assessments.map((entry) => entry.strategy_id)).toEqual(reversed);
  });

  it('marks replay plus fingerprint as ready_for_replay when all feature categories are real', async () => {
    const { replay, fingerprints } = await replayAndFingerprint();
    const assessment = buildCapabilityAssessmentSet(replay, fingerprints, {
      feature_capabilities: allRealFeatureCapabilities(),
    });

    expect(assessment.assessments.every((entry) => entry.status === 'ready_for_replay')).toBe(
      true,
    );
    expect(assessment.assessments.every((entry) => entry.limitations.length === 0)).toBe(
      true,
    );
  });

  it('maps replay_sanity_v1 placeholders to degraded replay limitations', async () => {
    const { replay, fingerprints } = await replayAndFingerprint();
    const assessment = buildCapabilityAssessmentSet(replay, fingerprints);

    expect(assessment.assessments.every((entry) => entry.status === 'degraded_replay')).toBe(
      true,
    );
    for (const entry of assessment.assessments) {
      expect(entry.features.find((feature) => feature.category === 'session')?.status).toBe(
        'placeholder',
      );
      expect(entry.limitations.map((limitation) => limitation.code)).toEqual([
        'placeholder_session',
        'placeholder_quote',
        'placeholder_indicators',
        'placeholder_structure',
        'placeholder_microstructure',
        'config_lineage_unverified',
      ]);
    }
  });

  it('marks missing fingerprint as blocked', async () => {
    const { replay, fingerprints } = await replayAndFingerprint();
    const missingStrategy = ACTIVE_STRATEGY_IDS[0]!;
    const partialFingerprints: StrategyFingerprintSet = {
      ...fingerprints,
      fingerprints: fingerprints.fingerprints.filter(
        (fingerprint) => fingerprint.strategy_id !== missingStrategy,
      ),
    };
    const assessment = buildCapabilityAssessmentSet(replay, partialFingerprints);
    const entry = assessment.assessments.find(
      (candidate) => candidate.strategy_id === missingStrategy,
    );

    expect(entry?.status).toBe('blocked');
    expect(entry?.fingerprint_sha256).toBeNull();
    expect(entry?.features.find((feature) => feature.category === 'fingerprint')?.status).toBe(
      'unavailable',
    );
    expect(entry?.limitations.map((limitation) => limitation.code)).toContain(
      'fingerprint_missing',
    );
  });

  it('marks zero-decision fingerprints as degraded when replay exists', async () => {
    const { replay } = await replayAndFingerprint();
    const zeroDecisionFingerprints = computeStrategyFingerprintSet([], ACTIVE_STRATEGY_IDS);
    const assessment = buildCapabilityAssessmentSet(replay, zeroDecisionFingerprints, {
      feature_capabilities: allRealFeatureCapabilities(),
    });

    expect(assessment.assessments.every((entry) => entry.status === 'degraded_replay')).toBe(
      true,
    );
    expect(
      assessment.assessments.every((entry) =>
        entry.limitations.some((limitation) => limitation.code === 'empty_decision_sequence'),
      ),
    ).toBe(true);
  });

  it('marks missing replay output as blocked', async () => {
    const { fingerprints } = await replayAndFingerprint();
    const assessment = buildCapabilityAssessmentSet([], fingerprints, {
      feature_capabilities: allRealFeatureCapabilities(),
    });

    expect(assessment.assessments.every((entry) => entry.status === 'blocked')).toBe(true);
    expect(
      assessment.assessments.every((entry) =>
        entry.limitations.map((limitation) => limitation.code).includes('replay_missing'),
      ),
    ).toBe(true);
  });

  it('produces deterministic sorted limitations', async () => {
    const { replay, fingerprints } = await replayAndFingerprint();
    const assessment = buildCapabilityAssessmentSet(replay, fingerprints);
    const first = assessment.assessments[0]!;

    expect(first.limitations.map((limitation) => limitation.code)).toEqual([
      'placeholder_session',
      'placeholder_quote',
      'placeholder_indicators',
      'placeholder_structure',
      'placeholder_microstructure',
      'config_lineage_unverified',
    ]);
  });

  it('produces deeply equal assessment sets for identical inputs', async () => {
    const first = await replayAndFingerprint();
    const second = await replayAndFingerprint();

    expect(buildCapabilityAssessmentSet(second.replay, second.fingerprints)).toEqual(
      buildCapabilityAssessmentSet(first.replay, first.fingerprints),
    );
  });

  it('rejects unknown strategy IDs in replay input', async () => {
    const { replay, fingerprints } = await replayAndFingerprint();
    const malformedReplay = [
      {
        ...replay.evaluations[0]!,
        strategy_id: 'not_a_strategy',
      },
    ] as unknown as readonly StrategyReplayEvaluation[];

    expectCapabilityIssue(
      () => buildCapabilityAssessmentSet(malformedReplay, fingerprints),
      'unknown_strategy_id',
    );
  });

  it('rejects duplicate strategy_order entries', async () => {
    const { replay, fingerprints } = await replayAndFingerprint();

    expectCapabilityIssue(
      () =>
        buildCapabilityAssessmentSet(replay, fingerprints, {
          strategy_order: [
            ACTIVE_STRATEGY_IDS[0]!,
            ACTIVE_STRATEGY_IDS[0]!,
            ACTIVE_STRATEGY_IDS[1]!,
            ACTIVE_STRATEGY_IDS[2]!,
          ],
        }),
      'duplicate_strategy_id',
    );
  });

  it('does not introduce nondeterministic runtime calls in capability-assessment source', () => {
    const sourceRoot = join(process.cwd(), 'apps/backtester/src/capability-assessment');
    const forbidden = /Date\.now|Math\.random|randomUUID|new Date\(/u;

    for (const fileName of readdirSync(sourceRoot)) {
      if (!fileName.endsWith('.ts')) continue;
      const source = readFileSync(join(sourceRoot, fileName), 'utf8');
      expect(source, fileName).not.toMatch(forbidden);
    }
  });
});

async function replayAndFingerprint() {
  const replay = await replayStrategies({
    strategy_ids: defaultStrategyReplayIds(),
    bars: REPLAY_BARS,
  });
  return {
    replay,
    fingerprints: computeStrategyFingerprintSet(replay.evaluations, ACTIVE_STRATEGY_IDS),
  };
}

function allRealFeatureCapabilities(): readonly StrategyFeatureCapability[] {
  return [
    'instrument',
    'session',
    'quote',
    'bars',
    'indicators',
    'structure',
    'microstructure',
    'config_lineage',
  ].map((category) => ({
    category: category as StrategyFeatureCapability['category'],
    status: 'real',
    source: 'test_real_feature_bridge',
    details: null,
  }));
}

function expectCapabilityIssue(
  callback: () => unknown,
  expectedCode: CapabilityAssessmentInputError['issues'][number]['code'],
): void {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityAssessmentInputError);
    expect((error as CapabilityAssessmentInputError).issues.map((issue) => issue.code)).toContain(
      expectedCode,
    );
    return;
  }

  throw new Error(`expected CapabilityAssessmentInputError with ${expectedCode}`);
}
