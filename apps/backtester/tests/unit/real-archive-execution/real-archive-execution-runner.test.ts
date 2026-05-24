import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  makeCandidateId,
  makeConfigHash,
  makeFeatureSnapshotId,
  makeStrategyEvaluationId,
  ns,
  type Candidate,
  type StrategyEvaluation,
} from '../../../../strategy_runtime/src/contracts/index.js';
import type {
  DbnMbp1Record,
  DbnTradesRecord,
} from '../../../../strategy_runtime/src/data/dbn-types.js';
import {
  runRealArchiveBacktest,
  type RealArchiveStrategyGenerator,
} from '../../../src/real-archive-execution/index.js';
import type { StrategyFeatureSnapshot } from '../../../../strategy_runtime/src/strategies/index.js';

const PRICE_SCALE = 1_000_000_000n;
const CONFIG = {
  config_hash: makeConfigHash('1'.repeat(64)),
  config_version: 1,
};

describe('QFA-201c real-archive lifecycle execution runner', () => {
  it('emits deterministic multi-bar per-trade records from synthetic archive records', async () => {
    const first = await runFixture();
    const second = await runFixture();

    expect(first.per_trade_records).toHaveLength(1);
    expect(first.per_trade_records[0]).toMatchObject({
      strategy_id: 'trend_pullback_long',
      session_id: '2026-02-02-rth',
      regime_label: 'high',
      side: 'long',
      quantity: 1,
      spread_bucket: '2-tick',
      queue_ahead_bucket: '6-20',
      exit_reason: 'stop_loss',
      exit_bar_index: 2,
      max_favorable_excursion_cents: 150n,
      max_adverse_excursion_cents: -250n,
    });
    expect(first.trade_analysis.summary.total_trades).toBe(1);
    expect(first.runtime_metrics.candidate_count).toBe(1);
    const candidate = first.journal_events.find((event) => event.type === 'CANDIDATE')?.payload as Candidate | undefined;
    expect(candidate?.targets.map((target) => target.price)).toEqual([100.75, 101.75]);
    expect(hashStable(first.per_trade_records)).toBe(hashStable(second.per_trade_records));
  });

  it('preserves the legacy replay-sanity runner by using a separate export', async () => {
    const result = await runFixture();
    expect(result.journal_events.map((event) => event.type)).toContain('ORDER_INTENT');
    expect(result.journal_events.map((event) => event.type)).toContain('SIM_FILL');
    expect(result.journal_events.map((event) => event.type)).toContain('POSITION');
    expect(result.journal_events.map((event) => event.type)).toContain('MGMT_TICK');
    expect(result.journal_events.map((event) => event.type)).toContain('MGMT_ACTION');
  });

  it('populates QFA-7xx-A context fields without changing strategy behavior', async () => {
    const snapshots: StrategyFeatureSnapshot[] = [];
    await runFixture(capturingGenerator(snapshots));

    expect(snapshots[0]?.context).toMatchObject({
      prior_day_close: 99.5,
      prior_day_high: 101,
      prior_day_low: 98,
      today_open: 100,
      regime_label: 'high',
      vix_prior_close_percentile: 0.733333,
      opening_range_high: 100,
      opening_range_low: 100,
      opening_range_minutes_elapsed: 0,
      session_vwap: 100,
      session_vwap_band_sigma_pts: null,
      overnight_return_bps: 50.2513,
      signed_shock_vwap: {
        value: null,
        anchor_type: 'vwap',
        anchor_value: 100,
        sigma_basis: 'atr_14',
        sigma_basis_value: null,
      },
      signed_shock_prior_close: {
        value: null,
        anchor_type: 'prior_close',
        anchor_value: 99.5,
        sigma_basis: 'atr_14',
        sigma_basis_value: null,
      },
    });
    expect(snapshots[0]?.indicators).toMatchObject({
      adx_14: null,
      atr_14_pts: null,
    });
    expect(typeof snapshots[0]?.context.vix_fresh).toBe('boolean');
  });

  it('populates VIX prior-close percentile from available regime labels', async () => {
    const snapshots: StrategyFeatureSnapshot[] = [];
    await runFixture(capturingGenerator(snapshots), {
      regime_labels_path: fixtureRegimeLabels([{
        session_id: '2026-02-02-rth',
        label_status: 'available',
        confirmed_label: 'high',
        primary_percentile: 0.733333,
      }]),
    });

    expect(snapshots[0]?.context.vix_prior_close_percentile).toBe(0.733333);
  });

  it('falls closed to null when the regime label percentile is unavailable', async () => {
    const snapshots: StrategyFeatureSnapshot[] = [];
    await runFixture(capturingGenerator(snapshots), {
      regime_labels_path: fixtureRegimeLabels([{
        session_id: '2026-02-02-rth',
        label_status: 'warmup_unavailable',
        confirmed_label: 'high',
        primary_percentile: 0.733333,
      }]),
    });

    expect(snapshots[0]?.context.vix_prior_close_percentile).toBeNull();
  });
});

async function runFixture(
  strategyGenerator: RealArchiveStrategyGenerator = deterministicGenerator(),
  overrides: Partial<Parameters<typeof runRealArchiveBacktest>[0]> = {},
) {
  return runRealArchiveBacktest({
    run_id: 'run-qfa-201b-fixture',
    strategy_id: 'trend_pullback_long',
    run_started_at_ns: ns(1n),
    fill_policy: {
      minimum_fill_probability_ppm: 0,
      order_quantity: 1,
    },
    strategy_generator: strategyGenerator,
    sessions: [
      {
        session_id: '2026-02-02-rth',
        trading_date: '2026-02-02',
        raw_symbol: 'MNQH6',
        regime_label: 'high',
        prior_day_close: 99.5,
        prior_day_high: 101,
        prior_day_low: 98,
        rth_start_ts_ns: ns(0n),
        trades_records: [
          trade(1_000_000_000n, 100),
          trade(61_000_000_000n, 100.5),
          trade(121_000_000_000n, 98.5),
        ],
        mbp1_records: [
          mbp1(1_000_000_000n, 99.75, 100.25),
          mbp1(61_000_000_000n, 100.25, 100.75),
          mbp1(121_000_000_000n, 98.25, 98.75),
        ],
      },
    ],
    ...overrides,
  });
}

function fixtureRegimeLabels(labels: readonly {
  readonly session_id: string;
  readonly label_status: string;
  readonly confirmed_label: string;
  readonly primary_percentile: number | null;
}[]): string {
  const root = mkdtempSync(join(tmpdir(), 'qfa-cycle4-s1-regime-'));
  const path = join(root, 'regime-labels.json');
  writeFileSync(path, JSON.stringify({ labels }), 'utf8');
  return path;
}

function capturingGenerator(snapshots: StrategyFeatureSnapshot[]): RealArchiveStrategyGenerator {
  const generator = deterministicGenerator();
  return (input) => {
    snapshots.push(input.snapshot);
    return generator(input);
  };
}

function deterministicGenerator(): RealArchiveStrategyGenerator {
  let emitted = false;
  return ({ strategy_id, snapshot }) => {
    const evaluation: StrategyEvaluation = {
      strategy_evaluation_id: makeStrategyEvaluationId(`eval-${snapshot.feature_snapshot_id}`),
      strategy_id,
      instrument: snapshot.instrument,
      feature_snapshot_id: snapshot.feature_snapshot_id,
      evaluated_ts_ns: snapshot.created_ts_ns,
      gate_state: emitted ? 'waiting' : 'armed',
      reasons: ['qfa-201b-fixture'],
      config: CONFIG,
    };
    if (emitted) {
      return { evaluation };
    }
    emitted = true;
    const candidate: Candidate = {
      candidate_id: makeCandidateId(`candidate-${snapshot.feature_snapshot_id}`),
      strategy_id,
      setup_type: strategy_id,
      setup_family: 'trend_pullback',
      instrument: snapshot.instrument,
      feature_snapshot_id: makeFeatureSnapshotId(snapshot.feature_snapshot_id),
      direction: 'long',
      status: 'proposed',
      proposed_ts_ns: snapshot.created_ts_ns,
      entry_price: snapshot.quote.bid_px,
      stop_price: snapshot.quote.bid_px - 1,
      risk_points: 1,
      targets: [
        { label: 'pt1', price: snapshot.quote.bid_px + 1, quantity_fraction: 0.5 },
        { label: 'pt2', price: snapshot.quote.bid_px + 2, quantity_fraction: 0.5 },
      ],
      reward_risk: [
        { label: 'pt1', reward_risk: 1 },
        { label: 'pt2', reward_risk: 2 },
      ],
      confidence: 1,
      config: CONFIG,
      reasons: ['qfa-201b-fixture'],
    };
    return { evaluation, candidate };
  };
}

function trade(ts: bigint, price: number): DbnTradesRecord {
  return {
    schema: 'trades',
    ts_event: ns(ts),
    ts_recv: ns(ts),
    instrument_id: 1,
    price: scaled(price),
    size: 10,
    aggressor_side: 'A',
  };
}

function mbp1(ts: bigint, bid: number, ask: number): DbnMbp1Record {
  return {
    schema: 'mbp-1',
    ts_event: ns(ts),
    ts_recv: ns(ts),
    instrument_id: 1,
    action: 'A',
    side: 'B',
    price: scaled(bid),
    size: 10,
    levels: [
      {
        bid_px: scaled(bid),
        bid_sz: 10,
        bid_ct: 2,
        ask_px: scaled(ask),
        ask_sz: 12,
        ask_ct: 2,
      },
    ],
  };
}

function scaled(price: number): bigint {
  return BigInt(Math.round(price * Number(PRICE_SCALE)));
}

function hashStable(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, bigintReplacer)).digest('hex');
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
