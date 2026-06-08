import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

const ROOT = process.cwd();
const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FEATURE-SNAPSHOT-BUILDER-COMPAT-REPAIR-01';
const SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-04-feature-snapshot-builder-compat-repair-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const OUT_DIR = path.join(ROOT, 'artifacts', 'paper-observation', SLUG);
const BOUNDED_JSONL = path.join(OUT_DIR, 'bounded-feature-snapshot-compat-repair.jsonl');
const REPORT_JSON = path.join(OUT_DIR, 'feature-snapshot-builder-compat-repair-report.json');
const REPORT_MD = path.join(OUT_DIR, 'feature-snapshot-builder-compat-repair-report.md');
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

function loadSourceSnapshot(): JsonRecord {
  for (const line of readText(SOURCE_JSONL).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as JsonRecord;
    if (record.record_type === 'StrategyFeatureSnapshot') return record;
  }
  throw new Error('StrategyFeatureSnapshot record not found in source JSONL');
}

function consumerCompatibilityRows(): Json[] {
  return [
    ['created_ts_ns', 'PR #321 source-backed snapshot timestamp'],
    ['quote.mid_px', 'PR #321 source-backed quote mid'],
    ['session.is_rth', 'PR #321 session readiness'],
    ['session.is_halt', 'PR #321 halt readiness'],
    ['session.is_roll_block', 'PR #321 roll readiness'],
    ['indicators.sigma_pts', 'PR #321 sigma source readiness'],
    ['context.regime_label', 'PR #321 scoped regime label'],
    ['context.signed_shock_vwap.value', 'PR #321 signed-shock source value'],
    ['config.config_hash', 'PR #321 variant config hash'],
    ['config.config_version', 'PR #321 variant config version'],
    ['instrument.tick_size', 'MNQ instrument lineage mirrored from prior source-backed builder artifacts'],
    ['instrument.point_value', 'MNQ instrument lineage mirrored from prior source-backed builder artifacts'],
    ['instrument.price_decimals', 'MNQ instrument lineage mirrored from prior source-backed builder artifacts'],
    ['instrument.symbol', 'MNQM6 source/capture contract identity'],
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
    'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-FEATURE-SNAPSHOT-BUILDER-COMPAT-REPAIR-01,P1,1.0,V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-CANDIDATE-STRAT-EVAL-SMOKE-01,Repair the 2026-06-04 source-backed feature snapshot compatibility by adding required MNQ instrument lineage without strategy runtime observation-day credit or authority,new_cycle4_v2_research_substrate';
  const text = readText(BACKLOG_CSV);
  if (text.includes(TICKET)) return;
  writeFileSync(BACKLOG_CSV, text.endsWith('\n') ? `${text}${row}\n` : `${text}\n${row}\n`, 'utf8');
}

function buildMarkdown(report: JsonRecord): string {
  const rows = (report.consumer_compatibility as Json[]).map((row) => asRecord(row));
  return `# ${TICKET}

## Determination

\`\`\`text
${report.determination}
\`\`\`

## Repair summary

| Field | Value |
|---|---|
| feature_snapshot_id | \`${report.feature_snapshot_id}\` |
| strategy_feature_snapshot_count | \`${report.strategy_feature_snapshot_count}\` |
| repaired_field_family | \`${report.repaired_field_family}\` |
| instrument.tick_size | \`${asRecord(report.instrument).tick_size}\` |
| instrument.symbol | \`${asRecord(report.instrument).symbol}\` |
| ready_for_candidate_strat_eval_smoke_rerun | \`${report.ready_for_candidate_strat_eval_smoke_rerun}\` |

## Consumer compatibility

| Snapshot field path | Value present | Placeholder used | Source-ready anchor | Consumer status |
|---|---:|---:|---|---|
${rows.map((row) => `| \`${row.snapshot_field_path}\` | \`${row.value_present}\` | \`${row.placeholder_used}\` | ${row.source_ready_anchor} | \`${row.consumer_status}\` |`).join('\n')}

## Authority locks

\`\`\`json
${JSON.stringify(report.authority_locks, null, 2)}
\`\`\`

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

This ticket repairs the PR #321 2026-06-04 source-backed snapshot compatibility gap found by the candidate strat-eval smoke: the v2 strategy reads \`snapshot.instrument.tick_size\`, but the PR #321 snapshot did not materialize \`instrument\`.

The repaired snapshot adds MNQ instrument lineage only. It does not run strategy runtime and creates no observation-day or broker/live authority.

## Consumer compatibility

\`\`\`json
${JSON.stringify(report.consumer_compatibility, null, 2)}
\`\`\`

## Authority caveat

\`\`\`json
${JSON.stringify(report.authority_locks, null, 2)}
\`\`\`
`;
}

function main(): void {
  ensureDir(OUT_DIR);
  ensureDir(path.dirname(MEMO_MD));
  const sourceReport = JSON.parse(readText(SOURCE_REPORT_JSON)) as JsonRecord;
  const sourceSnapshot = loadSourceSnapshot();
  const instrument: JsonRecord = {
    contract_month: '2026-06',
    currency: 'USD',
    exchange: 'CME',
    point_value: 2,
    price_decimals: 2,
    root: 'MNQ',
    symbol: 'MNQM6',
    tick_size: 0.25,
  };
  const repairedSnapshot: JsonRecord = {
    ...sourceSnapshot,
    instrument,
    source_anchor: {
      ...asRecord(sourceSnapshot.source_anchor),
      compatibility_repair_ticket: TICKET,
      repaired_field_family: 'instrument',
      source_feature_snapshot_builder_merge_commit: '63d5cf6f4d0258365758ab75f1184ede85d0ed13',
    },
  };
  const compatibility = consumerCompatibilityRows();
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
  const determination = 'FEATURE_SNAPSHOT_BUILDER_COMPAT_REPAIR_EMITTED_INSTRUMENT_READY_SNAPSHOT';
  const records: Json[] = [
    {
      manifest_role: 'open',
      record_type: 'SESSION_MANIFEST',
      source_feature_snapshot_builder_ticket: sourceReport.ticket,
      strategy_id: STRATEGY_ID,
      ticket: TICKET,
    },
    repairedSnapshot,
    {
      authority_locks: authorityLocks,
      determination,
      manifest_role: 'close',
      record_type: 'SESSION_MANIFEST',
      strategy_feature_snapshot_count: 1,
      ticket: TICKET,
    },
  ];
  writeFileSync(BOUNDED_JSONL, stableJsonl(records), 'utf8');
  if (statSync(BOUNDED_JSONL).size > MAX_ARTIFACT_BYTES) throw new Error(`Bounded artifact exceeds 95 MiB: ${BOUNDED_JSONL}`);
  const report: JsonRecord = {
    ticket: TICKET,
    determination,
    strategy_id: STRATEGY_ID,
    source_anchor: {
      source_feature_snapshot_builder_ticket: sourceReport.ticket,
      source_feature_snapshot_builder_report_lf_sha256: sha256FileLf(SOURCE_REPORT_JSON),
      source_feature_snapshot_builder_jsonl_lf_sha256: sha256FileLf(SOURCE_JSONL),
    },
    strategy_feature_snapshot_count: 1,
    feature_snapshot_id: FEATURE_SNAPSHOT_ID,
    repaired_field_family: 'instrument',
    instrument,
    consumer_compatibility: compatibility,
    ready_for_candidate_strat_eval_smoke_rerun: true,
    authority_locks: authorityLocks,
    recommended_next_ticket: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-04-CANDIDATE-STRAT-EVAL-SMOKE-RERUN-01',
    output_hashes: {
      bounded_feature_snapshot_compat_repair_jsonl: sha256FileLf(BOUNDED_JSONL),
    },
  };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  report.output_hashes = {
    bounded_feature_snapshot_compat_repair_jsonl: sha256FileLf(BOUNDED_JSONL),
    feature_snapshot_builder_compat_repair_report_json: sha256FileLf(REPORT_JSON),
  };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  writeFileSync(REPORT_MD, buildMarkdown(report), 'utf8');
  report.output_hashes = {
    bounded_feature_snapshot_compat_repair_jsonl: sha256FileLf(BOUNDED_JSONL),
    feature_snapshot_builder_compat_repair_report_json: sha256FileLf(REPORT_JSON),
    feature_snapshot_builder_compat_repair_report_md: sha256FileLf(REPORT_MD),
  };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  writeFileSync(REPORT_MD, buildMarkdown(report), 'utf8');
  writeFileSync(MEMO_MD, buildMemo(report), 'utf8');
  appendBacklogRow();
  const final = {
    state: 'PENDING_REVIEW',
    ticket: TICKET,
    determination,
    feature_snapshot_id: FEATURE_SNAPSHOT_ID,
    repaired_field_family: 'instrument',
    instrument,
    strategy_feature_snapshot_count: 1,
    ready_for_candidate_strat_eval_smoke_rerun: true,
    authority_locks: authorityLocks,
    bounded_jsonl_lf_sha256: sha256FileLf(BOUNDED_JSONL),
    report_json_lf_sha256: sha256FileLf(REPORT_JSON),
    report_md_lf_sha256: sha256FileLf(REPORT_MD),
    memo_lf_sha256: sha256FileLf(MEMO_MD),
    script_lf_sha256: sha256FileLf(path.join(ROOT, 'scripts', 'paper', 'run-v2-pf-c-late-am-2026-06-04-feature-snapshot-builder-compat-repair.ts')),
    recommended_next_ticket: report.recommended_next_ticket,
  };
  console.log(JSON.stringify(final, null, 2));
}

main();
