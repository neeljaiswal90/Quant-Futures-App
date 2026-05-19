import type { AnyJournalEventEnvelope, JsonValue } from '../../contracts/index.js';
import type { ValidatorIssue, ValidatorRunner, ValidatorRuntimeContext } from './runner.js';
import { captureValidatorIssueEmittedTsNs } from './validator-time.js';

const VALIDATOR_ID = 'EXEC-VALIDATOR-04' as const;
type ExecutionMode = 'paper' | 'live';
type TransitionStep = 'prepare' | 'commit';

interface PendingTransition {
  readonly from: ExecutionMode;
  readonly to: ExecutionMode;
  readonly prepared_event_id: string;
}

interface ParsedTransition {
  readonly step: TransitionStep;
  readonly from: string | undefined;
  readonly to: string | undefined;
}

export class ModeTransitionValidator implements ValidatorRunner {
  private currentMode: ExecutionMode | undefined;
  private pendingTransition: PendingTransition | undefined;

  runOnSessionStart(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    const mode = normalizeMode(context.mode ?? stringField(context.session_manifest, 'mode'));
    if (mode === undefined) {
      return [];
    }
    this.currentMode = mode;
    return [];
  }

  runOnEvent(
    event: AnyJournalEventEnvelope,
    context: ValidatorRuntimeContext = {},
  ): readonly ValidatorIssue[] {
    const payload = asRecord(event.payload);
    if (payload === undefined) {
      return [];
    }

    const transition = parseTransition(payload);
    if (transition !== undefined) {
      return this.applyOperatorTransition(transition, event, context);
    }

    const reportedMode = normalizeMode(
      stringField(payload, 'mode') ?? stringField(payload, 'session_mode') ?? stringField(payload, 'execution_mode'),
    );
    if (reportedMode === undefined) {
      return [];
    }
    if (this.currentMode === undefined) {
      this.currentMode = reportedMode;
      return [];
    }
    if (reportedMode !== this.currentMode) {
      return [
        issue({
          code: 'mode_transition_without_two_step_operator_event',
          severity: 'fatal',
          message: 'paper/live mode changed without the required prepare+commit operator sequence',
          context,
          event,
          details: {
            previous_mode: this.currentMode,
            observed_mode: reportedMode,
          },
        }),
      ];
    }
    return [];
  }

  runOnPeriodicCadence(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    void context;
    return [];
  }

  private applyOperatorTransition(
    transition: ParsedTransition,
    event: AnyJournalEventEnvelope,
    context: ValidatorRuntimeContext,
  ): readonly ValidatorIssue[] {
    const from = normalizeMode(transition.from);
    const to = normalizeMode(transition.to);
    if (from === undefined || to === undefined || from === to) {
      return [
        issue({
          code: 'invalid_mode_transition_request',
          severity: 'fatal',
          message: 'operator mode transition must name distinct paper/live from and to modes',
          context,
          event,
          details: {
            from_mode: transition.from ?? '',
            to_mode: transition.to ?? '',
          },
        }),
      ];
    }

    if (transition.step === 'prepare') {
      if (this.currentMode !== undefined && this.currentMode !== from) {
        return [
          issue({
            code: 'mode_transition_prepare_from_mismatch',
            severity: 'fatal',
            message: 'operator prepare step does not match the current execution mode',
            context,
            event,
            details: {
              current_mode: this.currentMode,
              requested_from_mode: from,
              requested_to_mode: to,
            },
          }),
        ];
      }
      this.pendingTransition = { from, to, prepared_event_id: event.event_id };
      return [];
    }

    const pending = this.pendingTransition;
    if (pending === undefined || pending.from !== from || pending.to !== to) {
      return [
        issue({
          code: 'mode_transition_commit_without_matching_prepare',
          severity: 'fatal',
          message: 'operator commit step is missing a matching prior prepare step',
          context,
          event,
          details: {
            requested_from_mode: from,
            requested_to_mode: to,
          },
        }),
      ];
    }
    this.currentMode = to;
    this.pendingTransition = undefined;
    return [];
  }
}

function parseTransition(payload: Record<string, unknown>): ParsedTransition | undefined {
  const explicitStep = stringField(payload, 'transition_step');
  const action = stringField(payload, 'operator_action');
  const step = explicitStep === 'prepare' || action === 'mode_transition_prepare'
    ? 'prepare'
    : explicitStep === 'commit' || action === 'mode_transition_commit'
      ? 'commit'
      : undefined;
  if (step === undefined) {
    return undefined;
  }
  return {
    step,
    from: stringField(payload, 'from_mode') ?? stringField(payload, 'previous_mode'),
    to: stringField(payload, 'to_mode') ?? stringField(payload, 'target_mode') ?? stringField(payload, 'mode'),
  };
}

function issue(input: {
  readonly code: string;
  readonly severity: ValidatorIssue['severity'];
  readonly message: string;
  readonly context?: ValidatorRuntimeContext;
  readonly event: AnyJournalEventEnvelope;
  readonly details?: Readonly<Record<string, JsonValue>>;
}): ValidatorIssue {
  return {
    validator_id: VALIDATOR_ID,
    severity: input.severity,
    emitted_ts_ns: captureValidatorIssueEmittedTsNs(),
    code: input.code,
    message: input.message,
    session_id: input.context?.session_id ?? input.event.session_id,
    event_id: input.event.event_id,
    event_type: input.event.type,
    ...(input.context?.session_family_id === undefined
      ? {}
      : { session_family_id: input.context.session_family_id }),
    ...(input.details === undefined ? {} : { details: input.details }),
  };
}

function normalizeMode(value: unknown): ExecutionMode | undefined {
  return value === 'paper' || value === 'live' ? value : undefined;
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
