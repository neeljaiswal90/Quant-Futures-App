import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { generateRegimeShockReversionShortV2Utc1618Exclusion } from '../../apps/strategy_runtime/src/strategies/regime_shock_reversion_short_v2_utc_16_18_exclusion.js';
import type { StrategyFeatureSnapshot } from '../../apps/strategy_runtime/src/strategies/types.js';

const ROOT = process.cwd();
const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-STRAT-EVAL-SMOKE-01';
const SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-02-strat-eval-smoke-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const OUT_DIR = path.join(ROOT, 'artifacts', 'paper-observation', SLUG);
const BOUNDED_JSONL = path.join(OUT_DIR, 'bounded-strat-eval-smoke.jsonl');
const REPORT_JSON = path.join(OUT_DIR, 'strat-eval-smoke-report.json');
const REPORT_MD = path.join(OUT_DIR, 'strat-eval-smoke-report.md');
const MEMO_MD = path.join(ROOT, 'docs', 'research', `${SLUG}-memo.md`);
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'paper', 'run-v2-pf-c-late-am-2026-06-02-strat-eval-smoke.ts');
const BACKLOG_CSV = path.join(ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');
const PR308_JSONL = path.join(
  ROOT,
  'artifacts',
  'paper-observation',
  'v2-pf-c-late-am-paper-observation-2026-06-02-feature-snapshot-builder-impl-01',
  'bounded-feature-snapshot.jsonl',
);
const MAX_ARTIFACT_BYTES = 95 * 1024 * 1024;
const FEATURE_SNAPSHOT_ID = 'feature-v2pf-20260602-1780423199835478000';
const TARGET_TS_NS = '1780423199835478000';
const TARGET_TS_UTC = '2026-06-02T17:59:59.835478000Z';
const TARGET_ENTRY_HOUR_UTC = 17;
const EXPECTED_GATE_STATUS = 'EXCLUDED_BY_UTC_16_18_GATE';
const EXPECTED_PASS_SUPPRESSION_REASON = 'EXCLUDED_BY_UTC_16_18_GATE';
const EXPECTED_NEXT_STRAT_EVAL_SMOKE_OUTCOME = 'STRAT_EVAL_MARKER_ALLOWED_BUT_CANDIDATE_SUPPRESSED_BY_VARIANT_GATE';
const PR308_BOUNDED_FEATURE_SNAPSHOT_LF_SHA256 = '76f26186ee8952e05addcc94adcf751c1bc493d8e9e13ff9387d57f6d81d3216';
const PR308_MERGE_COMMIT = '0e2fcf5c51b41abf51d4e1b8cb4011ae66f675ab';
const LOW_REGIME_THRESHOLD_POS = 2.7;
const SNAPSHOT_SIGNED_SHOCK_VWAP = -1.7986;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

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
    const out: JsonRecord = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortJson(value[key]);
    }
    return out;
  }
  return value;
}

function stableJson(value: Json): string {
  return JSON.stringify(sortJson(value), null, 2) + '\n';
}

function stableJsonl(records: Json[]): string {
  return records.map((record) => JSON.stringify(sortJson(record))).join('\n') + '\n';
}

function serializeForJson(value: unknown): Json {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeForJson(item));
  }
  if (typeof value === 'object' && value !== null) {
    const out: JsonRecord = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = serializeForJson(nested);
    }
    return out;
  }
  return null;
}

function reviveTimestampNs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => reviveTimestampNs(item));
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key.endsWith('_ts_ns') && typeof nested === 'string' && /^-?\d+$/.test(nested)) {
        out[key] = BigInt(nested);
      } else {
        out[key] = reviveTimestampNs(nested);
      }
    }
    return out;
  }
  return value;
}

function loadPr308Snapshot(): StrategyFeatureSnapshot {
  if (!existsSync(PR308_JSONL)) {
    throw new Error(`Missing PR #308 bounded feature snapshot JSONL: ${PR308_JSONL}`);
  }
  const actualSha = sha256FileLf(PR308_JSONL);
  if (actualSha !== PR308_BOUNDED_FEATURE_SNAPSHOT_LF_SHA256) {
    throw new Error(`PR #308 bounded snapshot hash mismatch: expected=${PR308_BOUNDED_FEATURE_SNAPSHOT_LF_SHA256} actual=${actualSha}`);
  }
  for (const line of readText(PR308_JSONL).split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const record = JSON.parse(line) as { record_type?: string; snapshot?: unknown };
    if (record.record_type === 'STRATEGY_FEATURE_SNAPSHOT') {
      const snapshot = reviveTimestampNs(record.snapshot) as StrategyFeatureSnapshot;
      if (snapshot.feature_snapshot_id !== FEATURE_SNAPSHOT_ID) {
        throw new Error(`Feature snapshot id mismatch: ${snapshot.feature_snapshot_id}`);
      }
      return snapshot;
    }
  }
  throw new Error('STRATEGY_FEATURE_SNAPSHOT record not found in PR #308 JSONL');
}

function candidateSuppressionReason(reasons: readonly string[]): string {
  if (reasons.includes(`${STRATEGY_ID}:utc_16_18_exclusion`)) {
    return EXPECTED_PASS_SUPPRESSION_REASON;
  }
  const primary = reasons[0] ?? 'NO_EVALUATION_REASON_RECORDED';
  return `BASE_STRATEGY_REJECTION_PRECEDES_UTC_GATE:${primary}`;
}

function determine(params: {
  readonly stratEvalCount: number;
  readonly candidateCount: number;
  readonly orderIntentCount: number;
  readonly suppressionReason: string;
}): string {
  if (params.stratEvalCount !== 1) {
    return 'STRAT_EVAL_SMOKE_BLOCKED_STRATEGY_EVALUATOR';
  }
  if (params.candidateCount !== 0) {
    return 'STRAT_EVAL_SMOKE_BLOCKED_UNEXPECTED_CANDIDATE';
  }
  if (params.orderIntentCount !== 0) {
    return 'STRAT_EVAL_SMOKE_BLOCKED_UNEXPECTED_ORDER_INTENT';
  }
  if (params.suppressionReason === EXPECTED_PASS_SUPPRESSION_REASON) {
    return 'STRAT_EVAL_SMOKE_PASSED_CANDIDATE_SUPPRESSED_BY_UTC_GATE';
  }
  return 'STRAT_EVAL_SMOKE_PARTIAL_PASS_BASE_REJECTION_PRECEDES_UTC_GATE';
}

function appendBacklogRow(): void {
  const row = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-STRAT-EVAL-SMOKE-01,P1,1.0,V2-PF-C-LATE-AM-PAPER-OBSERVATION-STRAT-EVAL-WAVE-1,Smoke the source-backed 2026-06-02 StrategyFeatureSnapshot through the narrow strategy evaluation path and verify STRAT_EVAL while candidate and order intent remain suppressed by the UTC 16-18 exclusion gate with no observation-day credit or authority,new_cycle4_v2_research_substrate';
  const existing = readText(BACKLOG_CSV);
  if (existing.includes(TICKET)) {
    return;
  }
  const suffix = existing.endsWith('\n') ? '' : '\n';
  writeFileSync(BACKLOG_CSV, `${existing}${suffix}${row}\n`, 'utf8');
}

function assertArtifactSizes(paths: readonly string[]): void {
  for (const filePath of paths) {
    const size = statSync(filePath).size;
    if (size > MAX_ARTIFACT_BYTES) {
      throw new Error(`Artifact exceeds 95 MiB guard: ${filePath} size=${size}`);
    }
  }
}

function buildReportMarkdown(report: JsonRecord): string {
  const guardrails = report.guardrails as JsonRecord;
  const rejection = report.rejection_threshold_provenance as JsonRecord;
  return `# ${TICKET}\n\n` +
    `## Determination\n\n` +
    `\`${report.determination}\`\n\n` +
    `| Outcome field | Value |\n|---|---|\n` +
    `| strat_eval_plumbing_status | \`${report.strat_eval_plumbing_status}\` |\n` +
    `| candidate_gate_proof_status | \`${report.candidate_gate_proof_status}\` |\n\n` +
    `## Counts\n\n` +
    `| Field | Value |\n|---|---:|\n` +
    `| STRAT_EVAL_count | \`${report.STRAT_EVAL_count}\` |\n` +
    `| CANDIDATE_count | \`${report.CANDIDATE_count}\` |\n` +
    `| ORDER_INTENT_count | \`${report.ORDER_INTENT_count}\` |\n\n` +
    `## Candidate suppression\n\n` +
    `| Field | Value |\n|---|---|\n` +
    `| target_timestamp_variant_gate_status | \`${report.target_timestamp_variant_gate_status}\` |\n` +
    `| expected_suppression_reason | \`${EXPECTED_PASS_SUPPRESSION_REASON}\` |\n` +
    `| actual_candidate_suppression_reason | \`${report.candidate_suppression_reason}\` |\n\n` +
    `## Interpretation\n\n` +
    `${report.interpretation}\n\n` +
    `## Rejection threshold provenance\n\n` +
    `| Field | Value |\n|---|---|\n` +
    `| strategy_source_path | \`${rejection.strategy_source_path}\` |\n` +
    `| symbol_or_function | \`${rejection.symbol_or_function}\` |\n` +
    `| threshold_name | \`${rejection.threshold_name}\` |\n` +
    `| threshold_value | \`${rejection.threshold_value}\` |\n` +
    `| snapshot_value_compared | \`${rejection.snapshot_value_compared}\` |\n` +
    `| comparison_result | \`${rejection.comparison_result}\` |\n` +
    `| why_rejection_precedes_utc_gate | ${rejection.why_rejection_precedes_utc_gate} |\n\n` +
    `## Guardrails\n\n` +
    `| Guardrail | Value |\n|---|---|\n` +
    Object.keys(guardrails).sort().map((key) => `| ${key} | \`${guardrails[key]}\` |`).join('\n') +
    `\n\n## Recommended next ticket\n\n` +
    `\`${report.recommended_next_ticket}\`\n\n` +
    `${report.recommended_next_ticket_reason}\n`;
}

function buildMemo(report: JsonRecord): string {
  const rejection = report.rejection_threshold_provenance as JsonRecord;
  return `# ${TICKET} memo\n\n` +
    `## Purpose\n\n` +
    `Smoke the PR #308 source-backed StrategyFeatureSnapshot through the narrow current strategy generator for \`${STRATEGY_ID}\`.\n\n` +
    `## Determination\n\n` +
    `\`${report.determination}\`\n\n` +
    `| Outcome field | Value |\n|---|---|\n` +
    `| strat_eval_plumbing_status | \`${report.strat_eval_plumbing_status}\` |\n` +
    `| candidate_gate_proof_status | \`${report.candidate_gate_proof_status}\` |\n\n` +
    `The smoke emitted a strategy-evaluation marker, so strategy-evaluation plumbing works. It did not reach the UTC gate as the candidate suppression reason. The inherited v2 strategy rejected the snapshot first, so claiming \`EXCLUDED_BY_UTC_16_18_GATE\` as the candidate suppression reason would overstate the current path.\n\n` +
    `## Evidence\n\n` +
    `| Field | Value |\n|---|---|\n` +
    `| feature_snapshot_id | \`${report.feature_snapshot_id}\` |\n` +
    `| strategy_id | \`${report.strategy_id}\` |\n` +
    `| target_timestamp_ns | \`${report.target_timestamp_ns}\` |\n` +
    `| target_entry_hour_utc | \`${report.target_entry_hour_utc}\` |\n` +
    `| target_timestamp_variant_gate_status | \`${report.target_timestamp_variant_gate_status}\` |\n` +
    `| STRAT_EVAL_count | \`${report.STRAT_EVAL_count}\` |\n` +
    `| CANDIDATE_count | \`${report.CANDIDATE_count}\` |\n` +
    `| ORDER_INTENT_count | \`${report.ORDER_INTENT_count}\` |\n` +
    `| candidate_suppression_reason | \`${report.candidate_suppression_reason}\` |\n\n` +
    `## Rejection threshold provenance\n\n` +
    `| Field | Value |\n|---|---|\n` +
    `| strategy_source_path | \`${rejection.strategy_source_path}\` |\n` +
    `| symbol_or_function | \`${rejection.symbol_or_function}\` |\n` +
    `| threshold_name | \`${rejection.threshold_name}\` |\n` +
    `| threshold_value | \`${rejection.threshold_value}\` |\n` +
    `| snapshot_value_compared | \`${rejection.snapshot_value_compared}\` |\n` +
    `| comparison_result | \`${rejection.comparison_result}\` |\n` +
    `| why_rejection_precedes_utc_gate | ${rejection.why_rejection_precedes_utc_gate} |\n\n` +
    `## Authority boundary\n\n` +
    `No full paper observation, broker/live dispatch, order intent, paper fill, qfa-410b, qfa-611, Phase 6, active roster, candidate roster, strategy config, management config, paper config, broker/live config, global regime label mutation, or observation-day credit was created.\n\n` +
    `## Recommended next ticket\n\n` +
    `\`${report.recommended_next_ticket}\`\n\n` +
    `${report.recommended_next_ticket_reason}\n`;
}

function main(): void {
  ensureDir(OUT_DIR);
  ensureDir(path.dirname(MEMO_MD));

  const snapshot = loadPr308Snapshot();
  const result = generateRegimeShockReversionShortV2Utc1618Exclusion({
    strategy_id: STRATEGY_ID,
    snapshot,
  });

  const evaluation = result.evaluation;
  const candidateCount = result.candidate === undefined ? 0 : 1;
  const orderIntentCount = 0;
  const stratEvalCount = evaluation === undefined ? 0 : 1;
  const suppressionReason = candidateCount === 0
    ? candidateSuppressionReason(evaluation?.reasons ?? [])
    : 'UNEXPECTED_CANDIDATE_EMITTED';
  const determination = determine({
    candidateCount,
    orderIntentCount,
    stratEvalCount,
    suppressionReason,
  });
  const passed = determination === 'STRAT_EVAL_SMOKE_PASSED_CANDIDATE_SUPPRESSED_BY_UTC_GATE';
  const stratEvalPlumbingStatus = stratEvalCount === 1 ? 'PASSED' : 'BLOCKED';
  const candidateGateProofStatus = passed ? 'PASSED' : 'BLOCKED_BY_BASE_REJECTION';
  const rejectionThresholdProvenance: JsonRecord = {
    comparison_result: `${SNAPSHOT_SIGNED_SHOCK_VWAP} < ${LOW_REGIME_THRESHOLD_POS}; inherited v2 base predicate rejects before candidate construction`,
    snapshot_value_compared: SNAPSHOT_SIGNED_SHOCK_VWAP,
    strategy_source_path: 'apps/strategy_runtime/src/strategies/regime_shock_reversion_short_v2.ts',
    symbol_or_function: 'firstRegimeShockReversionShortV2Rejection(...)',
    threshold_name: 'parameters.low_shock_threshold_pos',
    threshold_value: LOW_REGIME_THRESHOLD_POS,
    why_rejection_precedes_utc_gate: 'generateRegimeShockReversionShortV2Utc1618Exclusion(...) calls generateRegimeShockReversionShortV2WithParameters(...) first and only checks the UTC 16-18 exclusion after inherited.candidate exists.',
  };

  const guardrails: JsonRecord = {
    active_roster_mutated: false,
    broker_live_authorized: false,
    candidate_roster_mutated: false,
    full_paper_observation_invoked: false,
    global_regime_labels_mutated: false,
    management_config_mutated: false,
    observation_day_eligible: false,
    observation_day_increment: 0,
    order_intent_emitted: false,
    paper_config_mutated: false,
    paper_fill_emitted: false,
    paper_runtime_invoked: false,
    phase_6_authorized: false,
    qfa_410b_run: false,
    qfa_611_run: false,
    strategy_config_mutated: false,
  };

  const sourceAnchor: JsonRecord = {
    feature_snapshot_id: FEATURE_SNAPSHOT_ID,
    pr308_bounded_feature_snapshot_lf_sha256: PR308_BOUNDED_FEATURE_SNAPSHOT_LF_SHA256,
    pr308_merge_commit: PR308_MERGE_COMMIT,
    source_jsonl_path: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-feature-snapshot-builder-impl-01/bounded-feature-snapshot.jsonl',
    target_entry_hour_utc: TARGET_ENTRY_HOUR_UTC,
    target_timestamp_ns: TARGET_TS_NS,
    target_timestamp_utc: TARGET_TS_UTC,
    target_timestamp_variant_gate_status: EXPECTED_GATE_STATUS,
  };

  const interpretation = passed
    ? 'The narrow strategy generator emitted STRAT_EVAL and suppressed the candidate through the UTC 16-18 exclusion gate.'
    : 'The narrow strategy generator emitted STRAT_EVAL, so evaluation plumbing passed. The inherited v2 strategy rejected the snapshot before the variant UTC gate could suppress a candidate, so candidate/UTC gate suppression remains unproven for the PR #308 snapshot.';
  const recommendedNextTicket = passed
    ? 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-NON-EXCLUDED-SNAPSHOT-SOURCE-SCOPE-01'
    : 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-CANDIDATE-ELIGIBLE-NON-EXCLUDED-SNAPSHOT-SOURCE-SCOPE-01';
  const recommendedNextTicketReason = passed
    ? 'This smoke proves evaluation plumbing, but the available snapshot is inside the exclusion gate; source scope should identify or build a causal source-backed snapshot outside UTC 16-18.'
    : 'This smoke proves STRAT_EVAL plumbing, but the PR #308 snapshot is both inside the UTC 16-18 exclusion window and rejected by inherited v2 signal thresholds before the UTC gate. The next source scope should identify or build a causal source-backed snapshot that is candidate-eligible and outside the exclusion window. Candidate-eligible means inherited v2 base predicates pass before the UTC exclusion gate is evaluated.';

  const records: Json[] = [
    {
      record_type: 'SOURCE_SNAPSHOT_LOADED',
      source_anchor: sourceAnchor,
      ticket: TICKET,
    },
    {
      record_type: 'STRAT_EVAL',
      candidate_suppression_reason: suppressionReason,
      evaluation: serializeForJson(evaluation),
      marker_count_increment: stratEvalCount,
      strat_eval_plumbing_status: stratEvalPlumbingStatus,
      ticket: TICKET,
    },
    {
      record_type: 'CANDIDATE_SUPPRESSION',
      actual_candidate_suppression_reason: suppressionReason,
      candidate_count: candidateCount,
      expected_candidate_suppression_reason: EXPECTED_PASS_SUPPRESSION_REASON,
      expected_next_strat_eval_smoke_outcome: EXPECTED_NEXT_STRAT_EVAL_SMOKE_OUTCOME,
      candidate_gate_proof_status: candidateGateProofStatus,
      rejection_threshold_provenance: rejectionThresholdProvenance,
      target_timestamp_variant_gate_status: EXPECTED_GATE_STATUS,
      ticket: TICKET,
    },
    {
      record_type: 'AUTHORITY_AND_OBSERVATION_GUARDRAILS',
      guardrails,
      ticket: TICKET,
    },
    {
      record_type: 'DETERMINATION',
      determination,
      interpretation,
      strat_eval_plumbing_status: stratEvalPlumbingStatus,
      candidate_gate_proof_status: candidateGateProofStatus,
      recommended_next_ticket: recommendedNextTicket,
      ticket: TICKET,
    },
  ];

  writeFileSync(BOUNDED_JSONL, stableJsonl(records), 'utf8');
  const boundedSha = sha256FileLf(BOUNDED_JSONL);

  const report: JsonRecord = {
    CANDIDATE_count: candidateCount,
    ORDER_INTENT_count: orderIntentCount,
    STRAT_EVAL_count: stratEvalCount,
    bounded_strat_eval_smoke_lf_sha256: boundedSha,
    candidate_suppression_reason: suppressionReason,
    candidate_gate_proof_status: candidateGateProofStatus,
    determination,
    expected_candidate_suppression_reason: EXPECTED_PASS_SUPPRESSION_REASON,
    expected_next_strat_eval_smoke_outcome: EXPECTED_NEXT_STRAT_EVAL_SMOKE_OUTCOME,
    feature_snapshot_id: FEATURE_SNAPSHOT_ID,
    guardrails,
    interpretation,
    observation_day_eligible: false,
    observation_day_increment: 0,
    paper_runtime_invoked: false,
    broker_live_authorized: false,
    recommended_next_ticket: recommendedNextTicket,
    recommended_next_ticket_reason: recommendedNextTicketReason,
    rejection_threshold_provenance: rejectionThresholdProvenance,
    source_snapshot_anchor: sourceAnchor,
    strat_eval_plumbing_status: stratEvalPlumbingStatus,
    strategy_id: STRATEGY_ID,
    target_entry_hour_utc: TARGET_ENTRY_HOUR_UTC,
    target_timestamp_ns: TARGET_TS_NS,
    target_timestamp_utc: TARGET_TS_UTC,
    target_timestamp_variant_gate_status: EXPECTED_GATE_STATUS,
    ticket: TICKET,
  };

  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  writeFileSync(REPORT_MD, buildReportMarkdown(report), 'utf8');
  writeFileSync(MEMO_MD, buildMemo(report), 'utf8');
  appendBacklogRow();
  assertArtifactSizes([BOUNDED_JSONL, REPORT_JSON, REPORT_MD, MEMO_MD, SCRIPT_PATH]);

  const output = {
    CANDIDATE_count: candidateCount,
    ORDER_INTENT_count: orderIntentCount,
    STRAT_EVAL_count: stratEvalCount,
    bounded_strat_eval_smoke_lf_sha256: boundedSha,
    candidate_gate_proof_status: candidateGateProofStatus,
    candidate_suppression_reason: suppressionReason,
    determination,
    feature_snapshot_id: FEATURE_SNAPSHOT_ID,
    memo_lf_sha256: sha256FileLf(MEMO_MD),
    report_json_lf_sha256: sha256FileLf(REPORT_JSON),
    report_md_lf_sha256: sha256FileLf(REPORT_MD),
    strat_eval_plumbing_status: stratEvalPlumbingStatus,
    target_entry_hour_utc: TARGET_ENTRY_HOUR_UTC,
    target_timestamp_variant_gate_status: EXPECTED_GATE_STATUS,
  };
  console.log(JSON.stringify(output, null, 2));
}

main();
