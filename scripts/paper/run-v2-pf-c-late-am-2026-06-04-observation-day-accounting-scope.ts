import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

const ticket = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-OBSERVATION-DAY-ACCOUNTING-SCOPE-01';
const slug = 'v2-pf-c-late-am-paper-observation-2026-06-04-observation-day-accounting-scope-01';
const strategyId = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const sourceReportPath = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-04-full-session-runtime-impl-01/full-session-runtime-impl-report.json';
const artifactDir = `artifacts/paper-observation/${slug}`;
const boundedPath = `${artifactDir}/bounded-observation-day-accounting-scope.jsonl`;
const reportJsonPath = `${artifactDir}/observation-day-accounting-scope-report.json`;
const reportMdPath = `${artifactDir}/observation-day-accounting-scope-report.md`;
const memoPath = `docs/research/${slug}-memo.md`;
const backlogPath = 'docs/plan/new_app_v1_ticket_backlog_v6.csv';

function stable(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
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

const sourceReport = asRecord(JSON.parse(readFileSync(sourceReportPath, 'utf8')));
const slotAccounting = asRecord(sourceReport.slot_accounting);
const markerCounts = asRecord(sourceReport.runtime_marker_counts);
const authorityLocks = asRecord(sourceReport.authority_locks);
const boundarySummary = asRecord(sourceReport.boundary_summary);
const outputHashes = asRecord(sourceReport.output_hashes);

const criteria: JsonRecord = {
  full_session_contract_satisfied: bool(boundarySummary, 'full_session_contract_satisfied'),
  accounting_slots_expected_is_390: num(slotAccounting, 'accounting_slots_expected') === 390,
  source_ready_slots_is_390: num(slotAccounting, 'source_ready_slots') === 390,
  source_backed_snapshots_ingested_is_377: num(slotAccounting, 'snapshots_ingested') === 377,
  slots_missing_source_is_zero: num(slotAccounting, 'slots_missing_source') === 0,
  slots_failed_closed_is_zero: num(slotAccounting, 'slots_failed_closed') === 0,
  warmup_excluded_slots_is_13: num(slotAccounting, 'warmup_excluded_slots') === 13,
  strat_eval_positive: num(markerCounts, 'STRAT_EVAL') > 0,
  candidate_positive: num(markerCounts, 'CANDIDATE') > 0,
  order_intent_zero: num(markerCounts, 'ORDER_INTENT') === 0,
  rank_zero: num(markerCounts, 'RANK') === 0,
  sizing_zero: num(markerCounts, 'SIZING') === 0,
  risk_gate_zero: num(markerCounts, 'RISK_GATE') === 0,
  sim_fill_zero: num(markerCounts, 'SIM_FILL') === 0,
  position_zero: num(markerCounts, 'POSITION') === 0,
  order_translation_not_invoked: authorityLocks.order_translation_invoked === false,
  order_adapter_call_count_zero: num(authorityLocks, 'order_adapter_call_count') === 0,
  broker_adapter_call_count_zero: num(authorityLocks, 'broker_adapter_call_count') === 0,
  paper_fill_count_zero: num(authorityLocks, 'paper_fill_count') === 0,
};
const allCriteriaPass = Object.values(criteria).every((value) => value === true);
if (!allCriteriaPass) throw new Error('observation-day accounting scope criteria did not pass');

const accountingContract: JsonRecord = {
  observation_day_accounting_scope_ready_for_impl: true,
  observation_day_accounting_impl_authorized_by_scope: true,
  observation_day_credit_awarded_by_this_ticket: false,
  observation_day_eligible: false,
  observation_day_increment: 0,
  credit_unit: 'one_2026_06_04_rth_full_session_candidate_only_runtime_evidence_unit',
  minimum_impl_inputs: {
    source_report_path: sourceReportPath,
    prior_runtime_determination: String(sourceReport.determination),
    strategy_id: strategyId,
    observation_window_start_utc: String(slotAccounting.observation_window_start_utc),
    observation_window_end_utc: String(slotAccounting.observation_window_end_utc),
    accounting_slots_expected: num(slotAccounting, 'accounting_slots_expected'),
    source_ready_slots: num(slotAccounting, 'source_ready_slots'),
    source_backed_snapshots_required: num(slotAccounting, 'snapshots_ingested'),
    warmup_excluded_slots: num(slotAccounting, 'warmup_excluded_slots'),
    slots_missing_source: num(slotAccounting, 'slots_missing_source'),
    slots_failed_closed: num(slotAccounting, 'slots_failed_closed'),
    required_guard: 'paper_observation_stop_after_candidate',
    order_intent_required_for_observation_day_credit: false,
    order_path_simulation_required_by_this_scope: false,
  },
  next_impl_success_criteria: {
    one_accounting_record_for_2026_06_04_rth: true,
    source_report_hash_matches_anchor: true,
    STRAT_EVAL_count: num(markerCounts, 'STRAT_EVAL'),
    CANDIDATE_count: num(markerCounts, 'CANDIDATE'),
    ORDER_INTENT_count: 0,
    observation_day_increment_expected_in_impl: 1,
    broker_live_authority_expected_in_impl: false,
  },
};

const authorityCaveat: JsonRecord = {
  no_ORDER_INTENT_authority: true,
  no_order_translation: true,
  no_order_adapter: true,
  no_broker_adapter: true,
  no_paper_fill: true,
  no_qfa_410b_or_qfa_611: true,
  no_ACTIVE_STRATEGY_IDS_mutation: true,
  no_CANDIDATE_STRATEGY_IDS_mutation: true,
  no_broker_live_phase_6_roster_authority: true,
  observation_day_eligible: false,
  observation_day_increment: 0,
};

const boundedRecords: JsonRecord[] = [
  {
    record_type: 'OBSERVATION_DAY_ACCOUNTING_SCOPE_SOURCE_ANCHOR',
    ticket,
    source_ticket: String(sourceReport.ticket),
    source_report_path: sourceReportPath,
    source_report_lf_sha256: fileLfSha256(sourceReportPath),
    source_output_hashes: outputHashes,
  },
  {
    record_type: 'OBSERVATION_DAY_ACCOUNTING_SCOPE_RUNTIME_EVIDENCE',
    ticket,
    strategy_id: strategyId,
    slot_accounting: slotAccounting,
    runtime_marker_counts: markerCounts,
    boundary_summary: boundarySummary,
    authority_locks: authorityLocks,
  },
  {
    record_type: 'OBSERVATION_DAY_ACCOUNTING_SCOPE_DECISION',
    ticket,
    determination: 'OBSERVATION_DAY_ACCOUNTING_SCOPE_READY_FOR_IMPL',
    criteria,
    accounting_contract: accountingContract,
    authority_caveat: authorityCaveat,
    recommended_next_ticket: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-OBSERVATION-DAY-ACCOUNTING-IMPL-01',
  },
];
const boundedText = boundedRecords.map((record) => stable(record)).join('\n') + '\n';
writeText(boundedPath, boundedText);

const report: Record<string, Json> = {
  ticket,
  substrate_sha: 'd7b5e03421e4eb2f0ed0dee126c406b0b6bdf9c7',
  determination: 'OBSERVATION_DAY_ACCOUNTING_SCOPE_READY_FOR_IMPL',
  source_anchor: {
    pr_328_merge_commit: 'd7b5e03421e4eb2f0ed0dee126c406b0b6bdf9c7',
    source_report_path: sourceReportPath,
    source_report_lf_sha256: fileLfSha256(sourceReportPath),
    source_determination: String(sourceReport.determination),
    source_output_hashes: outputHashes,
  },
  strategy_id: strategyId,
  full_session_evidence: {
    slot_accounting: slotAccounting,
    runtime_marker_counts: markerCounts,
    boundary_summary: boundarySummary,
  },
  criteria,
  accounting_contract: accountingContract,
  authority_caveat: authorityCaveat,
  recommended_next_ticket: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-OBSERVATION-DAY-ACCOUNTING-IMPL-01',
};
writeText(reportJsonPath, stable(report) + '\n');
report.output_hashes = {
  bounded_observation_day_accounting_scope_jsonl: fileLfSha256(boundedPath),
  observation_day_accounting_scope_report_json: fileLfSha256(reportJsonPath),
};
writeText(reportJsonPath, stable(report) + '\n');

const reportMd = `# ${ticket}\n\n## Determination\n\n\`\`\`text\nOBSERVATION_DAY_ACCOUNTING_SCOPE_READY_FOR_IMPL\n\`\`\`\n\nThis scope authorizes a bounded observation-day accounting implementation, but it does not award observation-day credit itself.\n\n## Source anchor\n\n| Field | Value |\n|---|---|\n| PR #328 merge commit | d7b5e03421e4eb2f0ed0dee126c406b0b6bdf9c7 |\n| Source report | ${sourceReportPath} |\n| Source determination | ${String(sourceReport.determination)} |\n| Source report LF SHA256 | ${fileLfSha256(sourceReportPath)} |\n\n## Full-session evidence\n\n| Metric | Value |\n|---|---:|\n| accounting_slots_expected | ${num(slotAccounting, 'accounting_slots_expected')} |\n| source_ready_slots | ${num(slotAccounting, 'source_ready_slots')} |\n| source_backed_snapshots_emitted | ${num(slotAccounting, 'source_backed_snapshots_emitted')} |\n| snapshots_ingested | ${num(slotAccounting, 'snapshots_ingested')} |\n| warmup_excluded_slots | ${num(slotAccounting, 'warmup_excluded_slots')} |\n| slots_missing_source | ${num(slotAccounting, 'slots_missing_source')} |\n| slots_failed_closed | ${num(slotAccounting, 'slots_failed_closed')} |\n| STRAT_EVAL | ${num(markerCounts, 'STRAT_EVAL')} |\n| CANDIDATE | ${num(markerCounts, 'CANDIDATE')} |\n| ORDER_INTENT | ${num(markerCounts, 'ORDER_INTENT')} |\n| RANK | ${num(markerCounts, 'RANK')} |\n| SIZING | ${num(markerCounts, 'SIZING')} |\n| RISK_GATE | ${num(markerCounts, 'RISK_GATE')} |\n| SIM_FILL | ${num(markerCounts, 'SIM_FILL')} |\n| POSITION | ${num(markerCounts, 'POSITION')} |\n\n## Accounting scope contract\n\n| Field | Value |\n|---|---|\n| observation_day_accounting_scope_ready_for_impl | true |\n| observation_day_accounting_impl_authorized_by_scope | true |\n| observation_day_credit_awarded_by_this_ticket | false |\n| observation_day_eligible | false |\n| observation_day_increment | 0 |\n| order_intent_required_for_observation_day_credit | false |\n| order_path_simulation_required_by_this_scope | false |\n| expected implementation increment | 1 if the implementation preserves this anchored evidence and authority locks |\n\n## Authority caveat\n\nNo ORDER_INTENT authority, order translation, order adapter call, broker adapter call, paper fill, qfa-410b/qfa-611, roster mutation, broker/live authority, or Phase 6 authority is created by this scope ticket.\n\n## Output hashes\n\n| Output | LF SHA256 |\n|---|---|\n| bounded JSONL | ${fileLfSha256(boundedPath)} |\n| report JSON | ${fileLfSha256(reportJsonPath)} |\n\n## Recommended next ticket\n\n\`\`\`text\nV2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-OBSERVATION-DAY-ACCOUNTING-IMPL-01\n\`\`\`\n`;
writeText(reportMdPath, reportMd);

const memo = `# ${ticket} memo\n\n## Decision\n\n\`OBSERVATION_DAY_ACCOUNTING_SCOPE_READY_FOR_IMPL\`\n\nPR #328 proves the full-session candidate-only paper-runtime evidence contract for 2026-06-04. This ticket scopes the accounting implementation that may convert that anchored evidence into an observation-day accounting record. This ticket itself does not increment observation-day credit.\n\n## Load-bearing evidence\n\n- accounting window: ${String(slotAccounting.observation_window_start_utc)} to ${String(slotAccounting.observation_window_end_utc)}\n- accounting slots expected: ${num(slotAccounting, 'accounting_slots_expected')}\n- source-ready slots: ${num(slotAccounting, 'source_ready_slots')}\n- source-backed snapshots ingested: ${num(slotAccounting, 'snapshots_ingested')}\n- warmup excluded slots: ${num(slotAccounting, 'warmup_excluded_slots')}\n- missing source slots: ${num(slotAccounting, 'slots_missing_source')}\n- STRAT_EVAL: ${num(markerCounts, 'STRAT_EVAL')}\n- CANDIDATE: ${num(markerCounts, 'CANDIDATE')}\n- ORDER_INTENT: ${num(markerCounts, 'ORDER_INTENT')}\n\n## Accounting boundary\n\nThe next implementation may create a bounded observation-day accounting record for the anchored PR #328 evidence if it preserves the source hash, marker counts, guard contract, and authority locks. This scope does not authorize broker/live work and does not require order intent, order-path simulation, paper fills, or Phase 6 authority.\n\n## Authority caveat\n\nNo ORDER_INTENT authority, order translation, order adapter call, broker adapter call, paper fill, qfa-410b/qfa-611, active/candidate roster mutation, broker/live authority, or Phase 6 authority is created here.\n\n## Recommended next ticket\n\n\`V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-OBSERVATION-DAY-ACCOUNTING-IMPL-01\`\n`;
writeText(memoPath, memo);

const backlogRow = `${ticket},P1,1.0,V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FULL-SESSION-RUNTIME-IMPL-01,Scope bounded 2026-06-04 observation-day accounting implementation from full-session candidate-only runtime evidence while preserving ORDER_INTENT zero broker live Phase 6 roster and observation-day locks,new_cycle4_v2_research_substrate`;
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
  accounting_slots_expected: num(slotAccounting, 'accounting_slots_expected'),
  source_ready_slots: num(slotAccounting, 'source_ready_slots'),
  snapshots_ingested: num(slotAccounting, 'snapshots_ingested'),
  STRAT_EVAL: num(markerCounts, 'STRAT_EVAL'),
  CANDIDATE: num(markerCounts, 'CANDIDATE'),
  ORDER_INTENT: num(markerCounts, 'ORDER_INTENT'),
  observation_day_eligible: false,
  observation_day_increment: 0,
  recommended_next_ticket: finalReport.recommended_next_ticket,
  output_hashes: finalReport.output_hashes,
}, null, 2));
