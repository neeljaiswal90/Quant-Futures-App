import { isBrokerOriginatedEventType, type AnyJournalEventEnvelope, type JsonValue } from '../../contracts/index.js';
import type { ValidatorIssue, ValidatorRunner, ValidatorRuntimeContext } from './runner.js';
import { captureValidatorIssueEmittedTsNs } from './validator-time.js';

const VALIDATOR_ID = 'EXEC-VALIDATOR-02' as const;
const NS_PER_MS = 1_000_000n;
const DAY_NS = 86_400_000_000_000n;

export interface DualTimestampValidatorOptions {
  readonly nowMs?: () => number;
  readonly wallClockBandNs?: bigint;
}

export class DualTimestampValidator implements ValidatorRunner {
  private readonly nowMs: () => number;
  private readonly wallClockBandNs: bigint;

  constructor(options: DualTimestampValidatorOptions = {}) {
    this.nowMs = options.nowMs ?? Date.now;
    this.wallClockBandNs = options.wallClockBandNs ?? DAY_NS;
  }

  runOnEvent(
    event: AnyJournalEventEnvelope,
    context: ValidatorRuntimeContext = {},
  ): readonly ValidatorIssue[] {
    if (!isBrokerOriginatedEventType(event.type)) {
      return [];
    }

    const issues: ValidatorIssue[] = [];
    const exchangeTsNs = toBigInt(event.ts_ns) ?? 0n;
    const localTsNs = toBigInt(event.ts_ns_local);
    const bandNs = context.wall_clock_band_ns ?? this.wallClockBandNs;
    const nowNs = BigInt(Math.trunc(this.nowMs())) * NS_PER_MS;

    if (localTsNs === undefined) {
      issues.push(
        issue({
          code: 'broker_ts_ns_local_missing',
          severity: 'fatal',
          message: 'broker-originated event is missing ts_ns_local',
          context,
          event,
        }),
      );
      return issues;
    }

    if (absNs(exchangeTsNs - localTsNs) >= DAY_NS) {
      issues.push(
        issue({
          code: 'broker_exchange_local_delta_too_large',
          severity: 'fatal',
          message: 'broker-originated exchange and local timestamps differ by at least 24h',
          context,
          event,
          details: {
            exchange_ts_ns: exchangeTsNs.toString(),
            local_ts_ns: localTsNs.toString(),
            max_delta_ns_exclusive: DAY_NS.toString(),
          },
        }),
      );
    }

    for (const [label, tsNs] of [
      ['exchange', exchangeTsNs],
      ['local', localTsNs],
    ] as const) {
      if (absNs(tsNs - nowNs) > bandNs) {
        issues.push(
          issue({
            code: `broker_${label}_timestamp_outside_wall_clock_band`,
            severity: 'error',
            message: `broker-originated ${label} timestamp is outside the configured Date.now band`,
            context,
            event,
            details: {
              timestamp_ns: tsNs.toString(),
              now_ns: nowNs.toString(),
              band_ns: bandNs.toString(),
            },
          }),
        );
      }
    }

    return issues;
  }

  runOnSessionStart(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    void context;
    return [];
  }

  runOnPeriodicCadence(context: ValidatorRuntimeContext): readonly ValidatorIssue[] {
    void context;
    return [];
  }
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

function toBigInt(value: unknown): bigint | undefined {
  return typeof value === 'bigint' ? value : undefined;
}

function absNs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
