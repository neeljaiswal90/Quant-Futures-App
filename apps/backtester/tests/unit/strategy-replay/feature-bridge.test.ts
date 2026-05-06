import { describe, expect, it } from 'vitest';

import {
  buildReplayFeatureSnapshot,
  REPLAY_SANITY_PLACEHOLDER_FIELDS,
  STRATEGY_REPLAY_FEATURE_SOURCE,
} from '../../../src/strategy-replay/index.js';
import { REPLAY_BARS } from './fixtures.js';

describe('strategy replay feature bridge', () => {
  it('converts a BuiltBar into a valid strategy snapshot', () => {
    const bridged = buildReplayFeatureSnapshot(REPLAY_BARS[0]!, [REPLAY_BARS[0]!]);

    expect(bridged.feature_source).toBe(STRATEGY_REPLAY_FEATURE_SOURCE);
    expect(bridged.placeholder_fields).toEqual(REPLAY_SANITY_PLACEHOLDER_FIELDS);
    expect(bridged.snapshot.bars).toHaveLength(1);
    expect(bridged.snapshot.bars[0]?.close).toBe(100);
    expect(bridged.snapshot.quote.mid_px).toBe(100);
    expect(bridged.snapshot.session.is_rth).toBe(true);
    expect(bridged.snapshot.microstructure.values.feature_source).toBe(
      STRATEGY_REPLAY_FEATURE_SOURCE,
    );
  });

  it('derives deterministic rolling fields for identical bar history', () => {
    const first = buildReplayFeatureSnapshot(REPLAY_BARS[2]!, REPLAY_BARS.slice(0, 3));
    const second = buildReplayFeatureSnapshot(REPLAY_BARS[2]!, REPLAY_BARS.slice(0, 3));

    expect(second).toEqual(first);
    expect(first.snapshot.indicators.sigma_pts).toBeTypeOf('number');
    expect(first.snapshot.indicators.ema_9).toBeTypeOf('number');
    expect(first.snapshot.structure.values.nearest_resistance).toBeTypeOf('number');
  });
});
