/**
 * QFA-115 Backtest Run Specification — deterministic run-id derivation.
 *
 * Run-ID grammar (Q-2):
 *
 *   bt-{instrument_root}-{bar_token}-{window_token}-{strategy_token}-{hash12}
 *
 *   instrument_root: lowercased (e.g., "MNQ" -> "mnq")
 *   bar_token:       deriveBarToken (time-bar pass-through; tick-derived -> tickN/volN/dolN)
 *   window_token:    deriveWindowToken (session: sYYYYMMDD[-YYYYMMDD]; instant: iISO[-ISO])
 *   strategy_token:  deriveStrategyToken (single: abbreviation; multi: multi{count})
 *   hash12:          first 12 lower-case hex chars of computeRunSpecHash
 *
 * The grammar is human-scannable: an operator reading a journal can identify
 * the instrument, bar, window, and strategy class without dereferencing the
 * full RunSpec. This is the property Session 1's `backtest-${64-hex}` form
 * lacked.
 *
 * Derivation functions re-validate their inputs even though RunSpec
 * validation runs first via `computeRunSpecHash`. The reason: tooling may
 * call these helpers standalone (e.g., to preview the run-id of a partial
 * spec); independent validation produces clearer diagnostic messages at the
 * call site rather than at canonicalization time.
 */

import type { StrategyId } from './strategy-ids.js';
import { computeRunSpecHash } from './run-spec-hash.js';
import type { BacktestWindow, RunSpec } from './run-spec.js';

/**
 * Result of {@link deriveRunId}: the deterministic run-id plus the
 * underlying run-spec hash that anchors lineage.
 */
export interface RunIdentity {
  /** Human-scannable run-id per the QFA-115 grammar. */
  readonly run_id: string;
  /** Lower-case 64-character hex sha256 of the canonicalized RunSpec. */
  readonly run_spec_hash: string;
}

/**
 * Single-strategy run-id abbreviations. Keyed by the active StrategyId
 * union, so adding new strategies (e.g., the Phase 5 mean-reversion entries
 * `mr_long_rth` / `mr_short_rth` planned in QFA-601/QFA-602) requires
 * extending BOTH the StrategyId union AND this map atomically; the
 * compiler enforces that.
 *
 * NOT exported. The mapping is internal to run-id derivation.
 */
const STRATEGY_ID_TO_RUN_ID_ABBREV: Record<StrategyId, string> = {
  trend_pullback_long: 'tp_long',
  trend_pullback_short: 'tp_short',
  breakout_retest_long: 'bro_long',
  breakdown_retest_short: 'bro_short',
  regime_mean_reversion_long: 'rmr_long',
  regime_mean_reversion_short: 'rmr_short',
  liquidity_sweep_reversal_long: 'lsr_long',
  liquidity_sweep_reversal_short: 'lsr_short',
  vwap_overnight_reversal_long: 'vor_long',
  vwap_overnight_reversal_short: 'vor_short',
  regime_shock_reversion_short_v2: 'rsr_short_v2',
};

const TIME_BAR_RE = /^[1-9][0-9]*(s|m|h|d)$/u;
const TICK_BAR_RE = /^tick:(ticks|volume|dollar):([1-9][0-9]*)$/u;
const SESSION_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u;

/**
 * Tokenize a `bar_spec` per Q-2.5. Time bars pass through unchanged; tick
 * bars compress to one of `tick<N>`, `vol<N>`, `dol<N>` so the tick
 * type is visible in the run-id.
 *
 * Throws if `bar_spec` does not match the locked grammar.
 */
export function deriveBarToken(bar_spec: string): string {
  if (TIME_BAR_RE.test(bar_spec)) return bar_spec;
  const tickMatch = TICK_BAR_RE.exec(bar_spec);
  if (tickMatch !== null) {
    const kind = tickMatch[1]!;
    const count = tickMatch[2]!;
    switch (kind) {
      case 'ticks':
        return `tick${count}`;
      case 'volume':
        return `vol${count}`;
      case 'dollar':
        return `dol${count}`;
      // istanbul ignore next — kind is constrained by the regex group above
      default:
        throw new Error(`Unrecognized tick bar kind: ${kind}`);
    }
  }
  throw new Error(
    `Invalid bar_spec: ${bar_spec}; expected time-bar (e.g., 1m, 5m, 1h) or tick-bar (tick:ticks:N, tick:volume:N, tick:dollar:N)`,
  );
}

/**
 * Tokenize a `BacktestWindow` per Q-2.4. Session mode produces `s`-prefixed
 * dates; instant mode produces `i`-prefixed UTC instants. Single-point
 * windows omit the dash range; multi-point windows include `start-end`.
 *
 * Throws if window dates/instants do not match the expected format.
 */
export function deriveWindowToken(window: BacktestWindow): string {
  if (window.mode === 'session') {
    const startToken = sessionDateToToken(window.start, 'start');
    const endToken = sessionDateToToken(window.end, 'end');
    return startToken === endToken ? `s${startToken}` : `s${startToken}-${endToken}`;
  }
  // instant mode
  const startToken = instantToToken(window.start, 'start');
  const endToken = instantToToken(window.end, 'end');
  return startToken === endToken ? `i${startToken}` : `i${startToken}-${endToken}`;
}

function sessionDateToToken(value: string, label: 'start' | 'end'): string {
  const match = SESSION_DATE_RE.exec(value);
  if (match === null) {
    throw new Error(`Invalid session-mode ${label}: ${value}; expected YYYY-MM-DD`);
  }
  const [, year, month, day] = match;
  return `${year}${month}${day}`;
}

function instantToToken(value: string, label: 'start' | 'end'): string {
  const match = INSTANT_RE.exec(value);
  if (match === null) {
    throw new Error(
      `Invalid instant-mode ${label}: ${value}; expected canonical UTC ISO-8601 (YYYY-MM-DDTHH:MM:SSZ; no fractional seconds per Q-2.4)`,
    );
  }
  const [, year, month, day, hh, mm, ss] = match;
  return `${year}${month}${day}T${hh}${mm}${ss}Z`;
}

/**
 * Tokenize the strategy set per Q-2.2. Single strategy -> abbreviation from
 * `STRATEGY_ID_TO_RUN_ID_ABBREV`. Multi strategy -> `multi{count}`.
 *
 * Caller is expected to pass deduped, validated strategy IDs (RunSpec
 * validation already enforces this). If passed an empty array, throws.
 */
export function deriveStrategyToken(strategy_ids: readonly StrategyId[]): string {
  if (strategy_ids.length === 0) {
    throw new Error('deriveStrategyToken requires at least one strategy_id');
  }
  if (strategy_ids.length === 1) {
    const id = strategy_ids[0]!;
    const abbrev = STRATEGY_ID_TO_RUN_ID_ABBREV[id];
    if (abbrev === undefined) {
      throw new Error(`No run-id abbreviation registered for strategy_id: ${id}`);
    }
    return abbrev;
  }
  return `multi${String(strategy_ids.length)}`;
}

/**
 * Compose the deterministic run-id and run-spec hash for a fully-specified
 * RunSpec. Returns both so callers can attach the hash to lineage payloads
 * without recomputing.
 *
 * Invariant: identical RunSpec content (modulo object key insertion order)
 * always produces identical RunIdentity.
 */
export function deriveRunId(spec: RunSpec): RunIdentity {
  const run_spec_hash = computeRunSpecHash(spec);
  const root = spec.instrument_root.toLowerCase();
  const bar = deriveBarToken(spec.bar_spec);
  const win = deriveWindowToken(spec.backtest_window);
  const strat = deriveStrategyToken(spec.strategy_ids);
  const hash12 = run_spec_hash.slice(0, 12);
  const run_id = `bt-${root}-${bar}-${win}-${strat}-${hash12}`;
  return { run_id, run_spec_hash };
}
