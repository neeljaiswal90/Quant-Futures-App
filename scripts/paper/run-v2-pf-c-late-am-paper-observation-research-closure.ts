import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

const ticket = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-RESEARCH-CLOSURE-01';
const slug = 'v2-pf-c-late-am-paper-observation-research-closure-01';
const accountingReportPath = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-04-observation-day-accounting-impl-01/observation-day-accounting-impl-report.json';
const artifactDir = `artifacts/paper-observation/${slug}`;
const boundedPath = `${artifactDir}/bounded-research-closure.jsonl`;
const reportJsonPath = `${artifactDir}/research-closure-report.json`;
const reportMdPath = `${artifactDir}/research-closure-report.md`;
const memoPath = `docs/research/${slug}-memo.md`;
const backlogPath = 'docs/plan/new_app_v1_ticket_backlog_v6.csv';
const strategyId = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';

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

const accountingReport = asRecord(JSON.parse(readFileSync(accountingReportPath, 'utf8')));
const accountingRecord = asRecord(accountingReport.accounting_record);
const authorityCaveat = asRecord(accountingReport.authority_caveat);
const progress = asRecord(accountingReport.cumulative_progress);

if (String(accountingReport.determination) !== 'OBSERVATION_DAY_ACCOUNTING_IMPL_PASSED_INCREMENT_RECORDED') {
  throw new Error('accounting implementation anchor is not passed');
}
if (num(accountingRecord, 'observation_day_increment') !== 1) throw new Error('expected observation day increment 1');
if (num(accountingRecord, 'ORDER_INTENT_count') !== 0) throw new Error('expected ORDER_INTENT 0');
if (bool(authorityCaveat, 'authority_created') !== false) throw new Error('authority caveat violated');

const closureStatus: JsonRecord = {
  research_tree_status: 'CLOSED_WITH_ONE_ACCOUNTED_PAPER_OBSERVATION_DAY',
  determination: 'PAPER_OBSERVATION_RESEARCH_CLOSURE_COMPLETE_ONE_DAY_RECORDED',
  strategy_id: strategyId,
  registered_inactive_strategy_remains_inactive: true,
  observation_days_completed: num(progress, 'observation_days_completed'),
  minimum_trading_days_required: num(progress, 'minimum_trading_days_required'),
  preferred_trading_days_required: num(progress, 'preferred_trading_days_required'),
  progress_minimum: String(progress.progress_minimum),
  progress_preferred: String(progress.progress_preferred),
  remaining_minimum_days: num(progress, 'minimum_trading_days_required') - num(progress, 'observation_days_completed'),
  remaining_preferred_days: num(progress, 'preferred_trading_days_required') - num(progress, 'observation_days_completed'),
};
const chainSummary: JsonRecord = {
  source_readiness: '2026-06-04_LOCAL_CAPTURE_SOURCE_READY',
  feature_snapshot_builder: 'SOURCE_BACKED_CANDIDATE_ELIGIBLE_SNAPSHOT_EMITTED',
  strat_eval_smoke: 'STRAT_EVAL_AND_CANDIDATE_EMITTED_ORDER_INTENT_SUPPRESSED',
  paper_runtime_candidate_smoke: 'PASSED_STOP_AFTER_CANDIDATE',
  full_session_runtime_impl: 'PASSED_CANDIDATE_ONLY_GUARD_OVER_FULL_RTH_WINDOW',
  observation_day_accounting: 'ONE_DAY_RECORDED',
};
const authorityBoundary: JsonRecord = {
  broker_scope_authorized: false,
  live_trading_authorized: false,
  phase_6_authorized: false,
  order_intent_authorized: false,
  order_translation_authorized: false,
  order_adapter_authorized: false,
  broker_adapter_authorized: false,
  paper_fill_authorized: false,
  qfa_410b_or_qfa_611_authorized: false,
  active_roster_mutation_authorized: false,
  candidate_roster_mutation_authorized: false,
  broker_work_status: 'NOT_AUTHORIZED_BY_THIS_RESEARCH_CLOSURE_USE_SEPARATE_SCOPE_TICKET_ONLY',
};
const recommendedFollowups: JsonRecord = {
  continue_paper_observation_ticket: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-DAILY-CONTINUATION-01',
  purpose: 'Accrue remaining paper-observation days using the proven 2026-06-04 accounting contract without broker/live authority.',
  broker_scope_ticket_if_needed: 'V2-PF-C-LATE-AM-BROKER-PAPER-READINESS-SCOPE-01',
  broker_scope_caveat: 'Scope-only; no broker/live/Phase 6 authority until separately approved.',
};

const records: JsonRecord[] = [
  {
    record_type: 'RESEARCH_CLOSURE_ACCOUNTING_ANCHOR',
    ticket,
    accounting_report_path: accountingReportPath,
    accounting_report_lf_sha256: fileLfSha256(accountingReportPath),
    accounting_determination: String(accountingReport.determination),
    accounting_record: accountingRecord,
  },
  { record_type: 'RESEARCH_CLOSURE_STATUS', ticket, closure_status: closureStatus, chain_summary: chainSummary },
  { record_type: 'RESEARCH_CLOSURE_AUTHORITY_BOUNDARY', ticket, authority_boundary: authorityBoundary },
  { record_type: 'RESEARCH_CLOSURE_RECOMMENDED_FOLLOWUPS', ticket, recommended_followups: recommendedFollowups },
];
writeText(boundedPath, records.map((record) => stable(record)).join('\n') + '\n');

const report: Record<string, Json> = {
  ticket,
  substrate_sha: 'b0eb07c1ff067809138febf1ed7d7fcbce37b150',
  determination: 'PAPER_OBSERVATION_RESEARCH_CLOSURE_COMPLETE_ONE_DAY_RECORDED',
  accounting_anchor: {
    pr_330_merge_commit: 'b0eb07c1ff067809138febf1ed7d7fcbce37b150',
    accounting_report_path: accountingReportPath,
    accounting_report_lf_sha256: fileLfSha256(accountingReportPath),
    accounting_determination: String(accountingReport.determination),
  },
  closure_status: closureStatus,
  chain_summary: chainSummary,
  authority_boundary: authorityBoundary,
  recommended_followups: recommendedFollowups,
};
writeText(reportJsonPath, stable(report) + '\n');
report.output_hashes = {
  bounded_research_closure_jsonl: fileLfSha256(boundedPath),
  research_closure_report_json: fileLfSha256(reportJsonPath),
};
writeText(reportJsonPath, stable(report) + '\n');

const md = `# ${ticket}\n\n## Determination\n\n\`\`\`text\nPAPER_OBSERVATION_RESEARCH_CLOSURE_COMPLETE_ONE_DAY_RECORDED\n\`\`\`\n\nThe v2 late-AM paper-observation research tree is closed with one bounded research observation day recorded and no broker/live authority created.\n\n## Accounting status\n\n| Field | Value |\n|---|---|\n| strategy_id | ${strategyId} |\n| observation_days_completed | ${num(progress, 'observation_days_completed')} |\n| minimum target | ${String(progress.progress_minimum)} |\n| preferred target | ${String(progress.progress_preferred)} |\n| remaining minimum days | ${num(progress, 'minimum_trading_days_required') - num(progress, 'observation_days_completed')} |\n| remaining preferred days | ${num(progress, 'preferred_trading_days_required') - num(progress, 'observation_days_completed')} |\n\n## Evidence chain\n\n| Stage | Status |\n|---|---|\n| source readiness | 2026-06-04 local capture source ready |\n| feature snapshot builder | source-backed candidate-eligible snapshot emitted |\n| strat-eval smoke | STRAT_EVAL and CANDIDATE emitted, ORDER_INTENT suppressed |\n| paper-runtime candidate smoke | stop-after-candidate guard passed |\n| full-session runtime | full RTH window passed candidate-only guard |\n| observation-day accounting | one day recorded |\n\n## Authority boundary\n\nNo broker scope, live trading, Phase 6, ORDER_INTENT, order translation, order adapter, broker adapter, paper fill, qfa-410b/qfa-611, active roster mutation, or candidate roster mutation is authorized by this closure.\n\n## Recommended follow-ups\n\n| Ticket | Purpose |\n|---|---|\n| V2-PF-C-LATE-AM-PAPER-OBSERVATION-DAILY-CONTINUATION-01 | Continue accruing paper-observation days using the proven accounting contract. |\n| V2-PF-C-LATE-AM-BROKER-PAPER-READINESS-SCOPE-01 | Scope-only broker paper readiness if desired; no authority by this closure. |\n\n## Output hashes\n\n| Output | LF SHA256 |\n|---|---|\n| bounded JSONL | ${fileLfSha256(boundedPath)} |\n| report JSON | ${fileLfSha256(reportJsonPath)} |\n`;
writeText(reportMdPath, md);

const memo = `# ${ticket} memo\n\n## Closure\n\n\`PAPER_OBSERVATION_RESEARCH_CLOSURE_COMPLETE_ONE_DAY_RECORDED\`\n\nThe chain from 2026-06-04 source readiness through candidate-only full-session paper runtime and observation-day accounting is closed. One paper-observation research day is recorded.\n\n## Current status\n\n- strategy: \`${strategyId}\`\n- observation progress: ${String(progress.progress_minimum)} minimum and ${String(progress.progress_preferred)} preferred\n- remaining minimum days: ${num(progress, 'minimum_trading_days_required') - num(progress, 'observation_days_completed')}\n- remaining preferred days: ${num(progress, 'preferred_trading_days_required') - num(progress, 'observation_days_completed')}\n\n## Boundary\n\nThis closure does not authorize broker/live work, Phase 6, order intent, order translation, adapters, paper fills, qfa-410b/qfa-611, active roster mutation, or candidate roster mutation. Broker work, if desired, must start as a separate scope-only ticket.\n\n## Recommended next work\n\n- \`V2-PF-C-LATE-AM-PAPER-OBSERVATION-DAILY-CONTINUATION-01\` for continuing the 45/60-day paper-observation count.\n- \`V2-PF-C-LATE-AM-BROKER-PAPER-READINESS-SCOPE-01\` only if a broker-readiness scope is desired, with no authority by default.\n`;
writeText(memoPath, memo);

const backlogRow = `${ticket},P1,1.0,V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-OBSERVATION-DAY-ACCOUNTING-IMPL-01,Close the v2 late-AM paper-observation research tree with one accounted paper-observation day and explicit no broker live Phase 6 roster or order authority,new_cycle4_v2_research_substrate`;
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
  observation_days_completed: num(progress, 'observation_days_completed'),
  progress_minimum: String(progress.progress_minimum),
  progress_preferred: String(progress.progress_preferred),
  authority_created: false,
  recommended_followups: finalReport.recommended_followups,
  output_hashes: finalReport.output_hashes,
}, null, 2));
