import { describe, expect, it } from 'vitest';

import type { ManagementActionId } from '../../../src/contracts/ids.js';
import { createManagementExitOrderIntent, toOrderIntentEventPayload } from '../../../src/execution/simulated-execution.js';

const instrument = {
  symbol: 'MNQ',
  root: 'MNQ',
  exchange: 'CME',
  tick_size: 0.25,
  point_value: 2,
  currency: 'USD',
  price_decimals: 2,
} as const;

function position(side: 'long' | 'short') {
  return {
    position_id: `position-${side}` as never,
    candidate_id: `candidate-${side}` as never,
    instrument,
    side,
  };
}

describe('management exit order-intent parity', () => {
  it.each([
    'fail_safe:profile_mismatch',
    'fail_safe:stale_market',
    'fail_safe:invalid_market_price',
    'fail_safe:missing_stop',
    'fail_safe:invalid_quantity',
    'fail_safe:invalid_target_position:$.side',
    'fail_safe:max_spread_ticks_exceeded',
  ])('creates loose flattening parity for fail-safe subtype %s', (reason) => {
    const managementActionId = `mgmt-${reason.replaceAll(/[^a-z0-9]+/gi, '-')}` as ManagementActionId;
    const intent = createManagementExitOrderIntent({
      position: position('short'),
      management_action_id: managementActionId,
      quantity: 2,
      submitted_ts_ns: '2' as never,
      config: { config_hash: 'config-hash' } as never,
    });
    const runnerEnrichedPayload = {
      ...toOrderIntentEventPayload(intent),
      management_action_id: managementActionId,
    };

    expect(intent.side).toBe('buy');
    expect(intent.type).toBe('market');
    expect(intent.quantity).toBe(2);
    expect(intent.time_in_force).toBe('ioc');
    expect(runnerEnrichedPayload.management_action_id).toBe(managementActionId);
  });

  it('creates loose flattening parity for corrected stop-hit EXIT_FULL actions', () => {
    const managementActionId = 'mgmt-stop-hit-corrected-overlap' as ManagementActionId;
    const intent = createManagementExitOrderIntent({
      position: position('long'),
      management_action_id: managementActionId,
      quantity: 1,
      submitted_ts_ns: '3' as never,
      config: { config_hash: 'config-hash' } as never,
    });
    const runnerEnrichedPayload = {
      ...toOrderIntentEventPayload(intent),
      management_action_id: managementActionId,
    };

    expect(intent.side).toBe('sell');
    expect(intent.type).toBe('market');
    expect(intent.quantity).toBe(1);
    expect(intent.time_in_force).toBe('ioc');
    expect(runnerEnrichedPayload.management_action_id).toBe(managementActionId);
    expect(runnerEnrichedPayload).not.toHaveProperty('exit_price');
  });
});
