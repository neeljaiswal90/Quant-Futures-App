import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import {
  argv as processArgv,
  cwd as processCwd,
  exit as processExit,
  stderr as processStderr,
  stdout as processStdout,
} from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  createJournalEventEnvelope,
  formatJournalEventSchemaValidationErrors,
  journalEventFromJsonLine,
  stableJsonStringify,
  validateJournalEventEnvelope,
  type AnyJournalEventEnvelope,
  type JournalEventEnvelope,
  type JournalEventPayloadFor,
  type JsonValue,
} from '../../apps/strategy_runtime/src/contracts/index.js';
import {
  buildFeatureAvailabilityMask,
  type FeatureAvailabilityMask,
} from '../../apps/strategy_runtime/src/features/availability-mask.js';
import {
  makeCausationId,
  makeEventId,
  makeFeatureSnapshotId,
  makeRunId,
  makeSessionId,
} from '../../apps/strategy_runtime/src/contracts/ids.js';
import { forEachJsonlLine, sha256File } from '../sim/streaming-jsonl.js';

export const ORCH_MBO_01_REPORT_SCHEMA_VERSION = 1 as const;
export const ORCH_MBO_01_TICKET_ID = 'ORCH-MBO-01' as const;
export const ORCH_MBO_01_PRODUCER_VERSION = 'orch-mbo-01-shadow-producer-v1' as const;

const DEFAULT_OUT_JOURNAL = 'reports/rel/orch_mbo_01_shadow_runtime_journal.jsonl';
const DEFAULT_REPORT = 'reports/rel/orch_mbo_01_shadow_producer_report.json';
const DEFAULT_WINDOW_EVENT_COUNT = 100;
const DEFAULT_EMIT_EVERY = 100;
const NO_RAW_DATA_STATEMENT =
  'ORCH-MBO-01 reports paths, SHA-256 hashes, event counts, field names, derivation methods, and safety posture only. It does not embed raw MBO records, market-data payload values, shadow payload values, DBN files, runtime payload values, credentials, stdout, or stderr.';

type OrchMbo01Status = 'generated' | 'no_shadow_telemetry' | 'requires_inputs' | 'failed';
export type OrchMbo01ExitCode = 0 | 2 | 3;
type SupportedShadowField =
  | 'cancel_add_ratio_shadow'
  | 'mbo_action_imbalance_shadow'
  | 'order_lifetime_shadow';
type MboAction = 'add' | 'modify' | 'cancel' | 'unknown';

const SUPPORTED_METHODS: Readonly<Record<SupportedShadowField, string>> = {
  cancel_add_ratio_shadow: 'mbo_cancel_add_ratio_v1',
  mbo_action_imbalance_shadow: 'mbo_action_imbalance_v1',
  order_lifetime_shadow: 'mbo_order_lifetime_mean_ms_v1',
};
const SUPPORTED_SHADOW_FIELDS = Object.keys(SUPPORTED_METHODS) as readonly SupportedShadowField[];

export interface OrchMbo01Options {
  readonly cwd?: string;
  readonly runtime_journal: string;
  readonly mbo_source_journal: string;
  readonly out_journal?: string;
  readonly report?: string;
  readonly run_id: string;
  readonly session_id: string;
  readonly window_event_count?: number;
  readonly emit_every?: number;
  readonly max_shadow_events?: number;
}

type MutableOrchMbo01Options = {
  -readonly [K in keyof OrchMbo01Options]?: OrchMbo01Options[K];
};

export interface OrchMbo01Report {
  readonly schema_version: typeof ORCH_MBO_01_REPORT_SCHEMA_VERSION;
  readonly ticket_id: typeof ORCH_MBO_01_TICKET_ID;
  readonly producer_version: typeof ORCH_MBO_01_PRODUCER_VERSION;
  readonly status: OrchMbo01Status;
  readonly input: {
    readonly runtime_journal: JournalSummary;
    readonly mbo_source_journal: MboSourceSummary;
  };
  readonly output: {
    readonly out_journal: string;
    readonly out_journal_hash: string | null;
    readonly report: string;
  };
  readonly mask: {
    readonly mask_version: number;
    readonly mask_id: string;
    readonly mask_hash: string;
  };
  readonly generation: {
    readonly window_event_count: number;
    readonly emit_every: number;
    readonly max_shadow_events: number | null;
    readonly runtime_events_copied: number;
    readonly source_mbo_events_indexed: number;
    readonly shadow_events_emitted: number;
    readonly shadow_field_occurrences: number;
    readonly fields_emitted: readonly SupportedShadowField[];
    readonly derivation_methods: Readonly<Record<SupportedShadowField, string>>;
  };
  readonly safety_posture: {
    readonly producer_mode: 'offline_post_processor';
    readonly execution_mode: 'unchanged_simulated_only';
    readonly decision_use: false;
    readonly runtime_values_payload_mutated: false;
    readonly real_orders_allowed: false;
    readonly mbo_decision_use_allowed: false;
    readonly unsupported_shadow_fields_emitted: readonly string[];
  };
  readonly manifest_session_patch: {
    readonly journal: string;
    readonly mbo_source_journal: string;
    readonly mbo_source_journal_sha256: string | null;
  };
  readonly real_order_event_types_emitted: 0;
  readonly blocked_feature_fields_emitted: readonly string[];
  readonly restricted_feature_fields_emitted: readonly string[];
  readonly reasons: readonly string[];
  readonly no_raw_data_statement: typeof NO_RAW_DATA_STATEMENT;
  readonly next_blocker: string;
}

interface JournalSummary {
  readonly path: string;
  readonly exists: boolean;
  readonly sha256: string | null;
  readonly size_bytes: number | null;
  readonly events_scanned: number;
  readonly parse_error_count: number;
  readonly schema_error_count: number;
}

interface MboSourceSummary extends JournalSummary {
  readonly mbo_events_indexed: number;
  readonly malformed_mbo_event_count: number;
  readonly action_counts: Readonly<Record<MboAction, number>>;
}

interface LoadedRuntimeJournal {
  readonly events: readonly AnyJournalEventEnvelope[];
  readonly summary: JournalSummary;
}

interface LoadedMboSourceJournal {
  readonly events: readonly SourceMboEvent[];
  readonly summary: MboSourceSummary;
}

interface SourceMboEvent {
  readonly event_id: string;
  readonly ts_ns: bigint;
  readonly action: MboAction;
  readonly order_id: string | null;
}

interface ShadowEventBuild {
  readonly event: JournalEventEnvelope<'FEATURES', JournalEventPayloadFor<'FEATURES'> & ShadowPayloadExtension>;
  readonly field_occurrences: number;
}

interface ShadowPayloadExtension {
  readonly source: 'orch_mbo_01_shadow_producer';
  readonly shadow_values: Readonly<Record<SupportedShadowField, number | null>>;
  readonly decision_use: false;
  readonly mbo_shadow_lineage: {
    readonly schema_version: 1;
    readonly source_journal_sha256: string;
    readonly fields: Readonly<Record<SupportedShadowField, ShadowFieldLineageJson>>;
  };
  readonly feature_availability_mask: FeatureAvailabilityMask;
}

interface ShadowFieldLineageJson {
  readonly derivation_method: string;
  readonly source_event_ids: readonly string[];
  readonly source_window_start_ts_ns: bigint;
  readonly source_window_end_ts_ns: bigint;
}

interface GenerationInput {
  readonly cwd: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly sourceHash: string;
  readonly runtimeEvents: readonly AnyJournalEventEnvelope[];
  readonly sourceEvents: readonly SourceMboEvent[];
  readonly mask: FeatureAvailabilityMask;
  readonly windowEventCount: number;
  readonly emitEvery: number;
  readonly maxShadowEvents: number | null;
}

class JsonlWriter {
  private readonly fd: number;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, 'w');
  }

  write(value: JsonValue): void {
    writeSync(this.fd, `${stableJsonStringify(value)}\n`, null, 'utf8');
  }

  close(): void {
    closeSync(this.fd);
  }
}

export async function runOrchMbo01ShadowProducer(
  options: OrchMbo01Options,
): Promise<{ readonly report: OrchMbo01Report; readonly exit_code: OrchMbo01ExitCode }> {
  const cwd = resolve(options.cwd ?? processCwd());
  const runtimeJournal = resolve(cwd, options.runtime_journal);
  const mboSourceJournal = resolve(cwd, options.mbo_source_journal);
  const outJournal = resolve(cwd, options.out_journal ?? DEFAULT_OUT_JOURNAL);
  const reportPath = resolve(cwd, options.report ?? DEFAULT_REPORT);
  const windowEventCount = positiveInteger(options.window_event_count ?? DEFAULT_WINDOW_EVENT_COUNT, 'window_event_count');
  const emitEvery = positiveInteger(options.emit_every ?? DEFAULT_EMIT_EVERY, 'emit_every');
  const maxShadowEvents = options.max_shadow_events === undefined
    ? null
    : positiveInteger(options.max_shadow_events, 'max_shadow_events');
  const mask = buildFeatureAvailabilityMask();

  mkdirSync(dirname(reportPath), { recursive: true });

  const missing = [
    ...(existsSync(runtimeJournal) ? [] : [`runtime_journal:${toReportPath(cwd, runtimeJournal)}`]),
    ...(existsSync(mboSourceJournal) ? [] : [`mbo_source_journal:${toReportPath(cwd, mboSourceJournal)}`]),
  ];
  if (missing.length > 0) {
    const report = buildReport({
      cwd,
      status: 'requires_inputs',
      runtimeSummary: emptyJournalSummary(cwd, runtimeJournal),
      sourceSummary: emptyMboSourceSummary(cwd, mboSourceJournal),
      outJournal,
      reportPath,
      outJournalHash: null,
      mask,
      windowEventCount,
      emitEvery,
      maxShadowEvents,
      runtimeEventsCopied: 0,
      shadowEventsEmitted: 0,
      shadowFieldOccurrences: 0,
      sourceHash: null,
      reasons: missing,
    });
    writeReport(reportPath, report);
    return { report, exit_code: 2 };
  }

  try {
    const runtime = loadRuntimeJournal(cwd, runtimeJournal);
    const source = loadMboSourceJournal(cwd, mboSourceJournal);
    const reasons = [
      ...(runtime.summary.parse_error_count > 0 ? ['runtime_journal_parse_errors'] : []),
      ...(runtime.summary.schema_error_count > 0 ? ['runtime_journal_schema_errors'] : []),
      ...(source.summary.parse_error_count > 0 ? ['mbo_source_journal_parse_errors'] : []),
      ...(source.summary.malformed_mbo_event_count > 0 ? ['mbo_source_journal_malformed_mbo_events'] : []),
    ];

    if (reasons.length > 0) {
      const report = buildReport({
        cwd,
        status: 'failed',
        runtimeSummary: runtime.summary,
        sourceSummary: source.summary,
        outJournal,
        reportPath,
        outJournalHash: null,
        mask,
        windowEventCount,
        emitEvery,
        maxShadowEvents,
        runtimeEventsCopied: runtime.events.length,
        shadowEventsEmitted: 0,
        shadowFieldOccurrences: 0,
        sourceHash: source.summary.sha256,
        reasons,
      });
      writeReport(reportPath, report);
      return { report, exit_code: 3 };
    }

    if (source.events.length === 0 || source.summary.sha256 === null) {
      const report = buildReport({
        cwd,
        status: 'no_shadow_telemetry',
        runtimeSummary: runtime.summary,
        sourceSummary: source.summary,
        outJournal,
        reportPath,
        outJournalHash: null,
        mask,
        windowEventCount,
        emitEvery,
        maxShadowEvents,
        runtimeEventsCopied: runtime.events.length,
        shadowEventsEmitted: 0,
        shadowFieldOccurrences: 0,
        sourceHash: source.summary.sha256,
        reasons: ['no_mbo_source_events_indexed'],
      });
      writeReport(reportPath, report);
      return { report, exit_code: 2 };
    }

    const shadowEvents = buildShadowEvents({
      cwd,
      runId: options.run_id,
      sessionId: options.session_id,
      sourceHash: source.summary.sha256,
      runtimeEvents: runtime.events,
      sourceEvents: source.events,
      mask,
      windowEventCount,
      emitEvery,
      maxShadowEvents,
    });
    if (shadowEvents.length === 0) {
      const report = buildReport({
        cwd,
        status: 'no_shadow_telemetry',
        runtimeSummary: runtime.summary,
        sourceSummary: source.summary,
        outJournal,
        reportPath,
        outJournalHash: null,
        mask,
        windowEventCount,
        emitEvery,
        maxShadowEvents,
        runtimeEventsCopied: runtime.events.length,
        shadowEventsEmitted: 0,
        shadowFieldOccurrences: 0,
        sourceHash: source.summary.sha256,
        reasons: ['no_shadow_events_generated'],
      });
      writeReport(reportPath, report);
      return { report, exit_code: 2 };
    }

    writeMergedJournal(outJournal, runtime.events, shadowEvents.map((item) => item.event));
    const outJournalHash = sha256File(outJournal);
    const shadowFieldOccurrences = sum(shadowEvents.map((item) => item.field_occurrences));
    const report = buildReport({
      cwd,
      status: 'generated',
      runtimeSummary: runtime.summary,
      sourceSummary: source.summary,
      outJournal,
      reportPath,
      outJournalHash,
      mask,
      windowEventCount,
      emitEvery,
      maxShadowEvents,
      runtimeEventsCopied: runtime.events.length,
      shadowEventsEmitted: shadowEvents.length,
      shadowFieldOccurrences,
      sourceHash: source.summary.sha256,
      reasons: [],
    });
    writeReport(reportPath, report);
    return { report, exit_code: 0 };
  } catch (error) {
    const runtimeSummary = existsSync(runtimeJournal) ? safeRuntimeSummary(cwd, runtimeJournal) : emptyJournalSummary(cwd, runtimeJournal);
    const sourceSummary = existsSync(mboSourceJournal)
      ? safeMboSourceSummary(cwd, mboSourceJournal)
      : emptyMboSourceSummary(cwd, mboSourceJournal);
    const report = buildReport({
      cwd,
      status: 'failed',
      runtimeSummary,
      sourceSummary,
      outJournal,
      reportPath,
      outJournalHash: null,
      mask,
      windowEventCount,
      emitEvery,
      maxShadowEvents,
      runtimeEventsCopied: 0,
      shadowEventsEmitted: 0,
      shadowFieldOccurrences: 0,
      sourceHash: sourceSummary.sha256,
      reasons: [error instanceof Error ? error.message : String(error)],
    });
    writeReport(reportPath, report);
    return { report, exit_code: 3 };
  }
}

function loadRuntimeJournal(cwd: string, path: string): LoadedRuntimeJournal {
  const events: AnyJournalEventEnvelope[] = [];
  let eventsScanned = 0;
  let parseErrorCount = 0;
  let schemaErrorCount = 0;

  forEachJsonlLine(path, (line) => {
    if (line.trim() === '') return;
    eventsScanned += 1;
    try {
      const event = journalEventFromJsonLine(line) as AnyJournalEventEnvelope;
      const validation = validateJournalEventEnvelope(event);
      if (!validation.ok) {
        schemaErrorCount += 1;
        return;
      }
      events.push(validation.event as AnyJournalEventEnvelope);
    } catch {
      parseErrorCount += 1;
    }
  });

  return {
    events,
    summary: {
      path: toReportPath(cwd, path),
      exists: true,
      sha256: sha256File(path),
      size_bytes: statSync(path).size,
      events_scanned: eventsScanned,
      parse_error_count: parseErrorCount,
      schema_error_count: schemaErrorCount,
    },
  };
}

function loadMboSourceJournal(cwd: string, path: string): LoadedMboSourceJournal {
  const events: SourceMboEvent[] = [];
  let eventsScanned = 0;
  let parseErrorCount = 0;
  let malformedMboEventCount = 0;
  const actionCounts = emptyActionCounts();

  forEachJsonlLine(path, (line) => {
    if (line.trim() === '') return;
    eventsScanned += 1;
    try {
      const event = journalEventFromJsonLine(line);
      const parsed = sourceMboEventFromJournalEvent(event);
      if (parsed === null) return;
      if (!isUsableSourceMboEvent(parsed)) {
        malformedMboEventCount += 1;
        return;
      }
      events.push(parsed);
      actionCounts[parsed.action] += 1;
    } catch {
      parseErrorCount += 1;
    }
  });

  const sortedEvents = events.slice().sort(compareSourceMboEvents);
  return {
    events: sortedEvents,
    summary: {
      path: toReportPath(cwd, path),
      exists: true,
      sha256: sha256File(path),
      size_bytes: statSync(path).size,
      events_scanned: eventsScanned,
      parse_error_count: parseErrorCount,
      schema_error_count: 0,
      mbo_events_indexed: sortedEvents.length,
      malformed_mbo_event_count: malformedMboEventCount,
      action_counts: sortedActionCounts(actionCounts),
    },
  };
}

function sourceMboEventFromJournalEvent(event: JournalEventEnvelope): SourceMboEvent | null {
  if (event.type !== 'MICROSTRUCTURE') return null;
  const payload = jsonObject(event.payload);
  if (payload === null) return null;
  const source = stringValue(payload.source) ?? stringValue(payload.microstructure_kind);
  if (source === null || !source.startsWith('mbo_')) return null;
  const values = jsonObject(payload.values);
  return {
    event_id: String(event.event_id),
    ts_ns: optionalBigInt(event.ts_ns) ?? optionalBigInt(payload.exchange_event_ts_ns) ?? 0n,
    action: normalizeMboAction(payload.action ?? payload.raw_action ?? values?.mbo_action),
    order_id: stringValue(payload.order_id) ?? stringValue(values?.mbo_order_id),
  };
}

function isUsableSourceMboEvent(event: SourceMboEvent): boolean {
  return event.event_id.trim() !== '' && event.ts_ns > 0n;
}

function buildShadowEvents(input: GenerationInput): readonly ShadowEventBuild[] {
  const shadowEvents: ShadowEventBuild[] = [];
  const window: SourceMboEvent[] = [];
  const maxShadowEvents = input.maxShadowEvents ?? Number.POSITIVE_INFINITY;
  for (let index = 0; index < input.sourceEvents.length; index += 1) {
    const sourceEvent = input.sourceEvents[index]!;
    window.push(sourceEvent);
    while (window.length > input.windowEventCount) {
      window.shift();
    }
    const isEmitBoundary = (index + 1) % input.emitEvery === 0 || index === input.sourceEvents.length - 1;
    if (!isEmitBoundary || shadowEvents.length >= maxShadowEvents) {
      continue;
    }
    const shadowEvent = buildShadowEvent(input, window, shadowEvents.length + 1);
    if (shadowEvent !== null) {
      shadowEvents.push(shadowEvent);
    }
  }
  return shadowEvents;
}

function buildShadowEvent(
  input: GenerationInput,
  window: readonly SourceMboEvent[],
  sequence: number,
): ShadowEventBuild | null {
  const sourceEvents = window.slice().sort(compareSourceMboEvents);
  const firstSource = sourceEvents[0];
  const lastSource = sourceEvents[sourceEvents.length - 1];
  if (firstSource === undefined || lastSource === undefined) {
    throw new Error('ORCH-MBO-01 cannot build shadow event from an empty source window');
  }
  const anchor = findRuntimeCausationAnchor(input.runtimeEvents, lastSource.ts_ns);
  if (anchor === null) {
    return null;
  }
  const shadowValues: Readonly<Record<SupportedShadowField, number | null>> = {
    cancel_add_ratio_shadow: recomputeShadowField('cancel_add_ratio_shadow', sourceEvents),
    mbo_action_imbalance_shadow: recomputeShadowField('mbo_action_imbalance_shadow', sourceEvents),
    order_lifetime_shadow: recomputeShadowField('order_lifetime_shadow', sourceEvents),
  };
  const lineageFields = SUPPORTED_SHADOW_FIELDS.reduce<Record<SupportedShadowField, ShadowFieldLineageJson>>(
    (accumulator, field) => {
      accumulator[field] = {
        derivation_method: SUPPORTED_METHODS[field],
        source_event_ids: sourceEvents.map((event) => event.event_id),
        source_window_start_ts_ns: firstSource.ts_ns,
        source_window_end_ts_ns: lastSource.ts_ns,
      };
      return accumulator;
    },
    {} as Record<SupportedShadowField, ShadowFieldLineageJson>,
  );
  const eventId = `orch-mbo-01-shadow-${sanitizeId(input.runId)}-${padSequence(sequence)}`;
  const featureSnapshotId = `orch-mbo-01-shadow-feature-${sanitizeId(input.runId)}-${padSequence(sequence)}`;
  const payload: JournalEventPayloadFor<'FEATURES'> & ShadowPayloadExtension = {
    feature_snapshot_id: makeFeatureSnapshotId(featureSnapshotId),
    source_event_id: makeEventId(lastSource.event_id),
    source: 'orch_mbo_01_shadow_producer',
    values: {},
    shadow_values: shadowValues,
    decision_use: false,
    mbo_shadow_lineage: {
      schema_version: 1,
      source_journal_sha256: input.sourceHash,
      fields: lineageFields,
    },
    feature_availability_mask: input.mask,
  };
  const event = createJournalEventEnvelope({
    event_id: makeEventId(eventId),
    type: 'FEATURES',
    ts_ns: anchor.ts_ns,
    run_id: makeRunId(input.runId),
    session_id: makeSessionId(input.sessionId),
    causation_id: makeCausationId(anchor.event_id),
    payload,
  });
  assertValidEvent(event, eventId);
  return { event, field_occurrences: SUPPORTED_SHADOW_FIELDS.length };
}

function findRuntimeCausationAnchor(
  runtimeEvents: readonly AnyJournalEventEnvelope[],
  sourceWindowEndTsNs: bigint,
): { readonly event_id: string; readonly ts_ns: bigint } | null {
  for (const event of runtimeEvents) {
    if (BigInt(event.ts_ns) >= sourceWindowEndTsNs) {
      return { event_id: event.event_id, ts_ns: BigInt(event.ts_ns) };
    }
  }
  return null;
}

function recomputeShadowField(field: SupportedShadowField, sourceEvents: readonly SourceMboEvent[]): number | null {
  const addCount = sourceEvents.filter((event) => event.action === 'add').length;
  const cancelCount = sourceEvents.filter((event) => event.action === 'cancel').length;
  if (field === 'cancel_add_ratio_shadow') {
    return cancelCount / Math.max(1, addCount);
  }
  if (field === 'mbo_action_imbalance_shadow') {
    return (addCount - cancelCount) / Math.max(1, addCount + cancelCount);
  }

  const starts = new Map<string, bigint>();
  const lifetimesMs: number[] = [];
  for (const event of sourceEvents.slice().sort(compareSourceMboEvents)) {
    if (event.order_id === null) continue;
    if (event.action === 'add' && !starts.has(event.order_id)) {
      starts.set(event.order_id, event.ts_ns);
    }
    if (event.action === 'cancel') {
      const start = starts.get(event.order_id);
      if (start !== undefined && event.ts_ns >= start) {
        lifetimesMs.push(Number(event.ts_ns - start) / 1_000_000);
      }
    }
  }
  if (lifetimesMs.length === 0) return null;
  return sum(lifetimesMs) / lifetimesMs.length;
}

function writeMergedJournal(
  outJournal: string,
  runtimeEvents: readonly AnyJournalEventEnvelope[],
  shadowEvents: readonly JournalEventEnvelope<'FEATURES', JournalEventPayloadFor<'FEATURES'> & ShadowPayloadExtension>[],
): void {
  const sortedShadow = shadowEvents.slice().sort(compareJournalEvents);
  const writer = new JsonlWriter(outJournal);
  let shadowIndex = 0;
  try {
    for (const runtimeEvent of runtimeEvents) {
      while (
        shadowIndex < sortedShadow.length &&
        sortedShadow[shadowIndex] !== undefined &&
        BigInt(sortedShadow[shadowIndex]!.ts_ns) < BigInt(runtimeEvent.ts_ns)
      ) {
        writer.write(toSerializableJson(sortedShadow[shadowIndex]!));
        shadowIndex += 1;
      }
      writer.write(toSerializableJson(runtimeEvent));
    }
    while (shadowIndex < sortedShadow.length) {
      writer.write(toSerializableJson(sortedShadow[shadowIndex]!));
      shadowIndex += 1;
    }
  } finally {
    writer.close();
  }
}

function buildReport(input: {
  readonly cwd: string;
  readonly status: OrchMbo01Status;
  readonly runtimeSummary: JournalSummary;
  readonly sourceSummary: MboSourceSummary;
  readonly outJournal: string;
  readonly reportPath: string;
  readonly outJournalHash: string | null;
  readonly mask: FeatureAvailabilityMask;
  readonly windowEventCount: number;
  readonly emitEvery: number;
  readonly maxShadowEvents: number | null;
  readonly runtimeEventsCopied: number;
  readonly shadowEventsEmitted: number;
  readonly shadowFieldOccurrences: number;
  readonly sourceHash: string | null;
  readonly reasons: readonly string[];
}): OrchMbo01Report {
  return {
    schema_version: ORCH_MBO_01_REPORT_SCHEMA_VERSION,
    ticket_id: ORCH_MBO_01_TICKET_ID,
    producer_version: ORCH_MBO_01_PRODUCER_VERSION,
    status: input.status,
    input: {
      runtime_journal: input.runtimeSummary,
      mbo_source_journal: input.sourceSummary,
    },
    output: {
      out_journal: toReportPath(input.cwd, input.outJournal),
      out_journal_hash: input.outJournalHash,
      report: toReportPath(input.cwd, input.reportPath),
    },
    mask: {
      mask_version: input.mask.mask_version,
      mask_id: input.mask.mask_id,
      mask_hash: input.mask.mask_hash,
    },
    generation: {
      window_event_count: input.windowEventCount,
      emit_every: input.emitEvery,
      max_shadow_events: input.maxShadowEvents,
      runtime_events_copied: input.runtimeEventsCopied,
      source_mbo_events_indexed: input.sourceSummary.mbo_events_indexed,
      shadow_events_emitted: input.shadowEventsEmitted,
      shadow_field_occurrences: input.shadowFieldOccurrences,
      fields_emitted: SUPPORTED_SHADOW_FIELDS,
      derivation_methods: SUPPORTED_METHODS,
    },
    safety_posture: {
      producer_mode: 'offline_post_processor',
      execution_mode: 'unchanged_simulated_only',
      decision_use: false,
      runtime_values_payload_mutated: false,
      real_orders_allowed: false,
      mbo_decision_use_allowed: false,
      unsupported_shadow_fields_emitted: [],
    },
    manifest_session_patch: {
      journal: toReportPath(input.cwd, input.outJournal),
      mbo_source_journal: input.sourceSummary.path,
      mbo_source_journal_sha256: input.sourceHash,
    },
    real_order_event_types_emitted: 0,
    blocked_feature_fields_emitted: [],
    restricted_feature_fields_emitted: [],
    reasons: input.reasons,
    no_raw_data_statement: NO_RAW_DATA_STATEMENT,
    next_blocker: nextBlocker(input.status),
  };
}

function writeReport(path: string, report: OrchMbo01Report): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stableJsonStringify(report as unknown as JsonValue)}\n`, 'utf8');
}

function safeRuntimeSummary(cwd: string, path: string): JournalSummary {
  return {
    path: toReportPath(cwd, path),
    exists: existsSync(path),
    sha256: existsSync(path) ? sha256File(path) : null,
    size_bytes: existsSync(path) ? statSync(path).size : null,
    events_scanned: 0,
    parse_error_count: 0,
    schema_error_count: 0,
  };
}

function safeMboSourceSummary(cwd: string, path: string): MboSourceSummary {
  return {
    ...safeRuntimeSummary(cwd, path),
    mbo_events_indexed: 0,
    malformed_mbo_event_count: 0,
    action_counts: sortedActionCounts(emptyActionCounts()),
  };
}

function emptyJournalSummary(cwd: string, path: string): JournalSummary {
  return {
    path: toReportPath(cwd, path),
    exists: existsSync(path),
    sha256: null,
    size_bytes: existsSync(path) ? statSync(path).size : null,
    events_scanned: 0,
    parse_error_count: 0,
    schema_error_count: 0,
  };
}

function emptyMboSourceSummary(cwd: string, path: string): MboSourceSummary {
  return {
    ...emptyJournalSummary(cwd, path),
    mbo_events_indexed: 0,
    malformed_mbo_event_count: 0,
    action_counts: sortedActionCounts(emptyActionCounts()),
  };
}

function assertValidEvent(event: JournalEventEnvelope, label: string): void {
  const validation = validateJournalEventEnvelope(event);
  if (!validation.ok) {
    throw new Error(`${label}: ${formatJournalEventSchemaValidationErrors(validation.issues)}`);
  }
}

function normalizeMboAction(value: unknown): MboAction {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['add', 'new', 'insert', 'order_add'].includes(normalized)) return 'add';
  if (['modify', 'change', 'replace', 'update', 'order_modify'].includes(normalized)) return 'modify';
  if (['cancel', 'delete', 'remove', 'order_cancel'].includes(normalized)) return 'cancel';
  return 'unknown';
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function optionalBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/u.test(value)) return BigInt(value);
  return null;
}

function emptyActionCounts(): Record<MboAction, number> {
  return { add: 0, modify: 0, cancel: 0, unknown: 0 };
}

function sortedActionCounts(counts: Record<MboAction, number>): Readonly<Record<MboAction, number>> {
  return {
    add: counts.add,
    cancel: counts.cancel,
    modify: counts.modify,
    unknown: counts.unknown,
  };
}

function compareSourceMboEvents(left: SourceMboEvent, right: SourceMboEvent): number {
  if (left.ts_ns < right.ts_ns) return -1;
  if (left.ts_ns > right.ts_ns) return 1;
  return left.event_id.localeCompare(right.event_id);
}

function compareJournalEvents(left: JournalEventEnvelope, right: JournalEventEnvelope): number {
  if (BigInt(left.ts_ns) < BigInt(right.ts_ns)) return -1;
  if (BigInt(left.ts_ns) > BigInt(right.ts_ns)) return 1;
  return String(left.event_id).localeCompare(String(right.event_id));
}

function toSerializableJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => (
    typeof item === 'bigint' ? item.toString() : item
  ))) as JsonValue;
}

function toReportPath(cwd: string, path: string): string {
  return relative(cwd, path).replace(/\\/gu, '/');
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`ORCH-MBO-01 ${label} must be a positive integer`);
  }
  return value;
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/gu, '_');
}

function padSequence(value: number): string {
  return String(value).padStart(12, '0');
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function nextBlocker(status: OrchMbo01Status): string {
  if (status === 'generated') {
    return 'Run REL-00, REL-01D, and REL-01E against the shadow-enriched journal before adding it to REL-01 evidence.';
  }
  if (status === 'no_shadow_telemetry') {
    return 'Provide a usable MBO lifecycle source journal with indexed MBO events, then rerun ORCH-MBO-01.';
  }
  if (status === 'requires_inputs') {
    return 'Provide the runtime journal and normalized MBO lifecycle source journal, then rerun ORCH-MBO-01.';
  }
  return 'Fix ORCH-MBO-01 input or generation failure, then rerun.';
}

function parseArgs(argv: readonly string[]): OrchMbo01Options {
  const options: MutableOrchMbo01Options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const value = argv[index + 1];
    if (arg === '--runtime-journal' && value !== undefined) {
      options.runtime_journal = value;
      index += 1;
    } else if (arg === '--mbo-source-journal' && value !== undefined) {
      options.mbo_source_journal = value;
      index += 1;
    } else if (arg === '--out-journal' && value !== undefined) {
      options.out_journal = value;
      index += 1;
    } else if (arg === '--report' && value !== undefined) {
      options.report = value;
      index += 1;
    } else if (arg === '--run-id' && value !== undefined) {
      options.run_id = value;
      index += 1;
    } else if (arg === '--session-id' && value !== undefined) {
      options.session_id = value;
      index += 1;
    } else if (arg === '--window-event-count' && value !== undefined) {
      options.window_event_count = Number(value);
      index += 1;
    } else if (arg === '--emit-every' && value !== undefined) {
      options.emit_every = Number(value);
      index += 1;
    } else if (arg === '--max-shadow-events' && value !== undefined) {
      options.max_shadow_events = Number(value);
      index += 1;
    } else {
      throw new Error(`unknown or incomplete ORCH-MBO-01 argument: ${arg}`);
    }
  }
  for (const field of ['runtime_journal', 'mbo_source_journal', 'run_id', 'session_id'] as const) {
    if (options[field] === undefined || options[field]?.trim() === '') {
      throw new Error(`ORCH-MBO-01 requires --${field.replace(/_/gu, '-')}`);
    }
  }
  return options as OrchMbo01Options;
}

function writeSummary(result: { readonly report: OrchMbo01Report; readonly exit_code: OrchMbo01ExitCode }): string {
  return [
    `ORCH-MBO-01 shadow telemetry generation: ${result.report.status}`,
    `journal=${result.report.output.out_journal}`,
    `report=${result.report.output.report}`,
    `shadow_events=${result.report.generation.shadow_events_emitted}`,
    `shadow_field_occurrences=${result.report.generation.shadow_field_occurrences}`,
    `next_blocker=${result.report.next_blocker}`,
  ].join('\n');
}

const isMain = processArgv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(processArgv[1]);

if (isMain) {
  runOrchMbo01ShadowProducer(parseArgs(processArgv.slice(2)))
    .then((result) => {
      processStdout.write(`${writeSummary(result)}\n`);
      processExit(result.exit_code);
    })
    .catch((error) => {
      processStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      processExit(3);
    });
}
