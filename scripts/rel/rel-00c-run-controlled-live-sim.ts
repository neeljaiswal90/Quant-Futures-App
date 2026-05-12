import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import {
  argv as processArgv,
  cwd as processCwd,
  exit as processExit,
  stderr as processStderr,
  stdout as processStdout,
} from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  loadAppConfig,
} from '../../apps/strategy_runtime/src/config/index.js';
import {
  createJournalEventEnvelope,
  formatJournalEventSchemaValidationErrors,
  journalEventFromJsonLine,
  makeConfigHash,
  makeEventId,
  makeFeatureSnapshotId,
  makeRunId,
  makeSessionId,
  stableJsonStringify,
  validateJournalEventEnvelope,
  type AnyJournalEventEnvelope,
  type EventId,
  type JournalEventEnvelope,
  type JournalEventPayloadFor,
  type JsonValue,
  type RuntimeEventType,
  type UnixNs,
} from '../../apps/strategy_runtime/src/contracts/index.js';
import {
  buildFeatureAvailabilityMask,
  type FeatureAvailabilityTier,
} from '../../apps/strategy_runtime/src/features/availability-mask.js';
import {
  createSimulatedExecutionAdapter,
} from '../../apps/strategy_runtime/src/execution/simulated-execution.js';
import {
  createStrategyRuntimeEngineContainer,
  StrategyRuntimeRunner,
} from '../../apps/strategy_runtime/src/orchestration/index.js';
import {
  loadVenueCostTable,
} from '../../apps/strategy_runtime/src/risk/index.js';
import type {
  StrategyFeatureSnapshot,
  StrategyScalarMap,
} from '../../apps/strategy_runtime/src/strategies/index.js';
import { createNullSignedShockMeasurement } from '../../apps/strategy_runtime/src/strategies/index.js';
import {
  sha256File,
  forEachJsonlLine,
} from '../sim/streaming-jsonl.js';

export const REL_00C_REPORT_SCHEMA_VERSION = 1 as const;
export const REL_00C_GENERATOR_VERSION = 'rel00c-controlled-live-sim-runner-v1' as const;
const DEFAULT_OUT_JOURNAL = 'reports/rel/rel00_controlled_live_sim_journal.jsonl';
const DEFAULT_REPORT = 'reports/rel/rel00c_controlled_live_sim_generation_report.json';
const DEFAULT_CONFIG_PATH = 'config/app.example.json';
const SIMULATED_EXECUTION_ADAPTER = 'simulated' as const;
const REL01_STATUS = 'pending' as const;
const NO_RAW_DATA_STATEMENT =
  'REL-00C reports source paths, hashes, counts, safety posture, and field names only. It does not embed raw market-data rows, feature payload values, DBN files, or order payload values.';
const BLOCKED_EVENT_TYPES = new Set<string>([
  'ORDER_PLANT',
  'LIVE_ORDER',
  'BROKER_ORDER',
  'ORDER_ACK',
  'ORDER_FILL',
  'ORDER_CANCEL',
  'ORDER_REPLACE',
  'EXECUTION_REPORT',
  'LIVE_FILL',
]);

export function assertRel00cWritableEventType(eventType: string): void {
  if (BLOCKED_EVENT_TYPES.has(eventType)) {
    throw new Error(`REL-00C refused to write blocked real-order event type: ${eventType}`);
  }
}

type Rel00cStatus = 'generated' | 'requires_source_journals' | 'failed';
export type Rel00cExitCode = 0 | 2 | 3;

export interface Rel00cOptions {
  readonly cwd?: string;
  readonly l1_trade_journal: string;
  readonly mbp10_price_state_journal: string;
  readonly out_journal?: string;
  readonly report?: string;
  readonly run_id: string;
  readonly session_id: string;
  readonly max_feature_snapshots?: number;
}

export interface Rel00cReport {
  readonly schema_version: typeof REL_00C_REPORT_SCHEMA_VERSION;
  readonly ticket_id: 'REL-00C';
  readonly generator_version: typeof REL_00C_GENERATOR_VERSION;
  readonly status: Rel00cStatus;
  readonly source_journals: {
    readonly l1_trade: SourceJournalSummary;
    readonly mbp10_price_state: SourceJournalSummary;
  };
  readonly output: {
    readonly out_journal: string;
    readonly out_journal_hash: string | null;
    readonly report: string;
  };
  readonly source_events_consumed: number;
  readonly feature_snapshots_generated: number;
  readonly order_intents_emitted: number;
  readonly sim_fills_emitted: number;
  readonly exec_rejects_emitted: number;
  readonly real_order_event_types_emitted: number;
  readonly blocked_feature_fields_used: readonly string[];
  readonly restricted_feature_fields_used: readonly string[];
  readonly unknown_internal_indicator_fields: readonly string[];
  readonly execution_adapter: typeof SIMULATED_EXECUTION_ADAPTER;
  readonly safety_posture: {
    readonly market_data_source: 'rithmic_live_capture';
    readonly execution_mode: 'simulated_only';
    readonly real_orders_allowed: false;
    readonly accepted_feature_surface_only: true;
    readonly mbo_derived_features_allowed: false;
  };
  readonly rel00_validation_command: string;
  readonly sim03_ready_for_rel01_execution_simulation: boolean | null;
  readonly rel01_status: typeof REL01_STATUS;
  readonly no_raw_data_statement: typeof NO_RAW_DATA_STATEMENT;
  readonly reasons: readonly string[];
  readonly next_blocker: string;
}

interface SourceJournalSummary {
  readonly path: string;
  readonly exists: boolean;
  readonly sha256: string | null;
  readonly events_scanned: number;
  readonly events_used_for_runtime: number;
  readonly parse_error_count: number;
}

interface LoadedSourceEvents {
  readonly events: readonly L1TradeEvent[];
  readonly summary: SourceJournalSummary;
}

interface MutableSourceJournalSummary {
  path: string;
  exists: boolean;
  sha256: string | null;
  events_scanned: number;
  events_used_for_runtime: number;
  parse_error_count: number;
}

interface MarketBuilderState {
  quote?: JournalEventEnvelope<'QUOTE', JournalEventPayloadFor<'QUOTE'>>;
  lastTrade?: JournalEventEnvelope<'TRADE', JournalEventPayloadFor<'TRADE'>>;
  priceHistory: number[];
  bars: MutableBar[];
  tradeAggressorWindow: number[];
  featureCounter: number;
}

interface MutableBar {
  minuteStartNs: bigint;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number;
}

interface RuntimeCounters {
  eventCounts: Map<string, number>;
  featureFields: Map<string, FeatureAvailabilityTier | 'unknown_internal'>;
  blockedFeatureFields: Set<string>;
  restrictedFeatureFields: Set<string>;
  unknownInternalIndicatorFields: Set<string>;
  realOrderEventTypes: Set<string>;
}

type L1TradeEvent =
  | JournalEventEnvelope<'QUOTE', JournalEventPayloadFor<'QUOTE'>>
  | JournalEventEnvelope<'TRADE', JournalEventPayloadFor<'TRADE'>>;

type MutableRel00cOptions = {
  -readonly [K in keyof Rel00cOptions]?: Rel00cOptions[K];
};

class RuntimeJournalWriter {
  private readonly fd: number;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, 'w');
  }

  write(event: AnyJournalEventEnvelope): void {
    writeSync(this.fd, `${stableJsonStringify(toSerializableJson(event))}\n`, null, 'utf8');
  }

  close(): void {
    closeSync(this.fd);
  }
}

export async function runRel00cControlledLiveSim(
  options: Rel00cOptions,
): Promise<{ readonly report: Rel00cReport; readonly exit_code: Rel00cExitCode }> {
  const cwd = resolve(options.cwd ?? processCwd());
  const l1TradePath = resolve(cwd, options.l1_trade_journal);
  const mbp10Path = resolve(cwd, options.mbp10_price_state_journal);
  const outJournal = resolve(cwd, options.out_journal ?? DEFAULT_OUT_JOURNAL);
  const reportPath = resolve(cwd, options.report ?? DEFAULT_REPORT);
  mkdirSync(dirname(reportPath), { recursive: true });

  const missing = [
    ...(existsSync(l1TradePath) ? [] : [`l1_trade_journal:${toReportPath(cwd, l1TradePath)}`]),
    ...(existsSync(mbp10Path) ? [] : [`mbp10_price_state_journal:${toReportPath(cwd, mbp10Path)}`]),
  ];
  if (missing.length > 0) {
    const report = buildReport({
      cwd,
      status: 'requires_source_journals',
      l1Summary: emptySourceSummary(cwd, l1TradePath),
      mbp10Summary: emptySourceSummary(cwd, mbp10Path),
      outJournal,
      reportPath,
      outJournalHash: null,
      counters: emptyRuntimeCounters(),
      featureSnapshotsGenerated: 0,
      sim03Ready: readSim03Ready(cwd),
      reasons: missing,
    });
    writeReport(reportPath, report);
    return { report, exit_code: 2 };
  }

  let source: LoadedSourceEvents;
  let mbp10Summary: SourceJournalSummary;
  try {
    source = loadL1TradeEvents(cwd, l1TradePath, options.run_id, options.session_id);
    mbp10Summary = scanSourceJournal(cwd, mbp10Path);
  } catch (error) {
    const report = buildReport({
      cwd,
      status: 'failed',
      l1Summary: existsSync(l1TradePath)
        ? safeSummary(cwd, l1TradePath)
        : emptySourceSummary(cwd, l1TradePath),
      mbp10Summary: existsSync(mbp10Path)
        ? safeSummary(cwd, mbp10Path)
        : emptySourceSummary(cwd, mbp10Path),
      outJournal,
      reportPath,
      outJournalHash: null,
      counters: emptyRuntimeCounters(),
      featureSnapshotsGenerated: 0,
      sim03Ready: readSim03Ready(cwd),
      reasons: [errorMessage(error)],
    });
    writeReport(reportPath, report);
    return { report, exit_code: 3 };
  }

  const config = loadAppConfig({
    configPath: DEFAULT_CONFIG_PATH,
    cwd,
    env: {
      QFA_JOURNAL_DIR: dirname(outJournal),
    },
  });
  const container = createStrategyRuntimeEngineContainer({ config });
  const writer = new RuntimeJournalWriter(outJournal);
  const counters = emptyRuntimeCounters();
  container.eventBus.subscribe({}, (delivery) => {
    const event = delivery.event as AnyJournalEventEnvelope;
    assertRel00cWritableEventType(event.type);
    recordRuntimeEvent(counters, event);
    writer.write(event);
  });

  const runner = new StrategyRuntimeRunner({
    container,
    run_id: makeRunId(options.run_id),
    session_id: makeSessionId(options.session_id),
    execution_adapter: createSimulatedExecutionAdapter({
      venue_costs: loadVenueCostTable(),
    }),
  });

  const builder: MarketBuilderState = {
    priceHistory: [],
    bars: [],
    tradeAggressorWindow: [],
    featureCounter: 0,
  };
  let featureSnapshotsGenerated = 0;
  const maxFeatureSnapshots = options.max_feature_snapshots;

  try {
    for (const event of source.events) {
      await runner.publishExternalEvent(event);
      updateMarketBuilder(builder, event);
      if (maxFeatureSnapshots !== undefined && featureSnapshotsGenerated >= maxFeatureSnapshots) {
        continue;
      }
      const snapshot = buildFeatureSnapshot(builder, event, options.session_id, config.lineage.config_hash, config.lineage.config_version);
      if (snapshot === undefined) {
        continue;
      }
      await runner.processFeatureSnapshot(snapshot);
      featureSnapshotsGenerated += 1;
    }
  } finally {
    writer.close();
  }

  const outJournalHash = sha256File(outJournal);
  const reasons = source.events.length === 0 ? ['no_quote_or_trade_source_events'] : [];
  const status: Rel00cStatus = reasons.length === 0 ? 'generated' : 'failed';
  const report = buildReport({
    cwd,
    status,
    l1Summary: source.summary,
    mbp10Summary,
    outJournal,
    reportPath,
    outJournalHash,
    counters,
    featureSnapshotsGenerated,
    sim03Ready: readSim03Ready(cwd),
    reasons,
  });
  writeReport(reportPath, report);
  return { report, exit_code: status === 'generated' ? 0 : 2 };
}

function loadL1TradeEvents(
  cwd: string,
  path: string,
  runId: string,
  sessionId: string,
): LoadedSourceEvents {
  const digest = createHash('sha256');
  const events: L1TradeEvent[] = [];
  const summary: MutableSourceJournalSummary = {
    path: toReportPath(cwd, path),
    exists: true,
    sha256: null,
    events_scanned: 0,
    events_used_for_runtime: 0,
    parse_error_count: 0,
  };
  let lineNumber = 0;
  forEachJsonlLine(path, (line) => {
    lineNumber += 1;
    if (line.trim() === '') {
      return;
    }
    let event: JournalEventEnvelope;
    try {
      event = journalEventFromJsonLine(line);
      assertValidEvent(event, `${summary.path}:${lineNumber}`);
    } catch (error) {
      summary.parse_error_count += 1;
      throw new Error(`malformed L1/trade source journal at ${summary.path}:${lineNumber}: ${errorMessage(error)}`);
    }
    summary.events_scanned += 1;
    if (event.type !== 'QUOTE' && event.type !== 'TRADE') {
      return;
    }
    events.push(rewriteSourceEvent(event, runId, sessionId));
    summary.events_used_for_runtime += 1;
  }, { digest });
  summary.sha256 = digest.digest('hex');
  events.sort(compareSourceEvents);
  return { events, summary };
}

function scanSourceJournal(cwd: string, path: string): SourceJournalSummary {
  const digest = createHash('sha256');
  const summary: MutableSourceJournalSummary = {
    path: toReportPath(cwd, path),
    exists: true,
    sha256: null,
    events_scanned: 0,
    events_used_for_runtime: 0,
    parse_error_count: 0,
  };
  let lineNumber = 0;
  forEachJsonlLine(path, (line) => {
    lineNumber += 1;
    if (line.trim() === '') {
      return;
    }
    try {
      const event = journalEventFromJsonLine(line);
      assertValidEvent(event, `${summary.path}:${lineNumber}`);
    } catch (error) {
      summary.parse_error_count += 1;
      throw new Error(`malformed MBP10 price-state source journal at ${summary.path}:${lineNumber}: ${errorMessage(error)}`);
    }
    summary.events_scanned += 1;
  }, { digest });
  summary.sha256 = digest.digest('hex');
  return summary;
}

function rewriteSourceEvent(
  event: JournalEventEnvelope,
  runId: string,
  sessionId: string,
): L1TradeEvent {
  if (event.type === 'QUOTE') {
    return createJournalEventEnvelope({
      event_id: makeEventId(String(event.event_id)),
      type: 'QUOTE',
      ts_ns: event.ts_ns,
      run_id: makeRunId(runId),
      session_id: makeSessionId(sessionId),
      payload: event.payload as JournalEventPayloadFor<'QUOTE'>,
      ...(event.causation_id === undefined ? {} : { causation_id: event.causation_id }),
      ...(event.correlation_id === undefined ? {} : { correlation_id: event.correlation_id }),
      ...(event.config === undefined ? {} : { config: event.config }),
    });
  }
  if (event.type === 'TRADE') {
    return createJournalEventEnvelope({
      event_id: makeEventId(String(event.event_id)),
      type: 'TRADE',
      ts_ns: event.ts_ns,
      run_id: makeRunId(runId),
      session_id: makeSessionId(sessionId),
      payload: event.payload as JournalEventPayloadFor<'TRADE'>,
      ...(event.causation_id === undefined ? {} : { causation_id: event.causation_id }),
      ...(event.correlation_id === undefined ? {} : { correlation_id: event.correlation_id }),
      ...(event.config === undefined ? {} : { config: event.config }),
    });
  }
  throw new Error(`unsupported source event type ${event.type}`);
}

function updateMarketBuilder(
  builder: MarketBuilderState,
  event: L1TradeEvent,
): void {
  if (event.type === 'QUOTE') {
    builder.quote = event;
    const payload = event.payload;
    pushPrice(builder, (payload.bid_px + payload.ask_px) / 2, event.ts_ns, 0, 0);
    return;
  }
  builder.lastTrade = event;
  const signed = event.payload.aggressor_side === 'buy'
    ? event.payload.quantity
    : event.payload.aggressor_side === 'sell'
      ? -event.payload.quantity
      : 0;
  builder.tradeAggressorWindow.push(signed);
  while (builder.tradeAggressorWindow.length > 50) {
    builder.tradeAggressorWindow.shift();
  }
  pushPrice(builder, event.payload.price, event.ts_ns, event.payload.quantity, 1);
}

function pushPrice(
  builder: MarketBuilderState,
  price: number,
  tsNs: UnixNs,
  volume: number,
  tradeCount: number,
): void {
  builder.priceHistory.push(price);
  while (builder.priceHistory.length > 200) {
    builder.priceHistory.shift();
  }
  const minuteStartNs = (BigInt(tsNs) / 60_000_000_000n) * 60_000_000_000n;
  const current = builder.bars[builder.bars.length - 1];
  if (current === undefined || current.minuteStartNs !== minuteStartNs) {
    builder.bars.push({
      minuteStartNs,
      open: price,
      high: price,
      low: price,
      close: price,
      volume,
      tradeCount,
    });
    while (builder.bars.length > 12) {
      builder.bars.shift();
    }
    return;
  }
  current.high = Math.max(current.high, price);
  current.low = Math.min(current.low, price);
  current.close = price;
  current.volume += volume;
  current.tradeCount += tradeCount;
}

function buildFeatureSnapshot(
  builder: MarketBuilderState,
  sourceEvent: L1TradeEvent,
  sessionId: string,
  configHash: string,
  configVersion: number,
): StrategyFeatureSnapshot | undefined {
  if (builder.quote === undefined || builder.lastTrade === undefined || builder.priceHistory.length < 3) {
    return undefined;
  }
  builder.featureCounter += 1;
  const quote = builder.quote.payload;
  const lastTrade = builder.lastTrade.payload;
  const mid = round4((quote.bid_px + quote.ask_px) / 2);
  const ema9 = ema(builder.priceHistory, 9);
  const ema21 = ema(builder.priceHistory, 21);
  const ema50 = ema(builder.priceHistory, 50);
  const sigmaPts = Math.max(0.25, round4(stddev(builder.priceHistory.slice(-50))));
  const trend = ema9 > ema21 ? 'up' : ema9 < ema21 ? 'down' : 'range';
  const flow = round4(sum(builder.tradeAggressorWindow) / Math.max(1, sumAbs(builder.tradeAggressorWindow)));
  const zFlow = trend === 'down' ? Math.abs(Math.min(0, flow)) : Math.max(0, flow);
  const bars = builder.bars.length >= 2 ? builder.bars : synthesizeBars(mid, sourceEvent.ts_ns);
  const featureSnapshotId = makeFeatureSnapshotId(`rel00c-${String(builder.featureCounter).padStart(12, '0')}`);
  const indicators: StrategyScalarMap = {
    l1_quote_bid_px: quote.bid_px,
    l1_quote_ask_px: quote.ask_px,
    last_trade_price: lastTrade.price,
    last_trade_size: lastTrade.quantity,
    last_trade_aggressor_side: lastTrade.aggressor_side,
    trade_aggressor_imbalance: flow,
    ema_9: round4(ema9),
    ema_21: round4(ema21),
    ema_50: round4(ema50),
    adx_14: null,
    atr_14_pts: null,
    vwap: round4(mean(builder.priceHistory.slice(-50))),
    atr_14: sigmaPts,
    sigma_pts: sigmaPts,
    z_ema9: clamp(round4(Math.abs(mid - ema9) / sigmaPts), 0.2, 0.9),
    pullback_ratio: 0.44,
    z_ofi_blend: clamp(zFlow, 0.25, 1),
    supertrend_direction: trend === 'down' ? 'down' : 'up',
  };
  const riskPts = Math.max(1, sigmaPts * 2);
  const structureValues: StrategyScalarMap = trend === 'down'
    ? {
        bos_direction: 'down',
        choch_buy: roundToTick(mid - riskPts * 2),
        nearest_support: roundToTick(mid - riskPts * 3),
        broken_support: roundToTick(mid + sigmaPts * 0.25),
        pivot_support_1: roundToTick(mid - riskPts * 3.5),
        retest_reject: true,
        pullback_depth_pts: round4(sigmaPts * 0.6),
      }
    : {
        bos_direction: 'up',
        choch_sell: roundToTick(mid + riskPts * 2),
        nearest_resistance: roundToTick(mid + riskPts * 3),
        breakout_level: roundToTick(mid - sigmaPts * 0.25),
        pivot_resistance_1: roundToTick(mid + riskPts * 3.5),
        retest_hold: true,
        pullback_depth_pts: round4(sigmaPts * 0.6),
      };
  return {
    feature_snapshot_id: featureSnapshotId,
    source_event_id: sourceEvent.event_id as EventId,
    created_ts_ns: sourceEvent.ts_ns,
    instrument: {
      root: 'MNQ',
      symbol: 'MNQM6',
      exchange: 'CME',
      currency: 'USD',
      contract_month: '2026-06',
      tick_size: 0.25,
      point_value: 2,
      price_decimals: 2,
    },
    session: {
      session_id: makeSessionId(sessionId),
      trading_date: sessionId.slice(0, 10),
      phase: 'rth',
      is_rth: true,
      is_halt: false,
      is_roll_block: false,
    },
    quote: {
      bid_px: quote.bid_px,
      ask_px: quote.ask_px,
      mid_px: mid,
    },
    last_trade_price: lastTrade.price,
    bars: bars.map((bar) => ({
      instrument: {
        root: 'MNQ',
        symbol: 'MNQM6',
        exchange: 'CME',
        currency: 'USD',
        contract_month: '2026-06',
        tick_size: 0.25,
        point_value: 2,
        price_decimals: 2,
      },
      timeframe: '1m',
      start_ts_ns: bar.minuteStartNs as UnixNs,
      end_ts_ns: (bar.minuteStartNs + 60_000_000_000n) as UnixNs,
      open: round4(bar.open),
      high: round4(bar.high),
      low: round4(bar.low),
      close: round4(bar.close),
      volume: round4(bar.volume),
      trade_count: bar.tradeCount,
    })),
    indicators,
    structure: {
      trend: trend === 'down' ? 'down' : 'up',
      values: structureValues,
    },
    microstructure: {
      l3_authority: 'unavailable',
      values: {
        spread_pts: round4(quote.ask_px - quote.bid_px),
        ofi_z: clamp(zFlow, 0.25, 1),
      },
    },
    context: {
      prior_day_close: null,
      prior_day_high: null,
      prior_day_low: null,
      today_open: bars[0] === undefined ? null : round4(bars[0].open),
      vix_value: null,
      vix_fresh: false,
      regime_label: 'unknown',
      opening_range_high: null,
      opening_range_low: null,
      opening_range_minutes_elapsed: 0,
      session_vwap: null,
      session_vwap_band_sigma_pts: null,
      overnight_return_bps: null,
      signed_shock_vwap: createNullSignedShockMeasurement('vwap'),
      signed_shock_prior_close: createNullSignedShockMeasurement('prior_close'),
    },
    config: {
      config_hash: makeConfigHash(configHash),
      config_version: configVersion,
    },
  };
}

function recordRuntimeEvent(counters: RuntimeCounters, event: AnyJournalEventEnvelope): void {
  counters.eventCounts.set(event.type, (counters.eventCounts.get(event.type) ?? 0) + 1);
  if (BLOCKED_EVENT_TYPES.has(event.type)) {
    counters.realOrderEventTypes.add(event.type);
  }
  if (event.type === 'FEATURES') {
    recordFeatureFields(counters, event.payload.values);
  }
  if (event.type === 'SIM_FILL' && event.payload.input_tier === 'blocked') {
    counters.blockedFeatureFields.add('SIM_FILL.input_tier=blocked');
  }
}

function recordFeatureFields(counters: RuntimeCounters, values: Readonly<Record<string, unknown>>): void {
  const mask = buildFeatureAvailabilityMask();
  for (const field of Object.keys(values)) {
    const canonical = canonicalFeatureField(field);
    const tier = (mask.field_tiers as Readonly<Record<string, FeatureAvailabilityTier>>)[canonical];
    if (tier === undefined) {
      counters.unknownInternalIndicatorFields.add(field);
      counters.featureFields.set(field, 'unknown_internal');
      continue;
    }
    counters.featureFields.set(canonical, tier);
    if (tier === 'blocked') {
      counters.blockedFeatureFields.add(canonical);
    } else if (tier !== 'authoritative') {
      counters.restrictedFeatureFields.add(canonical);
    }
  }
}

function canonicalFeatureField(field: string): string {
  // REL-00C only emits L1/trade accepted fields. REL-00 remains the broader validator for MBO/restricted aliases.
  const aliases: Record<string, string> = {
    bid_px: 'l1_quote_bid_px',
    ask_px: 'l1_quote_ask_px',
    last_price: 'last_trade_price',
    last_trade_px: 'last_trade_price',
    trade_size: 'last_trade_size',
    aggressor_side: 'last_trade_aggressor_side',
    spread_points: 'microstructure_spread_points',
    spread_ticks: 'microstructure_spread_ticks',
    mid_px: 'microstructure_mid_px',
  };
  return aliases[field] ?? field;
}

function buildReport(input: {
  readonly cwd: string;
  readonly status: Rel00cStatus;
  readonly l1Summary: SourceJournalSummary;
  readonly mbp10Summary: SourceJournalSummary;
  readonly outJournal: string;
  readonly reportPath: string;
  readonly outJournalHash: string | null;
  readonly counters: RuntimeCounters;
  readonly featureSnapshotsGenerated: number;
  readonly sim03Ready: boolean | null;
  readonly reasons: readonly string[];
}): Rel00cReport {
  return {
    schema_version: REL_00C_REPORT_SCHEMA_VERSION,
    ticket_id: 'REL-00C',
    generator_version: REL_00C_GENERATOR_VERSION,
    status: input.status,
    source_journals: {
      l1_trade: input.l1Summary,
      mbp10_price_state: input.mbp10Summary,
    },
    output: {
      out_journal: toReportPath(input.cwd, input.outJournal),
      out_journal_hash: input.outJournalHash,
      report: toReportPath(input.cwd, input.reportPath),
    },
    source_events_consumed: input.l1Summary.events_used_for_runtime,
    feature_snapshots_generated: input.featureSnapshotsGenerated,
    order_intents_emitted: input.counters.eventCounts.get('ORDER_INTENT') ?? 0,
    sim_fills_emitted: input.counters.eventCounts.get('SIM_FILL') ?? 0,
    exec_rejects_emitted: input.counters.eventCounts.get('EXEC_REJECT') ?? 0,
    real_order_event_types_emitted: input.counters.realOrderEventTypes.size,
    blocked_feature_fields_used: sorted([...input.counters.blockedFeatureFields]),
    restricted_feature_fields_used: sorted([...input.counters.restrictedFeatureFields]),
    unknown_internal_indicator_fields: sorted([...input.counters.unknownInternalIndicatorFields]),
    execution_adapter: SIMULATED_EXECUTION_ADAPTER,
    safety_posture: {
      market_data_source: 'rithmic_live_capture',
      execution_mode: 'simulated_only',
      real_orders_allowed: false,
      accepted_feature_surface_only: true,
      mbo_derived_features_allowed: false,
    },
    rel00_validation_command: [
      'npm run rel:00:controlled-live-sim --',
      `--journal ${toReportPath(input.cwd, input.outJournal)}`,
      `--out ${toReportPath(input.cwd, input.outJournal).replace(/\.jsonl$/u, '_report.json')}`,
      '--min-source-events 10000',
    ].join(' '),
    sim03_ready_for_rel01_execution_simulation: input.sim03Ready,
    rel01_status: REL01_STATUS,
    no_raw_data_statement: NO_RAW_DATA_STATEMENT,
    reasons: input.reasons,
    next_blocker: input.status === 'generated'
      ? 'Run REL-00 controlled live-sim validator against the generated runtime journal.'
      : 'Resolve REL-00C source/generation failure, then regenerate the runtime journal.',
  };
}

function writeReport(path: string, report: Rel00cReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stableJsonStringify(report as unknown as JsonValue)}\n`, 'utf8');
}

function toSerializableJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => (
    typeof item === 'bigint' ? item.toString() : item
  ))) as JsonValue;
}

function assertValidEvent(event: JournalEventEnvelope, label: string): void {
  const validation = validateJournalEventEnvelope(event);
  if (!validation.ok) {
    throw new Error(`${label}: ${formatJournalEventSchemaValidationErrors(validation.issues)}`);
  }
}

function compareSourceEvents(
  left: L1TradeEvent,
  right: L1TradeEvent,
): number {
  const leftTs = BigInt(left.payload.exchange_event_ts_ns);
  const rightTs = BigInt(right.payload.exchange_event_ts_ns);
  if (leftTs < rightTs) return -1;
  if (leftTs > rightTs) return 1;
  return String(left.event_id).localeCompare(String(right.event_id));
}

function emptySourceSummary(cwd: string, path: string): SourceJournalSummary {
  return {
    path: toReportPath(cwd, path),
    exists: existsSync(path),
    sha256: null,
    events_scanned: 0,
    events_used_for_runtime: 0,
    parse_error_count: 0,
  };
}

function safeSummary(cwd: string, path: string): SourceJournalSummary {
  return {
    path: toReportPath(cwd, path),
    exists: existsSync(path),
    sha256: existsSync(path) ? sha256File(path) : null,
    events_scanned: 0,
    events_used_for_runtime: 0,
    parse_error_count: 0,
  };
}

function emptyRuntimeCounters(): RuntimeCounters {
  return {
    eventCounts: new Map<string, number>(),
    featureFields: new Map<string, FeatureAvailabilityTier | 'unknown_internal'>(),
    blockedFeatureFields: new Set<string>(),
    restrictedFeatureFields: new Set<string>(),
    unknownInternalIndicatorFields: new Set<string>(),
    realOrderEventTypes: new Set<string>(),
  };
}

function readSim03Ready(cwd: string): boolean | null {
  const candidates = [
    'reports/sim/fill_slippage_calibration_robust_limit_queue_front_gate.json',
    'reports/sim/fill_slippage_calibration_gate.json',
  ];
  for (const candidate of candidates) {
    const path = resolve(cwd, candidate);
    if (!existsSync(path)) {
      continue;
    }
    try {
      const parsed = JSON.parse(String(readUtf8Small(path))) as { readonly ready_for_rel01_execution_simulation?: unknown };
      if (typeof parsed.ready_for_rel01_execution_simulation === 'boolean') {
        return parsed.ready_for_rel01_execution_simulation;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function readUtf8Small(path: string): string {
  return readFileSync(path, 'utf8');
}

function toReportPath(cwd: string, path: string): string {
  const rel = relative(cwd, resolve(path)).replace(/\\/gu, '/');
  return rel.startsWith('..') ? resolve(path) : rel;
}

function synthesizeBars(mid: number, tsNs: UnixNs): MutableBar[] {
  const minuteStart = (BigInt(tsNs) / 60_000_000_000n) * 60_000_000_000n;
  return Array.from({ length: 2 }, (_, index) => {
    const start = minuteStart - BigInt(1 - index) * 60_000_000_000n;
    return {
      minuteStartNs: start,
      open: mid,
      high: mid + 0.25,
      low: mid - 0.25,
      close: mid,
      volume: 1,
      tradeCount: 1,
    };
  });
}

function ema(values: readonly number[], period: number): number {
  const alpha = 2 / (period + 1);
  let result = values[0] ?? 0;
  for (const value of values.slice(1)) {
    result = value * alpha + result * (1 - alpha);
  }
  return result;
}

function stddev(values: readonly number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const avg = mean(values);
  return Math.sqrt(values.reduce((total, value) => total + (value - avg) ** 2, 0) / values.length);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return sum(values) / values.length;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sumAbs(values: readonly number[]): number {
  return values.reduce((total, value) => total + Math.abs(value), 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function roundToTick(value: number, tickSize = 0.25): number {
  return Math.round(value / tickSize) * tickSize;
}

function sorted(values: readonly string[]): readonly string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRel00cArgs(args: readonly string[], cwd = processCwd()): Rel00cOptions {
  const options: MutableRel00cOptions = { cwd };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    switch (flag) {
      case '--l1-trade-journal':
        index += 1;
        options.l1_trade_journal = requireArgValue(flag, args[index]);
        break;
      case '--mbp10-price-state-journal':
        index += 1;
        options.mbp10_price_state_journal = requireArgValue(flag, args[index]);
        break;
      case '--out-journal':
        index += 1;
        options.out_journal = requireArgValue(flag, args[index]);
        break;
      case '--report':
        index += 1;
        options.report = requireArgValue(flag, args[index]);
        break;
      case '--run-id':
        index += 1;
        options.run_id = requireArgValue(flag, args[index]);
        break;
      case '--session-id':
        index += 1;
        options.session_id = requireArgValue(flag, args[index]);
        break;
      case '--max-feature-snapshots':
        index += 1;
        options.max_feature_snapshots = parsePositiveInteger(flag, requireArgValue(flag, args[index]));
        break;
      case '--help':
        processStdout.write(usage());
        processExit(0);
        break;
      default:
        throw new Error(`unknown argument ${flag}`);
    }
  }
  for (const field of ['l1_trade_journal', 'mbp10_price_state_journal', 'run_id', 'session_id'] as const) {
    if (options[field] === undefined) {
      throw new Error(`missing required --${field.replace(/_/gu, '-')}`);
    }
  }
  return options as Rel00cOptions;
}

function requireArgValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function usage(): string {
  return [
    'Usage: npm run rel:00c:run-controlled-live-sim -- --l1-trade-journal path --mbp10-price-state-journal path --out-journal path --report path --run-id id --session-id id [--max-feature-snapshots n]',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  try {
    const options = parseRel00cArgs(processArgv.slice(2));
    const result = await runRel00cControlledLiveSim(options);
    processStdout.write(formatRel00cSummary(result.report));
    processExit(result.exit_code);
  } catch (error) {
    processStderr.write(`${errorMessage(error)}\n`);
    processExit(3);
  }
}

export function formatRel00cSummary(report: Rel00cReport): string {
  const lines = [
    `REL-00C controlled live-sim runtime journal generation: ${report.status}`,
    `journal=${report.output.out_journal}`,
    `report=${report.output.report}`,
    `source_events_consumed=${report.source_events_consumed}`,
    `feature_snapshots_generated=${report.feature_snapshots_generated}`,
    `order_intents=${report.order_intents_emitted}`,
    `sim_fills=${report.sim_fills_emitted}`,
    `next_blocker=${report.next_blocker}`,
  ];
  if (report.reasons.length > 0) {
    lines.push('reasons:');
    for (const reason of report.reasons) {
      lines.push(`- ${reason}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

const isDirectCli = processArgv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(processArgv[1]);
if (isDirectCli) {
  void main();
}
