import type { AnyJournalEventEnvelope, JsonValue } from '../../contracts/index.js';
import type { ValidatorIssue, ValidatorRunner, ValidatorRuntimeContext } from './runner.js';
import { captureValidatorIssueEmittedTsNs } from './validator-time.js';

const VALIDATOR_ID = 'EXEC-VALIDATOR-06' as const;
const REQUIRED_FIELDS = [
  {
    canonical: 'mask_id',
    aliases: ['mask_id', 'execution_mask_id'],
  },
  {
    canonical: 'mask_version',
    aliases: ['mask_version', 'execution_mask_version'],
  },
  {
    canonical: 'mask_hash',
    aliases: ['mask_hash', 'execution_mask_hash'],
  },
  {
    canonical: 'reconnect_policy_config',
    aliases: ['reconnect_policy_config', 'reconnect_policy', 'reconnectPolicy'],
  },
  {
    canonical: 'plant_scope',
    aliases: ['plant_scope'],
  },
  {
    canonical: 'mode',
    aliases: ['mode', 'session_mode', 'execution_mode'],
  },
  {
    canonical: 'timestamp_anchor',
    aliases: ['timestamp_anchor', 'timestamp-anchor'],
  },
] as const;

export class SessionManifestValidator implements ValidatorRunner {
  runOnSessionStart(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    return validateManifest(context);
  }

  runOnEvent(
    event: AnyJournalEventEnvelope,
    context: ValidatorRuntimeContext = {},
  ): readonly ValidatorIssue[] {
    void event;
    void context;
    return [];
  }

  runOnPeriodicCadence(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    return validateManifest(context);
  }
}

function validateManifest(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
  const manifest = context.session_manifest;
  if (manifest === undefined) {
    return [
      issue({
        code: 'session_manifest_missing',
        severity: 'fatal',
        message: 'session manifest is missing',
        context,
      }),
    ];
  }

  const issues: ValidatorIssue[] = [];
  for (const field of REQUIRED_FIELDS) {
    if (!field.aliases.some((alias) => hasMeaningfulValue(manifest[alias]))) {
      issues.push(
        issue({
          code: 'session_manifest_required_field_missing',
          severity: 'fatal',
          message: `session manifest is missing required field ${field.canonical}`,
          context,
          details: { field: field.canonical },
        }),
      );
    }
  }
  return issues;
}

function hasMeaningfulValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim() !== '';
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return value !== undefined && value !== null;
}

function issue(input: {
  readonly code: string;
  readonly severity: ValidatorIssue['severity'];
  readonly message: string;
  readonly context?: ValidatorRuntimeContext;
  readonly details?: Readonly<Record<string, JsonValue>>;
}): ValidatorIssue {
  return {
    validator_id: VALIDATOR_ID,
    severity: input.severity,
    emitted_ts_ns: captureValidatorIssueEmittedTsNs(),
    code: input.code,
    message: input.message,
    ...(input.context?.session_id === undefined ? {} : { session_id: input.context.session_id }),
    ...(input.context?.session_family_id === undefined
      ? {}
      : { session_family_id: input.context.session_family_id }),
    ...(input.details === undefined ? {} : { details: input.details }),
  };
}
