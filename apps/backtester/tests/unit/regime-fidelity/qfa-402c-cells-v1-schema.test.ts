import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalizeReproJson } from '../../../src/repro-hash/index.js';

const ARTIFACT_PATH = join(process.cwd(), 'artifacts', 'regime-fidelity', 'qfa-402c-stratified-cells-v1.json');
const REGIMES = ['high', 'mid', 'low'] as const;
const SPREAD_BUCKETS = ['1-tick', '2-tick', '3+ ticks'] as const;
const QUEUE_AHEAD_BUCKETS = ['1-5', '6-20', '21+'] as const;
const TARGET_LOW_COVERAGE_KEYS = [
  'low|1-tick|1-5',
  'low|1-tick|6-20',
  'low|2-tick|1-5',
  'low|2-tick|6-20',
  'low|2-tick|21+',
  'low|3+ ticks|1-5',
  'low|3+ ticks|6-20',
] as const;

interface Qfa402cCell {
  readonly regime: string;
  readonly spread_bucket: string;
  readonly queue_ahead_bucket: string;
  readonly share_ppm: number;
  readonly probe_count: number;
  readonly within_tolerance_count: number;
}

interface Qfa402cCellsArtifact {
  readonly schema_version: number;
  readonly methodology_id: string;
  readonly generated_at_utc: string;
  readonly source_manifests: {
    readonly feb: string;
    readonly mar: string;
    readonly apr: string;
  };
  readonly input_substrate_hash: string;
  readonly fidelity_threshold_ppm: number;
  readonly cells: readonly Qfa402cCell[];
}

function loadArtifact(): { readonly raw: string; readonly artifact: Qfa402cCellsArtifact } {
  const raw = readFileSync(ARTIFACT_PATH, 'utf8');
  return {
    raw,
    artifact: JSON.parse(raw) as Qfa402cCellsArtifact,
  };
}

describe('QFA-402c stratified cells artifact v1', () => {
  it('is canonical LF JSON with the locked top-level schema', () => {
    const { raw, artifact } = loadArtifact();

    expect(raw).not.toContain('\r');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toBe(`${canonicalizeReproJson(artifact)}\n`);
    expect(artifact.schema_version).toBe(1);
    expect(artifact.methodology_id).toBe('qfa-402c-cells-v1');
    expect(artifact.generated_at_utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(artifact.source_manifests.feb).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.source_manifests.mar).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.source_manifests.apr).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.input_substrate_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.fidelity_threshold_ppm).toBe(800_000);
  });

  it('contains every regime x spread x queue-ahead cell explicitly', () => {
    const { artifact } = loadArtifact();
    const expectedKeys = new Set<string>();
    for (const regime of REGIMES) {
      for (const spread of SPREAD_BUCKETS) {
        for (const queue of QUEUE_AHEAD_BUCKETS) {
          expectedKeys.add(`${regime}|${spread}|${queue}`);
        }
      }
    }

    expect(artifact.cells).toHaveLength(expectedKeys.size);
    const actualKeys = new Set<string>();
    for (const cell of artifact.cells) {
      expect(REGIMES).toContain(cell.regime as (typeof REGIMES)[number]);
      expect(SPREAD_BUCKETS).toContain(cell.spread_bucket as (typeof SPREAD_BUCKETS)[number]);
      expect(QUEUE_AHEAD_BUCKETS).toContain(cell.queue_ahead_bucket as (typeof QUEUE_AHEAD_BUCKETS)[number]);
      expect(Number.isInteger(cell.share_ppm)).toBe(true);
      expect(Number.isInteger(cell.probe_count)).toBe(true);
      expect(Number.isInteger(cell.within_tolerance_count)).toBe(true);
      expect(cell.share_ppm).toBeGreaterThanOrEqual(0);
      expect(cell.share_ppm).toBeLessThanOrEqual(1_000_000);
      expect(cell.probe_count).toBeGreaterThanOrEqual(0);
      expect(cell.within_tolerance_count).toBeGreaterThanOrEqual(0);
      expect(cell.within_tolerance_count).toBeLessThanOrEqual(cell.probe_count);
      if (cell.probe_count === 0) {
        expect(cell.share_ppm).toBe(0);
      } else {
        expect(cell.share_ppm).toBe(Math.floor((cell.within_tolerance_count * 1_000_000) / cell.probe_count));
      }
      actualKeys.add(`${cell.regime}|${cell.spread_bucket}|${cell.queue_ahead_bucket}`);
    }
    expect(actualKeys).toEqual(expectedKeys);
  });

  it('uses observed low-regime probes for the v2 UTC 16-18 variant target cells', () => {
    const { artifact } = loadArtifact();
    const cellsByKey = new Map(
      artifact.cells.map((cell) => [`${cell.regime}|${cell.spread_bucket}|${cell.queue_ahead_bucket}`, cell]),
    );

    for (const key of TARGET_LOW_COVERAGE_KEYS) {
      const cell = cellsByKey.get(key);
      expect(cell).toBeDefined();
      expect(cell!.probe_count).toBeGreaterThan(0);
      expect(cell!.within_tolerance_count).toBeGreaterThan(0);
    }
  });
});
