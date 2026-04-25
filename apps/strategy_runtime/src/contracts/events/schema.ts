import { JOURNAL_EVENT_SCHEMA_VERSION, type JournalEventEnvelope } from './envelope.js';
import {
  categorizeRuntimeEventType,
  isRuntimeEventType,
  type RuntimeEventType,
} from './event-types.js';

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

const STRATEGY_IDS = [
  'trend_pullback_long',
  'trend_pullback_short',
  'breakout_retest_long',
  'breakdown_retest_short',
] as const;

const PAYLOAD_VALIDATORS = {
  CONN: validateConnectionPayload,
  FEED: validateFeedPayload,
  GAP: validateGapPayload,
  BOOK_REBUILD: validateBookRebuildPayload,
  SESSION_PHASE: validateSessionPhasePayload,
  ROLL_ADVISORY: validateRollAdvisoryPayload,
  HALT: validateHaltPayload,
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
  ORDER_INTENT: validateOrderIntentPayload,
  SIM_FILL: validateSimFillPayload,
  POSITION: validatePositionPayload,
  MGMT_TICK: validateManagementTickPayload,
  MGMT_ACTION: validateManagementActionPayload,
  CONFIG: validateConfigPayload,
} as const satisfies Record<RuntimeEventType, Validator>;

export function validateJournalEventEnvelope(value: unknown): JournalEventSchemaValidationResult {
  const issues: JournalEventSchemaIssue[] = [];
  const envelope = requireRecord(value, '$', issues);
  if (envelope === undefined) {
    return { ok: false, issues };
  }

  if (envelope.schema_version !== JOURNAL_EVENT_SCHEMA_VERSION) {
    addIssue(
      issues,
      '$.schema_version',
      'unsupported_schema_version',
      `must be ${JOURNAL_EVENT_SCHEMA_VERSION}`,
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
    'rth',
    'maintenance',
    'closed',
    'halted',
  ]);
  requireNonEmptyString(record.trading_date, `${path}.trading_date`, issues);
}

function validateRollAdvisoryPayload(
  payload: unknown,
  issues: JournalEventSchemaIssue[],
  path: string,
): void {
  const record = requireRecord(payload, path, issues);
  if (record === undefined) return;
  requireEnum(record.advisory, `${path}.advisory`, issues, [
    'block_new_entries',
    'flatten_required',
    'roll_complete',
  ]);
  requireNonEmptyString(record.active_symbol, `${path}.active_symbol`, issues);
  requireNonEmptyString(record.next_symbol, `${path}.next_symbol`, issues);
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
  requireEnum(record.order_type, `${path}.order_type`, issues, ['market', 'limit', 'stop_market']);
  requireNumber(record.quantity, `${path}.quantity`, issues);
  optionalNumber(record.limit_price, `${path}.limit_price`, issues);
  optionalNumber(record.stop_price, `${path}.stop_price`, issues);
  requireEnum(record.time_in_force, `${path}.time_in_force`, issues, ['ioc', 'day', 'gtc']);
  optionalNonEmptyString(record.strategy_config_hash, `${path}.strategy_config_hash`, issues);
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
  optionalNonEmptyString(record.strategy_config_hash, `${path}.strategy_config_hash`, issues);
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
