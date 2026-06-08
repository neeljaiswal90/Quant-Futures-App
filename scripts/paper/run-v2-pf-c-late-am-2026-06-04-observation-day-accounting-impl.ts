import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

const ticket = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-OBSERVATION-DAY-ACCOUNTING-IMPL-01';
const slug = 'v2-pf-c-late-am-paper-observation-2026-06-04-observation-day-accounting-impl-01';
const strategyId = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const scopeReportPath = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-04-observation-day-accounting-scope-01/observation-day-accounting-scope-report.json';
const runtimeReportPath = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-04-full-session-runtime-impl-01/full-session-runtime-impl-report.json';
const artifactDir = `artifacts/paper-observation/${slug}`;
const boundedPath = `${artifactDir}/bounded-observation-day-accounting-impl.jsonl`;
const reportJsonPath = `${artifactDir}/observation-day-accounting-impl-report.json`;
const reportMdPath = `${artifactDir}/observation-day-accounting-impl-report.md`;
const memoPath = `docs/research/${slug}-memo.md`;
const backlogPath = 'docs/plan/new_app_v1_ticket_backlog_v6.csv';

function stable(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
}
function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}
function lfSha256(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}
function fileLfSha256(path: string): string {
  return lfSha256(readFileSync(path, 'utf8'));
}
function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected JSON object');
  return value as JsonRecord;
}
function num(record: JsonRecord, key: string): number {
  const value = record[key];
  if (typeof value !== 'number') throw new Error(`expected numeric ${key}`);
  return value;
}
function bool(record: JsonRecord, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') throw new Error(`expected boolean ${key}`);
  return value;
}

const scopeReport = asRecord(JSON.parse(readFileSync(scopeReportPath, 'utf8')));
const runtimeReport = asRecord(JSON.parse(readFileSync(runtimeReportPath, 'utf8')));
const slotAccounting = asRecord(runtimeReport.slot_accounting);
const markerCounts = asRecord(runtimeReport.runtime_marker_counts);
const authorityLocks = asRecord(runtimeReport.authority_locks);
const boundarySummary = asRecord(runtimeReport.boundary_summary);
const scopeContract = asRecord(scopeReport.accounting_contract);

const prerequisites: JsonRecord = {
  scope_determination_ready: String(scopeReport.determination) === 'OBSERVATION_DAY_ACCOUNTING_SCOPE_READY_FOR_IMPL',
  impl_authorized_by_scope: bool(scopeContract, 'observation_day_accounting_impl_authorized_by_scope'),
  full_session_contract_satisfied: bool(boundarySummary, 'full_session_contract_satisfied'),
  accounting_slots_expected: num(slotAccounting, 'accounting_slots_expected'),
  source_ready_slots: num(slotAccounting, 'source_ready_slots'),
  snapshots_ingested: num(slotAccounting, 'snapshots_ingested'),
  warmup_excluded_slots: num(slotAccounting, 'warmup_excluded_slots'),
  slots_missing_source: num(slotAccounting, 'slots_missing_source'),
  slots_failed_closed: num(slotAccounting, 'slots_failed_closed'),
  STRAT_EVAL_count: num(markerCounts, 'STRAT_EVAL'),
  CANDIDATE_count: num(markerCounts, 'CANDIDATE'),
  ORDER_INTENT_count: num(markerCounts, 'ORDER_INTENT'),
  RANK_count: num(markerCounts, 'RANK'),
  SIZING_count: num(markerCounts, 'SIZING'),
  RISK_GATE_count: num(markerCounts, 'RISK_GATE'),
  SIM_FILL_count: num(markerCounts, 'SIM_FILL'),
  POSITION_count: num(markerCounts, 'POSITION'),
  order_translation_invoked: authorityLocks.order_translation_invoked === true,
  order_adapter_call_count: num(authorityLocks, 'order_adapter_call_count'),
  broker_adapter_call_count: num(authorityLocks, 'broker_adapter_call_count'),
  paper_fill_count: num(authorityLocks, 'paper_fill_count'),
};
const pass =
  prerequisites.scope_determination_ready === true &&
  prerequisites.impl_authorized_by_scope === true &&
  prerequisites.full_session_contract_satisfied === true &&
  prerequisites.accounting_slots_expected === 390 &&
  prerequisites.source_ready_slots === 390 &&
  prerequisites.snapshots_ingested === 377 &&
  prerequisites.warmup_excluded_slots === 13 &&
  prerequisites.slots_missing_source === 0 &&
  prerequisites.slots_failed_closed === 0 &&
  prerequisites.STRAT_EVAL_count === 377 &&
  prerequisites.CANDIDATE_count === 182 &&
  prerequisites.ORDER_INTENT_count === 0 &&
  prerequisites.RANK_count === 0 &&
  prerequisites.SIZING_count === 0 &&
  prerequisites.RISK_GATE_count === 0 &&
  prerequisites.SIM_FILL_count === 0 &&
  prerequisites.POSITION_count === 0 &&
  prerequisites.order_translation_invoked === false &&
  prerequisites.order_adapter_call_count === 0 &&
  prerequisites.broker_adapter_call_count === 0 &&
  prerequisites.paper_fill_count === 0;
if (!pass) throw new Error('observation-day accounting prerequisites failed');

const accountingRecord: JsonRecord = {
  record_type: 'PAPER_OBSERVATION_DAY_ACCOUNTING_RECORD',
  accounting_schema: 1,
  ticket,
  strategy_id: strategyId,
  session_id: '2026-06-04-rth',
  observation_window_start_utc: String(slotAccounting.observation_window_start_utc),
  observation_window_end_utc: String(slotAccounting.observation_window_end_utc),
  accounting_slots_expected: 390,
  source_ready_slots: 390,
  warmup_excluded_slots: 13,
  source_backed_snapshots_ingested: 377,
  STRAT_EVAL_count: 377,
  CANDIDATE_count: 182,
  ORDER_INTENT_count: 0,
  observation_day_eligible: true,
  observation_day_increment: 1,
  observation_day_credit_basis: 'FULL_RTH_CANDIDATE_ONLY_PAPER_RUNTIME_EVIDENCE_STOP_AFTER_CANDIDATE',
  order_intent_required_for_credit: false,
  order_path_simulation_required_for_credit: false,
  paper_runtime_guard: 'paper_observation_stop_after_candidate',
  authority_created: false,
  broker_live_authorized: false,
  phase_6_authorized: false,
};

const authorityCaveat: JsonRecord = {
  ORDER_INTENT_authorized: false,
  order_translation_invoked: false,
  order_adapter_call_count: 0,
  broker_adapter_call_count: 0,
  paper_fill_count: 0,
  qfa_410b_or_qfa_611_run: false,
  ACTIVE_STRATEGY_IDS_mutated: false,
  CANDIDATE_STRATEGY_IDS_mutated: false,
  broker_live_authorized: false,
  phase_6_authorized: false,
  authority_created: false,
};

const boundedRecords: JsonRecord[] = [
  {
    record_type: 'OBSERVATION_DAY_ACCOUNTING_IMPL_SOURCE_ANCHORS',
    ticket,
    scope_report_path: scopeReportPath,
    scope_report_lf_sha256: fileLfSha256(scopeReportPath),
    runtime_report_path: runtimeReportPath,
    runtime_report_lf_sha256: fileLfSha256(runtimeReportPath),
  },
  {
    record_type: 'OBSERVATION_DAY_ACCOUNTING_IMPL_PREREQUISITES',
    ticket,
    prerequisites,
    prerequisite_status: 'PASSED',
  },
  accountingRecord,
  {
    record_type: 'OBSERVATION_DAY_ACCOUNTING_IMPL_AUTHORITY_CAVEAT',
    ticket,
    authority_caveat: authorityCaveat,
  },
];
writeText(boundedPath, boundedRecords.map((record) => stable(record)).join('\n') + '\n');

const report: Record<string, Json> = {
  ticket,
  substrate_sha: 'c2596255b4af49fd8d8f2dbcfc10a1040d47abf0',
  determination: 'OBSERVATION_DAY_ACCOUNTING_IMPL_PASSED_INCREMENT_RECORDED',
  strategy_id: strategyId,
  source_anchors: {
    pr_329_merge_commit: 'c2596255b4af49fd8d8f2dbcfc10a1040d47abf0',
    scope_report_path: scopeReportPath,
    scope_report_lf_sha256: fileLfSha256(scopeReportPath),
    runtime_report_path: runtimeReportPath,
    runtime_report_lf_sha256: fileLfSha256(runtimeReportPath),
  },
  prerequisites,
  accounting_record: accountingRecord,
  authority_caveat: authorityCaveat,
  cumulative_progress: {
    observation_days_completed: 1,
    minimum_trading_days_required: 45,
    preferred_trading_days_required: 60,
    progress_minimum: '1/45',
    progress_preferred: '1/60',
  },
  recommended_next_ticket: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-RESEARCH-CLOSURE-01',
};
writeText(reportJsonPath, stable(report) + '\n');
report.output_hashes = {
  bounded_observation_day_accounting_impl_jsonl: fileLfSha256(boundedPath),
  observation_day_accounting_impl_report_json: fileLfSha256(reportJsonPath),
};
writeText(reportJsonPath, stable(report) + '\n');

const md = `# ${ticket}\n\n## Determination\n\n\`\`\`text\nOBSERVATION_DAY_ACCOUNTING_IMPL_PASSED_INCREMENT_RECORDED\n\`\`\`\n\nThis implements a bounded paper-observation accounting record for the anchored 2026-06-04 full-session candidate-only paper-runtime evidence.\n\n## Accounting record\n\n| Field | Value |\n|---|---|\n| session_id | 2026-06-04-rth |\n| strategy_id | ${strategyId} |\n| observation_window_start_utc | ${String(slotAccounting.observation_window_start_utc)} |\n| observation_window_end_utc | ${String(slotAccounting.observation_window_end_utc)} |\n| accounting_slots_expected | 390 |\n| source_ready_slots | 390 |\n| warmup_excluded_slots | 13 |\n| source_backed_snapshots_ingested | 377 |\n| STRAT_EVAL_count | 377 |\n| CANDIDATE_count | 182 |\n| ORDER_INTENT_count | 0 |\n| observation_day_eligible | true |\n| observation_day_increment | 1 |\n\n## Progress\n\n| Requirement | Progress |\n|---|---|\n| Minimum paper-observation target | 1 / 45 trading days |\n| Preferred paper-observation target | 1 / 60 trading days |\n\n## Authority caveat\n\nThis accounting record does not authorize ORDER_INTENT, order translation, order adapter calls, broker adapter calls, paper fills, qfa-410b/qfa-611, active/candidate roster mutation, broker/live trading, or Phase 6.\n\n## Output hashes\n\n| Output | LF SHA256 |\n|---|---|\n| bounded JSONL | ${fileLfSha256(boundedPath)} |\n| report JSON | ${fileLfSha256(reportJsonPath)} |\n\n## Recommended next ticket\n\n\`\`\`text\nV2-PF-C-LATE-AM-PAPER-OBSERVATION-RESEARCH-CLOSURE-01\n\`\`\`\n`;
writeText(reportMdPath, md);

const memo = `# ${ticket} memo\n\n## Result\n\n\`OBSERVATION_DAY_ACCOUNTING_IMPL_PASSED_INCREMENT_RECORDED\`\n\nThe 2026-06-04 full-session candidate-only paper-runtime evidence is now represented as one bounded paper-observation accounting day. This is research accounting only and creates no broker/live/order authority.\n\n## Evidence basis\n\n- PR #328 full-session runtime evidence passed the candidate-only guard.\n- PR #329 scoped observation-day accounting implementation from that evidence.\n- Accounting window: ${String(slotAccounting.observation_window_start_utc)} to ${String(slotAccounting.observation_window_end_utc)}.\n- Source-ready slots: 390.\n- Source-backed snapshots ingested: 377.\n- Warmup excluded slots: 13.\n- STRAT_EVAL: 377.\n- CANDIDATE: 182.\n- ORDER_INTENT: 0.\n\n## Accounting status\n\n\`observation_day_eligible = true\`\n\n\`observation_day_increment = 1\`\n\nProgress is now 1/45 minimum and 1/60 preferred paper-observation trading days.\n\n## Authority caveat\n\nNo ORDER_INTENT, order translation, order adapter, broker adapter, paper fill, qfa-410b/qfa-611, active/candidate roster mutation, broker/live authority, or Phase 6 authority is created.\n\n## Recommended next ticket\n\n\`V2-PF-C-LATE-AM-PAPER-OBSERVATION-RESEARCH-CLOSURE-01\`\n`;
writeText(memoPath, memo);

const backlogRow = `${ticket},P1,1.0,V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-OBSERVATION-DAY-ACCOUNTING-SCOPE-01,Implement bounded 2026-06-04 paper-observation day accounting from full-session candidate-only runtime evidence while preserving ORDER_INTENT zero broker live Phase 6 and roster authority,new_cycle4_v2_research_substrate`;
const backlog = readFileSync(backlogPath, 'utf8');
if (!backlog.includes(ticket)) {
  writeFileSync(backlogPath, `${backlog.replace(/\s*$/, '')}\n${backlogRow}\n`, 'utf8');
}

const finalReport = asRecord(JSON.parse(readFileSync(reportJsonPath, 'utf8')));
console.log(JSON.stringify({
  state: 'PENDING_REVIEW',
  ticket,
  substrate_sha: finalReport.substrate_sha,
  determination: finalReport.determination,
  observation_day_eligible: true,
  observation_day_increment: 1,
  progress_minimum: '1/45',
  progress_preferred: '1/60',
  STRAT_EVAL: 377,
  CANDIDATE: 182,
  ORDER_INTENT: 0,
  authority_created: false,
  recommended_next_ticket: finalReport.recommended_next_ticket,
  output_hashes: finalReport.output_hashes,
}, null, 2));
