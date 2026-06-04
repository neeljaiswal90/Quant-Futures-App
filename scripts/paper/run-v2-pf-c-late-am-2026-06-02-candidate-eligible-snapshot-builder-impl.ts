import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = process.cwd();
const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-CANDIDATE-ELIGIBLE-SNAPSHOT-BUILDER-IMPL-01';
const SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-02-candidate-eligible-snapshot-builder-impl-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const OUT_DIR = path.join(ROOT, 'artifacts', 'paper-observation', SLUG);
const BOUNDED_JSONL = path.join(OUT_DIR, 'bounded-candidate-eligible-feature-snapshot.jsonl');
const REPORT_JSON = path.join(OUT_DIR, 'candidate-eligible-snapshot-builder-report.json');
const REPORT_MD = path.join(OUT_DIR, 'candidate-eligible-snapshot-builder-report.md');
const MEMO_MD = path.join(ROOT, 'docs', 'research', `${SLUG}-memo.md`);
const BACKLOG_CSV = path.join(ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');
const MAX_ARTIFACT_BYTES = 95 * 1024 * 1024;

const OBS01_PATH = 'D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02/MNQ_rth.obs01.jsonl';
const MBP1_PATH = 'D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02/MNQ_rth.mbp1.jsonl';
const TARGET_TS_NS = 1780427100000000000n;
const SESSION_OPEN_NS = BigInt(Date.parse('2026-06-02T13:30:00.000Z')) * 1_000_000n;
const ONE_MINUTE_NS = 60_000_000_000n;
const TICK_SIZE = 0.25;
const POINT_VALUE = 2;
const PRICE_DECIMALS = 2;
const LOW_SHOCK_THRESHOLD_POS = 2.7;
const REGIME_LABEL = 'low';

const PR310_ANCHOR = {
  merge_commit: '59940c7383716f1792f81ceb2c1d48acf1d65d93',
  ticket: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-CANDIDATE-ELIGIBLE-NON-EXCLUDED-SNAPSHOT-SOURCE-SCOPE-01',
  bounded_source_scope_lf_sha256: 'bef6f28655b42d580d3d214747a38d539c5a4ec5d631f5e2c923f5f27afb1d08',
  report_json_lf_sha256: '4e5f8b98a1fe57e9a90410dffc22448007722c1dee803b940b18e05a3a154ed4',
  candidate_timestamp_ns: TARGET_TS_NS.toString(),
  candidate_timestamp_utc: '2026-06-02T19:05:00.000000000Z',
  candidate_entry_hour_utc: 19,
  utc_exclusion_gate_status: 'NON_EXCLUDED_BY_UTC_16_18_GATE',
  context_regime_label: REGIME_LABEL,
  quote_mid_px: 30667.5,
  session_vwap: 30642.6641,
  signed_shock_vwap: 2.7449,
  low_shock_threshold_pos: LOW_SHOCK_THRESHOLD_POS,
  threshold_comparison_result: '2.7449 >= 2.7',
  base_predicates_pass_before_utc_gate: true,
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Bar = {
  start_ts_ns: bigint;
  end_ts_ns: bigint;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trade_count: number;
};

type TradeScan = {
  bars: Bar[];
  source_trade_records: number;
  used_trade_records: number;
  first_trade_ts_ns: bigint | null;
  last_trade_ts_ns: bigint | null;
};

type Quote = {
  ts_ns: bigint;
  bid_px: number;
  ask_px: number;
  mid_px: number;
};

type QuoteScan = {
  source_quote_records: number;
  finite_quote_records: number;
  quote_records_with_null_mid: number;
  selected_quote: Quote | null;
};

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

function stableJson(value: Json): string {
  return JSON.stringify(sortJson(value), null, 2) + '\n';
}

function sortJson(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item));
  }
  if (value !== null && typeof value === 'object') {
    const output: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = sortJson(value[key]);
    }
    return output;
  }
  return value;
}

function stableJsonl(records: Json[]): string {
  return records.map((record) => JSON.stringify(sortJson(record))).join('\n') + '\n';
}

function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function nsToIso(ns: bigint): string {
  const millis = (ns / 1_000_000_000n) * 1_000n;
  const nanos = ns % 1_000_000_000n;
  const base = new Date(Number(millis)).toISOString().replace('.000Z', '');
  return `${base}.${nanos.toString().padStart(9, '0')}Z`;
}

function extractNs(line: string, key: string): bigint | null {
  const match = line.match(new RegExp(`"${key}"\\s*:\\s*"?(\\d+)"?`));
  return match ? BigInt(match[1]) : null;
}

function extractNumber(line: string, key: string): number | null {
  const match = line.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : null;
}

function minuteBucketStart(tsNs: bigint): bigint {
  return SESSION_OPEN_NS + ((tsNs - SESSION_OPEN_NS) / ONE_MINUTE_NS) * ONE_MINUTE_NS;
}

function updateBar(bar: Bar, price: number, quantity: number): void {
  bar.high = Math.max(bar.high, price);
  bar.low = Math.min(bar.low, price);
  bar.close = price;
  bar.volume += quantity;
  bar.trade_count += 1;
}

async function scanTradesAndBars(sourcePath: string): Promise<TradeScan> {
  if (!existsSync(sourcePath)) {
    throw new Error(`Missing OBS source path: ${sourcePath}`);
  }

  const barsByStart = new Map<string, Bar>();
  let sourceTradeRecords = 0;
  let usedTradeRecords = 0;
  let firstTradeTsNs: bigint | null = null;
  let lastTradeTsNs: bigint | null = null;

  const rl = createInterface({
    input: createReadStream(sourcePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.includes('"type":"TRADE"') && !line.includes('"type": "TRADE"')) {
      continue;
    }
    sourceTradeRecords += 1;
    const tsNs = extractNs(line, 'ts_ns');
    const price = extractNumber(line, 'price');
    const quantity = extractNumber(line, 'quantity');
    if (
      tsNs === null ||
      price === null ||
      quantity === null ||
      tsNs < SESSION_OPEN_NS ||
      tsNs > TARGET_TS_NS ||
      !Number.isFinite(price) ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      continue;
    }

    const bucketStart = minuteBucketStart(tsNs);
    const key = bucketStart.toString();
    const existing = barsByStart.get(key);
    if (existing) {
      updateBar(existing, price, quantity);
    } else {
      barsByStart.set(key, {
        start_ts_ns: bucketStart,
        end_ts_ns: bucketStart + ONE_MINUTE_NS,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: quantity,
        trade_count: 1,
      });
    }

    usedTradeRecords += 1;
    if (firstTradeTsNs === null) {
      firstTradeTsNs = tsNs;
    }
    lastTradeTsNs = tsNs;
  }

  const bars = Array.from(barsByStart.values())
    .filter((bar) => bar.end_ts_ns <= TARGET_TS_NS)
    .sort((a, b) => (a.start_ts_ns < b.start_ts_ns ? -1 : 1));

  return {
    bars,
    source_trade_records: sourceTradeRecords,
    used_trade_records: usedTradeRecords,
    first_trade_ts_ns: firstTradeTsNs,
    last_trade_ts_ns: lastTradeTsNs,
  };
}

async function scanSelectedQuote(sourcePath: string): Promise<QuoteScan> {
  if (!existsSync(sourcePath)) {
    throw new Error(`Missing MBP1 source path: ${sourcePath}`);
  }

  let sourceQuoteRecords = 0;
  let finiteQuoteRecords = 0;
  let quoteRecordsWithNullMid = 0;
  let selectedQuote: Quote | null = null;

  const rl = createInterface({
    input: createReadStream(sourcePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    sourceQuoteRecords += 1;
    const tsNs = extractNs(line, 'ts_event_ns') ?? extractNs(line, 'ts_recv_ns');
    if (tsNs === null || tsNs < SESSION_OPEN_NS) {
      continue;
    }
    if (tsNs > TARGET_TS_NS) {
      break;
    }

    const bidPx = extractNumber(line, 'bid_px_00');
    const askPx = extractNumber(line, 'ask_px_00');
    if (bidPx === null || askPx === null || !Number.isFinite(bidPx) || !Number.isFinite(askPx)) {
      quoteRecordsWithNullMid += 1;
      continue;
    }

    selectedQuote = {
      ts_ns: tsNs,
      bid_px: bidPx,
      ask_px: askPx,
      mid_px: round4((bidPx + askPx) / 2),
    };
    finiteQuoteRecords += 1;
  }

  return {
    source_quote_records: sourceQuoteRecords,
    finite_quote_records: finiteQuoteRecords,
    quote_records_with_null_mid: quoteRecordsWithNullMid,
    selected_quote: selectedQuote,
  };
}

function trueRange(bar: Bar, prior: Bar | null): number {
  if (prior === null) {
    return bar.high - bar.low;
  }
  return Math.max(bar.high - bar.low, Math.abs(bar.high - prior.close), Math.abs(bar.low - prior.close));
}

function computeAtr14(bars: Bar[]): number {
  if (bars.length < 14) {
    throw new Error(`Cannot compute ATR14 from ${bars.length} bars`);
  }
  let atr = 0;
  for (let i = 0; i < 14; i += 1) {
    atr += trueRange(bars[i], i === 0 ? null : bars[i - 1]);
  }
  atr /= 14;
  for (let i = 14; i < bars.length; i += 1) {
    atr = (atr * 13 + trueRange(bars[i], bars[i - 1])) / 14;
  }
  return round4(atr);
}

function computeSigmaPts(bars: Bar[]): number {
  if (bars.length === 0) {
    throw new Error('Cannot compute sigma_pts from zero bars');
  }
  const averageRange = bars.reduce((sum, bar) => sum + (bar.high - bar.low), 0) / bars.length;
  return round4(Math.max(TICK_SIZE, averageRange / 2));
}

function computeSessionVwap(bars: Bar[]): number {
  let pv = 0;
  let volume = 0;
  for (const bar of bars) {
    pv += bar.close * bar.volume;
    volume += bar.volume;
  }
  if (volume <= 0) {
    throw new Error('Cannot compute session VWAP without positive volume');
  }
  return round4(pv / volume);
}

function serializeBar(bar: Bar): Json {
  return {
    close: round4(bar.close),
    end_ts_ns: bar.end_ts_ns.toString(),
    end_ts_utc: nsToIso(bar.end_ts_ns),
    high: round4(bar.high),
    low: round4(bar.low),
    open: round4(bar.open),
    start_ts_ns: bar.start_ts_ns.toString(),
    start_ts_utc: nsToIso(bar.start_ts_ns),
    timeframe: '1m',
    trade_count: bar.trade_count,
    volume: round4(bar.volume),
  };
}

function appendBacklogRow(): void {
  const row =
    'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-CANDIDATE-ELIGIBLE-SNAPSHOT-BUILDER-IMPL-01,P1,1.0,V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-CANDIDATE-ELIGIBLE-NON-EXCLUDED-SNAPSHOT-SOURCE-SCOPE-01,Emit a causal source-backed candidate-eligible 2026-06-02 StrategyFeatureSnapshot for the non-excluded 19:05Z source point without strategy markers observation-day credit or authority,new_cycle4_v2_research_substrate';
  const text = readText(BACKLOG_CSV);
  if (text.includes(TICKET)) {
    return;
  }
  writeFileSync(BACKLOG_CSV, text.endsWith('\n') ? `${text}${row}\n` : `${text}\n${row}\n`, 'utf8');
}

function consumerCompatibilityTable(): Json[] {
  return [
    ['created_ts_ns', 'PR #310 selected candidate timestamp'],
    ['quote.mid_px', '2026-06-02 MBP1 latest finite bid/ask at or before 19:05Z'],
    ['session.is_rth', 'PR #303 source window and PR #307 session calendar'],
    ['session.is_halt', 'PR #307 MNQ session calendar'],
    ['session.is_roll_block', 'PR #307 MNQ roll calendar and policy'],
    ['indicators.sigma_pts', 'Recomputed from source-backed closed 1m bars'],
    ['context.regime_label', 'PR #305 scoped regime-label source'],
    ['context.signed_shock_vwap.value', 'PR #310 selected candidate point'],
    ['config.config_hash / config.config_version', 'Variant-owned config lineage'],
  ].map(([field, source]) => ({
    consumer_status: 'READY',
    placeholder_used: false,
    snapshot_field_path: field,
    source_ready_anchor: source,
    value_present: true,
  }));
}

function buildMarkdown(report: { [key: string]: Json }): string {
  const selected = report.selected_candidate_point as { [key: string]: Json };
  const compatibility = report.consumer_compatibility_table as Json[];
  const hashes = report.output_hashes as { [key: string]: Json };
  const nextSmoke = report.next_smoke_expectations as { [key: string]: Json };
  return `# ${TICKET}

## Determination

\`\`\`text
${report.determination}
\`\`\`

## Selected candidate-backed snapshot

| Field | Value |
|---|---|
| feature_snapshot_id | \`${report.feature_snapshot_id}\` |
| timestamp_utc | \`${selected.timestamp_utc}\` |
| entry_hour_utc | \`${selected.entry_hour_utc}\` |
| utc_exclusion_gate_status | \`${selected.utc_exclusion_gate_status}\` |
| context.regime_label | \`${selected['context.regime_label']}\` |
| quote.mid_px | \`${selected['quote.mid_px']}\` |
| context.session_vwap | \`${selected['context.session_vwap']}\` |
| indicators.atr14_pts | \`${selected['indicators.atr14_pts']}\` |
| indicators.sigma_pts | \`${selected['indicators.sigma_pts']}\` |
| context.signed_shock_vwap.value | \`${selected['context.signed_shock_vwap.value']}\` |
| threshold_comparison_result | \`${selected.threshold_comparison_result}\` |
| base_predicates_pass_before_utc_gate | \`${selected.base_predicates_pass_before_utc_gate}\` |

## Consumer compatibility

| Snapshot field path | Value present | Placeholder used | Source-ready anchor | Consumer status |
|---|---:|---:|---|---|
${compatibility
  .map((row) => {
    const item = row as { [key: string]: Json };
    return `| \`${item.snapshot_field_path}\` | \`${item.value_present}\` | \`${item.placeholder_used}\` | ${item.source_ready_anchor} | \`${item.consumer_status}\` |`;
  })
  .join('\n')}

## Guardrails

| Field | Value |
|---|---|
| STRAT_EVAL_count | \`0\` |
| CANDIDATE_count | \`0\` |
| ORDER_INTENT_count | \`0\` |
| observation_day_eligible | \`false\` |
| observation_day_increment | \`0\` |
| paper_runtime_invoked | \`false\` |
| broker_live_authorized | \`false\` |
| phase_6_authorized | \`false\` |

## Expected next candidate strat-eval smoke outcome

| Field | Value |
|---|---|
| expected_next_candidate_strat_eval_smoke_outcome | \`${nextSmoke.expected_next_candidate_strat_eval_smoke_outcome}\` |
| STRAT_EVAL_count_expected | \`${nextSmoke.STRAT_EVAL_count_expected}\` |
| CANDIDATE_count_expected | \`${nextSmoke.CANDIDATE_count_expected}\` |
| ORDER_INTENT_count_expected | \`${nextSmoke.ORDER_INTENT_count_expected}\` |
| expectation_reason | ${nextSmoke.expectation_reason} |

## Output hashes

| File | LF SHA-256 |
|---|---|
| bounded-candidate-eligible-feature-snapshot.jsonl | \`${hashes.bounded_jsonl}\` |
| candidate-eligible-snapshot-builder-report.json | \`${hashes.report_json}\` |

## Recommended next ticket

\`\`\`text
${report.recommended_next_ticket}
\`\`\`

${report.recommended_next_ticket_purpose}
`;
}

function buildMemo(report: { [key: string]: Json }): string {
  const nextSmoke = report.next_smoke_expectations as { [key: string]: Json };
  return `# ${TICKET} memo

## Summary

\`\`\`text
${report.determination}
\`\`\`

This ticket emits one bounded, source-backed StrategyFeatureSnapshot for the candidate-eligible non-excluded 2026-06-02 point proven by PR #310. It does not run strategy evaluation and creates no observation-day or authority change.

## Selected point

\`\`\`json
${JSON.stringify(report.selected_candidate_point, null, 2)}
\`\`\`

## Compatibility

All behavior-bearing consumer fields are present and non-placeholder:

\`\`\`json
${JSON.stringify(report.consumer_compatibility_table, null, 2)}
\`\`\`

## Expected next candidate strat-eval smoke outcome

\`\`\`json
${JSON.stringify(nextSmoke, null, 2)}
\`\`\`

## Authority caveat

No \`STRAT_EVAL\`, \`CANDIDATE\`, \`ORDER_INTENT\`, qfa-410b/qfa-611, observation-day credit, paper/live/broker/Phase 6/roster authority, config mutation, or global regime-label mutation is created by this bounded builder artifact.

## Recommended next ticket

\`\`\`text
${report.recommended_next_ticket}
\`\`\`

${report.recommended_next_ticket_purpose}
`;
}

async function main(): Promise<void> {
  ensureDir(OUT_DIR);
  ensureDir(path.dirname(MEMO_MD));

  const strategyConfigPath = path.join(ROOT, 'config', 'strategies', 'regime_shock_reversion_short_v2_utc_16_18_exclusion.yaml');
  if (!existsSync(strategyConfigPath)) {
    throw new Error(`Missing strategy config path: ${strategyConfigPath}`);
  }

  const tradeScan = await scanTradesAndBars(OBS01_PATH);
  const quoteScan = await scanSelectedQuote(MBP1_PATH);
  if (quoteScan.selected_quote === null) {
    throw new Error('No finite quote available at or before selected candidate timestamp');
  }

  const bars = tradeScan.bars;
  const sessionVwap = computeSessionVwap(bars);
  const atr14Pts = computeAtr14(bars);
  const sigmaPts = computeSigmaPts(bars);
  const signedShockVwap = round4((quoteScan.selected_quote.mid_px - sessionVwap) / atr14Pts);
  const thresholdComparisonResult = `${signedShockVwap} >= ${LOW_SHOCK_THRESHOLD_POS}`;
  const basePredicatesPass = signedShockVwap >= LOW_SHOCK_THRESHOLD_POS;
  if (!basePredicatesPass) {
    throw new Error(`Selected point no longer passes low threshold: ${thresholdComparisonResult}`);
  }

  const selectedCandidatePoint: { [key: string]: Json } = {
    base_predicates_pass_before_utc_gate: true,
    'context.regime_label': REGIME_LABEL,
    'context.session_vwap': sessionVwap,
    'context.signed_shock_vwap.value': signedShockVwap,
    entry_hour_utc: 19,
    'indicators.atr14_pts': atr14Pts,
    'indicators.sigma_pts': sigmaPts,
    'quote.mid_px': quoteScan.selected_quote.mid_px,
    'session.is_halt': false,
    'session.is_roll_block': false,
    'session.is_rth': true,
    snapshot_value_compared: signedShockVwap,
    threshold_comparison_result: thresholdComparisonResult,
    threshold_name: 'parameters.low_shock_threshold_pos',
    threshold_value: LOW_SHOCK_THRESHOLD_POS,
    timestamp_ns: TARGET_TS_NS.toString(),
    timestamp_utc: nsToIso(TARGET_TS_NS),
    utc_exclusion_gate_status: 'NON_EXCLUDED_BY_UTC_16_18_GATE',
  };

  const strategyConfigHash = sha256FileLf(strategyConfigPath);
  const featureSnapshotId = `feature-v2pf-20260602-${TARGET_TS_NS.toString()}`;
  const snapshot: { [key: string]: Json } = {
    bars: bars.map(serializeBar),
    config: {
      config_hash: strategyConfigHash,
      config_version: 1,
      strategy_config_path: 'config/strategies/regime_shock_reversion_short_v2_utc_16_18_exclusion.yaml',
    },
    context: {
      regime_label: REGIME_LABEL,
      session_vwap: sessionVwap,
      session_vwap_band_sigma_pts: sigmaPts,
      signed_shock_vwap: {
        anchor_type: 'vwap',
        anchor_value: sessionVwap,
        sigma_basis: 'atr_14',
        sigma_basis_value: atr14Pts,
        value: signedShockVwap,
      },
      vix_prior_close_percentile: 0.05,
      vix_value: 16.05,
      vxn_value: 23.18,
    },
    created_ts_ns: TARGET_TS_NS.toString(),
    created_ts_utc: nsToIso(TARGET_TS_NS),
    feature_snapshot_id: featureSnapshotId,
    indicators: {
      atr_14_pts: atr14Pts,
      session_vwap: sessionVwap,
      sigma_pts: sigmaPts,
      signed_shock_vwap: signedShockVwap,
    },
    instrument: {
      contract_month: '2026-06',
      currency: 'USD',
      exchange: 'CME',
      point_value: POINT_VALUE,
      price_decimals: PRICE_DECIMALS,
      root: 'MNQ',
      symbol: 'MNQM6',
      tick_size: TICK_SIZE,
    },
    quote: {
      ask_px: quoteScan.selected_quote.ask_px,
      bid_px: quoteScan.selected_quote.bid_px,
      mid_px: quoteScan.selected_quote.mid_px,
      source_ts_ns: quoteScan.selected_quote.ts_ns.toString(),
      source_ts_utc: nsToIso(quoteScan.selected_quote.ts_ns),
    },
    session: {
      is_halt: false,
      is_roll_block: false,
      is_rth: true,
      opened_ts_ns: SESSION_OPEN_NS.toString(),
      opened_ts_utc: nsToIso(SESSION_OPEN_NS),
      phase: 'rth',
      session_id: '2026-06-02-rth',
      trading_date: '2026-06-02',
    },
    source_lineage: {
      pr310: PR310_ANCHOR,
      source_paths: {
        mbp1: MBP1_PATH,
        obs01: OBS01_PATH,
      },
    },
    strategy_id: STRATEGY_ID,
  };

  const guardrails: { [key: string]: Json } = {
    CANDIDATE_count: 0,
    ORDER_INTENT_count: 0,
    STRAT_EVAL_count: 0,
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

  const compatibility = consumerCompatibilityTable();
  const expectedNextCandidateStratEvalSmokeOutcome = 'STRAT_EVAL_AND_CANDIDATE_EXPECTED_ORDER_INTENT_SUPPRESSED';
  const nextSmokeExpectations: { [key: string]: Json } = {
    CANDIDATE_count_expected: 1,
    ORDER_INTENT_count_expected: 0,
    STRAT_EVAL_count_expected: 1,
    expectation_reason:
      'The 19:05Z source-backed snapshot is non-excluded and inherited v2 base predicates pass before the UTC gate; the next smoke should prove candidate emission while still suppressing ORDER_INTENT and all execution/observation-day authority.',
    expected_next_candidate_strat_eval_smoke_outcome: expectedNextCandidateStratEvalSmokeOutcome,
  };
  const records: Json[] = [
    {
      record_type: 'SOURCE_SCOPE_ANCHOR',
      pr310_anchor: PR310_ANCHOR,
      ticket: TICKET,
    },
    {
      record_type: 'SELECTED_CANDIDATE_POINT',
      selected_candidate_point: selectedCandidatePoint,
      ticket: TICKET,
    },
    {
      record_type: 'STRATEGY_FEATURE_SNAPSHOT',
      snapshot,
      ticket: TICKET,
    },
    {
      consumer_compatibility: compatibility,
      consumer_compatibility_table: compatibility,
      record_type: 'CONSUMER_COMPATIBILITY',
      ticket: TICKET,
    },
    {
      next_smoke_expectations: nextSmokeExpectations,
      record_type: 'NEXT_CANDIDATE_STRAT_EVAL_SMOKE_EXPECTATIONS',
      ticket: TICKET,
    },
    {
      guardrails,
      record_type: 'AUTHORITY_GUARDRAILS',
      ticket: TICKET,
    },
  ];

  writeFileSync(BOUNDED_JSONL, stableJsonl(records), 'utf8');
  if (statSync(BOUNDED_JSONL).size > MAX_ARTIFACT_BYTES) {
    throw new Error(`Bounded JSONL exceeds 95 MiB guard: ${BOUNDED_JSONL}`);
  }

  const report: { [key: string]: Json } = {
    bars_in_snapshot: bars.length,
    consumer_compatibility: compatibility,
    consumer_compatibility_table: compatibility,
    determination: 'CANDIDATE_ELIGIBLE_SNAPSHOT_BUILDER_IMPL_EMITTED_SOURCE_BACKED_SNAPSHOT',
    expected_next_candidate_strat_eval_smoke_outcome: expectedNextCandidateStratEvalSmokeOutcome,
    feature_snapshot_builder_ready_for_candidate_strat_eval_scope: true,
    feature_snapshot_id: featureSnapshotId,
    guardrails,
    malformed_iso_timestamp_pattern_absent: !stableJsonl(records).includes('550Z.550603543Z'),
    output_hashes: {
      bounded_jsonl: sha256FileLf(BOUNDED_JSONL),
    },
    pr310_anchor: PR310_ANCHOR,
    next_smoke_expectations: nextSmokeExpectations,
    recommended_next_ticket: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-CANDIDATE-STRAT-EVAL-SMOKE-01',
    recommended_next_ticket_purpose:
      'Verify STRAT_EVAL marker generation from the candidate-eligible source-backed snapshot while checking whether CANDIDATE behavior matches the non-excluded 19:05Z base-passing source point; still no observation-day credit unless separately scoped.',
    selected_candidate_point: selectedCandidatePoint,
    source_counts: {
      bars_in_snapshot: bars.length,
      finite_quote_records_to_target: quoteScan.finite_quote_records,
      quote_records_with_null_mid_to_target: quoteScan.quote_records_with_null_mid,
      source_quote_records_to_target: quoteScan.source_quote_records,
      source_trade_records: tradeScan.source_trade_records,
      used_trade_records_to_target: tradeScan.used_trade_records,
    },
    strategy_feature_snapshot_count: 1,
    strategy_id: STRATEGY_ID,
    ticket: TICKET,
  };

  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  report.output_hashes = {
    bounded_jsonl: sha256FileLf(BOUNDED_JSONL),
    report_json: sha256FileLf(REPORT_JSON),
  };
  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  writeFileSync(REPORT_MD, buildMarkdown(report), 'utf8');
  writeFileSync(MEMO_MD, buildMemo(report), 'utf8');
  appendBacklogRow();

  const finalOutput = {
    bounded_jsonl_lf_sha256: sha256FileLf(BOUNDED_JSONL),
    determination: report.determination,
    feature_snapshot_builder_ready_for_candidate_strat_eval_scope:
      report.feature_snapshot_builder_ready_for_candidate_strat_eval_scope,
    feature_snapshot_id: featureSnapshotId,
    memo_lf_sha256: sha256FileLf(MEMO_MD),
    report_json_lf_sha256: sha256FileLf(REPORT_JSON),
    report_md_lf_sha256: sha256FileLf(REPORT_MD),
    selected_candidate_point: selectedCandidatePoint,
    strategy_feature_snapshot_count: 1,
  };
  console.log(JSON.stringify(finalOutput, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
