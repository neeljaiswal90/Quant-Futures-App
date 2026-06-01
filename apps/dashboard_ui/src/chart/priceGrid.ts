import { MNQ_TICK } from "../contract/render";

export function priceToTickKey(price: number, tickSize = MNQ_TICK): number {
  return Math.round(price / tickSize);
}

export function tickKeyToPrice(key: number, tickSize = MNQ_TICK): number {
  return key * tickSize;
}

export function snapPrice(price: number, tickSize = MNQ_TICK): number {
  return tickKeyToPrice(priceToTickKey(price, tickSize), tickSize);
}

export function samePriceBucket(
  a: number,
  b: number,
  tickSize = MNQ_TICK,
): boolean {
  return priceToTickKey(a, tickSize) === priceToTickKey(b, tickSize);
}
