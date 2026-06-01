import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type InputRecord = {
  readonly record_type: string;
  readonly source_event_id?: string;
  readonly source_line_number?: number;
  readonly source_ts_ns: string;
  readonly derived_ts_ns: string;
  readonly payload?: Record<string, JsonValue>;
};

type OutputRecord = {
  readonly record_type: 'SESSION_JOIN_DIAGNOSTIC' | 'BAR_SIGMA_SOURCE_DIAGNOSTIC' | 'REGIME_JOIN_DIAGNOSTIC' | 'SIGNED_SHOCK_SOURCE_DIAGNOSTIC' | 'SOURCE_GAP';
  readonly source_event_ids: readonly string[];
  readonly source_line_numbers: readonly number[];
  readonly source_ts_ns_range: { readonly min: string | null; readonly max: string | null };
  readonly derived_ts_ns: string | null;
  readonly max_source_ts_ns_used: string | null;
  readonly causality_status: string;
  readonly lookahead_detected: false;
  readonly payload: Record<string, JsonValue>;
};

const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-SESSION-REGIME-SHOCK-SOURCE-EXTEND-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const INPUT_PATH = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-source-data-extend-01/bounded-source-events.jsonl';
const INPUT_SHA = '0ab171e087826aaffb14cfbf6d3e5a51bd81173ace17efe85528790452010788';
const OUTPUT_DIR = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-session-regime-shock-source-extend-01';
const OUTPUT_JSONL = `${OUTPUT_DIR}/bounded-session-regime-shock-source.jsonl`;
const OUTPUT_JSON = `${OUTPUT_DIR}/session-regime-shock-source-report.json`;
const OUTPUT_MD = `${OUTPUT_DIR}/session-regime-shock-source-report.md`;
const MEMO_PATH = 'docs/research/v2-pf-c-late-am-paper-observation-session-regime-shock-source-extend-01-memo.md';
const REGIME_PATH = 'artifacts/regime/regime-labels.json';
const FEATURE_BUILDER_TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-FEATURE-BUILDER-IMPL-01';
const BAR_SIGMA_TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-BAR-SIGMA-SOURCE-EXTEND-01';
const SOURCE_TRADING_DATE = '2026-06-01';
const SESSION_TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-SESSION-STATE-SOURCE-EXTEND-01';
const REGIME_TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-REGIME-JOIN-SOURCE-EXTEND-01';
const SIGNED_SHOCK_TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-SIGNED-SHOCK-SOURCE-EXTEND-01';
const MINIMUM_BARS_REQUIRED = 30;

function parseArgs(): { maxEvents: number } {
  const args = process.argv.slice(2);
  let maxEvents = 120;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--max-events') {
      const raw = args[index + 1];
      if (raw === undefined) throw new Error('--max-events requires a value');
      maxEvents = Number.parseInt(raw, 10);
      index += 1;
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }
  if (!Number.isInteger(maxEvents) || maxEvents <= 0) {
    throw new Error('--max-events must be a positive integer');
  }
  return { maxEvents };
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortJsonValue(value[key]);
    return sorted;
  }
  return value;
}

function stableJson(value: JsonValue): string {
  return `${JSON.stringify(sortJsonValue(value))}\n`;
}

function stableJsonl(records: readonly OutputRecord[]): string {
  return records.map((record) => JSON.stringify(sortJsonValue(record as unknown as JsonValue))).join('\n') + '\n';
}

function assertCausal(record: OutputRecord): void {
  if (record.max_source_ts_ns_used !== null && record.derived_ts_ns !== null) {
    if (BigInt(record.max_source_ts_ns_used) > BigInt(record.derived_ts_ns)) {
      throw new Error(`lookahead detected for ${record.record_type}`);
    }
  }
}

function rangeFor(records: readonly InputRecord[]): { min: string | null; max: string | null } {
  if (records.length === 0) return { min: null, max: null };
  const sorted = [...records].sort((a, b) => bigintCompare(BigInt(a.source_ts_ns), BigInt(b.source_ts_ns)));
  return { min: sorted[0]!.source_ts_ns, max: sorted[sorted.length - 1]!.source_ts_ns };
}

function bigintCompare(a: bigint, b: bigint): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}function eventIds(records: readonly InputRecord[]): readonly string[] {
  return records.map((record, index) => record.source_event_id ?? `${record.record_type}-${index + 1}`);
}

function lineNumbers(records: readonly InputRecord[]): readonly number[] {
  return records
    .map((record) => record.source_line_number)
    .filter((value): value is number => typeof value === 'number' && Number.isInteger(value));
}

function maxTs(records: readonly InputRecord[]): string | null {
  if (records.length === 0) return null;
  return records.map((record) => BigInt(record.source_ts_ns)).sort(bigintCompare).at(-1)!.toString();
}

function makeGap(params: {
  blocker: string;
  missingReason: string;
  requiredSource: string;
  nextTicketHint: string;
  records: readonly InputRecord[];
}): OutputRecord {
  const max = maxTs(params.records);
  return {
    record_type: 'SOURCE_GAP',
    source_event_ids: [],
    source_line_numbers: [],
    source_ts_ns_range: rangeFor(params.records),
    derived_ts_ns: max,
    max_source_ts_ns_used: max,
    causality_status: 'blocked_missing_causal_source',
    lookahead_detected: false,
    payload: {
      blocker_family: params.blocker,
      missing_reason: params.missingReason,
      required_source: params.requiredSource,
      next_ticket_hint: params.nextTicketHint,
    },
  };
}

function buildBarSigmaDiagnostic(records: readonly InputRecord[]): OutputRecord {
  const tradeRecords = records.filter((record) => record.record_type === 'TRADE');
  const quoteRecords = records.filter((record) => record.record_type === 'QUOTE');
  const prices = tradeRecords
    .map((record) => record.payload?.price)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const quantities = tradeRecords
    .map((record) => record.payload?.quantity)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const max = maxTs([...tradeRecords, ...quoteRecords]) ?? maxTs(records);
  const ohlcv = prices.length > 0 ? {
    open: prices[0]!,
    high: Math.max(...prices),
    low: Math.min(...prices),
    close: prices[prices.length - 1]!,
    volume: quantities.reduce((total, value) => total + value, 0),
  } : null;
  const record: OutputRecord = {
    record_type: 'BAR_SIGMA_SOURCE_DIAGNOSTIC',
    source_event_ids: eventIds([...tradeRecords, ...quoteRecords]),
    source_line_numbers: lineNumbers([...tradeRecords, ...quoteRecords]),
    source_ts_ns_range: rangeFor([...tradeRecords, ...quoteRecords]),
    derived_ts_ns: max,
    max_source_ts_ns_used: max,
    causality_status: 'causal_partial_source_observed_sigma_blocked_by_minimum_history',
    lookahead_detected: false,
    payload: {
      trade_count: tradeRecords.length,
      quote_count: quoteRecords.length,
      trade_ohlcv_sample: ohlcv as JsonValue,
      bars_constructible_count: 0,
      minimum_bars_required: MINIMUM_BARS_REQUIRED,
      sigma_pts_status: 'blocked_minimum_history_not_satisfied',
      sigma_pts_missing_reason: 'bounded source sample proves trade/quote ingredients but not a causal bar sequence with minimum sigma lookback',
    },
  };
  assertCausal(record);
  return record;
}

function readInputRecords(text: string, maxEvents: number): readonly InputRecord[] {
  const records: InputRecord[] = [];
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  for (const line of lines.slice(0, maxEvents)) {
    const parsed = JSON.parse(line) as InputRecord;
    if (!/^\d+$/.test(parsed.source_ts_ns) || !/^\d+$/.test(parsed.derived_ts_ns)) {
      throw new Error('input bounded source record is missing numeric timestamp strings');
    }
    records.push(parsed);
  }
  return records;
}

function dateKeyFromNs(ns: string | null): string | null {
  if (ns === null) return null;
  const ms = Number(BigInt(ns) / 1_000_000n);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

async function regimeArtifactSummary(dateKey: string | null): Promise<Record<string, JsonValue>> {
  try {
    const text = await readFile(REGIME_PATH, 'utf8');
    const parsed = JSON.parse(text) as Record<string, JsonValue>;
    const hasDate = dateKey === null ? false : text.includes(dateKey);
    return {
      regime_source_path: REGIME_PATH,
      regime_source_sha256: sha256Text(text),
      label_scope: typeof parsed.label_scope === 'string' ? parsed.label_scope : null,
      queried_date: dateKey,
      queried_date_present: hasDate,
    };
  } catch (error) {
    return {
      regime_source_path: REGIME_PATH,
      regime_source_sha256: null,
      label_scope: null,
      queried_date: dateKey,
      queried_date_present: false,
      read_error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildRecords(inputRecords: readonly InputRecord[]): readonly OutputRecord[] {
  const output: OutputRecord[] = [
    buildBarSigmaDiagnostic(inputRecords),
    makeGap({
      blocker: 'session_state',
      missingReason: 'PR #298 bounded source has event timestamps but no explicit session calendar/state source for is_rth, is_halt, or is_roll_block; timestamp-window inference is not builder-ready',
      requiredSource: 'explicit runtime session classification or calendar/session source joined causally to source_ts_ns',
      nextTicketHint: SESSION_TICKET,
      records: inputRecords,
    }),
    makeGap({
      blocker: 'bar_sigma',
      missingReason: 'bounded source has trade/quote ingredients but not enough causal bar history to compute sigma_pts',
      requiredSource: 'causal bar builder with at least the configured sigma lookback before candidate evaluation',
      nextTicketHint: BAR_SIGMA_TICKET,
      records: inputRecords,
    }),
    makeGap({
      blocker: 'regime_label',
      missingReason: 'regime labels are not proven causally joined for the bounded live-capture timestamps',
      requiredSource: 'causal regime-label join keyed by session/source timestamp with primary_percentile and vxn_percentile',
      nextTicketHint: REGIME_TICKET,
      records: inputRecords,
    }),
    makeGap({
      blocker: 'signed_shock_vwap',
      missingReason: 'signed_shock_vwap requires causal VWAP/sigma basis and recent-history construction; bounded source proves ingredients only',
      requiredSource: 'causal signed-shock builder over sufficient trade/quote/bar history',
      nextTicketHint: SIGNED_SHOCK_TICKET,
      records: inputRecords,
    }),
  ];
  for (const record of output) assertCausal(record);
  return output;
}
function countOutputRecords(records: readonly OutputRecord[]): Record<string, number> {
  const counts: Record<string, number> = {
    BAR_SIGMA_SOURCE_DIAGNOSTIC: 0,
    REGIME_JOIN_DIAGNOSTIC: 0,
    SESSION_JOIN_DIAGNOSTIC: 0,
    SIGNED_SHOCK_SOURCE_DIAGNOSTIC: 0,
    SOURCE_GAP: 0,
  };
  for (const record of records) counts[record.record_type] = (counts[record.record_type] ?? 0) + 1;
  return counts;
}

function inputCounts(records: readonly InputRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) counts[record.record_type] = (counts[record.record_type] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function buildReport(params: {
  inputRecords: readonly InputRecord[];
  outputRecords: readonly OutputRecord[];
  inputText: string;
  outputText: string;
  regimeSummary: Record<string, JsonValue>;
}): JsonValue {
  const inputRange = rangeFor(params.inputRecords);
  const dateKey = dateKeyFromNs(inputRange.max);
  const outputCounts = countOutputRecords(params.outputRecords);
  const classification = 'SESSION_REGIME_SHOCK_SOURCE_PARTIAL_REMAINS_BLOCKED';
  return {
    schema_version: 1,
    ticket: TICKET,
    classification,
    strategy_id: STRATEGY_ID,
    observation_day_eligible: false,
    observation_day_increment: 0,
    input_bounded_source_path: INPUT_PATH,
    input_bounded_source_lf_sha256: sha256Text(params.inputText),
    expected_input_bounded_source_lf_sha256: INPUT_SHA,
    bounded_join_source_lf_sha256: sha256Text(params.outputText),
    bounded_join_record_count: params.outputRecords.length,
    bounded_join_record_counts_by_type: outputCounts,
    input_bounded_record_count: params.inputRecords.length,
    input_bounded_record_counts_by_type: inputCounts(params.inputRecords),
    input_source_ts_ns_range: inputRange,
    input_utc_date: dateKey,
    session_state_readiness: {
      session_join_status: 'blocked_missing_explicit_session_state_source',
      session_join_source: null,
      session_join_causality: 'not_established',
      session_join_missing_reason: 'bounded source timestamps alone do not prove is_rth, is_halt, or is_roll_block; timestamp-window inference is diagnostic-only and not builder-ready',
      next_ticket_hint: SESSION_TICKET,
    },
    bar_sigma_readiness: {
      bar_source_status: 'partial_trade_quote_source_available',
      bars_constructible_count: 0,
      minimum_bars_required: MINIMUM_BARS_REQUIRED,
      sigma_pts_status: 'blocked_minimum_history_not_satisfied',
      sigma_pts_missing_reason: 'bounded source contains 7 TRADE and 33 QUOTE records but no causal bar sequence with sufficient sigma lookback',
      next_ticket_hint: BAR_SIGMA_TICKET,
    },
    regime_readiness: {
      regime_join_status: 'blocked_missing_causal_join_for_live_capture_date',
      regime_label: null,
      primary_percentile: null,
      vxn_percentile: null,
      regime_source_path: REGIME_PATH,
      regime_causality_status: 'not_established',
      regime_artifact: params.regimeSummary as JsonValue,
      next_ticket_hint: REGIME_TICKET,
    },
    signed_shock_readiness: {
      signed_shock_status: 'blocked_missing_causal_vwap_sigma_history',
      vwap_source_status: 'partial_trade_quote_source_available',
      sigma_basis_status: 'blocked_by_bar_sigma_readiness',
      minimum_history_status: 'blocked_insufficient_history',
      signed_shock_missing_reason: 'signed_shock_vwap.value cannot be computed without causal bar/sigma and recent-history inputs',
      next_ticket_hint: SIGNED_SHOCK_TICKET,
    },
    no_lookahead_contract: {
      every_non_gap_record_has_max_source_ts_ns_used_lte_derived_ts_ns: true,
      every_record_lookahead_detected_false: true,
      uncertain_cases_classified_blocked: true,
    },
    feature_builder_readiness: 'PARTIAL_SOURCE_JOINS_AVAILABLE',
    recommended_next_ticket: BAR_SIGMA_TICKET,
    recommended_next_ticket_reason: 'Bar/sigma is the first dependency because signed_shock_vwap depends on causal VWAP/sigma history; session-state and regime joins remain parallel required blockers and must be addressed before FEATURE-BUILDER-IMPL.',
    dependency_ordering: ['bar_sigma_source_extend', 'signed_shock_source_extend', 'session_state_source_extend', 'regime_join_source_extend', 'feature_builder_impl'],
    date_basis_note: 'The bounded source file path is trading-date ' + SOURCE_TRADING_DATE + ', while bounded event timestamps convert to UTC date ' + dateKey + '. The regime join check used event UTC date, not filename trading date. This mismatch is why regime availability is not assumed.',
    deterministic_generation: {
      ab_byte_stable_bounded_join_source_jsonl: true,
      ab_byte_stable_report_json: true,
      ab_byte_stable_report_md: true,
    },
    source_gaps: params.outputRecords.filter((record) => record.record_type === 'SOURCE_GAP') as unknown as JsonValue,
    strategy_runtime_markers: {
      STRAT_EVAL: 0,
      CANDIDATE: 0,
      ORDER_INTENT: 0,
    },
    authority: {
      broker_live_authorized: false,
      phase_6_authorized: false,
      active_roster_mutated: false,
      candidate_roster_mutated: false,
      paper_observation_day_created: false,
    },
  };
}

function markdownTable(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '';
  const divider = rows[0]!.map(() => '---');
  return [rows[0]!, divider, ...rows.slice(1)].map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function buildMarkdown(report: JsonValue): string {
  const r = report as Record<string, any>;
  const countRows = [['Record type', 'Count']];
  for (const [recordType, count] of Object.entries(r.bounded_join_record_counts_by_type as Record<string, number>)) {
    countRows.push([recordType, String(count)]);
  }
  const readinessRows = [
    ['Area', 'Status', 'Next'],
    ['Session state', r.session_state_readiness.session_join_status, r.session_state_readiness.next_ticket_hint],
    ['Bar/sigma', r.bar_sigma_readiness.sigma_pts_status, r.bar_sigma_readiness.next_ticket_hint],
    ['Regime label', r.regime_readiness.regime_join_status, r.regime_readiness.next_ticket_hint],
    ['Signed shock', r.signed_shock_readiness.signed_shock_status, r.signed_shock_readiness.next_ticket_hint],
  ];
  return `# ${TICKET} — Session/Regime/Shock Source Report\n\n` +
    `## Determination\n\n` +
    `Classification: \`${r.classification}\`\n\n` +
    `Feature-builder readiness: \`${r.feature_builder_readiness}\`\n\n` +
    `Observation-day eligible: \`${r.observation_day_eligible}\`\n\n` +
    `Observation-day increment: \`${r.observation_day_increment}\`\n\n` +
    `Input bounded source LF SHA-256: \`${r.input_bounded_source_lf_sha256}\`\n\n` +
    `Output bounded join LF SHA-256: \`${r.bounded_join_source_lf_sha256}\`\n\n` +
    `## Output record counts\n\n${markdownTable(countRows)}\n\n` +
    `## Readiness summary\n\n${markdownTable(readinessRows)}\n\n` +
    `## No-lookahead contract\n\nEvery non-gap record includes \`max_source_ts_ns_used <= derived_ts_ns\` and \`lookahead_detected = false\`. Uncertain joins are represented as \`SOURCE_GAP\` records rather than fabricated values.\n\n` +
    `## Recommended next ticket\n\n\`${r.recommended_next_ticket}\`\n\n` +
    `## Authority caveat\n\nThis report is source/join evidence only. It does not emit \`StrategyFeatureSnapshot\`, run paper strategy runtime, produce strategy markers, count observation days, or grant broker/live/Phase 6/roster authority.\n`;
}
function buildMemo(report: JsonValue): string {
  const r = report as Record<string, any>;
  const countRows = [['Record type', 'Count']];
  for (const [recordType, count] of Object.entries(r.bounded_join_record_counts_by_type as Record<string, number>)) {
    countRows.push([recordType, String(count)]);
  }
  return `# ${TICKET} Memo\n\n` +
    `## 1. Context and PR #298 dependency\n\n` +
    `PR #298 proved bounded quote/trade/depth source data for \`${STRATEGY_ID}\`. This ticket uses that bounded payload as the only authoritative input for session/regime/shock source-join diagnostics.\n\n` +
    `## 2. Input bounded source provenance\n\n` +
    `Input path: \`${r.input_bounded_source_path}\`. Input LF SHA-256: \`${r.input_bounded_source_lf_sha256}\`. Expected anchor: \`${r.expected_input_bounded_source_lf_sha256}\`.\n\n` +
    `## 3. Session-state join assessment\n\n` +
    `Status: \`${r.session_state_readiness.session_join_status}\`. Missing reason: ${r.session_state_readiness.session_join_missing_reason}.\n\n` +
    `## 5. Bar/sigma source assessment\n\n` +
    `Status: \`${r.bar_sigma_readiness.sigma_pts_status}\`. Bounded trade/quote source exists, but \`${r.bar_sigma_readiness.bars_constructible_count}\` builder-ready bars are established versus \`${r.bar_sigma_readiness.minimum_bars_required}\` required for the sigma lookback.\n\n` +
    `## 6. Regime-label join assessment\n\n` +
    `Status: \`${r.regime_readiness.regime_join_status}\`. Regime source path: \`${r.regime_readiness.regime_source_path}\`. The bounded input date is \`${r.input_utc_date}\`, and causal regime availability is not established for that live-capture date.\n\n` +
    `## 7. Signed-shock source assessment\n\n` +
    `Status: \`${r.signed_shock_readiness.signed_shock_status}\`. VWAP ingredients are partially available through bounded trade/quote source records, but sigma basis and recent-history requirements remain blocked.\n\n` +
    `## 8. No-lookahead contract\n\n` +
    `Every non-gap record is checked for \`max_source_ts_ns_used <= derived_ts_ns\` and carries \`lookahead_detected = false\`. Uncertain joins are blocked with \`SOURCE_GAP\` records.\n\n` +
    `## 9. Remaining blockers\n\n` +
    `Output record counts:\n\n${markdownTable(countRows)}\n\n` +
    `The remaining blockers are session-state source, causal bar/sigma construction, regime-label join, and signed-shock VWAP/recent-history construction.\n\n` +
    `## 10. Recommended next ticket\n\n` +
    `\`${r.recommended_next_ticket}\` — ${r.recommended_next_ticket_reason}.\n\n` +
    `## 11. Verification\n\n` +
    `Generated from the PR #298 bounded payload with deterministic A/B byte-stability checks for JSONL, JSON report, and Markdown report.\n\n` +
    `## 12. Authority caveat\n\n` +
    `Observation-day eligible: \`${r.observation_day_eligible}\`. Observation-day increment: \`${r.observation_day_increment}\`. This ticket creates no broker/live dispatch, Phase 6 authority, active roster mutation, candidate roster mutation, or paper-observation day credit.\n`;
}

async function buildEvidence(maxEvents: number) {
  const inputText = await readFile(INPUT_PATH, 'utf8');
  const inputHash = sha256Text(inputText);
  if (inputHash !== INPUT_SHA) {
    throw new Error(`PR #298 bounded source hash mismatch: expected ${INPUT_SHA}, got ${inputHash}`);
  }
  const inputRecords = readInputRecords(inputText, maxEvents);
  const outputRecordsA = buildRecords(inputRecords);
  const outputRecordsB = buildRecords(inputRecords);
  const outputTextA = stableJsonl(outputRecordsA);
  const outputTextB = stableJsonl(outputRecordsB);
  if (outputTextA !== outputTextB) throw new Error('bounded join source JSONL is not byte-stable');
  const regimeSummary = await regimeArtifactSummary(dateKeyFromNs(rangeFor(inputRecords).max));
  const reportA = buildReport({ inputRecords, outputRecords: outputRecordsA, inputText, outputText: outputTextA, regimeSummary });
  const reportB = buildReport({ inputRecords, outputRecords: outputRecordsB, inputText, outputText: outputTextB, regimeSummary });
  const reportJsonA = stableJson(reportA);
  const reportJsonB = stableJson(reportB);
  if (reportJsonA !== reportJsonB) throw new Error('report JSON is not byte-stable');
  const markdownA = buildMarkdown(reportA);
  const markdownB = buildMarkdown(reportB);
  if (markdownA !== markdownB) throw new Error('report Markdown is not byte-stable');
  return {
    outputText: outputTextA,
    report: reportA,
    reportJson: reportJsonA,
    reportMd: markdownA,
    memo: buildMemo(reportA),
  };
}

async function main() {
  const { maxEvents } = parseArgs();
  const evidence = await buildEvidence(maxEvents);
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(path.dirname(MEMO_PATH), { recursive: true });
  await writeFile(OUTPUT_JSONL, evidence.outputText, 'utf8');
  await writeFile(OUTPUT_JSON, evidence.reportJson, 'utf8');
  await writeFile(OUTPUT_MD, evidence.reportMd, 'utf8');
  await writeFile(MEMO_PATH, evidence.memo, 'utf8');
  const report = evidence.report as Record<string, any>;
  console.log(JSON.stringify({
    ticket: TICKET,
    classification: report.classification,
    feature_builder_readiness: report.feature_builder_readiness,
    input_bounded_source_lf_sha256: report.input_bounded_source_lf_sha256,
    bounded_join_source_lf_sha256: report.bounded_join_source_lf_sha256,
    bounded_join_record_count: report.bounded_join_record_count,
    bounded_join_record_counts_by_type: report.bounded_join_record_counts_by_type,
    recommended_next_ticket: report.recommended_next_ticket,
    observation_day_eligible: report.observation_day_eligible,
    observation_day_increment: report.observation_day_increment,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});


