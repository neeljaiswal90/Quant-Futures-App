import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

const ticket = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-DAILY-CONTINUATION-01';
const slug = 'v2-pf-c-late-am-paper-observation-daily-continuation-01';
const strategyId = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const closureReportPath = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-research-closure-01/research-closure-report.json';
const accountingReportPath = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-04-observation-day-accounting-impl-01/observation-day-accounting-impl-report.json';
const artifactDir = `artifacts/paper-observation/${slug}`;
const boundedPath = `${artifactDir}/bounded-daily-continuation.jsonl`;
const reportJsonPath = `${artifactDir}/daily-continuation-report.json`;
const reportMdPath = `${artifactDir}/daily-continuation-report.md`;
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

const closureReport = asRecord(JSON.parse(readFileSync(closureReportPath, 'utf8')));
const accountingReport = asRecord(JSON.parse(readFileSync(accountingReportPath, 'utf8')));
const closureStatus = asRecord(closureReport.closure_status);
const accountingRecord = asRecord(accountingReport.accounting_record);
const authorityBoundary = asRecord(closureReport.authority_boundary);

if (String(closureReport.determination) !== 'PAPER_OBSERVATION_RESEARCH_CLOSURE_COMPLETE_ONE_DAY_RECORDED') throw new Error('closure anchor mismatch');
if (num(closureStatus, 'observation_days_completed') !== 1) throw new Error('expected one completed day');
if (bool(authorityBoundary, 'broker_scope_authorized') !== false) throw new Error('unexpected broker authority');

const continuationContract: JsonRecord = {
  determination: 'DAILY_CONTINUATION_READY_NEXT_DAY_CONTRACT_DEFINED',
  current_observation_days_completed: 1,
  minimum_trading_days_required: 45,
  preferred_trading_days_required: 60,
  remaining_minimum_days: 44,
  remaining_preferred_days: 59,
  next_day_credit_requires: {
    full_rth_session_window: true,
    accounting_slots_expected: 390,
    source_ready_slots: 390,
    warmup_excluded_slots_reported: true,
    source_backed_snapshots_ingested_reported: true,
    paper_runtime_stop_after_candidate: true,
    STRAT_EVAL_positive: true,
    CANDIDATE_allowed: true,
    ORDER_INTENT_count_must_equal: 0,
    RANK_SIZING_RISK_GATE_SIM_FILL_POSITION_must_equal: 0,
    observation_day_increment_may_equal_1_only_after_new_day_evidence: true,
  },
  next_day_must_not_reuse_prior_accounting_day: '2026-06-04-rth',
  next_day_input_status: 'NOT_SELECTED_BY_THIS_TICKET',
  implementation_authorized_by_this_ticket: false,
  observation_day_eligible: false,
  observation_day_increment: 0,
};
const authorityCaveat: JsonRecord = {
  no_new_observation_day_credit: true,
  no_paper_runtime_invocation: true,
  no_STRAT_EVAL: true,
  no_CANDIDATE: true,
  no_ORDER_INTENT: true,
  no_order_translation: true,
  no_order_adapter: true,
  no_broker_adapter: true,
  no_paper_fill: true,
  no_qfa_410b_or_qfa_611: true,
  no_ACTIVE_STRATEGY_IDS_mutation: true,
  no_CANDIDATE_STRATEGY_IDS_mutation: true,
  no_broker_live_phase_6_authority: true,
};
const followups: JsonRecord = {
  recommended_next_ticket: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-NEXT-LOCAL-CAPTURE-DAY-SOURCE-READINESS-01',
  purpose: 'Identify the next locally available full RTH capture day after 2026-06-04 and run the proven source-readiness-to-accounting pipeline without broker/live authority.',
  alternate_if_operator_wants_broker_scope: 'V2-PF-C-LATE-AM-BROKER-PAPER-READINESS-SCOPE-01',
  broker_scope_caveat: 'Scope-only and no broker/live/Phase 6 authority by default.',
};

const records: JsonRecord[] = [
  {
    record_type: 'DAILY_CONTINUATION_ANCHORS',
    ticket,
    closure_report_path: closureReportPath,
    closure_report_lf_sha256: fileLfSha256(closureReportPath),
    accounting_report_path: accountingReportPath,
    accounting_report_lf_sha256: fileLfSha256(accountingReportPath),
    prior_accounting_record: accountingRecord,
  },
  { record_type: 'DAILY_CONTINUATION_CONTRACT', ticket, strategy_id: strategyId, continuation_contract: continuationContract },
  { record_type: 'DAILY_CONTINUATION_AUTHORITY_CAVEAT', ticket, authority_caveat: authorityCaveat },
  { record_type: 'DAILY_CONTINUATION_FOLLOWUPS', ticket, followups },
];
writeText(boundedPath, records.map((record) => stable(record)).join('\n') + '\n');

const report: Record<string, Json> = {
  ticket,
  substrate_sha: '9f042eb2cbc139fb37f8fcebdf02f6fb7f942355',
  determination: 'DAILY_CONTINUATION_READY_NEXT_DAY_CONTRACT_DEFINED',
  strategy_id: strategyId,
  anchors: {
    closure_report_path: closureReportPath,
    closure_report_lf_sha256: fileLfSha256(closureReportPath),
    accounting_report_path: accountingReportPath,
    accounting_report_lf_sha256: fileLfSha256(accountingReportPath),
    prior_observation_day: '2026-06-04-rth',
    prior_observation_day_increment: 1,
  },
  continuation_contract: continuationContract,
  authority_caveat: authorityCaveat,
  followups,
};
writeText(reportJsonPath, stable(report) + '\n');
report.output_hashes = {
  bounded_daily_continuation_jsonl: fileLfSha256(boundedPath),
  daily_continuation_report_json: fileLfSha256(reportJsonPath),
};
writeText(reportJsonPath, stable(report) + '\n');

const md = `# ${ticket}\n\n## Determination\n\n\`\`\`text\nDAILY_CONTINUATION_READY_NEXT_DAY_CONTRACT_DEFINED\n\`\`\`\n\nThis ticket defines the daily continuation contract after the first accounted paper-observation day. It does not add a second observation day.\n\n## Current progress\n\n| Field | Value |\n|---|---|\n| strategy_id | ${strategyId} |\n| completed paper-observation days | 1 |\n| minimum target | 1 / 45 |\n| preferred target | 1 / 60 |\n| remaining minimum days | 44 |\n| remaining preferred days | 59 |\n| prior accounted day | 2026-06-04-rth |\n\n## Next-day credit contract\n\n| Requirement | Value |\n|---|---|\n| full RTH session window | required |\n| accounting slots expected | 390 |\n| source-ready slots | 390 |\n| warmup excluded slots | must be reported |\n| source-backed snapshots ingested | must be reported |\n| paper runtime guard | stop-after-candidate |\n| STRAT_EVAL | positive |\n| CANDIDATE | allowed |\n| ORDER_INTENT | must remain 0 |\n| RANK/SIZING/RISK_GATE/SIM_FILL/POSITION | must remain 0 |\n| reuse 2026-06-04 day | forbidden |\n\n## Authority caveat\n\nNo new observation-day credit, paper runtime invocation, strategy markers, ORDER_INTENT, order translation, adapters, fills, qfa-410b/qfa-611, roster mutation, broker/live authority, or Phase 6 authority is created by this continuation contract.\n\n## Recommended next ticket\n\n\`\`\`text\nV2-PF-C-LATE-AM-PAPER-OBSERVATION-NEXT-LOCAL-CAPTURE-DAY-SOURCE-READINESS-01\n\`\`\`\n\nIf broker readiness is desired instead, use a separate scope-only ticket: \`V2-PF-C-LATE-AM-BROKER-PAPER-READINESS-SCOPE-01\`.\n\n## Output hashes\n\n| Output | LF SHA256 |\n|---|---|\n| bounded JSONL | ${fileLfSha256(boundedPath)} |\n| report JSON | ${fileLfSha256(reportJsonPath)} |\n`;
writeText(reportMdPath, md);

const memo = `# ${ticket} memo\n\n## Result\n\n\`DAILY_CONTINUATION_READY_NEXT_DAY_CONTRACT_DEFINED\`\n\nThe paper-observation lane has one accounted day from 2026-06-04. This continuation ticket defines the contract for future daily accrual without creating another observation-day increment.\n\n## Current progress\n\n- completed: 1/45 minimum and 1/60 preferred\n- remaining: 44 minimum days and 59 preferred days\n- prior accounted day: 2026-06-04-rth\n\n## Next-day contract\n\nThe next observation day must use a new RTH session, prove 390 source-ready accounting slots, report warmup exclusions and ingested source-backed snapshots, run the stop-after-candidate paper-runtime guard, keep ORDER_INTENT at 0, and preserve zero rank/sizing/risk/fill/position side effects.\n\n## Authority caveat\n\nThis ticket does not run paper runtime, emit strategy markers, award new day credit, or authorize broker/live/Phase 6/roster authority.\n\n## Recommended next ticket\n\n\`V2-PF-C-LATE-AM-PAPER-OBSERVATION-NEXT-LOCAL-CAPTURE-DAY-SOURCE-READINESS-01\`\n`;
writeText(memoPath, memo);

const backlogRow = `${ticket},P1,1.0,V2-PF-C-LATE-AM-PAPER-OBSERVATION-RESEARCH-CLOSURE-01,Define daily continuation contract after one accounted paper-observation day without adding new observation-day credit broker live Phase 6 roster or order authority,new_cycle4_v2_research_substrate`;
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
  completed_days: 1,
  progress_minimum: '1/45',
  progress_preferred: '1/60',
  observation_day_eligible: false,
  observation_day_increment: 0,
  recommended_next_ticket: followups.recommended_next_ticket,
  output_hashes: finalReport.output_hashes,
}, null, 2));
