import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface ArtifactExit {
  readonly exit_ts_ns: string;
  readonly exit_quantity: number;
  readonly management_action_reason: string | null;
  readonly management_action_type: string | null;
  readonly target_label: string | null;
  readonly fail_safe_context: FailSafeContext | null;
}

interface FailSafeContext {
  readonly market_authority: string | null;
  readonly market_is_stale: boolean | null;
  readonly mark_price: number | null;
  readonly bid_px: number | null;
  readonly ask_px: number | null;
  readonly active_stop_price: number | null;
  readonly remaining_quantity: number | null;
  readonly position_profile_id: string | null;
  readonly position_profile_version: number | null;
  readonly management_profile_id: string | null;
  readonly management_profile_version: number | null;
  readonly validation_path: string | null;
}

interface ArtifactTrade {
  readonly trade_id: string;
  readonly session_id: string;
  readonly entry_ts_ns: string;
  readonly exit_ts_ns: string;
  readonly side: 'long' | 'short';
  readonly regime: string;
  readonly vix_prior_close_percentile: number | null;
  readonly spread_bucket: string;
  readonly queue_ahead_bucket: string;
  readonly entry_price: number;
  readonly exit_price: number;
  readonly gross_pnl_cents: string;
  readonly net_pnl_cents: string;
  readonly entry_quantity: number;
  readonly exit_quantity: number;
  readonly management_profile_id: string;
  readonly time_stop_at_deadline_extension: string;
  readonly exits: readonly ArtifactExit[];
  readonly exit_reason: string;
  readonly exit_bar_index: number;
  readonly max_favorable_excursion_cents: string;
  readonly max_adverse_excursion_cents: string;
}

interface ArtifactWindow {
  readonly window_id: string;
  readonly start_session: string;
  readonly end_session: string;
  readonly total_trades: number;
  readonly net_pnl_cents: string;
}

interface HeldOutArtifact {
  readonly schema_version: 1;
  readonly strategy_id: string;
  readonly trades: readonly ArtifactTrade[];
  readonly windows: readonly ArtifactWindow[];
  readonly aggregate: {
    readonly total_trades: number;
    readonly net_pnl_cents: string;
    readonly gross_profit_cents: string;
    readonly gross_loss_cents: string;
    readonly profit_factor_ppm: number | null;
  };
}

interface BucketStats {
  readonly count: number;
  readonly gross_pnl_cents: number;
  readonly net_pnl_cents: number;
  readonly avg_net_pnl_cents: number | null;
  readonly median_net_pnl_cents: number | null;
  readonly p10_net_pnl_cents: number | null;
  readonly p25_net_pnl_cents: number | null;
  readonly p75_net_pnl_cents: number | null;
  readonly p90_net_pnl_cents: number | null;
}

const SOURCE_ARTIFACT = 'artifacts/held-out-validation/cycle4-r1-v3-failsafe-forensics-02/regime_shock_reversion_short_v3-feb-mar-apr-2026.json';
const JSON_OUT = 'artifacts/research/cycle4-r1-v3-failsafe-forensics-02/v3-failsafe-trade-forensics.json';
const MD_OUT = 'artifacts/research/cycle4-r1-v3-failsafe-forensics-02/v3-failsafe-trade-forensics.md';
const EXPECTED_TRADES = 889;
const EXPECTED_FAIL_SAFE = 262;
const EXPECTED_NET_PNL_CENTS = -102600;

function main(): void {
  const sourceBytes = readFileSync(SOURCE_ARTIFACT);
  const sourceSha = createHash('sha256').update(sourceBytes).digest('hex');
  const artifact = JSON.parse(sourceBytes.toString('utf8')) as HeldOutArtifact;
  assertArtifactSurface(artifact);

  const trades = artifact.trades;
  const failSafeTrades = trades.filter((trade) => trade.exit_reason === 'fail_safe');
  const targetTrades = trades.filter((trade) => trade.exit_reason === 'target');
  const stopLossTrades = trades.filter((trade) => trade.exit_reason === 'stop_loss');
  const netPnlCents = sum(trades.map((trade) => cents(trade.net_pnl_cents)));

  if (trades.length !== EXPECTED_TRADES) {
    throw new Error(`expected ${EXPECTED_TRADES} trades, got ${trades.length}`);
  }
  if (failSafeTrades.length !== EXPECTED_FAIL_SAFE) {
    throw new Error(`expected ${EXPECTED_FAIL_SAFE} fail-safe exits, got ${failSafeTrades.length}`);
  }
  if (netPnlCents !== EXPECTED_NET_PNL_CENTS) {
    throw new Error(`expected net pnl ${EXPECTED_NET_PNL_CENTS}, got ${netPnlCents}`);
  }

  const result = {
    schema_version: 1,
    ticket: 'CYCLE4-R1-V3-FAILSAFE-FORENSICS-02',
    source_artifact: {
      path: SOURCE_ARTIFACT,
      sha256: sourceSha,
      strategy_id: artifact.strategy_id,
      schema_version: artifact.schema_version,
    },
    anchor_reconciliation: {
      total_trades: trades.length,
      fail_safe_exits: failSafeTrades.length,
      net_pnl_cents: netPnlCents,
      expected_total_trades: EXPECTED_TRADES,
      expected_fail_safe_exits: EXPECTED_FAIL_SAFE,
      expected_net_pnl_cents: EXPECTED_NET_PNL_CENTS,
      status: 'matched',
    },
    field_inventory: fieldInventory(),
    summary: {
      total_trades: trades.length,
      gross_profit_cents: cents(artifact.aggregate.gross_profit_cents),
      gross_loss_cents: cents(artifact.aggregate.gross_loss_cents),
      net_pnl_cents: netPnlCents,
      profit_factor_ppm: artifact.aggregate.profit_factor_ppm,
      fail_safe: stats(failSafeTrades),
      target: stats(targetTrades),
      stop_loss: stats(stopLossTrades),
    },
    exit_reason_breakdown: groupStats(trades, (trade) => trade.exit_reason),
    fail_safe_reason_breakdown: groupStats(failSafeTrades, (trade) => failSafeExit(trade).management_action_reason ?? 'unknown'),
    fail_safe_market_authority_breakdown: groupStats(failSafeTrades, (trade) => failSafeExit(trade).fail_safe_context?.market_authority ?? 'null'),
    fail_safe_stale_breakdown: groupStats(failSafeTrades, (trade) => String(failSafeExit(trade).fail_safe_context?.market_is_stale ?? null)),
    fail_safe_validation_path_breakdown: groupStats(failSafeTrades, (trade) => failSafeExit(trade).fail_safe_context?.validation_path ?? 'null'),
    fail_safe_profile_breakdown: groupStats(failSafeTrades, (trade) => {
      const context = failSafeExit(trade).fail_safe_context;
      return `${context?.position_profile_id ?? 'null'} -> ${context?.management_profile_id ?? 'null'}`;
    }),
    window_breakdown: windowBreakdown(artifact.windows, trades),
    session_breakdown: groupStats(trades, (trade) => trade.session_id).slice(0, 20),
    vix_percentile_breakdown: vixBreakdown(trades),
    spread_bucket_breakdown: groupStats(trades, (trade) => `${trade.exit_reason}:${trade.spread_bucket}`),
    queue_ahead_bucket_breakdown: groupStats(trades, (trade) => `${trade.exit_reason}:${trade.queue_ahead_bucket}`),
    hold_time_breakdown: holdTimeBreakdown(trades),
    mfe_mae_breakdown: mfeMaeBreakdown(trades),
    worst_failsafe_trades: tradeRows(failSafeTrades.slice().sort((a, b) => cents(a.net_pnl_cents) - cents(b.net_pnl_cents)).slice(0, 15)),
    best_failsafe_trades: tradeRows(failSafeTrades.slice().sort((a, b) => cents(b.net_pnl_cents) - cents(a.net_pnl_cents)).slice(0, 15)),
    improvement_target: {
      break_even_net_improvement_cents: 102600,
      gross_loss_reduction_pct_for_break_even: 11.387347391786903,
      pf_pass_threshold: 1.35,
      estimated_improvement_to_pf_pass_cents: 309593,
      framing: 'PF near 1.0 is break-even only, not ADR-0016 pass.',
    },
    evidence_gaps: [
      'vix_value remains unavailable per trade',
      'vix_fresh remains unavailable per trade',
      'signed_shock_vwap remains unavailable per trade',
      'signed_shock_vwap_recent_values remains unavailable per trade',
      'primary_percentile and vxn_percentile remain unavailable per trade',
      'window_id remains unavailable per trade; artifact window totals are available, but fail-safe concentration by window cannot be assigned without ambiguity',
    ],
    recommendations: [
      'Use fail-safe subtype/context findings to decide whether a targeted registered-inactive diagnostic variant is warranted.',
      'Do not tune v3 until coordinator/operator review of CYCLE4-R1-V3-FAILSAFE-FORENSICS-02.',
      'If signed-shock or VIX freshness is required, route a second evidence-surface extension rather than fabricating fields.',
    ],
  } satisfies JsonValue;

  writeJson(JSON_OUT, result);
  writeMarkdown(MD_OUT, artifact, result);
  process.stdout.write(JSON.stringify({
    source_sha: sourceSha,
    total_trades: trades.length,
    fail_safe_exits: failSafeTrades.length,
    net_pnl_cents: netPnlCents,
    json_out: JSON_OUT,
    md_out: MD_OUT,
  }) + '\n');
}

function assertArtifactSurface(artifact: HeldOutArtifact): void {
  if (artifact.schema_version !== 1) {
    throw new Error(`expected schema_version 1, got ${artifact.schema_version}`);
  }
  for (const [index, trade] of artifact.trades.entries()) {
    assertString(trade.trade_id, `trades[${index}].trade_id`);
    assertString(trade.session_id, `trades[${index}].session_id`);
    assertNumber(trade.entry_price, `trades[${index}].entry_price`);
    assertNumber(trade.exit_price, `trades[${index}].exit_price`);
    if (!Object.prototype.hasOwnProperty.call(trade, 'vix_prior_close_percentile')) {
      throw new Error(`missing trades[${index}].vix_prior_close_percentile`);
    }
    for (const [exitIndex, exit] of trade.exits.entries()) {
      const isFailSafeExit = exit.management_action_type === 'FAIL_SAFE_EXIT';
      if (isFailSafeExit) {
        if (exit.management_action_reason?.startsWith('fail_safe:') !== true) {
          throw new Error(`missing fail_safe reason at trades[${index}].exits[${exitIndex}]`);
        }
        if (exit.fail_safe_context === null) {
          throw new Error(`missing fail_safe_context at trades[${index}].exits[${exitIndex}]`);
        }
      } else if (exit.fail_safe_context !== null) {
        throw new Error(`non-fail-safe exit has context at trades[${index}].exits[${exitIndex}]`);
      }
    }
    if (trade.exit_reason === 'fail_safe' && !trade.exits.some((exit) => exit.management_action_type === 'FAIL_SAFE_EXIT')) {
      throw new Error(`fail_safe trade without FAIL_SAFE_EXIT at trades[${index}]`);
    }
  }
}

function assertString(value: unknown, path: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`expected non-empty string at ${path}`);
  }
}

function assertNumber(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`expected finite number at ${path}`);
  }
}

function fieldInventory(): JsonValue[] {
  return [
    { field: 'management_action_reason', class: 'already-in-exits', action: 'preserved' },
    { field: 'management_action_type', class: 'already-in-exits', action: 'preserved' },
    { field: 'target_label', class: 'already-in-exits', action: 'preserved' },
    { field: 'fail_safe_context', class: 'load-bearing-context', action: 'analyzed' },
    { field: 'trade_id', class: 'stable-identity', action: 'analyzed' },
    { field: 'session_id', class: 'stable-identity', action: 'analyzed' },
    { field: 'entry_price', class: 'price/tick-context', action: 'analyzed' },
    { field: 'exit_price', class: 'price/tick-context', action: 'analyzed' },
    { field: 'vix_prior_close_percentile', class: 'desired-entry-context', action: 'analyzed where non-null' },
    { field: 'signed_shock_vwap', class: 'unavailable/deferred', action: 'reported gap' },
    { field: 'signed_shock_vwap_recent_values', class: 'unavailable/deferred', action: 'reported gap' },
    { field: 'vix_fresh', class: 'unavailable/deferred', action: 'reported gap' },
  ];
}

function failSafeExit(trade: ArtifactTrade): ArtifactExit {
  const exit = trade.exits.find((candidate) => candidate.management_action_type === 'FAIL_SAFE_EXIT');
  if (exit === undefined) {
    throw new Error(`missing FAIL_SAFE_EXIT for ${trade.trade_id}`);
  }
  return exit;
}

function cents(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`invalid cents value ${value}`);
  }
  return parsed;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function stats(trades: readonly ArtifactTrade[]): BucketStats {
  const values = trades.map((trade) => cents(trade.net_pnl_cents)).sort((a, b) => a - b);
  const gross = sum(trades.map((trade) => cents(trade.gross_pnl_cents)));
  const net = sum(values);
  return {
    count: trades.length,
    gross_pnl_cents: gross,
    net_pnl_cents: net,
    avg_net_pnl_cents: trades.length === 0 ? null : round(net / trades.length, 2),
    median_net_pnl_cents: percentile(values, 0.5),
    p10_net_pnl_cents: percentile(values, 0.1),
    p25_net_pnl_cents: percentile(values, 0.25),
    p75_net_pnl_cents: percentile(values, 0.75),
    p90_net_pnl_cents: percentile(values, 0.9),
  };
}

function groupStats(trades: readonly ArtifactTrade[], keyFn: (trade: ArtifactTrade) => string): JsonValue[] {
  const groups = new Map<string, ArtifactTrade[]>();
  for (const trade of trades) {
    const key = keyFn(trade);
    groups.set(key, [...(groups.get(key) ?? []), trade]);
  }
  return [...groups.entries()]
    .map(([key, grouped]) => ({ key, ...stats(grouped) }))
    .sort((left, right) => Number(right.count) - Number(left.count) || String(left.key).localeCompare(String(right.key)));
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index] ?? null;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function windowBreakdown(windows: readonly ArtifactWindow[], trades: readonly ArtifactTrade[]): JsonValue[] {
  return windows.map((window) => {
    return {
      window_id: window.window_id,
      start_session: window.start_session,
      end_session: window.end_session,
      artifact_total_trades: window.total_trades,
      fail_safe_trades: null,
      net_pnl_cents: cents(window.net_pnl_cents),
      note: 'per-trade window_id is not serialized; overlapping walk-forward windows make session-range assignment ambiguous',
    };
  });
}

function vixBreakdown(trades: readonly ArtifactTrade[]): JsonValue[] {
  const bucketed = trades.map((trade) => ({ ...trade, vix_bucket: vixBucket(trade.vix_prior_close_percentile) }));
  return groupStats(bucketed, (trade) => `${trade.exit_reason}:${trade.vix_bucket}`);
}

function vixBucket(value: number | null): string {
  if (value === null) {
    return 'null';
  }
  if (value < 0.25) return '<0.25';
  if (value < 0.50) return '0.25-0.50';
  if (value < 0.67) return '0.50-0.67';
  if (value < 0.85) return '0.67-0.85';
  return '>=0.85';
}

function holdTimeBreakdown(trades: readonly ArtifactTrade[]): JsonValue[] {
  const groups = new Map<string, number[]>();
  for (const trade of trades) {
    const minutes = Number(BigInt(trade.exit_ts_ns) - BigInt(trade.entry_ts_ns)) / 60_000_000_000;
    groups.set(trade.exit_reason, [...(groups.get(trade.exit_reason) ?? []), round(minutes, 2)]);
  }
  return [...groups.entries()].map(([exit_reason, values]) => ({
    exit_reason,
    count: values.length,
    avg_minutes: round(sum(values) / values.length, 2),
    median_minutes: percentile(values.slice().sort((a, b) => a - b), 0.5),
    p90_minutes: percentile(values.slice().sort((a, b) => a - b), 0.9),
  })).sort((left, right) => Number(right.count) - Number(left.count));
}

function mfeMaeBreakdown(trades: readonly ArtifactTrade[]): JsonValue[] {
  const reasons = [...new Set(trades.map((trade) => trade.exit_reason))].sort();
  return reasons.map((reason) => {
    const grouped = trades.filter((trade) => trade.exit_reason === reason);
    return {
      exit_reason: reason,
      count: grouped.length,
      avg_mfe_cents: round(sum(grouped.map((trade) => cents(trade.max_favorable_excursion_cents))) / grouped.length, 2),
      avg_mae_cents: round(sum(grouped.map((trade) => cents(trade.max_adverse_excursion_cents))) / grouped.length, 2),
      median_mfe_cents: percentile(grouped.map((trade) => cents(trade.max_favorable_excursion_cents)).sort((a, b) => a - b), 0.5),
      median_mae_cents: percentile(grouped.map((trade) => cents(trade.max_adverse_excursion_cents)).sort((a, b) => a - b), 0.5),
    };
  });
}

function tradeRows(trades: readonly ArtifactTrade[]): JsonValue[] {
  return trades.map((trade) => {
    const exit = failSafeExit(trade);
    return {
      trade_id: trade.trade_id,
      session_id: trade.session_id,
      net_pnl_cents: cents(trade.net_pnl_cents),
      reason: exit.management_action_reason,
      market_authority: exit.fail_safe_context?.market_authority ?? null,
      mark_price: exit.fail_safe_context?.mark_price ?? null,
      active_stop_price: exit.fail_safe_context?.active_stop_price ?? null,
      remaining_quantity: exit.fail_safe_context?.remaining_quantity ?? null,
      vix_prior_close_percentile: trade.vix_prior_close_percentile,
      spread_bucket: trade.spread_bucket,
      queue_ahead_bucket: trade.queue_ahead_bucket,
    };
  });
}

function writeJson(path: string, value: JsonValue): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stableStringify(value) + '\n', 'utf8');
}

function stableStringify(value: JsonValue): string {
  return JSON.stringify(stable(value));
}

function stable(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key] as JsonValue)]));
  }
  return value;
}

function writeMarkdown(path: string, artifact: HeldOutArtifact, result: JsonValue): void {
  mkdirSync(dirname(path), { recursive: true });
  const r = result as Record<string, JsonValue>;
  const lines: string[] = [];
  lines.push('# CYCLE4-R1-V3-FAILSAFE-FORENSICS-02 Artifact');
  lines.push('');
  lines.push(`Source artifact: \`${SOURCE_ARTIFACT}\``);
  lines.push('');
  lines.push('## Anchor reconciliation');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---:|');
  lines.push(`| Total trades | ${artifact.trades.length} |`);
  lines.push(`| Fail-safe exits | ${artifact.trades.filter((trade) => trade.exit_reason === 'fail_safe').length} |`);
  lines.push(`| Net PnL cents | ${sum(artifact.trades.map((trade) => cents(trade.net_pnl_cents)))} |`);
  lines.push('');
  lines.push('## Exit reason breakdown');
  table(lines, r.exit_reason_breakdown as JsonValue[], ['key', 'count', 'net_pnl_cents', 'avg_net_pnl_cents']);
  lines.push('');
  lines.push('## Fail-safe reason breakdown');
  table(lines, r.fail_safe_reason_breakdown as JsonValue[], ['key', 'count', 'net_pnl_cents', 'avg_net_pnl_cents']);
  lines.push('');
  lines.push('## Fail-safe market authority breakdown');
  table(lines, r.fail_safe_market_authority_breakdown as JsonValue[], ['key', 'count', 'net_pnl_cents']);
  lines.push('');
  lines.push('## Window breakdown');
  table(lines, r.window_breakdown as JsonValue[], ['window_id', 'artifact_total_trades', 'fail_safe_trades', 'net_pnl_cents', 'note']);
  lines.push('');
  lines.push('## Worst fail-safe trades');
  table(lines, r.worst_failsafe_trades as JsonValue[], ['trade_id', 'session_id', 'net_pnl_cents', 'reason', 'market_authority', 'mark_price', 'active_stop_price']);
  lines.push('');
  lines.push('## Evidence gaps');
  for (const gap of r.evidence_gaps as JsonValue[]) {
    lines.push(`- ${String(gap)}`);
  }
  lines.push('');
  writeFileSync(path, lines.join('\n'), 'utf8');
}

function table(lines: string[], rows: JsonValue[], columns: string[]): void {
  lines.push(`| ${columns.join(' | ')} |`);
  lines.push(`| ${columns.map(() => '---').join(' | ')} |`);
  for (const row of rows as Record<string, JsonValue>[]) {
    lines.push(`| ${columns.map((column) => formatCell(row[column])).join(' | ')} |`);
  }
}

function formatCell(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value).replaceAll('|', '\\|');
}

main();
