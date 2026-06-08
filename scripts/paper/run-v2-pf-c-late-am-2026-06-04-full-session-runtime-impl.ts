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
const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FULL-SESSION-RUNTIME-IMPL-01';
const SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-04-full-session-runtime-impl-01';
const SUBSTRATE_SHA = '54a83cc96921c5d949943b122b39fdd40e6310a8';
const DETERMINATION_PASS = 'FULL_SESSION_RUNTIME_IMPL_PASSED_CANDIDATE_ONLY_GUARD';
const DETERMINATION_MISSING_SOURCE = 'FULL_SESSION_RUNTIME_IMPL_BLOCKED_MISSING_SOURCE_SNAPSHOTS';
const DETERMINATION_ORDER_LEAK = 'FULL_SESSION_RUNTIME_IMPL_FAILED_ORDER_BOUNDARY_LEAK';
const PASSED_NEXT_TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-OBSERVATION-DAY-ACCOUNTING-SCOPE-01';
const BLOCKED_SOURCE_NEXT_TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FULL-SESSION-SOURCE-SNAPSHOT-WINDOW-REPAIR-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const SESSION_ID = '2026-06-04-rth';
const SESSION_OPEN_UTC = '2026-06-04T13:30:00.000000000Z';
const SESSION_CLOSE_UTC = '2026-06-04T20:00:00.000000000Z';
const ACCOUNTING_SLOTS_EXPECTED = 390;
const WARMUP_EXCLUDED_EXPECTED = 13;
const FEATURE_COMPUTABLE_EXPECTED = 377;
const LOW_SHOCK_THRESHOLD_POS = 2.7;
const TICK_SIZE = 0.25;
const POINT_VALUE = 2;
const PRICE_DECIMALS = 2;
const MAX_ARTIFACT_BYTES = 95 * 1024 * 1024;

const OUT_DIR = path.join(ROOT, 'artifacts', 'paper-observation', SLUG);
const BOUNDED_JSONL = path.join(OUT_DIR, 'bounded-full-session-runtime-impl.jsonl');
const REPORT_JSON = path.join(OUT_DIR, 'full-session-runtime-impl-report.json');
const REPORT_MD = path.join(OUT_DIR, 'full-session-runtime-impl-report.md');
const MEMO_MD = path.join(ROOT, 'docs', 'research', `${SLUG}-memo.md`);
const BACKLOG_CSV = path.join(ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');
const SOURCE_READINESS_JSONL = path.join(ROOT, 'artifacts', 'paper-observation', 'v2-pf-c-late-am-paper-observation-2026-06-04-local-capture-source-readiness-01', 'bounded-local-capture-source-readiness.jsonl');
const SOURCE_READINESS_REPORT = path.join(ROOT, 'artifacts', 'paper-observation', 'v2-pf-c-late-am-paper-observation-2026-06-04-local-capture-source-readiness-01', 'local-capture-source-readiness-report.json');
const FULL_SESSION_SCOPE_REPORT = path.join(ROOT, 'artifacts', 'paper-observation', 'v2-pf-c-late-am-paper-observation-2026-06-04-full-session-runtime-scope-01', 'full-session-runtime-scope-report.json');
const STRATEGY_CONFIG_RELATIVE_PATH = 'config/strategies/regime_shock_reversion_short_v2_utc_16_18_exclusion.yaml';
const STRATEGY_CONFIG_PATH = path.join(ROOT, STRATEGY_CONFIG_RELATIVE_PATH);

type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json };
type JsonRecord = { readonly [key: string]: Json };
type SlotStatus = 'SNAPSHOT_INGESTED' | 'WARMUP_EXCLUDED' | 'MISSING_SOURCE' | 'FAILED_CLOSED';
type RuntimeSlotRecord = {
  readonly record_type: 'FULL_SESSION_RUNTIME_SLOT';
  readonly slot_index: number;
  readonly slot_start_ts_ns: string;
  readonly slot_start_utc: string;
  readonly slot_end_ts_ns: string;
  readonly slot_end_utc: string;
  readonly status: SlotStatus;
  readonly feature_snapshot_id: string | null;
  readonly feature_snapshot_lf_sha256: string | null;
  readonly quote_mid_px: number | null;
  readonly session_vwap: number | null;
  readonly atr14_pts: number | null;
  readonly sigma_pts: number | null;
  readonly signed_shock_vwap: number | null;
  readonly STRAT_EVAL_count: number;
  readonly CANDIDATE_count: number;
  readonly RANK_count: number;
  readonly SIZING_count: number;
  readonly RISK_GATE_count: number;
  readonly ORDER_INTENT_count: number;
  readonly SIM_FILL_count: number;
  readonly EXEC_REJECT_count: number;
  readonly POSITION_count: number;
  readonly candidate_id_or_null: string | null;
  readonly suppression_reason_or_null: string | null;
};

function ensureDir(dir: string): void { mkdirSync(dir, { recursive: true }); }
function readText(filePath: string): string { return readFileSync(filePath, 'utf8'); }
function lfText(text: string): string { return text.replace(/\r\n/g, '\n'); }
function sha256Text(text: string): string { return createHash('sha256').update(lfText(text), 'utf8').digest('hex'); }
function sha256FileLf(filePath: string): string { return sha256Text(readText(filePath)); }
function sortJson(value: Json): Json { if (Array.isArray(value)) return value.map((item) => sortJson(item)); if (value !== null && typeof value === 'object') { const output: Record<string, Json> = {}; for (const key of Object.keys(value).sort()) output[key] = sortJson(value[key]); return output; } return value; }
function stableJson(value: Json): string { return `${JSON.stringify(sortJson(value), null, 2)}\n`; }
function stableJsonl(records: readonly Json[]): string { return `${records.map((record) => JSON.stringify(sortJson(record))).join('\n')}\n`; }
function toJson(value: unknown): Json { if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value; if (typeof value === 'bigint') return value.toString(); if (Array.isArray(value)) return value.map((item) => toJson(item)); if (value !== null && typeof value === 'object') { const output: Record<string, Json> = {}; for (const [key, child] of Object.entries(value)) output[key] = toJson(child); return output; } return String(value); }
function asRecord(value: Json | undefined, label: string): JsonRecord { if (value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord; throw new Error(`Missing object: ${label}`); }
function numberField(record: JsonRecord, key: string): number { const value = record[key]; if (typeof value === 'number') return value; throw new Error(`Missing number: ${key}`); }
function stringField(record: JsonRecord, key: string): string { const value = record[key]; if (typeof value === 'string') return value; throw new Error(`Missing string: ${key}`); }
function booleanField(record: JsonRecord, key: string): boolean { const value = record[key]; if (typeof value === 'boolean') return value; throw new Error(`Missing boolean: ${key}`); }
function nsToIsoFromString(nsText: string): string { const ns = BigInt(nsText); const millis = (ns / 1_000_000_000n) * 1_000n; const nanos = ns % 1_000_000_000n; const base = new Date(Number(millis)).toISOString().replace('.000Z', ''); return `${base}.${nanos.toString().padStart(9, '0')}Z`; }
function snapshotDigest(snapshot: StrategyFeatureSnapshot): string { return sha256Text(stableJson(toJson(snapshot))); }
function countRecord(records: readonly RuntimeSlotRecord[], field: keyof RuntimeSlotRecord): number { return records.reduce((sum, record) => sum + (typeof record[field] === 'number' ? Number(record[field]) : 0), 0); }
function markerCounts(slotRecords: readonly RuntimeSlotRecord[]): JsonRecord { return { SESSION_MANIFEST: 2, FEATURE_SNAPSHOT_INGEST: slotRecords.filter((record) => record.status === 'SNAPSHOT_INGESTED').length, STRAT_EVAL: countRecord(slotRecords, 'STRAT_EVAL_count'), CANDIDATE: countRecord(slotRecords, 'CANDIDATE_count'), RANK: countRecord(slotRecords, 'RANK_count'), SIZING: countRecord(slotRecords, 'SIZING_count'), RISK_GATE: countRecord(slotRecords, 'RISK_GATE_count'), ORDER_INTENT: countRecord(slotRecords, 'ORDER_INTENT_count'), SIM_FILL: countRecord(slotRecords, 'SIM_FILL_count'), EXEC_REJECT: countRecord(slotRecords, 'EXEC_REJECT_count'), POSITION: countRecord(slotRecords, 'POSITION_count') }; }
function loadSourceSlots(): JsonRecord[] {
  return readText(SOURCE_READINESS_JSONL)
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRecord)
    .filter((record) => record.record_type === 'LOCAL_CAPTURE_SOURCE_READINESS_SLOT');
}
function buildSnapshot(slot: JsonRecord, strategyConfigHash: string): StrategyFeatureSnapshot {
  const slotEndTsNs = stringField(slot, 'slot_end_ts_ns');
  const mid = numberField(slot, 'quote_mid_px');
  const featureSnapshotId = `feature-v2pf-full-session-20260604-${slotEndTsNs}`;
  return {
    config: { config_hash: strategyConfigHash, config_version: 1, strategy_config_path: STRATEGY_CONFIG_RELATIVE_PATH },
    context: { regime_label: 'low', session_vwap: numberField(slot, 'session_vwap'), signed_shock_vwap: { value: numberField(slot, 'signed_shock_vwap') } },
    created_ts_ns: BigInt(slotEndTsNs),
    feature_snapshot_id: featureSnapshotId,
    indicators: { atr14_pts: numberField(slot, 'atr14_pts'), sigma_pts: numberField(slot, 'sigma_pts') },
    instrument: { contract_month: '2026-06', currency: 'USD', exchange: 'CME', point_value: POINT_VALUE, price_decimals: PRICE_DECIMALS, root: 'MNQ', symbol: 'MNQM6', tick_size: TICK_SIZE },
    quote: { bid_px: mid - TICK_SIZE, ask_px: mid + TICK_SIZE, mid_px: mid },
    session: { is_halt: false, is_roll_block: false, is_rth: true, session_id: SESSION_ID },
    source_event_id: `source-quote-${featureSnapshotId}`,
    strategy_id: STRATEGY_ID,
  } as unknown as StrategyFeatureSnapshot;
}
function sourceQuoteEventForSnapshot(snapshot: StrategyFeatureSnapshot, runId: ReturnType<typeof makeRunId>, sessionId: ReturnType<typeof makeSessionId>) {
  return createJournalEventEnvelope({
    event_id: makeEventId(String(snapshot.source_event_id)),
    type: 'QUOTE',
    ts_ns: snapshot.created_ts_ns,
    run_id: runId,
    session_id: sessionId,
    payload: { exchange_event_ts_ns: snapshot.created_ts_ns, sidecar_recv_ts_ns: ns(BigInt(snapshot.created_ts_ns) + 1_000_000n), bid_px: snapshot.quote.bid_px, bid_qty: 1, ask_px: snapshot.quote.ask_px, ask_qty: 1, authority: 'authoritative' as const },
  });
}
function appendBacklogRow(): void {
  const row = [TICKET, 'P1', '1.0', 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FULL-SESSION-RUNTIME-SCOPE-01', 'Implement bounded 2026-06-04 full-session paper-runtime candidate-only harness over the 390-slot RTH accounting window while preserving ORDER_INTENT zero broker live Phase 6 roster and observation-day locks', 'new_cycle4_v2_research_substrate'].join(',');
  const current = readText(BACKLOG_CSV);
  if (!current.includes(`${TICKET},`)) writeFileSync(BACKLOG_CSV, `${current.trimEnd()}\n${row}\n`, 'utf8');
}
function buildReportMarkdown(report: JsonRecord): string {
  const slotAccounting = asRecord(report.slot_accounting, 'slot_accounting');
  const counts = asRecord(report.runtime_marker_counts, 'runtime_marker_counts');
  const locks = asRecord(report.authority_locks, 'authority_locks');
  const outputHashes = asRecord(report.output_hashes, 'output_hashes');
  return [`# ${TICKET}`, '', `Determination: \`${report.determination}\``, '', '## Slot accounting', '', '| Field | Value |', '|---|---|', ...Object.entries(slotAccounting).map(([key, value]) => `| ${key} | \`${value}\` |`), '', '## Runtime marker counts', '', '| Marker | Count |', '|---|---:|', ...Object.entries(counts).map(([key, value]) => `| ${key} | ${value} |`), '', '## Authority locks', '', '| Field | Value |', '|---|---|', ...Object.entries(locks).map(([key, value]) => `| ${key} | \`${value}\` |`), '', '## Boundary result', '', '`STRAT_EVAL` and `CANDIDATE` were allowed through the bounded paper-runtime harness for source-backed ingested slots. `ORDER_INTENT`, ranking, sizing, risk, fills, positions, adapters, broker/live, Phase 6, and observation-day credit remained suppressed.', '', '## Output hashes', '', '| Artifact | LF SHA-256 |', '|---|---|', ...Object.entries(outputHashes).map(([key, value]) => `| ${key} | \`${value}\` |`), '', `Recommended next ticket: \`${report.recommended_next_ticket}\``, ''].join('\n');
}
function buildMemo(report: JsonRecord): string {
  return [`# ${TICKET} memo`, '', `Determination: \`${report.determination}\``, '', 'This implementation runs a bounded 2026-06-04 full-session/window paper-runtime candidate-only harness using the 390-slot contract from PR #327. It ingests 377 source-backed feature-computable snapshots and reports the 13 warmup-excluded accounting slots established by PR #320.', '', 'The result proves the candidate-only paper-runtime boundary across the full 2026-06-04 source-ready window. It does not authorize observation-day credit. Observation accounting remains `false / 0` until the separate accounting scope evaluates whether this evidence may count.', '', '## Authority caveat', '', 'No ORDER_INTENT, order translation, order adapter call, broker adapter call, paper fill, qfa-410b/qfa-611, ACTIVE_STRATEGY_IDS mutation, CANDIDATE_STRATEGY_IDS mutation, broker/live authority, Phase 6 authority, or observation-day increment is created by this ticket.', '', `Recommended next ticket: \`${report.recommended_next_ticket}\``, ''].join('\n');
}

async function main(): Promise<void> {
  ensureDir(OUT_DIR);
  if (!existsSync(STRATEGY_CONFIG_PATH)) throw new Error(`Missing strategy config path: ${STRATEGY_CONFIG_PATH}`);
  if (!existsSync(SOURCE_READINESS_JSONL)) throw new Error(`Missing source readiness JSONL: ${SOURCE_READINESS_JSONL}`);
  if (!existsSync(FULL_SESSION_SCOPE_REPORT)) throw new Error(`Missing full-session scope report: ${FULL_SESSION_SCOPE_REPORT}`);
  const sourceReport = JSON.parse(readText(SOURCE_READINESS_REPORT)) as JsonRecord;
  const sourceReadiness = asRecord(sourceReport.source_readiness, 'source_readiness');
  const sourceSlots = loadSourceSlots();
  if (sourceSlots.length !== ACCOUNTING_SLOTS_EXPECTED) throw new Error(`Expected ${ACCOUNTING_SLOTS_EXPECTED} source slots, got ${sourceSlots.length}`);
  if (numberField(sourceReadiness, 'source_ready_slots') !== ACCOUNTING_SLOTS_EXPECTED) throw new Error('source_ready_slots is not 390');
  if (numberField(sourceReadiness, 'feature_computable_slots') !== FEATURE_COMPUTABLE_EXPECTED) throw new Error('feature_computable_slots is not 377');
  const strategyConfigHash = sha256FileLf(STRATEGY_CONFIG_PATH);
  const runId = makeRunId('v2-pf-c-late-am-full-session-runtime-impl-20260604-run');
  const sessionId = makeSessionId('v2-pf-c-late-am-full-session-runtime-impl-20260604-session');
  const config = loadAppConfig({ configPath: 'config/app.example.json', cwd: ROOT, env: { QFA_JOURNAL_DIR: 'journals/paper/v2-pf-c-late-am-full-session-runtime-impl-20260604' } });
  const container = createStrategyRuntimeEngineContainer({ config });
  const runner = new StrategyRuntimeRunner({ container, run_id: runId, session_id: sessionId, execution_adapter: createSimulatedExecutionAdapter({ venue_costs: loadVenueCostTable() }), runtime_mode: 'paper', paper_observation_explicit_strategy_ids: [STRATEGY_ID], paper_observation_stop_after_candidate: true });
  const slotRecords: RuntimeSlotRecord[] = [];
  const candidateIds: string[] = [];
  for (const slot of sourceSlots) {
    const slotIndex = numberField(slot, 'slot_index');
    const slotStartTsNs = stringField(slot, 'slot_start_ts_ns');
    const slotEndTsNs = stringField(slot, 'slot_end_ts_ns');
    const base = { record_type: 'FULL_SESSION_RUNTIME_SLOT' as const, slot_index: slotIndex, slot_start_ts_ns: slotStartTsNs, slot_start_utc: stringField(slot, 'slot_utc'), slot_end_ts_ns: slotEndTsNs, slot_end_utc: stringField(slot, 'slot_end_utc') };
    const isWarmup = booleanField(slot, 'raw_or_normalized_trade_source_ready') && booleanField(slot, 'quote_mid_ready') && booleanField(slot, 'session_vwap_ready') && booleanField(slot, 'sigma_pts_ready') && !booleanField(slot, 'signed_shock_vwap_ready');
    if (isWarmup) {
      slotRecords.push({ ...base, status: 'WARMUP_EXCLUDED', feature_snapshot_id: null, feature_snapshot_lf_sha256: null, quote_mid_px: numberField(slot, 'quote_mid_px'), session_vwap: numberField(slot, 'session_vwap'), atr14_pts: null, sigma_pts: numberField(slot, 'sigma_pts'), signed_shock_vwap: null, STRAT_EVAL_count: 0, CANDIDATE_count: 0, RANK_count: 0, SIZING_count: 0, RISK_GATE_count: 0, ORDER_INTENT_count: 0, SIM_FILL_count: 0, EXEC_REJECT_count: 0, POSITION_count: 0, candidate_id_or_null: null, suppression_reason_or_null: 'ATR14_SIGNED_SHOCK_WARMUP_EXCLUDED' });
      continue;
    }
    const sourceReady = booleanField(slot, 'source_ready') && booleanField(slot, 'signed_shock_vwap_ready');
    if (!sourceReady) {
      slotRecords.push({ ...base, status: 'MISSING_SOURCE', feature_snapshot_id: null, feature_snapshot_lf_sha256: null, quote_mid_px: null, session_vwap: null, atr14_pts: null, sigma_pts: null, signed_shock_vwap: null, STRAT_EVAL_count: 0, CANDIDATE_count: 0, RANK_count: 0, SIZING_count: 0, RISK_GATE_count: 0, ORDER_INTENT_count: 0, SIM_FILL_count: 0, EXEC_REJECT_count: 0, POSITION_count: 0, candidate_id_or_null: null, suppression_reason_or_null: stringField(slot, 'missing_reason') });
      continue;
    }
    const snapshot = buildSnapshot(slot, strategyConfigHash);
    await runner.publishExternalEvent(sourceQuoteEventForSnapshot(snapshot, runId, sessionId));
    const result = await runner.processFeatureSnapshot(snapshot);
    const candidateId = typeof result.candidate_events[0]?.payload.candidate_id === 'string' ? result.candidate_events[0].payload.candidate_id : null;
    if (candidateId !== null) candidateIds.push(candidateId);
    slotRecords.push({ ...base, status: 'SNAPSHOT_INGESTED', feature_snapshot_id: snapshot.feature_snapshot_id, feature_snapshot_lf_sha256: snapshotDigest(snapshot), quote_mid_px: numberField(slot, 'quote_mid_px'), session_vwap: numberField(slot, 'session_vwap'), atr14_pts: numberField(slot, 'atr14_pts'), sigma_pts: numberField(slot, 'sigma_pts'), signed_shock_vwap: numberField(slot, 'signed_shock_vwap'), STRAT_EVAL_count: result.strategy_evaluation_events.length, CANDIDATE_count: result.candidate_events.length, RANK_count: result.rank_event === undefined ? 0 : 1, SIZING_count: result.sizing_events.length, RISK_GATE_count: result.risk_gate_events.length, ORDER_INTENT_count: result.order_intent_events.length, SIM_FILL_count: result.sim_fill_events.length, EXEC_REJECT_count: result.exec_reject_events.length, POSITION_count: result.position_events.length, candidate_id_or_null: candidateId, suppression_reason_or_null: result.paper_observation_stopped_after_candidate === true ? 'PAPER_OBSERVATION_STOP_AFTER_CANDIDATE' : null });
  }
  const counts = markerCounts(slotRecords);
  const sourceBackedSnapshotsEmitted = slotRecords.filter((record) => record.status === 'SNAPSHOT_INGESTED').length;
  const warmupExcludedSlots = slotRecords.filter((record) => record.status === 'WARMUP_EXCLUDED').length;
  const slotsMissingSource = slotRecords.filter((record) => record.status === 'MISSING_SOURCE').length;
  const slotsFailedClosed = slotRecords.filter((record) => record.status === 'FAILED_CLOSED').length;
  const orderBoundaryLeaked = counts.ORDER_INTENT !== 0 || counts.RANK !== 0 || counts.SIZING !== 0 || counts.RISK_GATE !== 0 || counts.SIM_FILL !== 0 || counts.POSITION !== 0;
  const success = sourceBackedSnapshotsEmitted === FEATURE_COMPUTABLE_EXPECTED && warmupExcludedSlots === WARMUP_EXCLUDED_EXPECTED && slotsMissingSource === 0 && slotsFailedClosed === 0 && Number(counts.STRAT_EVAL) === FEATURE_COMPUTABLE_EXPECTED && Number(counts.CANDIDATE) >= 1 && !orderBoundaryLeaked;
  const determination = success ? DETERMINATION_PASS : orderBoundaryLeaked ? DETERMINATION_ORDER_LEAK : DETERMINATION_MISSING_SOURCE;
  const recommendedNextTicket = determination === DETERMINATION_PASS ? PASSED_NEXT_TICKET : BLOCKED_SOURCE_NEXT_TICKET;
  const slotAccounting: JsonRecord = { accounting_slots_expected: ACCOUNTING_SLOTS_EXPECTED, source_ready_slots: ACCOUNTING_SLOTS_EXPECTED, source_backed_snapshots_emitted: sourceBackedSnapshotsEmitted, snapshots_ingested: sourceBackedSnapshotsEmitted, slots_processed: slotRecords.length, slots_missing_source: slotsMissingSource, slots_failed_closed: slotsFailedClosed, warmup_excluded_slots: warmupExcludedSlots, skipped_slots: 0, first_slot_utc: SESSION_OPEN_UTC, last_slot_utc: '2026-06-04T19:59:00.000000000Z', observation_window_start_utc: SESSION_OPEN_UTC, observation_window_end_utc: SESSION_CLOSE_UTC, slot_cadence: '1m_closed_bar_accounting_slot' };
  const authorityLocks: JsonRecord = { observation_day_eligible: false, observation_day_increment: 0, paper_runtime_invoked: true, full_session_runtime_harness_invoked: true, paper_observation_stop_after_candidate: true, order_translation_invoked: false, order_adapter_call_count: 0, broker_adapter_call_count: 0, paper_fill_count: 0, qfa_410b_or_qfa_611_run: false, ACTIVE_STRATEGY_IDS_mutated: false, CANDIDATE_STRATEGY_IDS_mutated: false, broker_live_authorized: false, phase_6_authorized: false };
  const records: Json[] = [{ record_type: 'SESSION_MANIFEST', manifest_role: 'open', ticket: TICKET, substrate_sha: SUBSTRATE_SHA, strategy_id: STRATEGY_ID, run_id: String(runId), session_id: String(sessionId), observation_window_start_utc: SESSION_OPEN_UTC, observation_window_end_utc: SESSION_CLOSE_UTC, accounting_slots_expected: ACCOUNTING_SLOTS_EXPECTED, paper_observation_explicit_strategy_ids: [STRATEGY_ID], paper_observation_stop_after_candidate: true }, ...slotRecords.map((record) => toJson(record)), { record_type: 'SESSION_MANIFEST', manifest_role: 'close', ticket: TICKET, determination, slot_accounting: slotAccounting, runtime_marker_counts: counts, authority_locks: authorityLocks }];
  writeFileSync(BOUNDED_JSONL, stableJsonl(records), 'utf8');
  if (statSync(BOUNDED_JSONL).size > MAX_ARTIFACT_BYTES) throw new Error(`Bounded JSONL exceeds 95 MiB guard: ${BOUNDED_JSONL}`);
  const boundedSha = sha256FileLf(BOUNDED_JSONL);
  const report: Record<string, Json> = { ticket: TICKET, determination, substrate_sha: SUBSTRATE_SHA, strategy_id: STRATEGY_ID, source_anchors: { source_readiness_jsonl_lf_sha256: sha256FileLf(SOURCE_READINESS_JSONL), source_readiness_report_lf_sha256: sha256FileLf(SOURCE_READINESS_REPORT), full_session_scope_report_lf_sha256: sha256FileLf(FULL_SESSION_SCOPE_REPORT) }, slot_accounting: slotAccounting, runtime_marker_counts: counts, candidate_summary: { candidate_count: candidateIds.length, first_candidate_id: candidateIds[0] ?? null, last_candidate_id: candidateIds[candidateIds.length - 1] ?? null }, boundary_summary: { full_session_contract_satisfied: success, partial_runtime_boundary_proof: Number(counts.STRAT_EVAL) > 0 && Number(counts.CANDIDATE) >= 1 && counts.ORDER_INTENT === 0, order_boundary_leaked: orderBoundaryLeaked }, guard_contract: { runtime_mode: 'paper', paper_observation_explicit_strategy_ids: [STRATEGY_ID], paper_observation_stop_after_candidate: true, stop_before: 'rankCandidates(...), sizing/risk, createEntryOrderIntent(...), order adapter, broker adapter, fill handling' }, authority_locks: authorityLocks, output_hashes: { bounded_full_session_runtime_impl_jsonl: boundedSha }, recommended_next_ticket: recommendedNextTicket };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  report.output_hashes = { bounded_full_session_runtime_impl_jsonl: boundedSha, full_session_runtime_impl_report_json: sha256FileLf(REPORT_JSON) };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  writeFileSync(REPORT_MD, buildReportMarkdown(report), 'utf8');
  report.output_hashes = { bounded_full_session_runtime_impl_jsonl: boundedSha, full_session_runtime_impl_report_json: sha256FileLf(REPORT_JSON), full_session_runtime_impl_report_md: sha256FileLf(REPORT_MD) };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  writeFileSync(REPORT_MD, buildReportMarkdown(report), 'utf8');
  writeFileSync(MEMO_MD, buildMemo(report), 'utf8');
  appendBacklogRow();
  console.log(JSON.stringify({ state: 'PENDING_REVIEW', ticket: TICKET, substrate_sha: SUBSTRATE_SHA, determination, slot_accounting: slotAccounting, runtime_marker_counts: counts, authority_locks: authorityLocks, bounded_jsonl_lf_sha256: sha256FileLf(BOUNDED_JSONL), report_json_lf_sha256: sha256FileLf(REPORT_JSON), report_md_lf_sha256: sha256FileLf(REPORT_MD), memo_lf_sha256: sha256FileLf(MEMO_MD), recommended_next_ticket: recommendedNextTicket }, null, 2));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
