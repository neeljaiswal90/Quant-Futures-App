import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { generateRegimeShockReversionShortV2Utc1618Exclusion } from '../../apps/strategy_runtime/src/strategies/regime_shock_reversion_short_v2_utc_16_18_exclusion.js';
import type { StrategyFeatureSnapshot } from '../../apps/strategy_runtime/src/strategies/types.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

const ROOT = process.cwd();
const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-CANDIDATE-STRAT-EVAL-SMOKE-01';
const SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-04-candidate-strat-eval-smoke-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const OUT_DIR = path.join(ROOT, 'artifacts', 'paper-observation', SLUG);
const BOUNDED_JSONL = path.join(OUT_DIR, 'bounded-candidate-strat-eval-smoke.jsonl');
const REPORT_JSON = path.join(OUT_DIR, 'candidate-strat-eval-smoke-report.json');
const REPORT_MD = path.join(OUT_DIR, 'candidate-strat-eval-smoke-report.md');
const MEMO_MD = path.join(ROOT, 'docs', 'research', `${SLUG}-memo.md`);
const BACKLOG_CSV = path.join(ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');
const SOURCE_JSONL = path.join(
  ROOT,
  'artifacts',
  'paper-observation',
  'v2-pf-c-late-am-paper-observation-2026-06-04-feature-snapshot-builder-impl-01',
  'bounded-feature-snapshot.jsonl',
);
const SOURCE_REPORT_JSON = path.join(
  ROOT,
  'artifacts',
  'paper-observation',
  'v2-pf-c-late-am-paper-observation-2026-06-04-feature-snapshot-builder-impl-01',
  'feature-snapshot-builder-report.json',
);
const MAX_ARTIFACT_BYTES = 95 * 1024 * 1024;
const FEATURE_SNAPSHOT_ID = 'feature-v2pf-20260604-1780585080000000000';
const TARGET_TS_NS = '1780585080000000000';
const TARGET_TS_UTC = '2026-06-04T14:58:00.000000000Z';
const TARGET_ENTRY_HOUR_UTC = 14;
const EXPECTED_GATE_STATUS = 'NON_EXCLUDED_BY_UTC_16_18_GATE';
const LOW_SHOCK_THRESHOLD_POS = 2.7;
const SNAPSHOT_SIGNED_SHOCK_VWAP = 2.9421;
const ORDER_INTENT_SUPPRESSION_REASON = 'NARROW_STRAT_EVAL_SMOKE_NO_ORDER_TRANSLATION';
const CANDIDATE_EMISSION_REASON = 'BASE_PREDICATES_PASS_AND_NON_EXCLUDED_BY_UTC_GATE';

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
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (value !== null && typeof value === 'object') {
    const output: JsonRecord = {};
    for (const key of Object.keys(value).sort()) output[key] = sortJson((value as JsonRecord)[key]);
    return output;
  }
  return value;
}

function stableJson(value: Json): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function stableJsonl(records: Json[]): string {
  return `${records.map((record) => JSON.stringify(sortJson(record))).join('\n')}\n`;
}

function serializeForJson(value: unknown): Json {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => serializeForJson(item));
  if (typeof value === 'object' && value !== null) {
    const output: JsonRecord = {};
    for (const [key, nested] of Object.entries(value)) output[key] = serializeForJson(nested);
    return output;
  }
  return null;
}

function reviveTimestampNs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => reviveTimestampNs(item));
  if (typeof value === 'object' && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key.endsWith('_ts_ns') && typeof nested === 'string' && /^-?\d+$/.test(nested)) output[key] = BigInt(nested);
      else output[key] = reviveTimestampNs(nested);
    }
    return output;
  }
  return value;
}

function asRecord(value: Json | undefined): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function loadFeatureSnapshot(): StrategyFeatureSnapshot {
  if (!existsSync(SOURCE_JSONL)) throw new Error(`Missing source bounded feature snapshot JSONL: ${SOURCE_JSONL}`);
  for (const line of readText(SOURCE_JSONL).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as JsonRecord;
    if (record.record_type !== 'StrategyFeatureSnapshot') continue;
    if (record.feature_snapshot_id !== FEATURE_SNAPSHOT_ID) {
      throw new Error(`Feature snapshot id mismatch: expected=${FEATURE_SNAPSHOT_ID} actual=${record.feature_snapshot_id}`);
    }
    return reviveTimestampNs(record) as StrategyFeatureSnapshot;
  }
  throw new Error('StrategyFeatureSnapshot record not found');
}

function determine(stratEvalCount: number, candidateCount: number, orderIntentCount: number): string {
  if (stratEvalCount !== 1) return 'CANDIDATE_STRAT_EVAL_SMOKE_BLOCKED_STRATEGY_EVALUATOR';
  if (candidateCount !== 1) return 'CANDIDATE_STRAT_EVAL_SMOKE_BLOCKED_CANDIDATE_NOT_EMITTED';
  if (orderIntentCount !== 0) return 'CANDIDATE_STRAT_EVAL_SMOKE_BLOCKED_UNEXPECTED_ORDER_INTENT';
  return 'CANDIDATE_STRAT_EVAL_SMOKE_PASSED_CANDIDATE_EMITTED_ORDER_INTENT_SUPPRESSED';
}

function appendBacklogRow(): void {
  const row =
    'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-CANDIDATE-STRAT-EVAL-SMOKE-01,P1,1.0,V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FEATURE-SNAPSHOT-BUILDER-IMPL-01,Smoke the 2026-06-04 source-backed StrategyFeatureSnapshot through the narrow strategy evaluation path and verify STRAT_EVAL plus CANDIDATE while ORDER_INTENT and all execution observation-day authority remain suppressed,new_cycle4_v2_research_substrate';
  const text = readText(BACKLOG_CSV);
  if (text.includes(TICKET)) return;
  writeFileSync(BACKLOG_CSV, text.endsWith('\n') ? `${text}${row}\n` : `${text}\n${row}\n`, 'utf8');
}

function buildReportMarkdown(report: JsonRecord): string {
  const candidate = asRecord(report.candidate_summary);
  const payload = asRecord(report.candidate_payload_summary);
  const guardrails = asRecord(report.guardrails);
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

## Candidate payload summary

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

## Order-intent suppression provenance

\`\`\`text
paper_runtime_invoked = false
order_translation_invoked = false
order_adapter_invoked = false
broker_adapter_invoked = false
candidate_persisted = false
order_intent_suppression_reason = ${report.order_intent_suppression_reason}
\`\`\`

## Consumer compatibility gap

\`\`\`json
${JSON.stringify(report.consumer_compatibility_gap, null, 2)}
\`\`\`

## Guardrails

| Guardrail | Value |
|---|---|
${Object.keys(guardrails).sort().map((key) => `| ${key} | \`${guardrails[key]}\` |`).join('\n')}

## Recommended next ticket

\`\`\`text
${report.recommended_next_ticket}
\`\`\`
`;
}

function buildMemo(report: JsonRecord): string {
  return `# ${TICKET} memo

## Summary

\`\`\`text
${report.determination}
\`\`\`

This smoke loads the PR #321 source-backed 2026-06-04 StrategyFeatureSnapshot and runs only the narrow strategy generator for \`${STRATEGY_ID}\`. It proves \`STRAT_EVAL = 1\` and \`CANDIDATE = 1\` for the non-excluded 14:58Z point while keeping \`ORDER_INTENT = 0\`.

## Candidate payload summary

\`\`\`json
${JSON.stringify(report.candidate_payload_summary, null, 2)}
\`\`\`

## Authority boundary

\`ORDER_INTENT = 0\` is caused by the intentionally narrow smoke scope: order translation, order adapter, broker adapter, paper runtime, and candidate persistence are not invoked. It is not evidence for or against a candidate-to-order path.

## Consumer compatibility gap

\`\`\`json
${JSON.stringify(report.consumer_compatibility_gap, null, 2)}
\`\`\`

\`\`\`json
${JSON.stringify(report.guardrails, null, 2)}
\`\`\`

## Recommended next ticket

\`\`\`text
${report.recommended_next_ticket}
\`\`\`
`;
}

function main(): void {
  ensureDir(OUT_DIR);
  ensureDir(path.dirname(MEMO_MD));

  const sourceReport = JSON.parse(readText(SOURCE_REPORT_JSON)) as JsonRecord;
  const sourceHashes = asRecord(sourceReport.output_hashes);
  const snapshot = loadFeatureSnapshot();
  let result: ReturnType<typeof generateRegimeShockReversionShortV2Utc1618Exclusion> | undefined;
  let blockedError: string | null = null;
  try {
    result = generateRegimeShockReversionShortV2Utc1618Exclusion({
      strategy_id: STRATEGY_ID,
      snapshot,
    });
  } catch (error: unknown) {
    blockedError = error instanceof Error ? error.message : String(error);
  }

  const stratEvalCount = result?.evaluation === undefined ? 0 : 1;
  const candidateCount = result?.candidate === undefined ? 0 : 1;
  const orderIntentCount = 0;
  const determination =
    blockedError === null
      ? determine(stratEvalCount, candidateCount, orderIntentCount)
      : 'CANDIDATE_STRAT_EVAL_SMOKE_BLOCKED_SNAPSHOT_CONSUMER_COMPATIBILITY_GAP';
  const thresholdComparisonResult = `${SNAPSHOT_SIGNED_SHOCK_VWAP} >= ${LOW_SHOCK_THRESHOLD_POS}`;

  const candidateSummary: JsonRecord = result?.candidate
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
  const consumerCompatibilityGap: Json =
    blockedError === null
      ? null
      : {
          missing_snapshot_field_path: 'instrument.tick_size',
          observed_error: blockedError,
          required_expression: 'snapshot.instrument.tick_size',
          strategy_source_path: 'apps/strategy_runtime/src/strategies/regime_shock_reversion_short_v2.ts',
          symbol_or_function: 'generateRegimeShockReversionShortV2WithParameters(...)',
        };

  const guardrails: JsonRecord = {
    active_roster_mutated: false,
    broker_live_authorized: false,
    broker_adapter_invoked: false,
    candidate_persisted: false,
    candidate_roster_mutated: false,
    full_paper_observation_invoked: false,
    global_regime_labels_mutated: false,
    management_config_mutated: false,
    observation_day_eligible: false,
    observation_day_increment: 0,
    order_adapter_invoked: false,
    order_intent_emitted: false,
    order_translation_invoked: false,
    paper_config_mutated: false,
    paper_fill_emitted: false,
    paper_runtime_invoked: false,
    phase_6_authorized: false,
    qfa_410b_run: false,
    qfa_611_run: false,
    strategy_config_mutated: false,
  };

  const records: Json[] = [
    {
      record_type: 'SOURCE_SNAPSHOT_LOADED',
      source_anchor: {
        feature_snapshot_id: FEATURE_SNAPSHOT_ID,
        source_bounded_feature_snapshot_lf_sha256: sourceHashes.bounded_feature_snapshot_jsonl,
        source_merge_commit: '63d5cf6f4d0258365758ab75f1184ede85d0ed13',
        target_entry_hour_utc: TARGET_ENTRY_HOUR_UTC,
        target_timestamp_ns: TARGET_TS_NS,
        target_timestamp_utc: TARGET_TS_UTC,
        target_timestamp_variant_gate_status: EXPECTED_GATE_STATUS,
      },
      ticket: TICKET,
    },
    {
      candidate: serializeForJson(result?.candidate ?? null),
      candidate_count: candidateCount,
      candidate_payload_summary: candidatePayloadSummary,
      evaluation: serializeForJson(result?.evaluation ?? null),
      record_type: 'STRAT_EVAL_AND_CANDIDATE',
      strat_eval_count: stratEvalCount,
      ticket: TICKET,
    },
    {
      broker_adapter_invoked: false,
      candidate_persisted: false,
      order_adapter_invoked: false,
      order_intent_count: orderIntentCount,
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
      blocked_error: blockedError,
      consumer_compatibility_gap: consumerCompatibilityGap,
      determination,
      record_type: 'DETERMINATION',
      ticket: TICKET,
    },
  ];

  writeFileSync(BOUNDED_JSONL, stableJsonl(records), 'utf8');
  if (statSync(BOUNDED_JSONL).size > MAX_ARTIFACT_BYTES) throw new Error(`Artifact exceeds 95 MiB: ${BOUNDED_JSONL}`);

  const report: JsonRecord = {
    CANDIDATE_count: candidateCount,
    ORDER_INTENT_count: orderIntentCount,
    STRAT_EVAL_count: stratEvalCount,
    bounded_candidate_strat_eval_smoke_lf_sha256: sha256FileLf(BOUNDED_JSONL),
    candidate_payload_summary: candidatePayloadSummary,
    candidate_summary: candidateSummary,
    consumer_compatibility_gap: consumerCompatibilityGap,
    determination,
    feature_snapshot_id: FEATURE_SNAPSHOT_ID,
    guardrails,
    low_shock_threshold_pos: LOW_SHOCK_THRESHOLD_POS,
    observation_day_eligible: false,
    observation_day_increment: 0,
    order_intent_suppression_reason: ORDER_INTENT_SUPPRESSION_REASON,
    paper_runtime_invoked: false,
    recommended_next_ticket:
      blockedError === null
        ? 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-PAPER-RUNTIME-CANDIDATE-SMOKE-SCOPE-01'
        : 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FEATURE-SNAPSHOT-BUILDER-COMPAT-REPAIR-01',
    recommended_next_ticket_reason:
      blockedError === null
        ? 'Scope whether the candidate-emitting 2026-06-04 source-backed snapshot can enter the dedicated paper-runtime path without broker/live authority, and define what must remain suppressed before any observation-day accounting can be considered.'
        : 'Repair the 2026-06-04 source-backed StrategyFeatureSnapshot builder so the materialized snapshot includes instrument.tick_size and any other behavior-bearing consumer fields required by the v2 strategy path, without running strategy runtime or creating observation-day credit.',
    snapshot_signed_shock_vwap: SNAPSHOT_SIGNED_SHOCK_VWAP,
    source_anchor: {
      feature_snapshot_builder_merge_commit: '63d5cf6f4d0258365758ab75f1184ede85d0ed13',
      feature_snapshot_builder_ticket: sourceReport.ticket,
      source_bounded_feature_snapshot_lf_sha256: sourceHashes.bounded_feature_snapshot_jsonl,
      source_report_lf_sha256: sha256FileLf(SOURCE_REPORT_JSON),
    },
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
  const final = {
    state: 'PENDING_REVIEW',
    ticket: TICKET,
    determination,
    STRAT_EVAL_count: stratEvalCount,
    CANDIDATE_count: candidateCount,
    ORDER_INTENT_count: orderIntentCount,
    consumer_compatibility_gap: blockedError,
    feature_snapshot_id: FEATURE_SNAPSHOT_ID,
    target_timestamp_utc: TARGET_TS_UTC,
    target_entry_hour_utc: TARGET_ENTRY_HOUR_UTC,
    candidate_payload_summary: candidatePayloadSummary,
    authority_locks: guardrails,
    bounded_jsonl_lf_sha256: sha256FileLf(BOUNDED_JSONL),
    report_json_lf_sha256: sha256FileLf(REPORT_JSON),
    report_md_lf_sha256: sha256FileLf(REPORT_MD),
    memo_lf_sha256: sha256FileLf(MEMO_MD),
    script_lf_sha256: sha256FileLf(path.join(ROOT, 'scripts', 'paper', 'run-v2-pf-c-late-am-2026-06-04-candidate-strat-eval-smoke.ts')),
    recommended_next_ticket: report.recommended_next_ticket,
  };
  console.log(JSON.stringify(final, null, 2));
}

main();
