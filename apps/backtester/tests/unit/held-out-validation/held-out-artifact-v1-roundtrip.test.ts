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
import { ACTIVE_STRATEGY_IDS } from '../../../../strategy_runtime/src/contracts/strategy-ids.js';
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
    expect(fixture.session_returns).toHaveLength(5);
  });

  it('emits deterministic LF-canonical artifacts from real-archive execution results', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'qfa410-artifact-'));
    try {
      const first = await runArtifactFixture(outputDir);
      const outputPath = first.artifact_paths?.[0];
      expect(outputPath).toBe(join(outputDir, `${ACTIVE_STRATEGY_IDS[0]}-feb-mar-apr-2026.json`));

      const firstBytes = readFileSync(outputPath!, 'utf8');
      const firstArtifact = JSON.parse(firstBytes) as HeldOutValidationArtifactV1;
      const second = await runArtifactFixture(outputDir);
      const secondBytes = readFileSync(second.artifact_paths![0]!, 'utf8');

      expect(secondBytes).toBe(firstBytes);
      expect(firstBytes.includes('\r')).toBe(false);
      expect(firstArtifact.gating_pnl_basis).toBe('net');
      expect(firstArtifact.capability_status).toBe('ready_for_replay');
      expect(firstArtifact.trades[0]?.gross_pnl_cents).not.toBe(firstArtifact.trades[0]?.net_pnl_cents);
      expect(firstArtifact.trades[0]).toMatchObject({
        regime: 'high',
        spread_bucket: '2-tick',
        queue_ahead_bucket: '6-20',
        exit_reason: 'stop_loss',
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
    strategy_order: [ACTIVE_STRATEGY_IDS[0]],
    run_started_at_ns: ns(1n),
    fill_policy: {
      commission_usd: 0.25,
      exchange_fee_usd: 0.25,
      minimum_fill_probability_ppm: 0,
      order_quantity: 1,
    },
    initial_equity_cents: 3_000_000n,
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
