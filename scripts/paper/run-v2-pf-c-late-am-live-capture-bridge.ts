import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import {
  journalEventFromJsonLine,
  journalEventToJsonLine,
  type AnyJournalEventEnvelope,
} from '../../apps/strategy_runtime/src/contracts/index.js';
import { validateJournalEventEnvelope } from '../../apps/strategy_runtime/src/contracts/events/schema.js';
import { PaperTradingSession } from '../../apps/strategy_runtime/src/paper-trading/index.js';
import {
  V2_PF_C_LATE_AM_PAPER_OBSERVATION_CONFIG_PATH,
  V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID,
  resolveV2PfCLateAmPaperObservationConfig,
} from './run-v2-pf-c-late-am-paper-observation.js';

const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-LIVE-CAPTURE-BRIDGE-01' as const;
const DEFAULT_SOURCE_OBS_PATH =
  'D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-01/MNQ_globex.obs01.jsonl';
const DEFAULT_OUT_DIR = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-live-capture-bridge-01';
const DEFAULT_MAX_EVENTS = 120;

interface BridgeArgs {
  readonly source_obs_path: string;
  readonly max_events: number;
  readonly json_out: string;
  readonly md_out: string;
}

interface SourceSample {
  readonly events: readonly AnyJournalEventEnvelope[];
  readonly event_counts_by_type: Readonly<Record<string, number>>;
  readonly malformed_count: number;
  readonly invalid_count: number;
  readonly lines_scanned: number;
}

interface BridgeReport {
  readonly schema_version: 1;
  readonly ticket: typeof TICKET;
  readonly strategy_id: typeof V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID;
  readonly classification:
    | 'LOCAL_OBS_REPLAY_BRIDGE_CONTROL_ONLY_NOT_OBSERVATION_DAY'
    | 'PAPER_RUNTIME_MARKERS_PRESENT_BRIDGE_ONLY_NOT_OBSERVATION_DAY';
  readonly observation_day_eligible: false;
  readonly observation_day_increment: 0;
  readonly source_obs: {
    readonly path: string;
    readonly exists: boolean;
    readonly size_bytes: number;
    readonly mtime_utc: string;
    readonly sha256: string;
    readonly sha256_scope: 'point_in_time_full_file';
    readonly max_events_requested: number;
    readonly lines_scanned: number;
    readonly sampled_events: number;
    readonly event_counts_by_type: Readonly<Record<string, number>>;
    readonly malformed_count: number;
    readonly invalid_count: number;
  };
  readonly bridge_input: {
    readonly bounded_replay_lf_sha256: string;
    readonly bounded_replay_event_count: number;
    readonly bounded_replay_source: 'first_valid_quote_trade_events';
  };
  readonly verification_anchors: {
    readonly sha256_scope: 'point_in_time_full_file';
    readonly bounded_replay_lf_sha256: string;
    readonly bounded_replay_event_count: number;
    readonly future_marker_classification: 'PAPER_RUNTIME_MARKERS_PRESENT_BRIDGE_ONLY_NOT_OBSERVATION_DAY';
  };
  readonly dedicated_paper_runtime: {
    readonly config_path: typeof V2_PF_C_LATE_AM_PAPER_OBSERVATION_CONFIG_PATH;
    readonly adapter_kind: 'mock';
    readonly market_data_source: 'local_obs_replay';
    readonly explicit_strategy_ids: readonly [typeof V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID];
    readonly broker_live_authorized: false;
    readonly phase_6_authorized: false;
  };
  readonly paper_runtime_result: {
    readonly started: boolean;
    readonly stopped: boolean;
    readonly event_count: number;
    readonly event_counts_by_type: Readonly<Record<string, number>>;
    readonly strategy_evaluation_count: number;
    readonly candidate_count: number;
    readonly order_intent_count: number;
    readonly quote_count: number;
    readonly trade_count: number;
    readonly local_obs_events_bridged: number;
  };
  readonly bridge_findings: readonly string[];
  readonly required_next_ticket: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-FEATURE-SNAPSHOT-BRIDGE-01';
  readonly authority: {
    readonly broker_live_authorized: false;
    readonly phase_6_authorized: false;
    readonly active_roster_mutated: false;
    readonly candidate_roster_mutated: false;
  };
}

export async function runBridge(args: BridgeArgs): Promise<BridgeReport> {
  const sourcePath = resolvePath(args.source_obs_path);
  if (!existsSync(sourcePath)) {
    throw new Error(`source OBS replay path does not exist: ${sourcePath}`);
  }

  const sourceStat = statSync(sourcePath);
  const [sourceSha256, sourceSample] = await Promise.all([
    sha256File(sourcePath),
    readSourceSample(sourcePath, args.max_events),
  ]);
  if (sourceSample.events.length === 0) {
    throw new Error(`source OBS replay path contains no QUOTE/TRADE events in first ${args.max_events} events`);
  }

  const tempDir = mkdtempSync(resolvePath(tmpdir(), 'qfa-live-capture-bridge-'));
  try {
    const replayPath = resolvePath(tempDir, 'bounded-local-obs-replay.jsonl');
    const journalDir = resolvePath(tempDir, 'paper-journal');
    const boundedReplayPayload = `${sourceSample.events.map((event) => journalEventToJsonLine(event)).join('\n')}\n`;
    const boundedReplayLfSha256 = sha256Text(boundedReplayPayload);
    writeFileSync(replayPath, boundedReplayPayload, 'utf8');

    const baseConfig = resolveV2PfCLateAmPaperObservationConfig();
    const session = new PaperTradingSession({
      env: {},
      config: {
        ...baseConfig,
        adapter_kind: 'mock',
        market_data_source: 'local_obs_replay',
        local_obs_replay_path: replayPath,
        local_obs_replay_pace_mode: 'as_fast_as_possible',
        journal_dir: journalDir,
        metrics_endpoint: { enabled: false, port: 0 },
        duration_ms: 0,
        shutdown_quarantine_timeout_ms: 0,
      },
    });

    await session.start();
    await session.stop();

    const diagnostics = session.getDiagnostics();
    const counts = diagnostics.event_counts_by_type;
    const strategyEvaluationCount = counts.STRAT_EVAL ?? 0;
    const candidateCount = counts.CANDIDATE ?? 0;
    const orderIntentCount = counts.ORDER_INTENT ?? 0;
    const quoteCount = counts.QUOTE ?? 0;
    const tradeCount = counts.TRADE ?? 0;
    const classification = strategyEvaluationCount > 0
      ? 'PAPER_RUNTIME_MARKERS_PRESENT_BRIDGE_ONLY_NOT_OBSERVATION_DAY'
      : 'LOCAL_OBS_REPLAY_BRIDGE_CONTROL_ONLY_NOT_OBSERVATION_DAY';

    return {
      schema_version: 1,
      ticket: TICKET,
      strategy_id: V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID,
      classification,
      observation_day_eligible: false,
      observation_day_increment: 0,
      source_obs: {
        path: sourcePath,
        exists: true,
        size_bytes: sourceStat.size,
        mtime_utc: sourceStat.mtime.toISOString(),
        sha256: sourceSha256,
        sha256_scope: 'point_in_time_full_file',
        max_events_requested: args.max_events,
        lines_scanned: sourceSample.lines_scanned,
        sampled_events: sourceSample.events.length,
        event_counts_by_type: sourceSample.event_counts_by_type,
        malformed_count: sourceSample.malformed_count,
        invalid_count: sourceSample.invalid_count,
      },
      bridge_input: {
        bounded_replay_lf_sha256: boundedReplayLfSha256,
        bounded_replay_event_count: sourceSample.events.length,
        bounded_replay_source: 'first_valid_quote_trade_events',
      },
      verification_anchors: {
        sha256_scope: 'point_in_time_full_file',
        bounded_replay_lf_sha256: boundedReplayLfSha256,
        bounded_replay_event_count: sourceSample.events.length,
        future_marker_classification: 'PAPER_RUNTIME_MARKERS_PRESENT_BRIDGE_ONLY_NOT_OBSERVATION_DAY',
      },
      dedicated_paper_runtime: {
        config_path: V2_PF_C_LATE_AM_PAPER_OBSERVATION_CONFIG_PATH,
        adapter_kind: 'mock',
        market_data_source: 'local_obs_replay',
        explicit_strategy_ids: [V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID],
        broker_live_authorized: false,
        phase_6_authorized: false,
      },
      paper_runtime_result: {
        started: diagnostics.started,
        stopped: diagnostics.stopped,
        event_count: diagnostics.event_count,
        event_counts_by_type: counts,
        strategy_evaluation_count: strategyEvaluationCount,
        candidate_count: candidateCount,
        order_intent_count: orderIntentCount,
        quote_count: quoteCount,
        trade_count: tradeCount,
        local_obs_events_bridged: quoteCount + tradeCount,
      },
      bridge_findings: [
        'Normalized Rithmic OBS JSONL can be consumed by the dedicated paper runtime through local_obs_replay with mock order-plant isolation.',
        'The bridge emits source QUOTE/TRADE journal events but does not create feature snapshots by itself.',
        'This bounded bridge smoke run never awards observation-day credit; any runtime markers must be routed to a later full-duration daily report or monitor ticket.',
      ],
      required_next_ticket: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-FEATURE-SNAPSHOT-BRIDGE-01',
      authority: {
        broker_live_authorized: false,
        phase_6_authorized: false,
        active_roster_mutated: false,
        candidate_roster_mutated: false,
      },
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function readSourceSample(path: string, maxEvents: number): Promise<SourceSample> {
  const events: AnyJournalEventEnvelope[] = [];
  const counts: Record<string, number> = {};
  let malformedCount = 0;
  let invalidCount = 0;
  let linesScanned = 0;

  const reader = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of reader) {
    if (events.length >= maxEvents) {
      break;
    }
    linesScanned += 1;
    if (line.trim() === '') {
      continue;
    }

    let event: AnyJournalEventEnvelope;
    try {
      event = journalEventFromJsonLine(line) as AnyJournalEventEnvelope;
    } catch {
      malformedCount += 1;
      continue;
    }

    const validation = validateJournalEventEnvelope(event);
    if (validation.issues.length > 0) {
      invalidCount += 1;
      continue;
    }
    if (event.type !== 'QUOTE' && event.type !== 'TRADE') {
      continue;
    }
    events.push(event);
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }

  reader.close();
  return {
    events,
    event_counts_by_type: sortRecord(counts),
    malformed_count: malformedCount,
    invalid_count: invalidCount,
    lines_scanned: linesScanned,
  };
}

function parseArgs(argv: readonly string[]): BridgeArgs {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith('--')) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2).replaceAll('-', '_');
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for ${arg}`);
    }
    args[key] = value;
    index += 1;
  }
  const maxEvents = args.max_events === undefined ? DEFAULT_MAX_EVENTS : Number(args.max_events);
  if (!Number.isInteger(maxEvents) || maxEvents <= 0) {
    throw new Error('--max-events must be a positive integer');
  }
  return {
    source_obs_path: args.source_obs_path ?? DEFAULT_SOURCE_OBS_PATH,
    max_events: maxEvents,
    json_out: args.json_out ?? `${DEFAULT_OUT_DIR}/live-capture-bridge-report.json`,
    md_out: args.md_out ?? `${DEFAULT_OUT_DIR}/live-capture-bridge-report.md`,
  };
}

function writeOutputs(report: BridgeReport, args: BridgeArgs): void {
  mkdirSync(dirname(args.json_out), { recursive: true });
  mkdirSync(dirname(args.md_out), { recursive: true });
  writeFileSync(args.json_out, `${stableStringify(report)}\n`, 'utf8');
  writeFileSync(args.md_out, `${markdownReport(report)}\n`, 'utf8');
}

function markdownReport(report: BridgeReport): string {
  const counts = report.paper_runtime_result.event_counts_by_type;
  return [
    '# V2 PF C late-AM live-capture bridge report',
    '',
    `Ticket: \`${report.ticket}\``,
    '',
    `Classification: \`${report.classification}\``,
    '',
    '## Source OBS',
    '',
    `- Path: \`${report.source_obs.path}\``,
    `- SHA-256: \`${report.source_obs.sha256}\``,
    `- Sampled events: ${report.source_obs.sampled_events}`,
    `- Source event counts: ${inlineCounts(report.source_obs.event_counts_by_type)}`,
    `- Full source SHA scope: \`${report.source_obs.sha256_scope}\``,
    `- Bounded replay LF SHA-256: \`${report.bridge_input.bounded_replay_lf_sha256}\``,
    `- Bounded replay event count: ${report.bridge_input.bounded_replay_event_count}`,
    '',
    'Review anchor fields:',
    '',
    '```json',
    JSON.stringify({
      sha256_scope: report.verification_anchors.sha256_scope,
      bounded_replay_lf_sha256: report.verification_anchors.bounded_replay_lf_sha256,
      bounded_replay_event_count: report.verification_anchors.bounded_replay_event_count,
      future_marker_classification: report.verification_anchors.future_marker_classification,
    }, null, 2),
    '```',
    '',
    '## Dedicated paper runtime',
    '',
    `- Strategy: \`${report.strategy_id}\``,
    `- Config: \`${report.dedicated_paper_runtime.config_path}\``,
    `- Adapter: \`${report.dedicated_paper_runtime.adapter_kind}\``,
    `- Market data source: \`${report.dedicated_paper_runtime.market_data_source}\``,
    '',
    '## Runtime event counts',
    '',
    `- Total events: ${report.paper_runtime_result.event_count}`,
    `- Counts: ${inlineCounts(counts)}`,
    `- STRAT_EVAL: ${report.paper_runtime_result.strategy_evaluation_count}`,
    `- CANDIDATE: ${report.paper_runtime_result.candidate_count}`,
    `- ORDER_INTENT: ${report.paper_runtime_result.order_intent_count}`,
    '',
    '## Interpretation',
    '',
    ...report.bridge_findings.map((finding) => `- ${finding}`),
    '',
    '## Observation-day decision',
    '',
    `Observation-day eligible: ${String(report.observation_day_eligible)}`,
    '',
    `Observation-day increment: ${report.observation_day_increment}`,
    '',
    'This bridge verifies local replay ingestion of normalized capture events into the dedicated paper runtime. It does not count toward the 45/60 paper-observation requirement unless strategy-runtime evidence is present.',
    '',
    '## Next ticket',
    '',
    `\`${report.required_next_ticket}\``,
    '',
    '## Authority',
    '',
    `- Broker/live authorized: ${String(report.authority.broker_live_authorized)}`,
    `- Phase 6 authorized: ${String(report.authority.phase_6_authorized)}`,
    `- Active roster mutated: ${String(report.authority.active_roster_mutated)}`,
    `- Candidate roster mutated: ${String(report.authority.candidate_roster_mutated)}`,
  ].join('\n');
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function inlineCounts(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return '(none)';
  }
  return entries.map(([key, value]) => `${key}=${value}`).join(', ');
}

function sortRecord(record: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJsonValue(child)]),
    );
  }
  return value;
}

if (process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const report = await runBridge(args);
  writeOutputs(report, args);
  process.stdout.write(`${report.classification}\n`);
  process.stdout.write(`events=${report.paper_runtime_result.event_count} strat_eval=${report.paper_runtime_result.strategy_evaluation_count}\n`);
}
