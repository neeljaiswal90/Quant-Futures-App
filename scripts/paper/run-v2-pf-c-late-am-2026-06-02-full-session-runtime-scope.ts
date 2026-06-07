import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FULL-SESSION-RUNTIME-SCOPE-01';
const SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-02-full-session-runtime-scope-01';
const SUBSTRATE_SHA = '8417b788f7725b95a9d08b21f1b0c9bca9aa24d3';
const DETERMINATION = 'FULL_SESSION_RUNTIME_SCOPE_READY_FOR_IMPL';
const NEXT_TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FULL-SESSION-RUNTIME-IMPL-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const FEATURE_SNAPSHOT_ID = 'feature-v2pf-20260602-1780427100000000000';

const OUT_DIR = path.join(ROOT, 'artifacts', 'paper-observation', SLUG);
const BOUNDED_JSONL = path.join(OUT_DIR, 'bounded-full-session-runtime-scope.jsonl');
const REPORT_JSON = path.join(OUT_DIR, 'full-session-runtime-scope-report.json');
const REPORT_MD = path.join(OUT_DIR, 'full-session-runtime-scope-report.md');
const MEMO_MD = path.join(ROOT, 'docs', 'research', `${SLUG}-memo.md`);
const BACKLOG_CSV = path.join(ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');

const SOURCE_REPORTS = [
  {
    pr: 303,
    label: 'source_readiness_2026_06_02',
    path: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-source-readiness-01/source-readiness-report.json',
  },
  {
    pr: 305,
    label: 'scoped_regime_label_source_acquire',
    path: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-regime-label-source-acquire-01/regime-label-source-acquire-report.json',
  },
  {
    pr: 307,
    label: 'halt_roll_calendar_source_extend',
    path: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-halt-roll-calendar-source-extend-01/halt-roll-calendar-source-report.json',
  },
  {
    pr: 310,
    label: 'candidate_eligible_non_excluded_source_scope',
    path: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-candidate-eligible-non-excluded-snapshot-source-scope-01/candidate-eligible-non-excluded-source-scope-report.json',
  },
  {
    pr: 311,
    label: 'candidate_eligible_snapshot_builder_impl',
    path: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-candidate-eligible-snapshot-builder-impl-01/candidate-eligible-snapshot-builder-report.json',
  },
  {
    pr: 314,
    label: 'paper_runtime_candidate_smoke_impl',
    path: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-paper-runtime-candidate-smoke-impl-01/paper-runtime-candidate-smoke-impl-report.json',
  },
  {
    pr: 315,
    label: 'paper_runtime_observation_day_scope',
    path: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-paper-runtime-observation-day-scope-01/paper-runtime-observation-day-scope-report.json',
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

function jsonRecord(value: Json | undefined, field: string): JsonRecord {
  if (value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  throw new Error(`Missing object field ${field}`);
}

function numberFrom(record: JsonRecord, key: string): number {
  const value = record[key];
  if (typeof value === 'number') {
    return value;
  }
  throw new Error(`Missing numeric field ${key}`);
}

function stringFrom(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value === 'string') {
    return value;
  }
  throw new Error(`Missing string field ${key}`);
}

function boolFrom(record: JsonRecord, key: string): boolean {
  const value = record[key];
  if (typeof value === 'boolean') {
    return value;
  }
  throw new Error(`Missing boolean field ${key}`);
}

function appendBacklogRow(): void {
  const row = [
    TICKET,
    'P1',
    '1.0',
    'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-PAPER-RUNTIME-OBSERVATION-DAY-SCOPE-01',
    'Scope the minimum bounded full-session paper-runtime evidence contract required before 2026-06-02 observation-day accounting implementation may be authorized without order broker live Phase 6 roster or observation-credit authority',
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

  const pr310Path = path.join(ROOT, SOURCE_REPORTS[3].path);
  const pr314Path = path.join(ROOT, SOURCE_REPORTS[5].path);
  const pr315Path = path.join(ROOT, SOURCE_REPORTS[6].path);
  const pr310 = parseJsonFile(pr310Path);
  const pr314 = parseJsonFile(pr314Path);
  const pr315 = parseJsonFile(pr315Path);

  const selectedCandidatePoint = jsonRecord(pr310.selected_candidate_point, 'selected_candidate_point');
  const sourceWindowEventCount = jsonRecord(pr310.source_window_event_count, 'source_window_event_count');
  const sourceWindowSpan = jsonRecord(pr310.source_window_span, 'source_window_span');
  const pr314Counts = jsonRecord(pr314.counts, 'pr314.counts');
  const pr314AuthorityLocks = jsonRecord(pr314.authority_locks, 'pr314.authority_locks');
  const pr315EvidenceContract = jsonRecord(pr315.evidence_contract, 'pr315.evidence_contract');

  if (numberFrom(pr314Counts, 'STRAT_EVAL') !== 1 || numberFrom(pr314Counts, 'CANDIDATE') !== 1 || numberFrom(pr314Counts, 'ORDER_INTENT') !== 0) {
    throw new Error('PR #314 candidate-only runtime counts do not match expected 1/1/0 anchor');
  }
  if (boolFrom(pr315EvidenceContract, 'candidate_only_smoke_sufficient_for_day_credit') !== false) {
    throw new Error('PR #315 did not preserve candidate-only no-credit decision');
  }

  const windowContract: JsonRecord = {
    observation_window_start_utc: '2026-06-02T13:30:00.000000000Z',
    observation_window_end_utc: '2026-06-02T20:00:00.000000000Z',
    window_basis: '2026-06-02-rth',
    window_basis_note: 'RTH calendar window is the accounting basis; the next implementation must declare exact source coverage and fail closed if source-backed snapshots do not cover the declared window.',
    snapshot_cadence_basis: 'one closed 1m accounting slot from 13:30:00Z inclusive to 20:00:00Z exclusive',
    rth_window_minutes: 390,
    warmup_exclusion_count: 'implementation_must_compute_and_report_explicitly',
    expected_snapshot_count_formula: '(20:00:00Z - 13:30:00Z) / 1 minute = 390 full-session accounting slots before any explicitly reported warmup/source-gap exclusions',
    full_session_accounting_slot_count_required: 390,
    actual_required_snapshot_count_basis: 'full-session accounting slot contract, not PR #310 diagnostic bar_points_scanned',
    pr310_diagnostic_bar_points_scanned: numberFrom(sourceWindowEventCount, 'bar_points_scanned'),
    pr310_diagnostic_count_is_full_session_requirement: false,
    full_session_claim_valid: true,
    full_session_claim_valid_reason: 'The full-session claim is valid only because the contract requires 390 RTH accounting slots and explicit warmup/source-gap accounting; the earlier 245 diagnostic count is not treated as a full-session count.',
    observed_source_window_first_ts_utc: stringFrom(sourceWindowSpan, 'first_source_ts_utc'),
    observed_source_window_last_ts_utc: stringFrom(sourceWindowSpan, 'last_source_ts_utc'),
    observed_source_window_session_open_ts_utc: stringFrom(sourceWindowSpan, 'session_open_ts_utc'),
    source_backed_feature_snapshot_count_required: 390,
    source_backed_feature_snapshot_count_basis: 'one source-backed StrategyFeatureSnapshot or explicit warmup/source-gap accounting record per full-session 1m accounting slot; implementation must report produced, ingested, warmup-excluded, skipped, missing, and failed-closed counts and may not claim full RTH coverage from the PR #310 245-count diagnostic alone',
    snapshot_spacing_or_event_basis: 'closed_1m_bar_event_basis_with_finite_quote_session_vwap_atr14_sigma_regime_halt_roll_config_lineage',
    runtime_manifest_required: true,
    paper_runtime_entrypoint_or_harness: 'PaperTradingSession.processFeatureSnapshot(...) loop over bounded source-backed snapshots, or a dedicated script harness that constructs StrategyRuntimeRunner with the same paper-only guard contract',
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
    marker_accounting_required_fields: [
      'record_type',
      'event_type',
      'feature_snapshot_id',
      'strategy_id',
      'created_ts_ns',
      'created_ts_utc',
      'candidate_id_or_null',
      'suppression_reason_or_null',
    ],
  };

  const guardBehavior: JsonRecord = {
    primary_guard_repo_path: 'apps/strategy_runtime/src/orchestration/runner.ts',
    primary_guard_symbol_or_function: 'StrategyRuntimeRunner.processFeatureSnapshot(...)',
    paper_session_entry_repo_path: 'apps/strategy_runtime/src/paper-trading/paper-trading-runner.ts',
    paper_session_entry_symbol_or_function: 'PaperTradingSession.processFeatureSnapshot(...)',
    explicit_strategy_ids_wire_path: 'PaperTradingSession config explicit_strategy_ids -> StrategyRuntimeRunner paper_observation_explicit_strategy_ids',
    stop_after_candidate_guard_required: true,
    stop_after_candidate_guard_source_anchor: 'PR #314 paper_observation_stop_after_candidate=true; default_enabled=false; runtime_mode=paper required; explicit strategy ids required',
    stop_before: 'rankCandidates(...), sizing/risk, createEntryOrderIntent(...), order adapter, broker adapter, fill handling',
  };

  const sourceStack: JsonRecord = {
    source_backed_feature_snapshot_path_exists: true,
    candidate_eligible_non_excluded_point_exists: boolFrom(pr310, 'candidate_eligible_non_excluded_snapshot_available'),
    candidate_point_timestamp_utc: stringFrom(selectedCandidatePoint, 'timestamp_utc'),
    candidate_point_timestamp_ns: stringFrom(selectedCandidatePoint, 'timestamp_ns'),
    candidate_point_entry_hour_utc: numberFrom(selectedCandidatePoint, 'entry_hour_utc'),
    candidate_point_signed_shock_vwap: numberFrom(selectedCandidatePoint, 'context.signed_shock_vwap.value'),
    candidate_point_threshold_comparison: stringFrom(selectedCandidatePoint, 'threshold_comparison_result'),
    session_vwap_ready: true,
    atr14_ready: true,
    signed_shock_vwap_source_ready: true,
    scoped_regime_label_ready: true,
    halt_roll_calendar_ready: true,
    source_window_bar_points_scanned: numberFrom(sourceWindowEventCount, 'bar_points_scanned'),
    source_window_bar_points_scanned_is_diagnostic_only: true,
    full_session_accounting_slot_count_required: 390,
    candidate_eligible_non_excluded_points: numberFrom(sourceWindowEventCount, 'candidate_eligible_non_excluded_points'),
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
    exactly_one_runtime_manifest_for_declared_window: true,
    source_backed_snapshots_ingested: 'equals source_backed_feature_snapshot_count_required unless explicitly justified skips are reported',
    full_session_accounting_slots_required: 390,
    warmup_exclusion_count_required_to_be_reported: true,
    pr310_diagnostic_245_count_must_not_be_used_as_full_session_count: true,
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
    {
      record_type: 'SOURCE_CHAIN_ANCHORS',
      ticket: TICKET,
      substrate_sha: SUBSTRATE_SHA,
      source_anchors: sourceAnchors,
    },
    {
      record_type: 'FULL_SESSION_RUNTIME_SCOPE_CONTRACT',
      ticket: TICKET,
      determination: DETERMINATION,
      source_stack: sourceStack,
      window_contract: windowContract,
      runtime_marker_requirements: runtimeMarkerRequirements,
      guard_behavior: guardBehavior,
      observation_accounting_locks: observationAccountingLocks,
      next_implementation_success_criteria: nextImplementationSuccessCriteria,
    },
  ];
  writeFileSync(BOUNDED_JSONL, stableJsonl(boundedRecords), 'utf8');

  const report: JsonRecord = {
    ticket: TICKET,
    determination: DETERMINATION,
    substrate_sha: SUBSTRATE_SHA,
    source_anchors: sourceAnchors,
    source_stack: sourceStack,
    prior_results: {
      pr314: {
        determination: stringFrom(pr314, 'determination'),
        STRAT_EVAL: numberFrom(pr314Counts, 'STRAT_EVAL'),
        CANDIDATE: numberFrom(pr314Counts, 'CANDIDATE'),
        ORDER_INTENT: numberFrom(pr314Counts, 'ORDER_INTENT'),
        paper_observation_stop_after_candidate: boolFrom(pr314AuthorityLocks, 'paper_observation_stop_after_candidate'),
      },
      pr315: {
        determination: stringFrom(pr315, 'determination'),
        candidate_only_smoke_sufficient_for_day_credit: boolFrom(pr315EvidenceContract, 'candidate_only_smoke_sufficient_for_day_credit'),
        full_session_runtime_manifest_required: boolFrom(pr315EvidenceContract, 'full_session_runtime_manifest_required'),
      },
    },
    window_contract: windowContract,
    runtime_marker_requirements: runtimeMarkerRequirements,
    guard_behavior: guardBehavior,
    observation_accounting_locks: observationAccountingLocks,
    next_implementation_success_criteria: nextImplementationSuccessCriteria,
    ready_for_impl_meaning: 'Ready means the full-session/window evidence contract and runtime guard requirements are scoped. It does not mean the full-session run has occurred or that observation-day credit is authorized.',
    bounded_artifact_size_bytes: statSync(BOUNDED_JSONL).size,
    recommended_next_ticket: NEXT_TICKET,
  };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  const boundedSha = sha256FileLf(BOUNDED_JSONL);
  const reportSha = sha256FileLf(REPORT_JSON);

  const md = [
    `# ${TICKET}`,
    '',
    `Determination: \`${DETERMINATION}\``,
    '',
    '## Scope decision',
    '',
    'This ticket scopes the minimum bounded full-session/window paper-runtime evidence contract. It does not run the full session and does not authorize observation-day credit.',
    '',
    '| Field | Value |',
    '|---|---|',
    '| candidate-only smoke sufficient for day credit | `false` |',
    '| implementation authorized by this ticket | `false` |',
    '| observation_day_eligible | `false` |',
    '| observation_day_increment | `0` |',
    '| order intent authorized | `false` |',
    '',
    '## Prior anchors',
    '',
    '| Anchor | Result |',
    '|---|---|',
    '| PR #314 | `STRAT_EVAL=1`, `CANDIDATE=1`, `ORDER_INTENT=0`, `paper_observation_stop_after_candidate=true` |',
    '| PR #315 | `OBSERVATION_DAY_SCOPE_BLOCKED_REQUIRES_FULL_SESSION_RUNTIME`, candidate-only day credit rejected |',
    '',
    '## Window contract',
    '',
    '| Field | Value |',
    '|---|---|',
    `| observation_window_start_utc | \`${windowContract.observation_window_start_utc}\` |`,
    `| observation_window_end_utc | \`${windowContract.observation_window_end_utc}\` |`,
    `| window_basis | \`${windowContract.window_basis}\` |`,
    `| snapshot_cadence_basis | \`${windowContract.snapshot_cadence_basis}\` |`,
    `| rth_window_minutes | \`${windowContract.rth_window_minutes}\` |`,
    `| warmup_exclusion_count | \`${windowContract.warmup_exclusion_count}\` |`,
    `| expected_snapshot_count_formula | \`${windowContract.expected_snapshot_count_formula}\` |`,
    `| full_session_accounting_slot_count_required | \`${windowContract.full_session_accounting_slot_count_required}\` |`,
    `| PR #310 diagnostic bar_points_scanned | \`${windowContract.pr310_diagnostic_bar_points_scanned}\` |`,
    `| PR #310 diagnostic count is full-session requirement | \`${windowContract.pr310_diagnostic_count_is_full_session_requirement}\` |`,
    `| full_session_claim_valid | \`${windowContract.full_session_claim_valid}\` |`,
    `| observed_source_window_first_ts_utc | \`${windowContract.observed_source_window_first_ts_utc}\` |`,
    `| observed_source_window_last_ts_utc | \`${windowContract.observed_source_window_last_ts_utc}\` |`,
    `| source_backed_feature_snapshot_count_required | \`${windowContract.source_backed_feature_snapshot_count_required}\` |`,
    `| snapshot_spacing_or_event_basis | \`${windowContract.snapshot_spacing_or_event_basis}\` |`,
    `| paper_runtime_entrypoint_or_harness | \`${windowContract.paper_runtime_entrypoint_or_harness}\` |`,
    `| strategy_id | \`${STRATEGY_ID}\` |`,
    '| paper_observation_explicit_strategy_ids required | `true` |',
    '| paper_observation_stop_after_candidate required | `true` |',
    '',
    '## Runtime marker requirements',
    '',
    '| Marker/class | Requirement |',
    '|---|---|',
    '| SESSION_MANIFEST | required |',
    '| FEATURE_SNAPSHOT_INGEST or equivalent | required |',
    '| STRAT_EVAL | required |',
    '| CANDIDATE | allowed/expected when predicates pass |',
    '| ORDER_INTENT | must remain `0` |',
    '| RANK / SIZING / RISK_GATE | must remain `0` with stop-after-candidate guard active |',
    '| SIM_FILL / POSITION | must remain `0` |',
    '',
    '## Guard behavior',
    '',
    '| Field | Value |',
    '|---|---|',
    `| primary_guard_repo_path | \`${guardBehavior.primary_guard_repo_path}\` |`,
    `| primary_guard_symbol_or_function | \`${guardBehavior.primary_guard_symbol_or_function}\` |`,
    `| paper_session_entry_repo_path | \`${guardBehavior.paper_session_entry_repo_path}\` |`,
    `| paper_session_entry_symbol_or_function | \`${guardBehavior.paper_session_entry_symbol_or_function}\` |`,
    `| stop_before | \`${guardBehavior.stop_before}\` |`,
    '',
    '## Source stack',
    '',
    '| Field | Value |',
    '|---|---|',
    '| source-backed feature snapshot path exists | `true` |',
    '| candidate-eligible non-excluded point exists | `true` |',
    `| candidate point | \`${sourceStack.candidate_point_timestamp_utc}\` |`,
    `| candidate signed_shock_vwap | \`${sourceStack.candidate_point_signed_shock_vwap}\` |`,
    '| session_vwap / ATR14 / signed_shock / regime / halt-roll | `READY` |',
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
    'This ticket defines the minimum bounded full-session/window paper-runtime evidence contract required before any observation-day accounting implementation may be authorized. It does not run the full session, emit order intent, or increment observation-day credit.',
    '',
    'PR #314 proved candidate-only paper-runtime plumbing with `STRAT_EVAL = 1`, `CANDIDATE = 1`, `ORDER_INTENT = 0`, and `paper_observation_stop_after_candidate = true`. PR #315 then correctly rejected candidate-only day credit and required full-session/window runtime evidence. This scope converts that requirement into an implementation contract.',
    '',
    'The next implementation may ingest source-backed snapshots through the paper runtime only under the explicit paper-observation strategy override and stop-after-candidate guard. The next implementation must still report `ORDER_INTENT = 0`, no order translation, no adapters, no broker/live, no fills, and no observation-day credit.',
    '',
    '## Required full-session/window contract',
    '',
    '- Observation window basis: `2026-06-02-rth`. The implementation must declare the exact bounded window and fail closed on source coverage gaps.',
    '- Full-session cadence basis: one closed 1m accounting slot from `13:30:00Z` inclusive to `20:00:00Z` exclusive, which yields `390` RTH accounting slots before any explicitly reported warmup/source-gap exclusions.',
    '- The PR #310 `245` bar-point count is diagnostic-only and must not be used as the full-session snapshot requirement.',
    '- Warmup exclusions, skipped slots, missing slots, and failed-closed slots must be reported explicitly by the next implementation.',
    '- Runtime manifest: required.',
    '- Feature snapshot ingest accounting: required, one per source-backed source-ready bar point unless justified skips are reported.',
    '- Strategy marker accounting: `STRAT_EVAL` required; `CANDIDATE` allowed/expected when predicates pass.',
    '- Suppression accounting: `ORDER_INTENT`, `RANK`, `SIZING`, `RISK_GATE`, `SIM_FILL`, and `POSITION` must remain `0` while the stop-after-candidate guard is active.',
    '- Observation accounting remains locked: `observation_day_eligible = false`, `observation_day_increment = 0`.',
    '',
    '## Authority caveat',
    '',
    'This ticket creates no ORDER_INTENT authority, order translation, order adapter, broker adapter, paper fill, qfa-410b/qfa-611, active/candidate roster mutation, broker/live authority, Phase 6 authority, or observation-day credit.',
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
  const scriptSha = sha256FileLf(path.join(ROOT, 'scripts', 'paper', 'run-v2-pf-c-late-am-2026-06-02-full-session-runtime-scope.ts'));
  console.log(JSON.stringify({
    state: 'PENDING_REVIEW',
    ticket: TICKET,
    substrate_sha: SUBSTRATE_SHA,
    determination: DETERMINATION,
    observation_window_start_utc: windowContract.observation_window_start_utc,
    observation_window_end_utc: windowContract.observation_window_end_utc,
    window_basis: windowContract.window_basis,
    source_backed_feature_snapshot_count_required: windowContract.source_backed_feature_snapshot_count_required,
    strategy_id: STRATEGY_ID,
    paper_observation_explicit_strategy_ids_required: true,
    paper_observation_stop_after_candidate_required: true,
    ORDER_INTENT_must_remain: 0,
    observation_day_eligible: false,
    observation_day_increment: 0,
    bounded_jsonl_lf_sha256: boundedSha,
    report_json_lf_sha256: reportSha,
    report_md_lf_sha256: reportMdSha,
    memo_lf_sha256: memoSha,
    script_lf_sha256: scriptSha,
    recommended_next_ticket: NEXT_TICKET,
  }, null, 2));
}

main();
