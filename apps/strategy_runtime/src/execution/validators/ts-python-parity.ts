import { spawnSync } from 'node:child_process';
import { stableJsonStringify, type AnyJournalEventEnvelope, type JsonValue } from '../../contracts/index.js';
import { buildExecutionCapabilityMask } from '../execution-capability-mask.js';
import type { ValidatorIssue, ValidatorRunner, ValidatorRuntimeContext } from './runner.js';
import { captureValidatorIssueEmittedTsNs } from './validator-time.js';

const VALIDATOR_ID = 'EXEC-VALIDATOR-08' as const;
const PYTHON_MODULE = 'services.market_data_sidecar.execution.execution_capability_mask';
const PYTHON_EXPORT_TIMEOUT_MS = 30_000;

export type PythonMaskExporter = () => string;

export interface TsPythonParityValidatorOptions {
  readonly pythonMaskExporter?: PythonMaskExporter;
}

export class TsPythonParityValidator implements ValidatorRunner {
  private readonly pythonMaskExporter: PythonMaskExporter;

  constructor(options: TsPythonParityValidatorOptions = {}) {
    this.pythonMaskExporter = options.pythonMaskExporter ?? defaultPythonMaskExporter;
  }

  runOnEvent(
    event: AnyJournalEventEnvelope,
    context: ValidatorRuntimeContext = {},
  ): readonly ValidatorIssue[] {
    void event;
    void context;
    return [];
  }

  runOnSessionStart(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    return this.compare(context);
  }

  runOnPeriodicCadence(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    return this.compare(context);
  }

  private compare(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    let pythonMask: unknown;
    try {
      pythonMask = JSON.parse(this.pythonMaskExporter());
    } catch (error) {
      return [
        issue({
          code: error instanceof PythonMaskExportTimeoutError
            ? 'python_execution_mask_export_timeout'
            : 'python_execution_mask_unavailable',
          severity: 'fatal',
          message: error instanceof PythonMaskExportTimeoutError
            ? 'Python execution capability mask export timed out'
            : 'Python execution capability mask export failed or returned invalid JSON',
          context,
          details: { error: error instanceof Error ? error.message : String(error) },
        }),
      ];
    }

    const tsMask = buildExecutionCapabilityMask();
    const tsJson = stableJsonStringify(tsMask as unknown as JsonValue);
    const pythonJson = stableJsonStringify(pythonMask as JsonValue);
    if (tsJson === pythonJson) {
      return [];
    }
    return [
      issue({
        code: 'ts_python_execution_mask_mismatch',
        severity: 'fatal',
        message: 'TypeScript and Python execution capability masks are not structurally equivalent',
        context,
        details: {
          ts_mask_hash: tsMask.mask_hash,
          python_mask_hash: pythonMaskHash(pythonMask),
        },
      }),
    ];
  }
}

function defaultPythonMaskExporter(): string {
  const result = spawnSync(
    process.env.PYTHON ?? 'python',
    ['-m', PYTHON_MODULE, '--export-json'],
    { cwd: process.cwd(), encoding: 'utf8', timeout: PYTHON_EXPORT_TIMEOUT_MS },
  );
  if (result.error !== undefined) {
    if (isTimeoutError(result.error)) {
      throw new PythonMaskExportTimeoutError(PYTHON_EXPORT_TIMEOUT_MS, result.stdout, result.stderr);
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Python execution capability mask export failed (${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
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

function pythonMaskHash(value: unknown): string {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? String((value as Record<string, unknown>).mask_hash ?? '')
    : '';
}

function isTimeoutError(error: Error): boolean {
  return 'code' in error && error.code === 'ETIMEDOUT';
}

class PythonMaskExportTimeoutError extends Error {
  constructor(timeoutMs: number, stdout: string | Buffer, stderr: string | Buffer) {
    super(
      `Python execution capability mask export timed out after ${timeoutMs}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  }
}
