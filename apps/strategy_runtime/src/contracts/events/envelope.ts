import type {
  CausationId,
  CorrelationId,
  EventId,
  RunId,
  SessionId,
} from '../ids.js';
import type { ConfigLineageRef } from '../lineage.js';
import type { JsonValue } from '../serialization.js';
import { toJsonLine } from '../serialization.js';
import type { UnixNs, UnixNsInput } from '../time.js';
import { ns, reviveTimestampNsFields } from '../time.js';
import type { RuntimeEventType } from './event-types.js';

export const JOURNAL_EVENT_SCHEMA_VERSION = 1 as const;

export interface JournalEventEnvelope<
  TType extends RuntimeEventType = RuntimeEventType,
  TPayload extends JsonValue = JsonValue,
> {
  readonly schema_version: typeof JOURNAL_EVENT_SCHEMA_VERSION;
  readonly event_id: EventId;
  readonly type: TType;
  readonly ts_ns: UnixNs;
  readonly run_id: RunId;
  readonly session_id: SessionId;
  readonly payload: TPayload;
  readonly causation_id?: CausationId;
  readonly correlation_id?: CorrelationId;
  readonly config?: ConfigLineageRef;
}

export interface CreateJournalEventEnvelopeInput<
  TType extends RuntimeEventType,
  TPayload extends JsonValue,
> {
  readonly event_id: EventId;
  readonly type: TType;
  readonly ts_ns: UnixNsInput | UnixNs;
  readonly run_id: RunId;
  readonly session_id: SessionId;
  readonly payload: TPayload;
  readonly causation_id?: CausationId;
  readonly correlation_id?: CorrelationId;
  readonly config?: ConfigLineageRef;
}

export function createJournalEventEnvelope<
  TType extends RuntimeEventType,
  TPayload extends JsonValue,
>(input: CreateJournalEventEnvelopeInput<TType, TPayload>): JournalEventEnvelope<TType, TPayload> {
  const event = {
    schema_version: JOURNAL_EVENT_SCHEMA_VERSION,
    event_id: input.event_id,
    type: input.type,
    ts_ns: ns(input.ts_ns),
    run_id: input.run_id,
    session_id: input.session_id,
    payload: input.payload,
    ...(input.causation_id === undefined ? {} : { causation_id: input.causation_id }),
    ...(input.correlation_id === undefined ? {} : { correlation_id: input.correlation_id }),
    ...(input.config === undefined ? {} : { config: input.config }),
  };

  return event;
}

export function journalEventToJsonLine(event: JournalEventEnvelope): string {
  return toJsonLine(event as unknown as JsonValue);
}

export function journalEventFromJsonLine(line: string): JournalEventEnvelope {
  return reviveTimestampNsFields(JSON.parse(line)) as JournalEventEnvelope;
}
