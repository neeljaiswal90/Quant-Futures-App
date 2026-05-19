import type { AnyJournalEventEnvelope, JsonValue } from '../../contracts/index.js';
import { buildExecutionCapabilityMask, type ExecutionCapabilityMask } from '../execution-capability-mask.js';
import type {
  ExecutionMaskSnapshot,
  ValidatorIssue,
  ValidatorRunner,
  ValidatorRuntimeContext,
} from './runner.js';
import { captureValidatorIssueEmittedTsNs } from './validator-time.js';

const VALIDATOR_ID = 'EXEC-VALIDATOR-07' as const;

export type MaskArtifactLoader = () => ExecutionMaskSnapshot | ExecutionCapabilityMask;

export interface SubmissionGateLike {
  readonly block?: (reason: string) => void;
  readonly setBlocked?: (blocked: boolean, reason?: string) => void;
}

export interface MaskDriftValidatorOptions {
  readonly artifactMaskLoader?: MaskArtifactLoader;
  readonly submissionGate?: SubmissionGateLike;
}

export class MaskDriftValidator implements ValidatorRunner {
  private readonly artifactMaskLoader?: MaskArtifactLoader;
  private readonly submissionGate?: SubmissionGateLike;

  constructor(options: MaskDriftValidatorOptions = {}) {
    this.artifactMaskLoader = options.artifactMaskLoader;
    this.submissionGate = options.submissionGate;
  }

  runOnSessionStart(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    return this.compareMasks(context);
  }

  runOnEvent(
    event: AnyJournalEventEnvelope,
    context: ValidatorRuntimeContext = {},
  ): readonly ValidatorIssue[] {
    const payload = asRecord(event.payload);
    const liveMask = payload === undefined
      ? undefined
      : (asRecord(payload.execution_capability_mask) ?? asRecord(payload.execution_mask));
    return liveMask === undefined ? [] : this.compareMasks({ ...context, execution_mask: liveMask }, event);
  }

  runOnPeriodicCadence(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    return this.compareMasks(context);
  }

  private compareMasks(
    context: ValidatorRuntimeContext,
    event?: AnyJournalEventEnvelope,
  ): readonly ValidatorIssue[] {
    const liveMask = asMaskSnapshot(
      context.execution_mask ?? extractManifestMask(context) ?? buildExecutionCapabilityMask(),
    );
    let artifactMask: ExecutionMaskSnapshot;
    try {
      artifactMask = asMaskSnapshot(
        context.artifact_mask ?? this.artifactMaskLoader?.() ?? buildExecutionCapabilityMask(),
      );
    } catch (error) {
      return [
        issue({
          code: 'execution_mask_artifact_unavailable',
          severity: 'fatal',
          message: 'filesystem/artifact execution capability mask could not be loaded',
          context,
          event,
          details: { error: error instanceof Error ? error.message : String(error) },
        }),
      ];
    }

    const driftFields = ['mask_id', 'mask_version', 'mask_hash'].filter(
      (field) => liveMask[field] !== artifactMask[field],
    );
    if (driftFields.length === 0) {
      return [];
    }

    const driftIssue = issue({
      code: 'execution_mask_drift',
      severity: 'fatal',
      message: 'live execution capability mask differs from filesystem/artifact mask',
      context,
      event,
      details: {
        drift_fields: driftFields.join(','),
        live_mask_id: stringValue(liveMask.mask_id),
        artifact_mask_id: stringValue(artifactMask.mask_id),
        live_mask_version: stringValue(liveMask.mask_version),
        artifact_mask_version: stringValue(artifactMask.mask_version),
        live_mask_hash: stringValue(liveMask.mask_hash),
        artifact_mask_hash: stringValue(artifactMask.mask_hash),
      },
    });
    this.blockSubmissionGate(driftIssue);
    return [driftIssue];
  }

  private blockSubmissionGate(driftIssue: ValidatorIssue): void {
    const reason = `${driftIssue.validator_id}:${driftIssue.code}`;
    // QFA-628 SubmissionGate is intentionally not imported here. When that surface
    // exists, callers can inject it through MaskDriftValidatorOptions.submissionGate;
    // until then, the fallback is a no-op observer path.
    if (this.submissionGate?.block !== undefined) {
      this.submissionGate.block(reason);
      return;
    }
    if (this.submissionGate?.setBlocked !== undefined) {
      this.submissionGate.setBlocked(true, reason);
    }
  }
}

function extractManifestMask(context: ValidatorRuntimeContext): ExecutionMaskSnapshot | undefined {
  const manifest = context.session_manifest;
  if (manifest === undefined) {
    return undefined;
  }
  const nested = asRecord(manifest.execution_capability_mask) ?? asRecord(manifest.execution_mask);
  if (nested !== undefined) {
    return nested;
  }
  if (manifest.mask_id === undefined && manifest.mask_version === undefined && manifest.mask_hash === undefined) {
    return undefined;
  }
  return {
    ...buildExecutionCapabilityMask(),
    ...(typeof manifest.mask_id === 'string' ? { mask_id: manifest.mask_id } : {}),
    ...(typeof manifest.mask_version === 'number' ? { mask_version: manifest.mask_version } : {}),
    ...(typeof manifest.mask_hash === 'string' ? { mask_hash: manifest.mask_hash } : {}),
  } as ExecutionMaskSnapshot;
}

function asMaskSnapshot(mask: ExecutionMaskSnapshot | ExecutionCapabilityMask): ExecutionMaskSnapshot {
  return mask as unknown as ExecutionMaskSnapshot;
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

function asRecord(value: unknown): ExecutionMaskSnapshot | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ExecutionMaskSnapshot)
    : undefined;
}

function stringValue(value: unknown): string {
  return value === undefined ? '' : String(value);
}
