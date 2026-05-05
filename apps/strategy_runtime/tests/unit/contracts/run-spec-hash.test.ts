// Module under test: contracts/run-spec-hash; ticket QFA-115 Session 2a.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeRunSpec,
  computeRunSpecHash,
} from '../../../src/contracts/run-spec-hash.js';
import type { RunSpec } from '../../../src/contracts/run-spec.js';
import { buildMinimalRunSpec } from './helpers/run-spec-builder.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const fixtureDir = join(repoRoot, 'apps/strategy_runtime/tests/fixtures/run-spec');

function readFixture(name: string): string {
  return readFileSync(join(fixtureDir, name), 'utf8');
}

describe('QFA-115 canonicalizeRunSpec — fixture cross-check', () => {
  it('produces canonical bytes that exactly match minimal-runspec.canonical.json', () => {
    const expected = readFixture('minimal-runspec.canonical.json');
    const actual = canonicalizeRunSpec(buildMinimalRunSpec());
    expect(actual).toBe(expected);
  });
});

describe('QFA-115 computeRunSpecHash — fixture cross-check', () => {
  it('matches the independently-computed sha256 in minimal-runspec.sha256.txt', () => {
    const expected = readFixture('minimal-runspec.sha256.txt').trim();
    const actual = computeRunSpecHash(buildMinimalRunSpec());
    expect(actual).toBe(expected);
  });

  it('produces a lower-case 64-character hex sha256', () => {
    const hash = computeRunSpecHash(buildMinimalRunSpec());
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe('QFA-115 computeRunSpecHash — determinism', () => {
  it('object key insertion order does not affect the hash', () => {
    const original = buildMinimalRunSpec();
    // Reorder top-level keys via a recursive shuffler.
    const reorderedTop = reverseRecordKeys(original) as RunSpec;
    expect(computeRunSpecHash(reorderedTop)).toBe(computeRunSpecHash(original));
  });

  it('object key insertion order in nested fields does not affect the hash', () => {
    const original = buildMinimalRunSpec();
    const reorderedNested = JSON.parse(
      JSON.stringify({
        ...original,
        backtest_window: reverseRecordKeys(original.backtest_window),
      }),
    ) as RunSpec;
    expect(computeRunSpecHash(reorderedNested)).toBe(computeRunSpecHash(original));
  });
});

describe('QFA-115 computeRunSpecHash — strategy_ids order is semantic', () => {
  it('different strategy_ids order produces different hashes', () => {
    const baseline = buildMinimalRunSpec();
    const swapped = {
      ...baseline,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      strategy_ids: ['trend_pullback_long', 'trend_pullback_short'] as any,
    };
    const swappedReverse = {
      ...baseline,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      strategy_ids: ['trend_pullback_short', 'trend_pullback_long'] as any,
    };
    expect(computeRunSpecHash(swapped)).not.toBe(computeRunSpecHash(swappedReverse));
  });
});

describe('QFA-115 computeRunSpecHash — single-field-mutation sensitivity', () => {
  const baseline = buildMinimalRunSpec();
  const baselineHash = computeRunSpecHash(baseline);

  it('bar_spec change -> different hash', () => {
    const mutated = { ...baseline, bar_spec: '5m' };
    expect(computeRunSpecHash(mutated)).not.toBe(baselineHash);
  });

  it('window.start change -> different hash', () => {
    const mutated = {
      ...baseline,
      backtest_window: { ...baseline.backtest_window, start: '2026-02-03' },
    };
    expect(computeRunSpecHash(mutated)).not.toBe(baselineHash);
  });

  it('window.end change -> different hash', () => {
    const mutated = {
      ...baseline,
      backtest_window: { ...baseline.backtest_window, end: '2026-02-05' },
    };
    expect(computeRunSpecHash(mutated)).not.toBe(baselineHash);
  });

  it('inclusive_end change -> different hash', () => {
    const mutated = {
      ...baseline,
      backtest_window: { ...baseline.backtest_window, inclusive_end: false },
    };
    expect(computeRunSpecHash(mutated)).not.toBe(baselineHash);
  });

  it('determinism_seed change -> different hash', () => {
    const mutated = { ...baseline, determinism_seed: 43 };
    expect(computeRunSpecHash(mutated)).not.toBe(baselineHash);
  });

  it('runner_code_dirty change -> different hash', () => {
    const mutated = { ...baseline, runner_code_dirty: true };
    expect(computeRunSpecHash(mutated)).not.toBe(baselineHash);
  });

  it('runner_code_commit_sha change -> different hash', () => {
    const mutated = { ...baseline, runner_code_commit_sha: '1'.repeat(40) };
    expect(computeRunSpecHash(mutated)).not.toBe(baselineHash);
  });

  it('corpus_inputs[0].manifest_hash change -> different hash', () => {
    const mutated = {
      ...baseline,
      corpus_inputs: [
        { ...baseline.corpus_inputs[0]!, manifest_hash: '0'.repeat(64) },
      ],
    };
    expect(computeRunSpecHash(mutated)).not.toBe(baselineHash);
  });

  it('config_inputs[0].lineage.config_hash change -> different hash', () => {
    const mutated = {
      ...baseline,
      config_inputs: [
        {
          ...baseline.config_inputs[0]!,
          lineage: {
            ...baseline.config_inputs[0]!.lineage,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            config_hash: '0'.repeat(64) as any,
          },
        },
      ],
    };
    expect(computeRunSpecHash(mutated)).not.toBe(baselineHash);
  });
});

describe('QFA-115 canonicalizeRunSpec — defense-in-depth', () => {
  it('throws if validation fails (validation runs first)', () => {
    const spec = buildMinimalRunSpec() as unknown as { determinism_seed: number };
    spec.determinism_seed = -1;
    expect(() => canonicalizeRunSpec(spec as unknown as RunSpec)).toThrow();
  });

  it('throws if an undefined property is present in the RunSpec object graph', () => {
    // Deliberately violate the type to test the runtime guard. RunSpec has no
    // optional fields by design; an undefined property indicates a bug.
    const spec = {
      ...buildMinimalRunSpec(),
      extra_runtime_field: undefined,
    } as unknown as RunSpec;
    expect(() => canonicalizeRunSpec(spec)).toThrow(/undefined|invalid/u);
  });

  it('throws if a nested undefined property is present', () => {
    const baseline = buildMinimalRunSpec();
    const nested = {
      ...baseline,
      backtest_window: { ...baseline.backtest_window, extra: undefined },
    } as unknown as RunSpec;
    expect(() => canonicalizeRunSpec(nested)).toThrow(/undefined|invalid/u);
  });
});

function reverseRecordKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseRecordKeys);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .reverse()
        .map((key) => [key, reverseRecordKeys(record[key])]),
    );
  }
  return value;
}
