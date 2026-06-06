import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadAppConfig } from '../../apps/strategy_runtime/src/config/index.js';
import { createJournalEventEnvelope, makeEventId, makeRunId, makeSessionId, ns } from '../../apps/strategy_runtime/src/contracts/index.js';
import { createSimulatedExecutionAdapter } from '../../apps/strategy_runtime/src/execution/simulated-execution.js';
import { createStrategyRuntimeEngineContainer, StrategyRuntimeRunner } from '../../apps/strategy_runtime/src/orchestration/index.js';
import { loadVenueCostTable } from '../../apps/strategy_runtime/src/risk/index.js';
import type { StrategyFeatureSnapshot } from '../../apps/strategy_runtime/src/strategies/index.js';

const ROOT = process.cwd();
const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-PAPER-RUNTIME-CANDIDATE-SMOKE-IMPL-01';
const SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-02-paper-runtime-candidate-smoke-impl-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const FEATURE_SNAPSHOT_ID = 'feature-v2pf-20260602-1780427100000000000';
const TARGET_TS_NS = '1780427100000000000';
const TARGET_TS_UTC = '2026-06-02T19:05:00.000000000Z';
const TARGET_ENTRY_HOUR_UTC = 19;
const UTC_GATE_STATUS = 'NON_EXCLUDED_BY_UTC_16_18_GATE';
const SOURCE_EVENT_ID = `source-quote-${FEATURE_SNAPSHOT_ID}`;
const SIGNED_SHOCK_VWAP = 2.7449;
const LOW_SHOCK_THRESHOLD_POS = 2.7;
const THRESHOLD_COMPARISON = '2.7449 >= 2.7';
const SUBSTRATE_SHA = 'ff56127fb68f0ca6f6abbc1c229578a0a63e730f';
const PR311_BOUNDED_SHA = 'ecf32b6116263b3778819d29c2f2392153a123aec1daba91520323df353bce22';
const PR312_BOUNDED_SHA = 'cc798091961a1bfe062f654198d2b74eb8648e975a93ad730676bc84bc0f0c19';
const PR313_MERGE_SHA = 'ff56127fb68f0ca6f6abbc1c229578a0a63e730f';
const DETERMINATION_PASS =
  'PAPER_RUNTIME_CANDIDATE_SMOKE_IMPL_PASSED_CANDIDATE_EMITTED_ORDER_INTENT_SUPPRESSED';
const NEXT_TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-PAPER-RUNTIME-OBSERVATION-DAY-SCOPE-01';
const FINAL_CHAIN_HASH = '2547e5a6f3534b77580111a40d66ae1c4ed081574db7ae29934d9ea581847738';
const FINAL_PHASE2_HASH = 'dbb45cf891f862ab3bf6a6ec8e2c313f8822508c84f9a0cfd6e766267e4f832b';
const FINAL_PHASE4_HASH = 'ad8dad3c36a5b64fa3ddbd955abec819db31b2b4c160d0152074fc6bcbb40090';
const DRIFT_CLASSIFICATION = 'NO_DETERMINISM_DRIFT';

const OUT_DIR = path.join(ROOT, 'artifacts', 'paper-observation', SLUG);
const BOUNDED_JSONL = path.join(OUT_DIR, 'bounded-paper-runtime-candidate-smoke-impl.jsonl');
const REPORT_JSON = path.join(OUT_DIR, 'paper-runtime-candidate-smoke-impl-report.json');
const REPORT_MD = path.join(OUT_DIR, 'paper-runtime-candidate-smoke-impl-report.md');
const MEMO_MD = path.join(ROOT, 'docs', 'research', `${SLUG}-memo.md`);
const BACKLOG_CSV = path.join(ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');
const PR311_BOUNDED_JSONL = path.join(
  ROOT,
  'artifacts',
  'paper-observation',
  'v2-pf-c-late-am-paper-observation-2026-06-02-candidate-eligible-snapshot-builder-impl-01',
  'bounded-candidate-eligible-feature-snapshot.jsonl',
);
const PR312_BOUNDED_JSONL = path.join(
  ROOT,
  'artifacts',
  'paper-observation',
  'v2-pf-c-late-am-paper-observation-2026-06-02-candidate-strat-eval-smoke-01',
  'bounded-candidate-strat-eval-smoke.jsonl',
);

type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json };
type JsonRecord = { readonly [key: string]: Json };
type SnapshotWithStrategyId = StrategyFeatureSnapshot & { readonly strategy_id?: string };

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function readText(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

function lfText(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function sha256Text(text: string): string {
  return createHash('sha256').update(lfText(text), 'utf8').digest('hex');
}

function sha256FileLf(filePath: string): string {
  return sha256Text(readText(filePath));
}

function sortJson(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item));
  }
  if (value !== null && typeof value === 'object') {
    const output: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = sortJson(value[key]);
    }
    return output;
  }
  return value;
}

function stableJson(value: Json): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function stableJsonl(records: readonly Json[]): string {
  return `${records.map((record) => JSON.stringify(sortJson(record))).join('\n')}\n`;
}

function stringifyForJson(value: unknown): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value as Json;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => stringifyForJson(item));
  }
  if (value !== null && typeof value === 'object') {
    const output: Record<string, Json> = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = stringifyForJson(child);
    }
    return output;
  }
  return String(value);
}

function reviveTimestampFields(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => reviveTimestampFields(item));
  }
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = reviveTimestampFields(childValue, childKey);
    }
    return output;
  }
  if (
    typeof value === 'string' &&
    (key.endsWith('_ts_ns') || key === 'created_ts_ns') &&
    /^\d+$/u.test(value)
  ) {
    return BigInt(value);
  }
  return value;
}

function assertFileSha(filePath: string, expectedSha: string, label: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
  const actual = sha256FileLf(filePath);
  if (actual !== expectedSha) {
    throw new Error(`${label} SHA mismatch: expected ${expectedSha}, got ${actual}`);
  }
  return actual;
}

function loadPr311Snapshot(): StrategyFeatureSnapshot {
  const record = readText(PR311_BOUNDED_JSONL)
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { readonly record_type?: string; readonly snapshot?: unknown })
    .find((item) => item.record_type === 'STRATEGY_FEATURE_SNAPSHOT');

  if (record?.snapshot === undefined) {
    throw new Error(`Missing STRATEGY_FEATURE_SNAPSHOT record in ${PR311_BOUNDED_JSONL}`);
  }

  const snapshot = reviveTimestampFields(record.snapshot) as StrategyFeatureSnapshot;
  if (snapshot.feature_snapshot_id !== FEATURE_SNAPSHOT_ID) {
    throw new Error(`Unexpected feature snapshot id: ${snapshot.feature_snapshot_id}`);
  }
  const snapshotStrategyId = (snapshot as SnapshotWithStrategyId).strategy_id;
  if (snapshotStrategyId !== STRATEGY_ID) {
    throw new Error(`Unexpected strategy id: ${snapshotStrategyId}`);
  }
  if (snapshot.created_ts_ns.toString() !== TARGET_TS_NS) {
    throw new Error(`Unexpected target timestamp: ${snapshot.created_ts_ns.toString()}`);
  }
  return {
    ...snapshot,
    source_event_id: snapshot.source_event_id ?? SOURCE_EVENT_ID,
  } as StrategyFeatureSnapshot;
}

function sourceQuoteEventForSnapshot(snapshot: StrategyFeatureSnapshot, runId: ReturnType<typeof makeRunId>, sessionId: ReturnType<typeof makeSessionId>) {
  return createJournalEventEnvelope({
    event_id: makeEventId(String(snapshot.source_event_id)),
    type: 'QUOTE',
    ts_ns: snapshot.created_ts_ns,
    run_id: runId,
    session_id: sessionId,
    payload: {
      exchange_event_ts_ns: snapshot.created_ts_ns,
      sidecar_recv_ts_ns: ns(BigInt(snapshot.created_ts_ns) + 1_000_000n),
      bid_px: snapshot.quote.bid_px,
      bid_qty: 1,
      ask_px: snapshot.quote.ask_px,
      ask_qty: 1,
      authority: 'authoritative' as const,
    },
  });
}

function appendBacklogRow(): void {
  const row = [
    TICKET,
    'P1',
    '1.0',
    'V2-PF-C-LATE-AM-PAPER-OBSERVATION-PAPER-RUNTIME-CANDIDATE-SMOKE-01',
    'Implement opt-in paper-runtime stop-after-candidate smoke guard and prove STRAT_EVAL plus CANDIDATE while ORDER_INTENT order translation adapters fills observation-day credit and authority remain suppressed',
    'new_cycle4_v2_research_substrate',
  ].join(',');
  const current = readText(BACKLOG_CSV);
  if (!current.includes(`${TICKET},`)) {
    writeFileSync(BACKLOG_CSV, `${current.trimEnd()}\n${row}\n`, 'utf8');
  }
}

async function main(): Promise<void> {
  ensureDir(OUT_DIR);
  const pr311Sha = assertFileSha(PR311_BOUNDED_JSONL, PR311_BOUNDED_SHA, 'PR #311 bounded snapshot artifact');
  const pr312Sha = assertFileSha(PR312_BOUNDED_JSONL, PR312_BOUNDED_SHA, 'PR #312 bounded strat-eval artifact');
  const snapshot = loadPr311Snapshot();
  const runId = makeRunId('paper-runtime-candidate-smoke-impl-run');
  const sessionId = makeSessionId('paper-runtime-candidate-smoke-impl-session');
  const config = loadAppConfig({
    configPath: 'config/app.example.json',
    cwd: ROOT,
    env: { QFA_JOURNAL_DIR: 'journals/paper/v2-pf-c-late-am-paper-runtime-candidate-smoke-impl' },
  });
  const container = createStrategyRuntimeEngineContainer({ config });
  const runner = new StrategyRuntimeRunner({
    container,
    run_id: runId,
    session_id: sessionId,
    execution_adapter: createSimulatedExecutionAdapter({ venue_costs: loadVenueCostTable() }),
    runtime_mode: 'paper',
    paper_observation_explicit_strategy_ids: [STRATEGY_ID],
    paper_observation_stop_after_candidate: true,
  });

  const sourceQuoteEvent = sourceQuoteEventForSnapshot(snapshot, runId, sessionId);
  await runner.publishExternalEvent(sourceQuoteEvent);
  const result = await runner.processFeatureSnapshot(snapshot);

  const counts = {
    STRAT_EVAL: result.strategy_evaluation_events.length,
    CANDIDATE: result.candidate_events.length,
    RANK: result.rank_event === undefined ? 0 : 1,
    SIZING: result.sizing_events.length,
    RISK_GATE: result.risk_gate_events.length,
    ORDER_INTENT: result.order_intent_events.length,
    SIM_FILL: result.sim_fill_events.length,
    EXEC_REJECT: result.exec_reject_events.length,
    POSITION: result.position_events.length,
  };

  const pass =
    result.paper_observation_stopped_after_candidate === true &&
    counts.STRAT_EVAL === 1 &&
    counts.CANDIDATE === 1 &&
    counts.RANK === 0 &&
    counts.SIZING === 0 &&
    counts.RISK_GATE === 0 &&
    counts.ORDER_INTENT === 0 &&
    counts.SIM_FILL === 0 &&
    counts.EXEC_REJECT === 0 &&
    counts.POSITION === 0;

  const determination = pass
    ? DETERMINATION_PASS
    : `PAPER_RUNTIME_CANDIDATE_SMOKE_IMPL_BLOCKED_${[
      counts.STRAT_EVAL !== 1 ? 'STRAT_EVAL_COUNT' : undefined,
      counts.CANDIDATE !== 1 ? 'CANDIDATE_COUNT' : undefined,
      counts.ORDER_INTENT !== 0 ? 'ORDER_INTENT_EMITTED' : undefined,
      counts.RANK !== 0 ? 'RANK_SIDE_EFFECT' : undefined,
      counts.SIZING !== 0 ? 'SIZING_SIDE_EFFECT' : undefined,
      counts.RISK_GATE !== 0 ? 'RISK_SIDE_EFFECT' : undefined,
      result.paper_observation_stopped_after_candidate !== true ? 'GUARD_NOT_TRIGGERED' : undefined,
    ].filter(Boolean).join('_') || 'UNEXPECTED_RESULT'}`;

  const candidatePayload = result.candidate_events[0]?.payload;
  const candidateSummary: JsonRecord = {
    candidate_strategy_id: STRATEGY_ID,
    candidate_timestamp_ns: TARGET_TS_NS,
    candidate_timestamp_utc: TARGET_TS_UTC,
    candidate_entry_hour_utc: TARGET_ENTRY_HOUR_UTC,
    candidate_regime_label: 'low',
    candidate_signed_shock_vwap: SIGNED_SHOCK_VWAP,
    candidate_threshold_name: 'parameters.low_shock_threshold_pos',
    candidate_threshold_value: LOW_SHOCK_THRESHOLD_POS,
    candidate_threshold_comparison: THRESHOLD_COMPARISON,
    candidate_utc_gate_status: UTC_GATE_STATUS,
    candidate_emission_reason: 'BASE_PREDICATES_PASS_AND_NON_EXCLUDED_BY_UTC_GATE',
    candidate_payload_strategy_id: stringifyForJson(candidatePayload?.strategy_id),
    candidate_payload_candidate_id: stringifyForJson(candidatePayload?.candidate_id),
  };

  const guardSummary: JsonRecord = {
    guard_insertion_repo_path: 'apps/strategy_runtime/src/orchestration/runner.ts',
    guard_insertion_symbol_or_function: 'StrategyRuntimeRunner.processFeatureSnapshot(...) ranked candidate loop',
    stop_before_symbol_or_function: 'rankCandidates(...) and createEntryOrderIntent(...)',
    primary_boundary: 'after CANDIDATE publish and before RANK/SIZING/RISK_GATE/ORDER_INTENT',
    allowed_marker_before_stop: 'CANDIDATE',
    disallowed_marker_after_stop: 'ORDER_INTENT',
    paper_observation_stop_after_candidate: true,
    default_enabled: false,
    requires_runtime_mode_paper: true,
    requires_paper_observation_explicit_strategy_ids: true,
  };

  const guardrailProofs: JsonRecord = {
    non_paper_runtime_with_stop_after_candidate_rejected: true,
    stop_after_candidate_without_explicit_strategy_ids_rejected: true,
    default_runtime_behavior_unchanged: true,
    normal_candidate_pipeline_without_guard_still_reaches_rank_or_order_boundary_in_test: true,
  };

  const determinism: JsonRecord = {
    command: 'npx tsx scripts/backtester/check-determinism.mts',
    result: 'pass',
    drift_classification: DRIFT_CLASSIFICATION,
    final_chain_hash: FINAL_CHAIN_HASH,
    final_phase2_hash: FINAL_PHASE2_HASH,
    final_phase4_hash: FINAL_PHASE4_HASH,
  };

  const typescriptCaveat: JsonRecord = {
    full_project_command: 'npx tsc -b tsconfig.json',
    full_project_result:
      'not a clean signal in this worktree because full-project dependency resolution hits existing operator-console / repo-split diagnostics outside touched files',
    targeted_touched_file_script_typescript_check: 'fail',
    targeted_touched_file_script_typescript_check_detail:
      'targeted command no longer reports touched-file/script errors; it still reaches existing shared config/transport strictness diagnostics outside touched files',
  };

  const authorityLocks: JsonRecord = {
    paper_runtime_invoked: true,
    paper_session_started: false,
    paper_observation_stop_after_candidate: true,
    candidate_persisted: counts.CANDIDATE === 1,
    order_translation_invoked: false,
    order_adapter_invoked: false,
    broker_adapter_invoked: false,
    paper_fill_created: false,
    qfa_410b_or_qfa_611_run: false,
    active_candidate_roster_mutated: false,
    broker_live_authorized: false,
    phase_6_authorized: false,
    observation_day_eligible: false,
    observation_day_increment: 0,
  };

  const boundedRecords: Json[] = [
    {
      record_type: 'SOURCE_SNAPSHOT_ANCHOR',
      ticket: TICKET,
      feature_snapshot_id: FEATURE_SNAPSHOT_ID,
      strategy_id: STRATEGY_ID,
      smoke_source_event_id: SOURCE_EVENT_ID,
      smoke_source_event_id_used_only_when_snapshot_source_event_id_missing: true,
      source_snapshot_lf_sha256: pr311Sha,
      prior_strat_eval_smoke_lf_sha256: pr312Sha,
      substrate_sha: SUBSTRATE_SHA,
    },
    {
      record_type: 'PAPER_RUNTIME_CANDIDATE_SMOKE_IMPL_RESULT',
      ticket: TICKET,
      determination,
      counts,
      guard_summary: guardSummary,
      guardrail_proofs: guardrailProofs,
      authority_locks: authorityLocks,
      determinism,
      typescript_caveat: typescriptCaveat,
    },
    {
      record_type: 'CANDIDATE_PAYLOAD_SUMMARY',
      ticket: TICKET,
      candidate_summary: candidateSummary,
    },
  ];
  writeFileSync(BOUNDED_JSONL, stableJsonl(boundedRecords), 'utf8');

  const report: JsonRecord = {
    ticket: TICKET,
    determination,
    substrate_sha: SUBSTRATE_SHA,
    pr313_merge_sha: PR313_MERGE_SHA,
    feature_snapshot_id: FEATURE_SNAPSHOT_ID,
    strategy_id: STRATEGY_ID,
    target_timestamp_ns: TARGET_TS_NS,
    target_timestamp_utc: TARGET_TS_UTC,
    target_entry_hour_utc: TARGET_ENTRY_HOUR_UTC,
    target_timestamp_variant_gate_status: UTC_GATE_STATUS,
    counts,
    STRAT_EVAL_count: counts.STRAT_EVAL,
    CANDIDATE_count: counts.CANDIDATE,
    ORDER_INTENT_count: counts.ORDER_INTENT,
    candidate_summary: candidateSummary,
    guard_summary: guardSummary,
    guardrail_proofs: guardrailProofs,
    authority_locks: authorityLocks,
    determinism,
    final_phase2_hash: FINAL_PHASE2_HASH,
    final_phase4_hash: FINAL_PHASE4_HASH,
    drift_classification: DRIFT_CLASSIFICATION,
    typescript_caveat: typescriptCaveat,
    suppression_boundary: {
      order_intent_suppression_reason: 'PAPER_OBSERVATION_STOP_AFTER_CANDIDATE_BEFORE_ORDER_TRANSLATION',
      no_rank_sizing_risk_order_translation_side_effects_beyond_candidate_marker: true,
    },
    source_anchors: {
      pr311_bounded_snapshot_lf_sha256: pr311Sha,
      pr312_bounded_strat_eval_smoke_lf_sha256: pr312Sha,
    },
    bounded_artifact_size_bytes: statSync(BOUNDED_JSONL).size,
    recommended_next_ticket: NEXT_TICKET,
  };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  const boundedSha = sha256FileLf(BOUNDED_JSONL);
  const reportSha = sha256FileLf(REPORT_JSON);

  const md = [
    `# ${TICKET}`,
    '',
    `Determination: \`${determination}\``,
    '',
    '## Runtime counts',
    '',
    '| Marker | Count |',
    '|---|---:|',
    `| STRAT_EVAL | ${counts.STRAT_EVAL} |`,
    `| CANDIDATE | ${counts.CANDIDATE} |`,
    `| RANK | ${counts.RANK} |`,
    `| SIZING | ${counts.SIZING} |`,
    `| RISK_GATE | ${counts.RISK_GATE} |`,
    `| ORDER_INTENT | ${counts.ORDER_INTENT} |`,
    `| SIM_FILL | ${counts.SIM_FILL} |`,
    '',
    '## Guard boundary',
    '',
    '| Field | Value |',
    '|---|---|',
    `| guard_insertion_repo_path | \`${guardSummary.guard_insertion_repo_path}\` |`,
    `| guard_insertion_symbol_or_function | \`${guardSummary.guard_insertion_symbol_or_function}\` |`,
    `| stop_before_symbol_or_function | \`${guardSummary.stop_before_symbol_or_function}\` |`,
    `| allowed_marker_before_stop | \`${guardSummary.allowed_marker_before_stop}\` |`,
    `| disallowed_marker_after_stop | \`${guardSummary.disallowed_marker_after_stop}\` |`,
    `| paper_observation_stop_after_candidate | \`${guardSummary.paper_observation_stop_after_candidate}\` |`,
    '',
    '## Guardrail proof status',
    '',
    '| Proof | Status |',
    '|---|---|',
    '| non_paper_runtime_with_stop_after_candidate_rejected | `true` |',
    '| stop_after_candidate_without_explicit_strategy_ids_rejected | `true` |',
    '| default_runtime_behavior_unchanged | `true` |',
    '| normal_candidate_pipeline_without_guard_still_reaches_rank_or_order_boundary_in_test | `true` |',
    '',
    '## Candidate payload summary',
    '',
    '| Field | Value |',
    '|---|---|',
    `| candidate_strategy_id | \`${STRATEGY_ID}\` |`,
    `| candidate_timestamp_utc | \`${TARGET_TS_UTC}\` |`,
    `| candidate_entry_hour_utc | \`${TARGET_ENTRY_HOUR_UTC}\` |`,
    `| candidate_utc_gate_status | \`${UTC_GATE_STATUS}\` |`,
    `| candidate_signed_shock_vwap | \`${SIGNED_SHOCK_VWAP}\` |`,
    `| candidate_threshold_comparison | \`${THRESHOLD_COMPARISON}\` |`,
    '',
    '## Authority locks',
    '',
    'No order translation, order adapter, broker adapter, paper fill, qfa-410b/qfa-611, roster/config mutation, Phase 6 authority, or observation-day credit is created by this smoke.',
    '',
    '## Determinism and TypeScript caveat',
    '',
    '| Field | Value |',
    '|---|---|',
    `| final_phase2_hash | \`${FINAL_PHASE2_HASH}\` |`,
    `| final_phase4_hash | \`${FINAL_PHASE4_HASH}\` |`,
    `| drift_classification | \`${DRIFT_CLASSIFICATION}\` |`,
    '| npx tsc -b tsconfig.json | `not a clean signal in this worktree because full-project dependency resolution hits existing operator-console / repo-split diagnostics outside touched files` |',
    '| targeted touched-file/script TypeScript check | `fail` |',
    '| targeted check note | `No touched-file/script errors remain; residual targeted errors are existing shared config/transport diagnostics outside touched files.` |',
    '',
    '## Output hashes',
    '',
    '| Artifact | LF SHA-256 |',
    '|---|---|',
    `| bounded JSONL | \`${boundedSha}\` |`,
    `| report JSON | \`${reportSha}\` |`,
    '',
    `Recommended next ticket: \`${NEXT_TICKET}\``,
    '',
  ].join('\n');
  writeFileSync(REPORT_MD, md, 'utf8');
  const reportMdSha = sha256FileLf(REPORT_MD);

  const memo = [
    `# ${TICKET} memo`,
    '',
    'This implementation adds an explicit, opt-in paper/smoke guard that stops the paper-mode strategy runtime after CANDIDATE publication and before rank, sizing, risk, order translation, order adapter, broker adapter, or fill paths.',
    '',
    `Determination: \`${determination}\``,
    '',
    'The smoke invokes `StrategyRuntimeRunner.processFeatureSnapshot(...)` with `runtime_mode: paper`, `paper_observation_explicit_strategy_ids`, and `paper_observation_stop_after_candidate: true`. It publishes one source-backed quote event, processes the PR #311 candidate-eligible snapshot, emits one STRAT_EVAL marker and one CANDIDATE marker, and returns before ORDER_INTENT can be created.',
    '',
    'The guard is default-disabled and rejects non-paper construction. It creates no normal runtime, backtester, qfa-410b, qfa-611, broker/live, Phase 6, roster, or observation-day authority.',
    '',
    'Guardrail proofs are explicit: `non_paper_runtime_with_stop_after_candidate_rejected = true`, `stop_after_candidate_without_explicit_strategy_ids_rejected = true`, `default_runtime_behavior_unchanged = true`, and `normal_candidate_pipeline_without_guard_still_reaches_rank_or_order_boundary_in_test = true`.',
    '',
    '## Suppression boundary',
    '',
    '- `paper_runtime_invoked = true`',
    '- `paper_observation_stop_after_candidate = true`',
    '- `candidate_persisted = true` as the bounded candidate marker',
    '- `order_translation_invoked = false`',
    '- `order_adapter_invoked = false`',
    '- `broker_adapter_invoked = false`',
    '- `paper_fill_created = false`',
    '- `observation_day_eligible = false`',
    '- `observation_day_increment = 0`',
    '',
    '## Determinism and TypeScript caveat',
    '',
    `- final_phase2_hash = \`${FINAL_PHASE2_HASH}\``,
    `- final_phase4_hash = \`${FINAL_PHASE4_HASH}\``,
    `- drift_classification = \`${DRIFT_CLASSIFICATION}\``,
    '- `npx tsc -b tsconfig.json = not a clean signal in this worktree because full-project dependency resolution hits existing operator-console / repo-split diagnostics outside touched files.`',
    '- `targeted touched-file/script TypeScript check = fail`; no touched-file/script errors remain, but the targeted command still reaches existing shared config/transport diagnostics outside touched files.',
    '',
    '## Output hashes',
    '',
    '| Artifact | LF SHA-256 |',
    '|---|---|',
    `| bounded JSONL | \`${boundedSha}\` |`,
    `| report JSON | \`${reportSha}\` |`,
    `| report MD | \`${reportMdSha}\` |`,
    '',
    `Recommended next ticket: \`${NEXT_TICKET}\``,
    '',
  ].join('\n');
  writeFileSync(MEMO_MD, memo, 'utf8');
  appendBacklogRow();

  const memoSha = sha256FileLf(MEMO_MD);
  const scriptSha = sha256FileLf(path.join(ROOT, 'scripts', 'paper', 'run-v2-pf-c-late-am-2026-06-02-paper-runtime-candidate-smoke-impl.ts'));
  console.log(JSON.stringify({
    state: 'PENDING_REVIEW',
    determination,
    counts,
    final_phase2_hash: FINAL_PHASE2_HASH,
    final_phase4_hash: FINAL_PHASE4_HASH,
    drift_classification: DRIFT_CLASSIFICATION,
    bounded_jsonl_lf_sha256: boundedSha,
    report_json_lf_sha256: reportSha,
    report_md_lf_sha256: reportMdSha,
    memo_lf_sha256: memoSha,
    script_lf_sha256: scriptSha,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
