import { unixNsToJsonString, type UnixNs } from './time.js';

export type JsonPrimitive = string | number | bigint | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export function stableJsonStringify(value: JsonValue): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Cannot serialize non-finite number');
    }
    return JSON.stringify(value);
  }

  if (typeof value === 'bigint') {
    return JSON.stringify(unixNsToJsonString(value as UnixNs));
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(',')}]`;
  }

  const record = value as { readonly [key: string]: JsonValue };
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key]!)}`)
    .join(',')}}`;
}

export function toJsonLine(value: JsonValue): string {
  return `${stableJsonStringify(value)}\n`;
}
