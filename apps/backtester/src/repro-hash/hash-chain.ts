import {
  ReproHashInputError,
  type ReproHashIssue,
} from './repro-hash-error.js';
import { sha256Utf8 } from './artifact-hash.js';
import {
  REPRO_ARTIFACT_ORDER,
  REPRO_HASH_CHAIN_ALGORITHM,
  type ReproArtifactHash,
  type ReproArtifactName,
  type ReproArtifactEncoding,
} from './types.js';

const LOWERCASE_SHA256_HEX = /^[a-f0-9]{64}$/u;

export function computeReproChainHash(
  runId: string,
  runSpecHash: string,
  artifacts: readonly ReproArtifactHash[],
): string {
  validateRunIdentity(runId, runSpecHash);
  validateArtifactSet(artifacts);

  let previousHash = sha256Utf8(
    `${REPRO_HASH_CHAIN_ALGORITHM}\n`
    + `run_id=${runId}\n`
    + `run_spec_hash=${runSpecHash}\n`,
  );

  for (const artifactName of REPRO_ARTIFACT_ORDER) {
    const artifact = artifacts.find((candidate) => candidate.name === artifactName)!;
    previousHash = sha256Utf8(
      `${REPRO_HASH_CHAIN_ALGORITHM}\n`
      + `prev=${previousHash}\n`
      + `artifact_name=${artifact.name}\n`
      + `artifact_encoding=${artifact.encoding}\n`
      + `artifact_sha256=${artifact.sha256}\n`,
    );
  }

  return previousHash;
}

export function validateRunIdentity(runId: string, runSpecHash: string): void {
  const issues: ReproHashIssue[] = [];
  if (typeof runId !== 'string' || runId.trim().length === 0) {
    issues.push({
      path: '$.run_id',
      code: 'invalid_run_id',
      message: 'run_id must be a non-empty string',
    });
  }
  if (!LOWERCASE_SHA256_HEX.test(runSpecHash)) {
    issues.push({
      path: '$.run_spec_hash',
      code: 'invalid_run_spec_hash',
      message: 'run_spec_hash must be a 64-character lowercase sha256 hex string',
    });
  }
  if (issues.length > 0) {
    throw new ReproHashInputError(issues);
  }
}

export function validateArtifactSet(artifacts: readonly ReproArtifactHash[]): void {
  const issues: ReproHashIssue[] = [];
  const seen = new Set<string>();

  for (const artifact of artifacts) {
    if (!isReproArtifactName(artifact.name)) {
      issues.push({
        path: '$.artifacts.name',
        code: 'invalid_artifact_name',
        message: `unknown artifact name ${String(artifact.name)}`,
      });
      continue;
    }
    if (seen.has(artifact.name)) {
      issues.push({
        path: `$.artifacts.${artifact.name}`,
        code: 'duplicate_artifact',
        message: `duplicate artifact ${artifact.name}`,
      });
    }
    seen.add(artifact.name);
    if (!isExpectedEncoding(artifact.name, artifact.encoding)) {
      issues.push({
        path: `$.artifacts.${artifact.name}.encoding`,
        code: 'invalid_artifact_name',
        message: `artifact ${artifact.name} has invalid encoding ${artifact.encoding}`,
      });
    }
    if (!LOWERCASE_SHA256_HEX.test(artifact.sha256)) {
      issues.push({
        path: `$.artifacts.${artifact.name}.sha256`,
        code: 'invalid_artifact_hash',
        message: 'artifact sha256 must be a 64-character lowercase hex string',
      });
    }
  }

  REPRO_ARTIFACT_ORDER.forEach((expectedName, index) => {
    if (!seen.has(expectedName)) {
      issues.push({
        path: `$.artifacts[${index}]`,
        code: 'missing_artifact',
        message: `missing required artifact ${expectedName}`,
      });
      return;
    }
    if (artifacts[index]?.name !== expectedName) {
      issues.push({
        path: `$.artifacts[${index}]`,
        code: 'invalid_artifact_name',
        message: `artifact order must be fixed; expected ${expectedName}`,
      });
    }
  });

  if (issues.length > 0) {
    throw new ReproHashInputError(issues);
  }
}

export function isLowercaseSha256Hex(value: string): boolean {
  return LOWERCASE_SHA256_HEX.test(value);
}

function isReproArtifactName(value: string): value is ReproArtifactName {
  return REPRO_ARTIFACT_ORDER.includes(value as ReproArtifactName);
}

function isExpectedEncoding(
  artifactName: ReproArtifactName,
  encoding: ReproArtifactEncoding,
): boolean {
  if (artifactName === 'journal_jsonl') {
    return encoding === 'raw_utf8_bytes';
  }
  return encoding === 'canonical_json_v1';
}
