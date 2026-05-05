/**
 * QFA-115 Backtest Run Specification — RunSpec-specific JCS profile and hash.
 *
 * EXPLICIT CONSTRAINT: this file does NOT import from `serialization.ts`.
 * The shared `stableJsonStringify` there silently coerces `bigint` to a
 * UnixNs string via `unixNsToJsonString`, which directly violates the
 * RunSpec determinism contract (Q-3.3: bigint must throw, not coerce).
 * The Session 1 violation of this prohibition is the primary reason for
 * the Session 2a restructure. Future contributors: if you find yourself
 * about to import `stableJsonStringify` here, stop — read ADR-0007 and
 * the QFA-115 walkthrough Q-3 first.
 *
 * The JCS profile aligns with RFC 8785 with one explicit deviation: NFC
 * Unicode normalization is NOT applied (RFC 8785 also leaves Unicode
 * normalization to the caller). String surrogate well-formedness is
 * enforced by `validateRunSpec` before canonicalization reaches strings.
 *
 * Canonicalization rules:
 *   1. validateRunSpec() runs first; throws RunSpecValidationError on bad input
 *   2. bigint anywhere -> throw (defense-in-depth; validation catches first)
 *   3. non-finite numbers -> throw
 *   4. undefined values throw (consistent with Q-3 reject-don't-coerce; RunSpec
 *      has no optional fields by design, so undefined indicates a bug)
 *   5. object keys sorted lexicographically (RFC 8785)
 *   6. array element order preserved (RFC 8785)
 *   7. no insignificant whitespace
 *   8. UTF-8 output
 *
 * RunSpec contains only string, finite-number, boolean, null, array, and
 * object values; the canonicalize walker rejects any other type.
 */

import { createHash } from 'node:crypto';
import type { RunSpec } from './run-spec.js';
import { validateRunSpec } from './run-spec-validate.js';

/**
 * Produce the canonical JSON string for a RunSpec. Validation runs first;
 * fails fast with `RunSpecValidationError` on invariant violation.
 */
export function canonicalizeRunSpec(spec: RunSpec): string {
  validateRunSpec(spec);
  return canonicalizeValue(spec, '$');
}

/**
 * Compute the deterministic sha256 hash of a RunSpec's canonical JSON form.
 * Returns a lower-case 64-character hex string.
 */
export function computeRunSpecHash(spec: RunSpec): string {
  return createHash('sha256')
    .update(canonicalizeRunSpec(spec), 'utf8')
    .digest('hex');
}

function canonicalizeValue(value: unknown, path: string): string {
  if (typeof value === 'bigint') {
    throw new Error(
      `Cannot canonicalize bigint at ${path}: RunSpec must contain no bigint values (Q-3.3)`,
    );
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot canonicalize non-finite number at ${path}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    // Surrogate well-formedness is enforced by validateRunSpec before
    // canonicalization. JSON.stringify emits RFC 8259-compatible escaping.
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((item, index) =>
      canonicalizeValue(item, `${path}[${index}]`),
    );
    return `[${parts.join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts = keys.map((key) => {
      const childPath = `${path}.${key}`;
      const child = canonicalizeValue(record[key], childPath);
      return `${JSON.stringify(key)}:${child}`;
    });
    return `{${parts.join(',')}}`;
  }
  if (typeof value === 'undefined') {
    throw new Error(`Cannot canonicalize undefined at ${path}`);
  }
  throw new Error(
    `Cannot canonicalize value of type ${typeof value} at ${path}`,
  );
}
