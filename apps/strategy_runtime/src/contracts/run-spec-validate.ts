/**
 * QFA-115 Backtest Run Specification — invariant validation.
 *
 * `validateRunSpec` enforces the QFA-115 walkthrough's locked invariants
 * before canonicalization. Failures aggregate into `RunSpecValidationError`
 * with a descriptive `path: message` issue list, mirroring the
 * `ConfigValidationError` pattern from `config/errors.ts`.
 *
 * Validation is the gate between caller-constructed RunSpec values and the
 * RunSpec-specific JCS profile in `run-spec-hash.ts`. Anything that reaches
 * canonicalization must already be invariant-clean; canonicalization does
 * not silently fix bad input.
 *
 * Determinism contract enforced here:
 *   - BigInt is rejected anywhere in RunSpec (Q-3.3).
 *   - Non-finite numbers rejected (Q-3.2 #3).
 *   - Unsafe integers rejected where integer semantics required (Q-3.2 #4).
 *   - Lone surrogates / invalid UTF-16 rejected in all string fields (Q-3.2 #5).
 *   - Array ordering validated, not silently sorted (Q-3.4).
 */

import {
  CONFIG_INPUT_ROLE_ORDER,
  CORPUS_INPUT_ROLE_ORDER,
  type BacktestWindow,
  type ConfigInputRole,
  type CorpusInputRef,
  type CorpusInputRole,
  type NamedConfigLineageRef,
  type RunSpec,
} from './run-spec.js';
import { isStrategyId } from './strategy-ids.js';

/** A single invariant failure with a path identifying the offending field. */
export interface RunSpecValidationIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Aggregated invariant failure thrown by `validateRunSpec`. Mirrors
 * `ConfigValidationError` shape: `instanceof` distinguishable from other
 * validation error classes, carries a `readonly issues` array, formats a
 * multi-line message.
 */
export class RunSpecValidationError extends Error {
  readonly issues: readonly RunSpecValidationIssue[];

  constructor(issues: readonly RunSpecValidationIssue[], heading = 'Invalid RunSpec') {
    const details = issues.map((issue) => `- ${issue.path}: ${issue.message}`).join('\n');
    super(`${heading}:\n${details}`);
    this.name = 'RunSpecValidationError';
    this.issues = issues;
  }
}

const HEX_64 = /^[a-f0-9]{64}$/u;
const HEX_40 = /^[a-f0-9]{40}$/u;
const TIME_BAR_RE = /^[1-9][0-9]*(s|m|h|d)$/u;
const TICK_BAR_RE = /^tick:(ticks|volume|dollar):[1-9][0-9]*$/u;
const SESSION_DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const UINT32_MAX = 0xffffffff;
const ALLOWED_CALENDARS = new Set<BacktestWindow['calendar']>(['CME_US_INDEX_FUTURES']);
const CORPUS_INPUT_ROLE_INDEX = new Map<CorpusInputRole, number>(
  CORPUS_INPUT_ROLE_ORDER.map((role, index) => [role, index]),
);
const CONFIG_INPUT_ROLE_INDEX = new Map<ConfigInputRole, number>(
  CONFIG_INPUT_ROLE_ORDER.map((role, index) => [role, index]),
);

/**
 * Validate a RunSpec value. Throws `RunSpecValidationError` aggregating all
 * issues if any invariant is violated. Returns void on success.
 */
export function validateRunSpec(spec: RunSpec): void {
  const issues: RunSpecValidationIssue[] = [];
  const path = '$';

  validateBigIntAbsence(spec, path, issues);

  if (spec.run_spec_schema_version !== 1) {
    issues.push({ path: `${path}.run_spec_schema_version`, message: 'must be 1' });
  }
  if (spec.instrument_root !== 'MNQ') {
    issues.push({ path: `${path}.instrument_root`, message: 'must be "MNQ" (V1 scope)' });
  }

  validateBarSpecGrammar(spec.bar_spec, `${path}.bar_spec`, issues);
  validateBacktestWindow(spec.backtest_window, `${path}.backtest_window`, issues);
  validateDeterminismSeed(spec.determinism_seed, `${path}.determinism_seed`, issues);
  validateStrategyIds(spec.strategy_ids, `${path}.strategy_ids`, issues);
  validateCorpusInputOrdering(spec.corpus_inputs, `${path}.corpus_inputs`, issues);
  validateConfigInputOrdering(spec.config_inputs, `${path}.config_inputs`, issues);

  validateString(spec.runner_code_commit_sha, `${path}.runner_code_commit_sha`, issues);
  if (
    typeof spec.runner_code_commit_sha === 'string'
    && !HEX_40.test(spec.runner_code_commit_sha)
  ) {
    issues.push({
      path: `${path}.runner_code_commit_sha`,
      message: 'must be a lower-case 40-character hex git SHA-1',
    });
  }
  if (typeof spec.runner_code_dirty !== 'boolean') {
    issues.push({ path: `${path}.runner_code_dirty`, message: 'must be a boolean' });
  }

  if (issues.length > 0) {
    throw new RunSpecValidationError(issues);
  }
}

/**
 * Walk the RunSpec recursively rejecting any bigint value. RunSpec contains
 * no bigint fields by design (Q-3.3); the only bigint adjacent to RunSpec is
 * `run_started_at_ns` on `BacktestRunMetaPayload`, which is excluded by being
 * outside RunSpec proper.
 */
function validateBigIntAbsence(
  value: unknown,
  path: string,
  issues: RunSpecValidationIssue[],
): void {
  if (typeof value === 'bigint') {
    issues.push({ path, message: 'bigint values are forbidden in RunSpec' });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      validateBigIntAbsence(item, `${path}[${index}]`, issues);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      validateBigIntAbsence(child, `${path}.${key}`, issues);
    }
  }
}

/** Validate a string field for type and well-formed UTF-16 (no lone surrogates). */
function validateString(value: unknown, path: string, issues: RunSpecValidationIssue[]): void {
  if (typeof value !== 'string') {
    issues.push({ path, message: 'must be a string' });
    return;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    // High surrogate D800-DBFF must be followed by low surrogate DC00-DFFF.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        issues.push({
          path,
          message: `invalid UTF-16: lone high surrogate at index ${String(index)}`,
        });
        return;
      }
      index += 1;
      continue;
    }
    // Low surrogate DC00-DFFF without a preceding high surrogate.
    if (code >= 0xdc00 && code <= 0xdfff) {
      issues.push({
        path,
        message: `invalid UTF-16: lone low surrogate at index ${String(index)}`,
      });
      return;
    }
  }
}

/** Validate the `bar_spec` grammar from Q-2.6. */
function validateBarSpecGrammar(
  value: unknown,
  path: string,
  issues: RunSpecValidationIssue[],
): void {
  validateString(value, path, issues);
  if (typeof value !== 'string') return;
  if (TIME_BAR_RE.test(value)) return;
  if (TICK_BAR_RE.test(value)) return;
  issues.push({
    path,
    message:
      'must match time-bar regex /^[1-9][0-9]*(s|m|h|d)$/ or tick-bar regex /^tick:(ticks|volume|dollar):[1-9][0-9]*$/',
  });
}

/** Validate `BacktestWindow`. */
function validateBacktestWindow(
  value: unknown,
  path: string,
  issues: RunSpecValidationIssue[],
): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }
  const window = value as Record<string, unknown>;
  validateString(window.start, `${path}.start`, issues);
  validateString(window.end, `${path}.end`, issues);
  if (window.mode !== 'instant' && window.mode !== 'session') {
    issues.push({ path: `${path}.mode`, message: 'must be "instant" or "session"' });
  }
  if (typeof window.inclusive_end !== 'boolean') {
    issues.push({ path: `${path}.inclusive_end`, message: 'must be a boolean' });
  }
  if (typeof window.calendar !== 'string') {
    issues.push({ path: `${path}.calendar`, message: 'must be a string' });
  } else if (!ALLOWED_CALENDARS.has(window.calendar as BacktestWindow['calendar'])) {
    issues.push({
      path: `${path}.calendar`,
      message: 'must be one of: CME_US_INDEX_FUTURES',
    });
  }

  if (typeof window.start === 'string' && typeof window.end === 'string') {
    if (window.mode === 'session') {
      if (!SESSION_DATE_RE.test(window.start)) {
        issues.push({ path: `${path}.start`, message: 'session-mode start must match YYYY-MM-DD' });
      }
      if (!SESSION_DATE_RE.test(window.end)) {
        issues.push({ path: `${path}.end`, message: 'session-mode end must match YYYY-MM-DD' });
      }
    } else if (window.mode === 'instant') {
      if (!INSTANT_RE.test(window.start)) {
        issues.push({
          path: `${path}.start`,
          message: 'instant-mode start must be UTC ISO-8601 with explicit Z (e.g., 2026-02-02T14:30:00Z)',
        });
      }
      if (!INSTANT_RE.test(window.end)) {
        issues.push({
          path: `${path}.end`,
          message: 'instant-mode end must be UTC ISO-8601 with explicit Z (e.g., 2026-02-02T14:30:00Z)',
        });
      }
    }
    if (window.start > window.end) {
      issues.push({ path, message: 'start must be lexicographically <= end' });
    }
  }
}

/** Validate `determinism_seed` per Q-3.2 #4 + A3 (uint32 non-negative safe integer). */
function validateDeterminismSeed(
  value: unknown,
  path: string,
  issues: RunSpecValidationIssue[],
): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({ path, message: 'must be a finite number' });
    return;
  }
  if (!Number.isSafeInteger(value)) {
    issues.push({ path, message: 'must be a safe integer' });
    return;
  }
  if (value < 0 || value > UINT32_MAX) {
    issues.push({ path, message: 'must be a non-negative integer <= 2^32 - 1' });
  }
}

/** Validate a positive (>= 1) integer schema/version field. */
function validatePositiveIntegerVersion(
  value: unknown,
  path: string,
  issues: RunSpecValidationIssue[],
): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({ path, message: 'must be a finite number' });
    return;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    issues.push({ path, message: 'must be a positive safe integer (>= 1)' });
  }
}

/** Validate `strategy_ids`: known + no duplicates; preserves caller order. */
function validateStrategyIds(
  value: unknown,
  path: string,
  issues: RunSpecValidationIssue[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path, message: 'must be a non-empty array' });
    return;
  }
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof item !== 'string') {
      issues.push({ path: itemPath, message: 'must be a string' });
      return;
    }
    if (!isStrategyId(item)) {
      issues.push({ path: itemPath, message: `unknown strategy_id: ${item}` });
      return;
    }
    if (seen.has(item)) {
      issues.push({ path: itemPath, message: `duplicate strategy_id: ${item}` });
      return;
    }
    seen.add(item);
  });
}

/**
 * Validate a single `CorpusInputRef`'s field-level invariants. Does NOT
 * validate ordering relative to siblings; that's `validateCorpusInputOrdering`.
 */
function validateCorpusInput(
  value: unknown,
  path: string,
  issues: RunSpecValidationIssue[],
): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }
  const ref = value as Record<string, unknown>;

  if (typeof ref.role !== 'string' || !CORPUS_INPUT_ROLE_INDEX.has(ref.role as CorpusInputRole)) {
    issues.push({
      path: `${path}.role`,
      message: `must be one of: ${CORPUS_INPUT_ROLE_ORDER.join(', ')}`,
    });
  }

  validateString(ref.manifest_hash, `${path}.manifest_hash`, issues);
  if (typeof ref.manifest_hash === 'string' && !HEX_64.test(ref.manifest_hash)) {
    issues.push({
      path: `${path}.manifest_hash`,
      message: 'must be a lower-case 64-character hex sha256',
    });
  }
  validatePositiveIntegerVersion(
    ref.manifest_schema_version,
    `${path}.manifest_schema_version`,
    issues,
  );

  if (ref.tier !== 'A' && ref.tier !== 'B' && ref.tier !== 'C') {
    issues.push({ path: `${path}.tier`, message: 'must be "A", "B", or "C"' });
  }

  if (ref.verification_status !== 'passed' && ref.verification_status !== 'not_run') {
    issues.push({
      path: `${path}.verification_status`,
      message: 'must be "passed" or "not_run"',
    });
  }
  // Q-1.7 invariant: passed IFF verification_report_hash !== null.
  if (ref.verification_status === 'passed') {
    if (typeof ref.verification_report_hash !== 'string') {
      issues.push({
        path: `${path}.verification_report_hash`,
        message: 'must be a hex string when verification_status === "passed"',
      });
    } else {
      validateString(ref.verification_report_hash, `${path}.verification_report_hash`, issues);
      if (!HEX_64.test(ref.verification_report_hash)) {
        issues.push({
          path: `${path}.verification_report_hash`,
          message: 'must be a lower-case 64-character hex sha256',
        });
      }
    }
  } else if (ref.verification_status === 'not_run') {
    if (ref.verification_report_hash !== null) {
      issues.push({
        path: `${path}.verification_report_hash`,
        message: 'must be null when verification_status === "not_run"',
      });
    }
  }

  validateTierClassification(ref.tier_classification, `${path}.tier_classification`, issues);
}

/** Validate `CorpusTierClassificationRef` invariants. */
function validateTierClassification(
  value: unknown,
  path: string,
  issues: RunSpecValidationIssue[],
): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }
  const ref = value as Record<string, unknown>;
  validateString(ref.classification_reason, `${path}.classification_reason`, issues);
  if (ref.policy_source !== 'runner_code' && ref.policy_source !== 'config') {
    issues.push({
      path: `${path}.policy_source`,
      message: 'must be "runner_code" or "config"',
    });
  }
  // Q-1.6 invariant: runner_code ↔ null; config ↔ non-null lineage ref.
  if (ref.policy_source === 'runner_code') {
    if (ref.policy_ref !== null) {
      issues.push({
        path: `${path}.policy_ref`,
        message: 'must be null when policy_source === "runner_code"',
      });
    }
  } else if (ref.policy_source === 'config') {
    if (ref.policy_ref === null || typeof ref.policy_ref !== 'object' || Array.isArray(ref.policy_ref)) {
      issues.push({
        path: `${path}.policy_ref`,
        message: 'must be a ConfigLineageRef object when policy_source === "config"',
      });
    } else {
      validateConfigLineageRef(ref.policy_ref, `${path}.policy_ref`, issues);
    }
  }
}

/** Validate a `ConfigLineageRef`. */
function validateConfigLineageRef(
  value: unknown,
  path: string,
  issues: RunSpecValidationIssue[],
): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }
  const ref = value as Record<string, unknown>;
  validateString(ref.config_hash, `${path}.config_hash`, issues);
  if (typeof ref.config_hash === 'string' && !HEX_64.test(ref.config_hash)) {
    issues.push({
      path: `${path}.config_hash`,
      message: 'must be a lower-case 64-character hex sha256',
    });
  }
  validatePositiveIntegerVersion(ref.config_version, `${path}.config_version`, issues);
}

/** Validate ordering of `corpus_inputs` array per Q-3.4. */
function validateCorpusInputOrdering(
  value: unknown,
  path: string,
  issues: RunSpecValidationIssue[],
): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'must be an array' });
    return;
  }
  if (value.length === 0) {
    issues.push({ path, message: 'must contain at least one corpus input' });
    return;
  }
  value.forEach((item, index) => {
    validateCorpusInput(item, `${path}[${index}]`, issues);
  });
  // Ordering check only if all items are well-formed enough to compare.
  for (let index = 1; index < value.length; index += 1) {
    const prev = value[index - 1] as CorpusInputRef;
    const curr = value[index] as CorpusInputRef;
    if (compareCorpusInputs(prev, curr) > 0) {
      issues.push({
        path: `${path}[${index}]`,
        message:
          `out of order: must follow CORPUS_INPUT_ROLE_ORDER then manifest_hash ASC then manifest_schema_version ASC`,
      });
    }
  }
}

function compareCorpusInputs(left: CorpusInputRef, right: CorpusInputRef): number {
  const leftRole = CORPUS_INPUT_ROLE_INDEX.get(left.role) ?? Number.POSITIVE_INFINITY;
  const rightRole = CORPUS_INPUT_ROLE_INDEX.get(right.role) ?? Number.POSITIVE_INFINITY;
  if (leftRole !== rightRole) return leftRole - rightRole;
  if (left.manifest_hash !== right.manifest_hash) {
    return left.manifest_hash < right.manifest_hash ? -1 : 1;
  }
  return left.manifest_schema_version - right.manifest_schema_version;
}

/** Validate ordering of `config_inputs` array per Q-3.4. */
function validateConfigInputOrdering(
  value: unknown,
  path: string,
  issues: RunSpecValidationIssue[],
): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'must be an array' });
    return;
  }
  if (value.length === 0) {
    issues.push({ path, message: 'must contain at least one config input' });
    return;
  }
  value.forEach((item, index) => {
    validateConfigInput(item, `${path}[${index}]`, issues);
  });
  for (let index = 1; index < value.length; index += 1) {
    const prev = value[index - 1] as NamedConfigLineageRef;
    const curr = value[index] as NamedConfigLineageRef;
    if (compareConfigInputs(prev, curr) > 0) {
      issues.push({
        path: `${path}[${index}]`,
        message:
          `out of order: must follow CONFIG_INPUT_ROLE_ORDER then config_path ASC then lineage.config_hash ASC then lineage.config_version ASC`,
      });
    }
  }
}

function compareConfigInputs(
  left: NamedConfigLineageRef,
  right: NamedConfigLineageRef,
): number {
  const leftRole = CONFIG_INPUT_ROLE_INDEX.get(left.role) ?? Number.POSITIVE_INFINITY;
  const rightRole = CONFIG_INPUT_ROLE_INDEX.get(right.role) ?? Number.POSITIVE_INFINITY;
  if (leftRole !== rightRole) return leftRole - rightRole;
  if (left.config_path !== right.config_path) {
    return left.config_path < right.config_path ? -1 : 1;
  }
  if (left.lineage.config_hash !== right.lineage.config_hash) {
    return left.lineage.config_hash < right.lineage.config_hash ? -1 : 1;
  }
  return left.lineage.config_version - right.lineage.config_version;
}

/** Validate a single `NamedConfigLineageRef` field-level invariants. */
function validateConfigInput(
  value: unknown,
  path: string,
  issues: RunSpecValidationIssue[],
): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }
  const ref = value as Record<string, unknown>;
  if (typeof ref.role !== 'string' || !CONFIG_INPUT_ROLE_INDEX.has(ref.role as ConfigInputRole)) {
    issues.push({
      path: `${path}.role`,
      message: `must be one of: ${CONFIG_INPUT_ROLE_ORDER.join(', ')}`,
    });
  }
  validateConfigPath(ref.config_path, `${path}.config_path`, issues);
  validateConfigLineageRef(ref.lineage, `${path}.lineage`, issues);
}

/**
 * Validate `config_path` per Q-1.5 + A2: repo-relative POSIX, no backslash,
 * no absolute path, no drive-letter prefix, no `..` traversal segments.
 */
function validateConfigPath(
  value: unknown,
  path: string,
  issues: RunSpecValidationIssue[],
): void {
  if (typeof value !== 'string' || value === '') {
    issues.push({ path, message: 'must be a non-empty string' });
    return;
  }
  validateString(value, path, issues);
  if (value.startsWith('/')) {
    issues.push({ path, message: 'must be repo-relative; absolute path forbidden' });
    return;
  }
  if (/^[A-Za-z]:/u.test(value)) {
    issues.push({ path, message: 'must be repo-relative; drive-letter prefix forbidden' });
    return;
  }
  if (value.includes('\\')) {
    issues.push({ path, message: 'must use forward-slash separators; backslash forbidden' });
    return;
  }
  if (value.split('/').includes('..')) {
    issues.push({ path, message: 'path traversal segments (..) forbidden' });
  }
}
