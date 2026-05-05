// Module under test: contracts/backtest-run-meta; ticket QFA-115 Session 2a.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BacktestRunMetaPayload } from '../../../src/contracts/backtest-run-meta.js';
import { computeRunSpecHash } from '../../../src/contracts/run-spec-hash.js';
import { ns } from '../../../src/contracts/time.js';
import { buildMinimalRunSpec } from './helpers/run-spec-builder.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const fixtureDir = join(repoRoot, 'apps/strategy_runtime/tests/fixtures/run-spec');

describe('QFA-115 BacktestRunMetaPayload — type shape', () => {
  it('extends RunSpec with run_spec_hash and run_started_at_ns', () => {
    const spec = buildMinimalRunSpec();
    const payload: BacktestRunMetaPayload = {
      ...spec,
      run_spec_hash: computeRunSpecHash(spec),
      run_started_at_ns: ns(1_801_000_000_000_000_000n),
    };
    expect(typeof payload.run_spec_hash).toBe('string');
    expect(typeof payload.run_started_at_ns).toBe('bigint');
    // Inherited RunSpec fields all present.
    expect(payload.run_spec_schema_version).toBe(1);
    expect(payload.instrument_root).toBe('MNQ');
    expect(payload.strategy_ids.length).toBeGreaterThan(0);
  });

  it('run_started_at_ns is the ONLY bigint field on the payload', () => {
    const spec = buildMinimalRunSpec();
    const payload: BacktestRunMetaPayload = {
      ...spec,
      run_spec_hash: computeRunSpecHash(spec),
      run_started_at_ns: ns(1_801_000_000_000_000_000n),
    };
    let bigintCount = 0;
    walk(payload, (value) => {
      if (typeof value === 'bigint') bigintCount += 1;
    });
    expect(bigintCount).toBe(1);
  });
});

describe('QFA-115 BacktestRunMetaPayload — fixture compatibility', () => {
  it('the committed valid-payload fixture parses with the expected fields', () => {
    const text = readFileSync(
      join(fixtureDir, 'backtest-run-meta-payload.valid.json'),
      'utf8',
    );
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed).toHaveProperty('run_spec_schema_version');
    expect(parsed).toHaveProperty('run_spec_hash');
    expect(parsed).toHaveProperty('run_started_at_ns');
    expect(parsed).toHaveProperty('strategy_ids');
    expect(parsed).toHaveProperty('corpus_inputs');
    expect(parsed).toHaveProperty('config_inputs');
  });

  it('payload run_spec_hash matches computeRunSpecHash on the inlined RunSpec fields', () => {
    const text = readFileSync(
      join(fixtureDir, 'backtest-run-meta-payload.valid.json'),
      'utf8',
    );
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const expectedHash = parsed.run_spec_hash as string;
    // Reconstruct RunSpec by stripping the two payload-only fields.
    const { run_spec_hash: _hash, run_started_at_ns: _ts, ...specFields } = parsed;
    expect(computeRunSpecHash(specFields as unknown as ReturnType<typeof buildMinimalRunSpec>))
      .toBe(expectedHash);
  });
});

function walk(value: unknown, visit: (value: unknown) => void): void {
  visit(value);
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visit));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      walk(child, visit);
    }
  }
}
