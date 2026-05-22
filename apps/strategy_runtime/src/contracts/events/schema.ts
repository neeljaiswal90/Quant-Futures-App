import { JOURNAL_EVENT_SCHEMA_VERSION, type JournalEventEnvelope } from './envelope.js';
import {
  categorizeRuntimeEventType,
  isBrokerOriginatedEventType,
  isRuntimeEventType,
  type RuntimeEventType,
} from './event-types.js';
import { ALL_STRATEGY_IDS } from '../strategy-ids.js';

export type JournalEventSchemaIssueCode =
  | 'invalid_envelope'
  | 'unsupported_schema_version'
  | 'unsupported_event_type'
  | 'missing_required_field'
  | 'invalid_field_type'
  | 'invalid_field_value';

export interface JournalEventSchemaIssue {
  readonly path: string;
  readonly code: JournalEventSchemaIssueCode;
  readonly message: string;
}

export interface JournalEventSchemaValidationResult {
  readonly ok: boolean;
  readonly event?: JournalEventEnvelope;
  readonly issues: readonly JournalEventSchemaIssue[];
}

type Validator = (
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
) => void;

const STRATEGY_IDS = ALL_STRATEGY_IDS;
const SUPPORTED_JOURNAL_EVENT_SCHEMA_VERSIONS = [1, JOURNAL_EVENT_SCHEMA_VERSION] as const;
const VALIDATOR_IDS = [
  'EXEC-VALIDATOR-01',
  'EXEC-VALIDATOR-02',
  'EXEC-VALIDATOR-03',
  'EXEC-VALIDATOR-04',
  'EXEC-VALIDATOR-05',
  'EXEC-VALIDATOR-06',
  'EXEC-VALIDATOR-07',
  'EXEC-VALIDATOR-08',
  'EXEC-VALIDATOR-09',
] as const;
const VALIDATOR_SEVERITIES = ['info', 'warning', 'error', 'fatal'] as const;

const PAYLOAD_VALIDATORS = {
  CONN: validateConnectionPayload,
  FEED: validateFeedPayload,
  GAP: validateGapPayload,
  BOOK_REBUILD: validateBookRebuildPayload,
  SESSION_PHASE: validateSessionPhasePayload,
  ROLL_ADVISORY: validateRollAdvisoryPayload,
  SESSION_MANIFEST: validateSessionManifestPayload,
  RECONNECT_STATE: validateReconnectStatePayload,
  LIVENESS_STATE: validateLivenessStatePayload,
  KILL_SWITCH_ENGAGED: validateKillSwitchEngagedPayload,
  KILL_SWITCH_DISENGAGED: validateKillSwitchDisengagedPayload,
  ANOMALY_DETECTED: validateAnomalyDetectedPayload,
  HALT: validateHaltPayload,
  WOULD_HALT: validateHaltPayload,
  VALIDATOR_ISSUE: validateValidatorIssuePayload,
  SECRET_RESOLUTION: validateSecretResolutionPayload,
  QUOTE: validateQuotePayload,
  TRADE: validateTradePayload,
  BAR_CLOSE: validateBarClosePayload,
  FEATURES: validateFeaturesPayload,
  STRUCTURE: validateStructurePayload,
  MICROSTRUCTURE: validateMicrostructurePayload,
  STRAT_EVAL: validateStrategyEvaluationPayload,
  CANDIDATE: validateCandidatePayload,
  ML_UPLIFT: validateMlUpliftPayload,
  RANK: validateRankPayload,
  RISK_GATE: validateRiskGatePayload,
  SIZING: validateSizingPayload,
  ORDER_ACK_CANCEL: validateOrderAckCancelPayload,
  ORDER_ACK_FILL: validateOrderAckFillPayload,
  ORDER_ACK_SUBMISSION: validateOrderAckSubmissionPayload,
  ORDER_BROKER_REJECT: validateOrderBrokerRejectPayload,
  ORDER_QUARANTINE_ENTERED: validateOrderQuarantineEnteredPayload,
  ORDER_QUARANTINE_CLEARED: validateOrderQuarantineClearedPayload,
  ORDER_INTENT: validateOrderIntentPayload,
  SIM_FILL: validateSimFillPayload,
  EXEC_REJECT: validateExecutionRejectPayload,
  POSITION: validatePositionPayload,
  MGMT_TICK: validateManagementTickPayload,
  MGMT_ACTION: validateManagementActionPayload,
  CONFIG: validateConfigPayload,
  BACKTEST_RUN_META: validateBacktestRunMetaPayload,
} as const satisfies Record<RuntimeEventType, Validator>;

export function validateJournalEventEnvelope(value: unknown): JournalEventSchemaValidationResult {
  const issues: JournalEventSchemaIssue[] = [];
  const envelope = requireRecord(value, '$', issues);
  if (envelope === undefined) {
    return { ok: false, issues };
  }

  if (
    typeof envelope.schema_version !== 'number' ||
    !SUPPORTED_JOURNAL_EVENT_SCHEMA_VERSIONS.includes(
      envelope.schema_version as (typeof SUPPORTED_JOURNAL_EVENT_SCHEMA_VERSIONS)[number],
    )
  ) {
    addIssue(
      issues,
      '$.schema_version',
      'unsupported_schema_version',
      `must be one of: ${SUPPORTED_JOURNAL_EVENT_SCHEMA_VERSIONS.join(', ')}`,
    );
  }

  requireNonEmptyString(envelope.event_id, '$.event_id', issues);
  requireNonEmptyString(envelope.run_id, '$.run_id', issues);
  requireNonEmptyString(envelope.session_id, '$.session_id', issues);
  requireTimestamp(envelope.ts_ns, '$.ts_ns', issues);

  const type = envelope.type;
  let runtimeType: RuntimeEventType | undefined;
  if (typeof type !== 'string' || !isRuntimeEventType(type)) {
    addIssue(
      issues,
      '$.type',
      'unsupported_event_type',
      `unsupported runtime event type: ${String(type)}`,
    );
  } else {
    runtimeType = type;
  }
  if (runtimeType !== undefined && isBrokerOriginatedEventType(runtimeType)) {
    requireTimestamp(envelope.ts_ns_local, '$.ts_ns_local', issues);
  } else {
    optionalTimestamp(envelope.ts_ns_local, '$.ts_ns_local', issues);
  }

  if (envelope.causation_id !== undefined) {
    requireNonEmptyString(envelope.causation_id, '$.causation_id', issues);
  }
  if (envelope.correlation_id !== undefined) {
    requireNonEmptyString(envelope.correlation_id, '$.correlation_id', issues);
  }
  if (envelope.config !== undefined) {
    validateConfigLineageRef(envelope.config, issues, '$.config');
  }

  if (!Object.hasOwn(envelope, 'payload')) {
    addIssue(issues, '$.payload', 'missing_required_field', 'is required');
  } else if (runtimeType !== undefined) {
    PAYLOAD_VALIDATORS[runtimeType](envelope.payload, issues, '$.payload');
    if (
      categorizeRuntimeEventType(runtimeType) === 'derived' &&
      (typeof envelope.causation_id !== 'string' || envelope.causation_id.trim() === '')
    ) {
      addIssue(
        issues,
        '$.causation_id',
        'missing_required_field',
        `derived event ${runtimeType} requires causation_id`,
      );
    }
  }

  return {
    ok: issues.length === 0,
    ...(issues.length === 0 ? { event: value as JournalEventEnvelope } : {}),
    issues: issues.sort(compareIssues),
  };
}

export function formatJournalEventSchemaValidationErrors(
  issues: readonly JournalEventSchemaIssue[],
): string {
  return `journal event schema validation failed: ${issues
    .map((issue) => `${issue.path} ${issue.message}`)
    .join('; ')}`;
}

function validateSourceTimestampPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): Record<string, unknown> | undefined {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) {
    return undefined;
  }

  requireTimestamp(record.exchange_event_ts_ns, `${path}.exchange_event_ts_ns`, issues);
  requireTimestamp(record.sidecar_recv_ts_ns, `${path}.sidecar_recv_ts_ns`, issues);
  optionalTimestamp(record.rithmic_publish_ts_ns, `${path}.rithmic_publish_ts_ns`, issues);
  return record;
}

function validateQuotePayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = validateSourceTimestampPayload(payload, issues, path);
  if (record === undefined) return;
  requireNumber(record.bid_px, `${path}.bid_px`, issues);
  requireNumber(record.bid_qty, `${path}.bid_qty`, issues);
  requireNumber(record.ask_px, `${path}.ask_px`, issues);
  requireNumber(record.ask_qty, `${path}.ask_qty`, issues);
  optionalEnum(record.authority, `${path}.authority`, issues, [
    'unknown',
    'warming',
    'authoritative',
    'stale',
    'gap',
  ]);
}

function validateTradePayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = validateSourceTimestampPayload(payload, issues, path);
  if (record === undefined) return;
  optionalNonEmptyString(record.trade_id, `${path}.trade_id`, issues);
  requireNumber(record.price, `${path}.price`, issues);
  requireNumber(record.quantity, `${path}.quantity`, issues);
  requireEnum(record.aggressor_side, `${path}.aggressor_side`, issues, [
    'buy',
    'sell',
    'unknown',
  ]);
}

function validateBarClosePayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = validateSourceTimestampPayload(payload, issues, path);
  if (record === undefined) return;
  requireEnum(record.timeframe, `${path}.timeframe`, issues, ['1m', '5m', '15m', '60m', '1d']);
  requireTimestamp(record.start_ts_ns, `${path}.start_ts_ns`, issues);
  requireTimestamp(record.end_ts_ns, `${path}.end_ts_ns`, issues);
  for (const field of ['open', 'high', 'low', 'close', 'volume'] as const) {
    requireNumber(record[field], `${path}.${field}`, issues);
  }
  optionalNumber(record.trade_count, `${path}.trade_count`, issues);
}

function validateMicrostructurePayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = validateSourceTimestampPayload(payload, issues, path);
  if (record === undefined) return;
  requireNonEmptyString(record.feature_snapshot_id, `${path}.feature_snapshot_id`, issues);
  requireEnum(record.l3_authority, `${path}.l3_authority`, issues, [
    'unavailable',
    'warming',
    'authoritative',
    'stale',
  ]);
  requireScalarMap(record.values, `${path}.values`, issues);
  optionalScalarMap(record.diagnostic_values, `${path}.diagnostic_values`, issues);
  optionalScalarMap(record.shadow_values, `${path}.shadow_values`, issues);
  optionalBoolean(record.decision_use, `${path}.decision_use`, issues);
  optionalFeatureAvailabilityMask(record.feature_availability_mask, `${path}.feature_availability_mask`, issues);
}

function validateBookRebuildPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = validateSourceTimestampPayload(payload, issues, path);
  if (record === undefined) return;
  requireEnum(record.authority, `${path}.authority`, issues, [
    'unknown',
    'warming',
    'authoritative',
    'stale',
    'gap',
  ]);
  requireNonEmptyString(record.reason, `${path}.reason`, issues);
  requireBoolean(record.warmup_complete, `${path}.warmup_complete`, issues);
}

function validateConnectionPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireEnum(record.state, `${path}.state`, issues, [
    'connecting',
    'connected',
    'disconnected',
    'reconnecting',
    'failed',
  ]);
  optionalNonEmptyString(record.detail, `${path}.detail`, issues);
}

function validateFeedPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireEnum(record.state, `${path}.state`, issues, ['warming', 'live', 'stale', 'gap', 'closed']);
  optionalNonEmptyString(record.stream, `${path}.stream`, issues);
  optionalNonEmptyString(record.detail, `${path}.detail`, issues);
}

function validateGapPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.gap_id, `${path}.gap_id`, issues);
  requireNonEmptyString(record.stream, `${path}.stream`, issues);
  requireTimestamp(record.start_ts_ns, `${path}.start_ts_ns`, issues);
  requireTimestamp(record.end_ts_ns, `${path}.end_ts_ns`, issues);
  optionalNumber(record.observed_count, `${path}.observed_count`, issues);
  optionalNonEmptyString(record.detail, `${path}.detail`, issues);
}

function validateSessionPhasePayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireEnum(record.phase, `${path}.phase`, issues, [
    'pre_open',
    'eth',
    'rth',
    'maintenance',
    'closed',
    'halted',
  ]);
  requireNonEmptyString(record.trading_date, `${path}.trading_date`, issues);
  optionalEnum(record.previous_phase, `${path}.previous_phase`, issues, [
    'pre_open',
    'eth',
    'rth',
    'maintenance',
    'closed',
    'halted',
  ]);
  optionalEnum(record.session_phase, `${path}.session_phase`, issues, [
    'rth',
    'eth',
    'maintenance',
    'closed',
  ]);
  optionalEnum(record.previous_session_phase, `${path}.previous_session_phase`, issues, [
    'rth',
    'eth',
    'maintenance',
    'closed',
  ]);
  optionalNonEmptyString(record.active_contract, `${path}.active_contract`, issues);
  optionalNonEmptyString(record.next_contract, `${path}.next_contract`, issues);
  optionalEnum(record.roll_phase, `${path}.roll_phase`, issues, [
    'normal',
    'pre_roll',
    'roll_block',
    'post_roll',
  ]);
  optionalBoolean(record.candidate_eligible, `${path}.candidate_eligible`, issues);
  optionalNonEmptyString(record.block_reason, `${path}.block_reason`, issues);
  optionalBoolean(record.should_flatten, `${path}.should_flatten`, issues);
}

function validateRollAdvisoryPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireEnum(record.advisory, `${path}.advisory`, issues, [
    'roll_window',
    'block_new_entries',
    'flatten_required',
    'roll_complete',
  ]);
  requireNonEmptyString(record.active_symbol, `${path}.active_symbol`, issues);
  requireNonEmptyString(record.next_symbol, `${path}.next_symbol`, issues);
  optionalEnum(record.roll_phase, `${path}.roll_phase`, issues, [
    'normal',
    'pre_roll',
    'roll_block',
    'post_roll',
  ]);
  optionalEnum(record.previous_roll_phase, `${path}.previous_roll_phase`, issues, [
    'normal',
    'pre_roll',
    'roll_block',
    'post_roll',
  ]);
  optionalBoolean(record.candidate_eligible, `${path}.candidate_eligible`, issues);
  optionalNonEmptyString(record.block_reason, `${path}.block_reason`, issues);
  optionalBoolean(record.should_flatten, `${path}.should_flatten`, issues);
  optionalNumber(record.minutes_to_cutover, `${path}.minutes_to_cutover`, issues);
}

function validateHaltPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireEnum(record.state, `${path}.state`, issues, ['halted', 'resumed']);
  optionalNonEmptyString(record.reason, `${path}.reason`, issues);
  optionalBoolean(record.resolved, `${path}.resolved`, issues);
}

function validateSessionManifestPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.mask_id, `${path}.mask_id`, issues);
  requireNumber(record.mask_version, `${path}.mask_version`, issues);
  requireNonEmptyString(record.mask_hash, `${path}.mask_hash`, issues);
  requireScalarMap(record.reconnect_policy_config, `${path}.reconnect_policy_config`, issues);
  requireEnum(record.plant_scope, `${path}.plant_scope`, issues, ['ORDER_PLANT']);
  requireEnum(record.mode, `${path}.mode`, issues, ['paper', 'live']);
  requireEnum(record.timestamp_anchor, `${path}.timestamp_anchor`, issues, [
    'broker_exchange_ts_ns',
    'local_monotonic_unix_anchor',
    'dual',
  ]);
  requireNonEmptyString(record.broker_session_id, `${path}.broker_session_id`, issues);
  requireEnum(record.adapter_kind, `${path}.adapter_kind`, issues, [
    'MOCK_ORDER_PLANT',
    'PYTHON_RITHMIC_ORDER_PLANT',
  ]);
  optionalEnum(record.market_data_source, `${path}.market_data_source`, issues, [
    'simulation',
    'live_rithmic_ticker_plant',
    'local_obs_replay',
  ]);
  optionalLiveAccountAllowlistSummary(
    record.live_account_allowlist_summary,
    `${path}.live_account_allowlist_summary`,
    issues,
  );
  optionalEnum(record.session_phase, `${path}.session_phase`, issues, [
    'starting',
    'closing',
    'reconnect_success',
    'reconnect_exhausted',
  ]);
  optionalNumber(record.session_duration_ms, `${path}.session_duration_ms`, issues);
  optionalNumber(record.final_quarantine_count, `${path}.final_quarantine_count`, issues);
  optionalNumber(record.intents_emitted_total, `${path}.intents_emitted_total`, issues);
  optionalNumber(record.acks_received_total, `${path}.acks_received_total`, issues);
  optionalNumber(record.would_halt_emissions_total, `${path}.would_halt_emissions_total`, issues);
}

function optionalLiveAccountAllowlistSummary(
  value: unknown,
  path: string,
  issues: JournalEventSchemaIssue[],
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    addIssue(issues, path, 'invalid_field_type', 'must be an array');
    return;
  }
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const record = requireRecord(entry, entryPath, issues);
    if (record === undefined) return;
    requireNonEmptyString(record.label, `${entryPath}.label`, issues);
    requireNonEmptyString(record.fcm_id, `${entryPath}.fcm_id`, issues);
    requireNonEmptyString(record.ib_id, `${entryPath}.ib_id`, issues);
    requireNonEmptyString(record.account_id_redacted, `${entryPath}.account_id_redacted`, issues);
    requireNumber(record.max_position_contracts, `${entryPath}.max_position_contracts`, issues);
    requireNumber(record.daily_loss_cap_usd, `${entryPath}.daily_loss_cap_usd`, issues);
  });
}

function validateReconnectStatePayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  optionalEnum(record.previous_state, `${path}.previous_state`, issues, [
    'DISCONNECTED',
    'CONNECTING',
    'CONNECTED',
    'RECONNECTING',
    'RECOVERING',
    'FAILED',
  ]);
  requireEnum(record.state, `${path}.state`, issues, [
    'DISCONNECTED',
    'CONNECTING',
    'CONNECTED',
    'RECONNECTING',
    'RECOVERING',
    'FAILED',
  ]);
  requireEnum(record.phase, `${path}.phase`, issues, [
    'disconnect',
    'attempt',
    'backoff',
    'success',
    'exhausted',
  ]);
  optionalNumber(record.attempt, `${path}.attempt`, issues);
  requireNumber(record.max_attempts, `${path}.max_attempts`, issues);
  optionalNumber(record.backoff_ms, `${path}.backoff_ms`, issues);
  optionalNumber(record.jitter_ms, `${path}.jitter_ms`, issues);
  optionalNumber(record.next_attempt_delay_ms, `${path}.next_attempt_delay_ms`, issues);
  optionalNonEmptyString(record.reason, `${path}.reason`, issues);
  requireScalarMap(record.retry_budget_config, `${path}.retry_budget_config`, issues);
  optionalBoolean(record.terminal, `${path}.terminal`, issues);
  optionalBoolean(record.blocked_submission_gate, `${path}.blocked_submission_gate`, issues);
}

function validateLivenessStatePayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireEnum(record.process_state, `${path}.process_state`, issues, [
    'live',
    'degraded',
    'dead',
  ]);
  requireEnum(record.broker_state, `${path}.broker_state`, issues, [
    'live',
    'degraded',
    'dead',
  ]);
  requireEnum(record.overall_state, `${path}.overall_state`, issues, ['live', 'degraded', 'dead']);
  requireBoolean(record.kill_switch_engaged, `${path}.kill_switch_engaged`, issues);
  optionalNumber(record.process_event_loop_lag_p95_ms, `${path}.process_event_loop_lag_p95_ms`, issues);
  optionalNumber(record.broker_last_heartbeat_age_ms, `${path}.broker_last_heartbeat_age_ms`, issues);
  optionalNonEmptyString(record.reason, `${path}.reason`, issues);
}

function validateKillSwitchEngagedPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireEnum(record.state, `${path}.state`, issues, ['engaged']);
  requireNonEmptyString(record.reason, `${path}.reason`, issues);
  requireNonEmptyString(record.source, `${path}.source`, issues);
  requireTimestamp(record.engaged_at_ts_ns, `${path}.engaged_at_ts_ns`, issues);
  requireBoolean(record.persistence_enabled, `${path}.persistence_enabled`, issues);
  optionalBoolean(record.restart_reengage, `${path}.restart_reengage`, issues);
}

function validateKillSwitchDisengagedPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireEnum(record.state, `${path}.state`, issues, ['disengaged']);
  requireNonEmptyString(record.reason, `${path}.reason`, issues);
  requireNonEmptyString(record.source, `${path}.source`, issues);
  requireTimestamp(record.disengaged_at_ts_ns, `${path}.disengaged_at_ts_ns`, issues);
  requireNonEmptyString(record.token_id, `${path}.token_id`, issues);
  requireBoolean(record.persistence_enabled, `${path}.persistence_enabled`, issues);
}

function validateAnomalyDetectedPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireEnum(record.rule_id, `${path}.rule_id`, issues, [
    'rapid_quarantine_accumulation',
    'auth_reject_burst',
    'heartbeat_skew',
    'reconnect_storm',
  ]);
  requireEnum(record.severity, `${path}.severity`, issues, ['low', 'medium', 'high']);
  requireTimestamp(record.triggered_ts_ns, `${path}.triggered_ts_ns`, issues);
  requireNonEmptyString(record.evidence_summary, `${path}.evidence_summary`, issues);
  requireEnum(record.auto_action, `${path}.auto_action`, issues, [
    'kill_switch_engaged',
    'alert_only',
  ]);
}

function validateValidatorIssuePayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireEnum(record.validator_id, `${path}.validator_id`, issues, VALIDATOR_IDS);
  requireEnum(record.severity, `${path}.severity`, issues, VALIDATOR_SEVERITIES);
  requireTimestamp(record.emitted_ts_ns, `${path}.emitted_ts_ns`, issues);
  requireNonEmptyString(record.code, `${path}.code`, issues);
  requireNonEmptyString(record.message, `${path}.message`, issues);
  optionalNonEmptyString(record.source_event_id, `${path}.source_event_id`, issues);
  optionalNonEmptyString(record.session_family_id, `${path}.session_family_id`, issues);
  if (record.source_event_type !== undefined) {
    if (typeof record.source_event_type !== 'string' || !isRuntimeEventType(record.source_event_type)) {
      addIssue(
        issues,
        `${path}.source_event_type`,
        'invalid_field_value',
        `unsupported runtime event type: ${String(record.source_event_type)}`,
      );
    }
  }
  optionalScalarMap(record.details, `${path}.details`, issues);
}

function validateSecretResolutionPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.key, `${path}.key`, issues);
  requireEnum(record.backend, `${path}.backend`, issues, ['env_var', 'vault']);
  requireTimestamp(record.resolved_at_ts_ns, `${path}.resolved_at_ts_ns`, issues);
  requireEnum(record.mode, `${path}.mode`, issues, ['paper', 'live']);
  requireBoolean(record.cached, `${path}.cached`, issues);
}

function validateConfigPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.config_hash, `${path}.config_hash`, issues);
  requireNumber(record.config_version, `${path}.config_version`, issues);
}

function validateBacktestRunMetaPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;

  // Envelope fields must NOT appear in the payload — they are owned by
  // JournalEventEnvelope. Detect violations early so misuse surfaces in
  // schema validation rather than as silent duplication on the wire.
  for (const envelopeField of [
    'event_id',
    'type',
    'ts_ns',
    'run_id',
    'session_id',
    'schema_version',
  ] as const) {
    if (envelopeField in record) {
      addIssue(
        issues,
        `${path}.${envelopeField}`,
        'invalid_field_value',
        `BACKTEST_RUN_META payload must not duplicate envelope field "${envelopeField}"`,
      );
    }
  }

  // RunSpec-derived shape (light shape check; deep invariants are enforced
  // by validateRunSpec at construction time, not at journal-schema time).
  if (record.run_spec_schema_version !== 1) {
    addIssue(
      issues,
      `${path}.run_spec_schema_version`,
      'invalid_field_value',
      'must be 1',
    );
  }
  if (record.instrument_root !== 'MNQ') {
    addIssue(
      issues,
      `${path}.instrument_root`,
      'invalid_field_value',
      'must be "MNQ"',
    );
  }
  requireNonEmptyString(record.bar_spec, `${path}.bar_spec`, issues);
  requireRecord(record.backtest_window, `${path}.backtest_window`, issues);
  requireNumber(record.determinism_seed, `${path}.determinism_seed`, issues);
  if (!Array.isArray(record.strategy_ids)) {
    addIssue(
      issues,
      `${path}.strategy_ids`,
      'invalid_field_type',
      'must be an array',
    );
  }
  if (!Array.isArray(record.corpus_inputs)) {
    addIssue(
      issues,
      `${path}.corpus_inputs`,
      'invalid_field_type',
      'must be an array',
    );
  }
  if (!Array.isArray(record.config_inputs)) {
    addIssue(
      issues,
      `${path}.config_inputs`,
      'invalid_field_type',
      'must be an array',
    );
  }
  requireNonEmptyString(
    record.runner_code_commit_sha,
    `${path}.runner_code_commit_sha`,
    issues,
  );
  if (typeof record.runner_code_dirty !== 'boolean') {
    addIssue(
      issues,
      `${path}.runner_code_dirty`,
      'invalid_field_type',
      'must be a boolean',
    );
  }

  // Payload-only fields outside RunSpec.
  requireNonEmptyString(record.run_spec_hash, `${path}.run_spec_hash`, issues);
  requireTimestamp(record.run_started_at_ns, `${path}.run_started_at_ns`, issues);
}

function validateFeaturesPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.feature_snapshot_id, `${path}.feature_snapshot_id`, issues);
  optionalNonEmptyString(record.source_event_id, `${path}.source_event_id`, issues);
  requireScalarMap(record.values, `${path}.values`, issues);
  optionalScalarMap(record.diagnostic_values, `${path}.diagnostic_values`, issues);
  optionalScalarMap(record.shadow_values, `${path}.shadow_values`, issues);
  optionalBoolean(record.decision_use, `${path}.decision_use`, issues);
  optionalFeatureAvailabilityMask(record.feature_availability_mask, `${path}.feature_availability_mask`, issues);
}

function validateStructurePayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.feature_snapshot_id, `${path}.feature_snapshot_id`, issues);
  requireEnum(record.trend, `${path}.trend`, issues, ['up', 'down', 'range', 'unknown']);
  requireScalarMap(record.values, `${path}.values`, issues);
}

function validateStrategyEvaluationPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(
    record.strategy_evaluation_id,
    `${path}.strategy_evaluation_id`,
    issues,
  );
  requireEnum(record.strategy_id, `${path}.strategy_id`, issues, STRATEGY_IDS);
  requireNonEmptyString(record.feature_snapshot_id, `${path}.feature_snapshot_id`, issues);
  requireEnum(record.gate_state, `${path}.gate_state`, issues, ['armed', 'waiting', 'blocked']);
  optionalNumber(record.score, `${path}.score`, issues);
  requireStringArray(record.reasons, `${path}.reasons`, issues);
  optionalNonEmptyString(record.strategy_config_hash, `${path}.strategy_config_hash`, issues);
}

function validateCandidatePayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.candidate_id, `${path}.candidate_id`, issues);
  requireEnum(record.strategy_id, `${path}.strategy_id`, issues, STRATEGY_IDS);
  requireNonEmptyString(record.feature_snapshot_id, `${path}.feature_snapshot_id`, issues);
  requireEnum(record.direction, `${path}.direction`, issues, ['long', 'short']);
  requireEnum(record.status, `${path}.status`, issues, [
    'proposed',
    'risk_rejected',
    'sized',
    'expired',
  ]);
  requireNumber(record.entry_price, `${path}.entry_price`, issues);
  requireNumber(record.stop_price, `${path}.stop_price`, issues);
  requireTargetArray(record.targets, `${path}.targets`, issues);
  requireNumber(record.confidence, `${path}.confidence`, issues);
  requireStringArray(record.reasons, `${path}.reasons`, issues);
  optionalNonEmptyString(record.strategy_config_hash, `${path}.strategy_config_hash`, issues);
}

function validateMlUpliftPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.feature_snapshot_id, `${path}.feature_snapshot_id`, issues);
  requireNonEmptyString(record.model_id, `${path}.model_id`, issues);
  requireNumber(record.score, `${path}.score`, issues);
  requireBoolean(record.enabled, `${path}.enabled`, issues);
}

function validateRankPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireStringArray(record.ranked_candidate_ids, `${path}.ranked_candidate_ids`, issues);
  requireNonEmptyString(record.method, `${path}.method`, issues);
  optionalNonEmptyString(record.strategy_config_hash, `${path}.strategy_config_hash`, issues);
}

function validateRiskGatePayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.risk_gate_decision_id, `${path}.risk_gate_decision_id`, issues);
  requireNonEmptyString(record.candidate_id, `${path}.candidate_id`, issues);
  requireEnum(record.status, `${path}.status`, issues, ['pass', 'reject']);
  requireStringArray(record.reasons, `${path}.reasons`, issues);
  optionalNonEmptyString(record.risk_manager_version, `${path}.risk_manager_version`, issues);
  optionalNonEmptyString(record.strategy_config_hash, `${path}.strategy_config_hash`, issues);
  optionalNonEmptyString(record.risk_policy_hash, `${path}.risk_policy_hash`, issues);
  optionalNonEmptyString(record.risk_config_hash, `${path}.risk_config_hash`, issues);
  optionalSessionRiskState(record.session_risk, `${path}.session_risk`, issues);
}

function optionalSessionRiskState(
  value: unknown,
  path: string,
  issues: JournalEventSchemaIssue[],
): void {
  if (value === undefined) {
    return;
  }
  const record = requireRecord(value, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.session_id, `${path}.session_id`, issues);
  requireNonEmptyString(record.account_ref, `${path}.account_ref`, issues);
  requireNonEmptyString(record.symbol, `${path}.symbol`, issues);
  requireNumber(record.realized_pnl_usd, `${path}.realized_pnl_usd`, issues);
  requireNumber(record.open_trade_count, `${path}.open_trade_count`, issues);
  requireNumber(record.closed_trade_count, `${path}.closed_trade_count`, issues);
  requireNumber(record.rejected_trade_count, `${path}.rejected_trade_count`, issues);
  requireEnum(record.circuit_breaker_state, `${path}.circuit_breaker_state`, issues, [
    'inactive',
    'active',
  ]);
  optionalNonEmptyString(record.circuit_breaker_reason, `${path}.circuit_breaker_reason`, issues);
  requireTimestamp(record.last_transition_ts_ns, `${path}.last_transition_ts_ns`, issues);
}

function validateSizingPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.sizing_decision_id, `${path}.sizing_decision_id`, issues);
  requireNonEmptyString(record.candidate_id, `${path}.candidate_id`, issues);
  requireNumber(record.quantity, `${path}.quantity`, issues);
  requireNumber(record.risk_usd, `${path}.risk_usd`, issues);
  requireNumber(record.risk_points, `${path}.risk_points`, issues);
  optionalNonEmptyString(record.rejected_reason, `${path}.rejected_reason`, issues);
  optionalNonEmptyString(record.strategy_config_hash, `${path}.strategy_config_hash`, issues);
  optionalNonEmptyString(record.risk_config_hash, `${path}.risk_config_hash`, issues);
  optionalNonEmptyString(record.risk_manager_version, `${path}.risk_manager_version`, issues);
}

function validateOrderIntentPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.order_intent_id, `${path}.order_intent_id`, issues);
  requireNonEmptyString(record.candidate_id, `${path}.candidate_id`, issues);
  requireNonEmptyString(record.sizing_decision_id, `${path}.sizing_decision_id`, issues);
  requireEnum(record.side, `${path}.side`, issues, ['buy', 'sell']);
  requireEnum(record.order_type, `${path}.order_type`, issues, [
    'market',
    'limit',
    'limit_post_only',
    'stop_market',
  ]);
  requireNumber(record.quantity, `${path}.quantity`, issues);
  optionalNumber(record.limit_price, `${path}.limit_price`, issues);
  optionalNumber(record.stop_price, `${path}.stop_price`, issues);
  requireEnum(record.time_in_force, `${path}.time_in_force`, issues, ['ioc', 'day', 'gtc']);
  optionalNonEmptyString(record.account_id, `${path}.account_id`, issues);
  optionalNonEmptyString(record.strategy_config_hash, `${path}.strategy_config_hash`, issues);
  optionalNonEmptyString(record.management_action_id, `${path}.management_action_id`, issues);
  optionalNonEmptyString(record.position_id, `${path}.position_id`, issues);
  optionalNonEmptyString(record.management_profile_hash, `${path}.management_profile_hash`, issues);
  optionalNonEmptyString(record.management_profile_id, `${path}.management_profile_id`, issues);
  optionalNumber(record.management_profile_version, `${path}.management_profile_version`, issues);
  optionalNonEmptyString(record.position_manager_version, `${path}.position_manager_version`, issues);
}

function validateOrderAckSubmissionPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.intent_id, `${path}.intent_id`, issues);
  requireNonEmptyString(record.submission_ack_id, `${path}.submission_ack_id`, issues);
  requireNonEmptyString(record.broker_order_id, `${path}.broker_order_id`, issues);
  requireNonEmptyString(record.broker_account_id, `${path}.broker_account_id`, issues);
  requireNonEmptyString(record.instrument_symbol, `${path}.instrument_symbol`, issues);
}

function validateOrderAckFillPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.intent_id, `${path}.intent_id`, issues);
  requireNonEmptyString(record.submission_ack_id, `${path}.submission_ack_id`, issues);
  requireNonEmptyString(record.fill_ack_id, `${path}.fill_ack_id`, issues);
  requireNonEmptyString(record.broker_order_id, `${path}.broker_order_id`, issues);
  requireNonEmptyString(record.broker_account_id, `${path}.broker_account_id`, issues);
  requireNonEmptyString(record.instrument_symbol, `${path}.instrument_symbol`, issues);
  requireNumber(record.fill_qty, `${path}.fill_qty`, issues);
  requireNumber(record.fill_price, `${path}.fill_price`, issues);
  requireEnum(record.fill_kind, `${path}.fill_kind`, issues, ['PARTIAL', 'FULL']);
}

function validateOrderAckCancelPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.intent_id, `${path}.intent_id`, issues);
  requireNonEmptyString(record.submission_ack_id, `${path}.submission_ack_id`, issues);
  requireNonEmptyString(record.cancel_ack_id, `${path}.cancel_ack_id`, issues);
  requireNonEmptyString(record.broker_order_id, `${path}.broker_order_id`, issues);
  requireNonEmptyString(record.broker_account_id, `${path}.broker_account_id`, issues);
  requireEnum(record.cancel_reason, `${path}.cancel_reason`, issues, [
    'CLIENT_REQUESTED',
    'BROKER_INITIATED',
    'EXCHANGE_INITIATED',
    'UNKNOWN',
  ]);
}

function validateOrderBrokerRejectPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.intent_id, `${path}.intent_id`, issues);
  optionalNonEmptyString(record.broker_order_id, `${path}.broker_order_id`, issues);
  requireNonEmptyString(record.broker_account_id, `${path}.broker_account_id`, issues);
  requireNonEmptyString(record.reject_reason_code, `${path}.reject_reason_code`, issues);
  optionalNonEmptyString(record.reject_subreason, `${path}.reject_subreason`, issues);
  requireNonEmptyString(record.reject_message_redacted, `${path}.reject_message_redacted`, issues);
}

function validateOrderQuarantineEnteredPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.intent_id, `${path}.intent_id`, issues);
  requireEnum(record.previous_state, `${path}.previous_state`, issues, [
    'pending_ack',
    'acked_resting',
    'partial_fill',
  ]);
  requireEnum(record.quarantine_reason, `${path}.quarantine_reason`, issues, [
    'submission_ack_timeout',
    'cancel_ack_timeout',
  ]);
  requireNumber(record.open_quarantine_count, `${path}.open_quarantine_count`, issues);
  optionalNumber(record.timeout_ms, `${path}.timeout_ms`, issues);
  optionalNumber(record.cancel_attempt_count, `${path}.cancel_attempt_count`, issues);
  optionalNumber(record.max_cancel_attempts, `${path}.max_cancel_attempts`, issues);
  optionalBoolean(record.escalation_required, `${path}.escalation_required`, issues);
  optionalBoolean(record.is_provisional, `${path}.is_provisional`, issues);
  optionalNonEmptyString(record.broker_order_id, `${path}.broker_order_id`, issues);
  optionalNonEmptyString(record.broker_account_id, `${path}.broker_account_id`, issues);
  optionalNonEmptyString(record.instrument_symbol, `${path}.instrument_symbol`, issues);
}

function validateOrderQuarantineClearedPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireEnum(record.clear_reason, `${path}.clear_reason`, issues, [
    'all_quarantines_resolved',
    'operator_close',
  ]);
  requireNumber(record.open_quarantine_count, `${path}.open_quarantine_count`, issues);
  if (record.open_quarantine_count !== 0) {
    addIssue(
      issues,
      `${path}.open_quarantine_count`,
      'invalid_field_value',
      'must be 0',
    );
  }
  requireStringArray(record.resolved_intent_ids, `${path}.resolved_intent_ids`, issues);
}

function validateSimFillPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.fill_id, `${path}.fill_id`, issues);
  requireNonEmptyString(record.order_intent_id, `${path}.order_intent_id`, issues);
  requireEnum(record.side, `${path}.side`, issues, ['buy', 'sell']);
  requireNumber(record.quantity, `${path}.quantity`, issues);
  requireNumber(record.price, `${path}.price`, issues);
  requireEnum(record.liquidity, `${path}.liquidity`, issues, ['maker', 'taker']);
  optionalNumber(record.slippage_points, `${path}.slippage_points`, issues);
  optionalNumber(record.exchange_fee_usd, `${path}.exchange_fee_usd`, issues);
  optionalNumber(record.commission_usd, `${path}.commission_usd`, issues);
  optionalNonEmptyString(record.execution_model_version, `${path}.execution_model_version`, issues);
  optionalEnum(record.fill_model, `${path}.fill_model`, issues, [
    'bbo_market_taker',
    'queue_aware_limit_post_only',
  ]);
  optionalEnum(record.input_tier, `${path}.input_tier`, issues, [
    'authoritative',
    'subscope',
    'diagnostic_only',
    'blocked',
  ]);
  optionalNumber(record.fill_probability, `${path}.fill_probability`, issues);
  optionalNumber(record.time_to_fill_estimate_ms, `${path}.time_to_fill_estimate_ms`, issues);
  optionalNumber(record.queue_position_estimate, `${path}.queue_position_estimate`, issues);
  optionalNumber(record.queue_ahead_size_estimate, `${path}.queue_ahead_size_estimate`, issues);
  optionalNumber(record.queue_ahead_order_count_estimate, `${path}.queue_ahead_order_count_estimate`, issues);
  optionalNumber(record.queue_consumed_size, `${path}.queue_consumed_size`, issues);
  optionalNonEmptyString(record.partial_fill_reason, `${path}.partial_fill_reason`, issues);
  optionalNumber(record.adverse_tick_draw, `${path}.adverse_tick_draw`, issues);
  optionalNumber(record.adverse_ticks, `${path}.adverse_ticks`, issues);
  optionalNonEmptyString(record.calibration_status, `${path}.calibration_status`, issues);
  optionalNonEmptyString(record.strategy_config_hash, `${path}.strategy_config_hash`, issues);
  optionalNonEmptyString(record.management_action_id, `${path}.management_action_id`, issues);
  optionalNonEmptyString(record.position_id, `${path}.position_id`, issues);
  optionalNonEmptyString(record.management_profile_hash, `${path}.management_profile_hash`, issues);
  optionalNonEmptyString(record.management_profile_id, `${path}.management_profile_id`, issues);
  optionalNumber(record.management_profile_version, `${path}.management_profile_version`, issues);
  optionalNonEmptyString(record.position_manager_version, `${path}.position_manager_version`, issues);
}

function validateExecutionRejectPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.execution_reject_id, `${path}.execution_reject_id`, issues);
  requireNonEmptyString(record.order_intent_id, `${path}.order_intent_id`, issues);
  requireNonEmptyString(record.candidate_id, `${path}.candidate_id`, issues);
  requireNonEmptyString(record.sizing_decision_id, `${path}.sizing_decision_id`, issues);
  requireEnum(record.status, `${path}.status`, issues, ['rejected', 'cancelled']);
  requireNonEmptyString(record.reason, `${path}.reason`, issues);
  requireEnum(record.execution_adapter, `${path}.execution_adapter`, issues, ['simulated']);
  requireNonEmptyString(record.execution_version, `${path}.execution_version`, issues);
  optionalNonEmptyString(record.strategy_config_hash, `${path}.strategy_config_hash`, issues);
  optionalNonEmptyString(record.management_action_id, `${path}.management_action_id`, issues);
  optionalNonEmptyString(record.position_id, `${path}.position_id`, issues);
  optionalNonEmptyString(record.management_profile_hash, `${path}.management_profile_hash`, issues);
  optionalNonEmptyString(record.management_profile_id, `${path}.management_profile_id`, issues);
  optionalNumber(record.management_profile_version, `${path}.management_profile_version`, issues);
  optionalNonEmptyString(record.position_manager_version, `${path}.position_manager_version`, issues);
}

function validatePositionPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.position_id, `${path}.position_id`, issues);
  requireNonEmptyString(record.candidate_id, `${path}.candidate_id`, issues);
  requireEnum(record.side, `${path}.side`, issues, ['long', 'short', 'flat']);
  requireEnum(record.status, `${path}.status`, issues, ['open', 'closing', 'closed']);
  requireNumber(record.quantity_open, `${path}.quantity_open`, issues);
  requireNumber(record.avg_entry_price, `${path}.avg_entry_price`, issues);
  requireTimestamp(record.updated_ts_ns, `${path}.updated_ts_ns`, issues);
  optionalNonEmptyString(record.strategy_config_hash, `${path}.strategy_config_hash`, issues);
  optionalNonEmptyString(record.management_profile_hash, `${path}.management_profile_hash`, issues);
  optionalNonEmptyString(record.management_profile_id, `${path}.management_profile_id`, issues);
  optionalNumber(record.management_profile_version, `${path}.management_profile_version`, issues);
}

function validateManagementTickPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.position_id, `${path}.position_id`, issues);
  requireNumber(record.mark_price, `${path}.mark_price`, issues);
  requireNumber(record.unrealized_pnl_usd, `${path}.unrealized_pnl_usd`, issues);
  optionalNonEmptyString(record.strategy_config_hash, `${path}.strategy_config_hash`, issues);
  optionalNonEmptyString(record.management_profile_hash, `${path}.management_profile_hash`, issues);
  optionalNonEmptyString(record.management_profile_id, `${path}.management_profile_id`, issues);
  optionalNumber(record.management_profile_version, `${path}.management_profile_version`, issues);
  optionalNonEmptyString(record.position_manager_version, `${path}.position_manager_version`, issues);
}

function validateManagementActionPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.management_action_id, `${path}.management_action_id`, issues);
  requireNonEmptyString(record.position_id, `${path}.position_id`, issues);
  requireEnum(record.action_type, `${path}.action_type`, issues, [
    'HOLD',
    'MOVE_STOP',
    'TAKE_PARTIAL',
    'TAKE_PROFIT',
    'EXIT_FULL',
    'MARK_BREAKEVEN',
    'ACTIVATE_TRAIL',
    'FAIL_SAFE_EXIT',
    'TIME_STOP_EXIT',
    'move_stop',
    'take_partial',
    'close_position',
    'activate_trailing',
    'time_stop',
    'fail_safe',
    'no_op',
  ]);
  requireNonEmptyString(record.reason, `${path}.reason`, issues);
  optionalNumber(record.new_stop_price, `${path}.new_stop_price`, issues);
  optionalNumber(record.exit_quantity, `${path}.exit_quantity`, issues);
  optionalEnum(record.target_label, `${path}.target_label`, issues, ['pt1', 'pt2', 'runner']);
  optionalNumber(record.exit_price, `${path}.exit_price`, issues);
  optionalNumber(record.realized_pnl_usd, `${path}.realized_pnl_usd`, issues);
  optionalNumber(record.realized_r, `${path}.realized_r`, issues);
  optionalNonEmptyString(record.strategy_config_hash, `${path}.strategy_config_hash`, issues);
  optionalNonEmptyString(record.management_profile_hash, `${path}.management_profile_hash`, issues);
  optionalNonEmptyString(record.management_profile_id, `${path}.management_profile_id`, issues);
  optionalNumber(record.management_profile_version, `${path}.management_profile_version`, issues);
  optionalNonEmptyString(record.position_manager_version, `${path}.position_manager_version`, issues);
  optionalNonEmptyString(record.active_contract, `${path}.active_contract`, issues);
  optionalNonEmptyString(record.next_contract, `${path}.next_contract`, issues);
  optionalTimestamp(record.cutover_ts_ns, `${path}.cutover_ts_ns`, issues);
  optionalEnum(record.roll_phase, `${path}.roll_phase`, issues, [
    'normal',
    'pre_roll',
    'roll_block',
    'post_roll',
  ]);
}

function validateConfigLineageRef(
  value: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(value, path, issues);
  if (record === undefined) return;
  requireNonEmptyString(record.config_hash, `${path}.config_hash`, issues);
  requireNumber(record.config_version, `${path}.config_version`, issues);
}

function requireTargetArray(
  value: unknown,
  path: string,
  issues: JournalEventSchemaIssue[],
): void {
  if (value === undefined) {
    addIssue(issues, path, 'missing_required_field', 'is required');
    return;
  }
  if (!Array.isArray(value)) {
    addIssue(issues, path, 'invalid_field_type', 'must be an array');
    return;
  }

  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = requireRecord(item, itemPath, issues);
    if (record === undefined) return;
    requireEnum(record.label, `${itemPath}.label`, issues, ['pt1', 'pt2', 'runner']);
    requireNumber(record.price, `${itemPath}.price`, issues);
    requireNumber(record.quantity_fraction, `${itemPath}.quantity_fraction`, issues);
  });
}

function requireStringArray(
  value: unknown,
  path: string,
  issues: JournalEventSchemaIssue[],
): void {
  if (value === undefined) {
    addIssue(issues, path, 'missing_required_field', 'is required');
    return;
  }
  if (!Array.isArray(value)) {
    addIssue(issues, path, 'invalid_field_type', 'must be an array');
    return;
  }

  value.forEach((item, index) => {
    requireNonEmptyString(item, `${path}[${index}]`, issues);
  });
}

function requireScalarMap(
  value: unknown,
  path: string,
  issues: JournalEventSchemaIssue[],
): void {
  if (value === undefined) {
    addIssue(issues, path, 'missing_required_field', 'is required');
    return;
  }
  const record = requireRecord(value, path, issues);
  if (record === undefined) return;
  for (const [key, child] of Object.entries(record)) {
    if (
      child === null ||
      typeof child === 'string' ||
      typeof child === 'number' ||
      typeof child === 'boolean'
    ) {
      if (typeof child === 'number' && !Number.isFinite(child)) {
        addIssue(issues, `${path}.${key}`, 'invalid_field_value', 'must be finite');
      }
      continue;
    }
    addIssue(issues, `${path}.${key}`, 'invalid_field_type', 'must be scalar JSON value');
  }
}

function optionalScalarMap(
  value: unknown,
  path: string,
  issues: JournalEventSchemaIssue[],
): void {
  if (value !== undefined) {
    requireScalarMap(value, path, issues);
  }
}

function optionalFeatureAvailabilityMask(
  value: unknown,
  path: string,
  issues: JournalEventSchemaIssue[],
): void {
  if (value === undefined) {
    return;
  }
  const record = requireRecord(value, path, issues);
  if (record === undefined) return;
  requireNumber(record.schema_version, `${path}.schema_version`, issues);
  requireNumber(record.mask_version, `${path}.mask_version`, issues);
  requireNonEmptyString(record.mask_id, `${path}.mask_id`, issues);
  requireNonEmptyString(record.mask_hash, `${path}.mask_hash`, issues);

  const lineage = requireRecord(record.lineage, `${path}.lineage`, issues);
  if (lineage !== undefined) {
    requireNonEmptyString(lineage.adr, `${path}.lineage.adr`, issues);
    requireNonEmptyString(lineage.infra01e, `${path}.lineage.infra01e`, issues);
    requireNonEmptyString(lineage.infra01f, `${path}.lineage.infra01f`, issues);
    requireNonEmptyString(lineage.data01b_full_status, `${path}.lineage.data01b_full_status`, issues);
    requireNonEmptyString(lineage.data01_full_status, `${path}.lineage.data01_full_status`, issues);
  }

  const fieldTiers = requireRecord(record.field_tiers, `${path}.field_tiers`, issues);
  if (fieldTiers !== undefined) {
    for (const [field, tier] of Object.entries(fieldTiers)) {
      requireEnum(tier, `${path}.field_tiers.${field}`, issues, [
        'authoritative',
        'diagnostic_only',
        'shadow_only',
        'advisory_only',
        'blocked',
        'subscope',
        'available',
      ]);
    }
  }
}

function requireRecord(
  value: unknown,
  path: string,
  issues: JournalEventSchemaIssue[],
): Record<string, unknown> | undefined {
  if (value === undefined) {
    addIssue(issues, path, 'missing_required_field', 'is required');
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    addIssue(issues, path, 'invalid_envelope', 'must be a JSON object');
    return undefined;
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(
  value: unknown,
  path: string,
  issues: JournalEventSchemaIssue[],
): void {
  if (value === undefined) {
    addIssue(issues, path, 'missing_required_field', 'is required');
    return;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    addIssue(issues, path, 'invalid_field_type', 'must be a non-empty string');
  }
}

function optionalNonEmptyString(
  value: unknown,
  path: string,
  issues: JournalEventSchemaIssue[],
): void {
  if (value !== undefined) {
    requireNonEmptyString(value, path, issues);
  }
}

function requireNumber(value: unknown, path: string, issues: JournalEventSchemaIssue[]): void {
  if (value === undefined) {
    addIssue(issues, path, 'missing_required_field', 'is required');
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    addIssue(issues, path, 'invalid_field_type', 'must be a finite number');
  }
}

function optionalNumber(value: unknown, path: string, issues: JournalEventSchemaIssue[]): void {
  if (value !== undefined) {
    requireNumber(value, path, issues);
  }
}

function requireBoolean(value: unknown, path: string, issues: JournalEventSchemaIssue[]): void {
  if (value === undefined) {
    addIssue(issues, path, 'missing_required_field', 'is required');
    return;
  }
  if (typeof value !== 'boolean') {
    addIssue(issues, path, 'invalid_field_type', 'must be a boolean');
  }
}

function optionalBoolean(value: unknown, path: string, issues: JournalEventSchemaIssue[]): void {
  if (value !== undefined) {
    requireBoolean(value, path, issues);
  }
}

function requireTimestamp(value: unknown, path: string, issues: JournalEventSchemaIssue[]): void {
  if (value === undefined) {
    addIssue(issues, path, 'missing_required_field', 'is required');
    return;
  }
  if (typeof value !== 'bigint') {
    addIssue(issues, path, 'invalid_field_type', 'must be a revived bigint nanosecond timestamp');
  }
}

function optionalTimestamp(value: unknown, path: string, issues: JournalEventSchemaIssue[]): void {
  if (value !== undefined) {
    requireTimestamp(value, path, issues);
  }
}

function requireEnum<TAllowed extends string>(
  value: unknown,
  path: string,
  issues: JournalEventSchemaIssue[],
  allowed: readonly TAllowed[],
): void {
  if (value === undefined) {
    addIssue(issues, path, 'missing_required_field', 'is required');
    return;
  }
  if (typeof value !== 'string' || !allowed.includes(value as TAllowed)) {
    addIssue(issues, path, 'invalid_field_value', `must be one of: ${allowed.join(', ')}`);
  }
}

function optionalEnum<TAllowed extends string>(
  value: unknown,
  path: string,
  issues: JournalEventSchemaIssue[],
  allowed: readonly TAllowed[],
): void {
  if (value !== undefined) {
    requireEnum(value, path, issues, allowed);
  }
}

function addIssue(
  issues: JournalEventSchemaIssue[],
  path: string,
  code: JournalEventSchemaIssueCode,
  message: string,
): void {
  issues.push({ path, code, message });
}

function compareIssues(left: JournalEventSchemaIssue, right: JournalEventSchemaIssue): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  if (left.code < right.code) return -1;
  if (left.code > right.code) return 1;
  if (left.message < right.message) return -1;
  if (left.message > right.message) return 1;
  return 0;
}
