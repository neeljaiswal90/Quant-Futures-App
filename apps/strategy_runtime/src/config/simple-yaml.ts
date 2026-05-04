// Module: simple-yaml — the canonical YAML parser for this project.
// Deliberately a strict YAML subset: scalar maps, nested maps, scalar
// sequences, sequences of maps, and inline empty literals `[]` / `{}`.
// Multi-line scalars, anchors/aliases, non-empty flow style, multi-document
// streams, tags, and directives are all rejected with descriptive errors.
//
// Empty-value defaulting: a bare `key:` with no children defaults to []
// (empty sequence). Use `key: {}` to explicitly request an empty map.
// This default favors list-shaped configs (calendars, session lists,
// parameter sweeps) which are the dominant new shape post-QFA-114.
//
// Sequence support and the empty-default convention added by QFA-114.
// Map and scalar handling unchanged.

import { ConfigValidationError } from './errors.js';
import type { ConfigValidationIssue } from './types.js';

// Match `key: value` or bare `key:` lines.
//
// The value capture (.*) is intentionally greedy and permits subsequent
// colons in the value (e.g. `start: 2026-02-27T14:30:00Z`,
// `event_time_utc: 19:00:00`). This is a deliberate design choice: ISO
// datetimes and HH:MM:SS values must flow through unquoted, since manually
// quoting every time-typed scalar in real configs is unergonomic.
const KEY_VALUE_LINE = /^(\s*)([A-Za-z0-9_]+):(?:\s*(.*))?$/u;

// Match `- value`, `- key: value`, or bare `- ` (sequence entry markers).
// The dash MUST be followed by either a space (introducing content) or end
// of trimmed line (empty entry — currently unsupported, surfaces a clear
// error). The trailing capture inherits the same intentional permissiveness
// for colons in scalar values as KEY_VALUE_LINE above.
const DASH_LINE = /^(\s*)-(?:\s+(.*))?$/u;

type MapFrame = {
  readonly kind: 'map';
  readonly indent: number;
  readonly object: Record<string, unknown>;
  // When this map was opened by a `key:` line with empty value, we track
  // its parent slot here so that a subsequent `- ` line at the same indent
  // can retroactively convert this empty map to a sequence by mutating
  // parentSlot.container[parentSlot.key] = []. Cleared (made undefined)
  // once the first non-sequence child line commits this frame to map kind.
  parentSlot?: ParentSlot;
};

type SequenceFrame = {
  readonly kind: 'sequence';
  readonly indent: number;
  readonly array: unknown[];
};

type ParentSlot =
  | { readonly container: Record<string, unknown>; readonly key: string }
  | { readonly container: unknown[]; readonly key: number };

type Frame = MapFrame | SequenceFrame;

export function parseSimpleYaml(
  contents: string,
  filePath: string,
  message = 'Invalid YAML config',
): unknown {
  const root: Record<string, unknown> = {};
  const stack: Frame[] = [{ kind: 'map', indent: 0, object: root }];

  const lines = contents.replace(/^﻿/u, '').split(/\r?\n/u);
  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const withoutComment = stripYamlComment(rawLine);
    if (withoutComment.trim() === '') {
      return;
    }

    rejectUnsupportedConstructs(withoutComment, filePath, lineNumber, message);

    const dashMatch = DASH_LINE.exec(withoutComment);
    if (dashMatch !== null) {
      handleSequenceEntry(dashMatch, stack, filePath, lineNumber, withoutComment, message);
      return;
    }

    const kvMatch = KEY_VALUE_LINE.exec(withoutComment);
    if (kvMatch !== null) {
      handleKeyValue(kvMatch, stack, filePath, lineNumber, message);
      return;
    }

    throw new ConfigValidationError(
      [{ path: `${filePath}:${lineNumber}`, message: 'unsupported YAML line' }],
      message,
    );
  });

  // End-of-input drain: any remaining frames that opened from `key:` with
  // empty value but never received a child line default to [] rather than
  // {}. This makes bare `events:` (no entries underneath) parse as an
  // empty sequence — the natural shape for list-typed YAML keys.
  while (stack.length > 1) {
    popFrameWithEmptyDefaulting(stack);
  }

  return root;
}

/** Pop the top frame, defaulting an unused empty-map opener to []. */
function popFrameWithEmptyDefaulting(stack: Frame[]): void {
  const popped = stack.pop()!;
  if (
    popped.kind === 'map'
    && popped.parentSlot !== undefined
    && Object.keys(popped.object).length === 0
  ) {
    const slot = popped.parentSlot;
    if (Array.isArray(slot.container)) {
      slot.container[slot.key as number] = [];
    } else {
      slot.container[slot.key as string] = [];
    }
  }
}

function handleKeyValue(
  match: RegExpExecArray,
  stack: Frame[],
  filePath: string,
  lineNumber: number,
  message: string,
): void {
  const indent = match[1]!.length;
  if (indent % 2 !== 0) {
    throw new ConfigValidationError(
      [{ path: `${filePath}:${lineNumber}`, message: 'indentation must use two-space levels' }],
      message,
    );
  }

  while (stack.length > 1 && indent < stack[stack.length - 1]!.indent) {
    popFrameWithEmptyDefaulting(stack);
  }
  const frame = stack[stack.length - 1]!;
  if (indent !== frame.indent) {
    throw new ConfigValidationError(
      [{ path: `${filePath}:${lineNumber}`, message: 'unsupported YAML indentation jump' }],
      message,
    );
  }
  if (frame.kind !== 'map') {
    throw new ConfigValidationError(
      [{ path: `${filePath}:${lineNumber}`, message: 'expected sequence entry (- ...) at this indent, got map key' }],
      message,
    );
  }

  // First child line at this indent commits the frame to map kind: drop
  // the retroactive-swap parentSlot so a later `- ` line at the same
  // indent cannot convert this map to a sequence.
  if (frame.parentSlot !== undefined) {
    (frame as { parentSlot?: ParentSlot }).parentSlot = undefined;
  }

  const key = match[2]!;
  const rawValue = match[3] ?? '';
  const trimmedValue = rawValue.trim();

  if (trimmedValue === '') {
    const child: Record<string, unknown> = {};
    frame.object[key] = child;
    stack.push({
      kind: 'map',
      indent: indent + 2,
      object: child,
      parentSlot: { container: frame.object, key },
    });
    return;
  }
  if (trimmedValue === '[]') {
    frame.object[key] = [];
    return;
  }
  if (trimmedValue === '{}') {
    frame.object[key] = {};
    return;
  }
  frame.object[key] = parseYamlScalar(trimmedValue);
}

function handleSequenceEntry(
  match: RegExpExecArray,
  stack: Frame[],
  filePath: string,
  lineNumber: number,
  rawLineForReporting: string,
  message: string,
): void {
  const indent = match[1]!.length;
  if (indent % 2 !== 0) {
    throw new ConfigValidationError(
      [{ path: `${filePath}:${lineNumber}`, message: 'indentation must use two-space levels' }],
      message,
    );
  }

  while (stack.length > 1 && indent < stack[stack.length - 1]!.indent) {
    popFrameWithEmptyDefaulting(stack);
  }

  // Retroactive map→sequence swap: if the top frame is an empty map opened
  // by a `key:` line, and we now see a `- ` at the same indent, convert
  // that map to a sequence in-place.
  let frame = stack[stack.length - 1]!;
  if (
    frame.kind === 'map'
    && frame.indent === indent
    && frame.parentSlot !== undefined
    && Object.keys(frame.object).length === 0
  ) {
    const slot = frame.parentSlot;
    const newArray: unknown[] = [];
    if (Array.isArray(slot.container)) {
      slot.container[slot.key as number] = newArray;
    } else {
      slot.container[slot.key as string] = newArray;
    }
    stack.pop();
    const seqFrame: SequenceFrame = { kind: 'sequence', indent, array: newArray };
    stack.push(seqFrame);
    frame = seqFrame;
  }

  if (frame.kind !== 'sequence' || frame.indent !== indent) {
    throw new ConfigValidationError(
      [{
        path: `${filePath}:${lineNumber}`,
        message: `unexpected sequence entry: ${truncate(rawLineForReporting)}`,
      }],
      message,
    );
  }

  const dashContent = match[2];
  if (dashContent === undefined || dashContent === '') {
    throw new ConfigValidationError(
      [{
        path: `${filePath}:${lineNumber}:${indent + 1}`,
        message: `bare '-' sequence entry without content not supported: ${truncate(rawLineForReporting)}`,
      }],
      message,
    );
  }

  // Sequence-of-maps: the dash content begins with `key: value` or `key:`.
  // The entry's first key sits at indent + 2 (two columns past the dash);
  // subsequent keys of the same entry align there.
  const entryKvMatch = /^([A-Za-z0-9_]+):(?:\s*(.*))?$/u.exec(dashContent);
  if (entryKvMatch !== null) {
    const entry: Record<string, unknown> = {};
    frame.array.push(entry);
    const entryIndent = indent + 2;
    const entryFrame: MapFrame = { kind: 'map', indent: entryIndent, object: entry };
    stack.push(entryFrame);

    const key = entryKvMatch[1]!;
    const rawValue = entryKvMatch[2] ?? '';
    const trimmedValue = rawValue.trim();
    if (trimmedValue === '') {
      const child: Record<string, unknown> = {};
      entry[key] = child;
      stack.push({
        kind: 'map',
        indent: entryIndent + 2,
        object: child,
        parentSlot: { container: entry, key },
      });
      return;
    }
    if (trimmedValue === '[]') {
      entry[key] = [];
      return;
    }
    if (trimmedValue === '{}') {
      entry[key] = {};
      return;
    }
    entry[key] = parseYamlScalar(trimmedValue);
    return;
  }

  // Sequence-of-scalars: the dash content is a bare scalar.
  frame.array.push(parseYamlScalar(dashContent.trim()));
}

function rejectUnsupportedConstructs(
  line: string,
  filePath: string,
  lineNumber: number,
  message: string,
): void {
  const trimmed = line.trim();

  if (trimmed === '---' || trimmed === '...') {
    throw richError(
      filePath,
      lineNumber,
      line.indexOf(trimmed) + 1,
      line,
      'multi-document YAML streams not supported (--- / ... markers)',
      message,
    );
  }

  if (trimmed.startsWith('%')) {
    throw richError(
      filePath,
      lineNumber,
      line.indexOf('%') + 1,
      line,
      'YAML directives (e.g. %YAML, %TAG) not supported',
      message,
    );
  }

  // Block scalar indicator as a value: `key: |`, `key: >`, with optional
  // chomping (+/-) and indent indicator digits. Match only when the value
  // shape is exactly the indicator (the line cannot have other tokens
  // after it because the parser is single-line).
  const blockScalarIndicator = /:\s+([|>])([+\-]?[0-9]?)\s*$/u;
  const blockMatch = blockScalarIndicator.exec(line);
  if (blockMatch !== null) {
    throw richError(
      filePath,
      lineNumber,
      line.indexOf(blockMatch[1]!) + 1,
      line,
      `multi-line block scalars not supported (${blockMatch[1]!}${blockMatch[2] ?? ''} indicator)`,
      message,
    );
  }

  // Anchors and aliases: `&name` or `*name` after a colon, or in a sequence
  // value. The capture must be at a value position (after `: ` or `- `).
  const anchorAliasMatch = /(?::\s+|-\s+)([&*])([A-Za-z0-9_]+)/u.exec(line);
  if (anchorAliasMatch !== null) {
    const symbol = anchorAliasMatch[1]!;
    throw richError(
      filePath,
      lineNumber,
      line.indexOf(symbol + anchorAliasMatch[2]!) + 1,
      line,
      `YAML ${symbol === '&' ? 'anchors (&name)' : 'aliases (*name)'} not supported`,
      message,
    );
  }

  // Tags: `!!str`, `!str`, etc. — only when at a value position.
  const tagMatch = /(?::\s+|-\s+)(!{1,2}[A-Za-z0-9_]+)/u.exec(line);
  if (tagMatch !== null) {
    throw richError(
      filePath,
      lineNumber,
      line.indexOf(tagMatch[1]!) + 1,
      line,
      `YAML tags (${tagMatch[1]!}) not supported`,
      message,
    );
  }

  // Non-empty flow sequence at a value position. Empty `[]` is allowed
  // (handled in handleKeyValue / handleSequenceEntry); anything else
  // rejects.
  const flowSeqMatch = /(?::\s+|-\s+)(\[)(?!\s*\])/u.exec(line);
  if (flowSeqMatch !== null) {
    throw richError(
      filePath,
      lineNumber,
      line.indexOf('[') + 1,
      line,
      'non-empty flow sequences ([a, b]) not supported; use block style with - lines',
      message,
    );
  }

  // Non-empty flow map at a value position. Empty `{}` is allowed.
  const flowMapMatch = /(?::\s+|-\s+)(\{)(?!\s*\})/u.exec(line);
  if (flowMapMatch !== null) {
    throw richError(
      filePath,
      lineNumber,
      line.indexOf('{') + 1,
      line,
      'non-empty flow mappings ({a: b}) not supported; use block style with key: value lines',
      message,
    );
  }
}

function richError(
  filePath: string,
  lineNumber: number,
  column: number,
  line: string,
  description: string,
  message: string,
): ConfigValidationError {
  return new ConfigValidationError(
    [{
      path: `${filePath}:${lineNumber}:${column}`,
      message: `${description}: ${truncate(line)}`,
    }],
    message,
  );
}

function truncate(line: string): string {
  const trimmed = line.replace(/\s+$/u, '');
  if (trimmed.length <= 80) {
    return trimmed;
  }
  return `${trimmed.slice(0, 77)}...`;
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
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) {
    return Number(value);
  }
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
