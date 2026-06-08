import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };
const ticket = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-WAIT-FOR-NEXT-FULL-LOCAL-CAPTURE-DAY-04';
const slug = 'v2-pf-c-late-am-paper-observation-wait-for-next-full-local-capture-day-04';
const priorReportPath = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-08-no-candidate-eligible-disposition-01/no-candidate-eligible-disposition-report.json';
const captureRoot = 'D:/Quant-futures-app/tools/rithmic_analytics/data/captures';
const artifactDir = `artifacts/paper-observation/${slug}`;
const boundedPath = `${artifactDir}/bounded-wait-for-next-full-local-capture-day.jsonl`;
const reportJsonPath = `${artifactDir}/wait-for-next-full-local-capture-day-report.json`;
const reportMdPath = `${artifactDir}/wait-for-next-full-local-capture-day-report.md`;
const memoPath = `docs/research/${slug}-memo.md`;
const backlogPath = 'docs/plan/new_app_v1_ticket_backlog_v6.csv';
function stable(value: Json): string { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`; }
function writeText(path: string, text: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, 'utf8'); }
function lfSha256(text: string): string { return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex'); }
function fileLfSha256(path: string): string { return lfSha256(readFileSync(path, 'utf8')); }
function nsToDate(ns: string): Date { return new Date(Number(BigInt(ns) / 1000000n)); }
function day(d: Date): string { return d.toISOString().slice(0, 10); }
function minute(d: Date): number { return d.getUTCHours() * 60 + d.getUTCMinutes(); }
async function scan(file: string): Promise<JsonRecord> {
  const slotsByDay = new Map<string, Set<number>>(); let total = 0; let min = ''; let max = ''; const st = statSync(file);
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue; total++; let rec: any; try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== 'TRADE' || !rec.ts_ns) continue;
    const d = nsToDate(String(rec.ts_ns)); const iso = d.toISOString(); if (!min || iso < min) min = iso; if (!max || iso > max) max = iso;
    const m = minute(d); if (m >= 810 && m < 1200) { const key = day(d); if (!slotsByDay.has(key)) slotsByDay.set(key, new Set()); slotsByDay.get(key)!.add(m); }
  }
  return { file, file_size_bytes: st.size, last_write_utc: st.mtime.toISOString(), total_records_scanned: total, source_time_min_utc: min, source_time_max_utc: max, rth_trade_slot_coverage: [...slotsByDay.entries()].map(([session_date, slots]) => ({ session_date, rth_trade_slots_present: slots.size, rth_trade_slots_missing: 390 - slots.size })).filter((x: any) => x.rth_trade_slots_present > 0) };
}
const files = readdirSync(captureRoot).flatMap((dir) => { const f = join(captureRoot, dir, 'MNQ_globex.obs01.jsonl').replace(/\\/g, '/'); return existsSync(f) ? [f] : []; });
const priorReport = JSON.parse(readFileSync(priorReportPath, 'utf8')) as JsonRecord;
const scans = await Promise.all(files.map(scan));
const allCoverage: JsonRecord[] = scans.flatMap((scan) => (scan.rth_trade_slot_coverage as Json[]).map((entry) => ({ ...(entry as JsonRecord), source_file: String(scan.file), source_file_last_write_utc: String(scan.last_write_utc) })));
const postPrior = allCoverage.filter((entry) => String(entry.session_date) > '2026-06-08');
const full = postPrior.filter((entry) => Number(entry.rth_trade_slots_present) === 390);
const latestAny = allCoverage.sort((a, b) => String(a.session_date).localeCompare(String(b.session_date)) || String(a.source_file).localeCompare(String(b.source_file))).at(-1) ?? null;
const determination = full.length > 0 ? 'WAIT_FOR_NEXT_FULL_LOCAL_CAPTURE_DAY_READY_TO_RESUME' : 'WAIT_FOR_NEXT_FULL_LOCAL_CAPTURE_DAY_STILL_WAITING';
const waitStatus: JsonRecord = { determination, prior_no_candidate_report_path: priorReportPath, prior_progress_minimum: '1/45', prior_progress_preferred: '1/60', prior_disposition_day: '2026-06-08-rth', full_post_prior_capture_day_available: full.length > 0, post_prior_candidates: postPrior, latest_any_rth_candidate: latestAny, resume_ticket_if_ready: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-NEXT-DAY-FEATURE-SNAPSHOT-BUILDER-IMPL-01', next_wait_ticket_if_blocked: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-WAIT-FOR-NEXT-FULL-LOCAL-CAPTURE-DAY-05', interpretation: full.length > 0 ? 'A post-2026-06-08 full RTH local capture day is available.' : 'No post-2026-06-08 full RTH local capture day is available in the scanned local source set.' };
const authorityCaveat: JsonRecord = { paper_runtime_invoked: false, StrategyFeatureSnapshot_materialized: false, STRAT_EVAL: 0, CANDIDATE: 0, ORDER_INTENT: 0, observation_day_eligible: false, observation_day_increment: 0, qfa_410b_or_qfa_611_run: false, broker_live_phase_6_roster_authority: false };
const records: JsonRecord[] = [
  { record_type: 'WAIT_FOR_NEXT_FULL_LOCAL_CAPTURE_DAY_ANCHOR', ticket, prior_report_path: priorReportPath, prior_report_lf_sha256: fileLfSha256(priorReportPath), prior_determination: String(priorReport.determination) },
  { record_type: 'WAIT_FOR_NEXT_FULL_LOCAL_CAPTURE_DAY_SCAN', ticket, scans },
  { record_type: 'WAIT_FOR_NEXT_FULL_LOCAL_CAPTURE_DAY_STATUS', ticket, wait_status: waitStatus, authority_caveat: authorityCaveat },
];
writeText(boundedPath, records.map(stable).join('\n') + '\n');
const report: Record<string, Json> = { ticket, substrate_sha: 'f66d4fddd830d9137c6ee3fbdb449ae69d7d8815', determination, wait_status: waitStatus, scans, authority_caveat: authorityCaveat };
writeText(reportJsonPath, stable(report) + '\n');
report.output_hashes = { bounded_wait_for_next_full_local_capture_day_jsonl: fileLfSha256(boundedPath), wait_for_next_full_local_capture_day_report_json: fileLfSha256(reportJsonPath) };
writeText(reportJsonPath, stable(report) + '\n');
const rows = postPrior.length ? postPrior.map((entry) => `| ${entry.session_date} | ${entry.rth_trade_slots_present} | ${entry.rth_trade_slots_missing} | ${entry.source_file_last_write_utc} | ${entry.source_file} |`).join('\n') : '| none | 0 | 390 | n/a | n/a |';
const md = `# ${ticket}\n\n## Determination\n\n\`\`\`text\n${determination}\n\`\`\`\n\nThe paper-observation count remains 1/45 minimum and 1/60 preferred.\n\n## Post-2026-06-08 candidates\n\n| Session date | RTH trade slots present | Missing | Source last write UTC | Source file |\n|---|---:|---:|---|---|\n${rows}\n\n## Latest known RTH candidate\n\n\`\`\`json\n${JSON.stringify(latestAny, null, 2)}\n\`\`\`\n\n## Status\n\n${String(waitStatus.interpretation)}\n\n## Authority caveat\n\nNo paper runtime, StrategyFeatureSnapshot, STRAT_EVAL, CANDIDATE, ORDER_INTENT, observation-day increment, qfa-410b/qfa-611, broker/live authority, Phase 6 authority, or roster mutation is created.\n\n## Recommended next ticket\n\n\`\`\`text\n${String(full.length > 0 ? waitStatus.resume_ticket_if_ready : waitStatus.next_wait_ticket_if_blocked)}\n\`\`\`\n\n## Output hashes\n\n| Output | LF SHA256 |\n|---|---|\n| bounded JSONL | ${fileLfSha256(boundedPath)} |\n| report JSON | ${fileLfSha256(reportJsonPath)} |\n`;
writeText(reportMdPath, md);
const memo = `# ${ticket} memo\n\n## Result\n\n\`${determination}\`\n\nNo post-2026-06-08 full local RTH capture day is available in the scanned local source set. The count remains 1/45 and 1/60.\n\n## Boundary\n\nNo runtime, feature snapshot, strategy markers, observation-day increment, or broker/live/Phase 6/roster authority is created.\n`;
writeText(memoPath, memo);
const backlogRow = `${ticket},P1,1.0,V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-08-NO-CANDIDATE-ELIGIBLE-DISPOSITION-01,Wait and scan for the next post-2026-06-08 full local RTH capture day before additional paper-observation accrual without runtime markers or authority,new_cycle4_v2_research_substrate`;
const backlog = readFileSync(backlogPath, 'utf8');
if (!backlog.includes(ticket)) writeFileSync(backlogPath, `${backlog.replace(/\s*$/, '')}\n${backlogRow}\n`, 'utf8');
const finalReport = JSON.parse(readFileSync(reportJsonPath, 'utf8')) as JsonRecord;
console.log(JSON.stringify({ state: 'PENDING_REVIEW', ticket, substrate_sha: finalReport.substrate_sha, determination, progress: '1/45 and 1/60', full_post_prior_capture_day_available: full.length > 0, post_prior_candidates: postPrior, latest_any_rth_candidate: latestAny, observation_day_increment: 0, recommended_next_ticket: full.length > 0 ? waitStatus.resume_ticket_if_ready : waitStatus.next_wait_ticket_if_blocked, output_hashes: finalReport.output_hashes }, null, 2));
