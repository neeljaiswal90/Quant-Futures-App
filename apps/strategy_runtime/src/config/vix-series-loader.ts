import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { VixObservation, VixSeries } from '../contracts/vix-series.js';
import { ConfigValidationError } from './errors.js';
import { stableStringify } from './hash.js';
import type { ConfigValidationIssue } from './types.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

/** Load, validate, and freeze a normalized FRED VIXCLS series artifact. */
export function loadVixSeries(path: string): VixSeries {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError(
      [{ path: 'vix_series.path', message: `cannot read or parse ${path}: ${message}` }],
      'Invalid VIX series',
    );
  }

  const issues: ConfigValidationIssue[] = [];
  validateVixSeries(parsed, 'vix_series', issues);
  if (issues.length > 0) {
    throw new ConfigValidationError(issues, 'Invalid VIX series');
  }
  return deepFreeze(parsed) as VixSeries;
}

function validateVixSeries(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
): asserts value is VixSeries {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }
  requireNumber(value, 'manifest_schema_version', path, issues);
  if (value.manifest_schema_version !== 1) {
    issues.push({ path: `${path}.manifest_schema_version`, message: 'must be 1' });
  }
  requireExactString(value, 'source', 'FRED', path, issues);
  requireExactString(value, 'series_id', 'VIXCLS', path, issues);
  requireNumber(value, 'fetch_timestamp_ns', path, issues);
  requireDateString(value, 'start_date', path, issues);
  requireDateString(value, 'end_date', path, issues);
  requireNumber(value, 'record_count', path, issues);
  requireBoolean(value, 'has_missing', path, issues);
  requireNumber(value, 'missing_count', path, issues);
  requireSha256(value, 'sha256', path, issues);
  validateObservations(value.observations, `${path}.observations`, issues);

  if (!Array.isArray(value.observations)) {
    return;
  }
  const observations = value.observations as readonly VixObservation[];
  if (typeof value.record_count === 'number' && value.record_count !== observations.length) {
    issues.push({ path: `${path}.record_count`, message: 'must match observations length' });
  }
  const missingCount = observations.filter((item) => item.value === null).length;
  if (typeof value.missing_count === 'number' && value.missing_count !== missingCount) {
    issues.push({ path: `${path}.missing_count`, message: 'must match null observation count' });
  }
  if (typeof value.has_missing === 'boolean' && value.has_missing !== (missingCount > 0)) {
    issues.push({ path: `${path}.has_missing`, message: 'must match missing_count > 0' });
  }
  if (observations.length > 0) {
    if (value.start_date !== observations[0].date) {
      issues.push({ path: `${path}.start_date`, message: 'must match first observation date' });
    }
    if (value.end_date !== observations[observations.length - 1].date) {
      issues.push({ path: `${path}.end_date`, message: 'must match last observation date' });
    }
  }
  if (typeof value.sha256 === 'string' && SHA256_PATTERN.test(value.sha256)) {
    const expectedHash = computeObservationHash(observations);
    if (value.sha256 !== expectedHash) {
      issues.push({ path: `${path}.sha256`, message: 'must match canonical observations hash' });
    }
  }
}

function validateObservations(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
): asserts value is readonly VixObservation[] {
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'must be an array' });
    return;
  }
  if (value.length === 0) {
    issues.push({ path, message: 'must include at least one observation' });
  }
  let priorDate: string | null = null;
  value.forEach((item, index) => {
    const itemPath = `${path}.${index}`;
    if (!isRecord(item)) {
      issues.push({ path: itemPath, message: 'must be an object' });
      return;
    }
    requireDateString(item, 'date', itemPath, issues);
    if (!(typeof item.value === 'number' || item.value === null) || !isFiniteOrNull(item.value)) {
      issues.push({ path: `${itemPath}.value`, message: 'must be a finite number or null' });
    }
    if (typeof item.date === 'string') {
      if (priorDate !== null && item.date < priorDate) {
        issues.push({ path: `${itemPath}.date`, message: 'observations must be sorted by date' });
      }
      priorDate = item.date;
    }
  });
}

function computeObservationHash(observations: readonly VixObservation[]): string {
  return createHash('sha256')
    .update(stableStringify([...observations].sort((left, right) => left.date.localeCompare(right.date))), 'utf8')
    .digest('hex');
}

function requireExactString(
  value: Record<string, unknown>,
  key: string,
  expected: string,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  if (value[key] !== expected) {
    issues.push({ path: `${path}.${key}`, message: `must be ${expected}` });
  }
}

function requireDateString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  if (typeof value[key] !== 'string' || !DATE_PATTERN.test(value[key])) {
    issues.push({ path: `${path}.${key}`, message: 'required YYYY-MM-DD string is missing or invalid' });
  }
}

function requireSha256(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  if (typeof value[key] !== 'string' || !SHA256_PATTERN.test(value[key])) {
    issues.push({ path: `${path}.${key}`, message: 'sha256 must be lower-case 64-character hex' });
  }
}

function requireNumber(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
    issues.push({ path: `${path}.${key}`, message: 'required finite number is missing or invalid' });
  }
}

function requireBoolean(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  if (typeof value[key] !== 'boolean') {
    issues.push({ path: `${path}.${key}`, message: 'required boolean is missing or invalid' });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteOrNull(value: number | null): boolean {
  return value === null || Number.isFinite(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
