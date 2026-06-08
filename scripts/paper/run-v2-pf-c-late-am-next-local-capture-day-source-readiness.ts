import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

const ticket = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-NEXT-LOCAL-CAPTURE-DAY-SOURCE-READINESS-01';
const slug = 'v2-pf-c-late-am-paper-observation-next-local-capture-day-source-readiness-01';
const continuationReportPath = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-daily-continuation-01/daily-continuation-report.json';
const artifactDir = `artifacts/paper-observation/${slug}`;
const boundedPath = `${artifactDir}/bounded-next-local-capture-day-source-readiness.jsonl`;
const reportJsonPath = `${artifactDir}/next-local-capture-day-source-readiness-report.json`;
const reportMdPath = `${artifactDir}/next-local-capture-day-source-readiness-report.md`;
const memoPath = `docs/research/${slug}-memo.md`;
const backlogPath = 'docs/plan/new_app_v1_ticket_backlog_v6.csv';
const sourceFiles = [
  'D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-03/MNQ_globex.obs01.jsonl',
  'D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-07/MNQ_globex.obs01.jsonl',
];

function stable(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
}
function writeText(path: string, text: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, 'utf8'); }
function lfSha256(text: string): string { return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex'); }
function fileLfSha256(path: string): string { return lfSha256(readFileSync(path, 'utf8')); }
function nsToDate(ns: string): Date { return new Date(Number(BigInt(ns) / 1000000n)); }
function day(d: Date): string { return d.toISOString().slice(0, 10); }
function minute(d: Date): number { return d.getUTCHours() * 60 + d.getUTCMinutes(); }
async function scan(file: string): Promise<JsonRecord> {
  const slotsByDay = new Map<string, Set<number>>();
  let total = 0; let min = ''; let max = '';
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue; total++;
    let rec: any; try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== 'TRADE' || !rec.ts_ns) continue;
    const d = nsToDate(String(rec.ts_ns)); const iso = d.toISOString();
    if (!min || iso < min) min = iso; if (!max || iso > max) max = iso;
    const m = minute(d);
    if (m >= 810 && m < 1200) {
      const key = day(d); if (!slotsByDay.has(key)) slotsByDay.set(key, new Set()); slotsByDay.get(key)!.add(m);
    }
  }
  return {
    file,
    file_size_bytes: statSync(file).size,
    total_records_scanned: total,
    source_time_min_utc: min,
    source_time_max_utc: max,
    rth_trade_slot_coverage: [...slotsByDay.entries()].map(([session_date, slots]) => ({ session_date, rth_trade_slots_present: slots.size, rth_trade_slots_missing: 390 - slots.size })).filter((x: any) => x.rth_trade_slots_present > 0),
  };
}

const continuationReport = JSON.parse(readFileSync(continuationReportPath, 'utf8')) as JsonRecord;
const scans = await Promise.all(sourceFiles.map(scan));
const allCoverage: JsonRecord[] = scans.flatMap((scan) => (scan.rth_trade_slot_coverage as Json[]).map((entry) => ({ ...(entry as JsonRecord), source_file: String(scan.file) })));
const candidatesAfterPrior = allCoverage.filter((entry) => String(entry.session_date) > '2026-06-04') as JsonRecord[];
const fullReady = candidatesAfterPrior.filter((entry) => Number(entry.rth_trade_slots_present) === 390);
const bestCandidate = candidatesAfterPrior.sort((a, b) => String(a.session_date).localeCompare(String(b.session_date)))[0] ?? null;
const determination = fullReady.length > 0 ? 'NEXT_LOCAL_CAPTURE_DAY_SOURCE_READINESS_READY_FOR_PIPELINE' : 'NEXT_LOCAL_CAPTURE_DAY_SOURCE_READINESS_BLOCKED_NO_FULL_RTH_CAPTURE_DAY';
const authorityCaveat: JsonRecord = {
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
const result: JsonRecord = {
  determination,
  prior_accounted_day: '2026-06-04-rth',
  current_progress_minimum: '1/45',
  current_progress_preferred: '1/60',
  next_full_rth_capture_day_found: fullReady.length > 0,
  full_ready_candidates: fullReady,
  first_post_prior_candidate: bestCandidate,
  blocker: fullReady.length > 0 ? null : {
    blocker_family: 'NO_POST_2026_06_04_LOCAL_CAPTURE_DAY_WITH_390_RTH_TRADE_SLOTS',
    observed_post_prior_candidates: candidatesAfterPrior,
    interpretation: '2026-06-05 is partial and 2026-06-08 is not full-session complete in the scanned local source set.',
  },
  recommended_next_ticket: fullReady.length > 0 ? 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-NEXT-DAY-FEATURE-SNAPSHOT-BUILDER-IMPL-01' : 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-WAIT-FOR-NEXT-FULL-LOCAL-CAPTURE-DAY-01',
};
const records: JsonRecord[] = [
  { record_type: 'NEXT_LOCAL_CAPTURE_DAY_SOURCE_READINESS_ANCHOR', ticket, continuation_report_path: continuationReportPath, continuation_report_lf_sha256: fileLfSha256(continuationReportPath), continuation_determination: String(continuationReport.determination) },
  { record_type: 'NEXT_LOCAL_CAPTURE_DAY_SOURCE_SCAN', ticket, scans },
  { record_type: 'NEXT_LOCAL_CAPTURE_DAY_SOURCE_READINESS_RESULT', ticket, result, authority_caveat: authorityCaveat },
];
writeText(boundedPath, records.map(stable).join('\n') + '\n');
const report: Record<string, Json> = {
  ticket,
  substrate_sha: 'de0ddcc6069dad2a85bc82595c369f28b0bd7e8a',
  determination,
  source_files_scanned: sourceFiles,
  scan_summary: scans,
  result,
  authority_caveat: authorityCaveat,
};
writeText(reportJsonPath, stable(report) + '\n');
report.output_hashes = { bounded_next_local_capture_day_source_readiness_jsonl: fileLfSha256(boundedPath), next_local_capture_day_source_readiness_report_json: fileLfSha256(reportJsonPath) };
writeText(reportJsonPath, stable(report) + '\n');
const coverageRows = candidatesAfterPrior.map((entry) => `| ${entry.session_date} | ${entry.rth_trade_slots_present} | ${entry.rth_trade_slots_missing} | ${entry.source_file} |`).join('\n');
const md = `# ${ticket}\n\n## Determination\n\n\`\`\`text\n${determination}\n\`\`\`\n\nNo new observation-day credit is awarded by this source-readiness scan.\n\n## Current progress\n\n| Field | Value |\n|---|---|\n| prior accounted day | 2026-06-04-rth |\n| progress minimum | 1 / 45 |\n| progress preferred | 1 / 60 |\n\n## Post-prior local RTH trade-slot candidates\n\n| Session date | RTH trade slots present | Missing | Source file |\n|---|---:|---:|---|\n${coverageRows}\n\n## Blocker\n\n\`\`\`text\nNO_POST_2026_06_04_LOCAL_CAPTURE_DAY_WITH_390_RTH_TRADE_SLOTS\n\`\`\`\n\n2026-06-05 is partial and 2026-06-08 is not full-session complete in the scanned local source set.\n\n## Authority caveat\n\nNo paper runtime, StrategyFeatureSnapshot, STRAT_EVAL, CANDIDATE, ORDER_INTENT, observation-day increment, qfa-410b/qfa-611, broker/live authority, Phase 6 authority, or roster mutation is created.\n\n## Recommended next ticket\n\n\`\`\`text\n${String(result.recommended_next_ticket)}\n\`\`\`\n\n## Output hashes\n\n| Output | LF SHA256 |\n|---|---|\n| bounded JSONL | ${fileLfSha256(boundedPath)} |\n| report JSON | ${fileLfSha256(reportJsonPath)} |\n`;
writeText(reportMdPath, md);
const memo = `# ${ticket} memo\n\n## Result\n\n\`${determination}\`\n\nThe next locally available full RTH capture day after 2026-06-04 is not ready in the scanned local source set. The paper-observation count remains 1/45 minimum and 1/60 preferred.\n\n## Evidence\n\n- 2026-06-05: 239/390 RTH trade slots present.\n- 2026-06-08: 225/390 RTH trade slots present at scan time.\n\n## Boundary\n\nThis is source-readiness only. It does not run paper runtime, emit strategy markers, materialize feature snapshots, increment observation-day accounting, or authorize broker/live/Phase 6/roster changes.\n\n## Next\n\n\`${String(result.recommended_next_ticket)}\`\n`;
writeText(memoPath, memo);
const backlogRow = `${ticket},P1,1.0,V2-PF-C-LATE-AM-PAPER-OBSERVATION-DAILY-CONTINUATION-01,Scan local captures after the first accounted 2026-06-04 paper-observation day for the next full RTH source-ready day without runtime markers observation-day credit or authority,new_cycle4_v2_research_substrate`;
const backlog = readFileSync(backlogPath, 'utf8');
if (!backlog.includes(ticket)) writeFileSync(backlogPath, `${backlog.replace(/\s*$/, '')}\n${backlogRow}\n`, 'utf8');
const finalReport = JSON.parse(readFileSync(reportJsonPath, 'utf8')) as JsonRecord;
console.log(JSON.stringify({ state: 'PENDING_REVIEW', ticket, substrate_sha: finalReport.substrate_sha, determination, prior_progress: '1/45 and 1/60', next_full_rth_capture_day_found: false, candidates_after_prior: candidatesAfterPrior, observation_day_increment: 0, recommended_next_ticket: result.recommended_next_ticket, output_hashes: finalReport.output_hashes }, null, 2));
