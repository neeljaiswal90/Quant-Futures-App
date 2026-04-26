import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  argv as processArgv,
  exit as processExit,
  stderr as processStderr,
  stdout as processStdout,
} from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  formatJournalEventSchemaValidationErrors,
  journalEventFromJsonLine,
  parseRuntimeEventType,
  parseStrategyId,
  stableJsonStringify,
  validateJournalEventEnvelope,
  type JournalEventEnvelope,
  type JsonValue,
  type RuntimeEventType,
  type StrategyId,
  type UnixNs,
} from '../../apps/strategy_runtime/src/contracts/index.js';
import { ns } from '../../apps/strategy_runtime/src/contracts/time.js';

export type JournalQueryFormat = 'text' | 'json';

export interface JournalQueryOptions {
  readonly journal_path?: string;
  readonly journal_dir?: string;
  readonly candidate_id?: string;
  readonly position_id?: string;
  readonly event_id?: string;
  readonly causation_id?: string;
  readonly strategy_id?: StrategyId;
  readonly session_id?: string;
  readonly run_id?: string;
  readonly type?: RuntimeEventType;
  readonly since_ts_ns?: UnixNs;
  readonly until_ts_ns?: UnixNs;
  readonly format: JournalQueryFormat;
  readonly limit?: number;
  readonly strict: boolean;
}

export interface JournalQueryDiagnostic {
  readonly source_file: string;
  readonly line_number: number;
  readonly message: string;
}

export interface JournalQueryMissingRef {
  readonly id: string;
  readonly reason: string;
}

export interface JournalQueryResult {
  readonly query: JournalQueryOptions;
  readonly source_files: readonly string[];
  readonly valid_events: number;
  readonly diagnostics: readonly JournalQueryDiagnostic[];
  readonly missing: readonly JournalQueryMissingRef[];
  readonly events: readonly JournalEventEnvelope[];
  readonly exit_code: 0 | 1;
}

interface ParsedJournalFile {
  readonly path: string;
  readonly display_name: string;
}

interface EventWithOrdinal {
  readonly event: JournalEventEnvelope;
  readonly ordinal: number;
}

interface JournalIndexes {
  readonly events: readonly EventWithOrdinal[];
  readonly by_event_id: ReadonlyMap<string, EventWithOrdinal>;
  readonly children_by_cause: ReadonlyMap<string, readonly EventWithOrdinal[]>;
}

const DEFAULT_QUERY_FORMAT: JournalQueryFormat = 'text';

export function parseJournalQueryArgs(args: readonly string[]): JournalQueryOptions {
  const options: {
    journal_path?: string;
    journal_dir?: string;
    candidate_id?: string;
    position_id?: string;
    event_id?: string;
    causation_id?: string;
    strategy_id?: StrategyId;
    session_id?: string;
    run_id?: string;
    type?: RuntimeEventType;
    since_ts_ns?: UnixNs;
    until_ts_ns?: UnixNs;
    format: JournalQueryFormat;
    limit?: number;
    strict: boolean;
  } = {
    format: DEFAULT_QUERY_FORMAT,
    strict: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const [flag, inlineValue] = splitArg(arg);
    switch (flag) {
      case '--journal':
        options.journal_path = requireValue(flag, inlineValue, () => {
          index += 1;
          return args[index];
        });
        break;
      case '--journal-dir':
        options.journal_dir = requireValue(flag, inlineValue, () => {
          index += 1;
          return args[index];
        });
        break;
      case '--candidate':
        options.candidate_id = requireValue(flag, inlineValue, () => {
          index += 1;
          return args[index];
        });
        break;
      case '--position':
        options.position_id = requireValue(flag, inlineValue, () => {
          index += 1;
          return args[index];
        });
        break;
      case '--event':
        options.event_id = requireValue(flag, inlineValue, () => {
          index += 1;
          return args[index];
        });
        break;
      case '--causation':
        options.causation_id = requireValue(flag, inlineValue, () => {
          index += 1;
          return args[index];
        });
        break;
      case '--strategy':
        options.strategy_id = parseStrategyId(requireValue(flag, inlineValue, () => {
          index += 1;
          return args[index];
        }));
        break;
      case '--session':
        options.session_id = requireValue(flag, inlineValue, () => {
          index += 1;
          return args[index];
        });
        break;
      case '--run':
        options.run_id = requireValue(flag, inlineValue, () => {
          index += 1;
          return args[index];
        });
        break;
      case '--type':
        options.type = parseRuntimeEventType(requireValue(flag, inlineValue, () => {
          index += 1;
          return args[index];
        }));
        break;
      case '--since-ts-ns':
        options.since_ts_ns = ns(requireValue(flag, inlineValue, () => {
          index += 1;
          return args[index];
        }));
        break;
      case '--until-ts-ns':
        options.until_ts_ns = ns(requireValue(flag, inlineValue, () => {
          index += 1;
          return args[index];
        }));
        break;
      case '--format': {
        const format = requireValue(flag, inlineValue, () => {
          index += 1;
          return args[index];
        });
        if (format !== 'text' && format !== 'json') {
          throw new Error('--format must be text or json');
        }
        options.format = format;
        break;
      }
      case '--limit':
        options.limit = parseLimit(requireValue(flag, inlineValue, () => {
          index += 1;
          return args[index];
        }));
        break;
      case '--strict':
        options.strict = true;
        break;
      case '--help':
      case '-h':
        throw new JournalQueryHelpRequested();
      default:
        throw new Error(`Unknown journal-query argument: ${arg}`);
    }
  }

  if ((options.journal_path === undefined) === (options.journal_dir === undefined)) {
    throw new Error('Use exactly one of --journal or --journal-dir');
  }
  if (
    options.since_ts_ns !== undefined &&
    options.until_ts_ns !== undefined &&
    BigInt(options.since_ts_ns) > BigInt(options.until_ts_ns)
  ) {
    throw new Error('--since-ts-ns must be <= --until-ts-ns');
  }

  return options;
}

export function runJournalQuery(options: JournalQueryOptions): JournalQueryResult {
  const files = resolveInputFiles(options);
  const diagnostics: JournalQueryDiagnostic[] = [];
  const loaded: EventWithOrdinal[] = [];
  let ordinal = 0;

  for (const file of files) {
    const lines = readFileSync(file.path, 'utf8').replace(/\r\n/g, '\n').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const rawLine = stripTrailingCarriageReturn(lines[index]!);
      if (rawLine.trim() === '') {
        continue;
      }
      const lineNumber = index + 1;
      try {
        const event = journalEventFromJsonLine(rawLine);
        const validation = validateJournalEventEnvelope(event);
        if (!validation.ok) {
          diagnostics.push({
            source_file: file.display_name,
            line_number: lineNumber,
            message: formatJournalEventSchemaValidationErrors(validation.issues),
          });
          continue;
        }
        loaded.push({ event, ordinal });
        ordinal += 1;
      } catch (error) {
        diagnostics.push({
          source_file: file.display_name,
          line_number: lineNumber,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const filteredEvents = loaded.filter((item) => eventMatchesGlobalFilters(item.event, options));
  const indexes = buildIndexes(filteredEvents);
  const missing: JournalQueryMissingRef[] = [];
  const selected = selectQueryEvents(indexes, options, missing);
  const limited = options.limit === undefined ? selected : selected.slice(0, options.limit);
  const exitCode: 0 | 1 =
    (options.strict && diagnostics.length > 0) || missing.length > 0 ? 1 : 0;

  return {
    query: options,
    source_files: files.map((file) => file.display_name),
    valid_events: loaded.length,
    diagnostics,
    missing,
    events: limited.map((item) => item.event),
    exit_code: exitCode,
  };
}

export function formatJournalQueryResult(result: JournalQueryResult): {
  readonly stdout: string;
  readonly stderr: string;
} {
  const stderrLines = result.diagnostics.map(
    (diagnostic) =>
      `${diagnostic.source_file}:${diagnostic.line_number}: ${diagnostic.message}`,
  );
  if (result.exit_code !== 0 && result.missing.length > 0) {
    stderrLines.push(...result.missing.map((missing) => `missing in journal: ${missing.id}`));
  }

  if (result.query.format === 'json') {
    return {
      stdout: `${stableJsonStringify(jsonResult(result) as unknown as JsonValue)}\n`,
      stderr: stderrLines.length === 0 ? '' : `${stderrLines.join('\n')}\n`,
    };
  }

  const stdoutLines = [
    'Journal Query',
    [
      `sources=${result.source_files.join(',')}`,
      `valid_events=${result.valid_events}`,
      `returned_events=${result.events.length}`,
      `diagnostics=${result.diagnostics.length}`,
    ].join(' '),
  ];

  if (result.missing.length > 0) {
    stdoutLines.push('');
    for (const missing of result.missing) {
      stdoutLines.push(`missing in journal id=${missing.id} reason=${missing.reason}`);
    }
  }

  if (result.events.length > 0) {
    stdoutLines.push('');
    for (const event of result.events) {
      stdoutLines.push(formatEventLine(event));
    }
  }

  return {
    stdout: `${stdoutLines.join('\n')}\n`,
    stderr: stderrLines.length === 0 ? '' : `${stderrLines.join('\n')}\n`,
  };
}

export function journalQueryUsage(): string {
  return [
    'Usage: journal:query (--journal path | --journal-dir path) [filters] [--format text|json] [--limit n] [--strict]',
    '',
    'Read-only OBS-01 JSONL journal query and provenance reconstruction.',
    '',
    'Selectors:',
    '  --candidate <candidate_id>  Reconstruct candidate provenance chain.',
    '  --position <position_id>    Show fills, position transitions, and management facts.',
    '  --event <event_id>          Show event, direct cause, and direct children.',
    '  --causation <causation_id>  Show cause event and direct caused events.',
    '',
    'Filters:',
    '  --strategy <strategy_id> --session <session_id> --run <run_id> --type <event_type>',
    '  --since-ts-ns <timestamp> --until-ts-ns <timestamp> --limit <n>',
    '',
    'Malformed lines are reported to stderr and skipped unless --strict is provided.',
  ].join('\n');
}

function resolveInputFiles(options: JournalQueryOptions): readonly ParsedJournalFile[] {
  if (options.journal_path !== undefined) {
    const path = resolve(options.journal_path);
    if (!statSync(path).isFile()) {
      throw new Error(`--journal is not a file: ${path}`);
    }
    return [{ path, display_name: basename(path) }];
  }

  const directory = resolve(options.journal_dir!);
  if (!statSync(directory).isDirectory()) {
    throw new Error(`--journal-dir is not a directory: ${directory}`);
  }
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => ({ path: join(directory, name), display_name: name }));
}

function buildIndexes(events: readonly EventWithOrdinal[]): JournalIndexes {
  const byEventId = new Map<string, EventWithOrdinal>();
  const childrenByCause = new Map<string, EventWithOrdinal[]>();

  for (const item of events) {
    byEventId.set(item.event.event_id, item);
    if (item.event.causation_id !== undefined) {
      const children = childrenByCause.get(item.event.causation_id) ?? [];
      children.push(item);
      childrenByCause.set(item.event.causation_id, children);
    }
  }

  for (const children of childrenByCause.values()) {
    children.sort(compareEventOrdinals);
  }

  return {
    events,
    by_event_id: byEventId,
    children_by_cause: childrenByCause,
  };
}

function selectQueryEvents(
  indexes: JournalIndexes,
  options: JournalQueryOptions,
  missing: JournalQueryMissingRef[],
): readonly EventWithOrdinal[] {
  const selected = new Map<string, EventWithOrdinal>();

  if (options.candidate_id !== undefined) {
    selectCandidateChain(indexes, options.candidate_id, selected, missing);
  }
  if (options.position_id !== undefined) {
    selectPositionChain(indexes, options.position_id, selected, missing);
  }
  if (options.event_id !== undefined) {
    selectEventNeighborhood(indexes, options.event_id, selected, missing);
  }
  if (options.causation_id !== undefined) {
    selectCausationNeighborhood(indexes, options.causation_id, selected, missing);
  }

  if (
    options.candidate_id === undefined &&
    options.position_id === undefined &&
    options.event_id === undefined &&
    options.causation_id === undefined
  ) {
    for (const item of indexes.events) {
      selected.set(item.event.event_id, item);
    }
  }

  return [...selected.values()].sort(compareEventOrdinals);
}

function selectCandidateChain(
  indexes: JournalIndexes,
  candidateId: string,
  selected: Map<string, EventWithOrdinal>,
  missing: JournalQueryMissingRef[],
): void {
  const candidate = indexes.events.find(
    (item) =>
      item.event.type === 'CANDIDATE' &&
      stringPayloadField(item.event, 'candidate_id') === candidateId,
  );
  if (candidate === undefined) {
    missing.push({ id: candidateId, reason: 'candidate_id not found' });
    return;
  }

  addAncestors(indexes, candidate, selected, missing);
  addSelected(candidate, selected);
  addDescendants(indexes, candidate.event.event_id, selected, missing);

  const featureSnapshotId = stringPayloadField(candidate.event, 'feature_snapshot_id');
  for (const item of indexes.events) {
    if (
      featureSnapshotId !== undefined &&
      ['FEATURES', 'STRUCTURE', 'MICROSTRUCTURE', 'STRAT_EVAL', 'ML_UPLIFT'].includes(item.event.type) &&
      stringPayloadField(item.event, 'feature_snapshot_id') === featureSnapshotId
    ) {
      addSelected(item, selected);
    }
    if (item.event.type === 'RANK' && stringArrayPayloadField(item.event, 'ranked_candidate_ids').includes(candidateId)) {
      addSelected(item, selected);
    }
  }
}

function selectPositionChain(
  indexes: JournalIndexes,
  positionId: string,
  selected: Map<string, EventWithOrdinal>,
  missing: JournalQueryMissingRef[],
): void {
  const positionEvents = indexes.events.filter(
    (item) => stringPayloadField(item.event, 'position_id') === positionId,
  );
  if (positionEvents.length === 0) {
    missing.push({ id: positionId, reason: 'position_id not found' });
    return;
  }

  for (const item of positionEvents) {
    addAncestors(indexes, item, selected, missing);
    addSelected(item, selected);
    addDescendants(indexes, item.event.event_id, selected, missing);
  }
}

function selectEventNeighborhood(
  indexes: JournalIndexes,
  eventId: string,
  selected: Map<string, EventWithOrdinal>,
  missing: JournalQueryMissingRef[],
): void {
  const event = indexes.by_event_id.get(eventId);
  if (event === undefined) {
    missing.push({ id: eventId, reason: 'event_id not found' });
    return;
  }
  addDirectCause(indexes, event, selected, missing);
  addSelected(event, selected);
  for (const child of indexes.children_by_cause.get(eventId) ?? []) {
    addSelected(child, selected);
  }
}

function selectCausationNeighborhood(
  indexes: JournalIndexes,
  causationId: string,
  selected: Map<string, EventWithOrdinal>,
  missing: JournalQueryMissingRef[],
): void {
  const cause = indexes.by_event_id.get(causationId);
  const children = indexes.children_by_cause.get(causationId) ?? [];
  if (cause === undefined && children.length === 0) {
    missing.push({ id: causationId, reason: 'causation_id not found' });
    return;
  }
  if (cause !== undefined) {
    addSelected(cause, selected);
  }
  for (const child of children) {
    addSelected(child, selected);
  }
}

function addAncestors(
  indexes: JournalIndexes,
  item: EventWithOrdinal,
  selected: Map<string, EventWithOrdinal>,
  missing: JournalQueryMissingRef[],
): void {
  if (item.event.causation_id === undefined) {
    return;
  }
  const cause = indexes.by_event_id.get(item.event.causation_id);
  if (cause === undefined) {
    missing.push({
      id: item.event.causation_id,
      reason: `causation_id for ${item.event.event_id} missing in journal`,
    });
    return;
  }
  addAncestors(indexes, cause, selected, missing);
  addSelected(cause, selected);
}

function addDirectCause(
  indexes: JournalIndexes,
  item: EventWithOrdinal,
  selected: Map<string, EventWithOrdinal>,
  missing: JournalQueryMissingRef[],
): void {
  if (item.event.causation_id === undefined) {
    return;
  }
  const cause = indexes.by_event_id.get(item.event.causation_id);
  if (cause === undefined) {
    missing.push({
      id: item.event.causation_id,
      reason: `direct cause for ${item.event.event_id} missing in journal`,
    });
    return;
  }
  addSelected(cause, selected);
}

function addDescendants(
  indexes: JournalIndexes,
  eventId: string,
  selected: Map<string, EventWithOrdinal>,
  missing: JournalQueryMissingRef[],
): void {
  for (const child of indexes.children_by_cause.get(eventId) ?? []) {
    addSelected(child, selected);
    if (child.event.causation_id !== undefined && !indexes.by_event_id.has(child.event.causation_id)) {
      missing.push({
        id: child.event.causation_id,
        reason: `causation_id for ${child.event.event_id} missing in journal`,
      });
    }
    addDescendants(indexes, child.event.event_id, selected, missing);
  }
}

function addSelected(item: EventWithOrdinal, selected: Map<string, EventWithOrdinal>): void {
  selected.set(item.event.event_id, item);
}

function eventMatchesGlobalFilters(event: JournalEventEnvelope, options: JournalQueryOptions): boolean {
  if (options.strategy_id !== undefined && stringPayloadField(event, 'strategy_id') !== options.strategy_id) {
    return false;
  }
  if (options.session_id !== undefined && event.session_id !== options.session_id) {
    return false;
  }
  if (options.run_id !== undefined && event.run_id !== options.run_id) {
    return false;
  }
  if (options.type !== undefined && event.type !== options.type) {
    return false;
  }
  if (options.since_ts_ns !== undefined && BigInt(event.ts_ns) < BigInt(options.since_ts_ns)) {
    return false;
  }
  if (options.until_ts_ns !== undefined && BigInt(event.ts_ns) > BigInt(options.until_ts_ns)) {
    return false;
  }
  return true;
}

function jsonResult(result: JournalQueryResult): JsonValue {
  return {
    schema_version: 1,
    query: publicQueryShape(result.query),
    source_files: result.source_files,
    summary: {
      valid_events: result.valid_events,
      returned_events: result.events.length,
      diagnostics: result.diagnostics.length,
      missing: result.missing.length,
    },
    missing: result.missing.map((missing) => ({
      id: missing.id,
      reason: missing.reason,
    })),
    diagnostics: result.diagnostics.map((diagnostic) => ({
      source_file: diagnostic.source_file,
      line_number: diagnostic.line_number,
      message: diagnostic.message,
    })),
    events: result.events as unknown as JsonValue,
  };
}

function publicQueryShape(options: JournalQueryOptions): JsonValue {
  return {
    ...(options.journal_path === undefined ? {} : { journal: options.journal_path }),
    ...(options.journal_dir === undefined ? {} : { journal_dir: options.journal_dir }),
    ...(options.candidate_id === undefined ? {} : { candidate: options.candidate_id }),
    ...(options.position_id === undefined ? {} : { position: options.position_id }),
    ...(options.event_id === undefined ? {} : { event: options.event_id }),
    ...(options.causation_id === undefined ? {} : { causation: options.causation_id }),
    ...(options.strategy_id === undefined ? {} : { strategy: options.strategy_id }),
    ...(options.session_id === undefined ? {} : { session: options.session_id }),
    ...(options.run_id === undefined ? {} : { run: options.run_id }),
    ...(options.type === undefined ? {} : { type: options.type }),
    ...(options.since_ts_ns === undefined ? {} : { since_ts_ns: options.since_ts_ns }),
    ...(options.until_ts_ns === undefined ? {} : { until_ts_ns: options.until_ts_ns }),
    format: options.format,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    strict: options.strict,
  };
}

function formatEventLine(event: JournalEventEnvelope): string {
  const cause = event.causation_id === undefined ? '--' : event.causation_id;
  return [
    nsToString(event.ts_ns),
    event.type,
    `event=${event.event_id}`,
    `cause=${cause}`,
    `run=${event.run_id}`,
    `session=${event.session_id}`,
    payloadSummary(event),
  ].filter((part) => part !== '').join(' ');
}

function payloadSummary(event: JournalEventEnvelope): string {
  switch (event.type) {
    case 'CANDIDATE':
      return [
        `candidate=${stringPayloadField(event, 'candidate_id') ?? '--'}`,
        `strategy=${stringPayloadField(event, 'strategy_id') ?? '--'}`,
        `status=${stringPayloadField(event, 'status') ?? '--'}`,
      ].join(' ');
    case 'STRAT_EVAL':
      return [
        `strategy=${stringPayloadField(event, 'strategy_id') ?? '--'}`,
        `gate=${stringPayloadField(event, 'gate_state') ?? '--'}`,
      ].join(' ');
    case 'RISK_GATE':
      return [
        `candidate=${stringPayloadField(event, 'candidate_id') ?? '--'}`,
        `risk=${stringPayloadField(event, 'status') ?? '--'}`,
      ].join(' ');
    case 'SIZING':
      return [
        `candidate=${stringPayloadField(event, 'candidate_id') ?? '--'}`,
        `qty=${numberPayloadField(event, 'quantity') ?? '--'}`,
      ].join(' ');
    case 'ORDER_INTENT':
      return [
        `order=${stringPayloadField(event, 'order_intent_id') ?? '--'}`,
        `candidate=${stringPayloadField(event, 'candidate_id') ?? '--'}`,
      ].join(' ');
    case 'SIM_FILL':
      return [
        `fill=${stringPayloadField(event, 'fill_id') ?? '--'}`,
        `order=${stringPayloadField(event, 'order_intent_id') ?? '--'}`,
      ].join(' ');
    case 'EXEC_REJECT':
      return [
        `reject=${stringPayloadField(event, 'execution_reject_id') ?? '--'}`,
        `order=${stringPayloadField(event, 'order_intent_id') ?? '--'}`,
        `status=${stringPayloadField(event, 'status') ?? '--'}`,
        `reason=${stringPayloadField(event, 'reason') ?? '--'}`,
      ].join(' ');
    case 'POSITION':
      return [
        `position=${stringPayloadField(event, 'position_id') ?? '--'}`,
        `candidate=${stringPayloadField(event, 'candidate_id') ?? '--'}`,
        `status=${stringPayloadField(event, 'status') ?? '--'}`,
      ].join(' ');
    case 'MGMT_TICK':
    case 'MGMT_ACTION':
      return `position=${stringPayloadField(event, 'position_id') ?? '--'}`;
    case 'FEATURES':
    case 'STRUCTURE':
    case 'MICROSTRUCTURE':
      return `feature=${stringPayloadField(event, 'feature_snapshot_id') ?? '--'}`;
    default:
      return '';
  }
}

function stringPayloadField(event: JournalEventEnvelope, field: string): string | undefined {
  const record = payloadRecord(event);
  const value = record?.[field];
  return typeof value === 'string' ? value : undefined;
}

function numberPayloadField(event: JournalEventEnvelope, field: string): number | undefined {
  const record = payloadRecord(event);
  const value = record?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArrayPayloadField(event: JournalEventEnvelope, field: string): readonly string[] {
  const record = payloadRecord(event);
  const value = record?.[field];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function payloadRecord(event: JournalEventEnvelope): Record<string, unknown> | undefined {
  return event.payload !== null && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : undefined;
}

function compareEventOrdinals(left: EventWithOrdinal, right: EventWithOrdinal): number {
  return left.ordinal - right.ordinal;
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('--limit must be a positive safe integer');
  }
  return parsed;
}

function splitArg(arg: string): readonly [string, string | undefined] {
  const equalsIndex = arg.indexOf('=');
  if (equalsIndex < 0) {
    return [arg, undefined];
  }
  return [arg.slice(0, equalsIndex), arg.slice(equalsIndex + 1)];
}

function requireValue(
  flag: string,
  inlineValue: string | undefined,
  nextValue: () => string | undefined,
): string {
  if (inlineValue !== undefined) {
    if (inlineValue === '') {
      throw new Error(`${flag} requires a non-empty value`);
    }
    return inlineValue;
  }
  const value = nextValue();
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function stripTrailingCarriageReturn(value: string): string {
  return value.endsWith('\r') ? value.slice(0, -1) : value;
}

function nsToString(value: UnixNs | bigint): string {
  return BigInt(value).toString();
}

class JournalQueryHelpRequested extends Error {
  constructor() {
    super('journal-query help requested');
  }
}

function main(): void {
  let options: JournalQueryOptions;
  try {
    options = parseJournalQueryArgs(processArgv.slice(2));
  } catch (error) {
    if (error instanceof JournalQueryHelpRequested) {
      processStdout.write(`${journalQueryUsage()}\n`);
      return;
    }
    processStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    processExit(1);
  }

  try {
    const result = runJournalQuery(options);
    const output = formatJournalQueryResult(result);
    processStdout.write(output.stdout);
    processStderr.write(output.stderr);
    processExit(result.exit_code);
  } catch (error) {
    processStderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    processExit(1);
  }
}

const invokedPath = processArgv[1] === undefined ? undefined : resolve(processArgv[1]);
if (invokedPath !== undefined && resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  main();
}
