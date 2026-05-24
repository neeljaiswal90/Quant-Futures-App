import {
  createJournalEventEnvelope,
  makeCausationId,
  makeEventId,
  makeFeatureSnapshotId,
  makeRunId,
  makeSessionId,
  type AnyJournalEventEnvelope,
  type BacktestRunMetaPayload,
  type BarTimeframe,
  type ConfigLineageRef,
  type EventId,
  type InstrumentIdentity,
  type JournalEventPayloadFor,
  type SessionId,
} from '../../strategy_runtime/src/contracts/index.js';
import { ns, type UnixNs } from '../../strategy_runtime/src/contracts/time.js';
import { getCachedRecords } from '../../strategy_runtime/src/data/parquet-cache.js';
import {
  buildCachedBars,
  DEFAULT_MNQ_ROLL_POLICY,
  type BuiltBar,
} from '../../strategy_runtime/src/data/bar-builder/index.js';
import {
  createNullSignedShockMeasurement,
  getActiveStrategyGenerator,
  type StrategyFeatureSnapshot,
} from '../../strategy_runtime/src/strategies/index.js';
import type { StrategyId } from '../../strategy_runtime/src/contracts/strategy-ids.js';
import { createBacktestJournalWriter } from './backtest-journal.js';
import { buildRunSpecFromOptions, type BuiltBacktestRunSpec } from './run-spec-builder.js';
import type { BacktestRunResult, BacktestRunnerOptions } from './types.js';

export async function runBacktest(options: BacktestRunnerOptions): Promise<BacktestRunResult> {
  const resolved = buildRunSpecFromOptions(options);
  const runId = makeRunId(resolved.identity.run_id);
  const sessionId = makeSessionId(options.session_id ?? `session-${resolved.identity.run_id}`);
  const writer = await createBacktestJournalWriter(options.output_dir, resolved.identity.run_id);
  const startedAt = ns(options.run_started_at_ns);

  await writer.write(createBacktestRunMetaEvent(resolved, startedAt, runId, sessionId));

  let sequence = 1;
  for (const input of resolved.input_sources) {
    const cached = await getCachedRecords(input.dbn_path, input.schema, {
      cacheRoot: options.cache_root,
      forceRebuild: options.force_rebuild_cache,
    });
    for await (const output of buildCachedBars(cached, {
      bar_spec: options.bar_spec,
      manifest_symbol: resolved.manifest_symbol,
      roll_policy: DEFAULT_MNQ_ROLL_POLICY,
      input_schemas: [input.schema],
      corpus_tier: resolved.run_spec.corpus_inputs[0]!.tier,
    })) {
      if (output.type !== 'bar') continue;
      const barEvent = createBarCloseEvent(output, options.bar_spec, runId, sessionId, sequence);
      sequence += 1;
      await writer.write(barEvent);

      const strategyEvent = createStrategyEvaluationEvent(
        output,
        resolved,
        runId,
        sessionId,
        barEvent.event_id,
        sequence,
      );
      sequence += 1;
      await writer.write(strategyEvent);
    }
  }

  return {
    run_id: resolved.identity.run_id,
    run_spec_hash: resolved.identity.run_spec_hash,
    journal_path: writer.journal_path,
    event_count: writer.event_count,
  };
}

function createBacktestRunMetaEvent(
  resolved: BuiltBacktestRunSpec,
  startedAt: UnixNs,
  runId: ReturnType<typeof makeRunId>,
  sessionId: SessionId,
): AnyJournalEventEnvelope {
  const payload: BacktestRunMetaPayload = {
    ...resolved.run_spec,
    run_spec_hash: resolved.identity.run_spec_hash,
    run_started_at_ns: startedAt,
  };
  return createJournalEventEnvelope({
    event_id: makeEventId(`evt-${resolved.identity.run_id}-000000`),
    type: 'BACKTEST_RUN_META',
    ts_ns: startedAt,
    run_id: runId,
    session_id: sessionId,
    payload,
  }) as AnyJournalEventEnvelope;
}

function createBarCloseEvent(
  bar: BuiltBar,
  barSpec: string,
  runId: ReturnType<typeof makeRunId>,
  sessionId: SessionId,
  sequence: number,
): AnyJournalEventEnvelope {
  const timeframe = barSpecToTimeframe(barSpec);
  if (timeframe === null || bar.bucket_start_ts_ns === null || bar.bucket_end_ts_ns === null) {
    throw new Error(`QFA-201 minimal runner can journal time bars only; received bar_spec ${barSpec}`);
  }
  return createJournalEventEnvelope({
    event_id: makeEventId(`evt-${runId}-${padSequence(sequence)}`),
    type: 'BAR_CLOSE',
    ts_ns: bar.last_record_ts_ns,
    run_id: runId,
    session_id: sessionId,
    payload: {
      timeframe,
      exchange_event_ts_ns: bar.last_record_ts_ns,
      sidecar_recv_ts_ns: bar.last_record_ts_ns,
      start_ts_ns: bar.bucket_start_ts_ns,
      end_ts_ns: bar.bucket_end_ts_ns,
      open: toSafeNumber(bar.open, 'bar.open'),
      high: toSafeNumber(bar.high, 'bar.high'),
      low: toSafeNumber(bar.low, 'bar.low'),
      close: toSafeNumber(bar.close, 'bar.close'),
      volume: toSafeNumber(bar.volume, 'bar.volume'),
    },
  }) as AnyJournalEventEnvelope;
}

function createStrategyEvaluationEvent(
  bar: BuiltBar,
  resolved: BuiltBacktestRunSpec,
  runId: ReturnType<typeof makeRunId>,
  sessionId: SessionId,
  causeEventId: EventId,
  sequence: number,
): AnyJournalEventEnvelope {
  const snapshot = createNeutralStrategySnapshot(bar, resolved, causeEventId);
  const result = getActiveStrategyGenerator(resolved.strategy_id)({
    strategy_id: resolved.strategy_id,
    snapshot,
  });
  const payload: JournalEventPayloadFor<'STRAT_EVAL'> = {
    strategy_evaluation_id: result.evaluation.strategy_evaluation_id,
    strategy_id: result.evaluation.strategy_id,
    feature_snapshot_id: result.evaluation.feature_snapshot_id,
    gate_state: result.evaluation.gate_state,
    ...(result.evaluation.score === undefined ? {} : { score: result.evaluation.score }),
    reasons: result.evaluation.reasons,
    strategy_config_hash: result.evaluation.config.config_hash,
  };
  return createJournalEventEnvelope({
    event_id: makeEventId(`evt-${runId}-${padSequence(sequence)}`),
    type: 'STRAT_EVAL',
    ts_ns: bar.last_record_ts_ns,
    run_id: runId,
    session_id: sessionId,
    causation_id: makeCausationId(causeEventId),
    payload,
  }) as AnyJournalEventEnvelope;
}

function createNeutralStrategySnapshot(
  bar: BuiltBar,
  resolved: BuiltBacktestRunSpec,
  sourceEventId: EventId,
): StrategyFeatureSnapshot {
  const price = toSafeNumber(bar.close, 'bar.close');
  const symbol = bar.raw_symbol ?? `iid${String(bar.instrument_id)}`;
  const instrument: InstrumentIdentity = {
    root: 'MNQ',
    symbol,
    exchange: 'CME',
    currency: 'USD',
    tick_size: 0.25,
    point_value: 2,
    price_decimals: 2,
  };
  const featureSnapshotId = makeFeatureSnapshotId(`feature-${bar.bar_id}`);
  return {
    feature_snapshot_id: featureSnapshotId,
    source_event_id: sourceEventId,
    created_ts_ns: bar.last_record_ts_ns,
    instrument,
    session: {
      session_id: makeSessionId(`strategy-session-${resolved.identity.run_id}`),
      trading_date: tradingDateForWindow(resolved.run_spec.backtest_window.start),
      phase: 'closed',
      is_rth: false,
      is_halt: false,
      is_roll_block: false,
    },
    quote: {
      bid_px: price,
      ask_px: price,
      mid_px: price,
    },
    last_trade_price: price,
    bars: [
      {
        instrument,
        timeframe: barSpecToTimeframe(resolved.run_spec.bar_spec) ?? '1m',
        start_ts_ns: bar.bucket_start_ts_ns ?? bar.first_record_ts_ns,
        end_ts_ns: bar.bucket_end_ts_ns ?? bar.last_record_ts_ns,
        open: toSafeNumber(bar.open, 'bar.open'),
        high: toSafeNumber(bar.high, 'bar.high'),
        low: toSafeNumber(bar.low, 'bar.low'),
        close: price,
        volume: toSafeNumber(bar.volume, 'bar.volume'),
      },
    ],
    indicators: {
      adx_14: null,
      atr_14_pts: null,
    },
    structure: {
      trend: 'unknown',
      values: {},
    },
    microstructure: {
      l3_authority: 'unavailable',
      values: {},
    },
    context: {
      prior_day_close: null,
      prior_day_high: null,
      prior_day_low: null,
      today_open: toSafeNumber(bar.open, 'bar.open'),
      vix_value: null,
      vix_fresh: false,
      vix_prior_close_percentile: null,
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
    config: strategyConfigRef(resolved, resolved.strategy_id),
  };
}

function strategyConfigRef(resolved: BuiltBacktestRunSpec, strategyId: StrategyId): ConfigLineageRef {
  const config = resolved.run_spec.config_inputs.find(
    (input) => input.role === 'strategy' && input.config_path.endsWith(`${strategyId}.yaml`),
  );
  if (config === undefined) {
    throw new Error(`missing strategy config lineage for ${strategyId}`);
  }
  return config.lineage;
}

function barSpecToTimeframe(barSpec: string): BarTimeframe | null {
  switch (barSpec) {
    case '1m':
      return '1m';
    case '5m':
      return '5m';
    case '15m':
      return '15m';
    case '1h':
      return '60m';
    case '1d':
      return '1d';
    default:
      return null;
  }
}

function tradingDateForWindow(start: string): string {
  return start.includes('T') ? start.slice(0, 10) : start;
}

function toSafeNumber(value: bigint, path: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) {
    throw new Error(`${path} cannot be represented as a safe integer number for existing journal payloads`);
  }
  return converted;
}

function padSequence(sequence: number): string {
  return sequence.toString().padStart(6, '0');
}
