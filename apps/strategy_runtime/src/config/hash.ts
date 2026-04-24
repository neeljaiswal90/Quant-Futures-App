import { createHash } from 'node:crypto';
import {
  CONFIG_HASH_ALGORITHM,
  CONFIG_SCHEMA_VERSION,
  type ConfigLineage,
  type PublicRuntimeConfig,
} from './types.js';

export function stableStringify(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Cannot hash non-finite numeric config value');
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }

  throw new Error(`Cannot hash unsupported config value type: ${typeof value}`);
}

export function canonicalizePublicConfig(config: PublicRuntimeConfig): string {
  return stableStringify(config);
}

export function hashPublicConfig(config: PublicRuntimeConfig): string {
  return createHash(CONFIG_HASH_ALGORITHM)
    .update(canonicalizePublicConfig(config), 'utf8')
    .digest('hex');
}

export function buildConfigLineage(config: PublicRuntimeConfig): ConfigLineage {
  return {
    config_version: CONFIG_SCHEMA_VERSION,
    config_hash: hashPublicConfig(config),
    config_hash_algorithm: CONFIG_HASH_ALGORITHM,
    canonical_config_json: canonicalizePublicConfig(config),
  };
}
