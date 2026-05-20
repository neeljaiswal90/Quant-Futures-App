import { createHash } from 'node:crypto';
import { stableJsonStringify, type AnyJournalEventEnvelope, type JsonValue } from '../../contracts/index.js';
import { buildExecutionCapabilityMask } from '../execution-capability-mask.js';
import type {
  ExecutionMaskSnapshot,
  ValidatorIssue,
  ValidatorRunner,
  ValidatorRuntimeContext,
} from './runner.js';
import { captureValidatorIssueEmittedTsNs } from './validator-time.js';

const VALIDATOR_ID = 'EXEC-VALIDATOR-01' as const;

export class MaskCoherenceValidator implements ValidatorRunner {
  private readonly lastMaskVersionByFamily = new Map<string, number>();

  runOnEvent(
    event: AnyJournalEventEnvelope,
    context: ValidatorRuntimeContext = {},
  ): readonly ValidatorIssue[] {
    const mask = extractMaskFromEvent(event);
    return mask === undefined ? [] : this.validateMask(mask, context, event);
  }

  runOnSessionStart(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    const mask = extractMaskFromContext(context);
    if (mask === undefined) {
      return [
        issue({
          code: 'execution_mask_missing',
          severity: 'fatal',
          message: 'session start is missing the QFA-622 execution capability mask',
          context,
        }),
      ];
    }
    return this.validateMask(mask, context);
  }

  runOnPeriodicCadence(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    const mask = extractMaskFromContext(context);
    return mask === undefined ? [] : this.validateMask(mask, context);
  }

  private validateMask(
    mask: ExecutionMaskSnapshot,
    context: ValidatorRuntimeContext,
    event?: AnyJournalEventEnvelope,
  ): readonly ValidatorIssue[] {
    const issues: ValidatorIssue[] = [];
    const expected = buildExecutionCapabilityMask();
    const observedHash = stringField(mask, 'mask_hash');
    const observedId = stringField(mask, 'mask_id');
    const observedVersion = numberField(mask, 'mask_version');
    const recomputedHash = recomputeMaskHash(mask) ?? expected.mask_hash;

    if (observedId === undefined || observedVersion === undefined || observedHash === undefined) {
      issues.push(
        issue({
          code: 'execution_mask_identity_missing',
          severity: 'fatal',
          message: 'execution capability mask is missing mask_id, mask_version, or mask_hash',
          context,
          event,
        }),
      );
      return issues;
    }

    if (observedId !== expected.mask_id || observedVersion !== expected.mask_version) {
      issues.push(
        issue({
          code: 'execution_mask_identity_mismatch',
          severity: 'error',
          message: 'execution capability mask identity differs from QFA-622 runtime identity',
          context,
          event,
          details: {
            expected_mask_id: expected.mask_id,
            observed_mask_id: observedId,
            expected_mask_version: expected.mask_version,
            observed_mask_version: observedVersion,
          },
        }),
      );
    }

    if (observedHash !== recomputedHash) {
      issues.push(
        issue({
          code: 'execution_mask_hash_mismatch',
          severity: 'fatal',
          message: 'execution capability mask hash does not match the recomputed canonical hash',
          context,
          event,
          details: {
            expected_hash: recomputedHash,
            observed_hash: observedHash,
          },
        }),
      );
    }

    const family = context.session_family_id ?? context.session_id ?? event?.session_id;
    if (family !== undefined) {
      const previousVersion = this.lastMaskVersionByFamily.get(family);
      if (previousVersion !== undefined && observedVersion < previousVersion) {
        issues.push(
          issue({
            code: 'execution_mask_version_regression',
            severity: 'fatal',
            message: 'execution capability mask version regressed within the session family',
            context,
            event,
            details: {
              previous_mask_version: previousVersion,
              observed_mask_version: observedVersion,
            },
          }),
        );
      }
      if (previousVersion === undefined || observedVersion >= previousVersion) {
        this.lastMaskVersionByFamily.set(family, observedVersion);
      }
    }

    return issues;
  }
}

function extractMaskFromContext(context: ValidatorRuntimeContext): ExecutionMaskSnapshot | undefined {
  if (context.execution_mask !== undefined) {
    return context.execution_mask as unknown as ExecutionMaskSnapshot;
  }
  const manifest = context.session_manifest;
  if (manifest === undefined) {
    return undefined;
  }
  const nested = recordField(manifest, 'execution_capability_mask') ?? recordField(manifest, 'execution_mask');
  if (nested !== undefined) {
    return nested;
  }
  const maskId = stringField(manifest, 'mask_id') ?? stringField(manifest, 'execution_mask_id');
  const maskHash = stringField(manifest, 'mask_hash') ?? stringField(manifest, 'execution_mask_hash');
  const maskVersion = numberField(manifest, 'mask_version') ?? numberField(manifest, 'execution_mask_version');
  if (maskId === undefined && maskHash === undefined && maskVersion === undefined) {
    return undefined;
  }
  return {
    ...buildExecutionCapabilityMask(),
    ...(maskId === undefined ? {} : { mask_id: maskId }),
    ...(maskHash === undefined ? {} : { mask_hash: maskHash }),
    ...(maskVersion === undefined ? {} : { mask_version: maskVersion }),
  } as ExecutionMaskSnapshot;
}

function extractMaskFromEvent(event: AnyJournalEventEnvelope): ExecutionMaskSnapshot | undefined {
  const payload = asRecord(event.payload);
  if (payload === undefined) {
    return undefined;
  }
  return recordField(payload, 'execution_capability_mask') ?? recordField(payload, 'execution_mask');
}

function recomputeMaskHash(mask: ExecutionMaskSnapshot): string | undefined {
  const record = { ...mask } as Record<string, unknown>;
  if (!('capabilities' in record) || !('binding_table' in record)) {
    return undefined;
  }
  delete record.mask_hash;
  return `sha256:${createHash('sha256')
    .update(stableJsonStringify(record as JsonValue), 'utf8')
    .digest('hex')}`;
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
  const sessionFamilyId = input.context?.session_family_id;
  return {
    validator_id: VALIDATOR_ID,
    severity: input.severity,
    emitted_ts_ns: captureValidatorIssueEmittedTsNs(),
    code: input.code,
    message: input.message,
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
    ...(sessionFamilyId === undefined ? {} : { session_family_id: sessionFamilyId }),
    ...(input.event === undefined ? {} : { event_id: input.event.event_id, event_type: input.event.type }),
    ...(input.details === undefined ? {} : { details: input.details }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function recordField(record: Readonly<Record<string, unknown>>, field: string): ExecutionMaskSnapshot | undefined {
  return asRecord(record[field]) as ExecutionMaskSnapshot | undefined;
}

function stringField(record: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function numberField(record: Readonly<Record<string, unknown>>, field: string): number | undefined {
  const value = record[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
