import type { DepthPayload, RealtimeMessage } from "@contracts/realtime/events";
import { isDepth, isPriceTick } from "../contract/guards";

export const LIVE_BACKFILL_BUFFER_CAP = 512;

export type TradeAggressorSide = "buy" | "sell" | "unknown";

export interface BookmapBackfillLimits {
  price_ticks_max: number;
  depth_columns_max: number;
  max_age_seconds: number;
}

export interface BookmapPriceTickRecord {
  seq: number;
  ts_ns: number;
  price: number;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  aggressor_side: TradeAggressorSide;
  orderflow_quality: string | null;
  last_trade_delta: number | null;
}

export interface BookmapDepthRecord extends DepthPayload {
  seq: number;
}

export interface BookmapBackfillResponse {
  schema_version: number;
  trading_date: string | null;
  session: string | null;
  generated_at_ns: number;
  through_seq: number;
  limits: BookmapBackfillLimits;
  price_ticks: BookmapPriceTickRecord[];
  depth: BookmapDepthRecord[];
}

export function normalizeBookmapBackfill(raw: unknown): BookmapBackfillResponse | null {
  if (!isObject(raw)) return null;
  const priceTicks = Array.isArray(raw.price_ticks)
    ? raw.price_ticks.flatMap((row) => normalizePriceTick(row))
    : [];
  const depth = Array.isArray(raw.depth)
    ? raw.depth.flatMap((row) => normalizeDepth(row))
    : [];
  return {
    schema_version: numberOr(raw.schema_version, 1),
    trading_date: stringOrNull(raw.trading_date),
    session: stringOrNull(raw.session),
    generated_at_ns: numberOr(raw.generated_at_ns, Date.now() * 1e6),
    through_seq: numberOr(raw.through_seq, -1),
    limits: normalizeLimits(raw.limits),
    price_ticks: priceTicks.sort((a, b) => a.ts_ns - b.ts_ns || a.seq - b.seq),
    depth: depth.sort((a, b) => a.ts_ns - b.ts_ns || a.seq - b.seq),
  };
}

export function mergeBackfillWithLiveFrames(
  backfill: BookmapBackfillResponse,
  liveFrames: readonly RealtimeMessage[],
): BookmapBackfillResponse {
  const priceByKey = new Map<string, BookmapPriceTickRecord>();
  for (const tick of backfill.price_ticks) priceByKey.set(priceTickKey(tick), tick);

  const depthBySeq = new Map<number, BookmapDepthRecord>();
  for (const column of backfill.depth) depthBySeq.set(column.seq, column);

  for (const frame of liveFrames) {
    const price = priceTickFromMessage(frame);
    if (price) {
      priceByKey.set(priceTickKey(price), {
        ...priceByKey.get(priceTickKey(price)),
        ...price,
      });
      continue;
    }
    const depth = depthFromMessage(frame);
    if (depth) depthBySeq.set(depth.seq, depth);
  }

  return {
    ...backfill,
    price_ticks: [...priceByKey.values()].sort(
      (a, b) => a.ts_ns - b.ts_ns || a.seq - b.seq,
    ),
    depth: [...depthBySeq.values()].sort((a, b) => a.ts_ns - b.ts_ns || a.seq - b.seq),
  };
}

export function appendBoundedLiveFrame(
  buffer: RealtimeMessage[],
  msg: RealtimeMessage,
  cap = LIVE_BACKFILL_BUFFER_CAP,
): void {
  if (cap <= 0) {
    buffer.length = 0;
    return;
  }
  buffer.push(msg);
  if (buffer.length > cap) {
    buffer.splice(0, buffer.length - cap);
  }
}

export function priceTickKey(tick: Pick<BookmapPriceTickRecord, "ts_ns" | "price" | "volume">): string {
  return `${tick.ts_ns}|${tick.price}|${tick.volume ?? 0}`;
}

export function isBookmapFrame(msg: RealtimeMessage): boolean {
  return isPriceTick(msg.payload) || isDepth(msg.payload);
}

function priceTickFromMessage(msg: RealtimeMessage): BookmapPriceTickRecord | null {
  if (!isPriceTick(msg.payload)) return null;
  const orderflow = msg.payload.orderflow;
  const aggressor = normalizeAggressor(orderflow?.last_trade_aggressor);
  return {
    seq: msg.seq,
    ts_ns: msg.ts_ns,
    price: msg.payload.price,
    bid: msg.payload.bid,
    ask: msg.payload.ask,
    volume: msg.payload.volume,
    aggressor_side: aggressor,
    orderflow_quality: orderflow?.quality ?? null,
    last_trade_delta: orderflow?.last_trade_delta ?? null,
  };
}

function depthFromMessage(msg: RealtimeMessage): BookmapDepthRecord | null {
  if (!isDepth(msg.payload)) return null;
  return { ...msg.payload, seq: msg.seq };
}

function normalizePriceTick(row: unknown): BookmapPriceTickRecord[] {
  if (!isObject(row)) return [];
  const ts = maybeNumber(row.ts_ns);
  const price = maybeNumber(row.price);
  if (ts == null || price == null) return [];
  return [
    {
      seq: numberOr(row.seq, -1),
      ts_ns: ts,
      price,
      bid: nullableNumber(row.bid),
      ask: nullableNumber(row.ask),
      volume: nullableNumber(row.volume),
      aggressor_side: normalizeAggressor(row.aggressor_side),
      orderflow_quality: stringOrNull(row.orderflow_quality),
      last_trade_delta: nullableNumber(row.last_trade_delta),
    },
  ];
}

function normalizeDepth(row: unknown): BookmapDepthRecord[] {
  if (!isObject(row)) return [];
  const ts = maybeNumber(row.ts_ns);
  const nTicks = maybeNumber(row.n_ticks);
  const quality = String(row.quality ?? "");
  if (ts == null || nTicks == null) return [];
  if (!["live", "inferred", "stale_l1", "unavailable"].includes(quality)) return [];
  return [
    {
      seq: numberOr(row.seq, -1),
      family: "depth",
      ts_ns: ts,
      mid: nullableNumber(row.mid),
      bid_levels: normalizeLevels(row.bid_levels),
      ask_levels: normalizeLevels(row.ask_levels),
      n_ticks: nTicks,
      quality: quality as DepthPayload["quality"],
    },
  ];
}

function normalizeLevels(raw: unknown): DepthPayload["bid_levels"] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => {
    if (!isObject(row)) return [];
    const price = maybeNumber(row.price);
    const size = maybeNumber(row.size);
    if (price == null || size == null) return [];
    return [{ price, size }];
  });
}

function normalizeLimits(raw: unknown): BookmapBackfillLimits {
  const obj = isObject(raw) ? raw : {};
  return {
    price_ticks_max: numberOr(obj.price_ticks_max, 100_000),
    depth_columns_max: numberOr(obj.depth_columns_max, 12_000),
    max_age_seconds: numberOr(obj.max_age_seconds, 8 * 60 * 60),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function maybeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : maybeNumber(value);
}

function numberOr(value: unknown, fallback: number): number {
  return maybeNumber(value) ?? fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeAggressor(value: unknown): TradeAggressorSide {
  const text = String(value ?? "unknown").toLowerCase();
  if (text === "buy" || text === "sell") return text;
  return "unknown";
}
