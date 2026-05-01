import type {
  JournalEventEnvelope,
  RuntimeEventType,
} from '../../../../strategy_runtime/src/contracts/events/index.js';
import {
  FEATURE_AVAILABILITY_MASK,
  isFeatureUseAllowed,
  type FeatureAvailabilityMask,
  type FeatureAvailabilityTier,
  type MboFeatureUseContext,
} from '../../../../strategy_runtime/src/features/availability-mask.js';
import type { OperatorConsoleAlertInput } from '../types/alerts.js';
import type { IngestedJournalEvent, JournalTailResult, QuarantinedJournalLine } from './journal-tail.js';

export type FeaturePolicyViolationKind =
  | 'blocked_field_present'
  | 'restricted_field_in_decision_context'
  | 'restricted_field_in_feature_values'
  | 'invalid_diagnostic_values_partition'
  | 'invalid_shadow_values_partition'
  | 'shadow_or_diagnostic_payload_decision_use'
  | 'mbo_feature_use_denied';

export interface FeaturePolicyViolation {
  readonly kind: FeaturePolicyViolationKind;
  readonly severity: 'warning' | 'critical';
  readonly field?: string;
  readonly canonical_field?: string;
  readonly tier?: FeatureAvailabilityTier | 'unmapped';
  readonly context?: FeatureUseContext | MboFeatureUseContext;
  readonly path?: string;
  readonly reason: string;
}

export interface NormalizedJournalEvent extends IngestedJournalEvent {
  readonly decision_grade: boolean;
  readonly policy_violations: readonly FeaturePolicyViolation[];
}

export interface EventNormalizerOptions {
  readonly mask?: FeatureAvailabilityMask;
  readonly check_missing_terminal_order_intents?: boolean;
}

export interface EventNormalizerResult {
  readonly events: readonly NormalizedJournalEvent[];
  readonly alerts: readonly OperatorConsoleAlertInput[];
  readonly malformed_or_schema_invalid_count: number;
  readonly feature_policy_violation_count: number;
  readonly blocked_feature_policy_violation_count: number;
  readonly missing_terminal_order_intent_count: number;
}

type FeatureUseContext = 'values' | 'diagnostic_values' | 'shadow_values' | 'decision_payload';

const FEATURE_SURFACE_EVENT_TYPES = new Set<RuntimeEventType>(['FEATURES', 'MICROSTRUCTURE']);
const DECISION_EVENT_TYPES = new Set<RuntimeEventType>([
  'STRAT_EVAL',
  'CANDIDATE',
  'RANK',
  'RISK_GATE',
  'SIZING',
  'ORDER_INTENT',
  'SIM_FILL',
  'EXEC_REJECT',
  'MGMT_ACTION',
]);

const TERMINAL_ORDER_INTENT_EVENT_TYPES = new Set<RuntimeEventType>(['SIM_FILL', 'EXEC_REJECT']);

export function normalizeJournalTailResult(
  result: JournalTailResult,
  options: EventNormalizerOptions = {},
): EventNormalizerResult {
  const mask = options.mask ?? FEATURE_AVAILABILITY_MASK;
  const checkMissingTerminalIntents = options.check_missing_terminal_order_intents ?? true;
  const normalizedEvents: NormalizedJournalEvent[] = [];
  const alerts: OperatorConsoleAlertInput[] = result.malformed_lines.map(malformedLineAlert);
  const pendingOrderIntents = new Map<string, IngestedJournalEvent>();
  const terminalOrderIntentIds = new Set<string>();
  let featurePolicyViolationCount = 0;
  let blockedFeaturePolicyViolationCount = 0;

  for (const ingested of result.events) {
    const violations = findFeaturePolicyViolations(ingested.event, mask);
    featurePolicyViolationCount += violations.length;
    blockedFeaturePolicyViolationCount += violations.filter(isBlockedPolicyViolation).length;

    normalizedEvents.push({
      ...ingested,
      decision_grade: violations.length === 0,
      policy_violations: violations,
    });

    alerts.push(...violations.map((violation, index) => policyViolationAlert(ingested, violation, index)));
    collectOrderIntentLifecycle(ingested, pendingOrderIntents, terminalOrderIntentIds);
  }

  const missingTerminalAlerts = checkMissingTerminalIntents
    ? missingTerminalOrderIntentAlerts(pendingOrderIntents, terminalOrderIntentIds)
    : [];
  alerts.push(...missingTerminalAlerts);

  return {
    events: normalizedEvents,
    alerts,
    malformed_or_schema_invalid_count: result.malformed_lines.length,
    feature_policy_violation_count: featurePolicyViolationCount,
    blocked_feature_policy_violation_count: blockedFeaturePolicyViolationCount,
    missing_terminal_order_intent_count: missingTerminalAlerts.length,
  };
}

export function findFeaturePolicyViolations(
  event: JournalEventEnvelope,
  mask: FeatureAvailabilityMask = FEATURE_AVAILABILITY_MASK,
): readonly FeaturePolicyViolation[] {
  const payload = jsonObject(event.payload) ?? {};
  const violations: FeaturePolicyViolation[] = [];

  if (FEATURE_SURFACE_EVENT_TYPES.has(event.type)) {
    scanFeatureFieldMap(violations, mask, 'values', jsonObject(payload.values));
    const diagnosticValues = jsonObject(payload.diagnostic_values);
    const shadowValues = jsonObject(payload.shadow_values);
    const hasDiagnosticOrShadow =
      hasEntries(diagnosticValues) || hasEntries(shadowValues);
    if (hasDiagnosticOrShadow && payload.decision_use !== false) {
      violations.push({
        kind: 'shadow_or_diagnostic_payload_decision_use',
        severity: 'critical',
        reason: 'diagnostic_values or shadow_values must carry decision_use=false',
      });
    }
    scanFeatureFieldMap(violations, mask, 'diagnostic_values', diagnosticValues);
    scanFeatureFieldMap(violations, mask, 'shadow_values', shadowValues);
  }

  if (DECISION_EVENT_TYPES.has(event.type)) {
    scanDecisionPayloadFields(violations, mask, payload);
    scanMboFeatureUseDecisions(violations, payload, mask);
  }

  return violations;
}

function scanFeatureFieldMap(
  violations: FeaturePolicyViolation[],
  mask: FeatureAvailabilityMask,
  context: FeatureUseContext,
  values: Record<string, unknown> | null,
): void {
  if (values === null) {
    return;
  }

  for (const field of Object.keys(values).sort()) {
    const canonical = canonicalFeatureField(field);
    const tier = tierForField(mask, canonical);
    if (tier === undefined) {
      continue;
    }

    if (tier === 'blocked') {
      violations.push({
        kind: 'blocked_field_present',
        severity: 'critical',
        field,
        canonical_field: canonical,
        tier,
        context,
        reason: `${canonical} is blocked by the feature availability mask`,
      });
      continue;
    }

    if (context === 'diagnostic_values' && tier !== 'diagnostic_only') {
      violations.push({
        kind: 'invalid_diagnostic_values_partition',
        severity: 'warning',
        field,
        canonical_field: canonical,
        tier,
        context,
        reason: `${canonical} is ${tier}, not diagnostic_only`,
      });
      continue;
    }

    if (context === 'shadow_values' && tier !== 'shadow_only') {
      violations.push({
        kind: 'invalid_shadow_values_partition',
        severity: 'warning',
        field,
        canonical_field: canonical,
        tier,
        context,
        reason: `${canonical} is ${tier}, not shadow_only`,
      });
      continue;
    }

    if (context === 'values' && tier !== 'authoritative' && tier !== 'available') {
      violations.push({
        kind: 'restricted_field_in_feature_values',
        severity: 'warning',
        field,
        canonical_field: canonical,
        tier,
        context,
        reason: `${canonical} is ${tier} and cannot be decision-grade feature state`,
      });
    }
  }
}

function scanDecisionPayloadFields(
  violations: FeaturePolicyViolation[],
  mask: FeatureAvailabilityMask,
  payload: Record<string, unknown>,
): void {
  const seen = new Set<string>();
  walkObjectKeys(payload, (path, key) => {
    const canonical = canonicalFeatureField(key);
    const tier = tierForField(mask, canonical);
    if (tier === undefined) {
      return;
    }
    const marker = `${path}:${key}:${canonical}`;
    if (seen.has(marker)) {
      return;
    }
    seen.add(marker);

    if (tier === 'blocked') {
      violations.push({
        kind: 'blocked_field_present',
        severity: 'critical',
        field: key,
        canonical_field: canonical,
        tier,
        context: 'decision_payload',
        path,
        reason: `${canonical} is blocked by the feature availability mask`,
      });
      return;
    }

    if (tier !== 'authoritative' && tier !== 'available') {
      violations.push({
        kind: 'restricted_field_in_decision_context',
        severity: 'warning',
        field: key,
        canonical_field: canonical,
        tier,
        context: 'decision_payload',
        path,
        reason: `${canonical} is ${tier} and cannot be used in decision payloads`,
      });
    }
  });
}

function scanMboFeatureUseDecisions(
  violations: FeaturePolicyViolation[],
  payload: Record<string, unknown>,
  mask: FeatureAvailabilityMask,
): void {
  const validContexts = mboUseContextSet(mask);
  walkObjects(payload, (path, value) => {
    const featureName = stringValue(value.feature_name) ?? stringValue(value.feature);
    const useContext = stringValue(value.use_context) ?? stringValue(value.context);
    if (featureName === undefined || useContext === undefined) {
      return;
    }
    if (!validContexts.has(useContext)) {
      violations.push({
        kind: 'mbo_feature_use_denied',
        severity: 'critical',
        field: featureName,
        context: useContext as MboFeatureUseContext,
        path,
        reason: `invalid MBO feature use context: ${useContext}`,
      });
      return;
    }

    const decision = isFeatureUseAllowed(featureName, useContext as MboFeatureUseContext);
    if (!decision.allowed) {
      violations.push({
        kind: 'mbo_feature_use_denied',
        severity: decision.tier === 'blocked' || decision.tier === 'unmapped' ? 'critical' : 'warning',
        field: featureName,
        tier: decision.tier,
        context: decision.use_context,
        path,
        reason: decision.reason,
      });
    }
  });
}

function collectOrderIntentLifecycle(
  ingested: IngestedJournalEvent,
  pendingOrderIntents: Map<string, IngestedJournalEvent>,
  terminalOrderIntentIds: Set<string>,
): void {
  const payload = jsonObject(ingested.event.payload) ?? {};
  const orderIntentId = stringValue(payload.order_intent_id);
  if (orderIntentId === undefined) {
    return;
  }

  if (ingested.event.type === 'ORDER_INTENT') {
    pendingOrderIntents.set(orderIntentId, ingested);
    return;
  }

  if (TERMINAL_ORDER_INTENT_EVENT_TYPES.has(ingested.event.type)) {
    terminalOrderIntentIds.add(orderIntentId);
  }
}

function missingTerminalOrderIntentAlerts(
  pendingOrderIntents: Map<string, IngestedJournalEvent>,
  terminalOrderIntentIds: Set<string>,
): readonly OperatorConsoleAlertInput[] {
  return [...pendingOrderIntents.entries()]
    .filter(([orderIntentId]) => !terminalOrderIntentIds.has(orderIntentId))
    .map(([orderIntentId, ingested]) => ({
      id: alertId('missing-terminal-order-intent', ingested, orderIntentId),
      kind: 'missing_terminal_order_intent',
      severity: 'warning',
      message: `ORDER_INTENT ${orderIntentId} has no SIM_FILL or EXEC_REJECT in the normalized batch`,
      event_id: ingested.event.event_id,
      source_file: ingested.source_file,
      line_number: ingested.line_number,
      byte_offset_start: ingested.byte_offset_start,
      byte_offset_end: ingested.byte_offset_end,
      details: { order_intent_id: orderIntentId },
    }));
}

function malformedLineAlert(line: QuarantinedJournalLine): OperatorConsoleAlertInput {
  const classification = line.error_message.includes('journal event schema validation failed')
    ? 'schema_invalid'
    : 'malformed_json';
  return {
    id: `malformed-or-schema-invalid:${line.source_file}:${line.line_number}:${line.byte_offset_start}`,
    kind: 'malformed_or_schema_invalid_row',
    severity: classification === 'schema_invalid' ? 'warning' : 'critical',
    message: `Excluded ${classification} journal row at ${line.source_file}:${line.line_number}`,
    source_file: line.source_file,
    line_number: line.line_number,
    byte_offset_start: line.byte_offset_start,
    byte_offset_end: line.byte_offset_end,
    details: {
      classification,
      error_message: line.error_message,
    },
  };
}

function policyViolationAlert(
  ingested: IngestedJournalEvent,
  violation: FeaturePolicyViolation,
  index: number,
): OperatorConsoleAlertInput {
  return {
    id: alertId(`feature-policy-${index}`, ingested, violation.kind),
    kind: 'feature_policy_violation',
    severity: violation.severity,
    message: `${ingested.event.type} excluded from decision-grade state: ${violation.reason}`,
    event_id: ingested.event.event_id,
    source_file: ingested.source_file,
    line_number: ingested.line_number,
    byte_offset_start: ingested.byte_offset_start,
    byte_offset_end: ingested.byte_offset_end,
    details: {
      violation_kind: violation.kind,
      field: violation.field ?? null,
      canonical_field: violation.canonical_field ?? null,
      tier: violation.tier ?? null,
      context: violation.context ?? null,
      path: violation.path ?? null,
    },
  };
}

function isBlockedPolicyViolation(violation: FeaturePolicyViolation): boolean {
  return violation.tier === 'blocked' || violation.tier === 'unmapped';
}

function tierForField(
  mask: FeatureAvailabilityMask,
  canonicalField: string,
): FeatureAvailabilityTier | undefined {
  return canonicalField in mask.field_tiers
    ? mask.field_tiers[canonicalField as keyof typeof mask.field_tiers]
    : undefined;
}

function canonicalFeatureField(field: string): string {
  const aliases: Readonly<Record<string, string>> = {
    bid_px: 'l1_quote_bid_px',
    ask_px: 'l1_quote_ask_px',
    l1_bid_px: 'l1_quote_bid_px',
    l1_ask_px: 'l1_quote_ask_px',
    spread_points: 'microstructure_spread_points',
    spread_ticks: 'microstructure_spread_ticks',
    mid_px: 'microstructure_mid_px',
    microprice_offset_ticks: 'mbo_microprice_offset_ticks',
    ofi_short: 'mbo_ofi_short',
    ofi_medium: 'mbo_ofi_medium',
    ofi_blend: 'mbo_ofi_blend',
    queue_imbalance: 'mbo_queue_imbalance',
    queue_ahead_fraction: 'queue_ahead_fraction_estimate',
  };
  return aliases[field] ?? field;
}

function walkObjectKeys(
  value: unknown,
  visit: (path: string, key: string) => void,
  path = '$',
): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkObjectKeys(item, visit, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    visit(path, key);
    walkObjectKeys(child, visit, `${path}.${key}`);
  }
}

function walkObjects(
  value: unknown,
  visit: (path: string, value: Record<string, unknown>) => void,
  path = '$',
): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkObjects(item, visit, `${path}[${index}]`));
    return;
  }
  const record = value as Record<string, unknown>;
  visit(path, record);
  for (const [key, child] of Object.entries(record)) {
    walkObjects(child, visit, `${path}.${key}`);
  }
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasEntries(value: Record<string, unknown> | null): boolean {
  return value !== null && Object.keys(value).length > 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function mboUseContextSet(mask: FeatureAvailabilityMask): ReadonlySet<string> {
  return new Set([
    ...mask.mbo_policy.decision_contexts,
    ...Object.values(mask.mbo_policy.allowed_contexts_by_tier).flat(),
  ]);
}

function alertId(prefix: string, ingested: IngestedJournalEvent, suffix: string): string {
  return `${prefix}:${ingested.event.event_id}:${ingested.line_number}:${suffix}`;
}
