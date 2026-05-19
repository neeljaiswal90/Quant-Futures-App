import type { AnyJournalEventEnvelope, JsonValue } from '../../contracts/index.js';
import { buildExecutionCapabilityMask } from '../execution-capability-mask.js';
import type { ValidatorIssue, ValidatorRunner, ValidatorRuntimeContext } from './runner.js';
import { captureValidatorIssueEmittedTsNs } from './validator-time.js';

const VALIDATOR_ID = 'EXEC-VALIDATOR-05' as const;
const LIVE_RECONCILIATION_PHASE_RANK = 3;
const PHASE_RANK: Readonly<Record<string, number>> = {
  startup: 0,
  paper: 1,
  paper_harness: 1,
  paper_ordering: 1,
  live_ordering: 2,
  live_reconciliation: LIVE_RECONCILIATION_PHASE_RANK,
  live_reconciled: 4,
};

export class PlantScopeValidator implements ValidatorRunner {
  runOnSessionStart(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    return validatePlants(extractPlantsFromContext(context), context);
  }

  runOnEvent(
    event: AnyJournalEventEnvelope,
    context: ValidatorRuntimeContext = {},
  ): readonly ValidatorIssue[] {
    const payload = asRecord(event.payload);
    if (payload === undefined) {
      return [];
    }
    return validatePlants(extractPlantsFromRecord(payload), context, event);
  }

  runOnPeriodicCadence(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    return validatePlants(extractPlantsFromContext(context), context);
  }
}

function validatePlants(
  plants: readonly string[],
  context: ValidatorRuntimeContext,
  event?: AnyJournalEventEnvelope,
): readonly ValidatorIssue[] {
  const issues: ValidatorIssue[] = [];
  const phase = phaseFromContextOrEvent(context, event);
  for (const plant of plants) {
    if (plant === 'ORDER_PLANT') {
      const mask = (context.execution_mask ?? buildExecutionCapabilityMask()) as unknown as Readonly<
        Record<string, unknown>
      >;
      const orderPlantPaper = tier(mask, 'order_plant_paper', 'paper');
      const orderPlantLive = tier(mask, 'order_plant_live', 'live');
      if (orderPlantPaper === 'blocked' && orderPlantLive === 'blocked') {
        issues.push(
          issue({
            code: 'order_plant_blocked_by_execution_mask',
            severity: 'fatal',
            message: 'ORDER_PLANT scope was requested but the QFA-622 mask blocks order plant access',
            context,
            event,
          }),
        );
      }
      continue;
    }
    if (plant === 'PNL_PLANT') {
      if (phaseRank(phase) < LIVE_RECONCILIATION_PHASE_RANK) {
        issues.push(
          issue({
            code: 'pnl_plant_before_live_reconciliation',
            severity: 'fatal',
            message: 'PNL_PLANT scope is only allowed at or after live_reconciliation phase',
            context,
            event,
            details: { phase: phase ?? '' },
          }),
        );
      }
      continue;
    }
    if (plant === 'HISTORY_PLANT') {
      issues.push(
        issue({
          code: 'history_plant_rejected',
          severity: 'fatal',
          message: 'HISTORY_PLANT scope is rejected by ADR-0018/QFA-622',
          context,
          event,
        }),
      );
    }
  }
  return issues;
}

function extractPlantsFromContext(context: ValidatorRuntimeContext): readonly string[] {
  if (context.plant_scope !== undefined) {
    return normalizePlants(context.plant_scope);
  }
  return normalizePlants(context.session_manifest?.plant_scope);
}

function extractPlantsFromRecord(record: Readonly<Record<string, unknown>>): readonly string[] {
  return normalizePlants(record.plant_scope ?? record.plant ?? record.execution_plant);
}

function normalizePlants(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function phaseFromContextOrEvent(
  context: ValidatorRuntimeContext,
  event?: AnyJournalEventEnvelope,
): string | undefined {
  const payload = event === undefined ? undefined : asRecord(event.payload);
  return (
    stringField(payload, 'execution_phase') ??
    context.execution_phase ??
    stringField(context.session_manifest, 'execution_phase') ??
    stringField(context.session_manifest, 'phase')
  );
}

function phaseRank(phase: string | undefined): number {
  return phase === undefined ? -1 : PHASE_RANK[phase] ?? -1;
}

function tier(mask: Readonly<Record<string, unknown>>, capability: string, mode: string): string | undefined {
  const bindingTable = asRecord(mask.binding_table);
  const capabilityBinding = bindingTable === undefined ? undefined : asRecord(bindingTable[capability]);
  const value = capabilityBinding?.[mode];
  return typeof value === 'string' ? value : undefined;
}

function issue(input: {
  readonly code: string;
  readonly severity: ValidatorIssue['severity'];
  readonly message: string;
  readonly context?: ValidatorRuntimeContext;
  readonly event?: AnyJournalEventEnvelope;
  readonly details?: Readonly<Record<string, JsonValue>>;
}): ValidatorIssue {
  const sessionId = input.context?.session_id ?? input.event?.session_id;
  return {
    validator_id: VALIDATOR_ID,
    severity: input.severity,
    emitted_ts_ns: captureValidatorIssueEmittedTsNs(),
    code: input.code,
    message: input.message,
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
    ...(input.context?.session_family_id === undefined
      ? {}
      : { session_family_id: input.context.session_family_id }),
    ...(input.event === undefined ? {} : { event_id: input.event.event_id, event_type: input.event.type }),
    ...(input.details === undefined ? {} : { details: input.details }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Readonly<Record<string, unknown>> | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
