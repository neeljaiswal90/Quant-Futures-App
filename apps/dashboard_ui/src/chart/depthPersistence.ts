import { MNQ_TICK } from "../contract/render";
import { snapPrice } from "./priceGrid";

/**
 * RA-112d: shortened 43s → 18s so the heatmap tracks CURRENT resting size more
 * crisply and old liquidity smears less across time (shorter horizontal
 * trails). A persistent wall that keeps getting refilled still accumulates and
 * stands out; transient liquidity decays away in ~18s instead of lingering.
 */
export const DEFAULT_HALF_LIFE_SECONDS = 18;
export const DEFAULT_PRUNE_THRESHOLD = 0.5;
export const MAX_ACCUMULATOR_PRICE_KEYS = 2_000;

export interface DepthPersistenceInputLevel {
  price: number;
  size: number;
}

export interface DepthPersistenceOptions {
  halfLifeSeconds?: number;
  pruneThreshold?: number;
  maxPriceKeys?: number;
}

/**
 * Client-side Bookmap-style liquidity persistence.
 *
 * The operator-facing parameter is half-life in seconds, not a frame-count
 * decay constant. Each update applies:
 *
 *   next = previous * 0.5 ** (elapsed_seconds / half_life_seconds) + raw_size
 *
 * That keeps the wall-clock decay stable when the backend emits sparse,
 * deduped depth frames instead of a fixed 4 fps stream. Scores are
 * "lot-frames": a decay-weighted presence x size x time measure, not lots.
 */
export class DepthPersistenceAccumulator {
  private readonly halfLifeSeconds: number;
  private readonly pruneThreshold: number;
  private readonly maxPriceKeys: number;
  private readonly scores = new Map<number, number>();
  private lastTsNs: number | null = null;

  constructor(options: DepthPersistenceOptions = {}) {
    this.halfLifeSeconds = Math.max(
      0.001,
      options.halfLifeSeconds ?? DEFAULT_HALF_LIFE_SECONDS,
    );
    this.pruneThreshold = Math.max(
      0,
      options.pruneThreshold ?? DEFAULT_PRUNE_THRESHOLD,
    );
    this.maxPriceKeys = Math.max(1, options.maxPriceKeys ?? MAX_ACCUMULATOR_PRICE_KEYS);
  }

  update(
    levels: readonly DepthPersistenceInputLevel[],
    tsNs: number,
  ): ReadonlyMap<number, number> {
    const rawByPrice = rawLevelMap(levels);
    this.decayExisting(tsNs);
    for (const [price, size] of rawByPrice) {
      this.scores.set(price, (this.scores.get(price) ?? 0) + size);
    }
    this.prune();
    this.pruneOverflow();
    this.lastTsNs = Number.isFinite(tsNs) ? tsNs : this.lastTsNs;
    return this.state();
  }

  clear(): void {
    this.scores.clear();
    this.lastTsNs = null;
  }

  state(): ReadonlyMap<number, number> {
    return new Map(this.scores);
  }

  private decayExisting(tsNs: number): void {
    if (this.lastTsNs == null || !Number.isFinite(tsNs) || tsNs <= this.lastTsNs) {
      return;
    }
    const elapsedSeconds = (tsNs - this.lastTsNs) / 1_000_000_000;
    const decay = Math.pow(0.5, elapsedSeconds / this.halfLifeSeconds);
    for (const [price, score] of this.scores) {
      this.scores.set(price, score * decay);
    }
  }

  private prune(): void {
    for (const [price, score] of this.scores) {
      if (!Number.isFinite(score) || score <= this.pruneThreshold) {
        this.scores.delete(price);
      }
    }
  }

  private pruneOverflow(): void {
    if (this.scores.size <= this.maxPriceKeys) return;
    const ranked = [...this.scores.entries()].sort((a, b) => b[1] - a[1]);
    this.scores.clear();
    for (let index = 0; index < ranked.length && index < this.maxPriceKeys; index += 1) {
      const [price, score] = ranked[index];
      this.scores.set(price, score);
    }
  }
}

export function rawLevelMap(
  levels: readonly DepthPersistenceInputLevel[],
): ReadonlyMap<number, number> {
  const map = new Map<number, number>();
  for (const level of levels) {
    if (!Number.isFinite(level.price) || !Number.isFinite(level.size) || level.size <= 0) {
      continue;
    }
    const price = snapPrice(level.price, MNQ_TICK);
    map.set(price, (map.get(price) ?? 0) + level.size);
  }
  return map;
}
