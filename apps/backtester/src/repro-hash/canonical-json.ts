import {
  throwReproHashIssue,
  type ReproHashIssue,
} from './repro-hash-error.js';

const BIGINT_TAG_KEY = '__qfa_type';

export function canonicalizeReproJson(value: unknown): string {
  return canonicalizeValue(value, '$');
}

function canonicalizeValue(value: unknown, path: string): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return canonicalizeNumber(value, path);
  }
  if (typeof value === 'bigint') {
    return canonicalizeBigint(value);
  }
  if (typeof value === 'undefined') {
    return throwReproHashIssue({
      path,
      code: 'undefined_value',
      message: 'undefined values are not part of canonical_json_v1',
    });
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    return throwUnsupportedValue(path, typeof value);
  }
  if (Array.isArray(value)) {
    return canonicalizeArray(value, path);
  }
  if (value instanceof Date) {
    return throwReproHashIssue({
      path,
      code: 'date_value_forbidden',
      message: 'Date objects are forbidden; pass deterministic strings instead',
    });
  }
  if (typeof value === 'object') {
    return canonicalizeObject(value, path);
  }
  return throwUnsupportedValue(path, typeof value);
}

function canonicalizeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    return throwReproHashIssue({
      path,
      code: 'non_finite_number',
      message: 'NaN and Infinity are forbidden in canonical_json_v1',
    });
  }
  if (Object.is(value, -0)) {
    return throwReproHashIssue({
      path,
      code: 'negative_zero',
      message: 'negative zero is forbidden in canonical_json_v1',
    });
  }
  return JSON.stringify(value);
}

function canonicalizeBigint(value: bigint): string {
  return `{"${BIGINT_TAG_KEY}":"bigint","value":${JSON.stringify(value.toString())}}`;
}

function canonicalizeArray(value: readonly unknown[], path: string): string {
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      return throwReproHashIssue({
        path: `${path}[${index}]`,
        code: 'undefined_value',
        message: 'sparse array slots are forbidden in canonical_json_v1',
      });
    }
    parts.push(canonicalizeValue(value[index], `${path}[${index}]`));
  }
  return `[${parts.join(',')}]`;
}

function canonicalizeObject(value: object, path: string): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return throwReproHashIssue({
      path,
      code: 'unsupported_value',
      message: 'only plain objects are supported in canonical_json_v1',
    });
  }
  const symbolKeys = Object.getOwnPropertySymbols(value);
  if (symbolKeys.length > 0) {
    return throwReproHashIssue({
      path,
      code: 'unsupported_value',
      message: 'symbol-keyed object properties are forbidden in canonical_json_v1',
    });
  }

  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, BIGINT_TAG_KEY)) {
    return throwReproHashIssue({
      path: `${path}.${BIGINT_TAG_KEY}`,
      code: 'unsupported_value',
      message: `${BIGINT_TAG_KEY} is reserved for canonical bigint tagging`,
    });
  }

  const keys = Object.keys(record).sort();
  const issues: ReproHashIssue[] = [];
  const parts: string[] = [];
  for (const key of keys) {
    const childPath = `${path}.${key}`;
    const child = record[key];
    if (typeof child === 'undefined') {
      issues.push({
        path: childPath,
        code: 'undefined_value',
        message: 'undefined object properties are forbidden in canonical_json_v1',
      });
      continue;
    }
    parts.push(`${JSON.stringify(key)}:${canonicalizeValue(child, childPath)}`);
  }
  if (issues.length > 0) {
    return throwReproHashIssue(issues[0]!);
  }
  return `{${parts.join(',')}}`;
}

function throwUnsupportedValue(path: string, valueType: string): never {
  return throwReproHashIssue({
    path,
    code: 'unsupported_value',
    message: `unsupported canonical_json_v1 value type: ${valueType}`,
  });
}
