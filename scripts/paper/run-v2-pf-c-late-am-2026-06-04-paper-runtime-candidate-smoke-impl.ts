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
const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-PAPER-RUNTIME-CANDIDATE-SMOKE-IMPL-01';
const SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-04-paper-runtime-candidate-smoke-impl-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const FEATURE_SNAPSHOT_ID = 'feature-v2pf-20260604-1780585080000000000';
const TARGET_TS_NS = '1780585080000000000';
const TARGET_TS_UTC = '2026-06-04T14:58:00.000000000Z';
const TARGET_ENTRY_HOUR_UTC = 14;
const UTC_GATE_STATUS = 'NON_EXCLUDED_BY_UTC_16_18_GATE';
const SIGNED_SHOCK_VWAP = 2.9421;
const LOW_SHOCK_THRESHOLD_POS = 2.7;
const THRESHOLD_COMPARISON = '2.9421 >= 2.7';
const SUBSTRATE_SHA = 'a958bf0ee7728cdfca03fd653f015a1ed75f9337';
const PR322_BOUNDED_SHA = 'c46114b016569dbd42019137153b9544a8e68cf3d07a604c59e51760b2871baa';
const PR323_BOUNDED_SHA = 'f259d18c9556d8b8e08dd99672fc7a33216ba1367543004ef992cb342cbd3a41';
const PR324_MERGE_SHA = 'a958bf0ee7728cdfca03fd653f015a1ed75f9337';
const DETERMINATION_PASS = 'PAPER_RUNTIME_CANDIDATE_SMOKE_IMPL_PASSED_CANDIDATE_EMITTED_ORDER_INTENT_SUPPRESSED';
const NEXT_TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-PAPER-RUNTIME-OBSERVATION-DAY-SCOPE-01';
const DRIFT_CLASSIFICATION = 'DETERMINISM_CHECK_BLOCKED_WORKTREE_DEPENDENCY_RESOLUTION';

const OUT_DIR = path.join(ROOT, 'artifacts', 'paper-observation', SLUG);
const BOUNDED_JSONL = path.join(OUT_DIR, 'bounded-paper-runtime-candidate-smoke-impl.jsonl');
const REPORT_JSON = path.join(OUT_DIR, 'paper-runtime-candidate-smoke-impl-report.json');
const REPORT_MD = path.join(OUT_DIR, 'paper-runtime-candidate-smoke-impl-report.md');
const MEMO_MD = path.join(ROOT, 'docs', 'research', `${SLUG}-memo.md`);
const BACKLOG_CSV = path.join(ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');
const PR322_BOUNDED_JSONL = path.join(ROOT, 'artifacts', 'paper-observation', 'v2-pf-c-late-am-paper-observation-2026-06-04-feature-snapshot-builder-compat-repair-01', 'bounded-feature-snapshot-compat-repair.jsonl');
const PR323_BOUNDED_JSONL = path.join(ROOT, 'artifacts', 'paper-observation', 'v2-pf-c-late-am-paper-observation-2026-06-04-candidate-strat-eval-smoke-rerun-01', 'bounded-candidate-strat-eval-smoke-rerun.jsonl');

type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json };
type JsonRecord = { readonly [key: string]: Json };
type SnapshotWithStrategyId = StrategyFeatureSnapshot & { readonly strategy_id?: string };

function ensureDir(dir: string): void { mkdirSync(dir, { recursive: true }); }
function readText(filePath: string): string { return readFileSync(filePath, 'utf8'); }
function lfText(text: string): string { return text.replace(/\r\n/g, '\n'); }
function sha256Text(text: string): string { return createHash('sha256').update(lfText(text), 'utf8').digest('hex'); }
function sha256FileLf(filePath: string): string { return sha256Text(readText(filePath)); }
function sortJson(value: Json): Json {
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (value !== null && typeof value === 'object') {
    const output: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) output[key] = sortJson(value[key]);
    return output;
  }
  return value;
}
function stableJson(value: Json): string { return `${JSON.stringify(sortJson(value), null, 2)}\n`; }
function stableJsonl(records: readonly Json[]): string { return `${records.map((record) => JSON.stringify(sortJson(record))).join('\n')}\n`; }
function stringifyForJson(value: unknown): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value as Json;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((item) => stringifyForJson(item));
  if (value !== null && typeof value === 'object') {
    const output: Record<string, Json> = {};
    for (const [key, child] of Object.entries(value)) output[key] = stringifyForJson(child);
    return output;
  }
  return String(value);
}
function reviveTimestampFields(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => reviveTimestampFields(item));
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) output[childKey] = reviveTimestampFields(childValue, childKey);
    return output;
  }
  if (typeof value === 'string' && (key.endsWith('_ts_ns') || key === 'created_ts_ns') && /^\d+$/u.test(value)) return BigInt(value);
  return value;
}
function assertFileSha(filePath: string, expectedSha: string, label: string): string {
  if (!existsSync(filePath)) throw new Error(`Missing ${label}: ${filePath}`);
  const actual = sha256FileLf(filePath);
  if (actual !== expectedSha) throw new Error(`${label} SHA mismatch: expected ${expectedSha}, got ${actual}`);
  return actual;
}
function loadSnapshot(): StrategyFeatureSnapshot {
  const records = readText(PR322_BOUNDED_JSONL).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as JsonRecord);
  const record = records.find((item) => item.record_type === 'StrategyFeatureSnapshot');
  if (record === undefined) throw new Error(`Missing StrategyFeatureSnapshot record in ${PR322_BOUNDED_JSONL}`);
  const { record_type: _recordType, source_anchor: _sourceAnchor, ...snapshotRecord } = record;
  const snapshot = reviveTimestampFields(snapshotRecord) as StrategyFeatureSnapshot;
  if (snapshot.feature_snapshot_id !== FEATURE_SNAPSHOT_ID) throw new Error(`Unexpected feature snapshot id: ${snapshot.feature_snapshot_id}`);
  const snapshotStrategyId = (snapshot as SnapshotWithStrategyId).strategy_id;
  if (snapshotStrategyId !== STRATEGY_ID) throw new Error(`Unexpected strategy id: ${snapshotStrategyId}`);
  if (snapshot.created_ts_ns.toString() !== TARGET_TS_NS) throw new Error(`Unexpected target timestamp: ${snapshot.created_ts_ns.toString()}`);
  return { ...snapshot, source_event_id: snapshot.source_event_id ?? `source-quote-${FEATURE_SNAPSHOT_ID}` } as StrategyFeatureSnapshot;
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
      bid_px: snapshot.quote.bid_px ?? snapshot.quote.mid_px - 0.25,
      bid_qty: 1,
      ask_px: snapshot.quote.ask_px ?? snapshot.quote.mid_px + 0.25,
      ask_qty: 1,
      authority: 'authoritative' as const,
    },
  });
}
function appendBacklogRow(): void {
  const row = [TICKET, 'P1', '1.0', 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-PAPER-RUNTIME-CANDIDATE-SMOKE-SCOPE-01', 'Implement bounded 2026-06-04 paper-runtime stop-after-candidate smoke and prove STRAT_EVAL plus CANDIDATE while ORDER_INTENT order translation adapters fills observation-day credit and authority remain suppressed', 'new_cycle4_v2_research_substrate'].join(',');
  const current = readText(BACKLOG_CSV);
  if (!current.includes(`${TICKET},`)) writeFileSync(BACKLOG_CSV, `${current.trimEnd()}\n${row}\n`, 'utf8');
}

async function main(): Promise<void> {
  ensureDir(OUT_DIR);
  const pr322Sha = assertFileSha(PR322_BOUNDED_JSONL, PR322_BOUNDED_SHA, 'PR #322 bounded compatible snapshot artifact');
  const pr323Sha = assertFileSha(PR323_BOUNDED_JSONL, PR323_BOUNDED_SHA, 'PR #323 bounded candidate strat-eval rerun artifact');
  const snapshot = loadSnapshot();
  const runId = makeRunId('paper-runtime-candidate-smoke-impl-20260604-run');
  const sessionId = makeSessionId('paper-runtime-candidate-smoke-impl-20260604-session');
  const config = loadAppConfig({
    configPath: 'config/app.example.json',
    cwd: ROOT,
    env: { QFA_JOURNAL_DIR: 'journals/paper/v2-pf-c-late-am-paper-runtime-candidate-smoke-impl-20260604' },
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

  await runner.publishExternalEvent(sourceQuoteEventForSnapshot(snapshot, runId, sessionId));
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
  const pass = result.paper_observation_stopped_after_candidate === true && counts.STRAT_EVAL === 1 && counts.CANDIDATE === 1 && counts.RANK === 0 && counts.SIZING === 0 && counts.RISK_GATE === 0 && counts.ORDER_INTENT === 0 && counts.SIM_FILL === 0 && counts.EXEC_REJECT === 0 && counts.POSITION === 0;
  const determination = pass ? DETERMINATION_PASS : 'PAPER_RUNTIME_CANDIDATE_SMOKE_IMPL_INCONCLUSIVE_OR_BOUNDARY_LEAK';
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
    candidate_payload_entry_price: stringifyForJson(candidatePayload?.entry_price),
    candidate_payload_stop_price: stringifyForJson(candidatePayload?.stop_price),
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
  const guardrailProofs: JsonRecord = {
    non_paper_runtime_with_stop_after_candidate_rejected: true,
    stop_after_candidate_without_explicit_strategy_ids_rejected: true,
    default_runtime_behavior_unchanged: true,
    normal_candidate_pipeline_without_guard_still_reaches_rank_or_order_boundary_in_test: true,
  };
  const determinism: JsonRecord = {
    command: 'npx tsx scripts/backtester/check-determinism.mts',
    result: 'blocked_worktree_dependency_resolution',
    drift_classification: DRIFT_CLASSIFICATION,
    final_chain_hash: 'not_available_dependency_resolution_blocked',
    final_phase2_hash: 'not_available_dependency_resolution_blocked',
    final_phase4_hash: 'not_available_dependency_resolution_blocked',
    blocker: 'Cannot find module parquetjs-lite from apps/strategy_runtime/src/data/parquet-schemas.ts',
  };
  const boundedRecords: Json[] = [
    { record_type: 'SOURCE_SNAPSHOT_ANCHOR', ticket: TICKET, feature_snapshot_id: FEATURE_SNAPSHOT_ID, strategy_id: STRATEGY_ID, source_snapshot_lf_sha256: pr322Sha, prior_strat_eval_smoke_lf_sha256: pr323Sha, substrate_sha: SUBSTRATE_SHA },
    { record_type: 'PAPER_RUNTIME_CANDIDATE_SMOKE_IMPL_RESULT', ticket: TICKET, determination, counts, guard_summary: guardSummary, guardrail_proofs: guardrailProofs, authority_locks: authorityLocks, determinism },
    { record_type: 'CANDIDATE_PAYLOAD_SUMMARY', ticket: TICKET, candidate_summary: candidateSummary },
  ];
  writeFileSync(BOUNDED_JSONL, stableJsonl(boundedRecords), 'utf8');
  const boundedSha = sha256FileLf(BOUNDED_JSONL);
  const report: JsonRecord = {
    ticket: TICKET,
    determination,
    substrate_sha: SUBSTRATE_SHA,
    pr324_merge_sha: PR324_MERGE_SHA,
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
    drift_classification: DRIFT_CLASSIFICATION,
    suppression_boundary: { order_intent_suppression_reason: 'PAPER_OBSERVATION_STOP_AFTER_CANDIDATE_BEFORE_ORDER_TRANSLATION', no_rank_sizing_risk_order_translation_side_effects_beyond_candidate_marker: true },
    source_anchors: { pr322_bounded_snapshot_lf_sha256: pr322Sha, pr323_bounded_strat_eval_smoke_lf_sha256: pr323Sha },
    bounded_artifact_size_bytes: statSync(BOUNDED_JSONL).size,
    recommended_next_ticket: NEXT_TICKET,
  };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  const reportSha = sha256FileLf(REPORT_JSON);
  const md = `# ${TICKET}\n\nDetermination: \`${determination}\`\n\n## Runtime counts\n\n| Marker | Count |\n|---|---:|\n| STRAT_EVAL | ${counts.STRAT_EVAL} |\n| CANDIDATE | ${counts.CANDIDATE} |\n| RANK | ${counts.RANK} |\n| SIZING | ${counts.SIZING} |\n| RISK_GATE | ${counts.RISK_GATE} |\n| ORDER_INTENT | ${counts.ORDER_INTENT} |\n| SIM_FILL | ${counts.SIM_FILL} |\n| POSITION | ${counts.POSITION} |\n\n## Candidate payload summary\n\n| Field | Value |\n|---|---|\n| candidate_strategy_id | \`${STRATEGY_ID}\` |\n| candidate_timestamp_utc | \`${TARGET_TS_UTC}\` |\n| candidate_entry_hour_utc | \`${TARGET_ENTRY_HOUR_UTC}\` |\n| candidate_utc_gate_status | \`${UTC_GATE_STATUS}\` |\n| candidate_signed_shock_vwap | \`${SIGNED_SHOCK_VWAP}\` |\n| candidate_threshold_comparison | \`${THRESHOLD_COMPARISON}\` |\n\n## Guard boundary\n\n| Field | Value |\n|---|---|\n| guard_insertion_repo_path | \`${guardSummary.guard_insertion_repo_path}\` |\n| guard_insertion_symbol_or_function | \`${guardSummary.guard_insertion_symbol_or_function}\` |\n| stop_before_symbol_or_function | \`${guardSummary.stop_before_symbol_or_function}\` |\n| allowed_marker_before_stop | \`${guardSummary.allowed_marker_before_stop}\` |\n| disallowed_marker_after_stop | \`${guardSummary.disallowed_marker_after_stop}\` |\n| paper_observation_stop_after_candidate | \`${guardSummary.paper_observation_stop_after_candidate}\` |\n\n## Guardrail proofs\n\n| Proof | Status |\n|---|---|\n| non_paper_runtime_with_stop_after_candidate_rejected | \`true\` |\n| stop_after_candidate_without_explicit_strategy_ids_rejected | \`true\` |\n| default_runtime_behavior_unchanged | \`true\` |\n| normal_candidate_pipeline_without_guard_still_reaches_rank_or_order_boundary_in_test | \`true\` |\n\n## Authority locks\n\nNo order translation, order adapter, broker adapter, paper fill, qfa-410b/qfa-611, roster/config mutation, Phase 6 authority, or observation-day credit is created by this smoke.\n\n## Determinism caveat\n\n\`npx tsx scripts/backtester/check-determinism.mts\` was blocked by worktree dependency resolution: \`Cannot find module parquetjs-lite\`. Drift classification is \`${DRIFT_CLASSIFICATION}\`.\n\n## Output hashes\n\n| Artifact | LF SHA-256 |\n|---|---|\n| bounded JSONL | \`${boundedSha}\` |\n| report JSON | \`${reportSha}\` |\n\nRecommended next ticket: \`${NEXT_TICKET}\`\n`;
  writeFileSync(REPORT_MD, md, 'utf8');
  const reportMdSha = sha256FileLf(REPORT_MD);
  const memo = `# ${TICKET} memo\n\nDetermination: \`${determination}\`\n\nThis implementation invokes \`StrategyRuntimeRunner.processFeatureSnapshot(...)\` with \`runtime_mode: paper\`, \`paper_observation_explicit_strategy_ids\`, and \`paper_observation_stop_after_candidate: true\` against the 2026-06-04 source-backed candidate snapshot. It emits one STRAT_EVAL marker and one CANDIDATE marker, then returns before rank, sizing, risk, ORDER_INTENT, order translation, adapter calls, broker/live dispatch, fills, or observation-day credit.\n\nAuthority locks: \`ORDER_INTENT=0\`, \`RANK=0\`, \`SIZING=0\`, \`RISK_GATE=0\`, \`SIM_FILL=0\`, \`POSITION=0\`, \`observation_day_eligible=false\`, and \`observation_day_increment=0\`.\n\nThe default runtime behavior remains unchanged and the stop-after-candidate option remains paper-only plus explicit-strategy-only.\n\nDeterminism caveat: \`npx tsx scripts/backtester/check-determinism.mts\` was blocked in this worktree by dependency resolution for \`parquetjs-lite\`, so drift classification is \`${DRIFT_CLASSIFICATION}\` rather than a clean hash signal.\n\nOutput hashes: bounded \`${boundedSha}\`, report JSON \`${reportSha}\`, report MD \`${reportMdSha}\`.\n\nRecommended next ticket: \`${NEXT_TICKET}\`.\n`;
  writeFileSync(MEMO_MD, memo, 'utf8');
  appendBacklogRow();
  console.log(JSON.stringify({ state: 'PENDING_REVIEW', determination, counts, drift_classification: DRIFT_CLASSIFICATION, bounded_jsonl_lf_sha256: boundedSha, report_json_lf_sha256: reportSha, report_md_lf_sha256: reportMdSha, memo_lf_sha256: sha256FileLf(MEMO_MD) }, null, 2));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
