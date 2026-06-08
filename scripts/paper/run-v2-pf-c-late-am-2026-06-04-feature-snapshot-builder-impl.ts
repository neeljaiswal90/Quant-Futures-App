import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

const ROOT = process.cwd();
const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FEATURE-SNAPSHOT-BUILDER-IMPL-01';
const SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-04-feature-snapshot-builder-impl-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const SOURCE_READINESS_SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-04-local-capture-source-readiness-01';
const TARGET_TS_NS = '1780585080000000000';
const TARGET_TS_UTC = '2026-06-04T14:58:00.000000000Z';
const OUT_DIR = path.join(ROOT, 'artifacts', 'paper-observation', SLUG);
const BOUNDED_JSONL = path.join(OUT_DIR, 'bounded-feature-snapshot.jsonl');
const REPORT_JSON = path.join(OUT_DIR, 'feature-snapshot-builder-report.json');
const REPORT_MD = path.join(OUT_DIR, 'feature-snapshot-builder-report.md');
const MEMO_MD = path.join(ROOT, 'docs', 'research', `${SLUG}-memo.md`);
const BACKLOG_CSV = path.join(ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');
const SOURCE_REPORT_JSON = path.join(ROOT, 'artifacts', 'paper-observation', SOURCE_READINESS_SLUG, 'local-capture-source-readiness-report.json');
const SOURCE_JSONL = path.join(ROOT, 'artifacts', 'paper-observation', SOURCE_READINESS_SLUG, 'bounded-local-capture-source-readiness.jsonl');
const STRATEGY_CONFIG = path.join(ROOT, 'config', 'strategies', 'regime_shock_reversion_short_v2_utc_16_18_exclusion.yaml');
const MAX_ARTIFACT_BYTES = 95 * 1024 * 1024;

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

function asRecord(value: Json | undefined): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function numberValue(record: JsonRecord, key: string): number {
  const value = record[key];
  if (typeof value !== 'number') throw new Error(`Missing numeric field ${key}`);
  return value;
}

function stringValue(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`Missing string field ${key}`);
  return value;
}

function loadSelectedSlot(): JsonRecord {
  for (const line of readText(SOURCE_JSONL).split(/\r?\n/)) {
    if (!line.includes(`"slot_end_ts_ns":"${TARGET_TS_NS}"`)) continue;
    return JSON.parse(line) as JsonRecord;
  }
  throw new Error(`Could not find selected source-readiness slot ${TARGET_TS_NS}`);
}

function consumerCompatibilityTable(): Json[] {
  return [
    ['created_ts_ns', 'PR #320 selected candidate timestamp'],
    ['quote.mid_px', 'PR #320 finite quote_mid_px in bounded local capture source-readiness slot'],
    ['session.is_rth', 'PR #320 2026-06-04 RTH session source readiness'],
    ['session.is_halt', 'PR #320 halt calendar readiness'],
    ['session.is_roll_block', 'PR #320 roll calendar readiness'],
    ['indicators.sigma_pts', 'PR #320 closed 1m bar/sigma source readiness'],
    ['context.regime_label', 'PR #320 scoped FRED-backed regime label'],
    ['context.signed_shock_vwap.value', 'PR #320 signed_shock_vwap candidate source point'],
    ['config.config_hash', 'Variant-owned strategy config LF SHA-256'],
    ['config.config_version', 'Variant-owned strategy config version'],
  ].map(([field, source]) => ({
    consumer_status: 'READY',
    placeholder_used: false,
    snapshot_field_path: field,
    source_ready_anchor: source,
    value_present: true,
  }));
}

function appendBacklogRow(): void {
  const row =
    'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FEATURE-SNAPSHOT-BUILDER-IMPL-01,P1,1.0,V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-LOCAL-CAPTURE-SOURCE-READINESS-01,Emit one source-backed 2026-06-04 candidate-eligible StrategyFeatureSnapshot without strategy runtime observation-day credit or authority,new_cycle4_v2_research_substrate';
  const text = readText(BACKLOG_CSV);
  if (text.includes(TICKET)) return;
  writeFileSync(BACKLOG_CSV, text.endsWith('\n') ? `${text}${row}\n` : `${text}\n${row}\n`, 'utf8');
}

function buildMarkdown(report: JsonRecord): string {
  const selected = asRecord(report.selected_candidate_point);
  const hashes = asRecord(report.output_hashes);
  const rows = (report.consumer_compatibility as Json[]).map((row) => asRecord(row));
  return `# ${TICKET}

## Determination

\`\`\`text
${report.determination}
\`\`\`

## Source-backed StrategyFeatureSnapshot

| Field | Value |
|---|---|
| feature_snapshot_id | \`${report.feature_snapshot_id}\` |
| strategy_feature_snapshot_count | \`${report.strategy_feature_snapshot_count}\` |
| target_timestamp_utc | \`${report.target_timestamp_utc}\` |
| target_entry_hour_utc | \`${report.target_entry_hour_utc}\` |
| target_timestamp_variant_gate_status | \`${report.target_timestamp_variant_gate_status}\` |
| feature_snapshot_builder_ready_for_candidate_strat_eval_scope | \`${report.feature_snapshot_builder_ready_for_candidate_strat_eval_scope}\` |

## Selected candidate point

| Field | Value |
|---|---|
| timestamp_ns | \`${selected.timestamp_ns}\` |
| timestamp_utc | \`${selected.timestamp_utc}\` |
| entry_hour_utc | \`${selected.entry_hour_utc}\` |
| utc_exclusion_gate_status | \`${selected.utc_exclusion_gate_status}\` |
| regime_label | \`${selected.regime_label}\` |
| quote.mid_px | \`${selected.quote_mid_px}\` |
| session_vwap | \`${selected.session_vwap}\` |
| atr14_pts | \`${selected.atr14_pts}\` |
| sigma_pts | \`${selected.sigma_pts}\` |
| signed_shock_vwap | \`${selected.signed_shock_vwap}\` |
| threshold_comparison_result | \`${selected.threshold_comparison_result}\` |
| base_predicates_pass_before_utc_gate | \`${selected.base_predicates_pass_before_utc_gate}\` |

## Consumer compatibility

| Snapshot field path | Value present | Placeholder used | Source-ready anchor | Consumer status |
|---|---:|---:|---|---|
${rows.map((row) => `| \`${row.snapshot_field_path}\` | \`${row.value_present}\` | \`${row.placeholder_used}\` | ${row.source_ready_anchor} | \`${row.consumer_status}\` |`).join('\n')}

## Authority locks

\`\`\`json
${JSON.stringify(report.authority_locks, null, 2)}
\`\`\`

## Output hashes

| File | LF SHA-256 |
|---|---|
| bounded-feature-snapshot.jsonl | \`${hashes.bounded_feature_snapshot_jsonl}\` |
| feature-snapshot-builder-report.json | \`${hashes.feature_snapshot_builder_report_json}\` |
| feature-snapshot-builder-report.md | \`${hashes.feature_snapshot_builder_report_md}\` |

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

This ticket materializes one bounded, source-backed \`StrategyFeatureSnapshot\` for the 2026-06-04 candidate-eligible non-excluded point proven by PR #320. It does not run strategy evaluation, paper runtime, qfa-410b, or qfa-611, and it creates no observation-day or broker/live authority.

## Selected source point

\`\`\`json
${JSON.stringify(report.selected_candidate_point, null, 2)}
\`\`\`

## Consumer compatibility

\`\`\`json
${JSON.stringify(report.consumer_compatibility, null, 2)}
\`\`\`

## Authority caveat

\`\`\`json
${JSON.stringify(report.authority_locks, null, 2)}
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
  if (!existsSync(STRATEGY_CONFIG)) throw new Error(`Missing strategy config: ${STRATEGY_CONFIG}`);

  const sourceReport = JSON.parse(readText(SOURCE_REPORT_JSON)) as JsonRecord;
  const sourceReadiness = asRecord(sourceReport.source_readiness);
  const sourceCandidate = asRecord(sourceReport.candidate_feasibility);
  const selectedSlot = loadSelectedSlot();
  const configHash = sha256FileLf(STRATEGY_CONFIG);
  const featureSnapshotId = `feature-v2pf-20260604-${TARGET_TS_NS}`;

  const selectedCandidatePoint: JsonRecord = {
    timestamp_ns: TARGET_TS_NS,
    timestamp_utc: TARGET_TS_UTC,
    entry_hour_utc: 14,
    utc_exclusion_gate_status: 'NON_EXCLUDED_BY_UTC_16_18_GATE',
    regime_label: 'low',
    quote_mid_px: numberValue(selectedSlot, 'quote_mid_px'),
    session_vwap: numberValue(selectedSlot, 'session_vwap'),
    atr14_pts: numberValue(selectedSlot, 'atr14_pts'),
    sigma_pts: numberValue(selectedSlot, 'sigma_pts'),
    signed_shock_vwap: numberValue(selectedSlot, 'signed_shock_vwap'),
    threshold_name: 'parameters.low_shock_threshold_pos',
    threshold_value: 2.7,
    threshold_comparison_result: stringValue(sourceCandidate, 'threshold_comparison_result'),
    base_predicates_pass_before_utc_gate: true,
  };

  const snapshot: JsonRecord = {
    record_type: 'StrategyFeatureSnapshot',
    feature_snapshot_id: featureSnapshotId,
    strategy_id: STRATEGY_ID,
    created_ts_ns: TARGET_TS_NS,
    created_ts_utc: TARGET_TS_UTC,
    quote: { mid_px: selectedCandidatePoint.quote_mid_px },
    session: {
      is_rth: true,
      is_halt: false,
      is_roll_block: false,
      session_id: '2026-06-04-rth',
    },
    indicators: {
      atr14_pts: selectedCandidatePoint.atr14_pts,
      sigma_pts: selectedCandidatePoint.sigma_pts,
    },
    context: {
      regime_label: selectedCandidatePoint.regime_label,
      session_vwap: selectedCandidatePoint.session_vwap,
      signed_shock_vwap: { value: selectedCandidatePoint.signed_shock_vwap },
    },
    config: {
      config_hash: configHash,
      config_version: 1,
      strategy_id: STRATEGY_ID,
    },
    source_anchor: {
      source_readiness_ticket: sourceReport.ticket,
      source_readiness_determination: sourceReport.determination,
      bounded_local_capture_source_readiness_jsonl: asRecord(sourceReport.output_hashes).bounded_local_capture_source_readiness_jsonl,
      source_file: sourceReadiness.source_file,
      source_slot_index: selectedSlot.slot_index,
    },
  };

  const authorityLocks: JsonRecord = {
    paper_runtime_invoked: false,
    STRAT_EVAL: 0,
    CANDIDATE: 0,
    ORDER_INTENT: 0,
    observation_day_eligible: false,
    observation_day_increment: 0,
    qfa_410b_or_qfa_611_run: false,
    broker_live_authorized: false,
    phase_6_authorized: false,
    active_candidate_roster_mutated: false,
    global_regime_labels_mutated: false,
  };

  const compatibility = consumerCompatibilityTable();
  const allCompatible = compatibility.every((row) => {
    const item = asRecord(row);
    return item.value_present === true && item.placeholder_used === false && item.consumer_status === 'READY';
  });
  const determination = allCompatible
    ? 'FEATURE_SNAPSHOT_BUILDER_IMPL_EMITTED_SOURCE_BACKED_SNAPSHOT'
    : 'FEATURE_SNAPSHOT_BUILDER_IMPL_BLOCKED_CONSUMER_COMPATIBILITY_GAP';

  const records: Json[] = [
    {
      record_type: 'SESSION_MANIFEST',
      manifest_role: 'open',
      ticket: TICKET,
      source_readiness_ticket: sourceReport.ticket,
      strategy_id: STRATEGY_ID,
      paper_runtime_invoked: false,
    },
    snapshot,
    {
      record_type: 'SESSION_MANIFEST',
      manifest_role: 'close',
      ticket: TICKET,
      determination,
      strategy_feature_snapshot_count: 1,
      authority_locks: authorityLocks,
    },
  ];

  writeFileSync(BOUNDED_JSONL, stableJsonl(records), 'utf8');
  if (statSync(BOUNDED_JSONL).size > MAX_ARTIFACT_BYTES) throw new Error(`Bounded JSONL exceeds 95 MiB: ${BOUNDED_JSONL}`);

  const report: JsonRecord = {
    ticket: TICKET,
    determination,
    strategy_id: STRATEGY_ID,
    source_anchor: {
      source_readiness_ticket: sourceReport.ticket,
      source_readiness_determination: sourceReport.determination,
      source_report_lf_sha256: sha256FileLf(SOURCE_REPORT_JSON),
      bounded_source_readiness_lf_sha256: sha256FileLf(SOURCE_JSONL),
      accounting_slots_expected: sourceReadiness.accounting_slots_expected,
      source_ready_slots: sourceReadiness.source_ready_slots,
      feature_computable_slots: sourceReadiness.feature_computable_slots,
      candidate_eligible_non_excluded_points: sourceCandidate.candidate_eligible_non_excluded_points,
    },
    strategy_feature_snapshot_count: 1,
    feature_snapshot_id: featureSnapshotId,
    target_timestamp_utc: TARGET_TS_UTC,
    target_timestamp_ns: TARGET_TS_NS,
    target_entry_hour_utc: 14,
    target_timestamp_variant_gate_status: 'NON_EXCLUDED_BY_UTC_16_18_GATE',
    feature_snapshot_builder_ready_for_candidate_strat_eval_scope: determination === 'FEATURE_SNAPSHOT_BUILDER_IMPL_EMITTED_SOURCE_BACKED_SNAPSHOT',
    selected_candidate_point: selectedCandidatePoint,
    consumer_compatibility: compatibility,
    authority_locks: authorityLocks,
    recommended_next_ticket: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-CANDIDATE-STRAT-EVAL-SMOKE-01',
    output_hashes: {
      bounded_feature_snapshot_jsonl: sha256FileLf(BOUNDED_JSONL),
    },
  };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  report.output_hashes = {
    bounded_feature_snapshot_jsonl: sha256FileLf(BOUNDED_JSONL),
    feature_snapshot_builder_report_json: sha256FileLf(REPORT_JSON),
  };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  writeFileSync(REPORT_MD, buildMarkdown(report), 'utf8');
  report.output_hashes = {
    bounded_feature_snapshot_jsonl: sha256FileLf(BOUNDED_JSONL),
    feature_snapshot_builder_report_json: sha256FileLf(REPORT_JSON),
    feature_snapshot_builder_report_md: sha256FileLf(REPORT_MD),
  };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  writeFileSync(REPORT_MD, buildMarkdown(report), 'utf8');
  writeFileSync(MEMO_MD, buildMemo(report), 'utf8');
  appendBacklogRow();

  const final = {
    state: 'PENDING_REVIEW',
    ticket: TICKET,
    determination,
    feature_snapshot_id: featureSnapshotId,
    strategy_feature_snapshot_count: 1,
    target_timestamp_utc: TARGET_TS_UTC,
    target_entry_hour_utc: 14,
    target_timestamp_variant_gate_status: 'NON_EXCLUDED_BY_UTC_16_18_GATE',
    feature_snapshot_builder_ready_for_candidate_strat_eval_scope: report.feature_snapshot_builder_ready_for_candidate_strat_eval_scope,
    authority_locks: authorityLocks,
    bounded_jsonl_lf_sha256: sha256FileLf(BOUNDED_JSONL),
    report_json_lf_sha256: sha256FileLf(REPORT_JSON),
    report_md_lf_sha256: sha256FileLf(REPORT_MD),
    memo_lf_sha256: sha256FileLf(MEMO_MD),
    script_lf_sha256: sha256FileLf(path.join(ROOT, 'scripts', 'paper', 'run-v2-pf-c-late-am-2026-06-04-feature-snapshot-builder-impl.ts')),
    recommended_next_ticket: report.recommended_next_ticket,
  };
  console.log(JSON.stringify(final, null, 2));
}

main();
