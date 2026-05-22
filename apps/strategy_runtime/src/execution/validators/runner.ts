import type { AnyJournalEventEnvelope, JsonValue, UnixNs } from '../../contracts/index.js';
import type { BrokerAccountSnapshotEntry, LiveAccountAllowlist } from '../brokers/account-allowlist.js';
import { AccountAllowlistValidator } from './account-allowlist.js';
import type { ExecutionCapabilityMask } from '../execution-capability-mask.js';
import { AckLineageValidator } from './ack-lineage.js';
import { DualTimestampValidator } from './dual-timestamp.js';
import { MaskCoherenceValidator } from './mask-coherence.js';
import { MaskDriftValidator, type MaskArtifactLoader, type SubmissionGateLike } from './mask-drift.js';
import { ModeTransitionValidator } from './mode-transition.js';
import { PlantScopeValidator } from './plant-scope.js';
import { SessionManifestValidator } from './session-manifest.js';
import { TsPythonParityValidator, type PythonMaskExporter } from './ts-python-parity.js';

export const EXECUTION_VALIDATOR_IDS = [
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

export type ExecutionValidatorId = (typeof EXECUTION_VALIDATOR_IDS)[number];
export type ValidatorIssueSeverity = 'info' | 'warning' | 'error' | 'fatal';

export interface ValidatorIssue {
  readonly validator_id: ExecutionValidatorId;
  readonly severity: ValidatorIssueSeverity;
  readonly emitted_ts_ns: UnixNs;
  readonly code: string;
  readonly message: string;
  readonly session_id?: string;
  readonly session_family_id?: string;
  readonly event_id?: string;
  readonly event_type?: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

export interface ExecutionMaskSnapshot extends Readonly<Record<string, unknown>> {
  readonly schema_version?: number;
  readonly mask_version?: number;
  readonly mask_id?: string;
  readonly mask_hash?: string;
}

export interface ValidatorSessionManifest extends Readonly<Record<string, unknown>> {}

export interface ValidatorRuntimeContext {
  readonly session_id?: string;
  readonly session_family_id?: string;
  readonly session_manifest?: ValidatorSessionManifest;
  readonly execution_mask?: ExecutionMaskSnapshot | ExecutionCapabilityMask;
  readonly artifact_mask?: ExecutionMaskSnapshot | ExecutionCapabilityMask;
  readonly plant_scope?: string | readonly string[];
  readonly mode?: string;
  readonly execution_phase?: string;
  readonly timestamp_anchor?: string;
  readonly wall_clock_band_ns?: bigint;
  readonly live_account_allowlist?: LiveAccountAllowlist;
  readonly account_list_snapshot?: readonly BrokerAccountSnapshotEntry[];
}

export interface ValidatorRunner {
  runOnEvent(
    event: AnyJournalEventEnvelope,
    context?: ValidatorRuntimeContext,
  ): readonly ValidatorIssue[];
  runOnSessionStart(context: ValidatorRuntimeContext): readonly ValidatorIssue[];
  runOnPeriodicCadence(context: ValidatorRuntimeContext): readonly ValidatorIssue[];
}

export interface ExecutionValidatorRunnerOptions {
  readonly validators?: readonly ValidatorRunner[];
  readonly nowMs?: () => number;
  readonly wallClockBandNs?: bigint;
  readonly artifactMaskLoader?: MaskArtifactLoader;
  readonly pythonMaskExporter?: PythonMaskExporter;
  readonly submissionGate?: SubmissionGateLike;
}

export class ExecutionValidatorRunner implements ValidatorRunner {
  constructor(private readonly validators: readonly ValidatorRunner[]) {}

  runOnEvent(
    event: AnyJournalEventEnvelope,
    context: ValidatorRuntimeContext = {},
  ): readonly ValidatorIssue[] {
    return this.validators.flatMap((validator) => validator.runOnEvent(event, context));
  }

  runOnSessionStart(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    return this.validators.flatMap((validator) => validator.runOnSessionStart(context));
  }

  runOnPeriodicCadence(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    return this.validators.flatMap((validator) => validator.runOnPeriodicCadence(context));
  }
}

export function createExecutionValidatorRunner(
  options: ExecutionValidatorRunnerOptions = {},
): ExecutionValidatorRunner {
  return new ExecutionValidatorRunner(
    options.validators ?? [
      new MaskCoherenceValidator(),
      new DualTimestampValidator({
        nowMs: options.nowMs,
        wallClockBandNs: options.wallClockBandNs,
      }),
      new AckLineageValidator(),
      new ModeTransitionValidator(),
      new PlantScopeValidator(),
      new SessionManifestValidator(),
      new MaskDriftValidator({
        artifactMaskLoader: options.artifactMaskLoader,
        submissionGate: options.submissionGate,
      }),
      new TsPythonParityValidator({ pythonMaskExporter: options.pythonMaskExporter }),
      new AccountAllowlistValidator(),
    ],
  );
}

export {
  AccountAllowlistValidator,
  AckLineageValidator,
  DualTimestampValidator,
  MaskCoherenceValidator,
  MaskDriftValidator,
  ModeTransitionValidator,
  PlantScopeValidator,
  SessionManifestValidator,
  TsPythonParityValidator,
};
