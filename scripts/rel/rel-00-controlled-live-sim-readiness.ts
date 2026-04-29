import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  argv as processArgv,
  exit as processExit,
  stderr as processStderr,
  stdout as processStdout,
} from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  categorizeRuntimeEventType,
  isRuntimeEventType,
  stableJsonStringify,
  type JournalEventEnvelope,
  type JsonValue,
  type RuntimeEventType,
} from '../../apps/strategy_runtime/src/contracts/index.js';
import {
  buildFeatureAvailabilityMask,
  type FeatureAvailabilityTier,
} from '../../apps/strategy_runtime/src/features/availability-mask.js';
import {
  createJournalTransportConfig,
  JsonlJournalTransportIngestor,
  type IngestedJournalEvent,
  type QuarantinedJournalLine,
} from '../../apps/strategy_runtime/src/transport/journal-jsonl-transport.js';
import { forEachJsonlLine, sha256File } from '../sim/streaming-jsonl.js';

export const REL_00_REPORT_SCHEMA_VERSION = 1 as const;
export const REL_00_TICKET_ID = 'REL-00' as const;

const DEFAULT_OUT_JSON = 'reports/rel/rel00_controlled_live_sim_readiness_report.json';
const DEFAULT_OUT_MD = 'reports/rel/rel00_controlled_live_sim_readiness_report.md';
const DEFAULT_VALIDATION_DIR = 'reports/rel/rel00_controlled_live_sim_transport';
const DEFAULT_MIN_SOURCE_EVENTS = 1;
const DECLARED_SOURCE = 'rithmic_live_operator_supplied' as const;
const REAL_ORDER_EVENT_TYPES = [
  'ORDER_PLANT',
  'LIVE_ORDER',
  'BROKER_ORDER',
  'ORDER_ACK',
  'ORDER_FILL',
  'ORDER_CANCEL',
  'ORDER_REPLACE',
  'EXECUTION_REPORT',
  'LIVE_FILL',
] as const;

type Rel00Status = 'pass' | 'fail';
type Rel00ExitCode = 0 | 2 | 3;
type SafetyModeStatus = 'declared_rithmic_live_sim';

export interface Rel00Options {
  readonly cwd?: string;
  readonly journal: string;
  readonly out_json?: string;
  readonly out_md?: string;
  readonly validation_dir?: string;
  readonly min_source_events?: number;
}

export interface Rel00Check {
  readonly name: string;
  readonly status: Rel00Status;
  readonly detail?: string;
}

export interface Rel00CheckGroup {
  readonly status: Rel00Status;
  readonly checks: readonly Rel00Check[];
}

export interface Rel00Report {
  readonly schema_version: typeof REL_00_REPORT_SCHEMA_VERSION;
  readonly ticket_id: typeof REL_00_TICKET_ID;
  readonly status: Rel00Status;
  readonly safety_mode_status: SafetyModeStatus;
  readonly input: {
    readonly journal_path: string;
    readonly journal_sha256: string | null;
    readonly journal_size_bytes: number | null;
    readonly declared_market_data_source: typeof DECLARED_SOURCE;
  };
  readonly safety_mode: {
    readonly live_data_source: 'rithmic';
    readonly execution_mode: 'simulated_only';
    readonly real_orders_allowed: false;
    readonly accepted_feature_surface_only: true;
    readonly mbo_derived_features_allowed: false;
  };
  readonly transport_checks: Rel00CheckGroup;
  readonly market_data_checks: Rel00CheckGroup;
  readonly execution_safety_checks: Rel00CheckGroup;
  readonly feature_surface_checks: Rel00CheckGroup;
  readonly traceability_checks: Rel00CheckGroup;
  readonly event_counts: Record<string, number>;
  readonly source_event_counts: Record<string, number>;
  readonly feature_surface_summary: FeatureSurfaceSummary;
  readonly raw_scan_summary: RawJournalScanSummary;
  readonly generated_output_paths: {
    readonly json: string;
    readonly markdown: string;
  };
  readonly reasons: readonly string[];
  readonly next_blocker: string;
  readonly no_raw_data_statement: string;
}

export interface Rel00Result {
  readonly report: Rel00Report;
  readonly json_path: string;
  readonly markdown_path: string;
  readonly exit_code: 0 | 2;
}

interface RawJournalScanSummary {
  readonly line_count: number;
  readonly parse_error_count: number;
  readonly event_type_counts: Record<string, number>;
  readonly real_order_event_type_counts: Record<string, number>;
}

interface FeatureSurfaceSummary {
  readonly checked_event_count: number;
  readonly authoritative_fields: readonly string[];
  readonly restricted_fields: readonly FeatureFieldUse[];
  readonly blocked_fields: readonly FeatureFieldUse[];
  readonly unknown_strategy_fields: readonly string[];
}

interface FeatureFieldUse {
  readonly event_type: string;
  readonly field: string;
  readonly canonical_field: string;
  readonly tier: FeatureAvailabilityTier;
}

interface TransportValidation {
  readonly events: readonly IngestedJournalEvent[];
  readonly quarantine: readonly QuarantinedJournalLine[];
}

export async function runRel00ControlledLiveSimReadiness(
  options: Rel00Options,
): Promise<Rel00Result> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const journalPath = resolve(cwd, options.journal);
  const outJson = resolve(cwd, options.out_json ?? DEFAULT_OUT_JSON);
  const outMd = resolve(cwd, options.out_md ?? DEFAULT_OUT_MD);
  const validationDir = resolve(cwd, options.validation_dir ?? DEFAULT_VALIDATION_DIR);
  const minSourceEvents = options.min_source_events ?? DEFAULT_MIN_SOURCE_EVENTS;

  mkdirSync(dirname(outJson), { recursive: true });
  mkdirSync(dirname(outMd), { recursive: true });

  const inputExists = existsSync(journalPath);
  const journalSizeBytes = inputExists ? statSync(journalPath).size : null;
  const journalSha256 = inputExists ? sha256File(journalPath) : null;
  const rawScan = inputExists ? scanRawJournal(journalPath) : emptyRawScan();
  const transport = inputExists
    ? await validateJournalWithTransport(journalPath, validationDir)
    : { events: [], quarantine: [] };
  const events = transport.events.map((entry) => entry.event);

  const transportChecks = transportCheckGroup(inputExists, journalSizeBytes, rawScan, transport);
  const marketDataChecks = marketDataCheckGroup(events, minSourceEvents);
  const executionSafetyChecks = executionSafetyCheckGroup(events, rawScan);
  const featureSurfaceSummary = featureSurface(events);
  const featureSurfaceChecks = featureSurfaceCheckGroup(featureSurfaceSummary);
  const traceabilityChecks = traceabilityCheckGroup(events);
  const groups = [
    transportChecks,
    marketDataChecks,
    executionSafetyChecks,
    featureSurfaceChecks,
    traceabilityChecks,
  ];
  const reasons = groups.flatMap((group) =>
    group.checks
      .filter((check) => check.status === 'fail')
      .map((check) => `${check.name}: ${check.detail ?? 'failed'}`),
  );

  const report: Rel00Report = {
    schema_version: REL_00_REPORT_SCHEMA_VERSION,
    ticket_id: REL_00_TICKET_ID,
    status: reasons.length === 0 ? 'pass' : 'fail',
    safety_mode_status: 'declared_rithmic_live_sim',
    input: {
      journal_path: toReportPath(cwd, journalPath),
      journal_sha256: journalSha256,
      journal_size_bytes: journalSizeBytes,
      declared_market_data_source: DECLARED_SOURCE,
    },
    safety_mode: {
      live_data_source: 'rithmic',
      execution_mode: 'simulated_only',
      real_orders_allowed: false,
      accepted_feature_surface_only: true,
      mbo_derived_features_allowed: false,
    },
    transport_checks: transportChecks,
    market_data_checks: marketDataChecks,
    execution_safety_checks: executionSafetyChecks,
    feature_surface_checks: featureSurfaceChecks,
    traceability_checks: traceabilityChecks,
    event_counts: countEvents(events),
    source_event_counts: countEvents(events.filter((event) => categorizeRuntimeEventType(event.type) === 'source_market_data')),
    feature_surface_summary: featureSurfaceSummary,
    raw_scan_summary: rawScan,
    generated_output_paths: {
      json: toReportPath(cwd, outJson),
      markdown: toReportPath(cwd, outMd),
    },
    reasons,
    next_blocker: reasons.length === 0
      ? 'REL-01 10-session controlled live-sim validation'
      : 'Resolve failed REL-00 controlled live-sim readiness checks, then rerun REL-00.',
    no_raw_data_statement: 'REL-00 indexes journal path, hash, event counts, status checks, and small scalar summaries only. It does not embed raw market-data rows, order payloads, DBN files, or journal payload values.',
  };

  writeFileSync(outJson, `${stableJsonStringify(report as unknown as JsonValue)}\n`, 'utf8');
  writeFileSync(outMd, markdownReport(report), 'utf8');

  return {
    report,
    json_path: outJson,
    markdown_path: outMd,
    exit_code: report.status === 'pass' ? 0 : 2,
  };
}

export function rel00ExitCode(report: Rel00Report): Rel00ExitCode {
  return report.status === 'pass' ? 0 : 2;
}

function transportCheckGroup(
  inputExists: boolean,
  journalSizeBytes: number | null,
  rawScan: RawJournalScanSummary,
  transport: TransportValidation,
): Rel00CheckGroup {
  return group([
    checkBoolean('journal_exists', inputExists),
    checkBoolean('journal_non_empty', journalSizeBytes !== null && journalSizeBytes > 0, `${journalSizeBytes ?? 0}`),
    checkBoolean('journal_json_lines_parseable', rawScan.parse_error_count === 0, `${rawScan.parse_error_count}`),
    checkBoolean('journal_transport_no_quarantine', transport.quarantine.length === 0, `${transport.quarantine.length}`),
    checkBoolean('journal_transport_ingests_events', transport.events.length > 0, `${transport.events.length}`),
    checkBoolean('journal_transport_matches_raw_event_count', transport.events.length === rawScan.line_count && rawScan.parse_error_count === 0, `${transport.events.length}/${rawScan.line_count}`),
  ]);
}

function marketDataCheckGroup(
  events: readonly JournalEventEnvelope[],
  minSourceEvents: number,
): Rel00CheckGroup {
  const sourceEvents = events.filter((event) => categorizeRuntimeEventType(event.type) === 'source_market_data');
  const sourceWithExchangeTs = sourceEvents.filter((event) => sourceEventHasCanonicalExchangeTime(event));
  const quoteOrTrade = sourceEvents.filter((event) => ['QUOTE', 'TRADE'].includes(event.type));
  return group([
    pass('declared_market_data_source_rithmic_live', DECLARED_SOURCE),
    checkBoolean('source_market_data_event_count_meets_minimum', sourceEvents.length >= minSourceEvents, `${sourceEvents.length}/${minSourceEvents}`),
    checkBoolean('quote_or_trade_event_present', quoteOrTrade.length > 0, `${quoteOrTrade.length}`),
    checkBoolean('source_events_use_exchange_event_ts_ns', sourceWithExchangeTs.length === sourceEvents.length, `${sourceWithExchangeTs.length}/${sourceEvents.length}`),
  ]);
}

function executionSafetyCheckGroup(
  events: readonly JournalEventEnvelope[],
  rawScan: RawJournalScanSummary,
): Rel00CheckGroup {
  const simFillEvents = events.filter((event) => event.type === 'SIM_FILL');
  const execRejectEvents = events.filter((event) => event.type === 'EXEC_REJECT');
  const unsafeExecRejects = execRejectEvents.filter((event) => {
    const payload = jsonObject(event.payload);
    return payload?.execution_adapter !== 'simulated';
  });
  const blockedTierFills = simFillEvents.filter((event) => {
    const payload = jsonObject(event.payload);
    return payload?.input_tier === 'blocked';
  });
  const realOrderTypeTotal = Object.values(rawScan.real_order_event_type_counts).reduce((sum, count) => sum + count, 0);
  return group([
    checkBoolean('no_real_order_event_types_in_raw_journal', realOrderTypeTotal === 0, stableJsonStringify(rawScan.real_order_event_type_counts as JsonValue)),
    checkBoolean('execution_rejects_are_simulated_adapter_only', unsafeExecRejects.length === 0, `${unsafeExecRejects.length}`),
    checkBoolean('sim_fills_do_not_use_blocked_input_tier', blockedTierFills.length === 0, `${blockedTierFills.length}`),
    pass('real_orders_allowed_false', 'simulated execution only'),
  ]);
}

function featureSurfaceCheckGroup(summary: FeatureSurfaceSummary): Rel00CheckGroup {
  return group([
    checkBoolean('no_blocked_feature_fields_used', summary.blocked_fields.length === 0, fieldUsesDetail(summary.blocked_fields)),
    checkBoolean('no_diagnostic_or_mbo_subscope_fields_used_as_runtime_features', summary.restricted_fields.length === 0, fieldUsesDetail(summary.restricted_fields)),
    pass('unknown_strategy_fields_treated_as_internal_indicators', `${summary.unknown_strategy_fields.length}`),
  ]);
}

function traceabilityCheckGroup(events: readonly JournalEventEnvelope[]): Rel00CheckGroup {
  const orderIntentIds = new Set<string>();
  const terminalOrderIntentIds = new Set<string>();
  const unknownTerminalRefs: string[] = [];
  for (const event of events) {
    const payload = jsonObject(event.payload);
    if (event.type === 'ORDER_INTENT') {
      const orderIntentId = stringValue(payload?.order_intent_id);
      if (orderIntentId !== null) orderIntentIds.add(orderIntentId);
    }
    if (event.type === 'SIM_FILL' || event.type === 'EXEC_REJECT') {
      const orderIntentId = stringValue(payload?.order_intent_id);
      if (orderIntentId !== null) {
        terminalOrderIntentIds.add(orderIntentId);
        if (!orderIntentIds.has(orderIntentId)) {
          unknownTerminalRefs.push(orderIntentId);
        }
      }
    }
  }
  const unterminated = [...orderIntentIds].filter((id) => !terminalOrderIntentIds.has(id)).sort();
  return group([
    pass('order_intent_count', `${orderIntentIds.size}`),
    checkBoolean('simulated_terminal_events_reference_known_order_intents', unknownTerminalRefs.length === 0, unknownTerminalRefs.join(',')),
    checkBoolean('order_intents_have_simulated_terminal_event_or_no_orders_present', unterminated.length === 0, unterminated.join(',')),
  ]);
}

function featureSurface(events: readonly JournalEventEnvelope[]): FeatureSurfaceSummary {
  const mask = buildFeatureAvailabilityMask();
  const authoritative = new Set<string>();
  const restricted = new Map<string, FeatureFieldUse>();
  const blocked = new Map<string, FeatureFieldUse>();
  const unknown = new Set<string>();
  let checkedEventCount = 0;

  for (const event of events) {
    if (event.type !== 'FEATURES' && event.type !== 'MICROSTRUCTURE') {
      continue;
    }
    const payload = jsonObject(event.payload);
    const values = jsonObject(payload?.values);
    if (values === null) {
      continue;
    }
    checkedEventCount += 1;
    for (const key of Object.keys(values).sort()) {
      const canonical = canonicalFeatureField(key);
      const tier = canonical in mask.field_tiers
        ? mask.field_tiers[canonical as keyof typeof mask.field_tiers]
        : null;
      if (tier === null) {
        unknown.add(key);
        continue;
      }
      if (tier === 'authoritative') {
        authoritative.add(canonical);
        continue;
      }
      const use: FeatureFieldUse = {
        event_type: event.type,
        field: key,
        canonical_field: canonical,
        tier,
      };
      if (tier === 'blocked') {
        blocked.set(`${event.type}:${key}:${canonical}`, use);
      } else {
        restricted.set(`${event.type}:${key}:${canonical}`, use);
      }
    }
  }

  return {
    checked_event_count: checkedEventCount,
    authoritative_fields: [...authoritative].sort(),
    restricted_fields: [...restricted.values()].sort(compareFeatureUses),
    blocked_fields: [...blocked.values()].sort(compareFeatureUses),
    unknown_strategy_fields: [...unknown].sort(),
  };
}

function canonicalFeatureField(field: string): string {
  const aliases: Record<string, string> = {
    bid_px: 'l1_quote_bid_px',
    ask_px: 'l1_quote_ask_px',
    last_price: 'last_trade_price',
    last_trade_px: 'last_trade_price',
    trade_size: 'last_trade_size',
    aggressor_side: 'last_trade_aggressor_side',
    spread_points: 'microstructure_spread_points',
    spread_ticks: 'microstructure_spread_ticks',
    mid_px: 'microstructure_mid_px',
    microprice_offset_ticks: 'mbo_microprice_offset_ticks',
    ofi_short: 'mbo_ofi_short',
    ofi_medium: 'mbo_ofi_medium',
    ofi_blend: 'mbo_ofi_blend',
    queue_imbalance: 'mbo_queue_imbalance',
    queue_ahead_fraction: 'queue_ahead_fraction_estimate',
  };
  return aliases[field] ?? field;
}

async function validateJournalWithTransport(
  journalPath: string,
  validationDir: string,
): Promise<TransportValidation> {
  ensureEmptyRel00Directory(validationDir);
  copyFileSync(journalPath, join(validationDir, basename(journalPath)));
  const events: IngestedJournalEvent[] = [];
  const quarantine: QuarantinedJournalLine[] = [];
  const ingestor = new JsonlJournalTransportIngestor(createJournalTransportConfig(validationDir), {
    onEvent: (event) => {
      events.push(event);
    },
    onMalformedLine: (line) => {
      quarantine.push(line);
    },
  });
  await ingestor.pollOnce();
  return { events, quarantine };
}

function scanRawJournal(path: string): RawJournalScanSummary {
  let lineCount = 0;
  let parseErrorCount = 0;
  const eventTypeCounts = new Map<string, number>();
  const realOrderEventTypeCounts = new Map<string, number>();
  forEachJsonlLine(path, (line) => {
    if (line.trim() === '') {
      return;
    }
    lineCount += 1;
    try {
      const parsed = JSON.parse(line) as unknown;
      const eventType = jsonObject(parsed)?.type;
      if (typeof eventType !== 'string') {
        parseErrorCount += 1;
        return;
      }
      increment(eventTypeCounts, eventType);
      if (REAL_ORDER_EVENT_TYPES.includes(eventType as (typeof REAL_ORDER_EVENT_TYPES)[number])) {
        increment(realOrderEventTypeCounts, eventType);
      }
    } catch {
      parseErrorCount += 1;
    }
  });
  return {
    line_count: lineCount,
    parse_error_count: parseErrorCount,
    event_type_counts: sortedRecord(eventTypeCounts),
    real_order_event_type_counts: sortedRecord(realOrderEventTypeCounts),
  };
}

function emptyRawScan(): RawJournalScanSummary {
  return {
    line_count: 0,
    parse_error_count: 0,
    event_type_counts: {},
    real_order_event_type_counts: {},
  };
}

function sourceEventHasCanonicalExchangeTime(event: JournalEventEnvelope): boolean {
  if (!isRuntimeEventType(event.type) || categorizeRuntimeEventType(event.type) !== 'source_market_data') {
    return false;
  }
  const payload = jsonObject(event.payload);
  const exchangeEventTsNs = payload?.exchange_event_ts_ns;
  return typeof exchangeEventTsNs === 'bigint' && BigInt(event.ts_ns) === exchangeEventTsNs;
}

function countEvents(events: readonly JournalEventEnvelope[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    increment(counts, event.type);
  }
  return sortedRecord(counts);
}

function group(checks: readonly Rel00Check[]): Rel00CheckGroup {
  return {
    status: checks.every((check) => check.status === 'pass') ? 'pass' : 'fail',
    checks,
  };
}

function pass(name: string, detail?: string): Rel00Check {
  return {
    name,
    status: 'pass',
    ...(detail === undefined ? {} : { detail }),
  };
}

function fail(name: string, detail?: string): Rel00Check {
  return {
    name,
    status: 'fail',
    ...(detail === undefined ? {} : { detail }),
  };
}

function checkBoolean(name: string, ok: boolean, detail?: string): Rel00Check {
  return ok ? pass(name, detail) : fail(name, detail);
}

function fieldUsesDetail(uses: readonly FeatureFieldUse[]): string {
  return uses.length === 0
    ? 'none'
    : uses.map((use) => `${use.event_type}.${use.field}->${use.canonical_field}:${use.tier}`).join(',');
}

function compareFeatureUses(left: FeatureFieldUse, right: FeatureFieldUse): number {
  return `${left.event_type}:${left.field}:${left.canonical_field}`.localeCompare(
    `${right.event_type}:${right.field}:${right.canonical_field}`,
  );
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedRecord(map: Map<string, number>): Record<string, number> {
  const record: Record<string, number> = {};
  for (const [key, value] of [...map.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    record[key] = value;
  }
  return record;
}

function ensureEmptyRel00Directory(directory: string): void {
  const resolved = resolve(directory);
  if (!resolved.toLowerCase().includes('rel00')) {
    throw new Error(`refusing to clear non-REL-00 directory: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
  mkdirSync(resolved, { recursive: true });
}

function markdownReport(report: Rel00Report): string {
  const lines = [
    '# REL-00 Controlled Live-Sim Readiness',
    '',
    `Status: ${report.status}`,
    `Safety mode: ${report.safety_mode_status}`,
    `Journal: ${report.input.journal_path}`,
    `Journal SHA-256: ${report.input.journal_sha256 ?? 'missing'}`,
    '',
    '## Checks',
    '',
    `- Transport: ${report.transport_checks.status}`,
    `- Market data: ${report.market_data_checks.status}`,
    `- Execution safety: ${report.execution_safety_checks.status}`,
    `- Feature surface: ${report.feature_surface_checks.status}`,
    `- Traceability: ${report.traceability_checks.status}`,
    '',
    '## Safety Boundary',
    '',
    `- Live data source: ${report.safety_mode.live_data_source}`,
    `- Execution mode: ${report.safety_mode.execution_mode}`,
    `- Real orders allowed: ${report.safety_mode.real_orders_allowed}`,
    `- MBO-derived runtime features allowed: ${report.safety_mode.mbo_derived_features_allowed}`,
    '',
    '## Reasons',
    '',
    ...(report.reasons.length === 0 ? ['- none'] : report.reasons.map((reason) => `- ${reason}`)),
    '',
    '## Next Blocker',
    '',
    report.next_blocker,
    '',
    '## Raw Data',
    '',
    report.no_raw_data_statement,
    '',
  ];
  return `${lines.join('\n')}`;
}

function writeSummary(result: Rel00Result): string {
  return [
    `REL-00 controlled live-sim readiness: ${result.report.status}`,
    `json=${result.report.generated_output_paths.json}`,
    `markdown=${result.report.generated_output_paths.markdown}`,
    `next_blocker=${result.report.next_blocker}`,
    '',
  ].join('\n');
}

function parseArgs(args: readonly string[]): Rel00Options {
  const options: {
    journal?: string;
    out_json?: string;
    out_md?: string;
    validation_dir?: string;
    min_source_events?: number;
  } = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    switch (flag) {
      case '--journal':
        index += 1;
        options.journal = requireArgValue(flag, args[index]);
        break;
      case '--out':
      case '--out-json':
        index += 1;
        options.out_json = requireArgValue(flag, args[index]);
        break;
      case '--out-md':
        index += 1;
        options.out_md = requireArgValue(flag, args[index]);
        break;
      case '--validation-dir':
        index += 1;
        options.validation_dir = requireArgValue(flag, args[index]);
        break;
      case '--min-source-events':
        index += 1;
        options.min_source_events = parsePositiveInteger(flag, requireArgValue(flag, args[index]));
        break;
      case '--help':
        processStdout.write(usage());
        processExit(0);
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (options.journal === undefined) {
    throw new Error('--journal is required');
  }
  return {
    journal: options.journal,
    ...(options.out_json === undefined ? {} : { out_json: options.out_json }),
    ...(options.out_md === undefined ? {} : { out_md: options.out_md }),
    ...(options.validation_dir === undefined ? {} : { validation_dir: options.validation_dir }),
    ...(options.min_source_events === undefined ? {} : { min_source_events: options.min_source_events }),
  };
}

function usage(): string {
  return [
    'Usage: npm run rel:00:controlled-live-sim -- --journal path [--out path] [--out-md path] [--min-source-events n]',
    '',
    'Validates a controlled live-Rithmic / simulated-execution journal without embedding raw data.',
    '',
  ].join('\n');
}

function requireArgValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function toReportPath(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  if (!rel.startsWith('..') && !isAbsolute(rel)) {
    return rel === '' ? '.' : rel.split(sep).join('/');
  }
  return path.split(sep).join('/');
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  try {
    const result = await runRel00ControlledLiveSimReadiness(parseArgs(processArgv.slice(2)));
    processStdout.write(writeSummary(result));
    processExit(result.exit_code);
  } catch (error) {
    processStderr.write(`REL-00 invalid input/config/environment: ${errorMessage(error)}\n`);
    processExit(3);
  }
}

if (processArgv[1] !== undefined && resolve(processArgv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
