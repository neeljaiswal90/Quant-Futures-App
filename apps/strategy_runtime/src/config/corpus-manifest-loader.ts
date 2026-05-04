import { readFileSync } from 'node:fs';
import type {
  CorpusManifest,
  CorpusManifestDatasetRange,
  CorpusManifestDatasetSchemaRange,
  CorpusManifestRetryPolicy,
  CorpusManifestSchemaFile,
  CorpusManifestSession,
  CorpusManifestSummary,
  CorpusManifestWindow,
} from '../contracts/corpus-manifest.js';
import { ConfigValidationError } from './errors.js';
import type { ConfigValidationIssue } from './types.js';

/** Non-fatal schema warning emitted while loading a corpus manifest. */
export interface CorpusManifestValidationWarning {
  /** JSON path where the warning was observed. */
  readonly path: string;
  /** Human-readable warning detail. */
  readonly message: string;
}

/** Loaded corpus manifest plus non-fatal validation warnings. */
export interface LoadedCorpusManifest {
  /** Frozen Python-emitted corpus manifest object. */
  readonly manifest: CorpusManifest;
  /** Unknown-field warnings preserved for downstream consumers. */
  readonly warnings: readonly CorpusManifestValidationWarning[];
}

const topLevelKeys = new Set([
  'manifest_schema_version',
  'ticket_id',
  'status',
  'blocked_reason',
  'ready_for_sim03_model_fitting',
  'scope_note',
  'dataset',
  'symbol',
  'databento_api_key_present',
  'dataset_range',
  'dataset_range_error',
  'definition_schema',
  'event_schemas',
  'min_complete_sessions',
  'out_dir',
  'retry_policy',
  'validation_fraction',
  'corpus_summary',
  'sessions',
]);

const corpusSummaryKeys = new Set([
  'requested_sessions',
  'complete_sessions',
  'excluded_sessions',
  'partial_sessions',
  'total_bytes',
  'calibration_sessions',
  'validation_sessions',
]);

const datasetRangeKeys = new Set(['start', 'end', 'schema']);
const datasetRangeSchemaKeys = new Set(['start', 'end']);
const retryPolicyKeys = new Set(['attempts', 'backoff', 'base_seconds']);
const sessionKeys = new Set([
  'session_id',
  'status',
  'split',
  'symbol',
  'exclusion_reason',
  'definition_snapshot_window',
  'rth_window',
  'schemas',
]);
const windowKeys = new Set(['start_ts_ns', 'end_ts_ns']);
const schemaFileKeys = new Set([
  'schema',
  'status',
  'path',
  'start_ts_ns',
  'end_ts_ns',
  'byte_count',
  'record_count',
  'reused_existing',
  'attempts',
  'sha256',
]);

/** Load, validate, and freeze a Python-emitted corpus manifest JSON file. */
export function loadCorpusManifest(path: string): CorpusManifest {
  const loaded = loadCorpusManifestWithWarnings(path);
  for (const warning of loaded.warnings) {
    process.stderr.write(`Corpus manifest warning (${path}): ${warning.path}: ${warning.message}\n`);
  }
  return loaded.manifest;
}

/** Load a corpus manifest and return non-fatal schema warnings alongside it. */
export function loadCorpusManifestWithWarnings(path: string): LoadedCorpusManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError(
      [{ path: 'corpus_manifest.path', message: `cannot read or parse ${path}: ${message}` }],
      'Invalid corpus manifest',
    );
  }

  const issues: ConfigValidationIssue[] = [];
  const warnings: CorpusManifestValidationWarning[] = [];
  validateManifest(parsed, 'manifest', issues, warnings);
  if (issues.length > 0) {
    throw new ConfigValidationError(issues, 'Invalid corpus manifest');
  }

  return {
    manifest: deepFreeze(parsed) as CorpusManifest,
    warnings,
  };
}

function validateManifest(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
  warnings: CorpusManifestValidationWarning[],
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }
  warnUnknownKeys(value, topLevelKeys, path, warnings);
  requireNumber(value, 'manifest_schema_version', path, issues);
  requireString(value, 'ticket_id', path, issues);
  requireString(value, 'status', path, issues);
  requireNullableString(value, 'blocked_reason', path, issues);
  requireBoolean(value, 'ready_for_sim03_model_fitting', path, issues);
  requireString(value, 'scope_note', path, issues);
  requireString(value, 'dataset', path, issues);
  requireString(value, 'symbol', path, issues);
  requireBoolean(value, 'databento_api_key_present', path, issues);
  validateDatasetRange(value.dataset_range, `${path}.dataset_range`, issues, warnings);
  requireNullableString(value, 'dataset_range_error', path, issues);
  requireString(value, 'definition_schema', path, issues);
  requireStringArray(value, 'event_schemas', path, issues);
  requireNumber(value, 'min_complete_sessions', path, issues);
  requireString(value, 'out_dir', path, issues);
  validateRetryPolicy(value.retry_policy, `${path}.retry_policy`, issues, warnings);
  requireNumber(value, 'validation_fraction', path, issues);
  validateCorpusSummary(value.corpus_summary, `${path}.corpus_summary`, issues, warnings);
  validateSessions(value.sessions, `${path}.sessions`, issues, warnings);
}

function validateCorpusSummary(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
  warnings: CorpusManifestValidationWarning[],
): asserts value is CorpusManifestSummary {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }
  warnUnknownKeys(value, corpusSummaryKeys, path, warnings);
  for (const key of corpusSummaryKeys) {
    requireNumber(value, key, path, issues);
  }
}

function validateDatasetRange(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
  warnings: CorpusManifestValidationWarning[],
): asserts value is CorpusManifestDatasetRange {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }
  warnUnknownKeys(value, datasetRangeKeys, path, warnings);
  requireString(value, 'start', path, issues);
  requireString(value, 'end', path, issues);
  if (!isRecord(value.schema)) {
    issues.push({ path: `${path}.schema`, message: 'must be an object keyed by schema name' });
    return;
  }
  for (const [schema, range] of Object.entries(value.schema)) {
    validateDatasetSchemaRange(range, `${path}.schema.${schema}`, issues, warnings);
  }
}

function validateDatasetSchemaRange(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
  warnings: CorpusManifestValidationWarning[],
): asserts value is CorpusManifestDatasetSchemaRange {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }
  warnUnknownKeys(value, datasetRangeSchemaKeys, path, warnings);
  requireString(value, 'start', path, issues);
  requireString(value, 'end', path, issues);
}

function validateRetryPolicy(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
  warnings: CorpusManifestValidationWarning[],
): asserts value is CorpusManifestRetryPolicy {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }
  warnUnknownKeys(value, retryPolicyKeys, path, warnings);
  requireNumber(value, 'attempts', path, issues);
  requireString(value, 'backoff', path, issues);
  requireNumber(value, 'base_seconds', path, issues);
}

function validateSessions(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
  warnings: CorpusManifestValidationWarning[],
): asserts value is readonly CorpusManifestSession[] {
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'must be an array' });
    return;
  }
  if (value.length === 0) {
    issues.push({ path, message: 'must include at least one session' });
  }
  value.forEach((session, index) =>
    validateSession(session, `${path}.${index}`, issues, warnings),
  );
}

function validateSession(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
  warnings: CorpusManifestValidationWarning[],
): asserts value is CorpusManifestSession {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }
  warnUnknownKeys(value, sessionKeys, path, warnings);
  requireString(value, 'session_id', path, issues);
  requireString(value, 'status', path, issues);
  requireString(value, 'split', path, issues);
  requireString(value, 'symbol', path, issues);
  requireNullableString(value, 'exclusion_reason', path, issues);
  validateWindow(value.definition_snapshot_window, `${path}.definition_snapshot_window`, issues, warnings);
  validateWindow(value.rth_window, `${path}.rth_window`, issues, warnings);
  if (!isRecord(value.schemas)) {
    issues.push({ path: `${path}.schemas`, message: 'must be an object keyed by schema name' });
    return;
  }
  for (const [schema, schemaFile] of Object.entries(value.schemas)) {
    validateSchemaFile(schemaFile, `${path}.schemas.${schema}`, issues, warnings);
  }
}

function validateWindow(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
  warnings: CorpusManifestValidationWarning[],
): asserts value is CorpusManifestWindow {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }
  warnUnknownKeys(value, windowKeys, path, warnings);
  requireDecimalString(value, 'start_ts_ns', path, issues);
  requireDecimalString(value, 'end_ts_ns', path, issues);
}

function validateSchemaFile(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
  warnings: CorpusManifestValidationWarning[],
): asserts value is CorpusManifestSchemaFile {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }
  warnUnknownKeys(value, schemaFileKeys, path, warnings);
  requireString(value, 'schema', path, issues);
  requireString(value, 'status', path, issues);
  requireString(value, 'path', path, issues);
  requireDecimalString(value, 'start_ts_ns', path, issues);
  requireDecimalString(value, 'end_ts_ns', path, issues);
  requireNumber(value, 'byte_count', path, issues);
  requireNullableNumber(value, 'record_count', path, issues);
  requireBoolean(value, 'reused_existing', path, issues);
  requireNumber(value, 'attempts', path, issues);
  if ('sha256' in value) {
    requireSha256(value, 'sha256', path, issues);
  }
}

function warnUnknownKeys(
  value: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
  path: string,
  warnings: CorpusManifestValidationWarning[],
): void {
  for (const key of Object.keys(value)) {
    if (!knownKeys.has(key)) {
      warnings.push({ path: `${path}.${key}`, message: 'unknown field preserved' });
    }
  }
}

function requireString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  if (typeof value[key] !== 'string' || value[key].length === 0) {
    issues.push({ path: `${path}.${key}`, message: 'required non-empty string is missing or invalid' });
  }
}

function requireDecimalString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  if (typeof value[key] !== 'string' || !/^\d+$/u.test(value[key])) {
    issues.push({ path: `${path}.${key}`, message: 'required decimal timestamp string is missing or invalid' });
  }
}

function requireNullableString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  if (!(typeof value[key] === 'string' || value[key] === null)) {
    issues.push({ path: `${path}.${key}`, message: 'required string-or-null field is missing or invalid' });
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

function requireNullableNumber(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  if (!((typeof value[key] === 'number' && Number.isFinite(value[key])) || value[key] === null)) {
    issues.push({ path: `${path}.${key}`, message: 'required finite-number-or-null field is missing or invalid' });
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

function requireStringArray(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  if (!Array.isArray(value[key]) || !value[key].every((item) => typeof item === 'string' && item.length > 0)) {
    issues.push({ path: `${path}.${key}`, message: 'required string array is missing or invalid' });
  }
}

function requireSha256(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): void {
  if (typeof value[key] !== 'string' || !/^[a-f0-9]{64}$/u.test(value[key])) {
    issues.push({ path: `${path}.${key}`, message: 'sha256 must be lower-case 64-character hex' });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
