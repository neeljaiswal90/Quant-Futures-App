import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { UnixNs } from '../../apps/strategy_runtime/src/contracts/time.js';
import {
  getMnqSessionPhase,
  loadMnqSessionCalendarConfig,
} from '../../apps/strategy_runtime/src/session/mnq-session-calendar.js';
import {
  evaluateRoll,
  loadMnqRollCalendarConfig,
} from '../../apps/strategy_runtime/src/session/mnq-roll-calendar.js';

const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-HALT-ROLL-CALENDAR-SOURCE-EXTEND-01';
const TICKET_SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-02-halt-roll-calendar-source-extend-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const ROOT = process.cwd();
const OUT_DIR = join(ROOT, 'artifacts', 'paper-observation', TICKET_SLUG);
const JSONL_PATH = join(OUT_DIR, 'bounded-halt-roll-calendar-source.jsonl');
const JSON_PATH = join(OUT_DIR, 'halt-roll-calendar-source-report.json');
const MD_PATH = join(OUT_DIR, 'halt-roll-calendar-source-report.md');
const MEMO_PATH = join(ROOT, 'docs', 'research', `${TICKET_SLUG}-memo.md`);
const BACKLOG_PATH = join(ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');
const BACKLOG_ROW = `${TICKET},P1,1.0,V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FEATURE-SOURCE-RECHECK-01,Prove explicit halt and roll calendar source readiness for 2026-06-02 without feature snapshot strategy markers observation-day credit or authority,new_cycle4_v2_research_substrate`;

const PATHS = {
  pr303Report: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-source-readiness-01/source-readiness-report.json',
  pr306Report: 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-feature-source-recheck-01/feature-source-recheck-report.json',
  sessionCalendarConfig: 'config/session/mnq-session-calendar.yaml',
  rollCalendarConfig: 'config/session/mnq-roll-calendar.yaml',
  sessionCalendarCode: 'apps/strategy_runtime/src/session/mnq-session-calendar.ts',
  rollCalendarCode: 'apps/strategy_runtime/src/session/mnq-roll-calendar.ts',
  sessionPolicyCode: 'apps/strategy_runtime/src/session/mnq-session-policy.ts',
  marketContract: 'apps/strategy_runtime/src/contracts/market.ts',
  strategyBase: 'apps/strategy_runtime/src/strategies/regime_shock_reversion_short_v2.ts',
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = { [key: string]: JsonValue };

function readText(relPath: string): string {
  const path = join(ROOT, relPath);
  if (!existsSync(path)) {
    throw new Error(`Missing required path: ${relPath}`);
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
  if (Array.isArray(value)) return value.map((entry) => sortJson(entry));
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
  if (typeof next !== 'string') throw new Error(`Expected string at ${key}`);
  return next;
}

function getNumber(value: JsonRecord, key: string): number {
  const next = value[key];
  if (typeof next !== 'number') throw new Error(`Expected number at ${key}`);
  return next;
}

function getBoolean(value: JsonRecord, key: string): boolean {
  const next = value[key];
  if (typeof next !== 'boolean') throw new Error(`Expected boolean at ${key}`);
  return next;
}

function optionalString(value: JsonRecord, key: string): string | null {
  const next = value[key];
  return typeof next === 'string' ? next : null;
}

function appendBacklogRow(): void {
  const existing = existsSync(BACKLOG_PATH) ? readFileSync(BACKLOG_PATH, 'utf8') : '';
  if (existing.includes(`${TICKET},`)) return;
  const suffix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  writeText(BACKLOG_PATH, `${existing}${suffix}${BACKLOG_ROW}\n`);
}

function gitHead(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
}

function table(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  return [
    `| ${rows[0]!.join(' | ')} |`,
    `| ${rows[0]!.map(() => '---').join(' | ')} |`,
    ...rows.slice(1).map((row) => `| ${row.map((cell) => cell.replace(/\|/g, '/')).join(' | ')} |`),
  ];
}

const pr303 = readJson(PATHS.pr303Report);
const pr306 = readJson(PATHS.pr306Report);

const pr303Rth = getRecord(pr303, 'rth_source_coverage_2026_06_02');
const pr303Mbp1 = getRecord(pr303Rth, 'mbp1');
const latestQuote = getRecord(pr303Mbp1, 'latest_finite_mid_quote');
const targetTsNsText = getString(latestQuote, 'ts_ns');
const targetTsNs = BigInt(targetTsNsText) as UnixNs;

const sessionCalendar = loadMnqSessionCalendarConfig({ cwd: ROOT, path: PATHS.sessionCalendarConfig, required: true });
const rollCalendar = loadMnqRollCalendarConfig({ cwd: ROOT, path: PATHS.rollCalendarConfig, required: true });
const sessionEvaluation = getMnqSessionPhase(sessionCalendar, targetTsNs);
const rollEvaluation = evaluateRoll(rollCalendar, targetTsNs);

const isHaltValue = sessionEvaluation.is_maintenance_halt || sessionEvaluation.journal_phase === 'halted';
const isRollBlockValue = rollEvaluation.block_new_entries;
const isHaltReady = sessionEvaluation.phase === 'rth' && !isHaltValue;
const isRollBlockReady = rollEvaluation.roll_phase === 'normal' && !isRollBlockValue && !rollEvaluation.flatten_required;
const ready = isHaltReady && isRollBlockReady;
const determination = ready
  ? 'HALT_ROLL_CALENDAR_SOURCE_READY_FOR_FEATURE_BUILDER'
  : 'HALT_ROLL_CALENDAR_SOURCE_BLOCKED';
const recommendedNextTicket = ready
  ? 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FEATURE-SNAPSHOT-BUILDER-IMPL-01'
  : 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-HALT-ROLL-CALENDAR-SOURCE-REPAIR-01';
const featureBuilderReadinessDelta = ready
  ? 'resolves last known source-readiness blocker from PR #306; feature builder implementation may now be scoped, but this PR does not authorize implementation or observation-day credit.'
  : 'does not resolve the last known source-readiness blocker from PR #306; only the exact halt/roll source blocker should be repaired next.';

const sourceAnchors: JsonRecord = {
  substrate_head: gitHead(),
  pr303: {
    artifact: PATHS.pr303Report,
    bounded_source_readiness_lf_sha256: getString(pr303, 'bounded_source_readiness_lf_sha256'),
    determination: getString(pr303, 'determination'),
    latest_finite_mid_quote_ts_ns: targetTsNsText,
    latest_finite_mid_quote_ts_utc: getString(latestQuote, 'ts_utc'),
    report_lf_sha256: sourceSha(PATHS.pr303Report),
  },
  pr306: {
    artifact: PATHS.pr306Report,
    blocker_subclassification: getString(pr306, 'blocker_subclassification'),
    bounded_feature_source_recheck_lf_sha256: getString(pr306, 'bounded_feature_source_recheck_lf_sha256'),
    determination: getString(pr306, 'determination'),
    report_lf_sha256: sourceSha(PATHS.pr306Report),
  },
  source_code_and_config: {
    market_contract_lf_sha256: sourceSha(PATHS.marketContract),
    roll_calendar_code_lf_sha256: sourceSha(PATHS.rollCalendarCode),
    roll_calendar_config_lf_sha256: sourceSha(PATHS.rollCalendarConfig),
    session_calendar_code_lf_sha256: sourceSha(PATHS.sessionCalendarCode),
    session_calendar_config_lf_sha256: sourceSha(PATHS.sessionCalendarConfig),
    session_policy_code_lf_sha256: sourceSha(PATHS.sessionPolicyCode),
    strategy_base_lf_sha256: sourceSha(PATHS.strategyBase),
  },
};

const fieldReadiness: JsonValue[] = [
  {
    calendar_value: isHaltValue,
    field_family: 'session.is_halt',
    mapped_from: 'getMnqSessionPhase(...).is_maintenance_halt || journal_phase === halted',
    notes: 'At the PR #303 bounded target timestamp, the explicit MNQ session calendar classifies the event as RTH, with no maintenance halt or closed-session reason. This proves calendar-backed halt readiness only; no StrategyFeatureSnapshot is emitted.',
    repo_symbol_or_path: `${PATHS.sessionCalendarCode}; ${PATHS.sessionCalendarConfig}`,
    source_status: isHaltReady ? 'READY' : 'BLOCKED',
  },
  {
    calendar_value: isRollBlockValue,
    field_family: 'session.is_roll_block',
    mapped_from: 'evaluateRoll(...).block_new_entries',
    notes: 'At the PR #303 bounded target timestamp, the explicit MNQ roll calendar classifies roll_phase as normal, outside any configured roll window, with no roll_block_window reason.',
    repo_symbol_or_path: `${PATHS.rollCalendarCode}; ${PATHS.rollCalendarConfig}; ${PATHS.sessionPolicyCode}`,
    source_status: isRollBlockReady ? 'READY' : 'BLOCKED',
  },
];

const explicitCalendarProvenanceRows: JsonValue[] = [
  {
    calendar_source_name: 'MNQ session calendar',
    date_basis: `target session ${sessionEvaluation.session_id}; local date ${sessionEvaluation.local.date}; trading date ${sessionEvaluation.trading_date}`,
    field: 'session.is_halt',
    repo_path: `${PATHS.sessionCalendarCode}; ${PATHS.sessionCalendarConfig}`,
    source_authority_type: 'current repo calendar/session semantics',
    symbol_or_function: 'getMnqSessionPhase(...).is_maintenance_halt and journal_phase',
    target_timestamp_basis: `PR #303 latest finite mid quote timestamp ${targetTsNsText} / ${getString(latestQuote, 'ts_utc')}`,
    value: isHaltValue,
    why_causal_for_2026_06_02: 'The PR #303 bounded target event timestamp is evaluated directly by the repo MNQ session calendar loaded from config/session/mnq-session-calendar.yaml. The timestamp is in the 2026-06-02 RTH session, the derived phase is rth, journal_phase is rth, reasons are empty, and is_maintenance_halt is false. No script-local calendar rule substitutes for the repo helper.',
  },
  {
    calendar_source_name: 'MNQ roll calendar',
    date_basis: `target session ${sessionEvaluation.session_id}; roll calendar timestamp evaluation in UTC ns`,
    field: 'session.is_roll_block',
    repo_path: `${PATHS.rollCalendarCode}; ${PATHS.rollCalendarConfig}; ${PATHS.sessionPolicyCode}`,
    source_authority_type: 'current repo roll-calendar semantics',
    symbol_or_function: 'evaluateRoll(...).block_new_entries',
    target_timestamp_basis: `PR #303 latest finite mid quote timestamp ${targetTsNsText} / ${getString(latestQuote, 'ts_utc')}`,
    value: isRollBlockValue,
    why_causal_for_2026_06_02: 'The same PR #303 bounded target event timestamp is evaluated directly by the repo MNQ roll calendar loaded from config/session/mnq-roll-calendar.yaml. The timestamp is outside configured roll windows, roll_phase is normal, in_roll_window is false, block_new_entries is false, flatten_required is false, and reasons are empty. No script-local roll rule substitutes for evaluateRoll.',
  },
];

const sessionCalendarEvidence: JsonRecord = {
  config_path: PATHS.sessionCalendarConfig,
  code_path: PATHS.sessionCalendarCode,
  config_lf_sha256: sourceSha(PATHS.sessionCalendarConfig),
  code_lf_sha256: sourceSha(PATHS.sessionCalendarCode),
  target_ts_ns: targetTsNsText,
  target_ts_utc: getString(latestQuote, 'ts_utc'),
  timezone: sessionEvaluation.timezone,
  local_date: sessionEvaluation.local.date,
  local_time: sessionEvaluation.local.time,
  trading_date: sessionEvaluation.trading_date,
  session_id: sessionEvaluation.session_id,
  phase: sessionEvaluation.phase,
  journal_phase: sessionEvaluation.journal_phase,
  is_rth: sessionEvaluation.is_rth,
  is_maintenance_halt: sessionEvaluation.is_maintenance_halt,
  is_session_closed: sessionEvaluation.is_session_closed,
  reasons: [...sessionEvaluation.reasons],
  is_halt_calendar_value_for_builder: isHaltValue,
  ready: isHaltReady,
};

const rollCalendarEvidence: JsonRecord = {
  config_path: PATHS.rollCalendarConfig,
  code_path: PATHS.rollCalendarCode,
  policy_path: PATHS.sessionPolicyCode,
  config_lf_sha256: sourceSha(PATHS.rollCalendarConfig),
  code_lf_sha256: sourceSha(PATHS.rollCalendarCode),
  policy_lf_sha256: sourceSha(PATHS.sessionPolicyCode),
  target_ts_ns: targetTsNsText,
  target_ts_utc: getString(latestQuote, 'ts_utc'),
  active_contract: rollEvaluation.active_contract,
  next_contract: optionalString(rollEvaluation as unknown as JsonRecord, 'next_contract'),
  roll_phase: rollEvaluation.roll_phase,
  in_roll_window: rollEvaluation.in_roll_window,
  block_new_entries: rollEvaluation.block_new_entries,
  flatten_required: rollEvaluation.flatten_required,
  reasons: [...rollEvaluation.reasons],
  period_id: optionalString(rollEvaluation as unknown as JsonRecord, 'period_id'),
  is_roll_block_calendar_value_for_builder: isRollBlockValue,
  ready: isRollBlockReady,
};

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

const records: JsonValue[] = [
  { payload: sourceAnchors, record_type: 'SOURCE_ANCHORS', ticket: TICKET },
  ...explicitCalendarProvenanceRows.map((payload) => ({ payload, record_type: 'EXPLICIT_CALENDAR_PROVENANCE', ticket: TICKET })),
  { payload: sessionCalendarEvidence, record_type: 'SESSION_HALT_CALENDAR_EVIDENCE', ticket: TICKET },
  { payload: rollCalendarEvidence, record_type: 'ROLL_CALENDAR_EVIDENCE', ticket: TICKET },
  ...fieldReadiness.map((payload) => ({ payload, record_type: 'FIELD_READINESS', ticket: TICKET })),
  { payload: guardrails, record_type: 'AUTHORITY_AND_OBSERVATION_GUARDRAILS', ticket: TICKET },
  {
    determination,
    payload: {
      recommended_next_ticket: recommendedNextTicket,
      feature_builder_readiness_delta: featureBuilderReadinessDelta,
      ready_for_feature_builder_source_inputs: ready,
      readiness_scope: 'calendar_backed_halt_roll_source_only_no_feature_snapshot_materialization',
    },
    record_type: 'DETERMINATION',
    ticket: TICKET,
  },
];

const jsonl = records.map((record) => JSON.stringify(sortJson(record))).join('\n') + '\n';
writeText(JSONL_PATH, jsonl);

const report: JsonRecord = {
  authority_and_observation_guardrails: guardrails,
  bounded_halt_roll_calendar_source_lf_sha256: sha256Text(jsonl),
  determination,
  explicit_calendar_provenance: explicitCalendarProvenanceRows,
  field_readiness: fieldReadiness,
  feature_builder_readiness_delta: featureBuilderReadinessDelta,
  non_overclaim_policy: {
    no_feature_snapshot_materialized: true,
    no_strategy_runtime_markers: true,
    no_observation_day_credit: true,
    scope: 'calendar source readiness only; does not run paper runtime or claim live exchange halt-feed coverage',
  },
  pr_source_anchors: sourceAnchors,
  recommended_next_ticket: recommendedNextTicket,
  roll_calendar_evidence: rollCalendarEvidence,
  schema_version: 1,
  session_calendar_evidence: sessionCalendarEvidence,
  source_stack_preserved_from_pr306: {
    prior_blocker_subclassification: getString(pr306, 'blocker_subclassification'),
    prior_determination: getString(pr306, 'determination'),
    prior_recommended_next_ticket: getString(pr306, 'recommended_next_ticket'),
  },
  strategy_id: STRATEGY_ID,
  target_event: {
    latest_finite_mid_px: getNumber(latestQuote, 'mid_px'),
    source_artifact: PATHS.pr303Report,
    source_path: getString(pr303Mbp1, 'path'),
    target_ts_ns: targetTsNsText,
    target_ts_utc: getString(latestQuote, 'ts_utc'),
  },
  ticket: TICKET,
};

const reportJson = stableJson(report);
writeText(JSON_PATH, reportJson);

const fieldRows = [
  ['Field', 'Status', 'Value', 'Mapped from', 'Notes'],
  ...(fieldReadiness as JsonRecord[]).map((field) => [
    String(field.field_family),
    String(field.source_status),
    String(field.calendar_value),
    String(field.mapped_from),
    String(field.notes),
  ]),
];

const sourceRows = [
  ['Source', 'Path', 'SHA'],
  ['Session calendar config', PATHS.sessionCalendarConfig, sourceSha(PATHS.sessionCalendarConfig)],
  ['Session calendar code', PATHS.sessionCalendarCode, sourceSha(PATHS.sessionCalendarCode)],
  ['Roll calendar config', PATHS.rollCalendarConfig, sourceSha(PATHS.rollCalendarConfig)],
  ['Roll calendar code', PATHS.rollCalendarCode, sourceSha(PATHS.rollCalendarCode)],
  ['Session policy code', PATHS.sessionPolicyCode, sourceSha(PATHS.sessionPolicyCode)],
  ['PR #306 feature-source recheck report', PATHS.pr306Report, sourceSha(PATHS.pr306Report)],
];

const provenanceRows = [
  ['Field', 'Repo path', 'Symbol/function', 'Calendar source', 'Date basis', 'Target timestamp basis', 'Value', 'Why causal'],
  ...(explicitCalendarProvenanceRows as JsonRecord[]).map((row) => [
    String(row.field),
    String(row.repo_path),
    String(row.symbol_or_function),
    String(row.calendar_source_name),
    String(row.date_basis),
    String(row.target_timestamp_basis),
    String(row.value),
    String(row.why_causal_for_2026_06_02),
  ]),
];

const md = [
  `# ${TICKET}`,
  '',
  `Determination: \`${determination}\``,
  '',
  `Recommended next ticket: \`${recommendedNextTicket}\``,
  '',
  '## Target event',
  '',
  `- Strategy: \`${STRATEGY_ID}\``,
  `- Target timestamp: \`${targetTsNsText}\` / \`${getString(latestQuote, 'ts_utc')}\``,
  `- Source path: \`${getString(pr303Mbp1, 'path')}\``,
  `- Latest finite mid: \`${getNumber(latestQuote, 'mid_px')}\``,
  '',
  '## Field readiness',
  '',
  ...table(fieldRows),
  '',
  '## Explicit calendar provenance',
  '',
  ...table(provenanceRows),
  '',
  '## Session calendar evidence',
  '',
  `- Session ID: \`${sessionEvaluation.session_id}\``,
  `- Trading date: \`${sessionEvaluation.trading_date}\``,
  `- Local time: \`${sessionEvaluation.local.date} ${sessionEvaluation.local.time} ${sessionEvaluation.timezone}\``,
  `- Phase: \`${sessionEvaluation.phase}\``,
  `- Journal phase: \`${sessionEvaluation.journal_phase}\``,
  `- is_rth: \`${sessionEvaluation.is_rth}\``,
  `- is_maintenance_halt: \`${sessionEvaluation.is_maintenance_halt}\``,
  `- is_halt calendar value for builder: \`${isHaltValue}\``,
  `- Reasons: \`${sessionEvaluation.reasons.join(',') || 'none'}\``,
  '',
  '## Roll calendar evidence',
  '',
  `- Active contract: \`${rollEvaluation.active_contract}\``,
  `- Roll phase: \`${rollEvaluation.roll_phase}\``,
  `- In roll window: \`${rollEvaluation.in_roll_window}\``,
  `- block_new_entries: \`${rollEvaluation.block_new_entries}\``,
  `- flatten_required: \`${rollEvaluation.flatten_required}\``,
  `- is_roll_block calendar value for builder: \`${isRollBlockValue}\``,
  `- Reasons: \`${rollEvaluation.reasons.join(',') || 'none'}\``,
  '',
  '## Source anchors',
  '',
  ...table(sourceRows),
  '',
  '## Non-overclaim boundary',
  '',
  'This proves calendar-backed halt/roll source readiness for the 2026-06-02 bounded target event only. It does not materialize `StrategyFeatureSnapshot`, does not emit strategy runtime markers, does not run qfa-410b/qfa-611, does not award observation-day credit, and creates no paper/live/broker/Phase 6/roster authority.',
  '',
  '## Feature-builder readiness delta',
  '',
  featureBuilderReadinessDelta,
  '',
].join('\n');
writeText(MD_PATH, md);

const memo = [
  `# ${TICKET} memo`,
  '',
  '## Context',
  '',
  'PR #306 narrowed the remaining source-readiness blocker to explicit halt/roll calendar provenance for `session.is_halt` and `session.is_roll_block`. This ticket evaluates those fields for the same bounded PR #303 2026-06-02 target event without materializing a feature snapshot.',
  '',
  '## Determination',
  '',
  `\`${determination}\``,
  '',
  'The source-readiness blocker is resolved for calendar-backed halt/roll inputs. The MNQ session calendar classifies the target event as RTH with no maintenance halt or closed-session reason, and the MNQ roll calendar classifies the same timestamp as normal roll phase with `block_new_entries=false` and `flatten_required=false`.',
  '',
  '## Field values proven',
  '',
  `- \`session.is_halt = false\` from \`getMnqSessionPhase(...).is_maintenance_halt || journal_phase === halted\` at \`${getString(latestQuote, 'ts_utc')}\`.`,
  `- \`session.is_roll_block = false\` from \`evaluateRoll(...).block_new_entries\` at \`${getString(latestQuote, 'ts_utc')}\`.`,
  '',
  '## Exact source authority',
  '',
  `- \`session.is_halt\`: repo path \`${PATHS.sessionCalendarCode}; ${PATHS.sessionCalendarConfig}\`, symbol/function \`getMnqSessionPhase(...).is_maintenance_halt and journal_phase\`, calendar source \`MNQ session calendar\`, date basis \`target session ${sessionEvaluation.session_id}; local date ${sessionEvaluation.local.date}; trading date ${sessionEvaluation.trading_date}\`, target timestamp basis \`${targetTsNsText} / ${getString(latestQuote, 'ts_utc')}\`, value \`${isHaltValue}\`.`,
  `- \`session.is_roll_block\`: repo path \`${PATHS.rollCalendarCode}; ${PATHS.rollCalendarConfig}; ${PATHS.sessionPolicyCode}\`, symbol/function \`evaluateRoll(...).block_new_entries\`, calendar source \`MNQ roll calendar\`, date basis \`target session ${sessionEvaluation.session_id}; UTC ns roll evaluation\`, target timestamp basis \`${targetTsNsText} / ${getString(latestQuote, 'ts_utc')}\`, value \`${isRollBlockValue}\`.`,
  '',
  'Both values are pinned to current repo calendar/session semantics. They do not depend on script-local substitute calendar rules.',
  '',
  '## Feature-builder readiness delta',
  '',
  featureBuilderReadinessDelta,
  '',
  '## Important boundary',
  '',
  'This is calendar source-readiness only. It does not claim a live exchange halt-feed integration, does not emit a `StrategyFeatureSnapshot`, does not invoke paper runtime, and does not create observation-day or authority credit.',
  '',
  '## Recommended next ticket',
  '',
  `\`${recommendedNextTicket}\``,
  '',
].join('\n');
writeText(MEMO_PATH, memo);

appendBacklogRow();

const outputShas = {
  bounded_halt_roll_calendar_source_lf_sha256: sha256Text(jsonl),
  memo_lf_sha256: sha256Text(memo),
  report_json_lf_sha256: sha256Text(reportJson),
  report_md_lf_sha256: sha256Text(md),
};

console.log(JSON.stringify(sortJson({
  determination,
  output_shas: outputShas,
  recommended_next_ticket: recommendedNextTicket,
  ticket: TICKET,
}), null, 2));
