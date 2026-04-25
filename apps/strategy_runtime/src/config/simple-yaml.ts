import { ConfigValidationError } from './errors.js';
import type { ConfigValidationIssue } from './types.js';

export function parseSimpleYaml(
  contents: string,
  filePath: string,
  message = 'Invalid YAML config',
): unknown {
  const root: Record<string, unknown> = {};
  const stack: Array<{ readonly indent: number; readonly object: Record<string, unknown> }> = [
    { indent: 0, object: root },
  ];

  const lines = contents.replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const withoutComment = stripYamlComment(rawLine);
    if (withoutComment.trim() === '') {
      return;
    }
    const match = /^(\s*)([A-Za-z0-9_]+):(?:\s*(.*))?$/.exec(withoutComment);
    if (match === null) {
      throw new ConfigValidationError([
        { path: `${filePath}:${index + 1}`, message: 'unsupported YAML line' },
      ], message);
    }
    const indent = match[1]!.length;
    if (indent % 2 !== 0) {
      throw new ConfigValidationError([
        { path: `${filePath}:${index + 1}`, message: 'indentation must use two-space levels' },
      ], message);
    }

    while (stack.length > 1 && indent < stack[stack.length - 1]!.indent) {
      stack.pop();
    }
    const frame = stack[stack.length - 1]!;
    if (indent !== frame.indent) {
      throw new ConfigValidationError([
        { path: `${filePath}:${index + 1}`, message: 'unsupported YAML indentation jump' },
      ], message);
    }

    const key = match[2]!;
    const rawValue = match[3] ?? '';
    if (rawValue.trim() === '') {
      const child: Record<string, unknown> = {};
      frame.object[key] = child;
      stack.push({ indent: indent + 2, object: child });
      return;
    }
    frame.object[key] = parseYamlScalar(rawValue.trim());
  });

  return root;
}

export function requireRecord(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ path, message: 'required object is missing or invalid' });
    return {};
  }
  return value as Record<string, unknown>;
}

export function readRecord(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): Record<string, unknown> {
  return requireRecord(record[key], `${path}.${key}`, issues);
}

export function checkUnknownKeys(
  record: Record<string, unknown>,
  path: string,
  allowedKeys: readonly string[],
  issues: ConfigValidationIssue[],
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record).sort()) {
    if (!allowed.has(key)) {
      issues.push({ path: `${path}.${key}`, message: 'unknown field' });
    }
  }
}

export function readLiteral<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  path: string,
  allowedValues: T,
  issues: ConfigValidationIssue[],
): T[number] {
  const value = record[key];
  if (typeof value !== 'string' || !allowedValues.includes(value)) {
    issues.push({ path: `${path}.${key}`, message: `expected one of: ${allowedValues.join(', ')}` });
  }
  return value as T[number];
}

export function readString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ path: `${path}.${key}`, message: 'required non-empty string is missing or invalid' });
    return '';
  }
  return value;
}

export function readBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    issues.push({ path: `${path}.${key}`, message: 'required boolean is missing or invalid' });
    return false;
  }
  return value;
}

export function readNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({ path: `${path}.${key}`, message: 'required finite number is missing or invalid' });
    return 0;
  }
  return value;
}

export function readPositiveNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): number {
  const value = readNumber(record, key, path, issues);
  if (!(value > 0)) {
    issues.push({ path: `${path}.${key}`, message: 'must be > 0' });
  }
  return value;
}

export function readNonNegativeNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ConfigValidationIssue[],
): number {
  const value = readNumber(record, key, path, issues);
  if (value < 0) {
    issues.push({ path: `${path}.${key}`, message: 'must be >= 0' });
  }
  return value;
}

export function throwIfIssues(
  issues: ConfigValidationIssue[],
  message = 'Invalid YAML config',
): void {
  if (issues.length > 0) {
    throw new ConfigValidationError(
      issues.sort((left, right) => (
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0
      )),
      message,
    );
  }
}

function stripYamlComment(line: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && quote === undefined) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = undefined;
      continue;
    }
    if (char === '#' && quote === undefined && (index === 0 || line[index - 1] === ' ')) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseYamlScalar(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    return Number(value);
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
