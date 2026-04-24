import { describe, expect, it } from 'vitest';
import { getContractSpec } from '../../src/risk/contracts.js';
import { PositionManager } from '../../src/management/position-manager/index.js';
import { buildDefaultProfileFromConfig, resolveProfile } from '../../src/management/management-profiles.js';
import { makeConfig, makeSnapshot } from './helpers.js';

const contract = getContractSpec('MNQ1!');

function buildManager() {
  return new PositionManager(contract);
}

function buildPositionManagerState() {
  const config = makeConfig();
  const profile = resolveProfile(buildDefaultProfileFromConfig(config), 10, contract);
  const setup = {
    direction: 'long' as const,
    setup_type: 'trend_pullback_long' as const,
    entry_low: 20_000,
    entry_high: 20_000,
    stop: 19_990,
    target_1: 20_012,
    target_2: 20_030,
    target_3: null,
    risk_pts: 10,
    rr_t1: 1.2,
    rr_t2: 3,
    confidence: 8.4,
    confidence_factors: ['fixture'],
    reason: 'fixture',
    target_1_direction_valid: true,
    target_2_direction_valid: true,
    target_3_direction_valid: true,
    target_ordering_valid: true,
    target_repair_applied: false,
  };
  const position = PositionManager.buildPosition({
    trade_id: 'TRADE-1',
    signal_id: 'SIGNAL-1',
    session_id: 'SESSION-1',
    setup,
    fill_price: 20_000,
    fill_time_iso: '2026-01-01T10:00:00.000Z',
    quantity: 2,
    notional_usd: 40_000,
    regime_at_entry: 'trending_up',
    strategy_version: 'v1',
    confidence_at_entry: 8.4,
    management_params: profile,
    entry_state_vector: null,
  }, contract);
  return { config, position };
}

describe('PositionManager futures behavior', () => {
  it('triggers PT1 and applies trailing on partial exits', () => {
    const manager = buildManager();
    const { config, position } = buildPositionManagerState();
    manager.openPosition(position);

    const decision = manager.evaluate(20_006, config);
    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toBe('partial_profit_1');

    manager.applyPt1Exit({
      order_id: 'exit-1',
      fill_price: 20_006,
      fill_time_iso: '2026-01-01T10:02:00.000Z',
      quantity: 1,
      side: 'long',
      slippage_pts: 0.25,
      fee_usd: 0.5,
      status: 'simulated',
    }, 1);

    const open = manager.getPosition();
    expect(open?.pt1_done).toBe(true);
    expect(open?.trailing_active).toBe(true);
    expect(open?.quantity_remaining).toBe(1);
  });

  it('returns stop-loss decisions when price breaches the active stop', () => {
    const manager = buildManager();
    const { config, position } = buildPositionManagerState();
    manager.openPosition(position);
    const decision = manager.evaluate(19_989.75, config);
    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toBe('stop_loss');
    expect(decision.plannedExitPrice).toBeLessThanOrEqual(position.stop_current);
  });

  it('allows time-stop exits only after the configured hold period', () => {
    const manager = buildManager();
    const { config, position } = buildPositionManagerState();
    position.entry_time_unix = Date.parse('2026-01-01T09:00:00.000Z');
    manager.openPosition(position);
    const decision = manager.evaluate(20_001, config, Date.parse('2026-01-01T09:31:00.000Z'));
    expect(decision.shouldExit).toBe(true);
    expect(decision.reason).toBe('time_stop');
  });

  it('closes positions into a compact trade record', () => {
    const manager = buildManager();
    const { position } = buildPositionManagerState();
    manager.openPosition(position);
    const record = manager.closePosition({
      order_id: 'exit-final',
      fill_price: 20_010,
      fill_time_iso: '2026-01-01T10:05:00.000Z',
      quantity: 2,
      side: 'long',
      slippage_pts: 0.25,
      fee_usd: 0.5,
      status: 'simulated',
    }, 'target_2', 20_010);

    expect(record.exit_reason).toBe('target_2');
    expect(record.pnl_realized).toBeGreaterThan(0);
    expect(record.exit_legs?.length).toBe(1);
  });
});
