import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type SourceRecord = {
  readonly record_type: 'TRADE' | 'QUOTE';
  readonly source_usage: 'bar_payload' | 'closure_only';
  readonly source_event_id: string;
  readonly source_line_number: number;
  readonly source_path: string;
  readonly source_ts_ns: string;
  readonly payload: Record<string, JsonValue>;
};

type BuiltBar = {
  readonly bar_start_ts_ns: string;
  readonly bar_end_ts_ns: string;
  readonly first_record_ts_ns: string;
  readonly last_record_ts_ns: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly trade_count: number;
  readonly quote_count: number;
  readonly source_event_ids: readonly string[];
  readonly source_line_numbers: readonly number[];
};

const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-SIGNED-SHOCK-SOURCE-EXTEND-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const INPUT_SOURCE = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-bar-sigma-source-window-extend-01/bounded-bar-sigma-window-source.jsonl';
const INPUT_REPORT = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-bar-sigma-source-window-extend-01/bar-sigma-window-report.json';
const OUTPUT_DIR = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-signed-shock-source-extend-01';
const OUTPUT_SOURCE = `${OUTPUT_DIR}/bounded-signed-shock-source.jsonl`;
const OUTPUT_JSON = `${OUTPUT_DIR}/signed-shock-source-report.json`;
const OUTPUT_MD = `${OUTPUT_DIR}/signed-shock-source-report.md`;
const MEMO_PATH = 'docs/research/v2-pf-c-late-am-paper-observation-signed-shock-source-extend-01-memo.md';
const PR301_INPUT_SOURCE_SHA = '4844a8c6dcb17bd875e0c43969eb03742df5ea961ba92c88c8c6445b388ffff2';
const PR301_REPORT_JSON_SHA = 'd0715f3d2b1fce0e5a70d9f912efd04563a19f02040a2922a312f9d088b53281';
const PR301_BOUNDED_BAR_SIGMA_OUTPUT_SHA = '04f09204e4a05ffeb3e9067a1d5237ce018710e97de9bb909e6f599be48a796a';
const MAX_ARTIFACT_BYTES = 95 * 1024 * 1024;
const BAR_INTERVAL_NS = 60_000_000_000n;
const ATR_PERIOD = 14;
const RECENT_WINDOW = 60;
const NEXT_TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-SESSION-VWAP-SOURCE-EXTEND-01';

function parseArgs(): { maxEvents: number } {
  const args = process.argv.slice(2);
  let maxEvents = 250000;
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
  if (!Number.isInteger(maxEvents) || maxEvents <= 0) throw new Error('--max-events must be positive');
  return { maxEvents };
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeLf(value: string): string {
  return value.replace(/\r\n/gu, '\n');
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

function stableJsonl(records: readonly JsonValue[]): string {
  return `${records.map((record) => JSON.stringify(sortJsonValue(record))).join('\n')}\n`;
}

function numberOrNull(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nsFloorMinute(tsNs: string): string {
  const ts = BigInt(tsNs);
  return (ts - (ts % BAR_INTERVAL_NS)).toString();
}

function nsMinuteEnd(startNs: string): string {
  return (BigInt(startNs) + BAR_INTERVAL_NS).toString();
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function countBy<T extends string>(values: readonly T[]): Record<T, number> {
  const counts = {} as Record<T, number>;
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) as Record<T, number>;
}

function parseSource(text: string, maxEvents: number): readonly SourceRecord[] {
  const records: SourceRecord[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    if (records.length >= maxEvents) break;
    const parsed = JSON.parse(line) as SourceRecord;
    if (parsed.record_type !== 'TRADE' && parsed.record_type !== 'QUOTE') continue;
    records.push(parsed);
  }
  return records;
}

function buildClosedBars(records: readonly SourceRecord[]): readonly BuiltBar[] {
  const closedBars: BuiltBar[] = [];
  let activeStart: string | null = null;
  let activeEnd: string | null = null;
  let activeRecords: SourceRecord[] = [];

  const closeActive = (): void => {
    if (activeStart === null || activeEnd === null || activeRecords.length === 0) return;
    const trades = activeRecords.filter((record) => record.record_type === 'TRADE');
    const quotes = activeRecords.filter((record) => record.record_type === 'QUOTE');
    const prices = trades.map((record) => numberOrNull(record.payload.price)).filter((value): value is number => value !== null);
    const quantities = trades.map((record) => numberOrNull(record.payload.quantity)).filter((value): value is number => value !== null);
    if (prices.length === 0) return;
    closedBars.push({
      bar_start_ts_ns: activeStart,
      bar_end_ts_ns: activeEnd,
      first_record_ts_ns: activeRecords[0]!.source_ts_ns,
      last_record_ts_ns: activeRecords[activeRecords.length - 1]!.source_ts_ns,
      open: prices[0]!,
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: prices[prices.length - 1]!,
      volume: quantities.reduce((total, value) => total + value, 0),
      trade_count: trades.length,
      quote_count: quotes.length,
      source_event_ids: activeRecords.map((record) => record.source_event_id),
      source_line_numbers: activeRecords.map((record) => record.source_line_number),
    });
  };

  for (const record of records) {
    if (record.source_usage === 'closure_only') {
      if (activeEnd !== null && BigInt(record.source_ts_ns) >= BigInt(activeEnd)) closeActive();
      break;
    }
    const recordStart = nsFloorMinute(record.source_ts_ns);
    const recordEnd = nsMinuteEnd(recordStart);
    if (activeStart === null) {
      activeStart = recordStart;
      activeEnd = recordEnd;
    }
    while (activeEnd !== null && BigInt(record.source_ts_ns) >= BigInt(activeEnd)) {
      closeActive();
      activeRecords = [];
      activeStart = recordStart;
      activeEnd = recordEnd;
      break;
    }
    activeRecords.push(record);
  }

  return closedBars;
}

function trueRange(bar: BuiltBar, previous: BuiltBar | undefined): number {
  if (previous === undefined) return bar.high - bar.low;
  return Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close));
}

function computeAtr14(bars: readonly BuiltBar[]): number | null {
  if (bars.length <= ATR_PERIOD) return null;
  let atr = 0;
  for (let index = 0; index < bars.length; index += 1) {
    const range = trueRange(bars[index]!, bars[index - 1]);
    if (index === 0) {
      atr = range;
      continue;
    }
    if (index < ATR_PERIOD) {
      atr += range;
      if (index === ATR_PERIOD - 1) atr /= ATR_PERIOD;
      continue;
    }
    atr = ((atr * (ATR_PERIOD - 1)) + range) / ATR_PERIOD;
  }
  return round4(atr);
}

function diagnosticRecords(input: {
  readonly records: readonly SourceRecord[];
  readonly bars: readonly BuiltBar[];
  readonly atr14: number | null;
  readonly report: Record<string, JsonValue>;
}): readonly JsonValue[] {
  const first = input.records[0];
  const last = input.records[input.records.length - 1];
  const barsWithVolume = input.bars.filter((bar) => bar.volume > 0);
  return [
    {
      record_type: 'SIGNED_SHOCK_SOURCE_DIAGNOSTIC',
      derived_ts_ns: last?.source_ts_ns ?? null,
      source_ts_ns_range: { min: first?.source_ts_ns ?? null, max: last?.source_ts_ns ?? null },
      causality_status: 'blocked_missing_exact_session_vwap_anchor',
      lookahead_detected: false,
      payload: {
        signed_shock_formula: '(price - session_vwap) / atr_14',
        price_source: 'quote.mid_px in current repo feature snapshot path',
        anchor_type: 'vwap',
        anchor_value_ready: false,
        sigma_basis: 'atr_14',
        sigma_basis_value_ready: input.atr14 !== null,
        sigma_basis_value_if_ready: input.atr14,
        bars_available: input.bars.length,
        bars_with_volume: barsWithVolume.length,
        session_vwap_ready: false,
        session_vwap_missing_reason: 'exact current-repo session_vwap requires effective RTH/session context and causal prior in-session bar history, not just the bounded PR #301 window',
        signed_shock_values_constructed: 0,
      },
    },
    {
      record_type: 'RECENT_SIGNED_SHOCK_SOURCE_DIAGNOSTIC',
      derived_ts_ns: last?.source_ts_ns ?? null,
      source_ts_ns_range: { min: first?.source_ts_ns ?? null, max: last?.source_ts_ns ?? null },
      causality_status: 'blocked_missing_exact_session_vwap_anchor',
      lookahead_detected: false,
      payload: {
        recent_window_length: RECENT_WINDOW,
        recent_history_bars_available: input.bars.length,
        recent_history_bar_count_sufficient_for_repo_function: input.bars.length > 0,
        recent_history_ready: false,
        recent_history_missing_reason: 'computeSignedShockVwapRecentValues requires session_vwap and atr_14; atr_14 is ready but session_vwap is not proven',
        signed_shock_recent_values_constructed: 0,
      },
    },
    {
      record_type: 'DEPENDENCY_INVENTORY',
      derived_ts_ns: last?.source_ts_ns ?? null,
      source_ts_ns_range: { min: first?.source_ts_ns ?? null, max: last?.source_ts_ns ?? null },
      causality_status: 'source_inventory_only_no_feature_snapshot',
      lookahead_detected: false,
      payload: {
        dependencies: [
          { field: 'snapshot.context.signed_shock_vwap.value', class: 'behavior-bearing for current v2', status: 'blocked_missing_session_vwap' },
          { field: 'session_vwap', class: 'behavior-bearing signed-shock source', status: 'blocked_missing_source' },
          { field: 'atr_14_pts', class: 'behavior-bearing signed-shock denominator', status: input.atr14 === null ? 'blocked_insufficient_history' : 'ready_from_bounded_bars' },
          { field: 'quote.mid_px', class: 'behavior-bearing signed-shock price source', status: 'available_in_bounded_source' },
          { field: 'sigma_pts', class: 'behavior-bearing for v2 stop/risk but not signed-shock denominator', status: input.report.sigma_pts_ready === true ? 'ready_from_pr301' : 'blocked' },
          { field: 'regime_label', class: 'behavior-bearing for current v2 but diagnostic-only for this ticket', status: 'deferred_not_required_for_signed_shock_source' },
          { field: 'session_state', class: 'behavior-bearing for current v2 and needed for exact VWAP anchor', status: 'blocked_missing_source' },
        ],
      },
    },
  ];
}

function buildReport(input: {
  readonly inputSourceText: string;
  readonly reportText: string;
  readonly outputText: string;
  readonly outputRecords: readonly JsonValue[];
  readonly sourceRecords: readonly SourceRecord[];
  readonly bars: readonly BuiltBar[];
  readonly atr14: number | null;
  readonly maxEvents: number;
}): JsonValue {
  const sourceCounts = countBy(input.sourceRecords.map((record) => record.record_type));
  const usageCounts = countBy(input.sourceRecords.map((record) => record.source_usage));
  const quoteRecords = input.sourceRecords.filter((record) => record.record_type === 'QUOTE');
  const tradeRecords = input.sourceRecords.filter((record) => record.record_type === 'TRADE');
  const quotesWithMid = quoteRecords.filter((record) => numberOrNull(record.payload.mid_px) !== null).length;
  const canonicalReportText = normalizeLf(input.reportText);
  const reportJson = JSON.parse(canonicalReportText) as Record<string, JsonValue>;
  const inputReportSha = sha256Text(canonicalReportText);
  const inputSourceSha = sha256Text(input.inputSourceText);
  if (inputSourceSha !== PR301_INPUT_SOURCE_SHA) throw new Error(`PR #301 bounded source hash mismatch: ${inputSourceSha}`);
  if (inputReportSha !== PR301_REPORT_JSON_SHA) throw new Error(`PR #301 report JSON hash mismatch: ${inputReportSha}`);
  if (reportJson.bounded_bar_sigma_output_lf_sha256 !== PR301_BOUNDED_BAR_SIGMA_OUTPUT_SHA) {
    throw new Error(`PR #301 internal bar/sigma output hash mismatch: ${String(reportJson.bounded_bar_sigma_output_lf_sha256)}`);
  }

  return {
    schema_version: 1,
    ticket: TICKET,
    strategy_id: STRATEGY_ID,
    determination: 'SIGNED_SHOCK_SOURCE_BLOCKED_MISSING_SESSION_VWAP',
    classification: 'SIGNED_SHOCK_SOURCE_BLOCKED_MISSING_SESSION_VWAP',
    observation_day_eligible: false,
    observation_day_increment: 0,
    input_bounded_source_lf_sha256: inputSourceSha,
    input_bar_sigma_lf_sha256: PR301_BOUNDED_BAR_SIGMA_OUTPUT_SHA,
    bar_sigma_window_report_json_sha256: inputReportSha,
    bar_sigma_window_report_json_sha256_scope: 'LF-canonical',
    bounded_signed_shock_source_lf_sha256: sha256Text(input.outputText),
    bounded_signed_shock_event_count: input.outputRecords.length,
    bounded_signed_shock_artifact_size_bytes: Buffer.byteLength(input.outputText, 'utf8'),
    bounded_signed_shock_artifact_size_limit_bytes: MAX_ARTIFACT_BYTES,
    bounded_signed_shock_artifact_size_within_limit: Buffer.byteLength(input.outputText, 'utf8') < MAX_ARTIFACT_BYTES,
    source_selection_policy: 'use committed PR #301 bounded bar/sigma source only; no live capture read; parse up to --max-events in original deterministic source order; emit compact causal diagnostic records instead of duplicating the near-limit raw source window',
    max_events: input.maxEvents,
    source_event_counts_by_type: sourceCounts,
    source_usage_counts: usageCounts,
    quote_records_total: quoteRecords.length,
    quote_records_with_finite_mid_px: quotesWithMid,
    trade_records_total: tradeRecords.length,
    signed_shock_formula_or_source_semantics: '(price - anchor_value) / sigma_basis_value; for signed_shock_vwap the runner passes price=quote.mid_px, anchor_type=vwap, anchor_value=context.session_vwap, sigma_basis=atr_14, sigma_basis_value=atr14Pts',
    signed_shock_formula_source: 'apps/backtester/src/real-archive-execution/snapshot-features.ts:323-349; apps/backtester/src/real-archive-execution/real-archive-execution-runner.ts:1230-1241',
    sigma_pts_source: 'PR #301 proves sigma_pts readiness but current signed_shock_vwap uses atr_14, not sigma_pts, as sigma_basis',
    sigma_pts_value_used: null,
    sigma_pts_value_from_pr301_informational: reportJson.sigma_pts_value_if_ready ?? null,
    atr_or_sigma_history_ready: input.atr14 !== null,
    atr14_pts_value_if_ready: input.atr14,
    atr14_formula_source: 'apps/backtester/src/real-archive-execution/snapshot-features.ts:252-272',
    closed_bars_available: input.bars.length,
    session_vwap_ready: false,
    session_vwap_source_record_count: 0,
    session_vwap_candidate_records_available_but_not_used: tradeRecords.length,
    recent_history_ready: false,
    recent_history_source_bars_available: input.bars.length,
    recent_history_window_length: RECENT_WINDOW,
    signed_shock_values_constructed: 0,
    signed_shock_recent_values_constructed: 0,
    earliest_signed_shock_ts_ns: null,
    latest_signed_shock_ts_ns: null,
    causality_check: {
      no_live_capture_read: true,
      every_output_record_lookahead_detected_false: true,
      no_signed_shock_values_emitted_without_session_vwap: true,
      bounded_source_hash_matches_pr301: true,
      bar_sigma_internal_hash_matches_pr301: true,
    },
    lookahead_detected: false,
    missing_dependency_list: [
      'exact current-repo session_vwap anchor',
      'effective RTH/session context for deciding which bars contribute to session_vwap',
      'causal prior in-session bar history before the bounded PR #301 window if session_vwap did not start at the bounded window',
    ],
    dependency_inventory: [
      { field: 'signed_shock_vwap.value', class: 'behavior-bearing for current v2', status: 'blocked_missing_session_vwap' },
      { field: 'quote.mid_px', class: 'behavior-bearing signed-shock source', status: quotesWithMid > 0 ? 'available_in_bounded_source' : 'blocked_missing_source' },
      { field: 'atr_14_pts', class: 'behavior-bearing signed-shock denominator', status: input.atr14 === null ? 'blocked_insufficient_history' : 'ready_from_bounded_bars' },
      { field: 'sigma_pts', class: 'behavior-bearing v2 stop/risk, informational for signed-shock', status: reportJson.sigma_pts_ready === true ? 'ready_from_pr301' : 'blocked' },
      { field: 'session_vwap', class: 'behavior-bearing signed-shock anchor', status: 'blocked_missing_source' },
      { field: 'signed_shock_vwap_recent_values', class: 'diagnostic and serialized context', status: 'blocked_missing_session_vwap' },
      { field: 'regime_label', class: 'behavior-bearing current v2, not required to prove signed-shock formula', status: 'deferred_not_required_for_this_ticket' },
    ],
    recommended_next_ticket: NEXT_TICKET,
    recommended_next_ticket_reason: 'Pin causal session_vwap/effective-session source before signed_shock_vwap can be materialized faithfully; do not proceed to feature-builder implementation yet.',
    feature_builder_blockers_remaining: [
      'signed_shock source',
      'session_state source',
      'regime_join source',
      'feature snapshot assembly contract',
    ],
    strategy_runtime_markers: { STRAT_EVAL: 0, CANDIDATE: 0, ORDER_INTENT: 0 },
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
  return `# ${TICKET} - Signed-Shock Source Report\n\n` +
    `## Determination\n\n` +
    `${markdownTable([
      ['Field', 'Value'],
      ['determination', r.determination],
      ['input_bounded_source_lf_sha256', r.input_bounded_source_lf_sha256],
      ['input_bar_sigma_lf_sha256', r.input_bar_sigma_lf_sha256],
      ['bounded_signed_shock_source_lf_sha256', r.bounded_signed_shock_source_lf_sha256],
      ['closed_bars_available', String(r.closed_bars_available)],
      ['atr14_pts_value_if_ready', String(r.atr14_pts_value_if_ready)],
      ['session_vwap_ready', String(r.session_vwap_ready)],
      ['signed_shock_values_constructed', String(r.signed_shock_values_constructed)],
      ['recommended_next_ticket', r.recommended_next_ticket],
    ])}\n\n` +
    `## Semantics\n\nCurrent repo signed-shock semantics are pinned as \`${r.signed_shock_formula_or_source_semantics}\`.\n\n` +
    `Formula provenance: \`${r.signed_shock_formula_source}\`.\n\n` +
    `Important: PR #301 sigma readiness is informational here. The signed-shock denominator is \`atr_14\`, not \`sigma_pts\`.\n\n` +
    `## Blocker\n\nExact \`session_vwap\` is not proven from the bounded PR #301 window. The ticket therefore emits no signed-shock values and does not fabricate a VWAP anchor.\n\n` +
    `Missing dependencies: ${r.missing_dependency_list.map((item: string) => `\`${item}\``).join(', ')}.\n\n` +
    `## Authority caveat\n\nObservation-day eligible: \`${r.observation_day_eligible}\`. Observation-day increment: \`${r.observation_day_increment}\`. No \`StrategyFeatureSnapshot\`, paper runtime, \`STRAT_EVAL\`, \`CANDIDATE\`, \`ORDER_INTENT\`, broker/live, Phase 6, active roster, candidate roster, or observation-day authority is created.\n`;
}

function buildMemo(report: JsonValue): string {
  const r = report as Record<string, any>;
  return `# ${TICKET} Memo\n\n` +
    `## 1. Context\n\nPR #301 established closed \`1m\` bar and \`sigma_pts\` readiness. This ticket checks whether the signed-shock-specific inputs can now be materialized without emitting feature snapshots or running strategy evaluation.\n\n` +
    `## 2. Input provenance\n\nPR #301 bounded source SHA: \`${r.input_bounded_source_lf_sha256}\`. PR #301 report JSON SHA: \`${r.bar_sigma_window_report_json_sha256}\`. PR #301 internal bar/sigma output SHA: \`${r.input_bar_sigma_lf_sha256}\`.\n\n` +
    `## 3. Signed-shock source semantics\n\nCurrent repo semantics are pinned to \`${r.signed_shock_formula_source}\`: \`${r.signed_shock_formula_or_source_semantics}\`.\n\n` +
    `## 4. Sigma versus ATR\n\nPR #301 \`sigma_pts\` remains important for v2 stop/risk behavior, but it is not the signed-shock denominator. The signed-shock path uses \`atr_14\`. Bounded bars available: \`${r.closed_bars_available}\`; ATR14 ready: \`${r.atr_or_sigma_history_ready}\`; ATR14 value: \`${r.atr14_pts_value_if_ready}\`.\n\n` +
    `## 5. Session VWAP blocker\n\nExact \`session_vwap\` is not source-proven. The bounded PR #301 window has trade records, but current repo \`session_vwap\` depends on effective session context and causal in-session bar history. This memo does not treat bounded-window VWAP as a substitute.\n\n` +
    `## 6. Recent-history blocker\n\n\`computeSignedShockVwapRecentValues\` requires \`session_vwap\` and \`atr_14\`. ATR14 is ready, but recent signed-shock values remain blocked because \`session_vwap\` is not proven.\n\n` +
    `## 7. Determination\n\nDetermination: \`${r.determination}\`. Signed-shock values constructed: \`${r.signed_shock_values_constructed}\`. Recent values constructed: \`${r.signed_shock_recent_values_constructed}\`.\n\n` +
    `## 8. Recommended next ticket\n\n\`${r.recommended_next_ticket}\`: ${r.recommended_next_ticket_reason}\n\nDo not recommend feature-builder implementation until signed-shock source, session-state source, regime-join source, and the feature snapshot assembly contract are all resolved.\n\n` +
    `## 9. Verification\n\nThe extractor uses the committed PR #301 bounded source only, emits compact deterministic diagnostics, enforces the artifact-size guard, and preserves LF-canonical hashes.\n\n` +
    `## 10. Authority caveat\n\nObservation-day eligible: \`${r.observation_day_eligible}\`. Observation-day increment: \`${r.observation_day_increment}\`. No \`StrategyFeatureSnapshot\`, paper runtime, \`STRAT_EVAL\`, \`CANDIDATE\`, \`ORDER_INTENT\`, broker/live, Phase 6, active roster, candidate roster, or observation-day authority is created.\n`;
}

async function buildEvidence(maxEvents: number) {
  const [inputSourceText, inputReportText] = await Promise.all([
    readFile(INPUT_SOURCE, 'utf8'),
    readFile(INPUT_REPORT, 'utf8'),
  ]);
  const sourceRecords = parseSource(inputSourceText, maxEvents);
  const bars = buildClosedBars(sourceRecords);
  const atr14 = computeAtr14(bars);
  const inputReport = JSON.parse(inputReportText) as Record<string, JsonValue>;
  const outputRecords = diagnosticRecords({ records: sourceRecords, bars, atr14, report: inputReport });
  const outputTextA = stableJsonl(outputRecords);
  const outputTextB = stableJsonl(outputRecords);
  if (outputTextA !== outputTextB) throw new Error('bounded signed-shock source JSONL is not byte-stable');
  if (Buffer.byteLength(outputTextA, 'utf8') >= MAX_ARTIFACT_BYTES) throw new Error('bounded signed-shock source artifact exceeds size guard');
  const reportA = buildReport({ inputSourceText, reportText: inputReportText, outputText: outputTextA, outputRecords, sourceRecords, bars, atr14, maxEvents });
  const reportB = buildReport({ inputSourceText, reportText: inputReportText, outputText: outputTextB, outputRecords, sourceRecords, bars, atr14, maxEvents });
  const reportJsonA = stableJson(reportA);
  const reportJsonB = stableJson(reportB);
  if (reportJsonA !== reportJsonB) throw new Error('report JSON is not byte-stable');
  const reportMdA = buildMarkdown(reportA);
  const reportMdB = buildMarkdown(reportB);
  if (reportMdA !== reportMdB) throw new Error('report Markdown is not byte-stable');
  return { outputText: outputTextA, report: reportA, reportJson: reportJsonA, reportMd: reportMdA, memo: buildMemo(reportA) };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const evidence = await buildEvidence(args.maxEvents);
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(path.dirname(MEMO_PATH), { recursive: true });
  await writeFile(OUTPUT_SOURCE, evidence.outputText, 'utf8');
  await writeFile(OUTPUT_JSON, evidence.reportJson, 'utf8');
  await writeFile(OUTPUT_MD, evidence.reportMd, 'utf8');
  await writeFile(MEMO_PATH, evidence.memo, 'utf8');
  const size = (await stat(OUTPUT_SOURCE)).size;
  const report = evidence.report as Record<string, any>;
  console.log(JSON.stringify({
    ticket: TICKET,
    determination: report.determination,
    bounded_signed_shock_source_lf_sha256: report.bounded_signed_shock_source_lf_sha256,
    bounded_signed_shock_event_count: report.bounded_signed_shock_event_count,
    artifact_size_bytes: size,
    closed_bars_available: report.closed_bars_available,
    atr14_pts_value_if_ready: report.atr14_pts_value_if_ready,
    session_vwap_ready: report.session_vwap_ready,
    signed_shock_values_constructed: report.signed_shock_values_constructed,
    recommended_next_ticket: report.recommended_next_ticket,
    observation_day_eligible: report.observation_day_eligible,
    observation_day_increment: report.observation_day_increment,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
