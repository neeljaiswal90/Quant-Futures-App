import { createHash } from 'node:crypto';
import type { CorpusManifest } from './corpus-manifest.js';

/** Compute a deterministic sha256 hash from corpus manifest contents. */
export function computeManifestHash(manifest: CorpusManifest): string {
  return createHash('sha256').update(stableManifestStringify(manifest), 'utf8').digest('hex');
}

function stableManifestStringify(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Cannot hash non-finite numeric manifest value');
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableManifestStringify(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableManifestStringify(record[key])}`)
      .join(',')}}`;
  }

  throw new Error(`Cannot hash unsupported manifest value type: ${typeof value}`);
}
