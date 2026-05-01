export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export function assertJsonSafe(value: unknown, path = '$'): asserts value is JsonValue {
  if (value === null) {
    return;
  }

  const valueType = typeof value;

  if (valueType === 'string' || valueType === 'boolean') {
    return;
  }

  if (valueType === 'bigint') {
    throw new Error(`${path} must be JSON-safe; bigint values are forbidden`);
  }

  if (valueType === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} must be JSON-safe; non-finite numbers are forbidden`);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`${path} must be JSON-safe; unsafe integer numbers are forbidden`);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonSafe(entry, `${path}[${index}]`));
    return;
  }

  if (valueType === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      assertJsonSafe(entry, `${path}.${key}`);
    }
    return;
  }

  throw new Error(`${path} must be JSON-safe; ${valueType} values are forbidden`);
}

export function stableJsonStringify(value: unknown): string {
  assertJsonSafe(value);
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue(value[key]!);
    }
    return sorted;
  }
  return value;
}
