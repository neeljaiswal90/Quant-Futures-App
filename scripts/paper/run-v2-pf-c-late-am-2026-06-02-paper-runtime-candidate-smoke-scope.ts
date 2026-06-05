import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-PAPER-RUNTIME-CANDIDATE-SMOKE-SCOPE-01';
const SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-02-paper-runtime-candidate-smoke-scope-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const FEATURE_SNAPSHOT_ID = 'feature-v2pf-20260602-1780427100000000000';
const TARGET_TS_NS = '1780427100000000000';
const TARGET_TS_UTC = '2026-06-02T19:05:00.000000000Z';
const TARGET_ENTRY_HOUR_UTC = 19;
const UTC_GATE_STATUS = 'NON_EXCLUDED_BY_UTC_16_18_GATE';
const SIGNED_SHOCK_VWAP = 2.7449;
const LOW_SHOCK_THRESHOLD_POS = 2.7;
const THRESHOLD_COMPARISON = '2.7449 >= 2.7';
const SUBSTRATE_SHA = 'b5eb3ceda03e05bdee50e22831925c5e0b829926';
const PR311_MERGE_SHA = '3e588bacec2dcc98e5b334314ae630d8b93cd707';
const PR312_MERGE_SHA = 'b5eb3ceda03e05bdee50e22831925c5e0b829926';
const PR311_BOUNDED_SHA = 'ecf32b6116263b3778819d29c2f2392153a123aec1daba91520323df353bce22';
const PR312_BOUNDED_SHA = 'cc798091961a1bfe062f654198d2b74eb8648e975a93ad730676bc84bc0f0c19';
const DETERMINATION = 'PAPER_RUNTIME_CANDIDATE_SMOKE_SCOPE_READY';
const NEXT_TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-PAPER-RUNTIME-CANDIDATE-SMOKE-IMPL-01';
const MAX_ARTIFACT_BYTES = 95 * 1024 * 1024;
const PRIMARY_GUARD_INSERTION_RECOMMENDATION = 'PRIMARY_INSERTION_IN_STRATEGY_RUNTIME_RUNNER_CANDIDATE_LOOP';
const ALTERNATIVE_GUARD_INSERTION_RECOMMENDATION = 'ALTERNATIVE_CALLER_LEVEL_STOP_IN_DEDICATED_PAPER_OBSERVATION_WRAPPER';

const OUT_DIR = path.join(ROOT, 'artifacts', 'paper-observation', SLUG);
const BOUNDED_JSONL = path.join(OUT_DIR, 'bounded-paper-runtime-candidate-smoke-scope.jsonl');
const REPORT_JSON = path.join(OUT_DIR, 'paper-runtime-candidate-smoke-scope-report.json');
const REPORT_MD = path.join(OUT_DIR, 'paper-runtime-candidate-smoke-scope-report.md');
const MEMO_MD = path.join(ROOT, 'docs', 'research', `${SLUG}-memo.md`);
const BACKLOG_CSV = path.join(ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');

const PR311_BOUNDED_JSONL = path.join(
  ROOT,
  'artifacts',
  'paper-observation',
  'v2-pf-c-late-am-paper-observation-2026-06-02-candidate-eligible-snapshot-builder-impl-01',
  'bounded-candidate-eligible-feature-snapshot.jsonl',
);
const PR311_REPORT_JSON = path.join(
  ROOT,
  'artifacts',
  'paper-observation',
  'v2-pf-c-late-am-paper-observation-2026-06-02-candidate-eligible-snapshot-builder-impl-01',
  'candidate-eligible-snapshot-builder-report.json',
);
const PR312_BOUNDED_JSONL = path.join(
  ROOT,
  'artifacts',
  'paper-observation',
  'v2-pf-c-late-am-paper-observation-2026-06-02-candidate-strat-eval-smoke-01',
  'bounded-candidate-strat-eval-smoke.jsonl',
);
const PR312_REPORT_JSON = path.join(
  ROOT,
  'artifacts',
  'paper-observation',
  'v2-pf-c-late-am-paper-observation-2026-06-02-candidate-strat-eval-smoke-01',
  'candidate-strat-eval-smoke-report.json',
);

const RUNTIME_ENTRYPOINT = 'scripts/paper/run-v2-pf-c-late-am-paper-observation.ts';
const REQUIRED_CONFIG_PATH = 'config/paper/v2-pf-c-late-am-paper-observation.yaml';
const PAPER_RUNNER_PATH = 'apps/strategy_runtime/src/paper-trading/paper-trading-runner.ts';
const ORCHESTRATION_RUNNER_PATH = 'apps/strategy_runtime/src/orchestration/runner.ts';

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

function stableJsonl(records: readonly Json[]): string {
  return records.map((record) => JSON.stringify(sortJson(record))).join('\n') + '\n';
}

function parseJsonFile(filePath: string): JsonRecord {
  return JSON.parse(readText(filePath)) as JsonRecord;
}

function assertFileSha(filePath: string, expectedSha: string, label: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
  const actualSha = sha256FileLf(filePath);
  if (actualSha !== expectedSha) {
    throw new Error(`${label} hash mismatch: expected=${expectedSha} actual=${actualSha}`);
  }
  return actualSha;
}

function assertContains(filePath: string, needles: readonly string[], label: string): void {
  const text = readText(path.join(ROOT, filePath));
  const missing = needles.filter((needle) => !text.includes(needle));
  if (missing.length > 0) {
    throw new Error(`${label} missing source symbols: ${missing.join(', ')}`);
  }
}

function appendBacklogRow(): void {
  const row =
    'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-PAPER-RUNTIME-CANDIDATE-SMOKE-SCOPE-01,P1,1.0,V2-PF-C-LATE-AM-PAPER-OBSERVATION-PAPER-RUNTIME-WAVE-1,Scope whether the 2026-06-02 candidate-emitting source-backed snapshot can enter the dedicated paper-runtime path while preserving order-intent broker-live and observation-day suppression,new_cycle4_v2_research_substrate';
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

function markdownTable(rows: readonly JsonRecord[]): string {
  if (rows.length === 0) {
    return '';
  }
  const headers = Object.keys(rows[0]!);
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' |')} |`,
    ...rows.map((row) => `| ${headers.map((header) => `\`${String(row[header])}\``).join(' | ')} |`),
  ].join('\n');
}

function buildReportMarkdown(report: JsonRecord): string {
  return `# ${TICKET}

## Determination

\`\`\`text
${report.determination}
\`\`\`

## Runtime path readiness

${markdownTable(report.runtime_path_readiness as JsonRecord[])}

## Suppression boundary

${markdownTable(report.order_candidate_suppression_boundary as JsonRecord[])}

## Guard insertion point

${markdownTable(report.guard_insertion_points as JsonRecord[])}

## Next implementation authority contract

${markdownTable(report.next_impl_authority_contract as JsonRecord[])}

## Next implementation success criteria

${markdownTable(report.next_impl_success_criteria as JsonRecord[])}

## Required next implementation guardrails

${markdownTable(report.required_guardrails as JsonRecord[])}

## PR anchors

| Anchor | Value |
|---|---|
| PR #311 merge SHA | \`${PR311_MERGE_SHA}\` |
| PR #311 bounded JSONL SHA | \`${PR311_BOUNDED_SHA}\` |
| PR #312 merge SHA | \`${PR312_MERGE_SHA}\` |
| PR #312 bounded JSONL SHA | \`${PR312_BOUNDED_SHA}\` |
| feature_snapshot_id | \`${FEATURE_SNAPSHOT_ID}\` |
| timestamp_utc | \`${TARGET_TS_UTC}\` |
| strategy_id | \`${STRATEGY_ID}\` |

## Recommended next ticket

\`\`\`text
${report.recommended_next_ticket}
\`\`\`

${report.recommended_next_ticket_reason}
`;
}

function buildMemo(report: JsonRecord): string {
  return `# ${TICKET} memo

## Summary

\`\`\`text
${report.determination}
\`\`\`

This scope diagnostic verifies that the PR #311/#312 candidate-emitting source-backed snapshot has a viable dedicated paper-runtime entry path, but the next implementation must add a bounded suppression guard before invoking a candidate-capable runtime cycle. Current runtime code proceeds from candidate event publication into ranking, sizing, risk, and order-intent creation when risk passes.

## Required answers

${markdownTable(report.required_question_answers as JsonRecord[])}

## Suppression boundary

${markdownTable(report.order_candidate_suppression_boundary as JsonRecord[])}

## Guard insertion point

${markdownTable(report.guard_insertion_points as JsonRecord[])}

## Next implementation contract

${markdownTable(report.next_impl_authority_contract as JsonRecord[])}

## Success criteria for next implementation

${markdownTable(report.next_impl_success_criteria as JsonRecord[])}

## Authority caveat

This ticket does not run full paper observation, does not emit ORDER_INTENT, does not invoke order translation, order adapter, broker adapter, qfa-410b, qfa-611, Phase 6, active/candidate roster mutation, global regime-label mutation, paper/live/broker authority, or observation-day credit.

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

  const pr311BoundedSha = assertFileSha(PR311_BOUNDED_JSONL, PR311_BOUNDED_SHA, 'PR #311 bounded snapshot JSONL');
  const pr312BoundedSha = assertFileSha(PR312_BOUNDED_JSONL, PR312_BOUNDED_SHA, 'PR #312 bounded smoke JSONL');
  const pr311Report = parseJsonFile(PR311_REPORT_JSON);
  const pr312Report = parseJsonFile(PR312_REPORT_JSON);

  assertContains(RUNTIME_ENTRYPOINT, [
    'resolveV2PfCLateAmPaperObservationConfig',
    'createV2PfCLateAmPaperObservationSession',
    'explicit_strategy_ids',
    'adapter_kind !== \'mock\'',
  ], 'dedicated paper observation entrypoint');
  assertContains(PAPER_RUNNER_PATH, [
    'processFeatureSnapshot',
    'sourceQuoteEventForSnapshot',
    'local_obs_replay shadow mode requires QFA_BROKER_ADAPTER_KIND=mock',
    'new StrategyRuntimeRunner',
    'paper_observation_explicit_strategy_ids',
  ], 'paper trading runner');
  assertContains(ORCHESTRATION_RUNNER_PATH, [
    'paper_observation_explicit_strategy_ids may only be used with runtime_mode=paper',
    'evaluateStrategySafely',
    "type: 'CANDIDATE'",
    'sizeCandidate',
    'createEntryOrderIntent',
  ], 'strategy runtime runner');
  assertContains(REQUIRED_CONFIG_PATH, [
    'strategy_id: regime_shock_reversion_short_v2_utc_16_18_exclusion',
    'adapter_kind: mock',
    'live_account_allowlist: []',
    'authority_created: false',
  ], 'dedicated paper config');

  const runtimePathReadiness: JsonRecord[] = [
    {
      check: 'paper_runtime_path_status',
      status: 'READY_WITH_REQUIRED_ORDER_SUPPRESSION_GUARD',
      source_path: RUNTIME_ENTRYPOINT,
      evidence: 'createV2PfCLateAmPaperObservationSession resolves single explicit registered-inactive strategy with mock adapter',
    },
    {
      check: 'snapshot_ingest_status',
      status: 'READY',
      source_path: PAPER_RUNNER_PATH,
      evidence: 'PaperTradingSession.processFeatureSnapshot publishes sourceQuoteEventForSnapshot then calls StrategyRuntimeRunner.processFeatureSnapshot',
    },
    {
      check: 'strategy_eval_path_status',
      status: 'READY',
      source_path: ORCHESTRATION_RUNNER_PATH,
      evidence: 'StrategyRuntimeRunner uses paper_observation_explicit_strategy_ids under runtime_mode=paper and evaluateStrategySafely',
    },
    {
      check: 'candidate_emission_expected',
      status: 'READY',
      source_path: PR312_REPORT_JSON.replace(`${ROOT}${path.sep}`, ''),
      evidence: 'PR #312 proved STRAT_EVAL=1 and CANDIDATE=1 for the source-backed 19:05Z snapshot',
    },
    {
      check: 'order_translation_boundary',
      status: 'REQUIRES_NEXT_TICKET_GUARD',
      source_path: ORCHESTRATION_RUNNER_PATH,
      evidence: 'The full runtime cycle continues to sizeCandidate, evaluateRiskGate, and createEntryOrderIntent for passing ranked candidates',
    },
  ];

  const suppressionBoundary: JsonRecord[] = [
    {
      boundary: 'candidate_persistence_begins',
      allowed_this_ticket: false,
      next_impl_policy: 'allow_bounded_CANDIDATE_marker_only',
      source_path: ORCHESTRATION_RUNNER_PATH,
      source_symbol: 'StrategyRuntimeRunner.processFeatureSnapshot publishes CANDIDATE event when result.candidate exists',
    },
    {
      boundary: 'order_translation_begins',
      allowed_this_ticket: false,
      next_impl_policy: 'must_stop_before_createEntryOrderIntent_or_force_explicit_candidate_only_mode',
      source_path: ORCHESTRATION_RUNNER_PATH,
      source_symbol: 'createEntryOrderIntent(...) after rank, sizing, and risk pass',
    },
    {
      boundary: 'order_adapter_begins',
      allowed_this_ticket: false,
      next_impl_policy: 'ORDER_INTENT subscription must not receive events in smoke',
      source_path: PAPER_RUNNER_PATH,
      source_symbol: 'PaperTradingSession subscribes ORDER_INTENT events to BrokerAdapterRuntimeIntegration.handleOrderIntent',
    },
    {
      boundary: 'broker_adapter',
      allowed_this_ticket: false,
      next_impl_policy: 'mock adapter only; no rithmic broker/live adapter',
      source_path: REQUIRED_CONFIG_PATH,
      source_symbol: 'adapter_kind: mock; live_account_allowlist: []',
    },
    {
      boundary: 'observation_day_credit',
      allowed_this_ticket: false,
      next_impl_policy: 'observation_day_eligible=false and observation_day_increment=0 until separate full-duration criteria',
      source_path: 'dispatch guardrail',
      source_symbol: 'scope-only diagnostic authority lock',
    },
  ];

  const guardInsertionPoints: JsonRecord[] = [
    {
      recommendation: PRIMARY_GUARD_INSERTION_RECOMMENDATION,
      guard_insertion_repo_path: ORCHESTRATION_RUNNER_PATH,
      guard_insertion_symbol_or_function: 'StrategyRuntimeRunner.processFeatureSnapshot(...) ranked candidate loop',
      stop_before_symbol_or_function: 'createEntryOrderIntent(...)',
      allowed_marker_before_stop: 'CANDIDATE',
      disallowed_marker_after_stop: 'ORDER_INTENT',
      rationale: 'The current full runtime cycle publishes CANDIDATE, then rank/sizing/risk, then createEntryOrderIntent when risk passes; a candidate-only smoke needs to stop before order translation.',
    },
    {
      recommendation: ALTERNATIVE_GUARD_INSERTION_RECOMMENDATION,
      guard_insertion_repo_path: RUNTIME_ENTRYPOINT,
      guard_insertion_symbol_or_function: 'dedicated v2 paper-observation wrapper / next smoke harness',
      stop_before_symbol_or_function: 'PaperTradingSession.processFeatureSnapshot(...) full-cycle order-translation continuation',
      allowed_marker_before_stop: 'CANDIDATE',
      disallowed_marker_after_stop: 'ORDER_INTENT',
      rationale: 'Caller-level harness can be used if the next ticket adds a bounded candidate-only runtime method or instrumentation seam without broadening general runtime authority.',
    },
  ];

  const nextImplAuthorityContract: JsonRecord[] = [
    {
      field: 'next_impl_allowed_to_emit_STRAT_EVAL',
      value: true,
      reason: 'candidate smoke must prove strategy evaluation in paper-runtime path',
    },
    {
      field: 'next_impl_allowed_to_emit_CANDIDATE',
      value: true,
      reason: 'candidate smoke must prove bounded candidate marker emission',
    },
    {
      field: 'next_impl_must_emit_ORDER_INTENT',
      value: false,
      reason: 'ORDER_INTENT is outside the candidate smoke authority boundary',
    },
    {
      field: 'next_impl_must_not_call_order_translation',
      value: true,
      reason: 'must stop before createEntryOrderIntent(...)',
    },
    {
      field: 'next_impl_must_not_call_order_adapter',
      value: true,
      reason: 'ORDER_INTENT subscription must not drive adapter handling',
    },
    {
      field: 'next_impl_must_not_call_broker_adapter',
      value: true,
      reason: 'broker/live and adapter side effects remain unauthorized',
    },
    {
      field: 'next_impl_observation_day_eligible',
      value: false,
      reason: 'bounded smoke is not a full observation day',
    },
    {
      field: 'next_impl_observation_day_increment',
      value: 0,
      reason: 'bounded smoke must not alter 45/60 day accounting',
    },
  ];

  const nextImplSuccessCriteria: JsonRecord[] = [
    {
      criterion: 'source_backed_snapshot_ingested',
      expected: 'exactly_one',
    },
    {
      criterion: 'STRAT_EVAL_count',
      expected: 1,
    },
    {
      criterion: 'CANDIDATE_count',
      expected: 1,
    },
    {
      criterion: 'ORDER_INTENT_count',
      expected: 0,
    },
    {
      criterion: 'rank_sizing_risk_order_translation_side_effects',
      expected: 'none_beyond_candidate_marker',
    },
    {
      criterion: 'observation_day_credit',
      expected: 'false_eligible_zero_increment',
    },
  ];

  const requiredGuardrails: JsonRecord[] = [
    {
      guardrail: 'runtime_entrypoint',
      requirement: 'use dedicated wrapper/config only',
      value: RUNTIME_ENTRYPOINT,
    },
    {
      guardrail: 'required_config_path',
      requirement: 'mock adapter and explicit single strategy',
      value: REQUIRED_CONFIG_PATH,
    },
    {
      guardrail: 'market_data_or_snapshot_ingest',
      requirement: 'use PR #311 source-backed snapshot fixture; no live broker/capture dependency',
      value: FEATURE_SNAPSHOT_ID,
    },
    {
      guardrail: 'candidate_only_runtime_stop',
      requirement: 'next impl must stop before order translation or add explicit candidate-only/suppress-order-intent guard',
      value: PRIMARY_GUARD_INSERTION_RECOMMENDATION,
    },
    {
      guardrail: 'order_intent',
      requirement: 'ORDER_INTENT_count must remain 0',
      value: false,
    },
    {
      guardrail: 'observation_day_credit',
      requirement: 'observation_day_eligible=false; observation_day_increment=0',
      value: false,
    },
  ];

  const requiredQuestionAnswers: JsonRecord[] = [
    {
      question: 'Can the dedicated PR #291 paper-observation runtime path ingest the PR #311 source-backed snapshot?',
      answer: 'yes_with_processFeatureSnapshot_ingest',
      evidence: 'PaperTradingSession.processFeatureSnapshot accepts StrategyFeatureSnapshot and publishes a source QUOTE event before runtime evaluation',
    },
    {
      question: 'Can it invoke the strategy-evaluation path and preserve the PR #312 candidate result?',
      answer: 'yes_expected_with_explicit_strategy_id',
      evidence: 'The paper runner passes paper_observation_explicit_strategy_ids into StrategyRuntimeRunner, and PR #312 proved the same snapshot emits candidate through the strategy generator',
    },
    {
      question: 'Where does candidate persistence begin, if any?',
      answer: 'CANDIDATE_event_publication_inside_StrategyRuntimeRunner.processFeatureSnapshot',
      evidence: 'Candidate event is published immediately after STRAT_EVAL when result.candidate exists',
    },
    {
      question: 'Where does order translation begin?',
      answer: 'createEntryOrderIntent_after_rank_sizing_and_risk_pass',
      evidence: 'Current full runtime cycle proceeds into sizing/risk and calls createEntryOrderIntent for passing ranked candidates',
    },
    {
      question: 'What switches/guards keep ORDER_INTENT, adapter calls, broker/live, and observation-day credit suppressed?',
      answer: 'next_impl_requires_candidate_only_or_stop_before_order_translation_guard_plus_mock_adapter_and_zero_credit_locks',
      evidence: 'No such bounded candidate-only runtime guard is executed in this scope ticket; it must be implemented before the next smoke runs',
    },
    {
      question: 'What must be implemented next?',
      answer: NEXT_TICKET,
      evidence: 'Implement bounded paper-runtime candidate smoke with explicit candidate marker allowance and ORDER_INTENT/order adapter/broker suppression',
    },
  ];

  const records: Json[] = [
    {
      record_type: 'PR_ANCHORS',
      feature_snapshot_id: FEATURE_SNAPSHOT_ID,
      pr311_bounded_lf_sha256: pr311BoundedSha,
      pr311_merge_sha: PR311_MERGE_SHA,
      pr312_bounded_lf_sha256: pr312BoundedSha,
      pr312_merge_sha: PR312_MERGE_SHA,
      ticket: TICKET,
    },
    {
      record_type: 'RUNTIME_PATH_READINESS',
      rows: runtimePathReadiness,
      ticket: TICKET,
    },
    {
      record_type: 'SUPPRESSION_BOUNDARY',
      rows: suppressionBoundary,
      ticket: TICKET,
    },
    {
      record_type: 'GUARD_INSERTION_POINTS',
      rows: guardInsertionPoints,
      ticket: TICKET,
    },
    {
      record_type: 'NEXT_IMPL_AUTHORITY_CONTRACT',
      rows: nextImplAuthorityContract,
      ticket: TICKET,
    },
    {
      record_type: 'NEXT_IMPL_SUCCESS_CRITERIA',
      rows: nextImplSuccessCriteria,
      ticket: TICKET,
    },
    {
      record_type: 'REQUIRED_GUARDRAILS',
      rows: requiredGuardrails,
      ticket: TICKET,
    },
    {
      record_type: 'DETERMINATION',
      determination: DETERMINATION,
      recommended_next_ticket: NEXT_TICKET,
      ticket: TICKET,
    },
  ];

  writeFileSync(BOUNDED_JSONL, stableJsonl(records), 'utf8');
  const boundedSha = sha256FileLf(BOUNDED_JSONL);

  const report: JsonRecord = {
    broker_adapter_allowed: false,
    broker_live_authorized: false,
    bounded_paper_runtime_candidate_smoke_scope_lf_sha256: boundedSha,
    candidate_emission_expected: true,
    candidate_persistence_allowed: false,
    candidate_snapshot_anchor: {
      candidate_emission_reason: 'BASE_PREDICATES_PASS_AND_NON_EXCLUDED_BY_UTC_GATE',
      entry_hour_utc: TARGET_ENTRY_HOUR_UTC,
      feature_snapshot_id: FEATURE_SNAPSHOT_ID,
      signed_shock_vwap: SIGNED_SHOCK_VWAP,
      strategy_id: STRATEGY_ID,
      threshold: LOW_SHOCK_THRESHOLD_POS,
      threshold_comparison: THRESHOLD_COMPARISON,
      timestamp_ns: TARGET_TS_NS,
      timestamp_utc: TARGET_TS_UTC,
      utc_gate_status: UTC_GATE_STATUS,
    },
    candidate_strat_eval_smoke_anchor: {
      CANDIDATE_count: pr312Report.CANDIDATE_count,
      ORDER_INTENT_count: pr312Report.ORDER_INTENT_count,
      STRAT_EVAL_count: pr312Report.STRAT_EVAL_count,
      determination: pr312Report.determination,
      order_intent_suppression_reason: pr312Report.order_intent_suppression_reason,
    },
    determination: DETERMINATION,
    feature_snapshot_builder_anchor: {
      determination: pr311Report.determination,
      feature_snapshot_id: pr311Report.feature_snapshot_id,
    },
    guard_insertion_points: guardInsertionPoints,
    guard_insertion_primary_recommendation: PRIMARY_GUARD_INSERTION_RECOMMENDATION,
    next_impl_allowed_to_emit_CANDIDATE: true,
    next_impl_allowed_to_emit_STRAT_EVAL: true,
    next_impl_authority_contract: nextImplAuthorityContract,
    next_impl_must_emit_ORDER_INTENT: false,
    next_impl_must_not_call_broker_adapter: true,
    next_impl_must_not_call_order_adapter: true,
    next_impl_must_not_call_order_translation: true,
    next_impl_observation_day_eligible: false,
    next_impl_observation_day_increment: 0,
    next_impl_success_criteria: nextImplSuccessCriteria,
    observation_day_eligible: false,
    observation_day_increment: 0,
    order_adapter_allowed: false,
    order_translation_allowed: false,
    paper_live_broker_phase6_roster_authority: 'unchanged',
    paper_runtime_path_status: 'READY_WITH_REQUIRED_ORDER_SUPPRESSION_GUARD',
    qfa_410b_or_qfa_611_run: false,
    recommended_next_ticket: NEXT_TICKET,
    recommended_next_ticket_reason:
      'Implement a bounded paper-runtime candidate smoke that allows STRAT_EVAL and CANDIDATE markers from the PR #311 source-backed snapshot while adding an explicit guard to stop before order translation, ORDER_INTENT publication, adapter calls, broker/live dispatch, fills, and observation-day accounting.',
    required_config_path: REQUIRED_CONFIG_PATH,
    required_guardrails: requiredGuardrails,
    required_question_answers: requiredQuestionAnswers,
    required_runtime_entrypoint: RUNTIME_ENTRYPOINT,
    runtime_path_readiness: runtimePathReadiness,
    snapshot_ingest_status: 'READY_VIA_PAPER_TRADING_SESSION_PROCESS_FEATURE_SNAPSHOT',
    strategy_eval_path_status: 'READY_VIA_STRATEGY_RUNTIME_RUNNER_PROCESS_FEATURE_SNAPSHOT',
    order_candidate_suppression_boundary: suppressionBoundary,
    substrate_sha: SUBSTRATE_SHA,
    ticket: TICKET,
  };

  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  writeFileSync(REPORT_MD, buildReportMarkdown(report), 'utf8');
  writeFileSync(MEMO_MD, buildMemo(report), 'utf8');
  appendBacklogRow();
  assertArtifactSizes([BOUNDED_JSONL, REPORT_JSON, REPORT_MD, MEMO_MD]);

  const output = {
    bounded_paper_runtime_candidate_smoke_scope_lf_sha256: boundedSha,
    determination: DETERMINATION,
    memo_lf_sha256: sha256FileLf(MEMO_MD),
    recommended_next_ticket: NEXT_TICKET,
    report_json_lf_sha256: sha256FileLf(REPORT_JSON),
    report_md_lf_sha256: sha256FileLf(REPORT_MD),
    snapshot_ingest_status: report.snapshot_ingest_status,
    strategy_eval_path_status: report.strategy_eval_path_status,
  };
  console.log(JSON.stringify(output, null, 2));
}

main();
