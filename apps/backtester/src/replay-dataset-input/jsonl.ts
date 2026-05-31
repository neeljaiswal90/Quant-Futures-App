import { readFileSync } from 'node:fs';
import type { ReplayDatasetContext, ReplaySignalRow, ReplayTradeTick, TradeAggressorSide } from './types.js';
import { cmpNs, parseNsDecimal } from './time.js';

type JsonRecord = Record<string, unknown>;

const SIGNAL_NS_KEYS = ['ts_ns'] as const;
const REPLAY_STEP_NS_KEYS = ['step_ns'] as const;
const TRADE_NS_KEYS = [
  'exchange_event_ts_ns',
  'ts_event_ns',
  'ts_ns',
  'sidecar_recv_ts_ns',
  'ts_recv_ns',
] as const;

export function readReplayDatasetJsonl(path: string): readonly ReplaySignalRow[] {
  const lines = nonEmptyLines(readFileSync(path, 'utf8'));
  return Object.freeze(lines.map((line, index) => parseReplaySignalLine(line, index + 1)));
}

export function readReplayTradeTapeJsonl(path: string): readonly ReplayTradeTick[] {
  const trades: ReplayTradeTick[] = [];
  const lines = nonEmptyLines(readFileSync(path, 'utf8'));
  for (let index = 0; index < lines.length; index += 1) {
    const trade = parseReplayTradeLine(lines[index]!, index + 1);
    if (trade !== null) {
      trades.push(trade);
    }
  }
  trades.sort((left, right) => cmpNs(left.ts_ns, right.ts_ns));
  return Object.freeze(trades);
}

function parseReplaySignalLine(line: string, lineNumber: number): ReplaySignalRow {
  const parsed = parseJsonRecord(line, `dataset line ${lineNumber}`);
  const replay = requiredRecordAt(parsed, 'replay', `dataset line ${lineNumber}.replay`);
  const tsNs = parseNsDecimal(
    extractNsToken(line, SIGNAL_NS_KEYS, `dataset line ${lineNumber}.ts_ns`),
    `dataset line ${lineNumber}.ts_ns`,
  );
  const stepNs = parseNsDecimal(
    extractNsToken(line, REPLAY_STEP_NS_KEYS, `dataset line ${lineNumber}.replay.step_ns`),
    `dataset line ${lineNumber}.replay.step_ns`,
  );
  return Object.freeze({
    schema_version: intAt(parsed, 'schema_version', `dataset line ${lineNumber}.schema_version`),
    ts_ns: tsNs,
    family: stringAt(parsed, 'family', `dataset line ${lineNumber}.family`),
    event_type: stringAt(parsed, 'event_type', `dataset line ${lineNumber}.event_type`),
    tier: optionalStringAt(parsed, 'tier', `dataset line ${lineNumber}.tier`),
    price: optionalNumberAt(parsed, 'price', `dataset line ${lineNumber}.price`),
    level_id: optionalStringAt(parsed, 'level_id', `dataset line ${lineNumber}.level_id`),
    side: optionalStringAt(parsed, 'side', `dataset line ${lineNumber}.side`),
    direction: optionalStringAt(parsed, 'direction', `dataset line ${lineNumber}.direction`),
    zone_context: parsed.zone_context ?? null,
    regime: parsed.regime ?? null,
    orderflow_snapshot: parsed.orderflow_snapshot ?? null,
    depth_snapshot: parsed.depth_snapshot ?? null,
    confluence_stack_size: optionalIntAt(
      parsed,
      'confluence_stack_size',
      `dataset line ${lineNumber}.confluence_stack_size`,
    ),
    payload: parsed.payload ?? null,
    replay: Object.freeze({
      capture_date: stringAt(replay, 'capture_date', `dataset line ${lineNumber}.replay.capture_date`),
      session: stringAt(replay, 'session', `dataset line ${lineNumber}.replay.session`),
      step_ns: stepNs,
      source_obs01: stringAt(replay, 'source_obs01', `dataset line ${lineNumber}.replay.source_obs01`),
      source_mbo: optionalStringAt(replay, 'source_mbo', `dataset line ${lineNumber}.replay.source_mbo`),
      schema_version: intAt(replay, 'schema_version', `dataset line ${lineNumber}.replay.schema_version`),
    } satisfies ReplayDatasetContext),
    raw_line: line,
  });
}

function parseReplayTradeLine(line: string, lineNumber: number): ReplayTradeTick | null {
  const parsed = parseJsonRecord(line, `trade tape line ${lineNumber}`);
  const payload = optionalRecordAt(parsed, 'payload', `trade tape line ${lineNumber}.payload`);
  const record = payload ?? parsed;
  const price = firstNumber(record, ['price', 'px', 'last_price', 'trade_price']);
  if (price === null) {
    return null;
  }
  const tsToken = extractNsToken(line, TRADE_NS_KEYS, `trade tape line ${lineNumber}.ts`);
  const size = firstNumber(record, ['size', 'quantity', 'qty', 'volume', 'trade_size']) ?? 0;
  return Object.freeze({
    ts_ns: parseNsDecimal(tsToken, `trade tape line ${lineNumber}.ts`),
    price,
    size,
    aggressor_side: parseAggressorSide(firstString(record, [
      'aggressor_side',
      'aggressor',
      'side',
      'trade_side',
    ])),
  });
}

function parseAggressorSide(value: string | null): TradeAggressorSide {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === 'buy' ||
    normalized === 'buyer' ||
    normalized === 'ask' ||
    normalized === 'at_ask' ||
    normalized === 'lift_ask'
  ) {
    return 'buy';
  }
  if (
    normalized === 'sell' ||
    normalized === 'seller' ||
    normalized === 'bid' ||
    normalized === 'at_bid' ||
    normalized === 'hit_bid'
  ) {
    return 'sell';
  }
  return 'unknown';
}

function nonEmptyLines(content: string): readonly string[] {
  return Object.freeze(
    content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

function parseJsonRecord(line: string, context: string): JsonRecord {
  const parsed = JSON.parse(line) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${context} must be a JSON object`);
  }
  return parsed as JsonRecord;
}

function extractNsToken(line: string, keys: readonly string[], path: string): string {
  for (const key of keys) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const pattern = new RegExp(`"${escapedKey}"\\s*:\\s*"?(\\d+)"?`, 'u');
    const match = line.match(pattern);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  throw new Error(`${path} missing nanosecond timestamp`);
}

function requiredRecordAt(record: JsonRecord, key: string, path: string): JsonRecord {
  const value = record[key];
  if (value === undefined || value === null) {
    throw new Error(`${path} is required`);
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function optionalRecordAt(
  record: JsonRecord,
  key: string,
  path: string,
): JsonRecord | null {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function stringAt(record: JsonRecord, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalStringAt(record: JsonRecord, key: string, path: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string or null`);
  }
  return value;
}

function intAt(record: JsonRecord, key: string, path: string): number {
  const value = record[key];
  if (!Number.isInteger(value)) {
    throw new Error(`${path} must be an integer`);
  }
  return value as number;
}

function optionalIntAt(record: JsonRecord, key: string, path: string): number | null {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${path} must be an integer or null`);
  }
  return value as number;
}

function optionalNumberAt(record: JsonRecord, key: string, path: string): number | null {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number or null`);
  }
  return value;
}

function firstNumber(record: JsonRecord, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function firstString(record: JsonRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return null;
}
