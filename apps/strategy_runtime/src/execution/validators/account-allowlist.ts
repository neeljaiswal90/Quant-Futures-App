import type { AnyJournalEventEnvelope, JsonValue } from '../../contracts/index.js';
import {
  accountIdAllowed,
  missingAllowlistEntriesFromSnapshot,
  redactAccountId,
  type BrokerAccountSnapshotEntry,
  type LiveAccountAllowlist,
} from '../brokers/account-allowlist.js';
import type { ValidatorIssue, ValidatorRunner, ValidatorRuntimeContext } from './runner.js';
import { captureValidatorIssueEmittedTsNs } from './validator-time.js';

const VALIDATOR_ID = 'EXEC-VALIDATOR-09' as const;

export class AccountAllowlistValidator implements ValidatorRunner {
  runOnEvent(
    event: AnyJournalEventEnvelope,
    context: ValidatorRuntimeContext = {},
  ): readonly ValidatorIssue[] {
    const allowlist = context.live_account_allowlist ?? [];
    if (allowlist.length === 0) {
      return [];
    }
    const payload = asRecord(event.payload);
    if (payload === undefined) {
      return [];
    }

    if (event.type === 'ORDER_INTENT') {
      const accountId = stringField(payload, 'account_id');
      if (accountId === undefined) {
        return [
          issue({
            code: 'order_intent_missing_account_id',
            message: 'order intent is missing account_id required by live account allowlist enforcement',
            context,
            event,
            details: {},
          }),
        ];
      }
      const allowlistCheck = accountIdAllowed(allowlist, accountId);
      if (!allowlistCheck.ok) {
        return [
          issue({
            code: allowlistCheck.code,
            message: allowlistCheck.message,
            context,
            event,
            details: { account_id_redacted: redactAccountId(accountId) },
          }),
        ];
      }
    }

    if (
      event.type === 'ORDER_ACK_SUBMISSION' ||
      event.type === 'ORDER_ACK_FILL' ||
      event.type === 'ORDER_ACK_CANCEL' ||
      event.type === 'ORDER_BROKER_REJECT'
    ) {
      const accountId = stringField(payload, 'broker_account_id');
      const allowlistCheck = accountIdAllowed(allowlist, accountId);
      if (accountId !== undefined && !allowlistCheck.ok) {
        return [
          issue({
            code: 'broker_account_id_not_in_allowlist',
            message: 'broker event reported an account_id outside the live account allowlist',
            context,
            event,
            details: { account_id_redacted: redactAccountId(accountId) },
          }),
        ];
      }
    }

    return [];
  }

  runOnSessionStart(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    const allowlist = context.live_account_allowlist ?? [];
    if (context.mode === 'live' && allowlist.length === 0) {
      return [
        issue({
          code: 'live_account_allowlist_empty',
          message: 'live execution requires a non-empty live account allowlist',
          context,
          details: {},
        }),
      ];
    }
    return validateSnapshot(allowlist, context.account_list_snapshot ?? [], context);
  }

  runOnPeriodicCadence(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    const allowlist = context.live_account_allowlist ?? [];
    return validateSnapshot(allowlist, context.account_list_snapshot ?? [], context);
  }
}

function validateSnapshot(
  allowlist: LiveAccountAllowlist,
  snapshot: readonly BrokerAccountSnapshotEntry[],
  context: ValidatorRuntimeContext,
): readonly ValidatorIssue[] {
  if (allowlist.length === 0 || snapshot.length === 0) {
    return [];
  }
  const missing = missingAllowlistEntriesFromSnapshot(allowlist, snapshot);
  if (missing.length === 0) {
    return [];
  }
  return [
    issue({
      code: 'account_allowlist_missing_from_broker_snapshot',
      message: 'broker account snapshot did not include every configured live account allowlist entry',
      context,
      details: {
        missing_account_ids_redacted: missing.map((entry) => redactAccountId(entry.account_id)).join(','),
      },
    }),
  ];
}

function issue(input: {
  readonly code: string;
  readonly message: string;
  readonly context?: ValidatorRuntimeContext;
  readonly event?: AnyJournalEventEnvelope;
  readonly details?: Readonly<Record<string, JsonValue>>;
}): ValidatorIssue {
  return {
    validator_id: VALIDATOR_ID,
    severity: 'fatal',
    emitted_ts_ns: captureValidatorIssueEmittedTsNs(),
    code: input.code,
    message: input.message,
    session_id: input.context?.session_id ?? input.event?.session_id,
    ...(input.event === undefined ? {} : { event_id: input.event.event_id, event_type: input.event.type }),
    ...(input.context?.session_family_id === undefined
      ? {}
      : { session_family_id: input.context.session_family_id }),
    ...(input.details === undefined ? {} : { details: input.details }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(record: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
