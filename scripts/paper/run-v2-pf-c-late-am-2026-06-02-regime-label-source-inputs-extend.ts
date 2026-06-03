import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | JsonRecord;
type JsonRecord = { [key: string]: JsonValue };

type FredRow = {
  readonly date: string;
  readonly VIXCLS: number | null;
  readonly VXNCLS: number | null;
};

const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-REGIME-LABEL-SOURCE-INPUTS-EXTEND-01';
const TARGET_SESSION_ID = '2026-06-02-rth';
const TARGET_PRIOR_CLOSE_DATE = '2026-06-01';
const PR303_REPORT = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-source-readiness-01/source-readiness-report.json';
const REGIME_LABELS_PATH = 'artifacts/regime/regime-labels.json';
const PINNED_VIX_VXN_PATH = 'config/research/vix-vxn-daily-2025-09-to-2026-04.json';
const OUTPUT_DIR = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-regime-label-source-inputs-extend-01';
const OUTPUT_JSONL = `${OUTPUT_DIR}/bounded-regime-label-source-inputs.jsonl`;
const OUTPUT_JSON = `${OUTPUT_DIR}/regime-label-source-inputs-report.json`;
const OUTPUT_MD = `${OUTPUT_DIR}/regime-label-source-inputs-report.md`;
const MEMO_PATH = 'docs/research/v2-pf-c-late-am-paper-observation-2026-06-02-regime-label-source-inputs-extend-01-memo.md';
const BACKLOG_PATH = 'docs/plan/new_app_v1_ticket_backlog_v6.csv';
const FRED_SOURCE_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=VIXCLS,VXNCLS&cosd=2026-05-01&coed=2026-06-01';
const BACKLOG_ROW = `${TICKET},P1,1.0,V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-SOURCE-READINESS-01,Extend scoped 2026-06-02-rth regime-label source inputs using FRED VIX/VXN prior-close continuity without mutating global regime labels or creating feature snapshots strategy markers observation-day credit or authority,new_cycle4_v2_research_substrate`;

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

function stableJsonl(records: readonly JsonRecord[]): string {
  return `${records.map((record) => stableStringify(record)).join('\n')}\n`;
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function sha256File(path: string): Promise<string> {
  return sha256Text(await readFile(path, 'utf8'));
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

function parseFredCsv(csv: string): FredRow[] {
  const lines = csv.trim().split(/\r?\n/u);
  const header = lines[0]?.split(',') ?? [];
  const dateIndex = header.indexOf('observation_date');
  const vixIndex = header.indexOf('VIXCLS');
  const vxnIndex = header.indexOf('VXNCLS');
  if (dateIndex < 0 || vixIndex < 0 || vxnIndex < 0) {
    throw new Error('FRED CSV did not include observation_date,VIXCLS,VXNCLS columns');
  }
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return {
      date: cells[dateIndex] ?? '',
      VIXCLS: parseFredNumber(cells[vixIndex]),
      VXNCLS: parseFredNumber(cells[vxnIndex]),
    };
  }).filter((row) => row.date.length > 0);
}

function parseFredNumber(value: string | undefined): number | null {
  if (value === undefined || value.length === 0 || value === '.') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toFredRowsFromPinned(source: JsonRecord): FredRow[] {
  const series = asRecord(source.series);
  const vixRows = asArray(series.VIXCLS).map((entry) => asRecord(entry));
  const vxnRowsByDate = new Map<string, number | null>();
  for (const entry of asArray(series.VXNCLS).map((row) => asRecord(row))) {
    if (typeof entry.date === 'string') {
      vxnRowsByDate.set(entry.date, numberOrNull(entry.value));
    }
  }
  return vixRows.map((entry) => ({
    date: typeof entry.date === 'string' ? entry.date : '',
    VIXCLS: numberOrNull(entry.value),
    VXNCLS: typeof entry.date === 'string' ? vxnRowsByDate.get(entry.date) ?? null : null,
  })).filter((row) => row.date.length > 0);
}

function mergeRows(rows: readonly FredRow[]): FredRow[] {
  const byDate = new Map<string, FredRow>();
  for (const row of rows) {
    const existing = byDate.get(row.date);
    byDate.set(row.date, {
      date: row.date,
      VIXCLS: row.VIXCLS ?? existing?.VIXCLS ?? null,
      VXNCLS: row.VXNCLS ?? existing?.VXNCLS ?? null,
    });
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function percentileRank(value: number, values: readonly number[]): number {
  const lessOrEqual = values.filter((entry) => entry <= value).length;
  return round6(lessOrEqual / values.length);
}

function rawLabel(percentile: number | null): string | null {
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

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function readJson(path: string): Promise<JsonRecord> {
  return JSON.parse(await readFile(path, 'utf8')) as JsonRecord;
}

async function fetchFredRows(): Promise<{ readonly csv: string; readonly http_status: number; readonly rows: FredRow[] }> {
  const response = await fetch(FRED_SOURCE_URL);
  const csv = await response.text();
  if (!response.ok) {
    throw new Error(`FRED request failed with HTTP ${response.status}`);
  }
  return { csv, http_status: response.status, rows: parseFredCsv(csv) };
}

function markdownTable(rows: readonly (readonly [string, JsonValue])[]): string {
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
  const pr303 = await readJson(PR303_REPORT);
  const regimeLabels = await readJson(REGIME_LABELS_PATH);
  const pinnedVixVxn = await readJson(PINNED_VIX_VXN_PATH);
  const fred = await fetchFredRows();

  const pinnedRows = toFredRowsFromPinned(pinnedVixVxn);
  const combinedRows = mergeRows([...pinnedRows, ...fred.rows]);
  const targetRow = combinedRows.find((row) => row.date === TARGET_PRIOR_CLOSE_DATE) ?? null;
  const vixRowsThroughTarget = combinedRows.filter((row) => row.date <= TARGET_PRIOR_CLOSE_DATE && row.VIXCLS !== null);
  const vxnRowsThroughTarget = combinedRows.filter((row) => row.date <= TARGET_PRIOR_CLOSE_DATE && row.VXNCLS !== null);
  const trailing60 = vixRowsThroughTarget.slice(-60).map((row) => row.VIXCLS).filter((value): value is number => value !== null);
  const targetPrimaryValue = targetRow?.VIXCLS ?? null;
  const primaryPercentile = targetPrimaryValue === null || trailing60.length < 60
    ? null
    : percentileRank(targetPrimaryValue, trailing60);
  const targetRawLabel = rawLabel(primaryPercentile);
  const labels = asArray(regimeLabels.labels).map((entry) => asRecord(entry));
  const currentTargetLabel = labels.find((entry) => entry.session_id === TARGET_SESSION_ID) ?? null;
  const lastExistingLabel = labels[labels.length - 1] ?? null;
  const pr303Regime = asRecord(pr303.regime_label_source_status);
  const pr303Vix = asRecord(pr303.vix_vxn_prior_close_source_status);
  const pr303SignedShock = asRecord(asRecord(pr303.signed_shock_vwap_source_readiness).payload);
  const sourceInputsReady = targetPrimaryValue !== null
    && targetRow?.VXNCLS !== null
    && trailing60.length === 60
    && currentTargetLabel === null;
  const determination = sourceInputsReady
    ? 'REGIME_LABEL_SOURCE_INPUTS_READY_LABEL_NOT_MATERIALIZED'
    : 'REGIME_LABEL_SOURCE_INPUTS_REMAIN_BLOCKED';
  const recommendedNextTicket = sourceInputsReady
    ? 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-REGIME-LABEL-SOURCE-ACQUIRE-01'
    : TICKET;

  const records: JsonRecord[] = [
    {
      record_type: 'PR303_SOURCE_READINESS_ANCHOR',
      ticket: TICKET,
      payload: {
        determination: String(pr303.determination),
        source_report_path: PR303_REPORT,
        source_report_lf_sha256: await sha256File(PR303_REPORT),
        session_vwap: numberOrNull(asRecord(asRecord(pr303.session_vwap_source_readiness).payload).session_vwap),
        atr14_pts: numberOrNull(pr303SignedShock.atr14_pts),
        signed_shock_vwap_source_readiness_value: numberOrNull(pr303SignedShock.signed_shock_vwap_source_readiness_value),
        vix_vxn_prior_close_ready: Boolean(pr303Vix.ready),
        regime_label_ready: Boolean(pr303Regime.ready),
      },
    },
    {
      record_type: 'CURRENT_REGIME_LABEL_ARTIFACT_STATUS',
      ticket: TICKET,
      payload: {
        path: REGIME_LABELS_PATH,
        sha256: await sha256File(REGIME_LABELS_PATH),
        label_count: labels.length,
        first_label_session_id: String(labels[0]?.session_id ?? ''),
        last_label_session_id: String(lastExistingLabel.session_id ?? ''),
        target_session_id: TARGET_SESSION_ID,
        target_session_present: currentTargetLabel !== null,
        mutation_performed: false,
      },
    },
    {
      record_type: 'FRED_VIX_VXN_SOURCE_INPUT_EXTENSION',
      ticket: TICKET,
      payload: {
        source_url: FRED_SOURCE_URL,
        http_status: fred.http_status,
        fred_response_lf_sha256: sha256Text(fred.csv.replace(/\r\n/g, '\n')),
        start_date: fred.rows[0]?.date ?? null,
        end_date: fred.rows[fred.rows.length - 1]?.date ?? null,
        rows_returned: fred.rows.length,
        rows_with_vix: fred.rows.filter((row) => row.VIXCLS !== null).length,
        rows_with_vxn: fred.rows.filter((row) => row.VXNCLS !== null).length,
        target_prior_close_date: TARGET_PRIOR_CLOSE_DATE,
        target_prior_close_values: targetRow === null ? null : {
          VIXCLS: targetRow.VIXCLS,
          VXNCLS: targetRow.VXNCLS,
        },
        parsed_rows: fred.rows.map((row) => ({
          date: row.date,
          VIXCLS: row.VIXCLS,
          VXNCLS: row.VXNCLS,
        })),
      },
    },
    {
      record_type: 'QFA212_SOURCE_INPUT_READINESS',
      ticket: TICKET,
      payload: {
        target_session_id: TARGET_SESSION_ID,
        methodology_provenance: {
          primary: 'ADR-0013 LD-212-1 / qfa-212 memo: VIX close on previous trading day',
          percentile: 'ADR-0013 LD-212-2 / qfa-212 memo: rolling 60-session percentile rank',
          hysteresis: 'two-session confirmation; this ticket does not materialize confirmed labels',
          vxn: 'diagnostic only, not authoritative label substrate',
        },
        combined_vix_rows_through_target: vixRowsThroughTarget.length,
        combined_vxn_rows_through_target: vxnRowsThroughTarget.length,
        trailing_60_vix_available: trailing60.length === 60,
        primary_value: targetPrimaryValue,
        primary_percentile_diagnostic_only: primaryPercentile,
        raw_label_diagnostic_only: targetRawLabel,
        existing_last_confirmed_label_anchor: {
          session_id: String(lastExistingLabel.session_id ?? ''),
          confirmed_label: String(lastExistingLabel.confirmed_label ?? ''),
          primary_prior_close_date: String(lastExistingLabel.primary_prior_close_date ?? ''),
        },
        label_materialized: false,
        source_inputs_ready_for_scoped_label_acquire: sourceInputsReady,
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
        blocker_if_any: sourceInputsReady ? null : 'missing target VIX/VXN prior close or rolling 60-session VIX continuity',
        feature_builder_ready: false,
        non_overclaim: 'source inputs only; label acquisition and feature-source recheck remain separate tickets',
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
    bounded_source_inputs_lf_sha256: boundedSha,
    source_inputs_ready_for_scoped_label_acquire: sourceInputsReady,
    current_global_regime_label_present: currentTargetLabel !== null,
    current_global_regime_labels_mutated: false,
    vix_vxn_source_extension: asRecord(records[2].payload),
    qfa212_source_input_readiness: asRecord(records[3].payload),
    pr303_anchor: asRecord(records[0].payload),
    authority_and_observation_guardrails: asRecord(records[4].payload),
    notes: [
      'This ticket extends source inputs only; it does not write artifacts/regime/regime-labels.json.',
      'The diagnostic raw label/percentile fields are input-readiness checks, not an authorized regime-label artifact.',
      'Feature-builder implementation remains blocked until a scoped regime-label source is acquired and a source-readiness recheck passes.',
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
      ['source_inputs_ready_for_scoped_label_acquire', sourceInputsReady],
      ['current_global_regime_label_present', currentTargetLabel !== null],
      ['global_regime_labels_mutated', false],
      ['target_prior_close_date', TARGET_PRIOR_CLOSE_DATE],
      ['target VIXCLS', targetRow?.VIXCLS ?? null],
      ['target VXNCLS', targetRow?.VXNCLS ?? null],
      ['trailing_60_vix_available', trailing60.length === 60],
      ['primary_percentile_diagnostic_only', primaryPercentile],
      ['raw_label_diagnostic_only', targetRawLabel],
      ['bounded_source_inputs_lf_sha256', boundedSha],
      ['report_json_lf_sha256', reportSha],
      ['recommended_next_ticket', recommendedNextTicket],
    ]),
    '',
    '## Authority',
    '',
    '- No `StrategyFeatureSnapshot` was emitted.',
    '- No `STRAT_EVAL`, `CANDIDATE`, or `ORDER_INTENT` markers were emitted.',
    '- `observation_day_eligible=false` and `observation_day_increment=0` remain locked.',
    '- No qfa-410b/qfa-611 run, broker/live dispatch, Phase 6 authority, or roster mutation occurred.',
    '- `artifacts/regime/regime-labels.json` was read only and not mutated.',
    '',
  ].join('\n');
  const memo = [
    `# ${TICKET} memo`,
    '',
    '## Context',
    '',
    'PR #303 proved 2026-06-02 source readiness for session VWAP, ATR14, signed-shock VWAP source value, and one-day VIX/VXN prior close, but it remained blocked on a missing 2026-06-02-rth regime label in the current global regime-label artifact.',
    '',
    '## Source input extension',
    '',
    `This ticket fetches the scoped FRED VIX/VXN continuation window from ${FRED_SOURCE_URL} and combines it with the existing pinned VIX/VXN source only for source-input readiness diagnostics. The current global regime-label artifact remains unchanged.`,
    '',
    '## QFA-212 provenance',
    '',
    '- ADR-0013 / QFA-212 primary substrate: VIX close on the previous trading day.',
    '- ADR-0013 / QFA-212 percentile basis: rolling 60-session percentile rank.',
    '- VXN is diagnostic only, not the authoritative label substrate.',
    '- Two-session hysteresis is not applied here as an authority action; label acquisition remains a separate ticket.',
    '',
    '## Result',
    '',
    `Determination: \`${determination}\`.`,
    '',
    `The source inputs are ${sourceInputsReady ? 'ready' : 'not ready'} for a scoped 2026-06-02-rth regime-label acquisition ticket. This is not feature-builder readiness and not observation-day credit.`,
    '',
    '## Next',
    '',
    `Recommended next ticket: \`${recommendedNextTicket}\`.`,
    '',
    '## Authority caveat',
    '',
    'No StrategyFeatureSnapshot, strategy marker, paper runtime, qfa-410b/qfa-611, broker/live dispatch, Phase 6 authority, active/candidate roster mutation, observation-day increment, or global regime-label mutation was created.',
    '',
  ].join('\n');

  await writeText(OUTPUT_JSONL, boundedText);
  await writeText(OUTPUT_JSON, reportText);
  await writeText(OUTPUT_MD, md);
  await writeText(MEMO_PATH, memo);
  await updateBacklog();
  console.log(JSON.stringify({
    determination,
    source_inputs_ready_for_scoped_label_acquire: sourceInputsReady,
    target_session_id: TARGET_SESSION_ID,
    target_prior_close_date: TARGET_PRIOR_CLOSE_DATE,
    target_vixcls: targetRow?.VIXCLS ?? null,
    target_vxncls: targetRow?.VXNCLS ?? null,
    fred_rows_returned: fred.rows.length,
    pinned_vix_rows: pinnedRows.filter((row) => row.VIXCLS !== null).length,
    combined_vix_rows_through_target: vixRowsThroughTarget.length,
    combined_vxn_rows_through_target: vxnRowsThroughTarget.length,
    trailing_60_length: trailing60.length,
    trailing_60_vix_available: trailing60.length === 60,
    primary_percentile_diagnostic_only: primaryPercentile,
    raw_label_diagnostic_only: targetRawLabel,
    bounded_source_inputs_lf_sha256: boundedSha,
    report_json_lf_sha256: reportSha,
    recommended_next_ticket: recommendedNextTicket,
  }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
