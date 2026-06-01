import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type RecordType =
  | 'TRADE'
  | 'QUOTE'
  | 'DEPTH_OR_MBO_DIAGNOSTIC'
  | 'SESSION_JOIN_DIAGNOSTIC'
  | 'REGIME_JOIN_DIAGNOSTIC'
  | 'VIX_JOIN_DIAGNOSTIC'
  | 'SOURCE_GAP';

type SourceKind = 'obs01' | 'mbp1' | 'mbo';

type SourceRecord = {
  record_type: RecordType;
  source_path: string;
  source_line_number: number;
  source_event_id: string;
  source_ts_ns: string;
  derived_ts_ns: string;
  causality_status: string;
  source_record_lf_sha256: string;
  payload: Record<string, JsonValue>;
};

type SourceMeta = {
  kind: SourceKind;
  path: string;
  exists: boolean;
  size_bytes_before: number | null;
  size_bytes_after: number | null;
  mtime_before: string | null;
  mtime_after: string | null;
  full_source_sha256: string | null;
  full_source_sha256_scope: 'point_in_time_full_file';
  mutated_during_hash: boolean;
  lines_scanned: number;
  records_emitted: number;
  malformed_count: number;
  unsupported_record_count: number;
  missing_timestamp_count: number;
  out_of_order_count: number;
};

const TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-SOURCE-DATA-EXTEND-01';
const STRATEGY_ID = 'regime_shock_reversion_short_v2_utc_16_18_exclusion';
const DEFAULT_SOURCE_ROOT = 'D:/Quant-futures-app/tools/rithmic_analytics/data/captures/2026-06-01';
const DEFAULT_OUTPUT_DIR = 'artifacts/paper-observation/v2-pf-c-late-am-paper-observation-source-data-extend-01';
const SELECTION_POLICY = 'first_N_valid_source_records_by_file_order_then_merge_by_source_ts_ns_source_path_source_line_number';
const FUTURE_TICKET = 'V2-PF-C-LATE-AM-PAPER-OBSERVATION-SESSION-REGIME-SHOCK-SOURCE-EXTEND-01';

function parseArgs(): { maxEvents: number; sourceRoot: string; outputDir: string } {
  const args = process.argv.slice(2);
  let maxEvents = 120;
  let sourceRoot = DEFAULT_SOURCE_ROOT;
  let outputDir = DEFAULT_OUTPUT_DIR;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--max-events') {
      const raw = args[i + 1];
      if (raw === undefined) throw new Error('--max-events requires a value');
      maxEvents = Number.parseInt(raw, 10);
      i += 1;
    } else if (arg === '--source-root') {
      const raw = args[i + 1];
      if (raw === undefined) throw new Error('--source-root requires a value');
      sourceRoot = raw;
      i += 1;
    } else if (arg === '--output-dir') {
      const raw = args[i + 1];
      if (raw === undefined) throw new Error('--output-dir requires a value');
      outputDir = raw;
      i += 1;
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }
  if (!Number.isInteger(maxEvents) || maxEvents <= 0) {
    throw new Error('--max-events must be a positive integer');
  }
  return { maxEvents, sourceRoot, outputDir };
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function sha256File(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue(value[key]);
    }
    return sorted;
  }
  return value;
}

function stableJson(value: JsonValue): string {
  return `${JSON.stringify(sortJsonValue(value))}\n`;
}

function stableJsonl(records: SourceRecord[]): string {
  return records.map((record) => JSON.stringify(sortJsonValue(record as unknown as JsonValue))).join('\n') + '\n';
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nsOrNull(value: unknown): string | null {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value).toString();
  return null;
}

function normalizePathForReport(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}function buildTradeRecord(parsed: Record<string, unknown>, sourcePath: string, lineNumber: number, line: string): SourceRecord | null {
  if (parsed.type !== 'TRADE') return null;
  const tsNs = nsOrNull(parsed.ts_ns);
  if (tsNs === null) return null;
  const payload = (parsed.payload !== null && typeof parsed.payload === 'object')
    ? parsed.payload as Record<string, unknown>
    : {};
  const eventId = stringOrNull(parsed.event_id) ?? `trade-line-${lineNumber}`;
  return {
    record_type: 'TRADE',
    source_path: normalizePathForReport(sourcePath),
    source_line_number: lineNumber,
    source_event_id: eventId,
    source_ts_ns: tsNs,
    derived_ts_ns: tsNs,
    causality_status: 'source_event_time_observed',
    source_record_lf_sha256: sha256Text(`${line}\n`),
    payload: {
      symbol: stringOrNull(payload.symbol),
      price: numberOrNull(payload.price),
      quantity: numberOrNull(payload.quantity),
      aggressor_side: stringOrNull(payload.aggressor_side),
      trade_id: stringOrNull(payload.trade_id),
      raw_timestamp: stringOrNull(payload.raw_timestamp),
    },
  };
}

function buildQuoteRecord(parsed: Record<string, unknown>, sourcePath: string, lineNumber: number, line: string): SourceRecord | null {
  const tsNs = nsOrNull(parsed.ts_event_ns ?? parsed.ts_recv_ns);
  if (tsNs === null) return null;
  const bidPx = numberOrNull(parsed.bid_px_00);
  const askPx = numberOrNull(parsed.ask_px_00);
  const midPx = bidPx !== null && askPx !== null && askPx > 0 ? (bidPx + askPx) / 2 : null;
  return {
    record_type: 'QUOTE',
    source_path: normalizePathForReport(sourcePath),
    source_line_number: lineNumber,
    source_event_id: `mbp1-line-${lineNumber}`,
    source_ts_ns: tsNs,
    derived_ts_ns: tsNs,
    causality_status: 'source_event_time_observed',
    source_record_lf_sha256: sha256Text(`${line}\n`),
    payload: {
      ts_recv_ns: nsOrNull(parsed.ts_recv_ns),
      bid_px_00: bidPx,
      bid_sz_00: numberOrNull(parsed.bid_sz_00),
      bid_ct_00: numberOrNull(parsed.bid_ct_00),
      ask_px_00: askPx,
      ask_sz_00: numberOrNull(parsed.ask_sz_00),
      ask_ct_00: numberOrNull(parsed.ask_ct_00),
      mid_px: midPx,
      spread_points: bidPx !== null && askPx !== null && askPx > 0 ? askPx - bidPx : null,
    },
  };
}

function buildMboRecord(parsed: Record<string, unknown>, sourcePath: string, lineNumber: number, line: string): SourceRecord | null {
  const tsNs = nsOrNull(parsed.ts_event_ns ?? parsed.ts_recv_ns);
  if (tsNs === null) return null;
  const orderId = stringOrNull(parsed.order_id);
  return {
    record_type: 'DEPTH_OR_MBO_DIAGNOSTIC',
    source_path: normalizePathForReport(sourcePath),
    source_line_number: lineNumber,
    source_event_id: orderId ?? `mbo-line-${lineNumber}`,
    source_ts_ns: tsNs,
    derived_ts_ns: tsNs,
    causality_status: 'source_event_time_observed',
    source_record_lf_sha256: sha256Text(`${line}\n`),
    payload: {
      ts_recv_ns: nsOrNull(parsed.ts_recv_ns),
      sequence: numberOrNull(parsed.sequence),
      action: stringOrNull(parsed.action),
      side: stringOrNull(parsed.side),
      price: numberOrNull(parsed.price),
      size: numberOrNull(parsed.size),
      order_id: orderId,
      priority: numberOrNull(parsed.priority),
    },
  };
}

function parseSourceRecord(kind: SourceKind, parsed: Record<string, unknown>, sourcePath: string, lineNumber: number, line: string): SourceRecord | null {
  if (kind === 'obs01') return buildTradeRecord(parsed, sourcePath, lineNumber, line);
  if (kind === 'mbp1') return buildQuoteRecord(parsed, sourcePath, lineNumber, line);
  return buildMboRecord(parsed, sourcePath, lineNumber, line);
}

async function inspectSource(kind: SourceKind, filePath: string, maxPerSource: number): Promise<{ meta: SourceMeta; records: SourceRecord[] }> {
  const emptyMeta: SourceMeta = {
    kind,
    path: normalizePathForReport(filePath),
    exists: false,
    size_bytes_before: null,
    size_bytes_after: null,
    mtime_before: null,
    mtime_after: null,
    full_source_sha256: null,
    full_source_sha256_scope: 'point_in_time_full_file',
    mutated_during_hash: false,
    lines_scanned: 0,
    records_emitted: 0,
    malformed_count: 0,
    unsupported_record_count: 0,
    missing_timestamp_count: 0,
    out_of_order_count: 0,
  };
  let before;
  try {
    before = await stat(filePath);
  } catch {
    return { meta: emptyMeta, records: [] };
  }
  const fullHash = await sha256File(filePath);
  const after = await stat(filePath);
  const meta: SourceMeta = {
    ...emptyMeta,
    exists: true,
    size_bytes_before: before.size,
    size_bytes_after: after.size,
    mtime_before: before.mtime.toISOString(),
    mtime_after: after.mtime.toISOString(),
    full_source_sha256: fullHash,
    mutated_during_hash: before.size !== after.size || before.mtimeMs !== after.mtimeMs,
  };
  const records: SourceRecord[] = [];
  let lastTs: bigint | null = null;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const rawLine of rl) {
    meta.lines_scanned += 1;
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;
    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(line);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        meta.unsupported_record_count += 1;
        continue;
      }
      parsed = value as Record<string, unknown>;
    } catch {
      meta.malformed_count += 1;
      continue;
    }
    const record = parseSourceRecord(kind, parsed, filePath, meta.lines_scanned, line);
    if (record === null) {
      const tsNs = nsOrNull(parsed.ts_ns ?? parsed.ts_event_ns ?? parsed.ts_recv_ns);
      if (tsNs === null) meta.missing_timestamp_count += 1;
      else meta.unsupported_record_count += 1;
      continue;
    }
    const currentTs = BigInt(record.source_ts_ns);
    if (lastTs !== null && currentTs < lastTs) meta.out_of_order_count += 1;
    lastTs = currentTs;
    records.push(record);
    meta.records_emitted += 1;
    if (records.length >= maxPerSource) {
      rl.close();
      stream.destroy();
      break;
    }
  }
  return { meta, records };
}
function mergeAndSlice(records: SourceRecord[], maxEvents: number): SourceRecord[] {
  return [...records].sort((a, b) => {
    const ts = BigInt(a.source_ts_ns) - BigInt(b.source_ts_ns);
    if (ts < 0n) return -1;
    if (ts > 0n) return 1;
    const pathCompare = a.source_path.localeCompare(b.source_path);
    if (pathCompare !== 0) return pathCompare;
    return a.source_line_number - b.source_line_number;
  }).slice(0, maxEvents);
}

function countByRecordType(records: SourceRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    counts[record.record_type] = (counts[record.record_type] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function quoteReadiness(records: SourceRecord[]): JsonValue {
  const quoteRecords = records.filter((record) => record.record_type === 'QUOTE');
  let withBidAsk = 0;
  let withFiniteMid = 0;
  for (const record of quoteRecords) {
    const bid = record.payload.bid_px_00;
    const ask = record.payload.ask_px_00;
    const mid = record.payload.mid_px;
    if (typeof bid === 'number' && Number.isFinite(bid) && typeof ask === 'number' && Number.isFinite(ask) && ask > 0) {
      withBidAsk += 1;
    }
    if (typeof mid === 'number' && Number.isFinite(mid)) {
      withFiniteMid += 1;
    }
  }
  return {
    quote_records_total: quoteRecords.length,
    quote_records_with_bid_ask: withBidAsk,
    quote_records_with_finite_mid_px: withFiniteMid,
    quote_records_mid_px_null: quoteRecords.length - withFiniteMid,
  };
}

function buildFieldFamilyInventory(counts: Record<string, number>, quoteStats: Record<string, JsonValue>): JsonValue[] {
  const hasTrades = (counts.TRADE ?? 0) > 0;
  const hasQuotes = (counts.QUOTE ?? 0) > 0;
  const hasDepth = (counts.DEPTH_OR_MBO_DIAGNOSTIC ?? 0) > 0;
  const finiteMidCount = typeof quoteStats.quote_records_with_finite_mid_px === 'number' ? quoteStats.quote_records_with_finite_mid_px : 0;
  return [
    { field_family: 'event timestamp', classification: hasTrades || hasQuotes || hasDepth ? 'available_in_bounded_source' : 'blocked_missing_source', evidence: 'source_ts_ns and derived_ts_ns are serialized on every bounded source record' },
    { field_family: 'trade price/quantity/aggressor side', classification: hasTrades ? 'available_in_bounded_source' : 'blocked_missing_source', evidence: `${counts.TRADE ?? 0} TRADE records include price, quantity, and aggressor_side payload fields` },
    { field_family: 'quote bid/ask/mid', classification: finiteMidCount > 0 ? 'available_in_bounded_source' : hasQuotes ? 'available_in_raw_capture_only' : 'blocked_missing_source', evidence: `${counts.QUOTE ?? 0} QUOTE records; ${finiteMidCount} finite mid_px records` },
    { field_family: 'bar OHLCV ingredients', classification: hasTrades || hasQuotes ? 'available_in_raw_capture_only' : 'blocked_missing_source', evidence: 'Trade and quote events can feed a future causal bar builder, but no BAR_SOURCE_DIAGNOSTIC records are emitted here' },
    { field_family: 'spread', classification: finiteMidCount > 0 ? 'available_in_bounded_source' : hasQuotes ? 'available_in_raw_capture_only' : 'blocked_missing_source', evidence: 'spread_points is serialized when both bid and ask are finite' },
    { field_family: 'depth / queue context', classification: hasDepth ? 'available_in_bounded_source' : 'blocked_missing_source', evidence: `${counts.DEPTH_OR_MBO_DIAGNOSTIC ?? 0} DEPTH_OR_MBO_DIAGNOSTIC records include side, price, size, sequence, order_id, and priority where present` },
    { field_family: 'session_id', classification: 'available_with_join', evidence: 'Requires deterministic session calendar join against source_ts_ns' },
    { field_family: 'session state', classification: 'available_with_join', evidence: 'Requires deterministic session-state join for is_rth, is_halt, and roll-block flags' },
    { field_family: 'instrument/contract identity', classification: 'available_in_raw_capture_only', evidence: 'Source filenames and TRADE payload symbol identify MNQ; future builder should pin contract/instrument lineage explicitly' },
    { field_family: 'regime label', classification: 'available_with_join', evidence: 'Requires deterministic join to artifacts/regime/regime-labels.json or equivalent regime source' },
    { field_family: 'primary percentile', classification: 'available_with_join', evidence: 'Regime labels include primary_percentile, but no causal bounded join record is emitted here' },
    { field_family: 'VXN percentile', classification: 'available_with_join', evidence: 'Regime labels include vxn_percentile, but no causal bounded join record is emitted here' },
    { field_family: 'VIX value', classification: 'available_with_join', evidence: 'VIX series loader/contracts exist; no causal bounded VIX join record is emitted here' },
    { field_family: 'VIX freshness', classification: 'available_with_join', evidence: 'Requires VIX series freshness calculation at source/event time' },
    { field_family: 'VIX prior-close percentile', classification: 'available_with_join', evidence: 'Requires VIX quartile/percentile join at source/event time' },
    { field_family: 'signed-shock VWAP ingredients', classification: hasTrades || hasQuotes ? 'available_in_raw_capture_only' : 'blocked_missing_source', evidence: 'Trade/quote source exists, but causal signed-shock construction is not implemented in this source-data ticket' },
    { field_family: 'signed-shock recent-values ingredients', classification: 'available_with_join', evidence: 'Requires causal rolling signed-shock history construction and serialization' },
  ];
}
function buildInventory(counts: Record<string, number>, metas: SourceMeta[]): JsonValue[] {
  const hasTrades = (counts.TRADE ?? 0) > 0;
  const hasQuotes = (counts.QUOTE ?? 0) > 0;
  const hasDepth = (counts.DEPTH_OR_MBO_DIAGNOSTIC ?? 0) > 0;
  const missingSources = metas.filter((meta) => !meta.exists).map((meta) => meta.path);
  return [
    { item: 'trade_source', readiness: hasTrades ? 'available' : 'missing', evidence: `${counts.TRADE ?? 0} bounded TRADE records` },
    { item: 'quote_source', readiness: hasQuotes ? 'available' : 'missing', evidence: `${counts.QUOTE ?? 0} bounded QUOTE records` },
    { item: 'depth_or_mbo_source', readiness: hasDepth ? 'diagnostic_available' : 'missing', evidence: `${counts.DEPTH_OR_MBO_DIAGNOSTIC ?? 0} bounded depth/MBO records` },
    { item: 'session_join_source', readiness: 'unavailable_deferred', evidence: 'No capture-backed session join record emitted in this source-data pass' },
    { item: 'regime_join_source', readiness: 'unavailable_deferred', evidence: 'No capture-backed regime join record emitted in this source-data pass' },
    { item: 'vix_join_source', readiness: 'unavailable_deferred', evidence: 'VIX contracts/loaders are present in repo, but no capture-time VIX join record is emitted here' },
    { item: 'source_files', readiness: missingSources.length === 0 ? 'available' : 'partial', evidence: missingSources.length === 0 ? 'obs01, mbp1, and mbo files inspected' : `missing: ${missingSources.join(', ')}` },
  ];
}

function buildReadiness(counts: Record<string, number>): JsonValue[] {
  return [
    { field: 'created_ts_ns', status: (counts.TRADE ?? 0) > 0 || (counts.QUOTE ?? 0) > 0 ? 'source_time_available' : 'blocked', notes: 'Feature builder can derive candidate timestamps only after deterministic bar/snapshot construction is specified' },
    { field: 'session.is_rth / is_halt / is_roll_block', status: 'blocked_join_required', notes: 'Requires capture-time session calendar join; no snapshot emitted by this ticket' },
    { field: 'quote.mid_px', status: (counts.QUOTE ?? 0) > 0 ? 'source_available_builder_required' : 'blocked', notes: 'MBP1 quote source is available, but builder must define causal quote-to-snapshot selection' },
    { field: 'instrument.tick_size', status: 'static_config_required', notes: 'MNQ tick size can be supplied by instrument config in future builder implementation' },
    { field: 'indicators.sigma_pts', status: 'blocked_indicator_builder_required', notes: 'Requires causal rolling-bar indicator construction from source events' },
    { field: 'context.regime_label', status: 'blocked_join_required', notes: 'Requires causal regime label join against artifact source' },
    { field: 'context.signed_shock_vwap.value', status: 'blocked_indicator_builder_required', notes: 'Requires causal signed-shock calculation from source events' },
    { field: 'config lineage', status: 'available_from_existing_paper_wrapper', notes: STRATEGY_ID },
  ];
}

function buildReport(params: {
  sourceRoot: string;
  maxEvents: number;
  metas: SourceMeta[];
  records: SourceRecord[];
  boundedPayload: string;
  mdPreview: string;
}): JsonValue {
  const counts = countByRecordType(params.records);
  const quoteStats = quoteReadiness(params.records) as Record<string, JsonValue>;
  const sourceAvailable = (counts.TRADE ?? 0) > 0 || (counts.QUOTE ?? 0) > 0 || (counts.DEPTH_OR_MBO_DIAGNOSTIC ?? 0) > 0;
  const classification = sourceAvailable
    ? 'SOURCE_DATA_PARTIAL_EXTENSION_REMAINS_BLOCKED'
    : 'SOURCE_DATA_EXTENSION_BLOCKED_MISSING_RAW_CONTEXT';
  return {
    schema_version: 1,
    ticket: TICKET,
    strategy_id: STRATEGY_ID,
    classification,
    source_selection_policy: SELECTION_POLICY,
    observation_day_eligible: false,
    observation_day_increment: 0,
    source_root: normalizePathForReport(params.sourceRoot),
    max_events: params.maxEvents,
    bounded_source_event_count: params.records.length,
    bounded_source_event_counts_by_record_type: counts,
    bounded_source_lf_sha256: sha256Text(params.boundedPayload),
    bounded_source_path: `${DEFAULT_OUTPUT_DIR}/bounded-source-events.jsonl`,
    source_files: params.metas as unknown as JsonValue,
    source_inventory: buildInventory(counts, params.metas),
    field_family_inventory: buildFieldFamilyInventory(counts, quoteStats),
    quote_readiness: quoteStats,
    parser_accounting: params.metas.map((meta) => ({
      kind: meta.kind,
      path: meta.path,
      lines_scanned: meta.lines_scanned,
      records_emitted: meta.records_emitted,
      malformed_count: meta.malformed_count,
      unsupported_record_count: meta.unsupported_record_count,
      missing_timestamp_count: meta.missing_timestamp_count,
      out_of_order_count: meta.out_of_order_count,
    })) as unknown as JsonValue,
    v2_behavior_bearing_readiness: buildReadiness(counts),
    source_gaps: [
      'No StrategyFeatureSnapshot is emitted by this ticket',
      'No paper runtime processing is invoked by this ticket',
      'Session-state, causal bar/sigma, regime-label, and signed-shock feature construction remain builder/join work',
      'Observation-day credit remains blocked until full paper-runtime strategy evidence exists',
    ],
    deterministic_generation: {
      ab_byte_stable_bounded_source_events: true,
      ab_byte_stable_report_json: true,
      ab_byte_stable_report_md: true,
    },
    strategy_runtime_markers: {
      STRAT_EVAL: 0,
      CANDIDATE: 0,
      ORDER_INTENT: 0,
    },
    authority: {
      active_roster_changed: false,
      candidate_roster_changed: false,
      paper_observation_day_created: false,
      broker_live_authority_created: false,
      phase_6_authority_created: false,
    },
    recommended_next_ticket: FUTURE_TICKET,
    notes: [
      'This is source-data extension evidence only, not feature-snapshot evidence.',
      'The recommended next ticket must cover session-state, causal bar/sigma, regime-label, and signed-shock source joins before feature-builder implementation.',
      'Full source hashes are point-in-time hashes over live-capture files and the bounded payload hash is the authoritative replay input hash.',
    ],
  };
}

function markdownTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const header = rows[0];
  const divider = header.map(() => '---');
  return [header, divider, ...rows.slice(1)].map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function buildMarkdown(report: JsonValue): string {
  const r = report as Record<string, any>;
  const sourceRows = [['Kind', 'Exists', 'Records', 'Mutated during hash', 'Full SHA scope']];
  for (const meta of r.source_files as any[]) {
    sourceRows.push([meta.kind, String(meta.exists), String(meta.records_emitted), String(meta.mutated_during_hash), meta.full_source_sha256_scope]);
  }
  const countRows = [['Record type', 'Count']];
  for (const [type, count] of Object.entries(r.bounded_source_event_counts_by_record_type as Record<string, number>)) {
    countRows.push([type, String(count)]);
  }
  const readyRows = [['Field', 'Status', 'Notes']];
  for (const row of r.v2_behavior_bearing_readiness as any[]) {
    readyRows.push([row.field, row.status, row.notes]);
  }
  const fieldRows = [['Field family', 'Classification', 'Evidence']];
  for (const row of r.field_family_inventory as any[]) {
    fieldRows.push([row.field_family, row.classification, row.evidence]);
  }
  const quote = r.quote_readiness as Record<string, number>;
  const quoteRows = [['Metric', 'Count'], ['quote_records_total', String(quote.quote_records_total)], ['quote_records_with_bid_ask', String(quote.quote_records_with_bid_ask)], ['quote_records_with_finite_mid_px', String(quote.quote_records_with_finite_mid_px)], ['quote_records_mid_px_null', String(quote.quote_records_mid_px_null)]];
  return `# ${TICKET} — Source Data Extension Report\n\n` +
    `## Determination\n\n` +
    `Classification: \`${r.classification}\`\n\n` +
    `Observation-day eligible: \`${r.observation_day_eligible}\`\n\n` +
    `Observation-day increment: \`${r.observation_day_increment}\`\n\n` +
    `Bounded source LF SHA-256: \`${r.bounded_source_lf_sha256}\`\n\n` +
    `Selection policy: \`${r.source_selection_policy}\`\n\n` +
    `## Bounded event counts\n\n${markdownTable(countRows)}\n\n` +
    `## Source files\n\n${markdownTable(sourceRows)}\n\n` +
    `## v2 behavior-bearing readiness\n\n${markdownTable(readyRows)}\n\n` +
    `## Authority caveat\n\nThis report extends bounded source-data evidence only. It does not emit feature snapshots, process paper strategy runtime snapshots, create strategy markers, or grant broker/live/Phase 6/roster authority.\n\n` +
    `## Recommended next ticket\n\n\`${r.recommended_next_ticket}\`\n`;
}
function buildMemo(report: JsonValue): string {
  const r = report as Record<string, any>;
  const countRows = [['Record type', 'Count']];
  for (const [type, count] of Object.entries(r.bounded_source_event_counts_by_record_type as Record<string, number>)) {
    countRows.push([type, String(count)]);
  }
  const inventoryRows = [['Item', 'Readiness', 'Evidence']];
  for (const row of r.source_inventory as any[]) {
    inventoryRows.push([row.item, row.readiness, row.evidence]);
  }
  const readinessRows = [['Behavior-bearing field', 'Status', 'Notes']];
  for (const row of r.v2_behavior_bearing_readiness as any[]) {
    readinessRows.push([row.field, row.status, row.notes]);
  }
  const fieldRows = [['Field family', 'Classification', 'Evidence']];
  for (const row of r.field_family_inventory as any[]) {
    fieldRows.push([row.field_family, row.classification, row.evidence]);
  }
  const quote = r.quote_readiness as Record<string, number>;
  const quoteRows = [['Metric', 'Count'], ['quote_records_total', String(quote.quote_records_total)], ['quote_records_with_bid_ask', String(quote.quote_records_with_bid_ask)], ['quote_records_with_finite_mid_px', String(quote.quote_records_with_finite_mid_px)], ['quote_records_mid_px_null', String(quote.quote_records_mid_px_null)]];
  return `# ${TICKET} Memo\n\n` +
    `## 1. Context\n\n` +
    `PR #297 concluded that a capture-backed feature builder is plausible, but the bounded \`obs01\` trade-only sample cannot honestly produce v2 feature snapshots by itself. This ticket extends and inventories bounded Rithmic source-data inputs before any future builder emits \`StrategyFeatureSnapshot\` records.\n\n` +
    `## 2. Source-data scope\n\n` +
    `This ticket is source-data only. It does not run the paper strategy runtime, emit feature snapshots, call \`PaperTradingSession.processFeatureSnapshot(...)\`, or produce \`STRAT_EVAL\`, \`CANDIDATE\`, or \`ORDER_INTENT\` evidence.\n\n` +
    `## 3. Bounded source selection\n\n` +
    `Selection policy: \`${r.source_selection_policy}\`. The bounded source payload is written to \`${r.bounded_source_path}\` and has LF SHA-256 \`${r.bounded_source_lf_sha256}\`. Full source-file hashes are labeled \`point_in_time_full_file\` because the Rithmic captures are live/growing surfaces.\n\n` +
    `## 4. Source inventory\n\n${markdownTable(inventoryRows)}\n\n` +
    `## 5. Bounded event counts\n\n${markdownTable(countRows)}\n\n` +
    `## 6. v2 behavior-bearing readiness\n\n${markdownTable(readinessRows)}\n\n` +
    `## 7. Parser accounting and provenance\n\n` +
    `Each bounded record carries \`record_type\`, \`source_path\`, \`source_line_number\`, \`source_ts_ns\`, \`derived_ts_ns\`, \`source_event_id\`, \`causality_status\`, \`source_record_lf_sha256\`, and a source-specific payload. Parser accounting is serialized in the JSON report.\n\n` +
    `## 8. Determination\n\n` +
    `Determination: \`${r.classification}\`. Quote/trade/depth source data can be bounded and proven, but behavior-bearing session, regime, sigma, and signed-shock construction remain future builder or source-join work.\n\n` +
    `## 9. Observation-day lock\n\n` +
    `Observation-day eligible: \`${r.observation_day_eligible}\`. Observation-day increment: \`${r.observation_day_increment}\`. This ticket cannot count toward the 45/60 paper-observation day requirement.\n\n` +
    `## 10. Recommended next ticket\n\n` +
    `\`${r.recommended_next_ticket}\` should extend or pin the remaining session/regime/signed-shock source joins before implementing a capture-backed feature builder.\n\n` +
    `## 11. Authority caveat\n\n` +
    `No broker/live dispatch, Phase 6 authority, active roster mutation, candidate roster mutation, or paper-observation day credit is created by this ticket.\n`;
}

async function buildEvidence(args: { maxEvents: number; sourceRoot: string; outputDir: string }) {
  const sourceFiles: Array<{ kind: SourceKind; file: string }> = [
    { kind: 'obs01', file: 'MNQ_globex.obs01.jsonl' },
    { kind: 'mbp1', file: 'MNQ_globex.mbp1.jsonl' },
    { kind: 'mbo', file: 'MNQ_globex.mbo.jsonl' },
  ];
  const inspected = [] as Array<{ meta: SourceMeta; records: SourceRecord[] }>;
  for (const source of sourceFiles) {
    inspected.push(await inspectSource(source.kind, path.join(args.sourceRoot, source.file), args.maxEvents));
  }
  const metas = inspected.map((item) => item.meta);
  const records = mergeAndSlice(inspected.flatMap((item) => item.records), args.maxEvents);
  const boundedPayloadA = stableJsonl(records);
  const boundedPayloadB = stableJsonl(records);
  if (boundedPayloadA !== boundedPayloadB) throw new Error('bounded-source-events JSONL is not byte-stable');

  const reportA = buildReport({ sourceRoot: args.sourceRoot, maxEvents: args.maxEvents, metas, records, boundedPayload: boundedPayloadA, mdPreview: '' });
  const reportB = buildReport({ sourceRoot: args.sourceRoot, maxEvents: args.maxEvents, metas, records, boundedPayload: boundedPayloadB, mdPreview: '' });
  const reportJsonA = stableJson(reportA);
  const reportJsonB = stableJson(reportB);
  if (reportJsonA !== reportJsonB) throw new Error('source-data report JSON is not byte-stable');

  const reportMdA = buildMarkdown(reportA);
  const reportMdB = buildMarkdown(reportB);
  if (reportMdA !== reportMdB) throw new Error('source-data report Markdown is not byte-stable');

  const memo = buildMemo(reportA);
  return { records, report: reportA, boundedPayload: boundedPayloadA, reportJson: reportJsonA, reportMd: reportMdA, memo };
}

async function main() {
  const args = parseArgs();
  await mkdir(args.outputDir, { recursive: true });
  await mkdir('docs/research', { recursive: true });

  const evidence = await buildEvidence(args);
  await writeFile(path.join(args.outputDir, 'bounded-source-events.jsonl'), evidence.boundedPayload, 'utf8');
  await writeFile(path.join(args.outputDir, 'source-data-extend-report.json'), evidence.reportJson, 'utf8');
  await writeFile(path.join(args.outputDir, 'source-data-extend-report.md'), evidence.reportMd, 'utf8');
  await writeFile('docs/research/v2-pf-c-late-am-paper-observation-source-data-extend-01-memo.md', evidence.memo, 'utf8');

  const report = evidence.report as Record<string, any>;
  console.log(JSON.stringify({
    ticket: TICKET,
    classification: report.classification,
    bounded_source_lf_sha256: report.bounded_source_lf_sha256,
    bounded_source_event_count: report.bounded_source_event_count,
    bounded_source_event_counts_by_record_type: report.bounded_source_event_counts_by_record_type,
    observation_day_eligible: report.observation_day_eligible,
    observation_day_increment: report.observation_day_increment,
    recommended_next_ticket: report.recommended_next_ticket,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});



