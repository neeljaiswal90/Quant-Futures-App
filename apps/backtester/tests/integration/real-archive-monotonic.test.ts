import { readFileSync } from 'node:fs';
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
} from '../../../strategy_runtime/src/contracts/index.js';
import type { StrategyId } from '../../../strategy_runtime/src/contracts/strategy-ids.js';
import { executeHeldOutValidationAgainstArchive } from '../../src/held-out-validation/index.js';
import type { RealArchiveStrategyGenerator } from '../../src/real-archive-execution/index.js';

describe('QFA-201d real-archive monotonic source merge', () => {
  it.skip('executes 2026-02-02-rth without non_monotonic_source drift', async () => {
    const manifestPath = 'D:/qfa-cache/databento/tier-a-feb-mar-2026/manifest-feb-2026.json';
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      readonly sessions: readonly {
        readonly session_id: string;
        readonly symbol: string;
        readonly rth_window: { readonly start_ts_ns: string; readonly end_ts_ns: string };
        readonly schemas: {
          readonly trades: { readonly path: string };
          readonly 'mbp-1': { readonly path: string };
        };
      }[];
    };
    const session = manifest.sessions.find((candidate) => candidate.session_id === '2026-02-02-rth');
    if (session === undefined) {
      throw new Error('missing 2026-02-02-rth in Tier A manifest');
    }

    const strategyId = 'vwap_overnight_reversal_long' as const satisfies StrategyId;
    const result = await executeHeldOutValidationAgainstArchive({
      run_id: 'qfa201d-real-archive-monotonic',
      input_spec: {
        spec_schema_version: 1,
        data_mode: 'tier_b_projection_from_tier_a',
        required_schemas: ['mbp-1', 'trades'],
        corpus_manifest_hashes: [
          createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
        ],
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
        sessions: [session.session_id, '2026-02-03-rth'],
        windows: [{
          window_id: 'wf-real-monotonic-1',
          sequence: 1,
          train: { start_session: session.session_id, end_session: session.session_id },
          validation: { start_session: session.session_id, end_session: session.session_id },
          test: { start_session: session.session_id, end_session: '2026-02-03-rth' },
        }],
      },
      strategy_order: [strategyId],
      run_started_at_ns: ns(1n),
      fill_policy: { minimum_fill_probability_ppm: 0, order_quantity: 1 },
      strategy_generators: { [strategyId]: deterministicGenerator() },
      archive_sessions: [{
        session_id: session.session_id,
        trading_date: session.session_id.slice(0, 10),
        raw_symbol: session.symbol,
        regime_label: 'high',
        rth_start_ts_ns: BigInt(session.rth_window.start_ts_ns),
        rth_end_ts_ns: BigInt(session.rth_window.end_ts_ns),
        trades_path: session.schemas.trades.path,
        mbp1_path: session.schemas['mbp-1'].path,
      }],
    });

    const window = result.per_strategy_real_records[0]?.windows[0];
    expect(window?.status).toBe('executed');
    expect(window?.per_trade_records.length).toBeGreaterThan(0);
  });
});

function deterministicGenerator(): RealArchiveStrategyGenerator {
  let emitted = false;
  const config = {
    config_hash: makeConfigHash('1'.repeat(64)),
    config_version: 1,
  };
  return ({ strategy_id, snapshot }) => {
    const evaluation: StrategyEvaluation = {
      strategy_evaluation_id: makeStrategyEvaluationId(`eval-${snapshot.feature_snapshot_id}`),
      strategy_id,
      instrument: snapshot.instrument,
      feature_snapshot_id: snapshot.feature_snapshot_id,
      evaluated_ts_ns: snapshot.created_ts_ns,
      gate_state: emitted ? 'waiting' : 'armed',
      reasons: ['qfa201d-real-archive-monotonic'],
      config,
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
      config,
      reasons: ['qfa201d-real-archive-monotonic'],
    };
    return { evaluation, candidate };
  };
}
