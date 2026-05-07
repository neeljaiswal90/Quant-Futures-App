import type { DatabentoSchema } from '../../contracts/tier-policy.js';
import { parseManifestSymbol } from '../bar-builder/manifest-symbol.js';
import {
  QueueSynthesisInputError,
  type QueueSynthesisIssue,
} from './queue-synthesis-input-error.js';
import type { QueueSynthesisMode, QueueSynthesisOptions } from './types.js';

const REFERENCE_ONLY_SCHEMAS: ReadonlySet<DatabentoSchema> = new Set([
  'definition',
  'status',
  'statistics',
]);

export function resolveQueueSynthesisMode(
  inputSchemas: readonly DatabentoSchema[],
  requestedMode: QueueSynthesisMode | 'auto',
): QueueSynthesisMode {
  if (requestedMode !== 'auto') {
    if (modeSupported(inputSchemas, requestedMode)) {
      return requestedMode;
    }
    throwUnsupportedMode(inputSchemas, requestedMode);
  }

  // MBO exposes order_id/action/side, but not explicit queue priority rank; this is
  // reconstruction evidence, not a ground-truth queue-position contract.
  if (inputSchemas.includes('mbo')) {
    return 'mbo_reconstruction';
  }
  if (inputSchemas.includes('mbp-1') && inputSchemas.includes('trades')) {
    return 'mbp_trades_proxy';
  }
  if (inputSchemas.includes('tbbo') && inputSchemas.includes('trades')) {
    return 'tbbo_trade_proxy';
  }
  if (inputSchemas.includes('mbp-10') || inputSchemas.includes('mbp-1')) {
    return 'mbp_proxy';
  }

  throwUnsupportedMode(inputSchemas, 'auto');
}

export function assertQueueSynthesisOptions(options: QueueSynthesisOptions): QueueSynthesisMode {
  const issues: QueueSynthesisIssue[] = [];

  if (options.instrument_root.trim() === '') {
    issues.push({
      path: '$.instrument_root',
      code: 'unsupported_input_schema',
      message: 'instrument_root must be non-empty',
    });
  }
  try {
    parseManifestSymbol(options.manifest_symbol);
  } catch {
    issues.push({
      path: '$.manifest_symbol',
      code: 'unsupported_input_schema',
      message: 'manifest_symbol must match a supported concrete, continuous, or root symbol',
    });
  }
  if (options.passive_order_quantity <= 0n) {
    issues.push({
      path: '$.passive_order_quantity',
      code: 'insufficient_queue_evidence',
      message: 'passive_order_quantity must be greater than 0',
    });
  }
  if (options.fill_horizon_ns <= 0n) {
    issues.push({
      path: '$.fill_horizon_ns',
      code: 'insufficient_queue_evidence',
      message: 'fill_horizon_ns must be greater than 0',
    });
  }
  if (options.depletion_lookback_ns <= 0n) {
    issues.push({
      path: '$.depletion_lookback_ns',
      code: 'insufficient_queue_evidence',
      message: 'depletion_lookback_ns must be greater than 0',
    });
  }

  let mode: QueueSynthesisMode | null = null;
  try {
    mode = resolveQueueSynthesisMode(options.input_schemas, options.mode);
  } catch (error) {
    if (error instanceof QueueSynthesisInputError) {
      issues.push(...error.issues);
    } else {
      throw error;
    }
  }

  if (issues.length > 0 || mode === null) {
    throw new QueueSynthesisInputError(issues);
  }
  return mode;
}

function modeSupported(
  inputSchemas: readonly DatabentoSchema[],
  mode: QueueSynthesisMode,
): boolean {
  switch (mode) {
    case 'mbo_reconstruction':
      return inputSchemas.includes('mbo');
    case 'mbp_proxy':
      return inputSchemas.includes('mbp-10') || inputSchemas.includes('mbp-1');
    case 'mbp_trades_proxy':
      return inputSchemas.includes('mbp-1') && inputSchemas.includes('trades');
    case 'tbbo_trade_proxy':
      return inputSchemas.includes('tbbo') && inputSchemas.includes('trades');
  }
}

function throwUnsupportedMode(
  inputSchemas: readonly DatabentoSchema[],
  requestedMode: QueueSynthesisMode | 'auto',
): never {
  if (inputSchemas.length === 0 || inputSchemas.every((schema) => REFERENCE_ONLY_SCHEMAS.has(schema))) {
    throw new QueueSynthesisInputError([
      {
        path: '$.input_schemas',
        code: 'insufficient_queue_evidence',
        message: 'queue synthesis requires MBO, MBP, or TBBO+trades evidence',
      },
    ]);
  }

  const nonReference = inputSchemas.filter((schema) => !REFERENCE_ONLY_SCHEMAS.has(schema));
  if (nonReference.length === 1 && nonReference[0] === 'ohlcv-1m') {
    throw new QueueSynthesisInputError([
      {
        path: '$.input_schemas',
        code: 'ohlcv_queue_synthesis_forbidden',
        message: 'OHLCV-only inputs cannot synthesize queue state',
      },
    ]);
  }
  if (nonReference.length === 1 && nonReference[0] === 'bbo') {
    throw new QueueSynthesisInputError([
      {
        path: '$.input_schemas',
        code: 'bbo_only_queue_synthesis_forbidden',
        message: 'BBO-only inputs cannot synthesize queue state',
      },
    ]);
  }

  throw new QueueSynthesisInputError([
    {
      path: '$.mode',
      code: 'unsupported_input_schema',
      message: `requested queue synthesis mode ${requestedMode} is not supported by input schemas ${inputSchemas.join(', ')}`,
    },
  ]);
}
