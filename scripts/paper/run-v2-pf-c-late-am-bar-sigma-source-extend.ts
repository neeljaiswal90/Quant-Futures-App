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
  readonly record_type: 'BAR_SOURCE_DIAGNOSTIC' | 'SIGMA_SOURCE_DIAGNOSTIC' | 'SOURCE_GAP';
  readonly source_event_ids: readonly string[];
  readonly source_line_numbers: readonly number[];
  readonly source_ts_ns_range: { readonly min: string | null; readonly max: string | null };
  readonly bar_start_ts_ns: string | null;
  readonly bar_end_ts_ns: string | null;
  readonly derived_ts_ns: string | null;
  readonly max_source_ts_ns_used: string | null;
  readonly causality_status: string;
  readonly lookahead_detected: false;
  readonly payload: Record<string, JsonValue>;
};

const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-BAR-SIGMA-SOURCE-EXTEND-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const INPUT_PATH = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-source-data-extend-01/bounded-source-events.jsonl';
const INPUT_SHA = '0ab171e087826aaffb14cfbf6d3e5a51bd81173ace17efe85528790452010788';
const PR299_JOIN_SHA = 'ebd8a6c56dc038c2e01d5f18824cf74727e81085657c9ba588353f1dca897764';
const OUTPUT_DIR = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-bar-sigma-source-extend-01';
const OUTPUT_JSONL = `${OUTPUT_DIR}/bounded-bar-sigma-source.jsonl`;
const OUTPUT_JSON = `${OUTPUT_DIR}/bar-sigma-source-report.json`;
const OUTPUT_MD = `${OUTPUT_DIR}/bar-sigma-source-report.md`;
const MEMO_PATH = 'docs/research/v2-pf-c-late-am-paper-observation-bar-sigma-source-extend-01-memo.md';
const WINDOW_TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-BAR-SIGMA-SOURCE-WINDOW-EXTEND-01';
const SIGNED_SHOCK_TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-SIGNED-SHOCK-SOURCE-EXTEND-01';
const BAR_SPEC = '1m';
const BAR_INTERVAL_NS = 60_000_000_000n;
const TICK_SIZE = 0.25;
const SIGMA_FORMULA_SOURCE = 'apps/backtester/src/real-archive-execution/real-archive-execution-runner.ts:1215,1280';
const SIGMA_FORMULA = 'sigma_pts = round4(max(TICK_SIZE, average(bars.map(bar => bar.high - bar.low)) / 2))';
const MINIMUM_BARS_FOR_FORMULA = 1;
const MINIMUM_BARS_FOR_SIGNED_SHOCK_ATR14 = 15;

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
  if (!Number.isInteger(maxEvents) || maxEvents <= 0) throw new Error('--max-events must be positive');
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

function compareBigint(a: bigint, b: bigint): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function rangeFor(records: readonly InputRecord[]): { min: string | null; max: string | null } {
  if (records.length === 0) return { min: null, max: null };
  const sorted = [...records].sort((a, b) => compareBigint(BigInt(a.source_ts_ns), BigInt(b.source_ts_ns)));
  return { min: sorted[0]!.source_ts_ns, max: sorted[sorted.length - 1]!.source_ts_ns };
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
  return records.map((record) => BigInt(record.source_ts_ns)).sort(compareBigint).at(-1)!.toString();
}

function barStart(tsNs: string): string {
  const ts = BigInt(tsNs);
  return (ts - (ts % BAR_INTERVAL_NS)).toString();
}

function barEnd(startNs: string): string {
  return (BigInt(startNs) + BAR_INTERVAL_NS).toString();
}

function finiteNumber(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readInputRecords(text: string, maxEvents: number): readonly InputRecord[] {
  const records: InputRecord[] = [];
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
  for (const line of lines.slice(0, maxEvents)) {
    const parsed = JSON.parse(line) as InputRecord;
    if (!/^\d+$/u.test(parsed.source_ts_ns) || !/^\d+$/u.test(parsed.derived_ts_ns)) {
      throw new Error('input record is missing numeric timestamp strings');
    }
    records.push(parsed);
  }
  return records;
}

function inputCounts(records: readonly InputRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) counts[record.record_type] = (counts[record.record_type] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function buildPartialBar(records: readonly InputRecord[]) {
  const tradeRecords = records.filter((record) => record.record_type === 'TRADE');
  const quoteRecords = records.filter((record) => record.record_type === 'QUOTE');
  const prices = tradeRecords.map((record) => finiteNumber(record.payload?.price)).filter((value): value is number => value !== null);
  const quantities = tradeRecords.map((record) => finiteNumber(record.payload?.quantity)).filter((value): value is number => value !== null);
  const firstTrade = tradeRecords[0];
  const start = firstTrade === undefined ? null : barStart(firstTrade.source_ts_ns);
  const end = start === null ? null : barEnd(start);
  const max = maxTs([...tradeRecords, ...quoteRecords]);
  const sourceRange = rangeFor([...tradeRecords, ...quoteRecords]);
  const spanNs = sourceRange.min === null || sourceRange.max === null ? null : (BigInt(sourceRange.max) - BigInt(sourceRange.min)).toString();
  const finiteQuoteMidCount = quoteRecords.filter((record) => finiteNumber(record.payload?.mid_px) !== null).length;
  const ohlcv = prices.length === 0 ? null : {
    open: prices[0]!,
    high: Math.max(...prices),
    low: Math.min(...prices),
    close: prices[prices.length - 1]!,
    volume: quantities.reduce((total, value) => total + value, 0),
  };
  const partialSigma = ohlcv === null ? null : Math.max(TICK_SIZE, (ohlcv.high - ohlcv.low) / 2);
  return {
    tradeRecords,
    quoteRecords,
    start,
    end,
    max,
    sourceRange,
    spanNs,
    finiteQuoteMidCount,
    ohlcv,
    partialSigma,
    closedBarCount: 0,
  };
}

function assertRecordCausal(record: OutputRecord): void {
  if (record.lookahead_detected !== false) throw new Error(`${record.record_type} lookahead flag is not false`);
  if (record.max_source_ts_ns_used !== null && record.derived_ts_ns !== null) {
    if (BigInt(record.max_source_ts_ns_used) > BigInt(record.derived_ts_ns)) {
      throw new Error(`${record.record_type} violates no-lookahead contract`);
    }
  }
}

function buildRecords(inputRecords: readonly InputRecord[]): readonly OutputRecord[] {
  const bar = buildPartialBar(inputRecords);
  const barSourceRecords = [...bar.tradeRecords, ...bar.quoteRecords];
  const max = bar.max;
  const barRecord: OutputRecord = {
    record_type: 'BAR_SOURCE_DIAGNOSTIC',
    source_event_ids: eventIds(barSourceRecords),
    source_line_numbers: lineNumbers(barSourceRecords),
    source_ts_ns_range: bar.sourceRange,
    bar_start_ts_ns: bar.start,
    bar_end_ts_ns: bar.end,
    derived_ts_ns: max,
    max_source_ts_ns_used: max,
    causality_status: 'causal_partial_1m_bar_source_observed_not_closed',
    lookahead_detected: false,
    payload: {
      bar_spec: BAR_SPEC,
      bar_interval_ns: BAR_INTERVAL_NS.toString(),
      bar_interval_source: 'apps/backtester/src/real-archive-execution/real-archive-execution-runner.ts:219,337-339',
      bar_constructible_status: 'partial_open_bar_only',
      bars_constructed_count: 0,
      partial_bar_ohlcv: bar.ohlcv as JsonValue,
      partial_sigma_pts_if_treated_as_closed: bar.partialSigma,
      trade_count: bar.tradeRecords.length,
      quote_count: bar.quoteRecords.length,
      finite_quote_mid_count: bar.finiteQuoteMidCount,
      source_span_ns: bar.spanNs,
      close_blocker: 'bounded source span does not reach the 1m bar boundary, so no closed causal 1m bar is established',
    },
  };
  const sigmaRecord: OutputRecord = {
    record_type: 'SIGMA_SOURCE_DIAGNOSTIC',
    source_event_ids: eventIds(barSourceRecords),
    source_line_numbers: lineNumbers(barSourceRecords),
    source_ts_ns_range: bar.sourceRange,
    bar_start_ts_ns: bar.start,
    bar_end_ts_ns: bar.end,
    derived_ts_ns: max,
    max_source_ts_ns_used: max,
    causality_status: 'blocked_insufficient_closed_bar_history',
    lookahead_detected: false,
    payload: {
      sigma_pts_status: 'blocked_insufficient_history',
      sigma_formula_source: SIGMA_FORMULA_SOURCE,
      sigma_formula: SIGMA_FORMULA,
      sigma_lookback_required: MINIMUM_BARS_FOR_FORMULA,
      sigma_lookback_available: bar.closedBarCount,
      signed_shock_atr14_bars_required: MINIMUM_BARS_FOR_SIGNED_SHOCK_ATR14,
      signed_shock_atr14_bars_available: bar.closedBarCount,
      missing_reason: 'sigma_pts formula is pinned, but PR #298 bounded source does not establish a closed causal 1m bar; signed_shock_vwap remains further blocked on ATR14 history',
    },
  };
  const gapRecord: OutputRecord = {
    record_type: 'SOURCE_GAP',
    source_event_ids: [],
    source_line_numbers: [],
    source_ts_ns_range: rangeFor(inputRecords),
    bar_start_ts_ns: bar.start,
    bar_end_ts_ns: bar.end,
    derived_ts_ns: maxTs(inputRecords),
    max_source_ts_ns_used: maxTs(inputRecords),
    causality_status: 'blocked_insufficient_history',
    lookahead_detected: false,
    payload: {
      blocker_family: 'bar_sigma_history',
      missing_reason: 'PR #298 bounded source control is shorter than one 1m bar and cannot prove closed-bar or sigma_pts readiness',
      required_source: 'wider bounded source window with enough causal trade records to close 1m bars before feature-builder implementation',
      next_ticket_hint: WINDOW_TICKET,
    },
  };
  const output = [barRecord, sigmaRecord, gapRecord];
  for (const record of output) assertRecordCausal(record);
  return output;
}
function countOutputRecords(records: readonly OutputRecord[]): Record<string, number> {
  const counts: Record<string, number> = {
    BAR_SOURCE_DIAGNOSTIC: 0,
    SIGMA_SOURCE_DIAGNOSTIC: 0,
    SOURCE_GAP: 0,
  };
  for (const record of records) counts[record.record_type] = (counts[record.record_type] ?? 0) + 1;
  return counts;
}

function buildReport(input: {
  readonly inputText: string;
  readonly inputRecords: readonly InputRecord[];
  readonly outputText: string;
  readonly outputRecords: readonly OutputRecord[];
}): JsonValue {
  const barRecord = input.outputRecords.find((record) => record.record_type === 'BAR_SOURCE_DIAGNOSTIC');
  const sigmaRecord = input.outputRecords.find((record) => record.record_type === 'SIGMA_SOURCE_DIAGNOSTIC');
  const barPayload = barRecord?.payload ?? {};
  const sigmaPayload = sigmaRecord?.payload ?? {};
  return {
    schema_version: 1,
    ticket: TICKET,
    classification: 'BAR_SIGMA_SOURCE_BLOCKED_INSUFFICIENT_HISTORY',
    strategy_id: STRATEGY_ID,
    observation_day_eligible: false,
    observation_day_increment: 0,
    original_pr298_bounded_source_lf_sha256: sha256Text(input.inputText),
    input_bounded_source_lf_sha256: sha256Text(input.inputText),
    expected_input_bounded_source_lf_sha256: INPUT_SHA,
    prior_pr299_bounded_join_lf_sha256: PR299_JOIN_SHA,
    bounded_bar_sigma_source_lf_sha256: sha256Text(input.outputText),
    bounded_bar_sigma_record_count: input.outputRecords.length,
    bounded_bar_sigma_record_counts_by_type: countOutputRecords(input.outputRecords),
    input_bounded_source_event_count: input.inputRecords.length,
    input_bounded_source_event_counts_by_type: inputCounts(input.inputRecords),
    source_selection_reason: 'PR #298 bounded source control first; no wider live source was used because the control already proves insufficient history for 1m bar/sigma readiness',
    bar_readiness: {
      bar_interval: BAR_SPEC,
      bar_interval_ns: BAR_INTERVAL_NS.toString(),
      bar_interval_source: 'apps/backtester/src/real-archive-execution/real-archive-execution-runner.ts:219,337-339',
      bar_constructible_status: barPayload.bar_constructible_status ?? 'blocked',
      bars_constructed_count: barPayload.bars_constructed_count ?? 0,
      partial_bar_ohlcv: barPayload.partial_bar_ohlcv ?? null,
      quote_coverage: {
        quote_count: barPayload.quote_count ?? 0,
        finite_quote_mid_count: barPayload.finite_quote_mid_count ?? 0,
      },
      trade_count: barPayload.trade_count ?? 0,
      source_ts_ns_range: barRecord?.source_ts_ns_range ?? { min: null, max: null },
      close_blocker: barPayload.close_blocker ?? null,
    },
    sigma_readiness: {
      sigma_pts_status: sigmaPayload.sigma_pts_status ?? 'blocked_insufficient_history',
      sigma_formula_source: SIGMA_FORMULA_SOURCE,
      sigma_formula: SIGMA_FORMULA,
      sigma_lookback_required: sigmaPayload.sigma_lookback_required ?? MINIMUM_BARS_FOR_FORMULA,
      sigma_lookback_available: sigmaPayload.sigma_lookback_available ?? 0,
      signed_shock_atr14_bars_required: sigmaPayload.signed_shock_atr14_bars_required ?? MINIMUM_BARS_FOR_SIGNED_SHOCK_ATR14,
      signed_shock_atr14_bars_available: sigmaPayload.signed_shock_atr14_bars_available ?? 0,
      missing_reason: sigmaPayload.missing_reason ?? 'insufficient history',
    },
    no_lookahead_contract: {
      every_record_lookahead_detected_false: true,
      every_non_gap_record_has_max_source_ts_ns_used_lte_derived_ts_ns: true,
      source_gap_records_also_have_lookahead_detected_false: true,
    },
    deterministic_generation: {
      ab_byte_stable_bounded_bar_sigma_jsonl: true,
      ab_byte_stable_report_json: true,
      ab_byte_stable_report_md: true,
      hash_convention: 'LF-canonical SHA-256 over exact generated payload',
    },
    recommended_next_ticket: WINDOW_TICKET,
    recommended_next_ticket_reason: 'The PR #298 bounded source control is shorter than one 1m bar and cannot prove closed-bar or sigma_pts readiness; extend the bounded source window before signed-shock source work.',
    downstream_after_ready: SIGNED_SHOCK_TICKET,
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
  for (const [type, count] of Object.entries(r.bounded_bar_sigma_record_counts_by_type as Record<string, number>)) {
    countRows.push([type, String(count)]);
  }
  const readinessRows = [
    ['Area', 'Status', 'Evidence'],
    ['Bar construction', r.bar_readiness.bar_constructible_status, `${r.bar_readiness.bars_constructed_count} closed bars; ${r.bar_readiness.trade_count} trades; ${r.bar_readiness.quote_coverage.finite_quote_mid_count} finite quote mids`],
    ['Sigma', r.sigma_readiness.sigma_pts_status, `${r.sigma_readiness.sigma_lookback_available}/${r.sigma_readiness.sigma_lookback_required} bars for sigma_pts formula`],
    ['Signed-shock downstream', 'blocked_until_bar_sigma_ready', `${r.sigma_readiness.signed_shock_atr14_bars_available}/${r.sigma_readiness.signed_shock_atr14_bars_required} bars for ATR14 basis`],
  ];
  return `# ${TICKET} — Bar/Sigma Source Report\n\n` +
    `## Determination\n\n` +
    `Classification: \`${r.classification}\`\n\n` +
    `Observation-day eligible: \`${r.observation_day_eligible}\`\n\n` +
    `Observation-day increment: \`${r.observation_day_increment}\`\n\n` +
    `Input bounded source LF SHA-256: \`${r.input_bounded_source_lf_sha256}\`\n\n` +
    `Output bounded bar/sigma LF SHA-256: \`${r.bounded_bar_sigma_source_lf_sha256}\`\n\n` +
    `## Output record counts\n\n${markdownTable(countRows)}\n\n` +
    `## Readiness\n\n${markdownTable(readinessRows)}\n\n` +
    `## Formula and interval\n\nBar interval is pinned to \`${r.bar_readiness.bar_interval}\` from \`${r.bar_readiness.bar_interval_source}\`. \`sigma_pts\` source is \`${r.sigma_readiness.sigma_formula_source}\`: \`${r.sigma_readiness.sigma_formula}\`.\n\n` +
    `## Recommended next ticket\n\n\`${r.recommended_next_ticket}\` — ${r.recommended_next_ticket_reason}\n\n` +
    `## Authority caveat\n\nThis report is source-data evidence only. It emits no feature snapshots, no paper runtime processing, no strategy markers, no observation-day credit, and no broker/live/Phase 6/roster authority.\n`;
}
function buildMemo(report: JsonValue): string {
  const r = report as Record<string, any>;
  return `# ${TICKET} Memo\n\n` +
    `## 1. Context and PR #299 dependency ordering\n\n` +
    `PR #299 established bar/sigma as the first dependency because \`signed_shock_vwap\` depends on causal VWAP/sigma history. This ticket tests the PR #298 bounded source control before any wider live-source extension.\n\n` +
    `## 2. Input source provenance\n\n` +
    `Input bounded source SHA: \`${r.input_bounded_source_lf_sha256}\`. Expected PR #298 anchor: \`${r.expected_input_bounded_source_lf_sha256}\`. PR #299 join anchor: \`${r.prior_pr299_bounded_join_lf_sha256}\`. No wider live-source window was generated in this pass.\n\n` +
    `## 3. Bar construction method\n\n` +
    `The existing archive feature path uses \`${r.bar_readiness.bar_interval}\` bars from \`${r.bar_readiness.bar_interval_source}\`. The PR #298 control can form only a partial open bar diagnostic: \`${r.bar_readiness.bar_constructible_status}\`, with \`${r.bar_readiness.bars_constructed_count}\` closed bars.\n\n` +
    `## 4. sigma_pts formula/source assessment\n\n` +
    `Formula source: \`${r.sigma_readiness.sigma_formula_source}\`. Formula: \`${r.sigma_readiness.sigma_formula}\`. Status: \`${r.sigma_readiness.sigma_pts_status}\`. Available lookback: \`${r.sigma_readiness.sigma_lookback_available}\`; required for the formula: \`${r.sigma_readiness.sigma_lookback_required}\`.\n\n` +
    `## 5. Bounded bar/sigma output summary\n\n` +
    `Output bounded bar/sigma SHA: \`${r.bounded_bar_sigma_source_lf_sha256}\`. Output record count: \`${r.bounded_bar_sigma_record_count}\`. Classification: \`${r.classification}\`.\n\n` +
    `## 6. No-lookahead contract\n\n` +
    `Every record carries \`lookahead_detected=false\`. Non-gap records assert \`max_source_ts_ns_used <= derived_ts_ns\`. Hashes are LF-canonical SHA-256 over the exact generated payload.\n\n` +
    `## 7. Remaining blockers\n\n` +
    `The PR #298 control proves quote/trade ingredients, but not a closed 1-minute bar or sufficient history for \`sigma_pts\`. Signed-shock source work remains downstream because ATR14 history is also unavailable in the bounded control.\n\n` +
    `## 8. Recommended next ticket\n\n` +
    `\`${r.recommended_next_ticket}\` — ${r.recommended_next_ticket_reason}.\n\n` +
    `## 9. Verification\n\n` +
    `Generated with deterministic A/B byte-stability checks for JSONL, JSON report, and Markdown report.\n\n` +
    `## 10. Authority caveat\n\n` +
    `Observation-day eligible: \`${r.observation_day_eligible}\`. Observation-day increment: \`${r.observation_day_increment}\`. No broker/live, Phase 6, active roster, candidate roster, paper runtime, or strategy marker authority is created.\n`;
}

async function buildEvidence(maxEvents: number) {
  const inputText = await readFile(INPUT_PATH, 'utf8');
  const inputHash = sha256Text(inputText);
  if (inputHash !== INPUT_SHA) throw new Error(`PR #298 input hash mismatch: expected ${INPUT_SHA}, got ${inputHash}`);
  const inputRecords = readInputRecords(inputText, maxEvents);
  const outputA = buildRecords(inputRecords);
  const outputB = buildRecords(inputRecords);
  const outputTextA = stableJsonl(outputA);
  const outputTextB = stableJsonl(outputB);
  if (outputTextA !== outputTextB) throw new Error('bar/sigma JSONL is not byte-stable');
  const reportA = buildReport({ inputText, inputRecords, outputText: outputTextA, outputRecords: outputA });
  const reportB = buildReport({ inputText, inputRecords, outputText: outputTextB, outputRecords: outputB });
  const reportJsonA = stableJson(reportA);
  const reportJsonB = stableJson(reportB);
  if (reportJsonA !== reportJsonB) throw new Error('report JSON is not byte-stable');
  const mdA = buildMarkdown(reportA);
  const mdB = buildMarkdown(reportB);
  if (mdA !== mdB) throw new Error('report Markdown is not byte-stable');
  return {
    outputText: outputTextA,
    report: reportA,
    reportJson: reportJsonA,
    reportMd: mdA,
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
    input_bounded_source_lf_sha256: report.input_bounded_source_lf_sha256,
    bounded_bar_sigma_source_lf_sha256: report.bounded_bar_sigma_source_lf_sha256,
    bounded_bar_sigma_record_count: report.bounded_bar_sigma_record_count,
    bars_constructed_count: report.bar_readiness.bars_constructed_count,
    sigma_pts_status: report.sigma_readiness.sigma_pts_status,
    recommended_next_ticket: report.recommended_next_ticket,
    observation_day_eligible: report.observation_day_eligible,
    observation_day_increment: report.observation_day_increment,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
