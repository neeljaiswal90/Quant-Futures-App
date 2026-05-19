import type { AnyJournalEventEnvelope, JsonValue } from '../../contracts/index.js';
import type { ValidatorIssue, ValidatorRunner, ValidatorRuntimeContext } from './runner.js';
import { captureValidatorIssueEmittedTsNs } from './validator-time.js';

const VALIDATOR_ID = 'EXEC-VALIDATOR-03' as const;

interface SubmissionNode {
  readonly event_id: string;
  readonly submission_ack_id: string;
  readonly intent_id: string;
  readonly broker_order_id: string;
  readonly broker_account_id: string;
  readonly instrument_symbol?: string;
}

export class AckLineageValidator implements ValidatorRunner {
  private readonly submissionsByAckId = new Map<string, SubmissionNode>();
  private readonly seenAckIds = new Set<string>();

  runOnEvent(
    event: AnyJournalEventEnvelope,
    context: ValidatorRuntimeContext = {},
  ): readonly ValidatorIssue[] {
    const payload = asRecord(event.payload);
    if (payload === undefined) {
      return [];
    }

    if (event.type === 'ORDER_ACK_SUBMISSION') {
      return this.recordSubmission(event, payload, context);
    }
    if (event.type === 'ORDER_ACK_FILL' || event.type === 'ORDER_ACK_CANCEL') {
      return this.validateTerminalAck(event, payload, context);
    }
    return [];
  }

  runOnSessionStart(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    void context;
    return [];
  }

  runOnPeriodicCadence(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    void context;
    return [];
  }

  private recordSubmission(
    event: AnyJournalEventEnvelope,
    payload: Record<string, unknown>,
    context: ValidatorRuntimeContext,
  ): readonly ValidatorIssue[] {
    const submissionAckId = stringField(payload, 'submission_ack_id');
    if (submissionAckId === undefined) {
      return [];
    }

    const issues: ValidatorIssue[] = [];
    if (this.seenAckIds.has(submissionAckId)) {
      issues.push(
        issue({
          code: 'duplicate_ack_id',
          severity: 'fatal',
          message: 'submission ACK reused an ACK identifier already seen in the lineage graph',
          context,
          event,
          details: { ack_id: submissionAckId },
        }),
      );
    }
    this.seenAckIds.add(submissionAckId);
    this.submissionsByAckId.set(submissionAckId, {
      event_id: event.event_id,
      submission_ack_id: submissionAckId,
      intent_id: stringField(payload, 'intent_id') ?? '',
      broker_order_id: stringField(payload, 'broker_order_id') ?? '',
      broker_account_id: stringField(payload, 'broker_account_id') ?? '',
      ...(stringField(payload, 'instrument_symbol') === undefined
        ? {}
        : { instrument_symbol: stringField(payload, 'instrument_symbol')! }),
    });
    return issues;
  }

  private validateTerminalAck(
    event: AnyJournalEventEnvelope,
    payload: Record<string, unknown>,
    context: ValidatorRuntimeContext,
  ): readonly ValidatorIssue[] {
    const issues: ValidatorIssue[] = [];
    const ackIdField = event.type === 'ORDER_ACK_FILL' ? 'fill_ack_id' : 'cancel_ack_id';
    const ackId = stringField(payload, ackIdField);
    if (ackId !== undefined) {
      if (this.seenAckIds.has(ackId)) {
        issues.push(
          issue({
            code: 'duplicate_ack_id',
            severity: 'fatal',
            message: 'terminal ACK reused an ACK identifier already seen in the lineage graph',
            context,
            event,
            details: { ack_id: ackId },
          }),
        );
      }
      this.seenAckIds.add(ackId);
    }

    const submissionAckId = stringField(payload, 'submission_ack_id');
    const submission = submissionAckId === undefined ? undefined : this.submissionsByAckId.get(submissionAckId);
    if (submissionAckId === undefined || submission === undefined) {
      issues.push(
        issue({
          code: 'orphan_terminal_ack',
          severity: 'fatal',
          message: 'fill/cancel ACK references no prior submission ACK in the lineage graph',
          context,
          event,
          details: {
            submission_ack_id: submissionAckId ?? '',
          },
        }),
      );
      return issues;
    }

    const mismatches = mismatchedFields(submission, payload, event.type === 'ORDER_ACK_FILL');
    if (mismatches.length > 0) {
      issues.push(
        issue({
          code: 'broken_ack_chain',
          severity: 'fatal',
          message: 'fill/cancel ACK lineage fields disagree with the prior submission ACK',
          context,
          event,
          details: {
            submission_event_id: submission.event_id,
            mismatched_fields: mismatches.join(','),
            submission_ack_id: submissionAckId,
          },
        }),
      );
    }

    return issues;
  }
}

function mismatchedFields(
  submission: SubmissionNode,
  payload: Record<string, unknown>,
  checkInstrument: boolean,
): readonly string[] {
  const fields = ['intent_id', 'broker_order_id', 'broker_account_id'] as const;
  const mismatches = fields.filter((field) => stringField(payload, field) !== submission[field]);
  if (checkInstrument && stringField(payload, 'instrument_symbol') !== submission.instrument_symbol) {
    return [...mismatches, 'instrument_symbol'];
  }
  return mismatches;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
