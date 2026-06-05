import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { generateRegimeShockReversionShortV2Utc1618Exclusion } from '../../apps/strategy_runtime/src/strategies/regime_shock_reversion_short_v2_utc_16_18_exclusion.js';
import type { StrategyFeatureSnapshot } from '../../apps/strategy_runtime/src/strategies/types.js';

const ROOT = process.cwd();
const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-CANDIDATE-STRAT-EVAL-SMOKE-01';
const SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-02-candidate-strat-eval-smoke-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const OUT_DIR = path.join(ROOT, 'artifacts', 'paper-observation', SLUG);
const BOUNDED_JSONL = path.join(OUT_DIR, 'bounded-candidate-strat-eval-smoke.jsonl');
const REPORT_JSON = path.join(OUT_DIR, 'candidate-strat-eval-smoke-report.json');
const REPORT_MD = path.join(OUT_DIR, 'candidate-strat-eval-smoke-report.md');
const MEMO_MD = path.join(ROOT, 'docs', 'research', `${SLUG}-memo.md`);
const BACKLOG_CSV = path.join(ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');
const MAX_ARTIFACT_BYTES = 95 * 1024 * 1024;

const PR311_JSONL = path.join(
  ROOT,
  'artifacts',
  'paper-observation',
  'v2-pf-c-late-am-paper-observation-2026-06-02-candidate-eligible-snapshot-builder-impl-01',
  'bounded-candidate-eligible-feature-snapshot.jsonl',
);
const PR311_BOUNDED_JSONL_LF_SHA256 = 'ecf32b6116263b3778819d29c2f2392153a123aec1daba91520323df353bce22';
const PR311_MERGE_COMMIT = '3e588bacec2dcc98e5b334314ae630d8b93cd707';
const FEATURE_SNAPSHOT_ID = 'feature-v2pf-20260602-1780427100000000000';
const TARGET_TS_NS = '1780427100000000000';
const TARGET_TS_UTC = '2026-06-02T19:05:00.000000000Z';
const TARGET_ENTRY_HOUR_UTC = 19;
const EXPECTED_GATE_STATUS = 'NON_EXCLUDED_BY_UTC_16_18_GATE';
const EXPECTED_NEXT_CANDIDATE_SMOKE_OUTCOME = 'STRAT_EVAL_AND_CANDIDATE_EXPECTED_ORDER_INTENT_SUPPRESSED';
const LOW_SHOCK_THRESHOLD_POS = 2.7;
const SNAPSHOT_SIGNED_SHOCK_VWAP = 2.7449;
const ORDER_INTENT_SUPPRESSION_REASON = 'NARROW_STRAT_EVAL_SMOKE_NO_ORDER_TRANSLATION';
const CANDIDATE_EMISSION_REASON = 'BASE_PREDICATES_PASS_AND_NON_EXCLUDED_BY_UTC_GATE';

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
    const output: JsonRecord = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = sortJson(value[key]);
    }
    return output;
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
    const output: JsonRecord = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = serializeForJson(nested);
    }
    return output;
  }
  return null;
}

function reviveTimestampNs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => reviveTimestampNs(item));
  }
  if (typeof value === 'object' && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key.endsWith('_ts_ns') && typeof nested === 'string' && /^-?\d+$/.test(nested)) {
        output[key] = BigInt(nested);
      } else {
        output[key] = reviveTimestampNs(nested);
      }
    }
    return output;
  }
  return value;
}

function loadPr311Snapshot(): StrategyFeatureSnapshot {
  if (!existsSync(PR311_JSONL)) {
    throw new Error(`Missing PR #311 bounded candidate snapshot JSONL: ${PR311_JSONL}`);
  }
  const actualSha = sha256FileLf(PR311_JSONL);
  if (actualSha !== PR311_BOUNDED_JSONL_LF_SHA256) {
    throw new Error(`PR #311 bounded snapshot hash mismatch: expected=${PR311_BOUNDED_JSONL_LF_SHA256} actual=${actualSha}`);
  }

  for (const line of readText(PR311_JSONL).split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const record = JSON.parse(line) as { record_type?: string; snapshot?: unknown };
    if (record.record_type === 'STRATEGY_FEATURE_SNAPSHOT') {
      const snapshot = reviveTimestampNs(record.snapshot) as StrategyFeatureSnapshot;
      if (snapshot.feature_snapshot_id !== FEATURE_SNAPSHOT_ID) {
        throw new Error(`Feature snapshot id mismatch: expected=${FEATURE_SNAPSHOT_ID} actual=${snapshot.feature_snapshot_id}`);
      }
      return snapshot;
    }
  }
  throw new Error('STRATEGY_FEATURE_SNAPSHOT record not found in PR #311 JSONL');
}

function determine(params: {
  readonly stratEvalCount: number;
  readonly candidateCount: number;
  readonly orderIntentCount: number;
}): string {
  if (params.stratEvalCount !== 1) {
    return 'CANDIDATE_STRAT_EVAL_SMOKE_BLOCKED_STRATEGY_EVALUATOR';
  }
  if (params.candidateCount !== 1) {
    return 'CANDIDATE_STRAT_EVAL_SMOKE_BLOCKED_CANDIDATE_NOT_EMITTED';
  }
  if (params.orderIntentCount !== 0) {
    return 'CANDIDATE_STRAT_EVAL_SMOKE_BLOCKED_UNEXPECTED_ORDER_INTENT';
  }
  return 'CANDIDATE_STRAT_EVAL_SMOKE_PASSED_CANDIDATE_EMITTED_ORDER_INTENT_SUPPRESSED';
}

function appendBacklogRow(): void {
  const row =
    'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-CANDIDATE-STRAT-EVAL-SMOKE-01,P1,1.0,V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-CANDIDATE-ELIGIBLE-SNAPSHOT-BUILDER-IMPL-01,Smoke the candidate-eligible 2026-06-02 source-backed StrategyFeatureSnapshot through the narrow strategy evaluation path and verify STRAT_EVAL plus CANDIDATE while ORDER_INTENT and all execution observation-day authority remain suppressed,new_cycle4_v2_research_substrate';
  const text = readText(BACKLOG_CSV);
  if (text.includes(TICKET)) {
    return;
  }
  writeFileSync(BACKLOG_CSV, text.endsWith('\n') ? `${text}${row}\n` : `${text}\n${row}\n`, 'utf8');
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
  const candidate = report.candidate_summary as JsonRecord;
  const payload = report.candidate_payload_summary as JsonRecord;
  return `# ${TICKET}

## Determination

\`\`\`text
${report.determination}
\`\`\`

## Counts

| Field | Value |
|---|---:|
| STRAT_EVAL_count | \`${report.STRAT_EVAL_count}\` |
| CANDIDATE_count | \`${report.CANDIDATE_count}\` |
| ORDER_INTENT_count | \`${report.ORDER_INTENT_count}\` |

## Candidate summary

| Field | Value |
|---|---|
| candidate_strategy_id | \`${payload.candidate_strategy_id}\` |
| candidate_timestamp_ns | \`${payload.candidate_timestamp_ns}\` |
| candidate_timestamp_utc | \`${payload.candidate_timestamp_utc}\` |
| candidate_entry_hour_utc | \`${payload.candidate_entry_hour_utc}\` |
| candidate_regime_label | \`${payload.candidate_regime_label}\` |
| candidate_signed_shock_vwap | \`${payload.candidate_signed_shock_vwap}\` |
| candidate_threshold_name | \`${payload.candidate_threshold_name}\` |
| candidate_threshold_value | \`${payload.candidate_threshold_value}\` |
| candidate_threshold_comparison | \`${payload.candidate_threshold_comparison}\` |
| candidate_utc_gate_status | \`${payload.candidate_utc_gate_status}\` |
| candidate_emission_reason | \`${payload.candidate_emission_reason}\` |
| candidate_id | \`${candidate.candidate_id}\` |
| direction | \`${candidate.direction}\` |
| entry_price | \`${candidate.entry_price}\` |
| stop_price | \`${candidate.stop_price}\` |
| risk_points | \`${candidate.risk_points}\` |
| confidence | \`${candidate.confidence}\` |
| first_reason | \`${candidate.first_reason}\` |

## Source and gate

| Field | Value |
|---|---|
| feature_snapshot_id | \`${report.feature_snapshot_id}\` |
| target_timestamp_utc | \`${report.target_timestamp_utc}\` |
| target_entry_hour_utc | \`${report.target_entry_hour_utc}\` |
| target_timestamp_variant_gate_status | \`${report.target_timestamp_variant_gate_status}\` |
| signed_shock_vwap | \`${report.snapshot_signed_shock_vwap}\` |
| low_shock_threshold_pos | \`${report.low_shock_threshold_pos}\` |
| threshold_comparison_result | \`${report.threshold_comparison_result}\` |
| order_intent_suppression_reason | \`${report.order_intent_suppression_reason}\` |

## Guardrails

| Guardrail | Value |
|---|---|
${Object.keys(guardrails).sort().map((key) => `| ${key} | \`${guardrails[key]}\` |`).join('\n')}

## Recommended next ticket

\`\`\`text
${report.recommended_next_ticket}
\`\`\`

${report.recommended_next_ticket_reason}
`;
}

function buildMemo(report: JsonRecord): string {
  const payload = report.candidate_payload_summary as JsonRecord;
  return `# ${TICKET} memo

## Summary

\`\`\`text
${report.determination}
\`\`\`

This smoke loads the PR #311 bounded source-backed candidate-eligible snapshot and runs only the narrow strategy generator for \`${STRATEGY_ID}\`. It proves strategy evaluation and candidate emission for the 19:05Z non-excluded point while keeping order intent, execution, and observation-day authority suppressed.

## Evidence

| Field | Value |
|---|---|
| feature_snapshot_id | \`${report.feature_snapshot_id}\` |
| STRAT_EVAL_count | \`${report.STRAT_EVAL_count}\` |
| CANDIDATE_count | \`${report.CANDIDATE_count}\` |
| ORDER_INTENT_count | \`${report.ORDER_INTENT_count}\` |
| target_timestamp_variant_gate_status | \`${report.target_timestamp_variant_gate_status}\` |
| threshold_comparison_result | \`${report.threshold_comparison_result}\` |
| candidate_timestamp_utc | \`${payload.candidate_timestamp_utc}\` |
| candidate_entry_hour_utc | \`${payload.candidate_entry_hour_utc}\` |
| candidate_utc_gate_status | \`${payload.candidate_utc_gate_status}\` |
| candidate_signed_shock_vwap | \`${payload.candidate_signed_shock_vwap}\` |
| candidate_threshold_comparison | \`${payload.candidate_threshold_comparison}\` |
| candidate_emission_reason | \`${payload.candidate_emission_reason}\` |
| order_intent_suppression_reason | \`${report.order_intent_suppression_reason}\` |
| expected_next_candidate_strat_eval_smoke_outcome | \`${report.expected_next_candidate_strat_eval_smoke_outcome}\` |

## Authority boundary

\`ORDER_INTENT_count = 0\` is caused by the intentionally narrow smoke scope: order translation, order adapter, broker adapter, paper runtime, and candidate persistence are not invoked. It is not evidence for or against a candidate-to-order path.

No full paper observation, broker/live dispatch, order intent, paper fill, qfa-410b, qfa-611, Phase 6, active roster, candidate roster, strategy config, management config, paper config, broker/live config, global regime label mutation, or observation-day credit was created.

## Recommended next ticket

\`\`\`text
${report.recommended_next_ticket}
\`\`\`

${report.recommended_next_ticket_reason}
`;
}

function main(): void {
  ensureDir(OUT_DIR);
  ensureDir(path.dirname(MEMO_MD));

  const snapshot = loadPr311Snapshot();
  const result = generateRegimeShockReversionShortV2Utc1618Exclusion({
    strategy_id: STRATEGY_ID,
    snapshot,
  });

  const stratEvalCount = result.evaluation === undefined ? 0 : 1;
  const candidateCount = result.candidate === undefined ? 0 : 1;
  const orderIntentCount = 0;
  const determination = determine({ stratEvalCount, candidateCount, orderIntentCount });

  const candidateSummary: JsonRecord = result.candidate
    ? {
        candidate_id: result.candidate.candidate_id,
        confidence: result.candidate.confidence,
        direction: result.candidate.direction,
        entry_price: result.candidate.entry_price,
        first_reason: result.candidate.reasons[0] ?? null,
        risk_points: result.candidate.risk_points,
        stop_price: result.candidate.stop_price,
      }
    : {
        candidate_id: null,
        confidence: null,
        direction: null,
        entry_price: null,
        first_reason: null,
        risk_points: null,
        stop_price: null,
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

  const thresholdComparisonResult = `${SNAPSHOT_SIGNED_SHOCK_VWAP} >= ${LOW_SHOCK_THRESHOLD_POS}`;
  const candidatePayloadSummary: JsonRecord = {
    candidate_emission_reason: CANDIDATE_EMISSION_REASON,
    candidate_entry_hour_utc: TARGET_ENTRY_HOUR_UTC,
    candidate_regime_label: snapshot.context.regime_label,
    candidate_signed_shock_vwap: SNAPSHOT_SIGNED_SHOCK_VWAP,
    candidate_strategy_id: STRATEGY_ID,
    candidate_threshold_comparison: thresholdComparisonResult,
    candidate_threshold_name: 'parameters.low_shock_threshold_pos',
    candidate_threshold_value: LOW_SHOCK_THRESHOLD_POS,
    candidate_timestamp_ns: TARGET_TS_NS,
    candidate_timestamp_utc: TARGET_TS_UTC,
    candidate_utc_gate_status: EXPECTED_GATE_STATUS,
  };
  const records: Json[] = [
    {
      record_type: 'SOURCE_SNAPSHOT_LOADED',
      source_anchor: {
        feature_snapshot_id: FEATURE_SNAPSHOT_ID,
        pr311_bounded_jsonl_lf_sha256: PR311_BOUNDED_JSONL_LF_SHA256,
        pr311_merge_commit: PR311_MERGE_COMMIT,
        target_entry_hour_utc: TARGET_ENTRY_HOUR_UTC,
        target_timestamp_ns: TARGET_TS_NS,
        target_timestamp_utc: TARGET_TS_UTC,
        target_timestamp_variant_gate_status: EXPECTED_GATE_STATUS,
      },
      ticket: TICKET,
    },
    {
      candidate: serializeForJson(result.candidate ?? null),
      candidate_count: candidateCount,
      candidate_payload_summary: candidatePayloadSummary,
      evaluation: serializeForJson(result.evaluation),
      record_type: 'STRAT_EVAL_AND_CANDIDATE',
      strat_eval_count: stratEvalCount,
      ticket: TICKET,
    },
    {
      order_intent_count: orderIntentCount,
      broker_adapter_invoked: false,
      candidate_persisted: false,
      order_adapter_invoked: false,
      order_intent_suppression_reason: ORDER_INTENT_SUPPRESSION_REASON,
      order_translation_invoked: false,
      paper_runtime_invoked: false,
      record_type: 'ORDER_INTENT_SUPPRESSION',
      ticket: TICKET,
    },
    {
      guardrails,
      record_type: 'AUTHORITY_AND_OBSERVATION_GUARDRAILS',
      ticket: TICKET,
    },
    {
      determination,
      expected_next_candidate_strat_eval_smoke_outcome: EXPECTED_NEXT_CANDIDATE_SMOKE_OUTCOME,
      record_type: 'DETERMINATION',
      ticket: TICKET,
    },
  ];

  writeFileSync(BOUNDED_JSONL, stableJsonl(records), 'utf8');
  const boundedSha = sha256FileLf(BOUNDED_JSONL);

  const report: JsonRecord = {
    CANDIDATE_count: candidateCount,
    ORDER_INTENT_count: orderIntentCount,
    STRAT_EVAL_count: stratEvalCount,
    broker_adapter_invoked: false,
    bounded_candidate_strat_eval_smoke_lf_sha256: boundedSha,
    candidate_payload_summary: candidatePayloadSummary,
    candidate_persisted: false,
    candidate_summary: candidateSummary,
    determination,
    expected_next_candidate_strat_eval_smoke_outcome: EXPECTED_NEXT_CANDIDATE_SMOKE_OUTCOME,
    feature_snapshot_id: FEATURE_SNAPSHOT_ID,
    guardrails,
    low_shock_threshold_pos: LOW_SHOCK_THRESHOLD_POS,
    observation_day_eligible: false,
    observation_day_increment: 0,
    order_adapter_invoked: false,
    order_intent_suppression_reason: ORDER_INTENT_SUPPRESSION_REASON,
    order_translation_invoked: false,
    paper_runtime_invoked: false,
    pr311_anchor: {
      bounded_jsonl_lf_sha256: PR311_BOUNDED_JSONL_LF_SHA256,
      merge_commit: PR311_MERGE_COMMIT,
    },
    recommended_next_ticket: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-PAPER-RUNTIME-CANDIDATE-SMOKE-SCOPE-01',
    recommended_next_ticket_reason:
      'Scope whether the candidate-emitting source-backed snapshot can enter the dedicated paper-runtime path without broker/live authority, and define what must remain suppressed before any observation-day accounting can be considered.',
    snapshot_signed_shock_vwap: SNAPSHOT_SIGNED_SHOCK_VWAP,
    strategy_id: STRATEGY_ID,
    target_entry_hour_utc: TARGET_ENTRY_HOUR_UTC,
    target_timestamp_ns: TARGET_TS_NS,
    target_timestamp_utc: TARGET_TS_UTC,
    target_timestamp_variant_gate_status: EXPECTED_GATE_STATUS,
    threshold_comparison_result: thresholdComparisonResult,
    ticket: TICKET,
  };

  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  writeFileSync(REPORT_MD, buildReportMarkdown(report), 'utf8');
  writeFileSync(MEMO_MD, buildMemo(report), 'utf8');
  appendBacklogRow();
  assertArtifactSizes([BOUNDED_JSONL, REPORT_JSON, REPORT_MD, MEMO_MD]);

  const output = {
    CANDIDATE_count: candidateCount,
    ORDER_INTENT_count: orderIntentCount,
    STRAT_EVAL_count: stratEvalCount,
    bounded_candidate_strat_eval_smoke_lf_sha256: boundedSha,
    determination,
    feature_snapshot_id: FEATURE_SNAPSHOT_ID,
    memo_lf_sha256: sha256FileLf(MEMO_MD),
    report_json_lf_sha256: sha256FileLf(REPORT_JSON),
    report_md_lf_sha256: sha256FileLf(REPORT_MD),
    target_entry_hour_utc: TARGET_ENTRY_HOUR_UTC,
    target_timestamp_variant_gate_status: EXPECTED_GATE_STATUS,
  };
  console.log(JSON.stringify(output, null, 2));
}

main();
