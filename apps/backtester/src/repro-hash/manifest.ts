import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { computeReproArtifactHash, computeRawUtf8ArtifactHash } from './artifact-hash.js';
import { canonicalizeReproJson } from './canonical-json.js';
import { computeReproChainHash, isLowercaseSha256Hex } from './hash-chain.js';
import {
  REPRO_HASH_CHAIN_ALGORITHM,
  type ReproArtifactHash,
  type ReproducibilityManifest,
  type ReproducibilityManifestInput,
} from './types.js';
import { ReproHashInputError, type ReproHashIssue } from './repro-hash-error.js';

export function computeReproducibilityManifest(
  input: ReproducibilityManifestInput,
): ReproducibilityManifest {
  const artifacts: readonly ReproArtifactHash[] = [
    computeRawUtf8ArtifactHash('journal_jsonl', input.journal_jsonl),
    computeReproArtifactHash('trade_ledger', input.trade_ledger),
    computeReproArtifactHash('trade_pnl', input.trade_pnl),
    computeReproArtifactHash('equity_curve', input.equity_curve),
    computeReproArtifactHash('metrics_summary', input.metrics_summary),
  ];

  const finalChainHash = computeReproChainHash(input.run_id, input.run_spec_hash, artifacts);
  validateFinalHash(finalChainHash);

  return {
    manifest_schema_version: 1,
    algorithm: REPRO_HASH_CHAIN_ALGORITHM,
    run_id: input.run_id,
    run_spec_hash: input.run_spec_hash,
    artifacts,
    final_chain_hash: finalChainHash,
  };
}

export async function writeReproducibilityManifest(
  path: string,
  manifest: ReproducibilityManifest,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${canonicalizeReproJson(manifest)}\n`, 'utf8');
}

function validateFinalHash(finalChainHash: string): void {
  if (isLowercaseSha256Hex(finalChainHash)) {
    return;
  }
  const issue: ReproHashIssue = {
    path: '$.final_chain_hash',
    code: 'invalid_artifact_hash',
    message: 'final_chain_hash must be a 64-character lowercase hex string',
  };
  throw new ReproHashInputError([issue]);
}
