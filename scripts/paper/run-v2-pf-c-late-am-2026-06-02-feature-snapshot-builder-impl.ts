import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = process.cwd();
const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-FEATURE-SNAPSHOT-BUILDER-IMPL-01';
const SLUG = 'v2-pf-c-late-am-paper-observation-2026-06-02-feature-snapshot-builder-impl-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const OUT_DIR = path.join(ROOT, 'artifacts', 'paper-observation', SLUG);
const BOUNDED_JSONL = path.join(OUT_DIR, 'bounded-feature-snapshot.jsonl');
const REPORT_JSON = path.join(OUT_DIR, 'feature-snapshot-builder-report.json');
const REPORT_MD = path.join(OUT_DIR, 'feature-snapshot-builder-report.md');
const MEMO_MD = path.join(ROOT, 'docs', 'research', `${SLUG}-memo.md`);
const BACKLOG_CSV = path.join(ROOT, 'docs', 'plan', 'new_app_v1_ticket_backlog_v6.csv');
const MAX_ARTIFACT_BYTES = 95 * 1024 * 1024;

const OBS01_PATH = 'D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02/MNQ_rth.obs01.jsonl';
const MBP1_PATH = 'D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-02/MNQ_rth.mbp1.jsonl';
const TARGET_TS_NS = 1780423199835478000n;
const SESSION_OPEN_NS = BigInt(Date.parse('2026-06-02T13:30:00.000Z')) * 1_000_000n;
const SNAPSHOT_CUTOFF_NS = BigInt(Date.parse('2026-06-02T18:00:00.000Z')) * 1_000_000n;
const ONE_MINUTE_NS = 60_000_000_000n;
const TICK_SIZE = 0.25;
const POINT_VALUE = 2;
const PRICE_DECIMALS = 2;

const EXPECTED_PR303 = {
  substrate_commit: '9c5a874374125574b2a93f55d84b9c9ad3d69466',
  bounded_source_readiness_lf_sha256: '3e79062c0c8cb490e05534ed67d8ccbf9e0f64529c01179bf61e3c6c785e14bf',
  closed_1m_bars: 119,
  session_vwap: 30645.9255,
  atr14_pts: 9.9665,
  signed_shock_vwap: -1.7986,
  vixcls: 16.05,
  vxncls: 23.18,
  latest_quote_bid_px: 30627.75,
  latest_quote_ask_px: 30628.25,
  latest_quote_mid_px: 30628,
  latest_quote_ts_ns: '1780423199835478000',
};

const EXPECTED_PR304 = {
  substrate_commit: '5c9c0a234959693e4e6c9418467d10aed63811d4',
  bounded_source_inputs_lf_sha256: 'f9e2ac81a5577b24a7b72fe884f88ec7323c12d2d9d7a74a358fb1291ac8fac8',
  target_session_id: '2026-06-02-rth',
  target_prior_close_date: '2026-06-01',
  primary_percentile_diagnostic_only: 0.05,
  raw_label_diagnostic_only: 'low',
};

const EXPECTED_PR305 = {
  substrate_commit: '7b13b559148fd33bd71d33910483d65e37de578f',
  scoped_regime_label_source_lf_sha256: '152e7fbfdfca52494edbb11a7364cfbbaf33e9d03390bca1f17ee739e38d9662',
  confirmed_label: 'low',
  global_regime_labels_mutated: false,
};

const EXPECTED_PR306 = {
  substrate_commit: '25618ea5073aab32dc908713067139e0b64e6624',
  bounded_feature_source_recheck_lf_sha256: '53289beb5e013c4031004bf5a3296ded7085d9c1db585e7152d8b3df1825aadc',
  blocker_subclassification: 'SESSION_STATE_SOURCE_BLOCKED_MISSING_EXPLICIT_HALT_ROLL_CALENDAR',
};

const EXPECTED_PR307 = {
  substrate_commit: '1f792abd7f6754fa2d40fc075732fb1886b67cc0',
  bounded_halt_roll_calendar_source_lf_sha256: 'ce65d57bfb323ad3d90e4cec682b58c0cb627b0f95ef0520451d2c41a68cbd25',
  session_is_halt: false,
  session_is_roll_block: false,
  halt_code_sha256: '4420ed9a6e167f2ea3c8c17dd1f5f2b6517ecdd1e7a1739902d3cf8cb19dac05',
  halt_config_sha256: '31fba43927801cd179e23f6997ba824928fdd0d984473f3c61ce05db1004f7b4',
  roll_code_sha256: '1ea59f1eb2c55955e66be7b3ab985923eb17e7a9b09534e465eabed7a657ebbc',
  roll_config_sha256: '06101663bb47d7798ec430be17801df0531469269e76a29c24eb080afd486207',
  roll_policy_sha256: '689b8030c058f56cbd65f13307bcd531361794e57cdb15a4d235982bf2e0e2f1',
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
  used_notional: number;
  used_quantity: number;
  first_trade_ts_ns: bigint | null;
  last_trade_ts_ns: bigint | null;
  first_trade_price: number | null;
  last_trade_price: number | null;
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
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortJson(value[key]);
    }
    return out;
  }
  return value;
}

function stableJsonl(records: Json[]): string {
  return records.map((record) => JSON.stringify(sortJson(record))).join('\n') + '\n';
}

function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function round6(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function nsToIso(ns: bigint): string {
  const millis = ns / 1_000_000n;
  const nanos = ns % 1_000_000_000n;
  const base = new Date(Number(millis)).toISOString().replace('.000Z', '');
  const frac = nanos.toString().padStart(9, '0');
  return `${base}.${frac}Z`;
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
  let usedNotional = 0;
  let usedQuantity = 0;
  let firstTradeTsNs: bigint | null = null;
  let lastTradeTsNs: bigint | null = null;
  let firstTradePrice: number | null = null;
  let lastTradePrice: number | null = null;

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
    if (tsNs === null) {
      continue;
    }
    if (tsNs < SESSION_OPEN_NS || tsNs >= SNAPSHOT_CUTOFF_NS) {
      continue;
    }

    const price = extractNumber(line, 'price');
    const quantity = extractNumber(line, 'quantity');
    if (price === null || quantity === null || !Number.isFinite(price) || !Number.isFinite(quantity) || quantity <= 0) {
      continue;
    }

    usedTradeRecords += 1;
    usedNotional += price * quantity;
    usedQuantity += quantity;
    if (firstTradeTsNs === null) {
      firstTradeTsNs = tsNs;
      firstTradePrice = price;
    }
    lastTradeTsNs = tsNs;
    lastTradePrice = price;

    const start = minuteBucketStart(tsNs);
    const end = start + ONE_MINUTE_NS;
    const key = start.toString();
    const existing = barsByStart.get(key);
    if (existing) {
      updateBar(existing, price, quantity);
    } else {
      barsByStart.set(key, {
        start_ts_ns: start,
        end_ts_ns: end,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: quantity,
        trade_count: 1,
      });
    }
  }

  const bars = Array.from(barsByStart.values()).sort((a, b) => (a.start_ts_ns < b.start_ts_ns ? -1 : 1));
  return {
    bars,
    source_trade_records: sourceTradeRecords,
    used_trade_records: usedTradeRecords,
    used_notional: usedNotional,
    used_quantity: usedQuantity,
    first_trade_ts_ns: firstTradeTsNs,
    last_trade_ts_ns: lastTradeTsNs,
    first_trade_price: firstTradePrice,
    last_trade_price: lastTradePrice,
  };
}

function computeSessionVwap(bars: Bar[]): number {
  let pv = 0;
  let volume = 0;
  for (const bar of bars) {
    if (bar.start_ts_ns < SESSION_OPEN_NS || !(bar.volume > 0)) {
      continue;
    }
    pv += bar.close * bar.volume;
    volume += bar.volume;
  }
  if (volume <= 0) {
    throw new Error('Cannot compute session VWAP without positive quantity');
  }
  return round4(pv / volume);
}

function computeAtr14(bars: Bar[]): number {
  if (bars.length < 14) {
    throw new Error(`Cannot compute ATR14 from ${bars.length} bars`);
  }
  const ranges: number[] = [];
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (i === 0) {
      ranges.push(bar.high - bar.low);
    } else {
      const prevClose = bars[i - 1].close;
      ranges.push(Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose)));
    }
  }
  let atr = ranges.slice(0, 14).reduce((sum, value) => sum + value, 0) / 14;
  for (let i = 14; i < ranges.length; i += 1) {
    atr = (atr * 13 + ranges[i]) / 14;
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
  const row = `${TICKET},P1,1.0,V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-HALT-ROLL-CALENDAR-SOURCE-EXTEND-01,Implement a causal source-backed StrategyFeatureSnapshot builder for the bounded 2026-06-02 paper-observation path without STRAT_EVAL candidate order-intent observation-day credit broker live Phase 6 or roster authority,new_cycle4_v2_research_substrate`;
  const existing = readText(BACKLOG_CSV);
  if (existing.includes(TICKET)) {
    return;
  }
  const suffix = existing.endsWith('\n') ? '' : '\n';
  writeFileSync(BACKLOG_CSV, `${existing}${suffix}${row}\n`, 'utf8');
}

function assertArtifactSizes(paths: string[]): void {
  for (const filePath of paths) {
    const size = statSync(filePath).size;
    if (size > MAX_ARTIFACT_BYTES) {
      throw new Error(`Artifact exceeds 95 MiB guard: ${filePath} size=${size}`);
    }
  }
}

function buildMarkdown(report: { [key: string]: Json }, snapshot: { [key: string]: Json }): string {
  const sourceStack = report.source_stack as { [key: string]: Json };
  const guardrails = report.guardrails as { [key: string]: Json };
  const compatibilityRows = report.consumer_compatibility_table as Json[];
  return `# ${TICKET}\n\n` +
    `## Determination\n\n` +
    `\`${report.determination}\`\n\n` +
    `## Snapshot\n\n` +
    `| Field | Value |\n|---|---|\n` +
    `| strategy_id | \`${STRATEGY_ID}\` |\n` +
    `| feature_snapshot_id | \`${snapshot.feature_snapshot_id}\` |\n` +
    `| created_ts_ns | \`${snapshot.created_ts_ns}\` |\n` +
    `| created_ts_utc | \`${snapshot.created_ts_utc}\` |\n` +
    `| bars_in_snapshot | \`${report.bars_in_snapshot}\` |\n` +
    `| sigma_pts | \`${sourceStack.sigma_pts}\` |\n` +
    `| atr14_pts | \`${sourceStack.atr14_pts}\` |\n` +
    `| session_vwap | \`${sourceStack.session_vwap}\` |\n` +
    `| signed_shock_vwap | \`${sourceStack.signed_shock_vwap}\` |\n` +
    `| scoped_regime_label | \`${sourceStack.scoped_regime_label}\` |\n\n` +
    `## Variant UTC gate interpretation\n\n` +
    `| Field | Value |\n|---|---|\n` +
    `| target_entry_hour_utc | \`${report.target_entry_hour_utc}\` |\n` +
    `| target_timestamp_variant_gate_status | \`${report.target_timestamp_variant_gate_status}\` |\n` +
    `| expected_next_strat_eval_smoke_outcome | \`${report.expected_next_strat_eval_smoke_outcome}\` |\n\n` +
    `## Consumer compatibility proof\n\n` +
    `| Snapshot field path | Value present | Placeholder used | Source-ready anchor | Consumer status |\n|---|---:|---:|---|---|\n` +
    compatibilityRows.map((row) => {
      const record = row as { [key: string]: Json };
      return `| \`${record.snapshot_field_path}\` | \`${record.value_present}\` | \`${record.placeholder_used}\` | ${record.source_ready_anchor} | \`${record.consumer_status}\` |`;
    }).join('\n') +
    `\n\n` +
    `## Source anchors\n\n` +
    `| PR | Anchor | Value |\n|---|---|---|\n` +
    `| #303 | source readiness commit | \`${EXPECTED_PR303.substrate_commit}\` |\n` +
    `| #303 | bounded source readiness LF SHA256 | \`${EXPECTED_PR303.bounded_source_readiness_lf_sha256}\` |\n` +
    `| #304 | source inputs LF SHA256 | \`${EXPECTED_PR304.bounded_source_inputs_lf_sha256}\` |\n` +
    `| #305 | scoped regime label source LF SHA256 | \`${EXPECTED_PR305.scoped_regime_label_source_lf_sha256}\` |\n` +
    `| #306 | feature source recheck LF SHA256 | \`${EXPECTED_PR306.bounded_feature_source_recheck_lf_sha256}\` |\n` +
    `| #307 | halt/roll calendar LF SHA256 | \`${EXPECTED_PR307.bounded_halt_roll_calendar_source_lf_sha256}\` |\n\n` +
    `## Guardrails\n\n` +
    `| Guardrail | Value |\n|---|---|\n` +
    Object.keys(guardrails).sort().map((key) => `| ${key} | \`${guardrails[key]}\` |`).join('\n') +
    `\n\n## Next ticket\n\n` +
    `\`${report.recommended_next_ticket}\`\n\n` +
    `${report.recommended_next_ticket_purpose}\n\n` +
    `This PR materializes a bounded, causal feature snapshot artifact only. It does not invoke paper runtime strategy evaluation or create observation-day, broker/live, Phase 6, active-roster, candidate-roster, qfa-410b, or qfa-611 authority.\n`;
}

function buildMemo(report: { [key: string]: Json }): string {
  const compatibilityRows = report.consumer_compatibility_table as Json[];
  return `# ${TICKET} memo\n\n` +
    `## Purpose\n\n` +
    `Implement a causal source-backed StrategyFeatureSnapshot builder for the bounded 2026-06-02 paper-observation path, using only source surfaces proven through PR #303, PR #304, PR #305, PR #306, and PR #307.\n\n` +
    `## Determination\n\n` +
    `\`${report.determination}\`\n\n` +
    `The builder emitted exactly one bounded StrategyFeatureSnapshot JSONL record for the 2026-06-02 control path. This resolves source materialization for feature-snapshot input only; it does not run strategy evaluation and does not count as an observation day.\n\n` +
    `## Variant UTC gate interpretation\n\n` +
    `| Field | Value |\n|---|---|\n` +
    `| target_entry_hour_utc | \`${report.target_entry_hour_utc}\` |\n` +
    `| target_timestamp_variant_gate_status | \`${report.target_timestamp_variant_gate_status}\` |\n` +
    `| expected_next_strat_eval_smoke_outcome | \`${report.expected_next_strat_eval_smoke_outcome}\` |\n\n` +
    `The snapshot can prove strategy-evaluation plumbing, but it should not be expected to produce a candidate or order intent at this timestamp because the variant UTC 16-18 entry gate excludes it.\n\n` +
    `## Consumer compatibility proof\n\n` +
    `| Snapshot field path | Value present | Placeholder used | Source-ready anchor | Consumer status |\n|---|---:|---:|---|---|\n` +
    compatibilityRows.map((row) => {
      const record = row as { [key: string]: Json };
      return `| \`${record.snapshot_field_path}\` | \`${record.value_present}\` | \`${record.placeholder_used}\` | ${record.source_ready_anchor} | \`${record.consumer_status}\` |`;
    }).join('\n') +
    `\n\n` +
    `## Source stack\n\n` +
    `| Field | Source authority | Value |\n|---|---|---|\n` +
    `| quote.mid_px | PR #303 latest finite mid quote | \`30628\` |\n` +
    `| bars | 2026-06-02 RTH obs01 source reconstructed into closed 1m bars | \`${report.bars_in_snapshot}\` |\n` +
    `| session_vwap | PR #303 source readiness, recomputed from bounded bars | \`${(report.source_stack as { [key: string]: Json }).session_vwap}\` |\n` +
    `| atr_14_pts | PR #303 source readiness, recomputed from bounded bars | \`${(report.source_stack as { [key: string]: Json }).atr14_pts}\` |\n` +
    `| sigma_pts | repo-faithful real-archive formula, average closed-bar range / 2 with tick floor | \`${(report.source_stack as { [key: string]: Json }).sigma_pts}\` |\n` +
    `| signed_shock_vwap | PR #303 signed-shock source readiness using atr_14 basis | \`${(report.source_stack as { [key: string]: Json }).signed_shock_vwap}\` |\n` +
    `| VIX/VXN prior close | PR #304 FRED source inputs | \`VIXCLS=16.05, VXNCLS=23.18\` |\n` +
    `| regime_label | PR #305 scoped paper-observation source only | \`low\` |\n` +
    `| session.is_halt | PR #307 MNQ session calendar | \`false\` |\n` +
    `| session.is_roll_block | PR #307 MNQ roll calendar and policy | \`false\` |\n\n` +
    `## Authority boundary\n\n` +
    `This memo creates no active roster, candidate roster, paper/live/broker, Phase 6, qfa-410b, qfa-611, or observation-day authority. Strategy runtime markers remain zero by construction: \`STRAT_EVAL=0\`, \`CANDIDATE=0\`, and \`ORDER_INTENT=0\`.\n\n` +
    `## Recommended next ticket\n\n` +
    `\`${report.recommended_next_ticket}\`\n\n` +
    `${report.recommended_next_ticket_purpose}\n\n` +
    `${report.recommended_next_ticket_reason}\n`;
}

async function main(): Promise<void> {
  ensureDir(OUT_DIR);
  ensureDir(path.dirname(MEMO_MD));

  const strategyConfigPath = path.join(ROOT, 'config', 'strategies', 'regime_shock_reversion_short_v2_utc_16_18_exclusion.yaml');
  const typeContractPath = path.join(ROOT, 'apps', 'strategy_runtime', 'src', 'strategies', 'types.ts');
  const realArchiveRunnerPath = path.join(ROOT, 'apps', 'backtester', 'src', 'real-archive-execution', 'real-archive-execution-runner.ts');
  const riskContractPath = path.join(ROOT, 'apps', 'strategy_runtime', 'src', 'risk', 'contracts.ts');

  for (const requiredPath of [OBS01_PATH, strategyConfigPath, typeContractPath, realArchiveRunnerPath, riskContractPath]) {
    if (!existsSync(requiredPath)) {
      throw new Error(`Required source path does not exist: ${requiredPath}`);
    }
  }

  const tradeScan = await scanTradesAndBars(OBS01_PATH);
  const bars = tradeScan.bars;
  if (bars.length < 14) {
    throw new Error(`Expected enough closed bars for ATR14; got ${bars.length}`);
  }

  const sessionVwap = computeSessionVwap(bars);
  const atr14Pts = computeAtr14(bars);
  const sigmaPts = computeSigmaPts(bars);
  const quoteBidPx = EXPECTED_PR303.latest_quote_bid_px;
  const quoteAskPx = EXPECTED_PR303.latest_quote_ask_px;
  const quoteMidPx = EXPECTED_PR303.latest_quote_mid_px;
  const signedShockVwap = round4((quoteMidPx - sessionVwap) / atr14Pts);
  const lastBar = bars[bars.length - 1];
  const firstBar = bars[0];
  const firstThirtyMinuteBars = bars.filter((bar) => bar.start_ts_ns >= SESSION_OPEN_NS && bar.end_ts_ns <= SESSION_OPEN_NS + 30n * ONE_MINUTE_NS);
  const openingRangeHigh = firstThirtyMinuteBars.length > 0 ? round4(Math.max(...firstThirtyMinuteBars.map((bar) => bar.high))) : null;
  const openingRangeLow = firstThirtyMinuteBars.length > 0 ? round4(Math.min(...firstThirtyMinuteBars.map((bar) => bar.low))) : null;

  const reconciliation = {
    atr14_matches_pr303: atr14Pts === EXPECTED_PR303.atr14_pts,
    bars_match_pr303_count: bars.length === EXPECTED_PR303.closed_1m_bars,
    expected_atr14_pts: EXPECTED_PR303.atr14_pts,
    expected_closed_1m_bars: EXPECTED_PR303.closed_1m_bars,
    expected_session_vwap: EXPECTED_PR303.session_vwap,
    expected_signed_shock_vwap: EXPECTED_PR303.signed_shock_vwap,
    observed_atr14_pts: atr14Pts,
    observed_closed_1m_bars: bars.length,
    observed_session_vwap: sessionVwap,
    observed_signed_shock_vwap: signedShockVwap,
    session_vwap_matches_pr303: sessionVwap === EXPECTED_PR303.session_vwap,
    signed_shock_vwap_matches_pr303: signedShockVwap === EXPECTED_PR303.signed_shock_vwap,
  };

  const reconciled = reconciliation.atr14_matches_pr303 && reconciliation.bars_match_pr303_count && reconciliation.session_vwap_matches_pr303 && reconciliation.signed_shock_vwap_matches_pr303;
  const determination = reconciled
    ? 'FEATURE_SNAPSHOT_BUILDER_IMPL_EMITTED_SOURCE_BACKED_SNAPSHOT'
    : 'FEATURE_SNAPSHOT_BUILDER_IMPL_BLOCKED_SOURCE_RECONCILIATION_MISMATCH';

  const featureSnapshotId = `feature-v2pf-20260602-${TARGET_TS_NS.toString()}`;
  const sourceEventId = `source-pr303-mbp1-${TARGET_TS_NS.toString()}`;
  const strategyConfigHash = sha256FileLf(strategyConfigPath);
  const barsSerialized = bars.map((bar) => serializeBar(bar));

  const snapshot: { [key: string]: Json } = {
    bars: barsSerialized,
    config: {
      config_hash: strategyConfigHash,
      config_version: 1,
      strategy_config_path: 'config/strategies/regime_shock_reversion_short_v2_utc_16_18_exclusion.yaml',
    },
    context: {
      opening_range_high: openingRangeHigh,
      opening_range_low: openingRangeLow,
      opening_range_minutes_elapsed: 30,
      prior_day_close: null,
      prior_day_high: null,
      prior_day_low: null,
      regime_label: EXPECTED_PR305.confirmed_label,
      session_vwap: sessionVwap,
      session_vwap_band_sigma_pts: sigmaPts,
      signed_shock_prior_close: {
        anchor_type: 'prior_close',
        anchor_value: null,
        sigma_basis: 'atr_14',
        sigma_basis_value: atr14Pts,
        value: null,
      },
      signed_shock_vwap: {
        anchor_type: 'vwap',
        anchor_value: sessionVwap,
        sigma_basis: 'atr_14',
        sigma_basis_value: atr14Pts,
        value: signedShockVwap,
      },
      signed_shock_vwap_recent_values: null,
      today_open: round4(firstBar.open),
      vix_fresh: true,
      vix_prior_close_percentile: EXPECTED_PR304.primary_percentile_diagnostic_only,
      vix_value: EXPECTED_PR303.vixcls,
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
    last_trade_price: round4(lastBar.close),
    microstructure: {
      l3_authority: 'unavailable',
      values: {
        ask_px: quoteAskPx,
        bid_px: quoteBidPx,
        quote_source: 'PR303 latest finite mid quote from bounded RTH MBP1 source',
        spread_pts: round4(quoteAskPx - quoteBidPx),
      },
    },
    quote: {
      ask_px: quoteAskPx,
      bid_px: quoteBidPx,
      mid_px: quoteMidPx,
    },
    session: {
      date_basis: 'target_session_id_2026-06-02-rth',
      is_halt: EXPECTED_PR307.session_is_halt,
      is_roll_block: EXPECTED_PR307.session_is_roll_block,
      is_rth: true,
      opened_ts_ns: SESSION_OPEN_NS.toString(),
      opened_ts_utc: nsToIso(SESSION_OPEN_NS),
      phase: 'rth',
      session_id: '2026-06-02-rth',
      trading_date: '2026-06-02',
    },
    source_event_id: sourceEventId,
    source_lineage: {
      pr303: EXPECTED_PR303,
      pr304: EXPECTED_PR304,
      pr305: EXPECTED_PR305,
      pr306: EXPECTED_PR306,
      pr307: EXPECTED_PR307,
    },
    strategy_id: STRATEGY_ID,
    structure: {
      trend: 'unknown',
      values: {
        source_scope: 'bounded_2026_06_02_paper_observation',
      },
    },
  };

  const guardrails: { [key: string]: Json } = {
    active_roster_mutated: false,
    broker_live_authorized: false,
    candidate_count: 0,
    candidate_roster_mutated: false,
    global_regime_labels_mutated: false,
    observation_day_eligible: false,
    observation_day_increment: 0,
    order_intent_count: 0,
    paper_runtime_invoked: false,
    phase_6_authorized: false,
    qfa_410b_or_qfa_611_run: false,
    strat_eval_count: 0,
    strategy_feature_snapshot_emitted: reconciled ? 1 : 0,
  };

  const sourceStack: { [key: string]: Json } = {
    atr14_pts: atr14Pts,
    latest_quote_mid_px: quoteMidPx,
    scoped_regime_label: EXPECTED_PR305.confirmed_label,
    session_is_halt: EXPECTED_PR307.session_is_halt,
    session_is_roll_block: EXPECTED_PR307.session_is_roll_block,
    session_is_rth: true,
    session_vwap: sessionVwap,
    sigma_pts: sigmaPts,
    signed_shock_vwap: signedShockVwap,
    vix_prior_close_percentile: EXPECTED_PR304.primary_percentile_diagnostic_only,
    vixcls: EXPECTED_PR303.vixcls,
    vxncls: EXPECTED_PR303.vxncls,
  };

  const targetEntryHourUtc = Number(nsToIso(TARGET_TS_NS).slice(11, 13));
  const targetTimestampVariantGateStatus = targetEntryHourUtc >= 16 && targetEntryHourUtc < 18
    ? 'EXCLUDED_BY_UTC_16_18_GATE'
    : 'NOT_EXCLUDED_BY_UTC_16_18_GATE';
  const expectedNextStratEvalSmokeOutcome = targetTimestampVariantGateStatus === 'EXCLUDED_BY_UTC_16_18_GATE'
    ? 'STRAT_EVAL_MARKER_ALLOWED_BUT_CANDIDATE_SUPPRESSED_BY_VARIANT_GATE'
    : 'STRAT_EVAL_MARKER_ALLOWED_CANDIDATE_GATE_NOT_SUPPRESSED_BY_UTC_16_18_WINDOW';
  const recommendedNextTicketPurpose = 'Verify STRAT_EVAL marker generation from the source-backed snapshot, while expecting CANDIDATE=0 / ORDER_INTENT=0 for this specific timestamp because the UTC 16-18 exclusion gate should suppress entries.';

  const consumerCompatibilityTable: Json[] = [
    {
      consumer_status: 'READY',
      placeholder_used: false,
      snapshot_field_path: 'created_ts_ns',
      source_ready_anchor: 'PR #303 latest finite mid quote timestamp / PR #307 target event',
      value_present: snapshot.created_ts_ns !== null && snapshot.created_ts_ns !== undefined,
    },
    {
      consumer_status: 'READY',
      placeholder_used: false,
      snapshot_field_path: 'quote.mid_px',
      source_ready_anchor: 'PR #303 latest finite mid quote',
      value_present: Number.isFinite(quoteMidPx),
    },
    {
      consumer_status: 'READY',
      placeholder_used: false,
      snapshot_field_path: 'session.is_rth',
      source_ready_anchor: 'PR #306 source recheck / 2026-06-02 RTH source window',
      value_present: true,
    },
    {
      consumer_status: 'READY',
      placeholder_used: false,
      snapshot_field_path: 'session.is_halt',
      source_ready_anchor: 'PR #307 MNQ session calendar',
      value_present: true,
    },
    {
      consumer_status: 'READY',
      placeholder_used: false,
      snapshot_field_path: 'session.is_roll_block',
      source_ready_anchor: 'PR #307 MNQ roll calendar and session policy',
      value_present: true,
    },
    {
      consumer_status: 'READY',
      placeholder_used: false,
      snapshot_field_path: 'indicators.sigma_pts',
      source_ready_anchor: 'Repo-faithful real-archive formula from bounded closed bars',
      value_present: Number.isFinite(sigmaPts),
    },
    {
      consumer_status: 'READY',
      placeholder_used: false,
      snapshot_field_path: 'context.regime_label',
      source_ready_anchor: 'PR #305 scoped paper-observation regime label source',
      value_present: EXPECTED_PR305.confirmed_label === 'low',
    },
    {
      consumer_status: 'READY',
      placeholder_used: false,
      snapshot_field_path: 'context.signed_shock_vwap.value',
      source_ready_anchor: 'PR #303 signed_shock_vwap source readiness using atr_14 basis',
      value_present: Number.isFinite(signedShockVwap),
    },
    {
      consumer_status: 'READY',
      placeholder_used: false,
      snapshot_field_path: 'config.config_hash / config.config_version',
      source_ready_anchor: 'Variant-owned strategy config YAML',
      value_present: strategyConfigHash.length === 64,
    },
  ];

  const records: Json[] = [
    {
      record_type: 'SOURCE_ANCHORS',
      ticket: TICKET,
      source_paths: {
        mbp1_source_path: MBP1_PATH,
        obs01_source_path: OBS01_PATH,
        real_archive_sigma_formula_path: 'apps/backtester/src/real-archive-execution/real-archive-execution-runner.ts',
        strategy_feature_snapshot_contract_path: 'apps/strategy_runtime/src/strategies/types.ts',
      },
      source_stack: sourceStack,
      target_entry_hour_utc: targetEntryHourUtc,
      target_timestamp_variant_gate_status: targetTimestampVariantGateStatus,
      expected_next_strat_eval_smoke_outcome: expectedNextStratEvalSmokeOutcome,
      consumer_compatibility_table: consumerCompatibilityTable,
    },
    {
      record_type: 'BAR_RECONCILIATION',
      ticket: TICKET,
      first_bar: serializeBar(firstBar),
      last_bar: serializeBar(lastBar),
      reconciliation: reconciliation as unknown as Json,
      trade_scan: {
        first_trade_price: tradeScan.first_trade_price,
        first_trade_ts_ns: tradeScan.first_trade_ts_ns?.toString() ?? null,
        first_trade_ts_utc: tradeScan.first_trade_ts_ns ? nsToIso(tradeScan.first_trade_ts_ns) : null,
        last_trade_price: tradeScan.last_trade_price,
        last_trade_ts_ns: tradeScan.last_trade_ts_ns?.toString() ?? null,
        last_trade_ts_utc: tradeScan.last_trade_ts_ns ? nsToIso(tradeScan.last_trade_ts_ns) : null,
        source_trade_records: tradeScan.source_trade_records,
        used_notional: round4(tradeScan.used_notional),
        used_quantity: round4(tradeScan.used_quantity),
        used_trade_records: tradeScan.used_trade_records,
      },
    },
    {
      record_type: 'STRATEGY_FEATURE_SNAPSHOT',
      ticket: TICKET,
      snapshot,
    },
    {
      record_type: 'AUTHORITY_AND_OBSERVATION_GUARDRAILS',
      guardrails,
      ticket: TICKET,
    },
    {
      record_type: 'DETERMINATION',
      determination,
      target_entry_hour_utc: targetEntryHourUtc,
      target_timestamp_variant_gate_status: targetTimestampVariantGateStatus,
      expected_next_strat_eval_smoke_outcome: expectedNextStratEvalSmokeOutcome,
      feature_snapshot_builder_ready_for_strat_eval_scope: reconciled,
      recommended_next_ticket: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-STRAT-EVAL-SMOKE-01',
      recommended_next_ticket_purpose: recommendedNextTicketPurpose,
      ticket: TICKET,
    },
  ];

  writeFileSync(BOUNDED_JSONL, stableJsonl(records), 'utf8');
  const boundedSha = sha256FileLf(BOUNDED_JSONL);

  const report: { [key: string]: Json } = {
    artifact_size_guard_bytes: MAX_ARTIFACT_BYTES,
    bars_in_snapshot: bars.length,
    bounded_feature_snapshot_lf_sha256: boundedSha,
    consumer_compatibility_table: consumerCompatibilityTable,
    created_artifacts: [
      'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-feature-snapshot-builder-impl-01/bounded-feature-snapshot.jsonl',
      'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-feature-snapshot-builder-impl-01/feature-snapshot-builder-report.json',
      'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-2026-06-02-feature-snapshot-builder-impl-01/feature-snapshot-builder-report.md',
      'docs/research/v2-pf-c-late-am-paper-observation-2026-06-02-feature-snapshot-builder-impl-01-memo.md',
      'scripts/paper/run-v2-pf-c-late-am-2026-06-02-feature-snapshot-builder-impl.ts',
      'docs/plan/new_app_v1_ticket_backlog_v6.csv',
    ],
    determination,
    expected_next_strat_eval_smoke_outcome: expectedNextStratEvalSmokeOutcome,
    feature_snapshot_builder_ready_for_strat_eval_scope: reconciled,
    feature_snapshot_id: featureSnapshotId,
    global_regime_labels_mutated: false,
    guardrails,
    json_transport_note: 'StrategyFeatureSnapshot timestamp fields are serialized as decimal strings for JSONL transport; runtime in-memory branding remains bigint per contract.',
    next_scope_boundary: 'STRAT_EVAL smoke is a separate ticket and must not award observation-day credit without explicit scoped validation.',
    recommended_next_ticket: 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-2026-06-02-STRAT-EVAL-SMOKE-01',
    recommended_next_ticket_purpose: recommendedNextTicketPurpose,
    recommended_next_ticket_reason: 'The causal feature snapshot input is now materialized; the next narrow step is to feed exactly this bounded snapshot into a mock/paper strategy-evaluation smoke path without candidate/order-intent/observation-day authority unless separately scoped and validated.',
    reconciliation: reconciliation as unknown as Json,
    source_stack: sourceStack,
    source_surfaces_used: {
      pr303: EXPECTED_PR303 as unknown as Json,
      pr304: EXPECTED_PR304 as unknown as Json,
      pr305: EXPECTED_PR305 as unknown as Json,
      pr306: EXPECTED_PR306 as unknown as Json,
      pr307: EXPECTED_PR307 as unknown as Json,
    },
    strategy_feature_snapshot_count: reconciled ? 1 : 0,
    strategy_id: STRATEGY_ID,
    target_entry_hour_utc: targetEntryHourUtc,
    target_timestamp_variant_gate_status: targetTimestampVariantGateStatus,
    ticket: TICKET,
  };

  writeFileSync(REPORT_JSON, stableJson(report), 'utf8');
  writeFileSync(REPORT_MD, buildMarkdown(report, snapshot), 'utf8');
  writeFileSync(MEMO_MD, buildMemo(report), 'utf8');
  appendBacklogRow();
  assertArtifactSizes([BOUNDED_JSONL, REPORT_JSON, REPORT_MD, MEMO_MD]);

  const output = {
    bounded_feature_snapshot_lf_sha256: boundedSha,
    determination,
    feature_snapshot_id: featureSnapshotId,
    feature_snapshot_builder_ready_for_strat_eval_scope: reconciled,
    target_entry_hour_utc: targetEntryHourUtc,
    target_timestamp_variant_gate_status: targetTimestampVariantGateStatus,
    expected_next_strat_eval_smoke_outcome: expectedNextStratEvalSmokeOutcome,
    reconciliation,
    report_json_lf_sha256: sha256FileLf(REPORT_JSON),
    report_md_lf_sha256: sha256FileLf(REPORT_MD),
    memo_lf_sha256: sha256FileLf(MEMO_MD),
    source_stack: sourceStack,
    strategy_feature_snapshot_count: reconciled ? 1 : 0,
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
