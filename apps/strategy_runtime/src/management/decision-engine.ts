import type { ContractSpec } from '../risk/contracts.js';
import {
  computeTargetPosition,
  describeTargetAction,
  logTargetPositionDecision,
  type PositionTargetConfig,
  type TargetPositionContext,
  type TargetPositionResult,
} from './target-position.js';
import { RulesProbabilityEngine } from './probability-engine.js';
import type {
  ManagementFeatures,
  ManagementMetrics,
  ManagementState,
  ManagementTargetPositionSnapshot,
  ProbabilityModel,
  TradePoP,
} from './types.js';

const HOLD_EDGE_THRESHOLD_USD = 5;
const TIME_STOP_URGENCY_SECS = 120;
const LOW_POP_THRESHOLD = 0.3;

interface TargetPositionRuntimeState {
  trade_id: string;
  cached_result: TargetPositionResult | null;
  small_drop_cycles_consecutive: number;
  last_reduce_ts_ms: number;
  bracket_sync_block_active: boolean;
}

export class ManagementDecisionEngine {
  private readonly model: ProbabilityModel;
  private readonly positionTargetConfig: PositionTargetConfig | null;
  private targetPositionRuntime: TargetPositionRuntimeState | null = null;

  constructor(
    private readonly contract: ContractSpec,
    positionTargetConfig?: PositionTargetConfig | null,
    model?: ProbabilityModel,
  ) {
    this.model = model ?? new RulesProbabilityEngine();
    this.positionTargetConfig = positionTargetConfig ?? null;
  }

  beginTrade(tradeId: string): void {
    if (this.targetPositionRuntime?.trade_id === tradeId) return;
    this.targetPositionRuntime = {
      trade_id: tradeId,
      cached_result: null,
      small_drop_cycles_consecutive: 0,
      last_reduce_ts_ms: 0,
      bracket_sync_block_active: false,
    };
  }

  endTrade(): void {
    this.targetPositionRuntime = null;
  }

  notifyReduceApplied(): void {
    if (!this.targetPositionRuntime) return;
    this.targetPositionRuntime.last_reduce_ts_ms = Date.now();
    this.targetPositionRuntime.small_drop_cycles_consecutive = 0;
  }

  notifyBracketSyncFailed(): void {
    if (!this.targetPositionRuntime) return;
    this.targetPositionRuntime.bracket_sync_block_active = true;
  }

  notifyBracketSyncReconciled(): void {
    if (!this.targetPositionRuntime) return;
    this.targetPositionRuntime.bracket_sync_block_active = false;
  }

  getTargetPositionRuntimeSnapshot(): Readonly<TargetPositionRuntimeState> | null {
    return this.targetPositionRuntime ? { ...this.targetPositionRuntime } : null;
  }

  evaluate(features: ManagementFeatures, tradeId?: string): ManagementMetrics {
    if (tradeId && this.targetPositionRuntime?.trade_id !== tradeId) {
      this.beginTrade(tradeId);
    }

    const pop = this.model.computePoP(features);
    const unrealized = this.computeUnrealizedPnlUsd(features);
    const evHold = this.computeEvHold(features, pop);
    const evExit = unrealized;
    const evReduce = 0.5 * unrealized + 0.5 * evHold;
    const evDelta = evHold - evExit;

    const targetResult = this.recomputeTargetPosition(features, pop);
    const determined = this.determineState(features, pop, unrealized, evDelta, evReduce, targetResult);
    const targetSnapshot = this.buildTargetPositionSnapshot(features, targetResult);

    return {
      features,
      pop,
      unrealized_pnl_usd: round2(unrealized),
      expected_value_hold_usd: round2(evHold),
      expected_value_exit_now_usd: round2(evExit),
      expected_value_reduce_usd: round2(evReduce),
      ev_hold_vs_exit_delta: round2(evDelta),
      management_state: determined.state,
      management_state_reason: determined.reason,
      decision_factors: determined.factors,
      timestamp_iso: new Date().toISOString(),
      target_position: targetSnapshot,
      requested_qty_to_exit: determined.requested_qty_to_exit ?? null,
    };
  }

  private recomputeTargetPosition(
    features: ManagementFeatures,
    pop: TradePoP,
  ): (TargetPositionResult & { from_stale_cache: boolean }) | null {
    const cfg = this.positionTargetConfig;
    const runtime = this.targetPositionRuntime;
    if (!cfg || !cfg.enabled || !cfg.management_recompute_enabled || !runtime) return null;

    if (!this.targetInputsSane(features, pop)) {
      return runtime.cached_result ? { ...runtime.cached_result, from_stale_cache: true } : null;
    }

    const context: TargetPositionContext = {
      stop_distance_pts: Math.abs(features.distance_to_stop_pts),
      contract: this.contract,
      equity: features.account_equity,
      max_risk_per_trade_pct: features.max_risk_per_trade_pct,
      confidence_raw: pop.pop_target2_before_stop,
      confidence_source: 'management_pop_t2',
      regime: features.regime,
      session_bucket: features.session_bucket,
      daily_loss_pct: features.daily_loss_pct,
      max_daily_loss_pct: features.max_daily_loss_pct,
      hard_cap: cfg.hard_cap,
      config: cfg,
    };

    const result = computeTargetPosition(context);
    const priorTarget = runtime.cached_result?.q_target ?? -1;
    if (result.q_target !== priorTarget) {
      logTargetPositionDecision(result, {
        tag: 'recompute',
        approved: result.q_target > 0,
        equity: features.account_equity,
        qCurrent: features.quantity_remaining,
      });
      if (result.q_target > features.quantity_remaining) {
        logTargetPositionDecision(result, {
          tag: 'would_scale_in',
          approved: false,
          equity: features.account_equity,
          qCurrent: features.quantity_remaining,
          deltaDrop: features.quantity_remaining - result.q_target,
        });
      }
    }

    runtime.cached_result = result;
    return { ...result, from_stale_cache: false };
  }

  private targetInputsSane(features: ManagementFeatures, pop: TradePoP): boolean {
    return Number.isFinite(features.current_price)
      && features.current_price > 0
      && Number.isFinite(features.distance_to_stop_pts)
      && features.distance_to_stop_pts > 0
      && Number.isFinite(pop.pop_target2_before_stop)
      && Number.isFinite(features.daily_loss_pct)
      && Number.isFinite(features.max_daily_loss_pct)
      && features.max_daily_loss_pct > 0;
  }

  private buildTargetPositionSnapshot(
    features: ManagementFeatures,
    result: (TargetPositionResult & { from_stale_cache: boolean }) | null,
  ): ManagementTargetPositionSnapshot | null {
    if (!result) return null;
    const runtime = this.targetPositionRuntime;
    const delta = result.q_target - features.quantity_remaining;
    const cooldownSec = this.positionTargetConfig?.management_reduce_cooldown_sec ?? 0;
    const elapsedSec = runtime ? (Date.now() - runtime.last_reduce_ts_ms) / 1000 : Infinity;
    const cooldownRemainingSec =
      runtime && runtime.last_reduce_ts_ms > 0 ? Math.max(0, cooldownSec - elapsedSec) : 0;
    const persistenceCounter = runtime?.small_drop_cycles_consecutive ?? 0;
    const action = describeTargetAction(
      delta,
      result.q_target,
      persistenceCounter,
      cooldownRemainingSec,
      runtime?.bracket_sync_block_active ?? false,
      result.from_stale_cache,
    );

    return {
      q_target: result.q_target,
      q_risk: result.q_risk,
      q_softcap: result.q_softcap,
      q_hardcap: result.q_hardcap,
      bound_by: result.bound_by,
      bound_by_all: result.bound_by_all,
      delta,
      action_kind: action.kind,
      action_qty: action.qty,
      confidence_raw: result.confidence_raw,
      confidence_factor: result.confidence_factor,
      confidence_source: result.confidence_source,
      regime_factor: result.regime_factor,
      session_factor: result.session_factor,
      drawdown_factor: result.drawdown_factor,
      from_stale_cache: result.from_stale_cache,
      small_drop_cycles_consecutive: persistenceCounter,
      cooldown_remaining_sec: Math.round(cooldownRemainingSec),
      bracket_sync_block_active: runtime?.bracket_sync_block_active ?? false,
    };
  }

  private computeUnrealizedPnlUsd(features: ManagementFeatures): number {
    return features.unrealized_pnl_pts * features.quantity_remaining * this.contract.point_value;
  }

  private computeEvHold(features: ManagementFeatures, pop: TradePoP): number {
    const qty = features.quantity_remaining;
    const pv = this.contract.point_value;
    const pnlIfStop = -Math.abs(features.distance_to_stop_pts) * qty * pv;
    const pnlIfT2 = Math.abs(features.distance_to_t2_pts) * qty * pv;
    const pnlIfRunner = Math.abs(features.distance_to_t2_pts) * 1.5 * qty * pv;
    return pop.pop_target2_before_stop * pnlIfT2
      + pop.pop_runner_extension * (pnlIfRunner - pnlIfT2)
      + (1 - pop.pop_target2_before_stop) * pnlIfStop;
  }

  private determineState(
    features: ManagementFeatures,
    pop: TradePoP,
    unrealizedPnl: number,
    evDelta: number,
    evReduce: number,
    targetResult: (TargetPositionResult & { from_stale_cache: boolean }) | null,
  ): {
    state: ManagementState;
    reason: string;
    factors: string[];
    requested_qty_to_exit?: number;
  } {
    const factors: string[] = [];

    if (features.distance_to_stop_pts <= 0) {
      return {
        state: 'EXIT_NOW',
        reason: 'Stop price breached - hard stop should have triggered',
        factors: ['stop_breached'],
      };
    }

    const runtime = this.targetPositionRuntime;
    const cfg = this.positionTargetConfig;
    if (targetResult && runtime && cfg) {
      if (targetResult.from_stale_cache) {
        factors.push('target_position_stale_input');
        return {
          state: 'HOLD',
          reason: `target_position_stale_input (holding prior q_target=${targetResult.q_target})`,
          factors,
        };
      }

      if (runtime.bracket_sync_block_active) {
        factors.push('bracket_sync_block_active');
        return {
          state: 'HOLD',
          reason: 'bracket_sync_block_active (suppressing target-position reduces until reconciled)',
          factors,
        };
      }

      const qCurrent = features.quantity_remaining;
      const qTarget = targetResult.q_target;
      const deltaDrop = qCurrent - qTarget;

      if (qTarget === 0 && cfg.flatten_on_zero_target) {
        factors.push(`target_position_flatten bound_by=${targetResult.bound_by}`);
        return {
          state: 'EXIT_NOW',
          reason: `target_position_flatten: q_target=0 (bound_by=${targetResult.bound_by})`,
          factors,
        };
      }

      if (deltaDrop >= 1 && qTarget < cfg.min_residual_contracts) {
        factors.push(`target_position_residual_below_minimum (residual=${qTarget} < min=${cfg.min_residual_contracts})`);
        return {
          state: 'EXIT_NOW',
          reason: `target_position_residual_below_minimum: q_target=${qTarget} < min_residual=${cfg.min_residual_contracts}`,
          factors,
        };
      }

      if (deltaDrop >= cfg.management_reduce_min_delta) {
        const elapsedSec =
          runtime.last_reduce_ts_ms > 0 ? (Date.now() - runtime.last_reduce_ts_ms) / 1000 : Infinity;
        if (elapsedSec < cfg.management_reduce_cooldown_sec) {
          factors.push(`target_reduce_cooldown (${elapsedSec.toFixed(0)}s < ${cfg.management_reduce_cooldown_sec}s)`);
          return {
            state: 'HOLD',
            reason: `target_reduce_cooldown_active: ${elapsedSec.toFixed(0)}s < ${cfg.management_reduce_cooldown_sec}s`,
            factors,
          };
        }

        let fireNow = false;
        if (deltaDrop >= cfg.reduce_large_delta_threshold) {
          fireNow = true;
        } else {
          runtime.small_drop_cycles_consecutive += 1;
          fireNow = runtime.small_drop_cycles_consecutive >= cfg.reduce_persistence_cycles_small_delta;
        }

        if (!fireNow) {
          factors.push(`pending_small_drop_persistence ${runtime.small_drop_cycles_consecutive}/${cfg.reduce_persistence_cycles_small_delta}`);
          return {
            state: 'HOLD',
            reason: `pending_small_drop_persistence ${runtime.small_drop_cycles_consecutive}/${cfg.reduce_persistence_cycles_small_delta}`,
            factors,
          };
        }

        const cappedQty = Math.min(deltaDrop, cfg.max_target_reduce_per_cycle);
        runtime.small_drop_cycles_consecutive = 0;
        factors.push(`target_position_reduce delta=${deltaDrop} capped=${cappedQty} bound_by=${targetResult.bound_by}`);
        factors.push('ev_reduce_suppressed_by_target_reduce');
        return {
          state: 'REDUCE',
          reason: `target_position_reduce: q_target=${qTarget} < q_current=${qCurrent} (delta=${deltaDrop}, capped=${cappedQty}, bound_by=${targetResult.bound_by})`,
          factors,
          requested_qty_to_exit: cappedQty,
        };
      }

      if (deltaDrop < cfg.management_reduce_min_delta) {
        runtime.small_drop_cycles_consecutive = 0;
      }
    }

    if (features.time_stop_remaining_seconds > 0
      && features.time_stop_remaining_seconds < TIME_STOP_URGENCY_SECS
      && features.current_r < 0.5) {
      factors.push(`time_stop_imminent(${features.time_stop_remaining_seconds}s)`);
    }
    if (pop.pop_target1_before_stop < LOW_POP_THRESHOLD) {
      factors.push(`low_pop_t1(${pop.pop_target1_before_stop})`);
    }
    if (features.regime === 'choppy' || features.regime === 'high_volatility_impulse') {
      factors.push(`adverse_regime(${features.regime})`);
    }
    if (evDelta > HOLD_EDGE_THRESHOLD_USD) {
      factors.push(`ev_hold_better(+$${evDelta.toFixed(0)})`);
    } else if (evDelta < -HOLD_EDGE_THRESHOLD_USD) {
      factors.push(`ev_exit_better($${Math.abs(evDelta).toFixed(0)})`);
    } else {
      factors.push('ev_near_neutral');
    }

    if (evDelta < -HOLD_EDGE_THRESHOLD_USD) {
      return {
        state: 'EXIT_NOW',
        reason: `EV(exit) beats EV(hold) by $${Math.abs(evDelta).toFixed(0)}`,
        factors,
      };
    }
    if (pop.pop_target1_before_stop < LOW_POP_THRESHOLD && unrealizedPnl > 0) {
      return {
        state: 'EXIT_NOW',
        reason: `PoP(T1)=${pop.pop_target1_before_stop} is low while trade is profitable - protect gains`,
        factors,
      };
    }
    if (features.time_stop_remaining_seconds > 0
      && features.time_stop_remaining_seconds < TIME_STOP_URGENCY_SECS
      && features.current_r < 0.3) {
      return {
        state: 'EXIT_NOW',
        reason: `Time stop imminent (${features.time_stop_remaining_seconds}s) with trade near flat`,
        factors,
      };
    }
    if (features.current_r >= 0.5
      && !features.partial_exit_done
      && !features.pt1_done
      && features.distance_to_stop_pts > features.distance_to_t1_pts * 0.5) {
      return {
        state: 'MOVE_STOP',
        reason: `Trade at ${features.current_r.toFixed(2)}R - consider moving stop to breakeven`,
        factors: [...factors, 'stop_not_at_be'],
      };
    }
    if (evReduce > unrealizedPnl * 0.8
      && pop.pop_target1_before_stop < 0.45
      && unrealizedPnl > 0) {
      return {
        state: 'REDUCE',
        reason: `PoP(T1)=${pop.pop_target1_before_stop} low - reduce and protect partial gains`,
        factors: [...factors, 'pop_below_threshold'],
      };
    }

    return {
      state: 'HOLD',
      reason: `PoP(T1)=${pop.pop_target1_before_stop}, PoP(T2)=${pop.pop_target2_before_stop} - maintain position`,
      factors,
    };
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
