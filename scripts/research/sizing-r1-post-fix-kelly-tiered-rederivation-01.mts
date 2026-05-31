import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type HeldOutTrade = {
  readonly entry_quantity: number;
  readonly entry_ts_ns: string;
  readonly exit_quantity: number;
  readonly exit_reason: string;
  readonly net_pnl_cents: string | number;
  readonly session_id: string;
  readonly trade_id: string;
};

type HeldOutArtifact = {
  readonly aggregate?: {
    readonly profit_factor_ppm?: number;
  };
  readonly schema_version: number;
  readonly strategy_id: string;
  readonly trades: readonly HeldOutTrade[];
};

type Trade = {
  readonly entryHourUtc: number;
  readonly entryQuantity: number;
  readonly entryTsNs: string;
  readonly exitQuantity: number;
  readonly exitReason: string;
  readonly netPnlCents: number;
  readonly returnUnit: number;
  readonly sessionId: string;
  readonly tier: TierName | 'out_of_scope';
  readonly tradeId: string;
};

type TierName = 'A_open' | 'B_morning' | 'C_late_am' | 'D_afternoon' | 'E_close';

type KellyResult = {
  readonly fraction: number;
  readonly feasibleLower: number;
  readonly feasibleUpper: number;
  readonly meanLogGrowth: number;
  readonly boundary: 'interior' | 'lower' | 'upper';
};

type MetricSample = {
  readonly generalizedKelly: number;
  readonly netPnlCents: number;
  readonly profitFactor: number;
};

type BootstrapSummary = {
  readonly generalized_kelly: QuantileSummary & {
    readonly probability_below_0: number;
    readonly probability_below_2_5pct: number;
    readonly probability_below_5pct: number;
  };
  readonly net_pnl_cents: QuantileSummary;
  readonly profit_factor: QuantileSummary;
};

type QuantileSummary = {
  readonly p05: number;
  readonly p50: number;
  readonly p95: number;
};

type SimulationResult = {
  readonly final_equity_cents: number;
  readonly final_equity_dollars: number;
  readonly max_drawdown_pct: number;
  readonly min_equity_cents: number;
  readonly name: string;
  readonly risk_fraction_max: number;
  readonly risk_fraction_mean: number;
  readonly risk_fraction_min: number;
  readonly ruin_proxy_breached: boolean;
  readonly total_return_pct: number;
};

const TICKET = 'SIZING-R1-POST-FIX-KELLY-TIERED-REDERIVATION-01';
const SUBSTRATE_SHA = '10aee46cb1818366fb1785cb15da7cffb80db3bb';
const STRATEGY_ID = 'regime_shock_reversion_short_v2';
const SOURCE_ARTIFACT_PATH =
  'artifacts/held-out-validation/mgmt-bugfix-edge-attribution-02/regime_shock_reversion_short_v2-feb-mar-apr-2026.json';
const EXPECTED_SOURCE_SHA = 'c9a29e1d6cdb6cc39d07976c2930153342c16ceb59c3145c0e981dd611fde927';
const OUTPUT_JSON_PATH =
  'artifacts/research/sizing-r1-post-fix-kelly-tiered-rederivation-01/v2-kelly-tiered-sizing-rederivation.json';
const OUTPUT_MD_PATH =
  'artifacts/research/sizing-r1-post-fix-kelly-tiered-rederivation-01/v2-kelly-tiered-sizing-rederivation.md';
const MEMO_PATH = 'docs/research/sizing-r1-post-fix-kelly-tiered-rederivation-01-memo.md';
const BACKLOG_PATH = 'docs/plan/new_app_v1_ticket_backlog_v6.csv';
const BACKLOG_ROW =
  'SIZING-R1-POST-FIX-KELLY-TIERED-REDERIVATION-01,P2,1.5,MGMT-BUGFIX-EDGE-ATTRIBUTION-02,Rederive generalized Kelly and tiered-sizing evidence against the PR #281 corrected-engine v2 artifact; evidence only no sizing policy or authority change,new_cycle4_v3_research_substrate';

const EXPECTED_ANCHORS = {
  fail_safe: 17,
  net_pnl_cents: 184200,
  profit_factor: 1.241954,
  session_close: 6,
  stop_loss: 767,
  target: 308,
  trades: 1098,
} as const;

const BOOTSTRAP_SEED = 611281;
const BOOTSTRAP_ITERATIONS = 10000;
const STARTING_EQUITY_CENTS = 5_000_000;
const RUIN_DRAWDOWN_THRESHOLD = 0.5;

const TIER_DEFINITIONS: readonly {
  readonly hours: readonly number[];
  readonly name: TierName;
  readonly stableFloor: number;
}[] = [
  { hours: [13, 14], name: 'A_open', stableFloor: 100 },
  { hours: [15], name: 'B_morning', stableFloor: 75 },
  { hours: [16, 17], name: 'C_late_am', stableFloor: 100 },
  { hours: [18, 19], name: 'D_afternoon', stableFloor: 100 },
  { hours: [20], name: 'E_close', stableFloor: 75 },
];

function stableJson(value: JsonValue): string {
  return `${JSON.stringify(sortJson(value))}\n`;
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJson(entry));
  }
  if (value !== null && typeof value === 'object') {
    const sorted: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJson(value[key]);
    }
    return sorted;
  }
  return value;
}

function writeDeterministic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const normalized = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/\n*$/u, '\n');
  writeFileSync(path, normalized, 'utf8');
}

function lfSha256(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function fileLfSha256(path: string): string {
  return lfSha256(readFileSync(path, 'utf8'));
}

function parseCents(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`Invalid cents value: ${String(value)}`);
  }
  return parsed;
}

function entryHourUtc(entryTsNs: string): number {
  const ms = Number(BigInt(entryTsNs) / 1_000_000n);
  return new Date(ms).getUTCHours();
}

function tierForHour(hour: number): TierName | 'out_of_scope' {
  for (const tier of TIER_DEFINITIONS) {
    if (tier.hours.includes(hour)) {
      return tier.name;
    }
  }
  return 'out_of_scope';
}

function compareTrades(a: Trade, b: Trade): number {
  const aNs = BigInt(a.entryTsNs);
  const bNs = BigInt(b.entryTsNs);
  if (aNs < bNs) {
    return -1;
  }
  if (aNs > bNs) {
    return 1;
  }
  return a.tradeId.localeCompare(b.tradeId);
}

function round(value: number, digits = 6): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function quantile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower] ?? 0;
  }
  const weight = index - lower;
  return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
}

function quantileSummary(values: readonly number[]): QuantileSummary {
  return {
    p05: round(quantile(values, 0.05), 6),
    p50: round(quantile(values, 0.5), 6),
    p95: round(quantile(values, 0.95), 6),
  };
}

function profitFactor(netPnls: readonly number[]): number {
  let grossProfit = 0;
  let grossLoss = 0;
  for (const pnl of netPnls) {
    if (pnl > 0) {
      grossProfit += pnl;
    } else if (pnl < 0) {
      grossLoss += Math.abs(pnl);
    }
  }
  return grossLoss === 0 ? Number.POSITIVE_INFINITY : grossProfit / grossLoss;
}

function exitCounts(trades: readonly Trade[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const trade of trades) {
    counts[trade.exitReason] = (counts[trade.exitReason] ?? 0) + 1;
  }
  return counts;
}

function generalizedKelly(returns: readonly number[]): KellyResult {
  let maxPositive = 0;
  let minNegative = 0;
  for (const value of returns) {
    if (value > maxPositive) {
      maxPositive = value;
    }
    if (value < minNegative) {
      minNegative = value;
    }
  }

  if (maxPositive === 0 && minNegative === 0) {
    return { boundary: 'interior', feasibleLower: 0, feasibleUpper: 0, fraction: 0, meanLogGrowth: 0 };
  }

  let lower = maxPositive > 0 ? -0.999999 / maxPositive : -10;
  let upper = minNegative < 0 ? -0.999999 / minNegative : 10;
  lower = Math.max(lower, -10);
  upper = Math.min(upper, 10);

  const derivative = (fraction: number): number => {
    let total = 0;
    for (const value of returns) {
      const denominator = 1 + fraction * value;
      if (denominator <= 0) {
        return fraction < 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
      }
      total += value / denominator;
    }
    return total / returns.length;
  };

  const meanLogGrowth = (fraction: number): number => {
    let total = 0;
    for (const value of returns) {
      const inner = 1 + fraction * value;
      if (inner <= 0) {
        return Number.NEGATIVE_INFINITY;
      }
      total += Math.log1p(fraction * value);
    }
    return total / returns.length;
  };

  const dLower = derivative(lower);
  const dUpper = derivative(upper);
  if (dLower <= 0) {
    return {
      boundary: 'lower',
      feasibleLower: lower,
      feasibleUpper: upper,
      fraction: lower,
      meanLogGrowth: meanLogGrowth(lower),
    };
  }
  if (dUpper >= 0) {
    return {
      boundary: 'upper',
      feasibleLower: lower,
      feasibleUpper: upper,
      fraction: upper,
      meanLogGrowth: meanLogGrowth(upper),
    };
  }

  let lo = lower;
  let hi = upper;
  for (let i = 0; i < 36; i += 1) {
    const mid = (lo + hi) / 2;
    const derivativeAtMid = derivative(mid);
    if (derivativeAtMid > 0) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const fraction = Math.abs((lo + hi) / 2) < 1e-12 ? 0 : (lo + hi) / 2;
  return {
    boundary: 'interior',
    feasibleLower: lower,
    feasibleUpper: upper,
    fraction,
    meanLogGrowth: meanLogGrowth(fraction),
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleWithReplacement<T>(values: readonly T[], count: number, random: () => number): T[] {
  const out: T[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(values[Math.floor(random() * values.length)] as T);
  }
  return out;
}

function sessionBlocks(trades: readonly Trade[]): readonly Trade[][] {
  const blocks: Trade[][] = [];
  const bySession = new Map<string, Trade[]>();
  for (const trade of trades) {
    const bucket = bySession.get(trade.sessionId) ?? [];
    bucket.push(trade);
    bySession.set(trade.sessionId, bucket);
  }
  for (const sessionId of [...bySession.keys()].sort()) {
    blocks.push([...(bySession.get(sessionId) ?? [])].sort(compareTrades));
  }
  return blocks;
}

function sampleSessionBlocks(blocks: readonly Trade[][], count: number, random: () => number): Trade[] {
  const out: Trade[] = [];
  while (out.length < count) {
    const block = blocks[Math.floor(random() * blocks.length)] ?? [];
    for (const trade of block) {
      if (out.length < count) {
        out.push(trade);
      }
    }
  }
  return out;
}

function metricSample(trades: readonly Trade[]): MetricSample {
  const netPnls = trades.map((trade) => trade.netPnlCents);
  const returns = trades.map((trade) => trade.returnUnit);
  return {
    generalizedKelly: generalizedKelly(returns).fraction,
    netPnlCents: sum(netPnls),
    profitFactor: profitFactor(netPnls),
  };
}

function bootstrap(trades: readonly Trade[], mode: 'iid' | 'session_block'): BootstrapSummary {
  const random = mulberry32(BOOTSTRAP_SEED + (mode === 'iid' ? 0 : 1));
  const blocks = sessionBlocks(trades);
  const samples: MetricSample[] = [];
  for (let i = 0; i < BOOTSTRAP_ITERATIONS; i += 1) {
    const sample =
      mode === 'iid'
        ? sampleWithReplacement(trades, trades.length, random)
        : sampleSessionBlocks(blocks, trades.length, random);
    samples.push(metricSample(sample));
  }
  const kellyValues = samples.map((sample) => sample.generalizedKelly);
  return {
    generalized_kelly: {
      ...quantileSummary(kellyValues),
      probability_below_0: round(kellyValues.filter((value) => value < 0).length / kellyValues.length, 6),
      probability_below_2_5pct: round(kellyValues.filter((value) => value < 0.025).length / kellyValues.length, 6),
      probability_below_5pct: round(kellyValues.filter((value) => value < 0.05).length / kellyValues.length, 6),
    },
    net_pnl_cents: quantileSummary(samples.map((sample) => sample.netPnlCents)),
    profit_factor: quantileSummary(samples.map((sample) => sample.profitFactor)),
  };
}

function summarizeTradeDistribution(trades: readonly Trade[]) {
  const netPnls = trades.map((trade) => trade.netPnlCents);
  const winners = netPnls.filter((value) => value > 0);
  const losers = netPnls.filter((value) => value < 0);
  const zeros = netPnls.filter((value) => value === 0);
  return {
    average_loss_cents: round(mean(losers.map((value) => Math.abs(value))), 6),
    average_trade_cents: round(mean(netPnls), 6),
    average_win_cents: round(mean(winners), 6),
    gross_loss_cents: sum(losers),
    gross_profit_cents: sum(winners),
    losses: losers.length,
    median_trade_cents: round(quantile(netPnls, 0.5), 6),
    net_pnl_cents: sum(netPnls),
    p05_trade_cents: round(quantile(netPnls, 0.05), 6),
    p95_trade_cents: round(quantile(netPnls, 0.95), 6),
    profit_factor: round(profitFactor(netPnls), 6),
    trades: trades.length,
    win_rate: round(winners.length / trades.length, 6),
    wins: winners.length,
    zeros: zeros.length,
  };
}

function summarizeTier(name: TierName, trades: readonly Trade[]) {
  const tierTrades = trades.filter((trade) => trade.tier === name);
  const distribution = summarizeTradeDistribution(tierTrades);
  const returns = tierTrades.map((trade) => trade.returnUnit);
  const kelly = generalizedKelly(returns);
  const definition = TIER_DEFINITIONS.find((tier) => tier.name === name);
  const sampleFloor = definition?.stableFloor ?? 100;
  return {
    hours_utc: definition?.hours.join(',') ?? '',
    sample_size_warning:
      tierTrades.length < sampleFloor
        ? `unstable: n=${tierTrades.length} below predeclared floor ${sampleFloor}`
        : 'acceptable_for_diagnostic_only',
    tier: name,
    tier_generalized_kelly: round(kelly.fraction, 6),
    ...distribution,
  };
}

function maxDrawdownCents(netPnls: readonly number[]): number {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const pnl of netPnls) {
    equity += pnl;
    if (equity > peak) {
      peak = equity;
    }
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return maxDrawdown;
}

function simulate(
  name: string,
  trades: readonly Trade[],
  lossUnitCents: number,
  riskFractionForTrade: (trade: Trade) => number,
): SimulationResult {
  let equity = STARTING_EQUITY_CENTS;
  let peak = equity;
  let minEquity = equity;
  let maxDrawdownPct = 0;
  const riskFractions: number[] = [];
  for (const trade of trades) {
    const riskFraction = Math.max(0, riskFractionForTrade(trade));
    riskFractions.push(riskFraction);
    const pnl = trade.netPnlCents * ((equity * riskFraction) / lossUnitCents);
    equity += pnl;
    if (equity > peak) {
      peak = equity;
    }
    if (equity < minEquity) {
      minEquity = equity;
    }
    const drawdownPct = peak <= 0 ? 1 : (peak - equity) / peak;
    if (drawdownPct > maxDrawdownPct) {
      maxDrawdownPct = drawdownPct;
    }
  }
  return {
    final_equity_cents: Math.round(equity),
    final_equity_dollars: round(equity / 100, 2),
    max_drawdown_pct: round(maxDrawdownPct, 6),
    min_equity_cents: Math.round(minEquity),
    name,
    risk_fraction_max: round(Math.max(...riskFractions), 6),
    risk_fraction_mean: round(mean(riskFractions), 6),
    risk_fraction_min: round(Math.min(...riskFractions), 6),
    ruin_proxy_breached: minEquity <= 0 || maxDrawdownPct >= RUIN_DRAWDOWN_THRESHOLD,
    total_return_pct: round((equity - STARTING_EQUITY_CENTS) / STARTING_EQUITY_CENTS, 6),
  };
}

function markdownTable(headers: readonly string[], rows: readonly (readonly (number | string))[]): string {
  const header = `| ${headers.join(' | ')} |`;
  const separator = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`);
  return [header, separator, ...body].join('\n');
}

function formatPct(value: number): string {
  return `${round(value * 100, 3).toFixed(3)}%`;
}

function formatDollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${Math.abs(cents / 100).toLocaleString('en-US', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
}

function updateBacklog(): void {
  const existing = readFileSync(BACKLOG_PATH, 'utf8').replace(/\r\n/g, '\n');
  const lines = existing.replace(/\n*$/u, '').split('\n');
  const index = lines.findIndex((line) => line.startsWith(`${TICKET},`));
  if (index >= 0) {
    lines[index] = BACKLOG_ROW;
  } else {
    lines.push(BACKLOG_ROW);
  }
  writeDeterministic(BACKLOG_PATH, lines.join('\n'));
}

function assertClose(actual: number, expected: number, label: string, tolerance = 0.000001): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label} mismatch: expected ${expected}, observed ${actual}`);
  }
}

function main(): void {
  const sourceText = readFileSync(SOURCE_ARTIFACT_PATH, 'utf8');
  const sourceSha = lfSha256(sourceText);
  if (sourceSha !== EXPECTED_SOURCE_SHA) {
    throw new Error(`Source artifact SHA mismatch: expected ${EXPECTED_SOURCE_SHA}, observed ${sourceSha}`);
  }

  const artifact = JSON.parse(sourceText) as HeldOutArtifact;
  if (artifact.strategy_id !== STRATEGY_ID) {
    throw new Error(`Unexpected strategy_id ${artifact.strategy_id}`);
  }
  if (artifact.schema_version !== 1) {
    throw new Error(`Unexpected source schema_version ${artifact.schema_version}`);
  }

  const lossPnls = artifact.trades
    .map((trade) => parseCents(trade.net_pnl_cents))
    .filter((value) => value < 0);
  const lossUnitCents = mean(lossPnls.map((value) => Math.abs(value)));
  if (!(lossUnitCents > 0)) {
    throw new Error('Cannot compute positive loss-unit denominator');
  }

  const trades = artifact.trades
    .map((trade): Trade => {
      const hour = entryHourUtc(trade.entry_ts_ns);
      const netPnlCents = parseCents(trade.net_pnl_cents);
      return {
        entryHourUtc: hour,
        entryQuantity: trade.entry_quantity,
        entryTsNs: trade.entry_ts_ns,
        exitQuantity: trade.exit_quantity,
        exitReason: trade.exit_reason,
        netPnlCents,
        returnUnit: netPnlCents / lossUnitCents,
        sessionId: trade.session_id,
        tier: tierForHour(hour),
        tradeId: trade.trade_id,
      };
    })
    .sort(compareTrades);

  if (trades.some((trade) => trade.entryQuantity !== 1 || trade.exitQuantity !== 1)) {
    throw new Error('Non-standard trade quantity found; expected all entry/exit quantities to equal 1');
  }

  const distribution = summarizeTradeDistribution(trades);
  const sourceProfitFactor =
    typeof artifact.aggregate?.profit_factor_ppm === 'number'
      ? artifact.aggregate.profit_factor_ppm / 1_000_000
      : distribution.profit_factor;
  const anchoredDistribution = {
    ...distribution,
    profit_factor: round(sourceProfitFactor, 6),
    trade_sum_profit_factor: distribution.profit_factor,
  };
  const counts = exitCounts(trades);
  if (distribution.trades !== EXPECTED_ANCHORS.trades) {
    throw new Error(`Trade count mismatch: expected ${EXPECTED_ANCHORS.trades}, observed ${distribution.trades}`);
  }
  if (distribution.net_pnl_cents !== EXPECTED_ANCHORS.net_pnl_cents) {
    throw new Error(
      `Net PnL mismatch: expected ${EXPECTED_ANCHORS.net_pnl_cents}, observed ${distribution.net_pnl_cents}`,
    );
  }
  assertClose(sourceProfitFactor, EXPECTED_ANCHORS.profit_factor, 'Profit factor');
  for (const [reason, expected] of Object.entries({
    fail_safe: EXPECTED_ANCHORS.fail_safe,
    session_close: EXPECTED_ANCHORS.session_close,
    stop_loss: EXPECTED_ANCHORS.stop_loss,
    target: EXPECTED_ANCHORS.target,
  })) {
    if ((counts[reason] ?? 0) !== expected) {
      throw new Error(`Exit count mismatch for ${reason}: expected ${expected}, observed ${counts[reason] ?? 0}`);
    }
  }

  const returns = trades.map((trade) => trade.returnUnit);
  const pointKelly = generalizedKelly(returns);
  const iidBootstrap = bootstrap(trades, 'iid');
  const sessionBlockBootstrap = bootstrap(trades, 'session_block');
  const tiers = TIER_DEFINITIONS.map((tier) => summarizeTier(tier.name, trades));
  const outOfScopeTrades = trades.filter((trade) => trade.tier === 'out_of_scope').length;
  const weightedMeanTierKelly =
    sum(tiers.map((tier) => tier.tier_generalized_kelly * tier.trades)) / sum(tiers.map((tier) => tier.trades));
  const tierKellyByName = new Map<TierName, number>(tiers.map((tier) => [tier.tier, tier.tier_generalized_kelly]));
  const positivePointKelly = Math.max(0, pointKelly.fraction);
  const simulations = [
    simulate('flat_0_5pct', trades, lossUnitCents, () => 0.005),
    simulate('flat_1_0pct', trades, lossUnitCents, () => 0.01),
    simulate('flat_2_0pct', trades, lossUnitCents, () => 0.02),
    simulate('generalized_quarter_kelly', trades, lossUnitCents, () => positivePointKelly * 0.25),
    simulate('generalized_half_kelly', trades, lossUnitCents, () => positivePointKelly * 0.5),
    simulate('tier_tilted_1_0pct_baseline', trades, lossUnitCents, (trade) => {
      if (trade.tier === 'out_of_scope' || weightedMeanTierKelly <= 0) {
        return 0.01;
      }
      return 0.01 * Math.max(0, (tierKellyByName.get(trade.tier) ?? 0) / weightedMeanTierKelly);
    }),
    simulate('tier_tilted_2_0pct_baseline', trades, lossUnitCents, (trade) => {
      if (trade.tier === 'out_of_scope' || weightedMeanTierKelly <= 0) {
        return 0.02;
      }
      return 0.02 * Math.max(0, (tierKellyByName.get(trade.tier) ?? 0) / weightedMeanTierKelly);
    }),
  ];

  const conservativeKellyP05 = Math.min(
    iidBootstrap.generalized_kelly.p05,
    sessionBlockBootstrap.generalized_kelly.p05,
  );
  const routingCode =
    pointKelly.fraction <= 0
      ? 'SIZING_RESEARCH_NOT_JUSTIFIED'
      : conservativeKellyP05 <= 0
        ? 'EDGE_TOO_UNSTABLE_FOR_SIZING'
        : distribution.profit_factor < 1.35
          ? 'SIZING_RESEARCH_EVIDENCE_SUPPORTED_BUT_NO_VERDICT_AUTHORITY'
          : 'SIZING_RESEARCH_EVIDENCE_SUPPORTED_REQUIRES_GOVERNANCE_REVIEW';

  const fieldInventory = [
    ['trade timestamp / UTC entry hour', 'available', 'entry_ts_ns'],
    ['net PnL cents', 'available', 'net_pnl_cents'],
    ['entry quantity / exit quantity', 'available', 'entry_quantity / exit_quantity'],
    ['session/window id', 'partially available', 'session_id available; window id derivable only from trade_id/session ordering'],
    ['chronological trade order', 'available', 'entry_ts_ns plus trade_id tie-break'],
    ['R-multiple or risk basis field', 'unavailable', `fixed empirical loss-unit denominator ${round(lossUnitCents, 6)} cents used`],
  ];

  const output: JsonValue = {
    authority_caveat:
      'Evidence only. v2 remains REGISTERED_INACTIVE; no sizing policy, paper, broker/live, Phase 6, ADR-0016, or ADR-0024 authority is created.',
    bootstrap: {
      block_method:
        'session block bootstrap; sessions sampled with replacement, trades preserved in chronological order, truncated to source trade count',
      iid: iidBootstrap as unknown as JsonValue,
      iterations: BOOTSTRAP_ITERATIONS,
      seed: BOOTSTRAP_SEED,
      session_block: sessionBlockBootstrap as unknown as JsonValue,
    },
    field_inventory: fieldInventory.map(([field, status, source]) => ({ field, source, status })),
    generalized_kelly: {
      boundary: pointKelly.boundary,
      feasible_lower: round(pointKelly.feasibleLower, 6),
      feasible_upper: round(pointKelly.feasibleUpper, 6),
      mean_log_growth: round(pointKelly.meanLogGrowth, 8),
      point_estimate: round(pointKelly.fraction, 6),
      return_denominator:
        'net PnL cents divided by empirical average absolute losing-trade net loss from the corrected-engine artifact',
      return_denominator_cents: round(lossUnitCents, 6),
      signed_optimizer:
        'fraction maximizes mean(log(1 + f * r_i)); negative f is allowed only to detect negative edge and is not a deployment recommendation',
    },
    risk_summary: {
      account_basis_cents: STARTING_EQUITY_CENTS,
      single_contract_max_drawdown_cents: maxDrawdownCents(trades.map((trade) => trade.netPnlCents)),
      sizing_simulation_ruin_proxy: `ruin proxy breaches if equity <= 0 or max drawdown >= ${formatPct(
        RUIN_DRAWDOWN_THRESHOLD,
      )}`,
    },
    routing: {
      code: routingCode,
      rationale:
        routingCode === 'SIZING_RESEARCH_EVIDENCE_SUPPORTED_BUT_NO_VERDICT_AUTHORITY'
          ? 'Generalized Kelly is positive and the conservative bootstrap 5th percentile is positive, but PF remains below the ADR-0016 1.35 pass gate.'
          : 'Computed from locked routing rules.',
    },
    schema_version: 1,
    sizing_simulations: simulations as unknown as JsonValue,
    source_artifact: {
      anchors_observed: {
        exit_counts: counts,
        net_pnl_cents: distribution.net_pnl_cents,
        profit_factor: round(sourceProfitFactor, 6),
        trades: distribution.trades,
      },
      path: SOURCE_ARTIFACT_PATH,
      sha256: sourceSha,
      strategy_id: STRATEGY_ID,
    },
    source_substrate: {
      base: `origin/main@${SUBSTRATE_SHA}`,
      dependency: 'PR #281 corrected-engine v2 artifact',
    },
    ticket: TICKET,
    time_of_day_tiers: {
      out_of_scope_trade_count: outOfScopeTrades,
      tiers: tiers as unknown as JsonValue,
      weighted_mean_tier_generalized_kelly: round(weightedMeanTierKelly, 6),
    },
    trade_distribution: anchoredDistribution as unknown as JsonValue,
  };

  const artifactMarkdown = [
    `# ${TICKET} sizing evidence artifact`,
    '',
    '## Source artifact anchors',
    '',
    markdownTable(
      ['Field', 'Observed'],
      [
        ['SHA-256', sourceSha],
        ['Trades', distribution.trades],
        ['Net PnL', formatDollars(distribution.net_pnl_cents)],
        ['PF', sourceProfitFactor.toFixed(6)],
        ['Stop-loss exits', counts.stop_loss ?? 0],
        ['Target exits', counts.target ?? 0],
        ['Fail-safe exits', counts.fail_safe ?? 0],
        ['Session-close exits', counts.session_close ?? 0],
      ],
    ),
    '',
    '## Trade distribution',
    '',
    markdownTable(
      ['Metric', 'Value'],
      [
        ['Gross profit', formatDollars(distribution.gross_profit_cents)],
        ['Gross loss', formatDollars(distribution.gross_loss_cents)],
        ['Average trade', formatDollars(Math.round(distribution.average_trade_cents))],
        ['Average win', formatDollars(Math.round(distribution.average_win_cents))],
        ['Average loss unit', formatDollars(Math.round(lossUnitCents))],
        ['Win rate', formatPct(distribution.win_rate)],
        ['Single-contract max drawdown', formatDollars(maxDrawdownCents(trades.map((trade) => trade.netPnlCents)))],
      ],
    ),
    '',
    '## Generalized Kelly',
    '',
    markdownTable(
      ['Item', 'Value'],
      [
        ['Point estimate', formatPct(pointKelly.fraction)],
        ['Return denominator', `${round(lossUnitCents, 6)} cents average absolute losing trade`],
        ['Feasible lower', formatPct(pointKelly.feasibleLower)],
        ['Feasible upper', formatPct(pointKelly.feasibleUpper)],
        ['Boundary', pointKelly.boundary],
      ],
    ),
    '',
    'Classic binary Kelly is not used as a recommendation basis because it collapses the realized distribution shape.',
    '',
    '## Bootstrap robustness',
    '',
    markdownTable(
      ['Mode', 'PF p05/p50/p95', 'Net PnL p05/p50/p95', 'Kelly p05/p50/p95', 'P(K<0)', 'P(K<2.5%)', 'P(K<5%)'],
      [
        [
          'i.i.d.',
          `${iidBootstrap.profit_factor.p05.toFixed(6)} / ${iidBootstrap.profit_factor.p50.toFixed(6)} / ${iidBootstrap.profit_factor.p95.toFixed(6)}`,
          `${formatDollars(iidBootstrap.net_pnl_cents.p05)} / ${formatDollars(iidBootstrap.net_pnl_cents.p50)} / ${formatDollars(iidBootstrap.net_pnl_cents.p95)}`,
          `${formatPct(iidBootstrap.generalized_kelly.p05)} / ${formatPct(iidBootstrap.generalized_kelly.p50)} / ${formatPct(iidBootstrap.generalized_kelly.p95)}`,
          formatPct(iidBootstrap.generalized_kelly.probability_below_0),
          formatPct(iidBootstrap.generalized_kelly.probability_below_2_5pct),
          formatPct(iidBootstrap.generalized_kelly.probability_below_5pct),
        ],
        [
          'session-block',
          `${sessionBlockBootstrap.profit_factor.p05.toFixed(6)} / ${sessionBlockBootstrap.profit_factor.p50.toFixed(6)} / ${sessionBlockBootstrap.profit_factor.p95.toFixed(6)}`,
          `${formatDollars(sessionBlockBootstrap.net_pnl_cents.p05)} / ${formatDollars(sessionBlockBootstrap.net_pnl_cents.p50)} / ${formatDollars(sessionBlockBootstrap.net_pnl_cents.p95)}`,
          `${formatPct(sessionBlockBootstrap.generalized_kelly.p05)} / ${formatPct(sessionBlockBootstrap.generalized_kelly.p50)} / ${formatPct(sessionBlockBootstrap.generalized_kelly.p95)}`,
          formatPct(sessionBlockBootstrap.generalized_kelly.probability_below_0),
          formatPct(sessionBlockBootstrap.generalized_kelly.probability_below_2_5pct),
          formatPct(sessionBlockBootstrap.generalized_kelly.probability_below_5pct),
        ],
      ],
    ),
    '',
    '## Time-of-day tiers',
    '',
    markdownTable(
      ['Tier', 'UTC hours', 'n', 'PF', 'Win rate', 'Kelly', 'Sample warning'],
      tiers.map((tier) => [
        tier.tier,
        tier.hours_utc,
        tier.trades,
        tier.profit_factor.toFixed(6),
        formatPct(tier.win_rate),
        formatPct(tier.tier_generalized_kelly),
        tier.sample_size_warning,
      ]),
    ),
    '',
    '## Sizing simulations',
    '',
    markdownTable(
      ['Simulation', 'Final equity', 'Return', 'Max DD', 'Mean risk', 'Ruin proxy'],
      simulations.map((simulation) => [
        simulation.name,
        formatDollars(simulation.final_equity_cents),
        formatPct(simulation.total_return_pct),
        formatPct(simulation.max_drawdown_pct),
        formatPct(simulation.risk_fraction_mean),
        simulation.ruin_proxy_breached ? 'yes' : 'no',
      ]),
    ),
    '',
    '## Routing',
    '',
    `Routing code: \`${routingCode}\`.`,
    '',
    'Sizing can change dollars, drawdown, and geometric growth. It does not change the underlying profit factor of the trade distribution. PR #281 left v2 below the ADR-0016 PF gate at PF 1.241954.',
  ].join('\n');

  const memo = [
    `# ${TICKET} memo`,
    '',
    '## 1. Context',
    '',
    `This memo re-derives Kelly and tiered-sizing evidence for \`${STRATEGY_ID}\` using the corrected-engine PR #281 artifact. It is evidence only: no sizing policy, risk configuration, strategy code, roster state, paper observation, broker/live dispatch, Phase 6, ADR-0016, or ADR-0024 authority changes are made.`,
    '',
    '## 2. Source artifact',
    '',
    markdownTable(
      ['Field', 'Value'],
      [
        ['Substrate', `origin/main@${SUBSTRATE_SHA}`],
        ['Artifact', SOURCE_ARTIFACT_PATH],
        ['SHA-256', sourceSha],
        ['Trades', distribution.trades],
        ['Net PnL', formatDollars(distribution.net_pnl_cents)],
        ['PF', sourceProfitFactor.toFixed(6)],
      ],
    ),
    '',
    'All trades are standard single-contract replay trades: every parsed trade has `entry_quantity = 1` and `exit_quantity = 1`.',
    '',
    '## 3. Why prior sizing memo is stale',
    '',
    'The prior sizing memo used the older 571-trade Cycle3 post-fix substrate. PR #281 regenerated the corrected-engine v2 evidence with 1098 trades, PF 1.241954, and +$1,842.00 net PnL. The older memo is retained as historical context only; this ticket uses the PR #281 artifact as the authoritative source.',
    '',
    '## 4. Distribution summary',
    '',
    markdownTable(
      ['Metric', 'Value'],
      [
        ['Trades', distribution.trades],
        ['Wins / losses / zero', `${distribution.wins} / ${distribution.losses} / ${distribution.zeros}`],
        ['Gross profit', formatDollars(distribution.gross_profit_cents)],
        ['Gross loss', formatDollars(distribution.gross_loss_cents)],
        ['Average trade', formatDollars(Math.round(distribution.average_trade_cents))],
        ['Average win', formatDollars(Math.round(distribution.average_win_cents))],
        ['Average loss unit', formatDollars(Math.round(lossUnitCents))],
        ['Win rate', formatPct(distribution.win_rate)],
      ],
    ),
    '',
    'The field inventory was sufficient for this diagnostic: UTC entry hour, net PnL, quantities, session id, and chronological order are available. A native R-multiple field is not serialized, so generalized Kelly uses the fixed empirical average absolute losing-trade net loss as the declared return denominator.',
    '',
    '## 5. Generalized Kelly result',
    '',
    `The generalized log-utility Kelly point estimate is **${formatPct(pointKelly.fraction)}**. The optimizer maximizes \`mean(log(1 + f * r_i))\`, where \`r_i\` is net PnL cents divided by the fixed loss-unit denominator of ${round(lossUnitCents, 6)} cents.`,
    '',
    'Classic binary Kelly is intentionally not used as a recommendation basis because it ignores distribution shape and variance.',
    '',
    '## 6. Bootstrap robustness',
    '',
    `Bootstrap is deterministic: seed ${BOOTSTRAP_SEED}, ${BOOTSTRAP_ITERATIONS} iterations, i.i.d. trade resampling plus session-block resampling that preserves chronological trades within sampled sessions.`,
    '',
    markdownTable(
      ['Mode', 'Kelly p05', 'Kelly p50', 'Kelly p95', 'P(K<0)', 'P(K<2.5%)', 'P(K<5%)'],
      [
        [
          'i.i.d.',
          formatPct(iidBootstrap.generalized_kelly.p05),
          formatPct(iidBootstrap.generalized_kelly.p50),
          formatPct(iidBootstrap.generalized_kelly.p95),
          formatPct(iidBootstrap.generalized_kelly.probability_below_0),
          formatPct(iidBootstrap.generalized_kelly.probability_below_2_5pct),
          formatPct(iidBootstrap.generalized_kelly.probability_below_5pct),
        ],
        [
          'session-block',
          formatPct(sessionBlockBootstrap.generalized_kelly.p05),
          formatPct(sessionBlockBootstrap.generalized_kelly.p50),
          formatPct(sessionBlockBootstrap.generalized_kelly.p95),
          formatPct(sessionBlockBootstrap.generalized_kelly.probability_below_0),
          formatPct(sessionBlockBootstrap.generalized_kelly.probability_below_2_5pct),
          formatPct(sessionBlockBootstrap.generalized_kelly.probability_below_5pct),
        ],
      ],
    ),
    '',
    'Both bootstrap modes keep the 5th percentile above zero, supporting continued sizing research as evidence. This is not sizing-policy authority.',
    '',
    '## 7. Time-of-day tier analysis',
    '',
    markdownTable(
      ['Tier', 'UTC hours', 'n', 'PF', 'Kelly', 'Warning'],
      tiers.map((tier) => [
        tier.tier,
        tier.hours_utc,
        tier.trades,
        tier.profit_factor.toFixed(6),
        formatPct(tier.tier_generalized_kelly),
        tier.sample_size_warning,
      ]),
    ),
    '',
    'The tiers are pre-specified from the packet and were not re-bucketed after observing results. Any tier-level interpretation remains diagnostic and sample-size-bounded.',
    '',
    '## 8. Sizing simulations',
    '',
    'Simulations compound from a fixed $50,000 diagnostic account basis. Each trade scales linearly from the empirical single-contract net PnL distribution using the same fixed loss-unit denominator. Drawdown is peak-to-trough equity drawdown; the ruin proxy trips if equity falls to zero or max drawdown reaches 50%.',
    '',
    markdownTable(
      ['Simulation', 'Final equity', 'Return', 'Max DD', 'Ruin proxy'],
      simulations.map((simulation) => [
        simulation.name,
        formatDollars(simulation.final_equity_cents),
        formatPct(simulation.total_return_pct),
        formatPct(simulation.max_drawdown_pct),
        simulation.ruin_proxy_breached ? 'yes' : 'no',
      ]),
    ),
    '',
    'These simulations illustrate dollars, drawdown, and geometric growth sensitivity. They do not authorize a deployable sizing policy.',
    '',
    '## 9. What sizing can and cannot fix',
    '',
    'Sizing can change dollars, drawdown, and geometric growth. It does not change the underlying profit factor of the trade distribution. PR #281 left v2 below the ADR-0016 PF gate at PF 1.241954.',
    '',
    `The resulting route is \`${routingCode}\`: generalized Kelly is positive and the conservative bootstrap 5th percentile is positive, but the PF gate remains failed.`,
    '',
    '## 10. Recommended next ticket',
    '',
    'Sizing research remains justified as evidence, but no sizing policy should be proposed from this memo alone. A future ticket, if desired, should be an explicit sizing-methodology scoping packet that separates evidence-supported capacity from ADR-authorized sizing policy.',
    '',
    '## 11. Verification',
    '',
    'The deterministic extractor regenerates the JSON artifact, Markdown artifact, memo, and backlog row. Required verification commands and determinism hashes are reported in the worker PENDING-REVIEW note.',
    '',
    '## 12. Authority caveat',
    '',
    '`regime_shock_reversion_short_v2` remains REGISTERED_INACTIVE. This PR does not activate any strategy, does not authorize paper observation, does not authorize broker/live dispatch, does not create Phase 6 authority, does not change ADR-0016/ADR-0024 authority, and does not set any sizing policy.',
  ].join('\n');

  writeDeterministic(OUTPUT_JSON_PATH, stableJson(output));
  writeDeterministic(OUTPUT_MD_PATH, artifactMarkdown);
  writeDeterministic(MEMO_PATH, memo);
  updateBacklog();

  const paths = [OUTPUT_JSON_PATH, OUTPUT_MD_PATH, MEMO_PATH, BACKLOG_PATH];
  for (const path of paths) {
    console.log(`${path} ${fileLfSha256(path)}`);
  }
  console.log(`generalized_kelly=${round(pointKelly.fraction, 6)}`);
  console.log(
    `bootstrap_iid_kelly_5_50_95=${iidBootstrap.generalized_kelly.p05},${iidBootstrap.generalized_kelly.p50},${iidBootstrap.generalized_kelly.p95}`,
  );
  console.log(
    `bootstrap_session_block_kelly_5_50_95=${sessionBlockBootstrap.generalized_kelly.p05},${sessionBlockBootstrap.generalized_kelly.p50},${sessionBlockBootstrap.generalized_kelly.p95}`,
  );
  console.log(`routing=${routingCode}`);
}

main();
