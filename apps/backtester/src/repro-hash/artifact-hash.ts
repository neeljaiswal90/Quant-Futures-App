import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { canonicalizeReproJson } from './canonical-json.js';
import {
  REPRO_ARTIFACT_ORDER,
  type ReproArtifactHash,
  type StructuredReproArtifactName,
} from './types.js';
import { throwReproHashIssue } from './repro-hash-error.js';

const STRUCTURED_ARTIFACT_NAMES = new Set(
  REPRO_ARTIFACT_ORDER.filter((name) => name !== 'journal_jsonl'),
);

export function computeRawUtf8ArtifactHash(
  name: 'journal_jsonl',
  value: string | Uint8Array,
): ReproArtifactHash {
  if (name !== 'journal_jsonl') {
    return throwReproHashIssue({
      path: '$.name',
      code: 'invalid_artifact_name',
      message: 'raw UTF-8 artifact hashing is only valid for journal_jsonl',
    });
  }
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  return {
    name,
    encoding: 'raw_utf8_bytes',
    sha256: sha256Bytes(bytes),
    byte_length: bytes.length,
  };
}

export function computeReproArtifactHash(
  name: StructuredReproArtifactName,
  value: unknown,
): ReproArtifactHash {
  if (!STRUCTURED_ARTIFACT_NAMES.has(name)) {
    return throwReproHashIssue({
      path: '$.name',
      code: 'invalid_artifact_name',
      message: `structured artifact hashing does not support ${String(name)}`,
    });
  }
  const canonicalJson = canonicalizeReproJson(value);
  const bytes = Buffer.from(canonicalJson, 'utf8');
  return {
    name,
    encoding: 'canonical_json_v1',
    sha256: sha256Bytes(bytes),
    byte_length: bytes.length,
  };
}

export function sha256Utf8(value: string): string {
  return sha256Bytes(Buffer.from(value, 'utf8'));
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
