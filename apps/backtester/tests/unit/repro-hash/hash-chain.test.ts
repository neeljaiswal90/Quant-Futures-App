import { describe, expect, it } from 'vitest';
import {
  computeReproChainHash,
  ReproHashInputError,
  type ReproArtifactHash,
} from '../../../src/repro-hash/index.js';

const RUN_ID = 'run-qfa-205';
const RUN_SPEC_HASH = 'a'.repeat(64);

describe('QFA-205 repro hash chain', () => {
  it('produces a versioned 64-character final hash from fixed artifact order', () => {
    expect(computeReproChainHash(RUN_ID, RUN_SPEC_HASH, artifactHashes())).toMatch(
      /^[a-f0-9]{64}$/u,
    );
  });

  it('is sensitive to run_spec_hash and artifact hashes', () => {
    const baseline = computeReproChainHash(RUN_ID, RUN_SPEC_HASH, artifactHashes());
    expect(computeReproChainHash(RUN_ID, 'b'.repeat(64), artifactHashes())).not.toBe(
      baseline,
    );
    expect(computeReproChainHash(RUN_ID, RUN_SPEC_HASH, artifactHashes({
      metrics_summary: 'c'.repeat(64),
    }))).not.toBe(baseline);
  });

  it('rejects missing, duplicate, invalid, and misordered artifacts', () => {
    expect(() => computeReproChainHash(RUN_ID, RUN_SPEC_HASH, artifactHashes().slice(1))).toThrow(
      ReproHashInputError,
    );
    expect(() => computeReproChainHash(RUN_ID, RUN_SPEC_HASH, [
      ...artifactHashes(),
      artifactHashes()[0]!,
    ])).toThrow('duplicate_artifact');
    expect(() => computeReproChainHash(RUN_ID, RUN_SPEC_HASH, [
      artifactHashes()[1]!,
      artifactHashes()[0]!,
      ...artifactHashes().slice(2),
    ])).toThrow('artifact order');
    expect(() => computeReproChainHash(RUN_ID, RUN_SPEC_HASH, artifactHashes({
      journal_jsonl: 'A'.repeat(64),
    }))).toThrow('invalid_artifact_hash');
  });

  it('rejects invalid run identity inputs', () => {
    expect(() => computeReproChainHash('', RUN_SPEC_HASH, artifactHashes())).toThrow(
      'invalid_run_id',
    );
    expect(() => computeReproChainHash(RUN_ID, 'abc', artifactHashes())).toThrow(
      'invalid_run_spec_hash',
    );
  });
});

function artifactHashes(overrides: Partial<Record<string, string>> = {}): ReproArtifactHash[] {
  return [
    artifact('journal_jsonl', 'raw_utf8_bytes', overrides.journal_jsonl ?? '0'.repeat(64)),
    artifact('trade_ledger', 'canonical_json_v1', overrides.trade_ledger ?? '1'.repeat(64)),
    artifact('trade_pnl', 'canonical_json_v1', overrides.trade_pnl ?? '2'.repeat(64)),
    artifact('equity_curve', 'canonical_json_v1', overrides.equity_curve ?? '3'.repeat(64)),
    artifact('metrics_summary', 'canonical_json_v1', overrides.metrics_summary ?? '4'.repeat(64)),
  ];
}

function artifact(
  name: ReproArtifactHash['name'],
  encoding: ReproArtifactHash['encoding'],
  sha256: string,
): ReproArtifactHash {
  return {
    name,
    encoding,
    sha256,
    byte_length: 1,
  };
}
