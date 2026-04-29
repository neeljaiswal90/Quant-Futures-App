export const LIMIT_QUEUE_FRONT_OBSERVATION_SCHEMA_VERSION = 1 as const;
export const LIMIT_QUEUE_FRONT_BUCKET = 'limit_queue:front' as const;
export const LIMIT_QUEUE_FRONT_BUCKET_ID = 'front' as const;
export const LIMIT_QUEUE_FRONT_TARGET_METRIC =
  'time_to_fill_relative_error_within_time_to_fill_relative_threshold' as const;
export const TARGETED_FRONT_REFIT_METHOD =
  'targeted_bucket_refit_from_calibration_observations' as const;

export type JsonObject = Record<string, unknown>;

export interface LimitQueueFrontObservation {
  readonly schema_version: typeof LIMIT_QUEUE_FRONT_OBSERVATION_SCHEMA_VERSION;
  readonly bucket: typeof LIMIT_QUEUE_FRONT_BUCKET;
  readonly split: 'calibration' | 'validation';
  readonly observed_time_to_fill_ms?: number | null;
  readonly modeled_time_to_fill_ms?: number | null;
  readonly fill_outcome: 'filled' | 'no_fill' | 'cancelled';
  readonly queue_position_features: JsonObject;
  readonly event_ts_ns: string;
  readonly session_id: string;
  readonly instrument: string;
  readonly source_report_hash: string;
  readonly order_side?: string;
  readonly queue_bucket?: typeof LIMIT_QUEUE_FRONT_BUCKET_ID;
  readonly no_fill_or_cancel_outcome?: 'no_fill' | 'cancelled' | null;
  readonly source_session_or_file?: string;
  readonly observation_id?: string;
}

export function validateLimitQueueFrontObservation(
  value: unknown,
  context: {
    readonly lineNumber?: number;
    readonly expectedSourceReportHash?: string;
    readonly sourceLabel?: string;
  } = {},
): LimitQueueFrontObservation {
  const label = context.lineNumber === undefined ? 'observation' : `observation line ${context.lineNumber}`;
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  if (value.schema_version !== LIMIT_QUEUE_FRONT_OBSERVATION_SCHEMA_VERSION) {
    throw new Error(`${label} has unsupported schema_version`);
  }
  if (value.bucket !== LIMIT_QUEUE_FRONT_BUCKET) {
    throw new Error(`${label} does not target ${LIMIT_QUEUE_FRONT_BUCKET}`);
  }
  const split = value.split;
  if (split !== 'calibration' && split !== 'validation') {
    throw new Error(`${label} split must be calibration or validation`);
  }
  const fillOutcome = value.fill_outcome;
  if (fillOutcome !== 'filled' && fillOutcome !== 'no_fill' && fillOutcome !== 'cancelled') {
    throw new Error(`${label} fill_outcome is invalid`);
  }
  const queuePositionFeatures = value.queue_position_features;
  if (!isJsonObject(queuePositionFeatures)) {
    throw new Error(`${label} queue_position_features must be an object`);
  }
  const sourceReportHash = requireString(value.source_report_hash, `${label} source_report_hash`);
  if (
    context.expectedSourceReportHash !== undefined &&
    sourceReportHash !== context.expectedSourceReportHash
  ) {
    throw new Error(
      `${label} source_report_hash does not match ${context.sourceLabel ?? 'source report'}`,
    );
  }
  const observedTimeToFill = numberOrNull(value.observed_time_to_fill_ms);
  if (fillOutcome === 'filled' && observedTimeToFill === null) {
    throw new Error(`${label} filled observations require observed_time_to_fill_ms`);
  }
  const queueBucket = optionalString(value.queue_bucket);
  if (queueBucket !== undefined && queueBucket !== LIMIT_QUEUE_FRONT_BUCKET_ID) {
    throw new Error(`${label} queue_bucket must be ${LIMIT_QUEUE_FRONT_BUCKET_ID}`);
  }
  const noFillOrCancelOutcome = optionalString(value.no_fill_or_cancel_outcome);
  if (
    noFillOrCancelOutcome !== undefined &&
    noFillOrCancelOutcome !== 'no_fill' &&
    noFillOrCancelOutcome !== 'cancelled'
  ) {
    throw new Error(`${label} no_fill_or_cancel_outcome is invalid`);
  }

  return {
    schema_version: LIMIT_QUEUE_FRONT_OBSERVATION_SCHEMA_VERSION,
    bucket: LIMIT_QUEUE_FRONT_BUCKET,
    split,
    observed_time_to_fill_ms: observedTimeToFill,
    modeled_time_to_fill_ms: numberOrNull(value.modeled_time_to_fill_ms),
    fill_outcome: fillOutcome,
    queue_position_features: queuePositionFeatures,
    event_ts_ns: requireString(value.event_ts_ns, `${label} event_ts_ns`),
    session_id: requireString(value.session_id, `${label} session_id`),
    instrument: requireString(value.instrument, `${label} instrument`),
    source_report_hash: sourceReportHash,
    ...(typeof value.order_side === 'string' ? { order_side: value.order_side } : {}),
    ...(queueBucket === undefined ? {} : { queue_bucket: queueBucket }),
    ...(noFillOrCancelOutcome === undefined
      ? {}
      : { no_fill_or_cancel_outcome: noFillOrCancelOutcome }),
    ...(typeof value.source_session_or_file === 'string'
      ? { source_session_or_file: value.source_session_or_file }
      : {}),
    ...(typeof value.observation_id === 'string' ? { observation_id: value.observation_id } : {}),
  };
}

export function observationSchemaExample(): JsonObject {
  return {
    schema_version: LIMIT_QUEUE_FRONT_OBSERVATION_SCHEMA_VERSION,
    bucket: LIMIT_QUEUE_FRONT_BUCKET,
    split: 'calibration',
    observed_time_to_fill_ms: 3900,
    modeled_time_to_fill_ms: null,
    fill_outcome: 'filled',
    no_fill_or_cancel_outcome: null,
    order_side: 'bid',
    queue_bucket: LIMIT_QUEUE_FRONT_BUCKET_ID,
    queue_position_features: {
      queue_bucket: LIMIT_QUEUE_FRONT_BUCKET_ID,
      queue_ahead_size: 0,
      queue_ahead_order_count: 0,
    },
    event_ts_ns: '1777296600000000000',
    session_id: '2026-04-27-rth',
    instrument: 'MNQM6',
    source_report_hash: '<sha256 of fill_slippage_calibration.json>',
    source_session_or_file: '2026-04-27-rth:mbo',
    observation_id: '<deterministic sha256>',
  };
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
