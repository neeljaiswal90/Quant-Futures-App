import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-PAPER-RUNTIME-OBSERVATION-DAY-SCOPE-01';
const SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-02-paper-runtime-observation-day-scope-01';
const SUBSTRATE_SHA = 'e443b29dace9c8195334d885a17d5d5a70a8f824';
const DETERMINATION = 'OBSERVATION_DAY_SCOPE_BLOCKED_REQUIRES_FULL_SESSION_RUNTIME';
const NEXT_TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FULL-SESSION-RUNTIME-SCOPE-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const FEATURE_SNAPSHOT_ID = 'feature-v2pf-20260602-1780427100000000000';
const TARGET_TS_UTC = '2026-06-02T19:05:00.000000000Z';
const TARGET_TS_NS = '1780427100000000000';

const OUT_DIR = path.join(ROOT, 'artifacts', 'paper-observation', SLUG);
const BOUNDED_JSONL = path.join(OUT_DIR, 'bounded-paper-runtime-observation-day-scope.jsonl');
const REPORT_JSON = path.join(OUT_DIR, 'paper-runtime-observation-day-scope-report.json');
const REPORT_MD = path.join(OUT_DIR, 'paper-runtime-observation-day-scope-report.md');
const MEMO_MD = path.join(ROOT, 'docs', 'research', `${SLUG}-memo.md`);
const BACKLOG_CSV = path.join(ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');

const SOURCE_REPORTS = [
  {
    pr: 311,
    label: 'candidate_eligible_source_backed_snapshot',
    path: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-candidate-eligible-snapshot-builder-impl-01/candidate-eligible-snapshot-builder-report.json',
  },
  {
    pr: 312,
    label: 'candidate_strat_eval_smoke',
    path: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-candidate-strat-eval-smoke-01/candidate-strat-eval-smoke-report.json',
  },
  {
    pr: 313,
    label: 'paper_runtime_candidate_smoke_scope',
    path: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-paper-runtime-candidate-smoke-scope-01/paper-runtime-candidate-smoke-scope-report.json',
  },
  {
    pr: 314,
    label: 'paper_runtime_candidate_smoke_impl',
    path: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-paper-runtime-candidate-smoke-impl-01/paper-runtime-candidate-smoke-impl-report.json',
  },
] as const;

type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json };
type JsonRecord = { readonly [key: string]: Json };

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

function parseJsonFile(filePath: string): JsonRecord {
  return JSON.parse(readText(filePath)) as JsonRecord;
}

function numberField(source: JsonRecord, directKey: string, countsKey: string): number {
  const direct = source[directKey];
  if (typeof direct === 'number') {
    return direct;
  }
  const counts = source.counts;
  if (counts !== null && typeof counts === 'object' && !Array.isArray(counts)) {
    const value = counts[countsKey];
    if (typeof value === 'number') {
      return value;
    }
  }
  throw new Error(`Missing numeric field ${directKey} / counts.${countsKey}`);
}

function appendBacklogRow(): void {
  const row = [
    TICKET,
    'P1',
    '1.0',
    'V2-PF-C-LATE-AM-PAPER-OBSERVATION-PAPER-RUNTIME-ACCOUNTING-01',
    'Scope whether bounded 2026-06-02 paper-runtime candidate smoke evidence can count as an observation day and define the minimum full-session evidence contract without order broker live Phase 6 roster or observation-credit authority',
    'new_cycle4_v2_research_substrate',
  ].join(',');
  const current = readText(BACKLOG_CSV);
  if (!current.includes(`${TICKET},`)) {
    writeFileSync(BACKLOG_CSV, `${current.trimEnd()}\n${row}\n`, 'utf8');
  }
}

function main(): void {
  ensureDir(OUT_DIR);

  const sourceAnchors: Json[] = SOURCE_REPORTS.map((source) => {
    const absolutePath = path.join(ROOT, source.path);
    if (!existsSync(absolutePath)) {
      throw new Error(`Missing source report: ${source.path}`);
    }
    return {
      pr: source.pr,
      label: source.label,
      path: source.path,
      lf_sha256: sha256FileLf(absolutePath),
      size_bytes: statSync(absolutePath).size,
    };
  });

  const pr314ReportPath = path.join(ROOT, SOURCE_REPORTS[3].path);
  const pr314 = parseJsonFile(pr314ReportPath);
  const stratEvalCount = numberField(pr314, 'STRAT_EVAL_count', 'STRAT_EVAL');
  const candidateCount = numberField(pr314, 'CANDIDATE_count', 'CANDIDATE');
  const orderIntentCount = numberField(pr314, 'ORDER_INTENT_count', 'ORDER_INTENT');

  if (stratEvalCount !== 1 || candidateCount !== 1 || orderIntentCount !== 0) {
    throw new Error(`Unexpected PR #314 counts: STRAT_EVAL=${stratEvalCount} CANDIDATE=${candidateCount} ORDER_INTENT=${orderIntentCount}`);
  }

  const candidateOnlyEvidence: JsonRecord = {
    source_backed_snapshot: true,
    paper_runtime_invoked: true,
    strategy_id: STRATEGY_ID,
    feature_snapshot_id: FEATURE_SNAPSHOT_ID,
    target_timestamp_ns: TARGET_TS_NS,
    target_timestamp_utc: TARGET_TS_UTC,
    STRAT_EVAL_count: stratEvalCount,
    CANDIDATE_count: candidateCount,
    ORDER_INTENT_count: orderIntentCount,
    paper_observation_stop_after_candidate: true,
    candidate_only_day_credit_rejected: true,
  };

  const evidenceContract: JsonRecord = {
    observation_day_increment_may_become_1_only_after: 'FULL_SESSION_PAPER_RUNTIME_ACCOUNTING_EVIDENCE',
    candidate_only_smoke_sufficient_for_day_credit: false,
    full_session_runtime_manifest_required: true,
    explicit_observation_window_required: true,
    minimum_observation_window_basis: 'configured paper observation session/window, not one source-backed snapshot',
    source_backed_feature_snapshots_required_for_window: true,
    strategy_runtime_markers_required: true,
    required_marker_minimum: 'STRAT_EVAL evidence across the declared observation window plus candidate/order suppression accounting',
    candidate_marker_allowed: true,
    order_intent_required_for_observation_day_credit: false,
    order_path_simulation_required_by_this_scope: false,
    order_translation_must_remain_suppressed_until_separately_authorized: true,
    adapter_or_broker_invocation_allowed: false,
    paper_fill_allowed: false,
    qfa_410b_or_qfa_611_required: false,
    qfa_410b_or_qfa_611_allowed: false,
    active_candidate_roster_mutation_allowed: false,
    broker_live_phase6_authority_allowed: false,
  };

  const authorityLocks: JsonRecord = {
    observation_day_eligible: false,
    observation_day_increment: 0,
    implementation_authorized_by_this_ticket: false,
    ORDER_INTENT_authorized: false,
    order_translation_authorized: false,
    order_adapter_authorized: false,
    broker_adapter_authorized: false,
    paper_fill_authorized: false,
    broker_live_authorized: false,
    phase_6_authorized: false,
    active_candidate_roster_mutation_authorized: false,
    qfa_410b_or_qfa_611_authorized: false,
  };

  const boundedRecords: Json[] = [
    {
      record_type: 'SOURCE_CHAIN_ANCHORS',
      ticket: TICKET,
      substrate_sha: SUBSTRATE_SHA,
      source_anchors: sourceAnchors,
    },
    {
      record_type: 'OBSERVATION_DAY_SCOPE_DECISION',
      ticket: TICKET,
      determination: DETERMINATION,
      candidate_only_evidence: candidateOnlyEvidence,
      evidence_contract: evidenceContract,
      authority_locks: authorityLocks,
    },
  ];
  writeFileSync(BOUNDED_JSONL, stableJsonl(boundedRecords), 'utf8');

  const report: JsonRecord = {
    ticket: TICKET,
    determination: DETERMINATION,
    substrate_sha: SUBSTRATE_SHA,
    source_anchors: sourceAnchors,
    candidate_only_evidence: candidateOnlyEvidence,
    evidence_contract: evidenceContract,
    authority_locks: authorityLocks,
    decision_summary:
      'The bounded 2026-06-02 candidate smoke proves source-backed paper-runtime candidate plumbing, but it is a single-snapshot control proof and does not satisfy an observation-day unit. Observation-day increment remains 0 until a full-session/window paper-runtime accounting artifact is scoped and produced.',
    recommended_next_ticket: NEXT_TICKET,
    bounded_artifact_size_bytes: statSync(BOUNDED_JSONL).size,
  };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  const boundedSha = sha256FileLf(BOUNDED_JSONL);
  const reportSha = sha256FileLf(REPORT_JSON);

  const md = [
    `# ${TICKET}`,
    '',
    `Determination: \`${DETERMINATION}\``,
    '',
    '## Decision',
    '',
    'The bounded 2026-06-02 paper-runtime candidate smoke does not count as an observation day by itself. It proves source-backed candidate plumbing, but it is a single-snapshot control proof rather than a full-session/window paper-runtime accounting unit.',
    '',
    '| Field | Value |',
    '|---|---|',
    '| candidate_only_smoke_sufficient_for_day_credit | `false` |',
    '| observation_day_eligible | `false` |',
    '| observation_day_increment | `0` |',
    '| implementation_authorized_by_this_ticket | `false` |',
    '| order_path_simulation_required_by_this_scope | `false` |',
    '',
    '## PR #314 evidence',
    '',
    '| Marker | Count |',
    '|---|---:|',
    `| STRAT_EVAL | ${stratEvalCount} |`,
    `| CANDIDATE | ${candidateCount} |`,
    `| ORDER_INTENT | ${orderIntentCount} |`,
    '',
    '## Minimum evidence contract before increment may become 1',
    '',
    '- Full-session/window paper-runtime manifest is required.',
    '- Observation window must be explicit and cannot be a single snapshot.',
    '- Source-backed feature snapshots must cover the declared window sufficiently for accounting.',
    '- Strategy-runtime marker accounting must cover the declared window.',
    '- ORDER_INTENT/order translation/adapter/broker/fill paths remain suppressed unless separately authorized.',
    '- qfa-410b/qfa-611, broker/live, Phase 6, and roster authority remain outside this ticket.',
    '',
    '## Source anchors',
    '',
    '| PR | Label | LF SHA-256 |',
    '|---:|---|---|',
    ...sourceAnchors.map((anchor) => {
      const record = anchor as JsonRecord;
      return `| ${record.pr} | \`${record.label}\` | \`${record.lf_sha256}\` |`;
    }),
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
    `Determination: \`${DETERMINATION}\``,
    '',
    'PR #314 proves candidate-only paper-runtime plumbing for one source-backed 2026-06-02 snapshot: `STRAT_EVAL = 1`, `CANDIDATE = 1`, and `ORDER_INTENT = 0` under the explicit `paper_observation_stop_after_candidate` guard.',
    '',
    'That is not an observation-day unit. Observation-day credit should represent a declared full-session/window paper-runtime accounting artifact, not a single-snapshot smoke. Therefore this ticket rejects candidate-only day credit and keeps `observation_day_increment = 0`.',
    '',
    'This scope does not require order-path simulation. It also does not authorize order translation, order adapters, broker adapters, paper fills, qfa-410b/qfa-611, active/candidate roster mutation, broker/live execution, or Phase 6 authority.',
    '',
    '## Minimum contract before observation_day_increment may become 1',
    '',
    '- Declare the observation window/session basis.',
    '- Produce a full-session/window paper-runtime accounting artifact.',
    '- Account for source-backed feature snapshots and strategy markers across that window.',
    '- Preserve ORDER_INTENT/order/broker/fill suppression unless a separate ticket explicitly authorizes them.',
    '- Keep observation-day accounting separate from broker/live authority.',
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
  const scriptSha = sha256FileLf(path.join(ROOT, 'scripts', 'paper', 'run-v2-pf-c-late-am-2026-06-02-paper-runtime-observation-day-scope.ts'));
  console.log(JSON.stringify({
    state: 'PENDING_REVIEW',
    determination: DETERMINATION,
    observation_day_eligible: false,
    observation_day_increment: 0,
    candidate_only_smoke_sufficient_for_day_credit: false,
    bounded_jsonl_lf_sha256: boundedSha,
    report_json_lf_sha256: reportSha,
    report_md_lf_sha256: reportMdSha,
    memo_lf_sha256: memoSha,
    script_lf_sha256: scriptSha,
    recommended_next_ticket: NEXT_TICKET,
  }, null, 2));
}

main();
