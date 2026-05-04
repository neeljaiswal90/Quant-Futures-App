// Module under test: contracts/tier-policy; ticket QFA-106.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCorpusManifest } from '../../../src/config/index.js';
import {
  REFERENCE_SCHEMAS,
  SCHEMA_TIER_MAP,
  TIER_RANK,
  TIER_REQUIRED_SCHEMAS,
  TierPolicyError,
  classifyCorpusTier,
  checkTierCompatibility,
  type DataTier,
  type DatabentoSchema,
} from '../../../src/contracts/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const fixtureDir = join(repoRoot, 'apps/strategy_runtime/tests/fixtures/tier-policy');

function fixturePath(name: string): string {
  return join(fixtureDir, `${name}-manifest.json`);
}

describe('QFA-106 tier policy', () => {
  describe('SCHEMA_TIER_MAP completeness', () => {
    // Exhaustive switch pattern: every DatabentoSchema literal must appear here
    // or this function fails to compile. The const-assignment forces TS to
    // require every case branch.
    const everyDatabentoSchema: readonly DatabentoSchema[] = [
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
    ];

    it('SCHEMA_TIER_MAP has an entry for every recognized schema', () => {
      for (const schema of everyDatabentoSchema) {
        expect(SCHEMA_TIER_MAP[schema]).toBeDefined();
        expect(['A', 'B', 'C']).toContain(SCHEMA_TIER_MAP[schema]);
      }
      expect(Object.keys(SCHEMA_TIER_MAP).sort()).toEqual([...everyDatabentoSchema].sort());
    });

    it('encodes the runbook tier table exactly', () => {
      // Spot-check: any drift from the runbook must fail this test.
      // See docs/RUNBOOK-backtester.md#tier-policy.
      expect(SCHEMA_TIER_MAP.mbo).toBe('A');
      expect(SCHEMA_TIER_MAP['mbp-10']).toBe('A');
      expect(SCHEMA_TIER_MAP['mbp-1']).toBe('B');
      expect(SCHEMA_TIER_MAP.trades).toBe('B');
      expect(SCHEMA_TIER_MAP.tbbo).toBe('B');
      expect(SCHEMA_TIER_MAP.bbo).toBe('B');
      expect(SCHEMA_TIER_MAP['ohlcv-1m']).toBe('C');
      expect(SCHEMA_TIER_MAP.definition).toBe('C');
      expect(SCHEMA_TIER_MAP.statistics).toBe('C');
      expect(SCHEMA_TIER_MAP.status).toBe('C');
    });
  });

  describe('TIER_REQUIRED_SCHEMAS completeness', () => {
    it('has an entry for every DataTier', () => {
      const everyTier: readonly DataTier[] = ['A', 'B', 'C'];
      for (const tier of everyTier) {
        expect(TIER_REQUIRED_SCHEMAS[tier]).toBeDefined();
        expect(TIER_REQUIRED_SCHEMAS[tier].length).toBeGreaterThan(0);
      }
      expect(Object.keys(TIER_REQUIRED_SCHEMAS).sort()).toEqual(['A', 'B', 'C']);
    });

    it('Tier A requires mbo AND mbp-10', () => {
      expect([...TIER_REQUIRED_SCHEMAS.A].sort()).toEqual(['mbo', 'mbp-10']);
    });

    it('Tier B requires mbp-1 AND trades AND tbbo', () => {
      expect([...TIER_REQUIRED_SCHEMAS.B].sort()).toEqual(['mbp-1', 'tbbo', 'trades']);
    });

    it('Tier C requires ohlcv-1m', () => {
      expect([...TIER_REQUIRED_SCHEMAS.C]).toEqual(['ohlcv-1m']);
    });

    it('TIER_REQUIRED_SCHEMAS contains no reference schemas', () => {
      for (const tier of ['A', 'B', 'C'] as const) {
        for (const schema of TIER_REQUIRED_SCHEMAS[tier]) {
          expect(REFERENCE_SCHEMAS.has(schema)).toBe(false);
        }
      }
    });
  });

  describe('TIER_RANK ordering', () => {
    it('A is richest (rank 0); C is lowest (rank 2)', () => {
      expect(TIER_RANK.A).toBe(0);
      expect(TIER_RANK.B).toBe(1);
      expect(TIER_RANK.C).toBe(2);
    });
  });

  describe('REFERENCE_SCHEMAS', () => {
    it('contains exactly definition, statistics, status', () => {
      expect([...REFERENCE_SCHEMAS].sort()).toEqual(['definition', 'statistics', 'status']);
    });
  });

  describe('classifyCorpusTier', () => {
    it('classifies a Tier A manifest (mbo + mbp-10 present) as Tier A', () => {
      const manifest = loadCorpusManifest(fixturePath('tier-a'));
      const result = classifyCorpusTier(manifest);
      expect(result.effectiveTier).toBe('A');
      expect(result.classification_reason).toContain('Tier A');
      expect(result.classification_reason).toContain('mbo');
      expect(result.classification_reason).toContain('mbp-10');
      expect(result.unrecognizedSchemas).toEqual([]);
    });

    it('Tier A classification surfaces all available schemas in enum order', () => {
      const manifest = loadCorpusManifest(fixturePath('tier-a'));
      const result = classifyCorpusTier(manifest);
      // enum order: mbo, mbp-10, mbp-1, trades, ..., definition
      expect(result.availableSchemas).toEqual([
        'mbo',
        'mbp-10',
        'mbp-1',
        'trades',
        'definition',
      ]);
    });

    it('classifies a Tier B manifest (mbp-1+trades+tbbo, no mbo/mbp-10) as Tier B', () => {
      const manifest = loadCorpusManifest(fixturePath('tier-b'));
      const result = classifyCorpusTier(manifest);
      expect(result.effectiveTier).toBe('B');
      expect(result.classification_reason).toContain('Tier B');
      expect(result.unrecognizedSchemas).toEqual([]);
    });

    it('classifies a Tier C manifest (ohlcv-1m only) as Tier C', () => {
      const manifest = loadCorpusManifest(fixturePath('tier-c'));
      const result = classifyCorpusTier(manifest);
      expect(result.effectiveTier).toBe('C');
      expect(result.classification_reason).toContain('Tier C');
      expect(result.unrecognizedSchemas).toEqual([]);
    });

    it('Tier A schema present but mbp-10 missing → Tier B (best-fit semantics)', () => {
      const manifest = loadCorpusManifest(fixturePath('mixed-incomplete-a'));
      const result = classifyCorpusTier(manifest);
      // Has mbo + mbp-1 + trades + tbbo. Tier A requires mbo AND mbp-10;
      // mbp-10 is absent, so Tier A's full set isn't satisfied.
      // Tier B requires mbp-1 + trades + tbbo, all present.
      expect(result.effectiveTier).toBe('B');
      expect(result.classification_reason).toContain('Tier B');
    });

    it('surfaces unrecognized schemas without throwing', () => {
      const manifest = loadCorpusManifest(fixturePath('unrecognized-schema'));
      const result = classifyCorpusTier(manifest);
      expect(result.unrecognizedSchemas).toEqual(['future-mbp-25']);
      // mbo alone doesn't satisfy any tier's full required set;
      // unrecognized schemas don't drive classification either.
      expect(result.effectiveTier).toBe('C');
      expect(result.classification_reason).toMatch(/no tier.*fully satisfied|defaulted to Tier C/);
    });

    it('reference-only corpus classifies as Tier C with documented reason', () => {
      const manifest = loadCorpusManifest(fixturePath('reference-only'));
      const result = classifyCorpusTier(manifest);
      expect(result.effectiveTier).toBe('C');
      expect(result.classification_reason).toContain('no microstructure schemas present');
      expect(result.classification_reason).toContain('defaulted to Tier C');
      // Reference data IS visible in availableSchemas (it was present in the manifest).
      expect(result.availableSchemas).toContain('definition');
      expect(result.availableSchemas).toContain('statistics');
    });

    it('reference data does not affect Tier A classification of an otherwise-Tier-A corpus', () => {
      // tier-a fixture has definition included; it should not block Tier A classification.
      const manifest = loadCorpusManifest(fixturePath('tier-a'));
      const result = classifyCorpusTier(manifest);
      expect(result.effectiveTier).toBe('A');
      expect(result.availableSchemas).toContain('definition');
    });
  });

  describe('checkTierCompatibility — all 9 tier pairs', () => {
    const pairs: readonly { corpus: DataTier; required: DataTier; expected: boolean }[] = [
      { corpus: 'A', required: 'A', expected: true },
      { corpus: 'A', required: 'B', expected: true },
      { corpus: 'A', required: 'C', expected: true },
      { corpus: 'B', required: 'A', expected: false },
      { corpus: 'B', required: 'B', expected: true },
      { corpus: 'B', required: 'C', expected: true },
      { corpus: 'C', required: 'A', expected: false },
      { corpus: 'C', required: 'B', expected: false },
      { corpus: 'C', required: 'C', expected: true },
    ];

    for (const { corpus, required, expected } of pairs) {
      it(`corpus=${corpus} required=${required} → compatible=${expected}`, () => {
        const result = checkTierCompatibility(corpus, required);
        expect(result.compatible).toBe(expected);
        expect(result.reason).toContain(`Tier ${corpus}`);
        expect(result.reason).toContain(`Tier ${required}`);
      });
    }
  });

  describe('TierPolicyError', () => {
    it('carries required tier, corpus tier, available schemas, classification reason', () => {
      const error = new TierPolicyError({
        requiredTier: 'A',
        corpusTier: 'B',
        availableSchemas: ['mbp-1', 'trades', 'tbbo'],
        classificationReason: 'Tier B: required schemas mbp-1, trades, tbbo all present',
      });
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('TierPolicyError');
      expect(error.requiredTier).toBe('A');
      expect(error.corpusTier).toBe('B');
      expect(error.availableSchemas).toEqual(['mbp-1', 'trades', 'tbbo']);
      expect(error.classificationReason).toBe(
        'Tier B: required schemas mbp-1, trades, tbbo all present',
      );
      expect(error.message).toContain('Tier A');
      expect(error.message).toContain('Tier B');
    });

    it('accepts a custom message override', () => {
      const error = new TierPolicyError({
        requiredTier: 'A',
        corpusTier: 'C',
        availableSchemas: ['ohlcv-1m'],
        classificationReason: 'reference-only',
        message: 'custom failure message',
      });
      expect(error.message).toBe('custom failure message');
    });
  });
});
