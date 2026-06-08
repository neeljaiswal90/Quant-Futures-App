import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FULL-SESSION-RUNTIME-SCOPE-01';
const SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-04-full-session-runtime-scope-01';
const SUBSTRATE_SHA = '5574b950782bea9bb41cc36312ee67f0136700b3';
const DETERMINATION = 'FULL_SESSION_RUNTIME_SCOPE_READY_FOR_IMPL';
const NEXT_TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FULL-SESSION-RUNTIME-IMPL-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const FEATURE_SNAPSHOT_ID = 'feature-v2pf-20260604-1780585080000000000';

const OUT_DIR = path.join(ROOT, 'artifacts', 'paper-observation', SLUG);
const BOUNDED_JSONL = path.join(OUT_DIR, 'bounded-full-session-runtime-scope.jsonl');
const REPORT_JSON = path.join(OUT_DIR, 'full-session-runtime-scope-report.json');
const REPORT_MD = path.join(OUT_DIR, 'full-session-runtime-scope-report.md');
const MEMO_MD = path.join(ROOT, 'docs', 'research', `${SLUG}-memo.md`);
const BACKLOG_CSV = path.join(ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');

const SOURCE_REPORTS = [
  { pr: 320, label: 'local_capture_source_readiness_2026_06_04', path: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-04-local-capture-source-readiness-01/local-capture-source-readiness-report.json' },
  { pr: 322, label: 'feature_snapshot_compat_repair', path: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-04-feature-snapshot-builder-compat-repair-01/feature-snapshot-builder-compat-repair-report.json' },
  { pr: 323, label: 'candidate_strat_eval_smoke_rerun', path: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-04-candidate-strat-eval-smoke-rerun-01/candidate-strat-eval-smoke-rerun-report.json' },
  { pr: 325, label: 'paper_runtime_candidate_smoke_impl', path: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-04-paper-runtime-candidate-smoke-impl-01/paper-runtime-candidate-smoke-impl-report.json' },
  { pr: 326, label: 'paper_runtime_observation_day_scope', path: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-04-paper-runtime-observation-day-scope-01/paper-runtime-observation-day-scope-report.json' },
] as const;

type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json };
type JsonRecord = { readonly [key: string]: Json };

function ensureDir(dir: string): void { mkdirSync(dir, { recursive: true }); }
function readText(filePath: string): string { return readFileSync(filePath, 'utf8'); }
function lfText(text: string): string { return text.replace(/\r\n/g, '\n'); }
function sha256Text(text: string): string { return createHash('sha256').update(lfText(text), 'utf8').digest('hex'); }
function sha256FileLf(filePath: string): string { return sha256Text(readText(filePath)); }
function sortJson(value: Json): Json { if (Array.isArray(value)) return value.map((item) => sortJson(item)); if (value !== null && typeof value === 'object') { const output: Record<string, Json> = {}; for (const key of Object.keys(value).sort()) output[key] = sortJson(value[key]); return output; } return value; }
function stableJson(value: Json): string { return `${JSON.stringify(sortJson(value), null, 2)}\n`; }
function stableJsonl(records: readonly Json[]): string { return `${records.map((record) => JSON.stringify(sortJson(record))).join('\n')}\n`; }
function parseJsonFile(filePath: string): JsonRecord { return JSON.parse(readText(filePath)) as JsonRecord; }
function jsonRecord(value: Json | undefined, field: string): JsonRecord { if (value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord; throw new Error(`Missing object field ${field}`); }
function numberFrom(record: JsonRecord, key: string): number { const value = record[key]; if (typeof value === 'number') return value; throw new Error(`Missing numeric field ${key}`); }
function stringFrom(record: JsonRecord, key: string): string { const value = record[key]; if (typeof value === 'string') return value; throw new Error(`Missing string field ${key}`); }
function boolFrom(record: JsonRecord, key: string): boolean { const value = record[key]; if (typeof value === 'boolean') return value; throw new Error(`Missing boolean field ${key}`); }
function appendBacklogRow(): void {
  const row = [TICKET, 'P1', '1.0', 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-PAPER-RUNTIME-OBSERVATION-DAY-SCOPE-01', 'Scope the minimum bounded 2026-06-04 full-session paper-runtime evidence contract required before observation-day accounting implementation may be authorized without order broker live Phase 6 roster or observation-credit authority', 'new_cycle4_v2_research_substrate'].join(',');
  const current = readText(BACKLOG_CSV);
  if (!current.includes(`${TICKET},`)) writeFileSync(BACKLOG_CSV, `${current.trimEnd()}\n${row}\n`, 'utf8');
}

function main(): void {
  ensureDir(OUT_DIR);
  const sourceAnchors: Json[] = SOURCE_REPORTS.map((source) => { const absolutePath = path.join(ROOT, source.path); if (!existsSync(absolutePath)) throw new Error(`Missing source report: ${source.path}`); return { pr: source.pr, label: source.label, path: source.path, lf_sha256: sha256FileLf(absolutePath), size_bytes: statSync(absolutePath).size }; });

  const pr320 = parseJsonFile(path.join(ROOT, SOURCE_REPORTS[0].path));
  const pr325 = parseJsonFile(path.join(ROOT, SOURCE_REPORTS[3].path));
  const pr326 = parseJsonFile(path.join(ROOT, SOURCE_REPORTS[4].path));
  const readiness = jsonRecord(pr320.source_readiness, 'pr320.source_readiness');
  const candidate = jsonRecord(pr320.candidate_feasibility, 'pr320.candidate_feasibility');
  const pr325Counts = jsonRecord(pr325.counts, 'pr325.counts');
  const pr326Contract = jsonRecord(pr326.evidence_contract, 'pr326.evidence_contract');

  if (numberFrom(readiness, 'accounting_slots_expected') !== 390) throw new Error('PR #320 accounting slots expected is not 390');
  if (numberFrom(readiness, 'source_ready_slots') !== 390) throw new Error('PR #320 source ready slots is not 390');
  if (numberFrom(readiness, 'feature_computable_slots') !== 377) throw new Error('PR #320 feature computable slots is not 377');
  if (numberFrom(readiness, 'warmup_excluded_slots') !== 13) throw new Error('PR #320 warmup excluded slots is not 13');
  if (numberFrom(pr325Counts, 'STRAT_EVAL') !== 1 || numberFrom(pr325Counts, 'CANDIDATE') !== 1 || numberFrom(pr325Counts, 'ORDER_INTENT') !== 0) throw new Error('PR #325 candidate runtime counts are not 1/1/0');
  if (boolFrom(pr326Contract, 'candidate_only_smoke_sufficient_for_day_credit') !== false) throw new Error('PR #326 did not reject candidate-only day credit');

  const windowContract: JsonRecord = {
    observation_window_start_utc: stringFrom(readiness, 'observation_window_start_utc'),
    observation_window_end_utc: stringFrom(readiness, 'observation_window_end_utc'),
    window_basis: '2026-06-04-rth',
    snapshot_cadence_basis: 'one closed 1m accounting slot from 13:30:00Z inclusive to 20:00:00Z exclusive',
    accounting_slots_expected: 390,
    rth_window_minutes: 390,
    source_ready_slots_required: 390,
    source_ready_slots_anchor: numberFrom(readiness, 'source_ready_slots'),
    warmup_excluded_slots_expected: 13,
    warmup_exclusion_basis: 'ATR14/signed-shock warmup established by PR #320 local-capture source readiness',
    feature_computable_slots_required: 377,
    expected_snapshot_count_formula: '390 accounting slots - 13 warmup-excluded slots = 377 source-backed feature-computable snapshots',
    source_backed_feature_snapshot_count_required: 377,
    actual_required_snapshot_count_basis: 'full RTH accounting window with explicit warmup exclusions; not a partial source window',
    full_session_claim_valid: true,
    full_session_claim_valid_reason: 'The contract preserves all 390 accounting slots while requiring 377 feature-computable snapshots plus explicit reporting for the 13 warmup-excluded slots.',
    paper_runtime_entrypoint_or_harness: 'PaperTradingSession.processFeatureSnapshot(...) loop over bounded 2026-06-04 source-backed snapshots, or a dedicated script harness that constructs StrategyRuntimeRunner with the same paper-only guard contract',
    strategy_id: STRATEGY_ID,
    paper_observation_explicit_strategy_ids_required: true,
    paper_observation_stop_after_candidate_required: true,
    implementation_must_not_run_order_path: true,
  };
  const runtimeMarkerRequirements: JsonRecord = {
    SESSION_MANIFEST_required: true,
    FEATURE_SNAPSHOT_INGEST_or_equivalent_required: true,
    STRAT_EVAL_markers_required: true,
    CANDIDATE_markers_allowed: true,
    CANDIDATE_markers_expected_when_strategy_predicates_pass: true,
    ORDER_INTENT_must_remain: 0,
    RANK_must_remain: 0,
    SIZING_must_remain: 0,
    RISK_GATE_must_remain: 0,
    SIM_FILL_must_remain: 0,
    POSITION_must_remain: 0,
  };
  const sourceStack: JsonRecord = {
    source_backed_feature_snapshot_path_exists: true,
    local_capture_source_ready: true,
    source_file: stringFrom(readiness, 'source_file'),
    accounting_slots_expected: numberFrom(readiness, 'accounting_slots_expected'),
    rth_trade_slots_present: numberFrom(readiness, 'rth_trade_slots_present'),
    rth_trade_slots_missing: numberFrom(readiness, 'rth_trade_slots_missing'),
    source_ready_slots: numberFrom(readiness, 'source_ready_slots'),
    feature_computable_slots: numberFrom(readiness, 'feature_computable_slots'),
    warmup_excluded_slots: numberFrom(readiness, 'warmup_excluded_slots'),
    candidate_eligible_non_excluded_point_exists: numberFrom(candidate, 'candidate_eligible_non_excluded_points') > 0,
    candidate_eligible_non_excluded_points: numberFrom(candidate, 'candidate_eligible_non_excluded_points'),
    candidate_point_timestamp_utc: stringFrom(candidate, 'best_or_first_candidate_eligible_non_excluded_timestamp_utc'),
    candidate_point_timestamp_ns: stringFrom(candidate, 'timestamp_ns'),
    candidate_point_entry_hour_utc: numberFrom(candidate, 'entry_hour_utc'),
    candidate_point_signed_shock_vwap: numberFrom(candidate, 'signed_shock_vwap'),
    candidate_point_threshold_comparison: stringFrom(candidate, 'threshold_comparison_result'),
    session_vwap_ready: boolFrom(readiness, 'session_vwap_ready'),
    atr14_ready: boolFrom(readiness, 'atr14_ready'),
    signed_shock_vwap_source_ready: boolFrom(readiness, 'signed_shock_vwap_ready'),
    scoped_regime_label_ready: boolFrom(readiness, 'scoped_regime_label_ready'),
    halt_roll_calendar_ready: boolFrom(readiness, 'session_is_halt_ready') && boolFrom(readiness, 'session_is_roll_block_ready'),
  };
  const guardBehavior: JsonRecord = {
    primary_guard_repo_path: 'apps/strategy_runtime/src/orchestration/runner.ts',
    primary_guard_symbol_or_function: 'StrategyRuntimeRunner.processFeatureSnapshot(...)',
    paper_session_entry_repo_path: 'apps/strategy_runtime/src/paper-trading/paper-trading-runner.ts',
    paper_session_entry_symbol_or_function: 'PaperTradingSession.processFeatureSnapshot(...)',
    explicit_strategy_ids_wire_path: 'PaperTradingSession config explicit_strategy_ids -> StrategyRuntimeRunner paper_observation_explicit_strategy_ids',
    stop_after_candidate_guard_required: true,
    stop_after_candidate_guard_source_anchor: 'PR #325 paper_observation_stop_after_candidate=true; default_enabled=false; runtime_mode=paper required; explicit strategy ids required',
    stop_before: 'rankCandidates(...), sizing/risk, createEntryOrderIntent(...), order adapter, broker adapter, fill handling',
  };
  const observationAccountingLocks: JsonRecord = {
    observation_day_eligible: false,
    observation_day_increment: 0,
    implementation_authorized_by_this_ticket: false,
    full_session_runtime_run_performed_by_this_ticket: false,
    ORDER_INTENT_authorized: false,
    order_translation_authorized: false,
    order_adapter_authorized: false,
    broker_adapter_authorized: false,
    paper_fill_authorized: false,
    qfa_410b_or_qfa_611_authorized: false,
    active_candidate_roster_mutation_authorized: false,
    broker_live_authorized: false,
    phase_6_authorized: false,
  };
  const nextImplementationSuccessCriteria: JsonRecord = {
    accounting_slots_expected: 390,
    source_ready_slots_expected: 390,
    warmup_excluded_slots_expected: 13,
    source_backed_snapshots_ingested_expected: 377,
    missing_source_slots_expected: 0,
    STRAT_EVAL_count_minimum: 1,
    CANDIDATE_count: 'allowed and expected when predicates pass; report exact count',
    ORDER_INTENT_count: 0,
    RANK_count: 0,
    SIZING_count: 0,
    RISK_GATE_count: 0,
    SIM_FILL_count: 0,
    POSITION_count: 0,
    observation_day_eligible: false,
    observation_day_increment: 0,
    no_order_translation_adapter_broker_or_fill_side_effects: true,
  };

  const boundedRecords: Json[] = [
    { record_type: 'SOURCE_CHAIN_ANCHORS', ticket: TICKET, substrate_sha: SUBSTRATE_SHA, source_anchors: sourceAnchors },
    { record_type: 'FULL_SESSION_RUNTIME_SCOPE_CONTRACT', ticket: TICKET, determination: DETERMINATION, source_stack: sourceStack, window_contract: windowContract, runtime_marker_requirements: runtimeMarkerRequirements, guard_behavior: guardBehavior, observation_accounting_locks: observationAccountingLocks, next_implementation_success_criteria: nextImplementationSuccessCriteria },
  ];
  writeFileSync(BOUNDED_JSONL, stableJsonl(boundedRecords), 'utf8');
  const boundedSha = sha256FileLf(BOUNDED_JSONL);
  const report: JsonRecord = { ticket: TICKET, determination: DETERMINATION, substrate_sha: SUBSTRATE_SHA, source_anchors: sourceAnchors, source_stack: sourceStack, prior_results: { pr325: { determination: stringFrom(pr325, 'determination'), STRAT_EVAL: numberFrom(pr325Counts, 'STRAT_EVAL'), CANDIDATE: numberFrom(pr325Counts, 'CANDIDATE'), ORDER_INTENT: numberFrom(pr325Counts, 'ORDER_INTENT') }, pr326: { determination: stringFrom(pr326, 'determination'), candidate_only_smoke_sufficient_for_day_credit: boolFrom(pr326Contract, 'candidate_only_smoke_sufficient_for_day_credit'), full_session_runtime_manifest_required: boolFrom(pr326Contract, 'full_session_runtime_manifest_required') } }, window_contract: windowContract, runtime_marker_requirements: runtimeMarkerRequirements, guard_behavior: guardBehavior, observation_accounting_locks: observationAccountingLocks, next_implementation_success_criteria: nextImplementationSuccessCriteria, ready_for_impl_meaning: 'Ready means the full-session/window evidence contract and runtime guard requirements are scoped. It does not mean the full-session run has occurred or that observation-day credit is authorized.', bounded_artifact_size_bytes: statSync(BOUNDED_JSONL).size, recommended_next_ticket: NEXT_TICKET };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  const reportSha = sha256FileLf(REPORT_JSON);
  const md = `# ${TICKET}\n\nDetermination: \`${DETERMINATION}\`\n\n## Scope decision\n\nThis ticket scopes the minimum bounded 2026-06-04 full-session/window paper-runtime evidence contract. It does not run the full session and does not authorize observation-day credit.\n\n## Window contract\n\n| Field | Value |\n|---|---|\n| observation_window_start_utc | \`${windowContract.observation_window_start_utc}\` |\n| observation_window_end_utc | \`${windowContract.observation_window_end_utc}\` |\n| window_basis | \`${windowContract.window_basis}\` |\n| accounting_slots_expected | \`390\` |\n| source_ready_slots_required | \`390\` |\n| warmup_excluded_slots_expected | \`13\` |\n| feature_computable_slots_required | \`377\` |\n| expected_snapshot_count_formula | \`${windowContract.expected_snapshot_count_formula}\` |\n| full_session_claim_valid | \`true\` |\n\n## Runtime marker requirements\n\n| Marker/class | Requirement |\n|---|---|\n| SESSION_MANIFEST | required |\n| FEATURE_SNAPSHOT_INGEST or equivalent | required |\n| STRAT_EVAL | required |\n| CANDIDATE | allowed/expected when predicates pass |\n| ORDER_INTENT | must remain \`0\` |\n| RANK / SIZING / RISK_GATE | must remain \`0\` with stop-after-candidate guard active |\n| SIM_FILL / POSITION | must remain \`0\` |\n\n## Source stack\n\n| Field | Value |\n|---|---|\n| source_ready_slots | \`${sourceStack.source_ready_slots}\` |\n| feature_computable_slots | \`${sourceStack.feature_computable_slots}\` |\n| warmup_excluded_slots | \`${sourceStack.warmup_excluded_slots}\` |\n| candidate_eligible_non_excluded_points | \`${sourceStack.candidate_eligible_non_excluded_points}\` |\n| candidate point | \`${sourceStack.candidate_point_timestamp_utc}\` |\n| candidate signed_shock_vwap | \`${sourceStack.candidate_point_signed_shock_vwap}\` |\n\n## Authority locks\n\nObservation-day eligibility remains \`false\` and increment remains \`0\`. No ORDER_INTENT, order translation, adapter, broker, fill, qfa-410b/qfa-611, roster, broker/live, or Phase 6 authority is created.\n\n## Output hashes\n\n| Artifact | LF SHA-256 |\n|---|---|\n| bounded JSONL | \`${boundedSha}\` |\n| report JSON | \`${reportSha}\` |\n\nRecommended next ticket: \`${NEXT_TICKET}\`\n`;
  writeFileSync(REPORT_MD, md, 'utf8');
  const reportMdSha = sha256FileLf(REPORT_MD);
  const memo = `# ${TICKET} memo\n\nDetermination: \`${DETERMINATION}\`\n\nThis ticket defines the bounded 2026-06-04 full-session/window paper-runtime evidence contract. It does not run the full session, emit order intent, or increment observation-day credit.\n\nContract: 390 RTH accounting slots from \`13:30:00Z\` inclusive to \`20:00:00Z\` exclusive. PR #320 proves \`source_ready_slots = 390\`, \`warmup_excluded_slots = 13\`, and \`feature_computable_slots = 377\`; therefore the next implementation should ingest 377 source-backed feature snapshots while reporting all 390 accounting slots and the 13 warmup exclusions.\n\nThe stop-after-candidate guard remains required: STRAT_EVAL and CANDIDATE may emit, while RANK, SIZING, RISK_GATE, ORDER_INTENT, SIM_FILL, POSITION, order translation, adapters, broker/live, fills, and observation-day credit remain suppressed.\n\nRecommended next ticket: \`${NEXT_TICKET}\`.\n\nOutput hashes: bounded \`${boundedSha}\`, report JSON \`${reportSha}\`, report MD \`${reportMdSha}\`.\n`;
  writeFileSync(MEMO_MD, memo, 'utf8');
  appendBacklogRow();
  console.log(JSON.stringify({ state: 'PENDING_REVIEW', ticket: TICKET, substrate_sha: SUBSTRATE_SHA, determination: DETERMINATION, observation_window_start_utc: windowContract.observation_window_start_utc, observation_window_end_utc: windowContract.observation_window_end_utc, window_basis: windowContract.window_basis, accounting_slots_expected: 390, source_ready_slots_required: 390, warmup_excluded_slots_expected: 13, source_backed_feature_snapshot_count_required: 377, strategy_id: STRATEGY_ID, paper_observation_explicit_strategy_ids_required: true, paper_observation_stop_after_candidate_required: true, ORDER_INTENT_must_remain: 0, observation_day_eligible: false, observation_day_increment: 0, bounded_jsonl_lf_sha256: boundedSha, report_json_lf_sha256: reportSha, report_md_lf_sha256: reportMdSha, memo_lf_sha256: sha256FileLf(MEMO_MD), recommended_next_ticket: NEXT_TICKET }, null, 2));
}
main();
