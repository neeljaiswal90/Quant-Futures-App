import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | JsonRecord;
type JsonRecord = { [key: string]: JsonValue };

const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-REGIME-LABEL-SOURCE-ACQUIRE-01';
const TARGET_SESSION_ID = '2026-06-02-rth';
const TARGET_PRIOR_CLOSE_DATE = '2026-06-01';
const PR304_REPORT = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-regime-label-source-inputs-extend-01/regime-label-source-inputs-report.json';
const PR304_BOUNDED = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-regime-label-source-inputs-extend-01/bounded-regime-label-source-inputs.jsonl';
const GLOBAL_REGIME_LABELS = 'artifacts/regime/regime-labels.json';
const OUTPUT_DIR = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-regime-label-source-acquire-01';
const OUTPUT_JSONL = `${OUTPUT_DIR}/scoped-regime-label-source.jsonl`;
const OUTPUT_JSON = `${OUTPUT_DIR}/regime-label-source-acquire-report.json`;
const OUTPUT_MD = `${OUTPUT_DIR}/regime-label-source-acquire-report.md`;
const MEMO_PATH = 'docs/research/v2-pf-c-late-am-paper-observation-2026-06-02-regime-label-source-acquire-01-memo.md';
const BACKLOG_PATH = 'docs/plan/new_app_v1_ticket_backlog_v6.csv';
const BACKLOG_ROW = `${TICKET},P1,1.0,V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-REGIME-LABEL-SOURCE-INPUTS-EXTEND-01,Acquire scoped 2026-06-02-rth regime-label source artifact from PR304 source inputs without mutating global regime labels or creating feature snapshots strategy markers observation-day credit or authority,new_cycle4_v2_research_substrate`;

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function stableJson(value: JsonValue): string {
  return `${stableStringify(value)}\n`;
}

function stableJsonl(records: JsonRecord[]): string {
  return `${records.map((record) => stableStringify(record)).join('\n')}\n`;
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function sha256File(path: string): Promise<string> {
  return sha256Text((await readFile(path, 'utf8')).replace(/\r\n/g, '\n'));
}

async function readJson(path: string): Promise<JsonRecord> {
  return JSON.parse(await readFile(path, 'utf8')) as JsonRecord;
}

function asRecord(value: unknown): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function rawLabelFromPercentile(percentile: number | null): 'low' | 'mid' | 'high' | null {
  if (percentile === null) {
    return null;
  }
  if (percentile < 0.33) {
    return 'low';
  }
  if (percentile < 0.67) {
    return 'mid';
  }
  return 'high';
}

function applyHysteresis(input: {
  readonly previousConfirmedLabel: string | null;
  readonly rawLabel: string | null;
  readonly primaryPercentile: number | null;
}): { readonly confirmedLabel: string | null; readonly transitionPending: boolean; readonly rationale: string } {
  if (input.rawLabel === null || input.primaryPercentile === null) {
    return { confirmedLabel: null, transitionPending: false, rationale: 'missing raw label or percentile' };
  }
  if (input.previousConfirmedLabel === null || input.previousConfirmedLabel === input.rawLabel) {
    return {
      confirmedLabel: input.rawLabel,
      transitionPending: false,
      rationale: 'raw label matches previous confirmed label or no previous confirmed label is available',
    };
  }
  return {
    confirmedLabel: input.previousConfirmedLabel,
    transitionPending: true,
    rationale: 'raw label differs from previous confirmed label; two-session hysteresis confirmation is outside this single-session scoped acquisition',
  };
}

function markdownTable(rows: [string, JsonValue][]): string {
  return [
    '| Field | Value |',
    '|---|---|',
    ...rows.map(([field, value]) => `| ${field} | ${String(value)} |`),
  ].join('\n');
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
}

async function updateBacklog(): Promise<void> {
  const existing = await readFile(BACKLOG_PATH, 'utf8');
  if (existing.includes(`${TICKET},`)) {
    return;
  }
  const suffix = existing.endsWith('\n') ? '' : '\n';
  await writeFile(BACKLOG_PATH, `${existing}${suffix}${BACKLOG_ROW}\n`, 'utf8');
}

async function main(): Promise<void> {
  const pr304 = await readJson(PR304_REPORT);
  const globalLabels = await readJson(GLOBAL_REGIME_LABELS);
  const readiness = asRecord(pr304.qfa212_source_input_readiness);
  const vixVxn = asRecord(pr304.vix_vxn_source_extension);
  const targetValues = asRecord(vixVxn.target_prior_close_values);
  const labels = asArray(globalLabels.labels).map((entry) => asRecord(entry));
  const currentTarget = labels.find((entry) => entry.session_id === TARGET_SESSION_ID) ?? null;
  const lastExisting = labels[labels.length - 1] ?? {};
  const existingAnchor = asRecord(readiness.existing_last_confirmed_label_anchor);
  const primaryValue = numberOrNull(readiness.primary_value);
  const primaryPercentile = numberOrNull(readiness.primary_percentile_diagnostic_only);
  const rawLabel = stringOrNull(readiness.raw_label_diagnostic_only) ?? rawLabelFromPercentile(primaryPercentile);
  const previousConfirmedLabel = stringOrNull(existingAnchor.confirmed_label) ?? stringOrNull(lastExisting.confirmed_label);
  const hysteresis = applyHysteresis({ previousConfirmedLabel, rawLabel, primaryPercentile });
  const sourceInputsReady = Boolean(readiness.source_inputs_ready_for_scoped_label_acquire)
    && Boolean(pr304.source_inputs_ready_for_scoped_label_acquire)
    && currentTarget === null
    && hysteresis.confirmedLabel !== null
    && primaryValue !== null
    && primaryPercentile !== null;
  const scopedLabel: JsonRecord = {
    session_id: TARGET_SESSION_ID,
    label_status: sourceInputsReady ? 'available' : 'blocked',
    confirmed_label: hysteresis.confirmedLabel,
    raw_label: rawLabel,
    primary_value: primaryValue,
    primary_percentile: primaryPercentile,
    primary_prior_close_date: TARGET_PRIOR_CLOSE_DATE,
    vxn_value: numberOrNull(targetValues.VXNCLS),
    vxn_percentile: null,
    vxn_raw_label: null,
    vxn_status: 'diagnostic_value_available_percentile_not_materialized',
    secondary_value: null,
    secondary_raw_rv: null,
    secondary_percentile: null,
    secondary_label: null,
    secondary_percentile_basis: null,
    secondary_percentile_window_sessions: null,
    secondary_status: 'not_materialized_in_scoped_paper_observation_label',
    disagreement_score: null,
    transition_pending: hysteresis.transitionPending,
    partial_session: false,
    quality_excluded: false,
    quality_exclusion_reason: null,
    use_for_calibration: false,
    materialization_scope: 'scoped_paper_observation_source_only',
    global_regime_labels_mutated: false,
    authority_note: 'not a canonical global regime-label mutation',
  };
  const determination = sourceInputsReady
    ? 'SCOPED_REGIME_LABEL_SOURCE_ACQUIRED_NOT_GLOBAL'
    : 'SCOPED_REGIME_LABEL_SOURCE_ACQUIRE_BLOCKED';
  const recommendedNextTicket = sourceInputsReady
    ? 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FEATURE-SOURCE-RECHECK-01'
    : TICKET;
  const records: JsonRecord[] = [
    {
      record_type: 'PR304_SOURCE_INPUT_ANCHOR',
      ticket: TICKET,
      payload: {
        report_path: PR304_REPORT,
        report_lf_sha256: await sha256File(PR304_REPORT),
        bounded_source_path: PR304_BOUNDED,
        bounded_source_lf_sha256: await sha256File(PR304_BOUNDED),
        determination: String(pr304.determination),
        source_inputs_ready_for_scoped_label_acquire: Boolean(pr304.source_inputs_ready_for_scoped_label_acquire),
        target_session_id: TARGET_SESSION_ID,
        target_prior_close_date: TARGET_PRIOR_CLOSE_DATE,
        target_vixcls: numberOrNull(targetValues.VIXCLS),
        target_vxncls: numberOrNull(targetValues.VXNCLS),
        trailing_60_vix_available: Boolean(readiness.trailing_60_vix_available),
        primary_percentile: primaryPercentile,
        raw_label: rawLabel,
      },
    },
    {
      record_type: 'GLOBAL_REGIME_LABEL_READ_ONLY_ANCHOR',
      ticket: TICKET,
      payload: {
        path: GLOBAL_REGIME_LABELS,
        sha256: await sha256File(GLOBAL_REGIME_LABELS),
        label_count: labels.length,
        first_label_session_id: String(labels[0]?.session_id ?? ''),
        last_label_session_id: String(lastExisting.session_id ?? ''),
        target_session_present: currentTarget !== null,
        global_regime_labels_mutated: false,
      },
    },
    {
      record_type: 'SCOPED_REGIME_LABEL_SOURCE',
      ticket: TICKET,
      payload: scopedLabel,
    },
    {
      record_type: 'HYSTERESIS_DECISION',
      ticket: TICKET,
      payload: {
        previous_confirmed_label: previousConfirmedLabel,
        raw_label: rawLabel,
        primary_percentile: primaryPercentile,
        confirmed_label: hysteresis.confirmedLabel,
        transition_pending: hysteresis.transitionPending,
        rationale: hysteresis.rationale,
      },
    },
    {
      record_type: 'AUTHORITY_AND_OBSERVATION_GUARDRAILS',
      ticket: TICKET,
      payload: {
        StrategyFeatureSnapshot: 0,
        STRAT_EVAL: 0,
        CANDIDATE: 0,
        ORDER_INTENT: 0,
        observation_day_eligible: false,
        observation_day_increment: 0,
        paper_runtime_invoked: false,
        broker_live_authorized: false,
        phase_6_authorized: false,
        active_roster_mutated: false,
        candidate_roster_mutated: false,
        qfa_410b_or_qfa_611_run: false,
        global_regime_labels_mutated: false,
      },
    },
    {
      record_type: 'DETERMINATION',
      ticket: TICKET,
      determination,
      payload: {
        recommended_next_ticket: recommendedNextTicket,
        feature_builder_ready: false,
        non_overclaim: 'scoped label source acquired; feature source recheck remains separate and no observation-day credit is created',
      },
    },
  ];
  const boundedText = stableJsonl(records);
  const boundedSha = sha256Text(boundedText);
  const report: JsonRecord = {
    schema_version: 1,
    ticket: TICKET,
    target_session_id: TARGET_SESSION_ID,
    determination,
    recommended_next_ticket: recommendedNextTicket,
    scoped_regime_label_source_lf_sha256: boundedSha,
    scoped_label: scopedLabel,
    pr304_anchor: asRecord(records[0].payload),
    global_regime_label_anchor: asRecord(records[1].payload),
    hysteresis_decision: asRecord(records[3].payload),
    authority_and_observation_guardrails: asRecord(records[4].payload),
    notes: [
      'This ticket materializes a scoped paper-observation regime-label source only.',
      'The global artifacts/regime/regime-labels.json artifact remains unchanged.',
      'Feature-source recheck remains separate; this ticket does not emit StrategyFeatureSnapshot or strategy runtime markers.',
    ],
  };
  const reportText = stableJson(report);
  const reportSha = sha256Text(reportText);
  const md = [
    `# ${TICKET}`,
    '',
    '## Determination',
    '',
    `\`${determination}\``,
    '',
    markdownTable([
      ['target_session_id', TARGET_SESSION_ID],
      ['confirmed_label', hysteresis.confirmedLabel],
      ['raw_label', rawLabel],
      ['primary_value', primaryValue],
      ['primary_percentile', primaryPercentile],
      ['primary_prior_close_date', TARGET_PRIOR_CLOSE_DATE],
      ['transition_pending', hysteresis.transitionPending],
      ['materialization_scope', String(scopedLabel.materialization_scope)],
      ['global_regime_labels_mutated', false],
      ['scoped_regime_label_source_lf_sha256', boundedSha],
      ['report_json_lf_sha256', reportSha],
      ['recommended_next_ticket', recommendedNextTicket],
    ]),
    '',
    '## Boundary',
    '',
    '- `artifacts/regime/regime-labels.json` was read only and not mutated.',
    '- The label is scoped to paper-observation source-readiness only.',
    '- No qfa-410b/qfa-611 run or global research/backtest regime authority is created.',
    '',
    '## Authority',
    '',
    '- No `StrategyFeatureSnapshot` was emitted.',
    '- No `STRAT_EVAL`, `CANDIDATE`, or `ORDER_INTENT` markers were emitted.',
    '- `observation_day_eligible=false` and `observation_day_increment=0` remain locked.',
    '- No paper runtime, broker/live dispatch, Phase 6 authority, or roster mutation occurred.',
    '',
  ].join('\n');
  const memo = [
    `# ${TICKET} memo`,
    '',
    '## Context',
    '',
    'PR #304 proved source inputs were ready for a scoped 2026-06-02-rth regime-label acquisition, but deliberately did not materialize a label.',
    '',
    '## Acquisition',
    '',
    'This ticket uses PR #304 source-input evidence and QFA-212/ADR-0013 semantics to acquire a scoped paper-observation regime-label source record.',
    '',
    '## Hysteresis decision',
    '',
    `The source-input raw label is \`${rawLabel}\` at primary percentile \`${primaryPercentile}\`. The previous confirmed-label anchor is \`${previousConfirmedLabel}\`, so the scoped confirmed label is \`${hysteresis.confirmedLabel}\` with \`transition_pending=${hysteresis.transitionPending}\`.`,
    '',
    '## Result',
    '',
    `Determination: \`${determination}\`.`,
    '',
    `Recommended next ticket: \`${recommendedNextTicket}\`.`,
    '',
    '## Authority caveat',
    '',
    'The scoped label source does not mutate `artifacts/regime/regime-labels.json`, does not authorize global regime/backtest research changes, does not run qfa-410b/qfa-611, does not create a StrategyFeatureSnapshot, and does not create observation-day, broker/live, Phase 6, or roster authority.',
    '',
  ].join('\n');

  await writeText(OUTPUT_JSONL, boundedText);
  await writeText(OUTPUT_JSON, reportText);
  await writeText(OUTPUT_MD, md);
  await writeText(MEMO_PATH, memo);
  await updateBacklog();
  console.log(JSON.stringify({
    determination,
    target_session_id: TARGET_SESSION_ID,
    confirmed_label: hysteresis.confirmedLabel,
    raw_label: rawLabel,
    primary_value: primaryValue,
    primary_percentile: primaryPercentile,
    transition_pending: hysteresis.transitionPending,
    materialization_scope: scopedLabel.materialization_scope,
    global_regime_labels_mutated: false,
    scoped_regime_label_source_lf_sha256: boundedSha,
    report_json_lf_sha256: reportSha,
    recommended_next_ticket: recommendedNextTicket,
  }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
