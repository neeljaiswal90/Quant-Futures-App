import { createHash } from 'node:crypto';
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
import { ACTIVE_STRATEGY_IDS } from '../../../../strategy_runtime/src/contracts/strategy-ids.js';
import type {
  DbnMbp1Record,
  DbnTradesRecord,
} from '../../../../strategy_runtime/src/data/dbn-types.js';
import {
  executeHeldOutValidationAgainstArchive,
  type HeldOutValidationRealArchiveResult,
} from '../../../src/held-out-validation/index.js';
import type {
  RealArchiveStrategyGenerator,
} from '../../../src/real-archive-execution/index.js';

const PRICE_SCALE = 1_000_000_000n;
const HASH_A = 'a'.repeat(64);
const CONFIG = {
  config_hash: makeConfigHash('1'.repeat(64)),
  config_version: 1,
};

describe('QFA-410b real-archive held-out execution', () => {
  it('executes a held-out test window through QFA-201c and preserves per-trade metadata', async () => {
    const result = await runFixture();

    expect(result.per_strategy_real_records).toHaveLength(1);
    expect(result.raw_execution_results).toHaveLength(1);
    expect(result.per_strategy_real_records[0]?.windows[0]).toMatchObject({
      strategy_id: ACTIVE_STRATEGY_IDS[0],
      window_id: 'wf-real-1',
      status: 'executed',
    });
    expect(result.per_strategy_real_records[0]?.windows[0]?.per_trade_records[0]).toMatchObject({
      strategy_id: ACTIVE_STRATEGY_IDS[0],
      session_id: '2026-02-02-rth',
      regime_label: 'high',
      spread_bucket: '2-tick',
      queue_ahead_bucket: '6-20',
      exit_reason: 'fail_safe',
      exit_bar_index: 2,
      entry_quantity: 2,
      exit_quantity: 2,
      management_profile_id: expect.any(String),
      time_stop_at_deadline_extension: 'enforce_floor',
      exits: [{
        exit_ts_ns: ns(121_000_000_000n),
        exit_quantity: 2,
        management_action_reason: expect.stringMatching(/^fail_safe:/),
        management_action_type: 'FAIL_SAFE_EXIT',
        target_label: null,
      }],
      max_favorable_excursion_cents: 300n,
      max_adverse_excursion_cents: -500n,
    });
    expect(result.framework_result.window_results[0]?.window_id).toBe('wf-real-1');
  });

  it('accumulates runtime PT1 and PT2 exit evidence for a two-contract target path', async () => {
    const result = await runTargetFixture();
    const trade = result.per_strategy_real_records[0]?.windows[0]?.per_trade_records[0];

    expect(trade).toMatchObject({
      strategy_id: ACTIVE_STRATEGY_IDS[0],
      session_id: '2026-02-04-rth',
      regime_label: 'high',
      exit_reason: 'target',
      entry_quantity: 2,
      exit_quantity: 2,
      exits: [
        {
          exit_ts_ns: ns(61_000_000_000n),
          exit_quantity: 1,
          management_action_reason: 'target:pt1:hit',
          management_action_type: 'TAKE_PARTIAL',
          target_label: 'pt1',
        },
        {
          exit_ts_ns: ns(121_000_000_000n),
          exit_quantity: 1,
          management_action_reason: 'target:pt2:hit',
          management_action_type: 'TAKE_PROFIT',
          target_label: 'pt2',
        },
      ],
    });
  });

  it('is deterministic for identical real-archive fixture inputs', async () => {
    expect(hashStable((await runFixture()).per_strategy_real_records)).toBe(
      hashStable((await runFixture()).per_strategy_real_records),
    );
  });
});

async function runFixture(): Promise<HeldOutValidationRealArchiveResult> {
  return executeHeldOutValidationAgainstArchive({
    run_id: 'qfa-410b-fixture',
    input_spec: {
      spec_schema_version: 1,
      data_mode: 'tier_b_projection_from_tier_a',
      required_schemas: ['mbp-1', 'trades'],
      corpus_manifest_hashes: [HASH_A],
      fidelity_status: 'passed',
    },
    walk_forward_plan: {
      policy: {
        policy_version: 1,
        train_sessions: 1,
        validation_sessions: 0,
        test_sessions: 1,
        step_sessions: 1,
        min_required_sessions: 2,
      },
      sessions: ['2026-02-02-rth', '2026-02-03-rth'],
      windows: [{
        window_id: 'wf-real-1',
        sequence: 1,
        train: { start_session: '2026-02-02-rth', end_session: '2026-02-02-rth' },
        validation: { start_session: '2026-02-02-rth', end_session: '2026-02-02-rth' },
        test: { start_session: '2026-02-02-rth', end_session: '2026-02-03-rth' },
      }],
    },
    strategy_order: [ACTIVE_STRATEGY_IDS[0]],
    run_started_at_ns: ns(1n),
    fill_policy: {
      minimum_fill_probability_ppm: 0,
      order_quantity: 2,
    },
    strategy_generators: {
      [ACTIVE_STRATEGY_IDS[0]]: deterministicGenerator(),
    },
    archive_sessions: [{
      session_id: '2026-02-02-rth',
      trading_date: '2026-02-02',
      raw_symbol: 'MNQH6',
      regime_label: 'high',
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
    }],
  });
}

async function runTargetFixture(): Promise<HeldOutValidationRealArchiveResult> {
  return executeHeldOutValidationAgainstArchive({
    run_id: 'qfa-410b-target-fixture',
    input_spec: {
      spec_schema_version: 1,
      data_mode: 'tier_b_projection_from_tier_a',
      required_schemas: ['mbp-1', 'trades'],
      corpus_manifest_hashes: [HASH_A],
      fidelity_status: 'passed',
    },
    walk_forward_plan: {
      policy: {
        policy_version: 1,
        train_sessions: 1,
        validation_sessions: 0,
        test_sessions: 1,
        step_sessions: 1,
        min_required_sessions: 2,
      },
      sessions: ['2026-02-04-rth', '2026-02-05-rth'],
      windows: [{
        window_id: 'wf-target-1',
        sequence: 1,
        train: { start_session: '2026-02-04-rth', end_session: '2026-02-04-rth' },
        validation: { start_session: '2026-02-04-rth', end_session: '2026-02-04-rth' },
        test: { start_session: '2026-02-04-rth', end_session: '2026-02-05-rth' },
      }],
    },
    strategy_order: [ACTIVE_STRATEGY_IDS[0]],
    run_started_at_ns: ns(1n),
    fill_policy: {
      minimum_fill_probability_ppm: 0,
      order_quantity: 2,
    },
    strategy_generators: {
      [ACTIVE_STRATEGY_IDS[0]]: deterministicGenerator(),
    },
    archive_sessions: [{
      session_id: '2026-02-04-rth',
      trading_date: '2026-02-04',
      raw_symbol: 'MNQH6',
      regime_label: 'high',
      trades_records: [
        trade(1_000_000_000n, 100),
        trade(61_000_000_000n, 101),
        trade(121_000_000_000n, 102),
      ],
      mbp1_records: [
        mbp1(1_000_000_000n, 99.75, 100.25),
        mbp1(61_000_000_000n, 100.75, 101.25),
        mbp1(121_000_000_000n, 101.75, 102.25),
      ],
    }],
  });
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
      reasons: ['qfa-410b-fixture'],
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
      reasons: ['qfa-410b-fixture'],
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
    levels: [{
      bid_px: scaled(bid),
      bid_sz: 10,
      bid_ct: 2,
      ask_px: scaled(ask),
      ask_sz: 12,
      ask_ct: 2,
    }],
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
