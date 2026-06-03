import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FEATURE-SOURCE-RECHECK-01';
const TICKET_SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-02-feature-source-recheck-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const ROOT = process.cwd();
const OUT_DIR = join(ROOT, 'artifacts', 'paper-observation', TICKET_SLUG);
const JSONL_PATH = join(OUT_DIR, 'bounded-feature-source-recheck.jsonl');
const JSON_PATH = join(OUT_DIR, 'feature-source-recheck-report.json');
const MD_PATH = join(OUT_DIR, 'feature-source-recheck-report.md');
const MEMO_PATH = join(ROOT, 'docs', 'research', `${TICKET_SLUG}-memo.md`);
const BACKLOG_PATH = join(ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');
const BACKLOG_ROW = `${TICKET},P1,1.0,V2-PF-C-LATE-AM-PAPER-OBSERVATION-SOURCE-READINESS-WAVE-5,Reconcile merged 2026-06-02 source surfaces from PR #303 #304 #305 and determine whether behavior-bearing causal StrategyFeatureSnapshot inputs are source-ready without feature materialization strategy markers observation-day credit or authority,new_cycle4_v2_research_substrate`;

const PATHS = {
  pr303Report: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-source-readiness-01/source-readiness-report.json',
  pr303Bounded: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-source-readiness-01/bounded-2026-06-02-source-readiness.jsonl',
  pr304Report: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-regime-label-source-inputs-extend-01/regime-label-source-inputs-report.json',
  pr304Bounded: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-regime-label-source-inputs-extend-01/bounded-regime-label-source-inputs.jsonl',
  pr305Report: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-regime-label-source-acquire-01/regime-label-source-acquire-report.json',
  pr305Scoped: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-regime-label-source-acquire-01/scoped-regime-label-source.jsonl',
  strategyBase: 'apps/strategy_runtime/src/strategies/regime_shock_reversion_short_v2.ts',
  strategyVariant: 'apps/strategy_runtime/src/strategies/regime_shock_reversion_short_v2_utc_16_18_exclusion.ts',
  strategyConfig: 'config/strategies/regime_shock_reversion_short_v2_utc_16_18_exclusion.yaml',
  registry: 'apps/strategy_runtime/src/strategies/registry.ts',
  strategyIds: 'apps/strategy_runtime/src/contracts/strategy-ids.ts',
  marketContract: 'apps/strategy_runtime/src/contracts/market.ts',
  sessionCalendar: 'apps/strategy_runtime/src/session/mnq-session-calendar.ts',
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = { [key: string]: JsonValue };

function readText(relPath: string): string {
  const path = join(ROOT, relPath);
  if (!existsSync(path)) {
    throw new Error(`Missing required source path: ${relPath}`);
  }
  return readFileSync(path, 'utf8');
}

function readJson(relPath: string): JsonRecord {
  return JSON.parse(readText(relPath)) as JsonRecord;
}

function lfCanonical(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function sourceSha(relPath: string): string {
  return sha256Text(lfCanonical(readText(relPath)));
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJson(entry));
  }
  if (value !== null && typeof value === 'object') {
    const sorted: JsonRecord = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJson((value as JsonRecord)[key]);
    }
    return sorted;
  }
  return value;
}

function stableJson(value: JsonValue): string {
  return `${JSON.stringify(sortJson(value))}\n`;
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function getRecord(value: JsonRecord, key: string): JsonRecord {
  const next = value[key];
  if (next === null || typeof next !== 'object' || Array.isArray(next)) {
    throw new Error(`Expected object at ${key}`);
  }
  return next as JsonRecord;
}

function getString(value: JsonRecord, key: string): string {
  const next = value[key];
  if (typeof next !== 'string') {
    throw new Error(`Expected string at ${key}`);
  }
  return next;
}

function getNumber(value: JsonRecord, key: string): number {
  const next = value[key];
  if (typeof next !== 'number') {
    throw new Error(`Expected number at ${key}`);
  }
  return next;
}

function getBoolean(value: JsonRecord, key: string): boolean {
  const next = value[key];
  if (typeof next !== 'boolean') {
    throw new Error(`Expected boolean at ${key}`);
  }
  return next;
}

function appendBacklogRow(): void {
  const existing = existsSync(BACKLOG_PATH) ? readFileSync(BACKLOG_PATH, 'utf8') : '';
  if (existing.includes(`${TICKET},`)) {
    return;
  }
  const suffix = existing.endsWith('\n') || existing.length === 0 ? '' : '\n';
  writeText(BACKLOG_PATH, `${existing}${suffix}${BACKLOG_ROW}\n`);
}

const pr303 = readJson(PATHS.pr303Report);
const pr304 = readJson(PATHS.pr304Report);
const pr305 = readJson(PATHS.pr305Report);

const pr303SessionVwap = getRecord(pr303, 'session_vwap_source_readiness');
const pr303SignedShock = getRecord(pr303, 'signed_shock_vwap_source_readiness');
const pr303VixVxn = getRecord(pr303, 'vix_vxn_prior_close_source_status');
const pr303Bars = getRecord(pr303, 'closed_1m_bars');
const pr303Rth = getRecord(pr303, 'rth_source_coverage_2026_06_02');
const pr303Mbp1 = getRecord(pr303Rth, 'mbp1');
const pr303LatestQuote = getRecord(pr303Mbp1, 'latest_finite_mid_quote');
const pr304Inputs = getRecord(pr304, 'qfa212_source_input_readiness');
const pr305Label = getRecord(pr305, 'scoped_label');
const pr305GlobalAnchor = getRecord(pr305, 'global_regime_label_anchor');
const pr305Guardrails = getRecord(pr305, 'authority_and_observation_guardrails');

const sourceAnchors: JsonRecord = {
  pr303: {
    artifact: PATHS.pr303Report,
    bounded_artifact: PATHS.pr303Bounded,
    bounded_lf_sha256: getString(pr303, 'bounded_source_readiness_lf_sha256'),
    determination: getString(pr303, 'determination'),
    merge_commit: '9c5a874374125574b2a93f55d84b9c9ad3d69466',
    report_lf_sha256: sourceSha(PATHS.pr303Report),
  },
  pr304: {
    artifact: PATHS.pr304Report,
    bounded_artifact: PATHS.pr304Bounded,
    bounded_lf_sha256: getString(pr304, 'bounded_source_inputs_lf_sha256'),
    determination: getString(pr304, 'determination'),
    merge_commit: '5c9c0a234959693e4e6c9418467d10aed63811d4',
    report_lf_sha256: sourceSha(PATHS.pr304Report),
  },
  pr305: {
    artifact: PATHS.pr305Report,
    scoped_artifact: PATHS.pr305Scoped,
    scoped_regime_label_source_lf_sha256: getString(pr305, 'scoped_regime_label_source_lf_sha256'),
    determination: getString(pr305, 'determination'),
    merge_commit: '7b13b559148fd33bd71d33910483d65e37de578f',
    report_lf_sha256: sourceSha(PATHS.pr305Report),
  },
};

const sessionFieldSourceCodeProvenance: JsonValue[] = [
  {
    current_default_behavior: 'no default found',
    evidence: 'SessionState requires is_halt and is_roll_block as booleans, but current source-readiness artifacts do not materialize them and current repo source does not expose a paper/local replay default for these exact fields.',
    external_source_required: true,
    field: 'session.is_halt / session.is_roll_block',
    repo_symbol_or_path: `${PATHS.marketContract}; ${PATHS.sessionCalendar}; ${PATHS.strategyBase}`,
    source_code_lf_sha256: {
      market_contract: sourceSha(PATHS.marketContract),
      session_calendar: sourceSha(PATHS.sessionCalendar),
      strategy_base: sourceSha(PATHS.strategyBase),
    },
  },
  {
    current_default_behavior: 'calendar derives phase and is_maintenance_halt, but not SessionState.is_halt or SessionState.is_roll_block defaults',
    evidence: 'getMnqSessionPhase(...) provides phase, is_rth, is_eth, is_maintenance_halt, is_session_closed, and candidate_eligible. That is useful provenance, but it is not a builder-ready source for both required SessionState flags.',
    external_source_required: true,
    field: 'session.is_halt / session.is_roll_block',
    repo_symbol_or_path: 'apps/strategy_runtime/src/session/mnq-session-calendar.ts#getMnqSessionPhase',
    source_code_lf_sha256: sourceSha(PATHS.sessionCalendar),
  },
];

const behaviorBearingFields: JsonValue[] = [
  {
    causal_timing_basis: 'source_ts_ns and derived timestamp are bounded before the fixed 2026-06-02T18:00:00Z source-readiness cutoff',
    date_basis: '2026-06-02 RTH source window',
    field_family: 'created_ts_ns',
    notes: 'Feature builder can derive created_ts_ns from bounded source timestamps; no StrategyFeatureSnapshot is emitted here.',
    source_anchor_sha_or_commit: getString(pr303, 'bounded_source_readiness_lf_sha256'),
    source_artifact_or_code_path: PATHS.pr303Bounded,
    source_status: 'READY',
  },
  {
    causal_timing_basis: 'latest finite MBP1 quote timestamp is at or before the bounded cutoff',
    date_basis: '2026-06-02 RTH MBP1 normalized quote source',
    field_family: 'quote.mid_px',
    notes: `Latest finite mid_px is ${getNumber(pr303LatestQuote, 'mid_px')} at ${getString(pr303LatestQuote, 'ts_utc')}.`,
    source_anchor_sha_or_commit: getString(pr303, 'bounded_source_readiness_lf_sha256'),
    source_artifact_or_code_path: PATHS.pr303Report,
    source_status: 'READY',
  },
  {
    causal_timing_basis: 'explicit effective RTH start is 2026-06-02T13:30:00Z and bounded source covers RTH open',
    date_basis: 'target_session_id 2026-06-02-rth',
    field_family: 'session.is_rth',
    notes: 'RTH membership is source-ready for the selected 2026-06-02 RTH candidate window.',
    source_anchor_sha_or_commit: getString(pr303, 'bounded_source_readiness_lf_sha256'),
    source_artifact_or_code_path: PATHS.pr303Report,
    source_status: 'READY',
  },
  {
    causal_timing_basis: 'no merged PR #303/#304/#305 artifact explicitly classifies halt state for the 2026-06-02 event window',
    date_basis: 'target_session_id 2026-06-02-rth',
    field_family: 'session.is_halt',
    notes: 'No current repo default/fallback was found for SessionState.is_halt in paper/local replay. Timestamp-window inference is not enough; future builder needs an explicit halt calendar/source or deliberate documented conservative default.',
    source_anchor_sha_or_commit: '7b13b559148fd33bd71d33910483d65e37de578f',
    source_artifact_or_code_path: `PR #303/#304/#305 merged source surfaces; ${PATHS.marketContract}; ${PATHS.sessionCalendar}`,
    source_status: 'BLOCKED',
  },
  {
    causal_timing_basis: 'no merged PR #303/#304/#305 artifact explicitly classifies roll-block state for the 2026-06-02 event window',
    date_basis: 'target_session_id 2026-06-02-rth',
    field_family: 'session.is_roll_block',
    notes: 'No current repo default/fallback was found for SessionState.is_roll_block in paper/local replay. The v2 generator treats roll-block as behavior-bearing, so source readiness remains blocked until this flag is causally sourced or deliberately defaulted.',
    source_anchor_sha_or_commit: '7b13b559148fd33bd71d33910483d65e37de578f',
    source_artifact_or_code_path: `PR #303/#304/#305 merged source surfaces; ${PATHS.marketContract}; ${PATHS.sessionCalendar}`,
    source_status: 'BLOCKED',
  },
  {
    causal_timing_basis: 'PR #303 proves 119 closed 1m bars from the effective RTH open through the bounded cutoff',
    date_basis: '2026-06-02 RTH closed-bar source window',
    field_family: 'indicators.sigma_pts',
    notes: `Source bars are ready for sigma construction; closed_1m_bars=${getNumber(pr303Bars, 'closed_1m_bars_constructed')}. This recheck does not materialize a StrategyFeatureSnapshot value.`,
    source_anchor_sha_or_commit: getString(pr303, 'bounded_source_readiness_lf_sha256'),
    source_artifact_or_code_path: `${PATHS.pr303Report}; apps/backtester/src/real-archive-execution/real-archive-execution-runner.ts`,
    source_status: 'READY',
  },
  {
    causal_timing_basis: 'PR #305 scoped paper-observation source acquired confirmed label without mutating global regime labels',
    date_basis: 'target_session_id 2026-06-02-rth; primary prior close 2026-06-01',
    field_family: 'context.regime_label',
    notes: `Scoped source label is ${getString(pr305Label, 'confirmed_label')}; global regime labels remain unmutated and target is not present in global artifact.`,
    source_anchor_sha_or_commit: getString(pr305, 'scoped_regime_label_source_lf_sha256'),
    source_artifact_or_code_path: PATHS.pr305Scoped,
    source_status: 'READY',
  },
  {
    causal_timing_basis: 'PR #303 computes signed_shock_vwap source readiness from latest finite quote, session_vwap, and ATR14 before cutoff',
    date_basis: '2026-06-02 RTH source window',
    field_family: 'context.signed_shock_vwap.value',
    notes: `source-readiness value=${getNumber(pr303SignedShock, 'signed_shock_vwap_source_readiness_value')}; session_vwap=${getNumber(pr303SessionVwap, 'session_vwap')}; ATR14=${getNumber(pr303SignedShock, 'atr14_pts')}.`,
    source_anchor_sha_or_commit: getString(pr303, 'bounded_source_readiness_lf_sha256'),
    source_artifact_or_code_path: PATHS.pr303Report,
    source_status: 'READY',
  },
  {
    causal_timing_basis: 'variant generator reads variant config using strategy_id before delegating to the shared v2 parameterized generator',
    date_basis: 'repo config at origin/main after PR #305',
    field_family: 'config lineage for regime_shock_reversion_short_v2_utc_16_18_exclusion',
    notes: 'Config lineage is ready from variant YAML, registry generator mapping, and variant-owned getStrategyParameters path.',
    source_anchor_sha_or_commit: '7b13b559148fd33bd71d33910483d65e37de578f',
    source_artifact_or_code_path: `${PATHS.strategyVariant}; ${PATHS.strategyConfig}; ${PATHS.registry}`,
    source_status: 'READY',
  },
];

const diagnosticFields: JsonValue[] = [
  {
    causal_timing_basis: 'FRED prior close for 2026-06-01 retrieved in PR #303 and source-input continuity extended in PR #304',
    date_basis: 'prior close date 2026-06-01 for target session 2026-06-02-rth',
    field_family: 'VIX value / freshness / percentile',
    notes: `VIXCLS=${getNumber(getRecord(pr303VixVxn, 'returned_values'), 'VIXCLS')}; PR #304 primary_value=${getNumber(pr304Inputs, 'primary_value')}, primary_percentile=${getNumber(pr304Inputs, 'primary_percentile_diagnostic_only')}.`,
    source_anchor_sha_or_commit: getString(pr304, 'bounded_source_inputs_lf_sha256'),
    source_artifact_or_code_path: PATHS.pr304Report,
    source_status: 'DIAGNOSTIC_ONLY',
  },
  {
    causal_timing_basis: 'FRED prior close value exists, percentile is not materialized in the scoped label source',
    date_basis: 'prior close date 2026-06-01',
    field_family: 'VXN percentile',
    notes: `VXN value=${getNumber(pr305Label, 'vxn_value')}; vxn_percentile is null and non-blocking for v2 behavior.`,
    source_anchor_sha_or_commit: getString(pr305, 'scoped_regime_label_source_lf_sha256'),
    source_artifact_or_code_path: PATHS.pr305Scoped,
    source_status: 'DIAGNOSTIC_ONLY',
  },
  {
    causal_timing_basis: 'PR #304 computes rolling 60-session diagnostic percentile from extended VIX source inputs',
    date_basis: 'prior close date 2026-06-01',
    field_family: 'primary percentile',
    notes: `primary_percentile=${getNumber(pr304Inputs, 'primary_percentile_diagnostic_only')}; diagnostic-only for this source recheck.`,
    source_anchor_sha_or_commit: getString(pr304, 'bounded_source_inputs_lf_sha256'),
    source_artifact_or_code_path: PATHS.pr304Report,
    source_status: 'DIAGNOSTIC_ONLY',
  },
  {
    causal_timing_basis: 'not needed to evaluate the current v2 UTC 16-18 exclusion behavior-bearing path',
    date_basis: 'not required for v2 behavior',
    field_family: 'spread bucket',
    notes: 'Spread bucket can remain absent from the causal StrategyFeatureSnapshot builder for this v2 behavior path.',
    source_anchor_sha_or_commit: '7b13b559148fd33bd71d33910483d65e37de578f',
    source_artifact_or_code_path: 'not required by regime_shock_reversion_short_v2_utc_16_18_exclusion generator',
    source_status: 'NOT_REQUIRED',
  },
  {
    causal_timing_basis: 'not needed to evaluate the current v2 UTC 16-18 exclusion behavior-bearing path',
    date_basis: 'not required for v2 behavior',
    field_family: 'queue bucket',
    notes: 'Queue bucket can remain absent from the causal StrategyFeatureSnapshot builder for this v2 behavior path.',
    source_anchor_sha_or_commit: '7b13b559148fd33bd71d33910483d65e37de578f',
    source_artifact_or_code_path: 'not required by regime_shock_reversion_short_v2_utc_16_18_exclusion generator',
    source_status: 'NOT_REQUIRED',
  },
  {
    causal_timing_basis: 'current v2 strategy consumes signed_shock_vwap.value only, not recent values',
    date_basis: '2026-06-02 RTH source window',
    field_family: 'signed-shock recent values',
    notes: 'Recent values are useful diagnostic context but not a behavior-bearing blocker for v2 candidate generation.',
    source_anchor_sha_or_commit: getString(pr303, 'bounded_source_readiness_lf_sha256'),
    source_artifact_or_code_path: PATHS.pr303Report,
    source_status: 'NOT_REQUIRED',
  },
];

const blocked = (behaviorBearingFields as JsonRecord[]).filter((field) => field.source_status === 'BLOCKED');
const blockedFieldNames = blocked.map((field) => String(field.field_family));
const blockerSubclassification = blockedFieldNames.every((field) => field === 'session.is_halt' || field === 'session.is_roll_block')
  ? 'SESSION_STATE_SOURCE_BLOCKED_MISSING_EXPLICIT_HALT_ROLL_CALENDAR'
  : null;
const determination = blocked.length === 0
  ? 'FEATURE_SOURCE_READY_FOR_BUILDER_IMPL'
  : 'FEATURE_SOURCE_RECHECK_BLOCKED_SESSION_STATE';

const recommendedNextTicket = blocked.length === 0
  ? 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FEATURE-SNAPSHOT-BUILDER-IMPL-01'
  : blockerSubclassification === 'SESSION_STATE_SOURCE_BLOCKED_MISSING_EXPLICIT_HALT_ROLL_CALENDAR'
    ? 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-HALT-ROLL-CALENDAR-SOURCE-EXTEND-01'
    : 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-SESSION-STATE-SOURCE-EXTEND-01';

const recommendedNextTicketReason = blocked.length === 0
  ? 'All behavior-bearing source families are ready for a separately scoped feature snapshot builder implementation.'
  : blockerSubclassification === 'SESSION_STATE_SOURCE_BLOCKED_MISSING_EXPLICIT_HALT_ROLL_CALENDAR'
    ? 'session.is_rth is already source-ready; the remaining session-state blocker is explicit halt/roll calendar provenance or a deliberate documented conservative default for session.is_halt=false and session.is_roll_block=false.'
    : 'At least one broader session-state source family remains blocked beyond halt/roll calendar provenance.';

const guardrails: JsonRecord = {
  CANDIDATE: 0,
  ORDER_INTENT: 0,
  STRAT_EVAL: 0,
  StrategyFeatureSnapshot: 0,
  active_roster_mutated: false,
  broker_live_authorized: false,
  candidate_roster_mutated: false,
  global_regime_labels_mutated: false,
  observation_day_eligible: false,
  observation_day_increment: 0,
  paper_runtime_invoked: false,
  phase_6_authorized: false,
  qfa_410b_or_qfa_611_run: false,
};

if (getBoolean(pr305Guardrails, 'global_regime_labels_mutated') !== false) {
  throw new Error('PR #305 guardrail mismatch: global regime labels mutated');
}

const records: JsonValue[] = [
  { payload: sourceAnchors, record_type: 'SOURCE_ANCHORS', ticket: TICKET },
  ...sessionFieldSourceCodeProvenance.map((field) => ({ payload: field, record_type: 'SESSION_FIELD_SOURCE_CODE_PROVENANCE', ticket: TICKET })),
  ...behaviorBearingFields.map((field) => ({ payload: field, record_type: 'BEHAVIOR_BEARING_FIELD_RECHECK', ticket: TICKET })),
  ...diagnosticFields.map((field) => ({ payload: field, record_type: 'DIAGNOSTIC_FIELD_RECHECK', ticket: TICKET })),
  { payload: guardrails, record_type: 'AUTHORITY_AND_OBSERVATION_GUARDRAILS', ticket: TICKET },
  { determination, payload: { blocked_field_families: blockedFieldNames, blocker_subclassification: blockerSubclassification, recommended_next_ticket: recommendedNextTicket, recommended_next_ticket_reason: recommendedNextTicketReason }, record_type: 'DETERMINATION', ticket: TICKET },
];

const jsonl = records.map((record) => JSON.stringify(sortJson(record))).join('\n') + '\n';
writeText(JSONL_PATH, jsonl);

const report: JsonRecord = {
  authority_and_observation_guardrails: guardrails,
  behavior_bearing_fields: behaviorBearingFields,
  blocked_behavior_bearing_fields: blockedFieldNames,
  blocker_subclassification: blockerSubclassification,
  bounded_feature_source_recheck_lf_sha256: sha256Text(jsonl),
  determination,
  diagnostic_non_blocking_fields: diagnosticFields,
  notes: [
    'This ticket reconciles source readiness only and does not materialize StrategyFeatureSnapshot.',
    'PR #305 scoped regime-label source resolves the prior regime-label blocker without mutating global regime labels.',
    'The remaining blocker is not RTH membership; it is explicit halt/roll calendar provenance or a deliberate documented conservative default for session.is_halt and session.is_roll_block.',
    'Current repo code does not expose a paper/local replay default for the exact SessionState.is_halt and SessionState.is_roll_block fields, so the top-level determination remains FEATURE_SOURCE_RECHECK_BLOCKED_SESSION_STATE.',
  ],
  pr_source_anchors: sourceAnchors,
  recommended_next_ticket: recommendedNextTicket,
  recommended_next_ticket_reason: recommendedNextTicketReason,
  schema_version: 1,
  session_field_source_code_provenance: sessionFieldSourceCodeProvenance,
  source_stack_summary: {
    atr14_pts: getNumber(pr303SignedShock, 'atr14_pts'),
    closed_1m_bars: getNumber(pr303Bars, 'closed_1m_bars_constructed'),
    confirmed_scoped_regime_label: getString(pr305Label, 'confirmed_label'),
    global_regime_labels_mutated: false,
    quote_mid_px_latest: getNumber(pr303LatestQuote, 'mid_px'),
    scoped_regime_label_source_acquired: true,
    session_vwap: getNumber(pr303SessionVwap, 'session_vwap'),
    signed_shock_vwap_source_readiness_value: getNumber(pr303SignedShock, 'signed_shock_vwap_source_readiness_value'),
    target_session_id: getString(pr305, 'target_session_id'),
    vixcls: getNumber(pr304Inputs, 'primary_value'),
    vxncls: getNumber(pr305Label, 'vxn_value'),
  },
  strategy_id: STRATEGY_ID,
  ticket: TICKET,
};

const reportJson = stableJson(report);
writeText(JSON_PATH, reportJson);

function table(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const header = rows[0];
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.slice(1).map((row) => `| ${row.join(' | ')} |`),
  ];
}

const behaviorRows = [
  ['Field', 'Status', 'Source', 'Date basis', 'Notes'],
  ...(behaviorBearingFields as JsonRecord[]).map((field) => [
    String(field.field_family),
    String(field.source_status),
    String(field.source_artifact_or_code_path),
    String(field.date_basis),
    String(field.notes).replace(/\|/g, '/'),
  ]),
];

const diagnosticRows = [
  ['Field', 'Status', 'Notes'],
  ...(diagnosticFields as JsonRecord[]).map((field) => [
    String(field.field_family),
    String(field.source_status),
    String(field.notes).replace(/\|/g, '/'),
  ]),
];

const sessionProvenanceRows = [
  ['Field', 'Repo symbol or path', 'Current default behavior', 'External source required'],
  ...(sessionFieldSourceCodeProvenance as JsonRecord[]).map((field) => [
    String(field.field),
    String(field.repo_symbol_or_path),
    String(field.current_default_behavior),
    String(field.external_source_required),
  ]),
];

const md = [
  `# ${TICKET}`,
  '',
  `Determination: \`${determination}\``,
  '',
  `Blocker subclassification: \`${blockerSubclassification}\``,
  '',
  `Recommended next ticket: \`${recommendedNextTicket}\``,
  '',
  `Recommended next ticket reason: ${recommendedNextTicketReason}`,
  '',
  '## Source stack summary',
  '',
  `- Target strategy: \`${STRATEGY_ID}\``,
  `- Target session: \`${getString(pr305, 'target_session_id')}\``,
  `- Session VWAP: \`${getNumber(pr303SessionVwap, 'session_vwap')}\``,
  `- ATR14: \`${getNumber(pr303SignedShock, 'atr14_pts')}\``,
  `- Signed-shock source value: \`${getNumber(pr303SignedShock, 'signed_shock_vwap_source_readiness_value')}\``,
  `- Scoped regime label: \`${getString(pr305Label, 'confirmed_label')}\``,
  `- Global regime labels mutated: \`false\``,
  '',
  '## Behavior-bearing field readiness',
  '',
  ...table(behaviorRows),
  '',
  '## Diagnostic-only / non-blocking fields',
  '',
  ...table(diagnosticRows),
  '',
  '## Session field source-code provenance',
  '',
  ...table(sessionProvenanceRows),
  '',
  '## PR source anchors',
  '',
  `- PR #303 merge commit: \`${(sourceAnchors.pr303 as JsonRecord).merge_commit}\``,
  `- PR #303 bounded source SHA: \`${getString(pr303, 'bounded_source_readiness_lf_sha256')}\``,
  `- PR #304 merge commit: \`${(sourceAnchors.pr304 as JsonRecord).merge_commit}\``,
  `- PR #304 bounded source-input SHA: \`${getString(pr304, 'bounded_source_inputs_lf_sha256')}\``,
  `- PR #305 merge commit: \`${(sourceAnchors.pr305 as JsonRecord).merge_commit}\``,
  `- PR #305 scoped label source SHA: \`${getString(pr305, 'scoped_regime_label_source_lf_sha256')}\``,
  '',
  '## Guardrails',
  '',
  '- No StrategyFeatureSnapshot materialized.',
  '- No STRAT_EVAL, CANDIDATE, or ORDER_INTENT markers emitted.',
  '- No qfa-410b or qfa-611 run.',
  '- No global regime-label mutation.',
  '- observation_day_eligible=false and observation_day_increment=0 remain locked.',
  '- No paper/live/broker/Phase 6/roster authority created.',
  '',
].join('\n');
writeText(MD_PATH, md);

const memo = [
  `# ${TICKET} memo`,
  '',
  '## Context',
  '',
  'PR #303 moved the paper-observation source-readiness lane to 2026-06-02 and proved RTH source coverage, closed bars, session VWAP, ATR14, signed-shock source value, and VIX/VXN prior close. PR #304 proved regime-label source inputs. PR #305 acquired a scoped paper-observation regime-label source without mutating global regime labels.',
  '',
  '## Determination',
  '',
  `\`${determination}\``,
  '',
  `Blocker subclassification: \`${blockerSubclassification}\``,
  '',
  'The recheck is not ready for feature-builder implementation because explicit source provenance for `session.is_halt` and `session.is_roll_block` is still missing from the merged source surfaces. `session.is_rth` is supported by the 2026-06-02 RTH source window, so this is not a broad RTH/session-basis blocker.',
  '',
  'Current repo code does not expose a paper/local replay default for the exact `SessionState.is_halt` and `SessionState.is_roll_block` fields. The MNQ session calendar can derive phase and `is_maintenance_halt`, but that is not a builder-ready source for both behavior-bearing `SessionState` flags. Therefore the top-level determination remains `FEATURE_SOURCE_RECHECK_BLOCKED_SESSION_STATE`, while the next ticket is narrowed to halt/roll calendar source provenance.',
  '',
  '## Ready source families',
  '',
  '- `created_ts_ns`',
  '- `quote.mid_px`',
  '- `session.is_rth`',
  '- `indicators.sigma_pts` source bars',
  '- `context.regime_label` scoped source',
  '- `context.signed_shock_vwap.value` source value',
  '- `regime_shock_reversion_short_v2_utc_16_18_exclusion` config lineage',
  '',
  '## Blocking source family',
  '',
  '- `session.is_halt`',
  '- `session.is_roll_block`',
  '',
  '## Session field source-code provenance',
  '',
  `- Field: \`session.is_halt / session.is_roll_block\``,
  `- Repo path(s): \`${PATHS.marketContract}; ${PATHS.sessionCalendar}; ${PATHS.strategyBase}\``,
  '- Current default behavior: `no default found` for the exact `SessionState` fields in paper/local replay source paths checked by this ticket.',
  '- External source required: `true`, unless a later scoped ticket explicitly documents a conservative default.',
  '',
  '## Authority caveat',
  '',
  'This source-readiness diagnostic does not materialize a StrategyFeatureSnapshot, does not emit strategy runtime markers, does not run qfa-410b/qfa-611, does not mutate global regime labels, does not award observation-day credit, and creates no paper/live/broker/Phase 6/roster authority.',
  '',
  '## Recommended next ticket',
  '',
  `\`${recommendedNextTicket}\``,
  '',
  recommendedNextTicketReason,
  '',
].join('\n');
writeText(MEMO_PATH, memo);

appendBacklogRow();

const outputShas: JsonRecord = {
  bounded_feature_source_recheck_lf_sha256: sha256Text(jsonl),
  report_json_lf_sha256: sha256Text(reportJson),
  report_md_lf_sha256: sha256Text(md),
  memo_lf_sha256: sha256Text(memo),
};

console.log(JSON.stringify(sortJson({
  determination,
  output_shas: outputShas,
  recommended_next_ticket: recommendedNextTicket,
  ticket: TICKET,
}), null, 2));


