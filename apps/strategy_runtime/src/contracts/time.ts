import type { Brand } from './ids.js';

export type UnixNsInput = bigint | number | string;

/**
 * Timestamp transport rule:
 * - In-memory contracts use branded bigint nanoseconds.
 * - JSONL transport serializes nanoseconds as unsigned decimal strings.
 * - Display-only ISO strings may be derived later, but are not canonical replay data.
 */
export type UnixNs = Brand<bigint, 'UnixNs'>;

export const TIMESTAMP_NS_FIELD_NAMES = [
  'exchange_event_ts_ns',
  'rithmic_publish_ts_ns',
  'sidecar_recv_ts_ns',
  'tick_ts_ns',
  'runtime_consume_ts_ns',
  'created_ts_ns',
  'emitted_ts_ns',
  'evaluated_ts_ns',
  'proposed_ts_ns',
  'decided_ts_ns',
  'submitted_ts_ns',
  'filled_ts_ns',
  'opened_ts_ns',
  'updated_ts_ns',
  'closed_ts_ns',
  'boot_ts_ns',
  'snapshot_ts_ns',
  'start_ts_ns',
  'end_ts_ns',
  'ts_ns',
  'ts_ns_local',
] as const;

const TIMESTAMP_NS_FIELD_NAME_SET = new Set<string>(TIMESTAMP_NS_FIELD_NAMES);

export interface SourceTimestampSet {
  readonly exchange_event_ts_ns: UnixNs;
  readonly rithmic_publish_ts_ns?: UnixNs;
  readonly sidecar_recv_ts_ns: UnixNs;
}

export interface RuntimeTimestampSet extends SourceTimestampSet {
  readonly runtime_consume_ts_ns: UnixNs;
  readonly ts_ns: UnixNs;
}

export interface TimestampValidationIssue {
  readonly path: string;
  readonly message: string;
}

function parseNs(value: UnixNsInput): bigint {
  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error('number nanosecond timestamp must be a safe integer');
    }
    return BigInt(value);
  }

  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('string nanosecond timestamp must be unsigned decimal digits');
  }
  return BigInt(value);
}

export function ns(value: UnixNsInput): UnixNs {
  const parsed = parseNs(value);
  if (parsed < 0n) {
    throw new Error('nanosecond timestamp must be non-negative');
  }
  return parsed as UnixNs;
}

export function unixNsToJsonString(value: UnixNs): string {
  return value.toString();
}

export function isTimestampNsFieldName(fieldName: string): boolean {
  return TIMESTAMP_NS_FIELD_NAME_SET.has(fieldName) || fieldName.endsWith('_ts_ns');
}

function shouldSkipTimestampRevival(path: string): boolean {
  return path.endsWith('.feature_availability_mask') || path.includes('.feature_availability_mask.');
}

export function reviveTimestampNsFields(value: unknown, path = '$'): unknown {
  if (shouldSkipTimestampRevival(path)) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => reviveTimestampNsFields(item, `${path}[${index}]`));
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const revived: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(record)) {
    const childPath = `${path}.${key}`;
    if (isTimestampNsFieldName(key)) {
      if (typeof child !== 'string') {
        throw new Error(`${childPath} must be a decimal string nanosecond timestamp in JSONL`);
      }
      revived[key] = ns(child);
      continue;
    }
    revived[key] = reviveTimestampNsFields(child, childPath);
  }

  return revived;
}

function validateNsField(
  value: unknown,
  path: string,
  issues: TimestampValidationIssue[],
  optional = false,
) {
  if (value === undefined && optional) {
    return;
  }
  try {
    ns(value as UnixNsInput);
  } catch {
    issues.push({ path, message: 'must be a non-negative integer nanosecond timestamp' });
  }
}

export function validateRuntimeTimestampSet(
  timestamps: Partial<Record<keyof RuntimeTimestampSet, unknown>>,
): readonly TimestampValidationIssue[] {
  const issues: TimestampValidationIssue[] = [];
  validateNsField(timestamps.exchange_event_ts_ns, 'exchange_event_ts_ns', issues);
  validateNsField(timestamps.rithmic_publish_ts_ns, 'rithmic_publish_ts_ns', issues, true);
  validateNsField(timestamps.sidecar_recv_ts_ns, 'sidecar_recv_ts_ns', issues);
  validateNsField(timestamps.runtime_consume_ts_ns, 'runtime_consume_ts_ns', issues);
  validateNsField(timestamps.ts_ns, 'ts_ns', issues);
  return issues;
}

export function makeRuntimeTimestampSet(input: {
  readonly exchange_event_ts_ns: UnixNsInput;
  readonly rithmic_publish_ts_ns?: UnixNsInput;
  readonly sidecar_recv_ts_ns: UnixNsInput;
  readonly runtime_consume_ts_ns: UnixNsInput;
  readonly ts_ns: UnixNsInput;
}): RuntimeTimestampSet {
  const issues = validateRuntimeTimestampSet(input);
  if (issues.length > 0) {
    throw new Error(
      `Invalid runtime timestamp set:\n${issues
        .map((issue) => `- ${issue.path}: ${issue.message}`)
        .join('\n')}`,
    );
  }

  return {
    exchange_event_ts_ns: ns(input.exchange_event_ts_ns),
    rithmic_publish_ts_ns:
      input.rithmic_publish_ts_ns === undefined ? undefined : ns(input.rithmic_publish_ts_ns),
    sidecar_recv_ts_ns: ns(input.sidecar_recv_ts_ns),
    runtime_consume_ts_ns: ns(input.runtime_consume_ts_ns),
    ts_ns: ns(input.ts_ns),
  };
}
