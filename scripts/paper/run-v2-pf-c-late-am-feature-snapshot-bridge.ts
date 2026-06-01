import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-FEATURE-SNAPSHOT-BRIDGE-01' as const;
const PRIOR_TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-LIVE-CAPTURE-BRIDGE-01' as const;
const DEFAULT_SOURCE_OBS_PATH =
  'D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-01/MNQ_globex.obs01.jsonl';
const DEFAULT_PRIOR_BRIDGE_REPORT_PATH =
  'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-live-capture-bridge-01/live-capture-bridge-report.json';
const DEFAULT_OUT_DIR =
  'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-feature-snapshot-bridge-01';
const DEFAULT_MAX_EVENTS = 120;
const DEFAULT_MAX_SNAPSHOTS = 120;
const EMPTY_FEATURE_SNAPSHOT_PAYLOAD = '[]\n';

interface BridgeArgs {
  readonly source_obs_path: string;
  readonly prior_bridge_report_path: string;
  readonly max_events: number;
  readonly max_snapshots: number;
  readonly json_out: string;
  readonly md_out: string;
  readonly memo_out: string;
}

interface SourceSample {
  readonly events: readonly AnyJournalEventEnvelope[];
  readonly event_counts_by_type: Readonly<Record<string, number>>;
  readonly malformed_count: number;
  readonly invalid_count: number;
  readonly lines_scanned: number;
}

interface PriorBridgeAnchor {
  readonly path: string;
  readonly ticket: typeof PRIOR_TICKET | string;
  readonly classification: string;
  readonly bounded_replay_lf_sha256: string | null;
  readonly bounded_replay_event_count: number | null;
}

interface RuntimeDiagnostics {
  readonly started: boolean;
  readonly stopped: boolean;
  readonly event_count: number;
  readonly event_counts_by_type: Readonly<Record<string, number>>;
  readonly strategy_evaluation_count: number;
  readonly candidate_count: number;
  readonly order_intent_count: number;
}

interface BridgeReport {
  readonly schema_version: 1;
  readonly ticket: typeof TICKET;
  readonly strategy_id: typeof V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID;
  readonly classification:
    | 'FEATURE_SNAPSHOT_BRIDGE_CONTROL_ONLY_NOT_OBSERVATION_DAY'
    | 'FEATURE_SNAPSHOT_BRIDGE_MARKERS_PRESENT_NOT_OBSERVATION_DAY'
    | 'FEATURE_SNAPSHOT_BRIDGE_BLOCKED_EVIDENCE_GAP';
  readonly disallowed_classification: 'OBSERVATION_DAY_ELIGIBLE';
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
  readonly prior_bridge_anchor: PriorBridgeAnchor;
  readonly bounded_obs_replay: {
    readonly bounded_obs_replay_lf_sha256: string;
    readonly bounded_obs_replay_event_count: number;
    readonly bounded_obs_replay_source: 'first_valid_quote_trade_events';
  };
  readonly feature_snapshot_bridge: {
    readonly feature_source_decision:
      | 'reuse_existing_builder'
      | 'new_bounded_bridge_builder'
      | 'blocked_missing_required_fields';
    readonly feature_snapshot_payload_source:
      | 'capture_backed_feature_snapshots'
      | 'not_materialized_blocked_missing_required_fields';
    readonly feature_snapshot_source_path: string | null;
    readonly bounded_feature_snapshot_lf_sha256: string;
    readonly bounded_feature_snapshot_count: number;
    readonly max_snapshots_requested: number;
    readonly source_events_read: number;
    readonly feature_snapshots_attempted: number;
    readonly feature_snapshots_emitted: number;
    readonly feature_snapshots_rejected: number;
    readonly missing_required_context: readonly string[];
    readonly no_fabrication_policy: string;
  };
  readonly causality_assessment: {
    readonly status: 'not_evaluated_no_snapshots_emitted';
    readonly max_source_event_ts_ns_used: string | null;
    readonly max_snapshot_created_ts_ns: string | null;
    readonly future_event_count_used: 0;
    readonly source_event_range_start_ts_ns: string | null;
    readonly source_event_range_end_ts_ns: string | null;
  };
  readonly dedicated_paper_runtime: {
    readonly config_path: typeof V2_PF_C_LATE_AM_PAPER_OBSERVATION_CONFIG_PATH;
    readonly adapter_kind: 'mock';
    readonly market_data_source: string;
    readonly explicit_strategy_ids: readonly [typeof V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID];
    readonly broker_live_authorized: false;
    readonly phase_6_authorized: false;
  };
  readonly runtime_marker_counts: RuntimeDiagnostics;
  readonly bridge_findings: readonly string[];
  readonly required_next_ticket:
    | 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-FULL-DURATION-MONITOR-01'
    | 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-FEATURE-BUILDER-SCOPE-01';
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
    throw new Error(`source OBS replay path contains no QUOTE/TRADE events in first ${args.max_events} valid events`);
  }

  const boundedObsPayload = `${sourceSample.events.map((event) => journalEventToJsonLine(event)).join('\n')}\n`;
  const boundedObsReplayLfSha256 = sha256Text(boundedObsPayload);
  const priorBridgeAnchor = readPriorBridgeAnchor(args.prior_bridge_report_path);
  const missingRequiredContext = missingContextForFeatureSnapshot(sourceSample);
  const featureSnapshotPayloadLfSha256 = sha256Text(EMPTY_FEATURE_SNAPSHOT_PAYLOAD);
  const sourceTsRange = sourceEventTsRange(sourceSample.events);
  const runtimeDiagnostics = await runDedicatedRuntimeControl();

  return {
    schema_version: 1,
    ticket: TICKET,
    strategy_id: V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID,
    classification: 'FEATURE_SNAPSHOT_BRIDGE_BLOCKED_EVIDENCE_GAP',
    disallowed_classification: 'OBSERVATION_DAY_ELIGIBLE',
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
    prior_bridge_anchor: priorBridgeAnchor,
    bounded_obs_replay: {
      bounded_obs_replay_lf_sha256: boundedObsReplayLfSha256,
      bounded_obs_replay_event_count: sourceSample.events.length,
      bounded_obs_replay_source: 'first_valid_quote_trade_events',
    },
    feature_snapshot_bridge: {
      feature_source_decision: 'blocked_missing_required_fields',
      feature_snapshot_payload_source: 'not_materialized_blocked_missing_required_fields',
      feature_snapshot_source_path: null,
      bounded_feature_snapshot_lf_sha256: featureSnapshotPayloadLfSha256,
      bounded_feature_snapshot_count: 0,
      max_snapshots_requested: args.max_snapshots,
      source_events_read: sourceSample.events.length,
      feature_snapshots_attempted: 0,
      feature_snapshots_emitted: 0,
      feature_snapshots_rejected: 0,
      missing_required_context: missingRequiredContext,
      no_fabrication_policy:
        'No synthetic fixture, constant, future, or placeholder feature values are emitted as capture-backed evidence.',
    },
    causality_assessment: {
      status: 'not_evaluated_no_snapshots_emitted',
      max_source_event_ts_ns_used: null,
      max_snapshot_created_ts_ns: null,
      future_event_count_used: 0,
      source_event_range_start_ts_ns: sourceTsRange.start_ts_ns,
      source_event_range_end_ts_ns: sourceTsRange.end_ts_ns,
    },
    dedicated_paper_runtime: {
      config_path: V2_PF_C_LATE_AM_PAPER_OBSERVATION_CONFIG_PATH,
      adapter_kind: 'mock',
      market_data_source: 'simulation_control_start_stop',
      explicit_strategy_ids: [V2_PF_C_LATE_AM_PAPER_OBSERVATION_STRATEGY_ID],
      broker_live_authorized: false,
      phase_6_authorized: false,
    },
    runtime_marker_counts: runtimeDiagnostics,
    bridge_findings: [
      'The PR #295 normalized OBS replay input remains deterministic through the bounded replay LF hash.',
      'The current bounded OBS sample contains source TRADE events but no capture-backed feature snapshot payload.',
      'The bridge does not fabricate VIX, signed-shock, regime, quote, bar, spread, or queue context from constants or fixtures.',
      'Because zero feature snapshots were emitted, this run cannot produce STRAT_EVAL/CANDIDATE/ORDER_INTENT markers and remains a blocked evidence-gap control.',
      'Observation-day credit remains hard-locked to false/0.',
    ],
    required_next_ticket: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-FEATURE-BUILDER-SCOPE-01',
    authority: {
      broker_live_authorized: false,
      phase_6_authorized: false,
      active_roster_mutated: false,
      candidate_roster_mutated: false,
    },
  };
}

async function runDedicatedRuntimeControl(): Promise<RuntimeDiagnostics> {
  const tempDir = mkdtempSync(resolvePath(tmpdir(), 'qfa-feature-snapshot-bridge-'));
  try {
    const journalDir = resolvePath(tempDir, 'paper-journal');
    const baseConfig = resolveV2PfCLateAmPaperObservationConfig();
    const session = new PaperTradingSession({
      env: {},
      config: {
        ...baseConfig,
        adapter_kind: 'mock',
        journal_dir: journalDir,
        metrics_endpoint: { enabled: false, port: 0 },
        duration_ms: 0,
        shutdown_quarantine_timeout_ms: 0,
      },
    });
    await session.start();
    await session.stop();
    const diagnostics = session.getDiagnostics();
    const counts = sortRecord(diagnostics.event_counts_by_type);
    return {
      started: diagnostics.started,
      stopped: diagnostics.stopped,
      event_count: diagnostics.event_count,
      event_counts_by_type: counts,
      strategy_evaluation_count: counts.STRAT_EVAL ?? 0,
      candidate_count: counts.CANDIDATE ?? 0,
      order_intent_count: counts.ORDER_INTENT ?? 0,
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

function missingContextForFeatureSnapshot(sample: SourceSample): readonly string[] {
  const counts = sample.event_counts_by_type;
  const missing = [
    'capture_backed_strategy_feature_snapshot_builder',
    'capture_backed_vix_value',
    'capture_backed_vix_fresh',
    'capture_backed_vix_prior_close_percentile',
    'capture_backed_signed_shock_vwap',
    'capture_backed_signed_shock_vwap_recent_values',
    'capture_backed_regime_label',
    'capture_backed_primary_percentile',
    'capture_backed_vxn_percentile',
    'capture_backed_spread_queue_context',
    'capture_backed_bar_context',
  ];
  if ((counts.QUOTE ?? 0) === 0) {
    missing.unshift('capture_quote_context');
  }
  return missing;
}

function sourceEventTsRange(events: readonly AnyJournalEventEnvelope[]): {
  readonly start_ts_ns: string | null;
  readonly end_ts_ns: string | null;
} {
  let start: bigint | undefined;
  let end: bigint | undefined;
  for (const event of events) {
    const ts = BigInt(String(event.ts_ns));
    start = start === undefined || ts < start ? ts : start;
    end = end === undefined || ts > end ? ts : end;
  }
  return {
    start_ts_ns: start === undefined ? null : start.toString(),
    end_ts_ns: end === undefined ? null : end.toString(),
  };
}

function readPriorBridgeAnchor(path: string): PriorBridgeAnchor {
  const resolvedPath = resolvePath(path);
  if (!existsSync(resolvedPath)) {
    return {
      path: resolvedPath,
      ticket: PRIOR_TICKET,
      classification: 'missing_prior_bridge_report',
      bounded_replay_lf_sha256: null,
      bounded_replay_event_count: null,
    };
  }
  const parsed = JSON.parse(readFileSync(resolvedPath, 'utf8')) as {
    readonly ticket?: string;
    readonly classification?: string;
    readonly bridge_input?: {
      readonly bounded_replay_lf_sha256?: string;
      readonly bounded_replay_event_count?: number;
    };
  };
  return {
    path: resolvedPath,
    ticket: parsed.ticket ?? PRIOR_TICKET,
    classification: parsed.classification ?? 'unknown',
    bounded_replay_lf_sha256: parsed.bridge_input?.bounded_replay_lf_sha256 ?? null,
    bounded_replay_event_count: parsed.bridge_input?.bounded_replay_event_count ?? null,
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
  return {
    source_obs_path: args.source_obs_path ?? DEFAULT_SOURCE_OBS_PATH,
    prior_bridge_report_path: args.prior_bridge_report_path ?? DEFAULT_PRIOR_BRIDGE_REPORT_PATH,
    max_events: positiveIntegerArg(args.max_events, '--max-events', DEFAULT_MAX_EVENTS),
    max_snapshots: positiveIntegerArg(args.max_snapshots, '--max-snapshots', DEFAULT_MAX_SNAPSHOTS),
    json_out: args.json_out ?? `${DEFAULT_OUT_DIR}/feature-snapshot-bridge-report.json`,
    md_out: args.md_out ?? `${DEFAULT_OUT_DIR}/feature-snapshot-bridge-report.md`,
    memo_out: args.memo_out ?? 'docs/research/v2-pf-c-late-am-paper-observation-feature-snapshot-bridge-01-memo.md',
  };
}

function positiveIntegerArg(value: string | undefined, label: string, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function writeOutputs(report: BridgeReport, args: BridgeArgs): void {
  mkdirSync(dirname(args.json_out), { recursive: true });
  mkdirSync(dirname(args.md_out), { recursive: true });
  mkdirSync(dirname(args.memo_out), { recursive: true });
  writeFileSync(args.json_out, `${stableStringify(report)}\n`, 'utf8');
  writeFileSync(args.md_out, `${markdownReport(report)}\n`, 'utf8');
  writeFileSync(args.memo_out, `${memoReport(report)}\n`, 'utf8');
}

function markdownReport(report: BridgeReport): string {
  return [
    '# V2 PF C late-AM feature-snapshot bridge report',
    '',
    `Ticket: \`${report.ticket}\``,
    '',
    `Classification: \`${report.classification}\``,
    '',
    '## Bounded source input',
    '',
    `- Source OBS path: \`${report.source_obs.path}\``,
    `- Full source SHA-256: \`${report.source_obs.sha256}\``,
    `- Full source SHA scope: \`${report.source_obs.sha256_scope}\``,
    `- Bounded OBS replay LF SHA-256: \`${report.bounded_obs_replay.bounded_obs_replay_lf_sha256}\``,
    `- Bounded OBS replay event count: ${report.bounded_obs_replay.bounded_obs_replay_event_count}`,
    `- Source event counts: ${inlineCounts(report.source_obs.event_counts_by_type)}`,
    '',
    '## Feature-snapshot bridge',
    '',
    `- Decision: \`${report.feature_snapshot_bridge.feature_source_decision}\``,
    `- Feature snapshot payload source: \`${report.feature_snapshot_bridge.feature_snapshot_payload_source}\``,
    `- Bounded feature snapshot LF SHA-256: \`${report.feature_snapshot_bridge.bounded_feature_snapshot_lf_sha256}\``,
    `- Bounded feature snapshot count: ${report.feature_snapshot_bridge.bounded_feature_snapshot_count}`,
    `- Snapshots attempted/emitted/rejected: ${report.feature_snapshot_bridge.feature_snapshots_attempted}/${report.feature_snapshot_bridge.feature_snapshots_emitted}/${report.feature_snapshot_bridge.feature_snapshots_rejected}`,
    '',
    'Missing required context:',
    '',
    ...report.feature_snapshot_bridge.missing_required_context.map((item) => `- \`${item}\``),
    '',
    '## Causality',
    '',
    `- Status: \`${report.causality_assessment.status}\``,
    `- Source event range start: \`${report.causality_assessment.source_event_range_start_ts_ns}\``,
    `- Source event range end: \`${report.causality_assessment.source_event_range_end_ts_ns}\``,
    `- Future event count used: ${report.causality_assessment.future_event_count_used}`,
    '',
    '## Runtime markers',
    '',
    `- Event counts: ${inlineCounts(report.runtime_marker_counts.event_counts_by_type)}`,
    `- STRAT_EVAL: ${report.runtime_marker_counts.strategy_evaluation_count}`,
    `- CANDIDATE: ${report.runtime_marker_counts.candidate_count}`,
    `- ORDER_INTENT: ${report.runtime_marker_counts.order_intent_count}`,
    '',
    '## Observation-day decision',
    '',
    `- Observation-day eligible: ${String(report.observation_day_eligible)}`,
    `- Observation-day increment: ${report.observation_day_increment}`,
    '',
    'This monitor verifies bridge/control evidence only. It does not count toward the 45/60 paper-observation day requirement.',
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

function memoReport(report: BridgeReport): string {
  return [
    '# V2-PF-C-LATE-AM-PAPER-OBSERVATION-FEATURE-SNAPSHOT-BRIDGE-01 memo',
    '',
    '## Context',
    '',
    'PR #295 proved that a bounded normalized Rithmic `obs01` sample can be replayed into the dedicated paper-observation runtime path as source `TRADE` events. It did not produce strategy runtime markers because it did not derive feature snapshots.',
    '',
    'This ticket checks whether the same capture-backed lane can produce causal `StrategyFeatureSnapshot` input for `PaperTradingSession.processFeatureSnapshot(...)` without using active-roster fallback, broker/live execution, synthetic fixtures, or observation-day credit.',
    '',
    '## Source evidence',
    '',
    `- Source OBS path: \`${report.source_obs.path}\``,
    `- Full source OBS SHA-256: \`${report.source_obs.sha256}\``,
    `- Full source SHA scope: \`${report.source_obs.sha256_scope}\`; the live capture may grow, so this is point-in-time evidence only.`,
    `- Bounded OBS replay LF SHA-256: \`${report.bounded_obs_replay.bounded_obs_replay_lf_sha256}\``,
    `- Bounded OBS replay event count: ${report.bounded_obs_replay.bounded_obs_replay_event_count}`,
    `- Source sample event counts: ${inlineCounts(report.source_obs.event_counts_by_type)}`,
    '',
    'Prior bridge anchor:',
    '',
    `- Prior ticket: \`${report.prior_bridge_anchor.ticket}\``,
    `- Prior classification: \`${report.prior_bridge_anchor.classification}\``,
    `- Prior bounded replay LF SHA-256: \`${report.prior_bridge_anchor.bounded_replay_lf_sha256}\``,
    `- Prior bounded replay event count: ${report.prior_bridge_anchor.bounded_replay_event_count}`,
    '',
    '## Feature source decision',
    '',
    `Decision: \`${report.feature_snapshot_bridge.feature_source_decision}\``,
    '',
    'The bridge is blocked because the bounded capture sample does not include enough causal feature context to construct a capture-backed `StrategyFeatureSnapshot` without fabrication.',
    '',
    'Missing context:',
    '',
    ...report.feature_snapshot_bridge.missing_required_context.map((item) => `- \`${item}\``),
    '',
    'No synthetic fixtures, constants, future data, or placeholder VIX/signed-shock/regime values were emitted as capture-backed feature evidence.',
    '',
    '## Bounded feature-snapshot payload',
    '',
    `- Feature snapshot payload source: \`${report.feature_snapshot_bridge.feature_snapshot_payload_source}\``,
    `- Bounded feature snapshot LF SHA-256: \`${report.feature_snapshot_bridge.bounded_feature_snapshot_lf_sha256}\``,
    `- Bounded feature snapshot count: ${report.feature_snapshot_bridge.bounded_feature_snapshot_count}`,
    `- Feature snapshots attempted/emitted/rejected: ${report.feature_snapshot_bridge.feature_snapshots_attempted}/${report.feature_snapshot_bridge.feature_snapshots_emitted}/${report.feature_snapshot_bridge.feature_snapshots_rejected}`,
    '',
    '## Causality assessment',
    '',
    `- Status: \`${report.causality_assessment.status}\``,
    `- Source event range: \`${report.causality_assessment.source_event_range_start_ts_ns}\` to \`${report.causality_assessment.source_event_range_end_ts_ns}\``,
    `- Future event count used: ${report.causality_assessment.future_event_count_used}`,
    '',
    'Because no snapshots were emitted, there is no per-snapshot causality proof to evaluate. The bridge therefore remains blocked rather than claiming marker success.',
    '',
    '## Dedicated runtime control',
    '',
    `- Config path: \`${report.dedicated_paper_runtime.config_path}\``,
    `- Strategy: \`${report.strategy_id}\``,
    `- Adapter: \`${report.dedicated_paper_runtime.adapter_kind}\``,
    `- Explicit strategy IDs: \`${report.dedicated_paper_runtime.explicit_strategy_ids.join(',')}\``,
    `- Runtime event counts: ${inlineCounts(report.runtime_marker_counts.event_counts_by_type)}`,
    `- STRAT_EVAL: ${report.runtime_marker_counts.strategy_evaluation_count}`,
    `- CANDIDATE: ${report.runtime_marker_counts.candidate_count}`,
    `- ORDER_INTENT: ${report.runtime_marker_counts.order_intent_count}`,
    '',
    '## Classification',
    '',
    `\`${report.classification}\``,
    '',
    'This is a bridge/control evidence result, not a paper-observation day.',
    '',
    '## Observation-day eligibility',
    '',
    `Observation-day eligible: ${String(report.observation_day_eligible)}.`,
    '',
    `Observation-day increment: \`${report.observation_day_increment}\`.`,
    '',
    '## Recommended next ticket',
    '',
    `\`${report.required_next_ticket}\``,
    '',
    'Purpose: scope or implement a causal feature builder that can derive the required VIX, signed-shock, regime, quote/bar, and microstructure context from capture-backed inputs without lookahead.',
    '',
    '## Authority caveat',
    '',
    'This ticket creates no broker/live authority, no Phase 6 authority, no active-roster authority, no candidate-roster authority, and no observation-day credit.',
    '',
    '## Verification',
    '',
    'The worker report records command exits and hygiene status.',
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
  process.stdout.write(
    `source_events=${report.source_obs.sampled_events} feature_snapshots=${report.feature_snapshot_bridge.feature_snapshots_emitted} strat_eval=${report.runtime_marker_counts.strategy_evaluation_count}\n`,
  );
}
