import { readReplayDatasetJsonl, readReplayTradeTapeJsonl } from './jsonl.js';
import type {
  NormalizedSignalDirection,
  ReplayDatasetInput,
  ReplayDatasetLoadOptions,
  ReplaySignalCandidateSeed,
  ReplaySignalRow,
  ReplaySignalRowJson,
} from './types.js';
import { nsToDecimalString } from './time.js';

export function loadReplayDatasetInput(options: ReplayDatasetLoadOptions): ReplayDatasetInput {
  const rows = readReplayDatasetJsonl(options.datasetPath);
  const tradeTapePath = resolveTradeTapePath(rows, options.tradeTapePath);
  return Object.freeze({
    dataset_path: options.datasetPath,
    trade_tape_path: tradeTapePath,
    rows,
    trade_tape: readReplayTradeTapeJsonl(tradeTapePath),
  });
}

export function resolveTradeTapePath(
  rows: readonly ReplaySignalRow[],
  explicitTradeTapePath?: string,
): string {
  if (explicitTradeTapePath !== undefined && explicitTradeTapePath.trim().length > 0) {
    return explicitTradeTapePath;
  }
  if (rows.length === 0) {
    throw new Error('cannot infer trade tape path from an empty replay dataset');
  }
  const paths = new Set(rows.map((row) => row.replay.source_obs01));
  if (paths.size !== 1) {
    throw new Error(
      `replay dataset contains conflicting source_obs01 paths: ${[...paths].sort().join(', ')}`,
    );
  }
  return rows[0]!.replay.source_obs01;
}

export function toReplaySignalCandidateSeed(row: ReplaySignalRow): ReplaySignalCandidateSeed {
  return Object.freeze({
    seed_schema_version: 1,
    seed_id: [
      row.replay.capture_date,
      row.replay.session,
      nsToDecimalString(row.ts_ns),
      row.family,
      row.event_type,
      row.level_id ?? 'no-level',
      row.side ?? 'no-side',
    ].join('|'),
    ts_ns: row.ts_ns,
    family: row.family,
    event_type: row.event_type,
    signal_price: row.price,
    level_id: row.level_id,
    side: row.side,
    normalized_direction: normalizeSignalDirection(row.direction, row.side),
    capture_date: row.replay.capture_date,
    session: row.replay.session,
    source_obs01: row.replay.source_obs01,
  });
}

/**
 * Resolve a signal's directional bias from its direction and/or side fields.
 *
 * QFA-DATA-LEAK FIX: this MUST stay at parity with the canonical Python
 * resolver `services/replay/replay/setups.py:_direction`. The setup-deriver
 * (Python) and this labeler (TS) independently resolve direction; any
 * disagreement silently drops training examples — a directional setup whose
 * label comes back `neutral_direction` is excluded in dataset.py's join.
 *
 * The previous TS version recognized only `buy/sell/bid/ask` on the `side`
 * field and used exact equality, so the detectors' actual emissions —
 * `side="short"/"long"` and `side_inferred="sell_absorbed"/"buy_absorbed"` —
 * fell through to `unknown` and ~70% of directional firings were dropped.
 *
 * Order matters: absorption tokens are checked BEFORE the generic long/short
 * tokens because `buy_absorbed` contains "buy" but means SHORT (buyers
 * absorbed → sellers won), and `sell_absorbed` means LONG. Mirrors Python.
 */
export function normalizeSignalDirection(
  direction: string | null,
  side: string | null = null,
): NormalizedSignalDirection {
  const text = [direction, side]
    .filter((part): part is string => Boolean(part))
    .join(' ')
    .toLowerCase();

  if (text.includes('neutral') || text.includes('mixed') || text.includes('balanced')) {
    return 'neutral';
  }
  // Absorption semantics invert — check before the generic buy/sell tokens.
  if (text.includes('buy_absorbed')) {
    return 'short';
  }
  if (text.includes('sell_absorbed')) {
    return 'long';
  }
  if (['long', 'bull', 'up', 'buy', 'bid'].some((token) => text.includes(token))) {
    return 'long';
  }
  if (['short', 'bear', 'down', 'sell', 'ask'].some((token) => text.includes(token))) {
    return 'short';
  }
  return 'unknown';
}

export function replaySignalRowToJson(row: ReplaySignalRow): ReplaySignalRowJson {
  return Object.freeze({
    schema_version: row.schema_version,
    ts_ns: nsToDecimalString(row.ts_ns),
    family: row.family,
    event_type: row.event_type,
    tier: row.tier,
    price: row.price,
    level_id: row.level_id,
    side: row.side,
    direction: row.direction,
    replay: {
      capture_date: row.replay.capture_date,
      session: row.replay.session,
      step_ns: nsToDecimalString(row.replay.step_ns),
      source_obs01: row.replay.source_obs01,
      source_mbo: row.replay.source_mbo,
      schema_version: row.replay.schema_version,
    },
  });
}
