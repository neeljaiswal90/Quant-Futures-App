import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };
const ticket = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-08-NO-CANDIDATE-ELIGIBLE-DISPOSITION-01';
const slug = 'v2-pf-c-late-am-paper-observation-2026-06-08-no-candidate-eligible-disposition-01';
const sourceReportPath = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-08-local-capture-source-readiness-01/local-capture-source-readiness-report.json';
const artifactDir = `artifacts/paper-observation/${slug}`;
const boundedPath = `${artifactDir}/bounded-no-candidate-eligible-disposition.jsonl`;
const reportJsonPath = `${artifactDir}/no-candidate-eligible-disposition-report.json`;
const reportMdPath = `${artifactDir}/no-candidate-eligible-disposition-report.md`;
const memoPath = `docs/research/${slug}-memo.md`;
const backlogPath = 'docs/plan/new_app_v1_ticket_backlog_v6.csv';
function stable(value: Json): string { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`; }
function writeText(path: string, text: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, 'utf8'); }
function lfSha256(text: string): string { return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex'); }
function fileLfSha256(path: string): string { return lfSha256(readFileSync(path, 'utf8')); }
function asRecord(value: unknown): JsonRecord { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object'); return value as JsonRecord; }
function num(record: JsonRecord, key: string): number { const value = record[key]; if (typeof value !== 'number') throw new Error(`expected numeric ${key}`); return value; }
const sourceReport = asRecord(JSON.parse(readFileSync(sourceReportPath, 'utf8')));
const sourceReadiness = asRecord(sourceReport.source_readiness);
const candidate = asRecord(sourceReport.candidate_feasibility);
if (String(sourceReport.determination) !== 'LOCAL_CAPTURE_SOURCE_READINESS_BLOCKED_NO_CANDIDATE_ELIGIBLE_NON_EXCLUDED_POINT') throw new Error('source report is not no-candidate blocked');
if (num(candidate, 'candidate_eligible_non_excluded_points') !== 0) throw new Error('expected zero candidate eligible non-excluded points');
const disposition: JsonRecord = {
  determination: 'NO_CANDIDATE_ELIGIBLE_DISPOSITION_NO_DAY_CREDIT',
  session_id: '2026-06-08-rth',
  source_complete: true,
  source_ready_slots: num(sourceReadiness, 'source_ready_slots'),
  feature_computable_slots: num(sourceReadiness, 'feature_computable_slots'),
  regime_label: String(candidate.regime_label),
  candidate_eligible_points: num(candidate, 'candidate_eligible_points'),
  candidate_eligible_non_excluded_points: num(candidate, 'candidate_eligible_non_excluded_points'),
  reason: 'SOURCE_COMPLETE_DAY_HAS_NO_CANDIDATE_ELIGIBLE_NON_EXCLUDED_POINT_FOR_THIS_VARIANT',
  observation_day_eligible: false,
  observation_day_increment: 0,
  may_reuse_for_day_credit_later: false,
};
const authority: JsonRecord = {
  paper_runtime_invoked: false,
  StrategyFeatureSnapshot_materialized: false,
  STRAT_EVAL: 0,
  CANDIDATE: 0,
  ORDER_INTENT: 0,
  observation_day_eligible: false,
  observation_day_increment: 0,
  qfa_410b_or_qfa_611_run: false,
  broker_live_phase_6_roster_authority: false,
};
const records: JsonRecord[] = [
  { record_type: 'NO_CANDIDATE_DISPOSITION_SOURCE_ANCHOR', ticket, source_report_path: sourceReportPath, source_report_lf_sha256: fileLfSha256(sourceReportPath), source_determination: String(sourceReport.determination) },
  { record_type: 'NO_CANDIDATE_DISPOSITION_DECISION', ticket, disposition, authority_caveat: authority },
];
writeText(boundedPath, records.map(stable).join('\n') + '\n');
const report: Record<string, Json> = {
  ticket,
  substrate_sha: '9c30a74392fd708141c89b0d6d958ec9d7ec9d72',
  determination: 'NO_CANDIDATE_ELIGIBLE_DISPOSITION_NO_DAY_CREDIT',
  source_anchor: { pr_337_merge_commit: '9c30a74392fd708141c89b0d6d958ec9d7ec9d72', source_report_path: sourceReportPath, source_report_lf_sha256: fileLfSha256(sourceReportPath) },
  disposition,
  authority_caveat: authority,
  recommended_next_ticket: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-WAIT-FOR-NEXT-FULL-LOCAL-CAPTURE-DAY-04',
};
writeText(reportJsonPath, stable(report) + '\n');
report.output_hashes = { bounded_no_candidate_eligible_disposition_jsonl: fileLfSha256(boundedPath), no_candidate_eligible_disposition_report_json: fileLfSha256(reportJsonPath) };
writeText(reportJsonPath, stable(report) + '\n');
const md = `# ${ticket}\n\n## Determination\n\n\`\`\`text\nNO_CANDIDATE_ELIGIBLE_DISPOSITION_NO_DAY_CREDIT\n\`\`\`\n\n2026-06-08 is source-complete but cannot count as a paper-observation day for this lane because no candidate-eligible non-excluded point exists.\n\n## Evidence\n\n| Field | Value |\n|---|---|\n| source_ready_slots | ${num(sourceReadiness, 'source_ready_slots')} |\n| feature_computable_slots | ${num(sourceReadiness, 'feature_computable_slots')} |\n| regime_label | ${String(candidate.regime_label)} |\n| candidate_eligible_points | ${num(candidate, 'candidate_eligible_points')} |\n| candidate_eligible_non_excluded_points | ${num(candidate, 'candidate_eligible_non_excluded_points')} |\n| observation_day_increment | 0 |\n\n## Authority caveat\n\nNo paper runtime, StrategyFeatureSnapshot, STRAT_EVAL, CANDIDATE, ORDER_INTENT, observation-day increment, qfa-410b/qfa-611, broker/live authority, Phase 6 authority, or roster mutation is created.\n\n## Recommended next ticket\n\n\`\`\`text\nV2-PF-C-LATE-AM-PAPER-OBSERVATION-WAIT-FOR-NEXT-FULL-LOCAL-CAPTURE-DAY-04\n\`\`\`\n\n## Output hashes\n\n| Output | LF SHA256 |\n|---|---|\n| bounded JSONL | ${fileLfSha256(boundedPath)} |\n| report JSON | ${fileLfSha256(reportJsonPath)} |\n`;
writeText(reportMdPath, md);
const memo = `# ${ticket} memo\n\n## Result\n\n\`NO_CANDIDATE_ELIGIBLE_DISPOSITION_NO_DAY_CREDIT\`\n\n2026-06-08 has full source readiness but no candidate-eligible non-excluded point for the registered-inactive variant. It does not increment paper-observation accounting. The count remains 1/45 and 1/60.\n\n## Boundary\n\nNo runtime, feature snapshot, strategy markers, observation-day increment, or broker/live/Phase 6/roster authority is created.\n`;
writeText(memoPath, memo);
const backlogRow = `${ticket},P1,1.0,V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-08-LOCAL-CAPTURE-SOURCE-READINESS-01,Disposition 2026-06-08 source-complete local capture as no candidate-eligible non-excluded point with no observation-day credit or authority,new_cycle4_v2_research_substrate`;
const backlog = readFileSync(backlogPath, 'utf8');
if (!backlog.includes(ticket)) writeFileSync(backlogPath, `${backlog.replace(/\s*$/, '')}\n${backlogRow}\n`, 'utf8');
const finalReport = JSON.parse(readFileSync(reportJsonPath, 'utf8')) as JsonRecord;
console.log(JSON.stringify({ state: 'PENDING_REVIEW', ticket, substrate_sha: finalReport.substrate_sha, determination: finalReport.determination, source_ready_slots: disposition.source_ready_slots, candidate_eligible_non_excluded_points: disposition.candidate_eligible_non_excluded_points, observation_day_increment: 0, recommended_next_ticket: finalReport.recommended_next_ticket, output_hashes: finalReport.output_hashes }, null, 2));
