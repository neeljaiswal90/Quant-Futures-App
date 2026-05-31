import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
import type { StrategyId } from '../../../../strategy_runtime/src/contracts/strategy-ids.js';
import type {
  DbnMbp1Record,
  DbnTradesRecord,
} from '../../../../strategy_runtime/src/data/dbn-types.js';
import {
  executeHeldOutValidationAgainstArchive,
  type HeldOutValidationArtifactV1,
  type HeldOutValidationRealArchiveResult,
} from '../../../src/held-out-validation/index.js';
import type {
  RealArchiveStrategyGenerator,
} from '../../../src/real-archive-execution/index.js';

const PRICE_SCALE = 1_000_000_000n;
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const CONFIG = {
  config_hash: makeConfigHash('1'.repeat(64)),
  config_version: 1,
};
const EXPLICIT_REPLAY_STRATEGY_ID = 'vwap_overnight_reversal_long' as const satisfies StrategyId;

describe('HeldOutValidationArtifactV1 writer', () => {
  it('round-trips the committed fixture schema with net gating fields', () => {
    const fixture = JSON.parse(
      readFileSync('apps/backtester/tests/fixtures/qfa410-fixture.json', 'utf8'),
    ) as HeldOutValidationArtifactV1;

    expect(fixture.schema_version).toBe(1);
    expect(fixture.methodology_id).toBe('qfa-410-v1');
    expect(fixture.gating_pnl_basis).toBe('net');
    expect(fixture.strategy_family).toBe('continuation');
    expect(fixture.parameter_lock_source).toBe('test-fixture');
    expect(fixture.trades[0]?.gross_pnl_cents).not.toBe(fixture.trades[0]?.net_pnl_cents);
    expect(fixture.trades[0]).not.toHaveProperty('quantity');
    expect(fixture.trades[0]).toMatchObject({
      trade_id: expect.any(String),
      session_id: '2026-02-04-rth',
      entry_price: expect.any(Number),
      exit_price: expect.any(Number),
      vix_value: null,
      vix_fresh: false,
      vix_prior_close_percentile: null,
      signed_shock_vwap: {
        value: null,
        anchor_type: 'vwap',
        anchor_value: null,
        sigma_basis: 'atr_14',
        sigma_basis_value: null,
      },
      signed_shock_vwap_recent_values: null,
      first_minute_max_favorable_excursion_cents: '100',
      first_minute_max_adverse_excursion_cents: '0',
      first_minute_close_pnl_cents: '100',
      first_minute_observed: true,
      entry_quantity: 2,
      exit_quantity: 2,
      management_profile_id: 'test-fixture-management-profile',
      time_stop_at_deadline_extension: 'enforce_floor',
      exits: [
        {
          exit_ts_ns: '61000000000',
          exit_quantity: 1,
          management_action_reason: 'target:pt1:hit',
          management_action_type: 'TAKE_PARTIAL',
          target_label: 'pt1',
          fail_safe_context: null,
        },
        {
          exit_ts_ns: '121000000000',
          exit_quantity: 1,
          management_action_reason: 'target:pt2:hit',
          management_action_type: 'TAKE_PROFIT',
          target_label: 'pt2',
          fail_safe_context: null,
        },
      ],
    });
    expect(fixture.session_returns).toHaveLength(5);
  });

  it('emits deterministic LF-canonical artifacts from real-archive execution results', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'qfa410-artifact-'));
    try {
      const first = await runArtifactFixture(outputDir);
      const outputPath = first.artifact_paths?.[0];
      expect(outputPath).toBe(join(outputDir, `${EXPLICIT_REPLAY_STRATEGY_ID}-feb-mar-apr-2026.json`));

      const firstBytes = readFileSync(outputPath!, 'utf8');
      const firstArtifact = JSON.parse(firstBytes) as HeldOutValidationArtifactV1;
      const second = await runArtifactFixture(outputDir);
      const secondBytes = readFileSync(second.artifact_paths![0]!, 'utf8');

      expect(secondBytes).toBe(firstBytes);
      expect(firstBytes.includes('\r')).toBe(false);
      expect(firstArtifact.gating_pnl_basis).toBe('net');
      expect(firstArtifact.capability_status).toBe('ready_for_replay');
      expect(firstArtifact.trades[0]?.gross_pnl_cents).not.toBe(firstArtifact.trades[0]?.net_pnl_cents);
      expect(firstArtifact.schema_version).toBe(1);
      expect(firstArtifact.trades[0]).not.toHaveProperty('quantity');
      expect(firstArtifact.trades[0]).toMatchObject({
        trade_id: expect.any(String),
        session_id: '2026-02-02-rth',
        entry_price: expect.any(Number),
        exit_price: expect.any(Number),
        vix_value: expect.any(Number),
        vix_fresh: expect.any(Boolean),
        vix_prior_close_percentile: null,
        signed_shock_vwap: expect.objectContaining({
          value: null,
          anchor_type: 'vwap',
          sigma_basis: 'atr_14',
        }),
        signed_shock_vwap_recent_values: null,
        first_minute_max_favorable_excursion_cents: '150',
        first_minute_max_adverse_excursion_cents: '0',
        first_minute_close_pnl_cents: '150',
        first_minute_observed: true,
        entry_quantity: 1,
        exit_quantity: 1,
        management_profile_id: expect.any(String),
        time_stop_at_deadline_extension: 'enforce_floor',
        regime: 'high',
        spread_bucket: '2-tick',
        queue_ahead_bucket: '6-20',
        // MGMT-BUGFIX-FAILSAFE-FILL-MODEL-CORRECTION-01: corrected dispatch routes
        // same-bar max_adverse_r + stop overlap to stop_loss / EXIT_FULL / stop:hit.
        exit_reason: 'stop_loss',
        exits: [{
          exit_ts_ns: '121000000000',
          exit_quantity: 1,
          // MGMT-BUGFIX-FAILSAFE-FILL-MODEL-CORRECTION-01: corrected dispatch routes
          // same-bar max_adverse_r + stop overlap to stop_loss / EXIT_FULL / stop:hit.
          management_action_reason: 'stop:hit',
          management_action_type: 'EXIT_FULL',
          target_label: null,
          fail_safe_context: null,
        }],
      });
    } finally {
      rmSync(outputDir, { force: true, recursive: true });
    }
  });
});

async function runArtifactFixture(outputDir: string): Promise<HeldOutValidationRealArchiveResult> {
  return executeHeldOutValidationAgainstArchive({
    run_id: 'qfa410-artifact-fixture',
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
        window_id: 'wf-artifact-1',
        sequence: 1,
        train: { start_session: '2026-02-02-rth', end_session: '2026-02-02-rth' },
        validation: { start_session: '2026-02-02-rth', end_session: '2026-02-02-rth' },
        test: { start_session: '2026-02-02-rth', end_session: '2026-02-03-rth' },
      }],
    },
    strategy_order: [EXPLICIT_REPLAY_STRATEGY_ID],
    run_started_at_ns: ns(1n),
    fill_policy: {
      commission_usd: 0.25,
      exchange_fee_usd: 0.25,
      minimum_fill_probability_ppm: 0,
      order_quantity: 1,
    },
    initial_equity_cents: 3_000_000n,
    strategy_generators: {
      [EXPLICIT_REPLAY_STRATEGY_ID]: deterministicGenerator(),
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
    artifact_output: {
      output_dir: outputDir,
      default_metadata: {
        strategy_family: 'continuation',
        parameter_lock_source: 'test-fixture',
        parameter_lock_hash: HASH_E,
        input_substrate_hash: HASH_D,
        input_manifest_hashes: {
          feb: HASH_A,
          mar: HASH_B,
          apr: HASH_C,
        },
      },
    },
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
      reasons: ['qfa410-artifact-fixture'],
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
      reasons: ['qfa410-artifact-fixture'],
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
