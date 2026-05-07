import type { DbnMboRecord, DbnMbp10Record, DbnMbp1Record, DbnTbboRecord } from '../dbn-types.js';
import type { UnixNs } from '../../contracts/time.js';
import { createQueueSynthesisSourceMetadata } from './source-metadata.js';
import type {
  QueueBookSide,
  QueueSynthesisConfidence,
  QueueStateSnapshot,
  QueueSynthesisMode,
  QueueSynthesisOptions,
  QueueSynthesisQualityFlag,
  QueueSynthesisSourceMetadata,
} from './types.js';
import {
  definitionQualityFlags,
  mboBookSide,
  type QueueContractIdentity,
} from './record-adapter.js';

interface PriceLevelState {
  readonly instrument_id: number;
  readonly raw_symbol: string | null;
  readonly side: QueueBookSide;
  readonly price: bigint;
  readonly estimated_queue_ahead: bigint | null;
  readonly estimated_visible_size: bigint | null;
  readonly estimated_trade_depletion: bigint;
  readonly estimated_visible_reduction: bigint;
  readonly source_metadata: QueueSynthesisSourceMetadata;
}

interface MboOrderState {
  readonly instrument_id: number;
  readonly side: QueueBookSide;
  readonly price: bigint;
  readonly size: bigint;
}

export class QueueSynthesisState {
  private readonly levels = new Map<string, PriceLevelState>();
  private readonly mboOrders = new Map<string, MboOrderState>();
  private readonly trackedProbePrices = new Set<string>();

  constructor(private readonly options: QueueSynthesisOptions, private readonly mode: QueueSynthesisMode) {}

  trackProbePrice(input: {
    readonly instrument_id: number;
    readonly side: 'buy' | 'sell';
    readonly limit_price: bigint;
  }): void {
    this.trackedProbePrices.add(
      this.key(input.instrument_id, input.side === 'buy' ? 'bid' : 'ask', input.limit_price),
    );
  }

  getProbeLevel(input: {
    readonly instrument_id: number;
    readonly side: 'buy' | 'sell';
    readonly limit_price: bigint;
  }): PriceLevelState | null {
    return this.levels.get(this.key(input.instrument_id, input.side === 'buy' ? 'bid' : 'ask', input.limit_price)) ?? null;
  }

  applyMbo(record: DbnMboRecord, identity: QueueContractIdentity): QueueStateSnapshot | null {
    const side = mboBookSide(record.side);
    if (side === null) {
      return null;
    }

    const orderKey = record.order_id.toString();
    const previous = this.mboOrders.get(orderKey);
    const size = BigInt(record.size);

    if (record.action === 'A') {
      this.mboOrders.set(orderKey, {
        instrument_id: record.instrument_id,
        side,
        price: record.price,
        size,
      });
      return this.adjustLevel(record.instrument_id, side, record.price, size, 0n, identity, record.ts_event);
    }

    if (record.action === 'M') {
      if (previous !== undefined) {
        this.adjustLevel(
          previous.instrument_id,
          previous.side,
          previous.price,
          -previous.size,
          previous.size,
          identity,
          record.ts_event,
        );
      }
      this.mboOrders.set(orderKey, {
        instrument_id: record.instrument_id,
        side,
        price: record.price,
        size,
      });
      return this.adjustLevel(record.instrument_id, side, record.price, size, 0n, identity, record.ts_event);
    }

    const reduction = previous === undefined ? size : minBigint(size, previous.size);
    if (previous !== undefined && previous.size > reduction) {
      this.mboOrders.set(orderKey, {
        ...previous,
        size: previous.size - reduction,
      });
    } else {
      this.mboOrders.delete(orderKey);
    }

    return this.adjustLevel(
      previous?.instrument_id ?? record.instrument_id,
      previous?.side ?? side,
      previous?.price ?? record.price,
      -reduction,
      reduction,
      identity,
      record.ts_event,
    );
  }

  applyMbp(record: DbnMbp1Record | DbnMbp10Record, identity: QueueContractIdentity): QueueStateSnapshot[] {
    const snapshots: QueueStateSnapshot[] = [];

    for (const [index, level] of record.levels.entries()) {
      const bid = this.setVisibleLevel(record.instrument_id, 'bid', level.bid_px, BigInt(level.bid_sz), identity, record.ts_event);
      const ask = this.setVisibleLevel(record.instrument_id, 'ask', level.ask_px, BigInt(level.ask_sz), identity, record.ts_event);
      if (index === 0 || this.trackedProbePrices.has(this.key(record.instrument_id, 'bid', level.bid_px))) {
        snapshots.push(bid);
      }
      if (index === 0 || this.trackedProbePrices.has(this.key(record.instrument_id, 'ask', level.ask_px))) {
        snapshots.push(ask);
      }
    }

    return snapshots;
  }

  applyTbbo(record: DbnTbboRecord, identity: QueueContractIdentity): QueueStateSnapshot[] {
    return [
      this.setVisibleLevel(record.instrument_id, 'bid', record.bid_px, BigInt(record.bid_sz), identity, record.ts_event),
      this.setVisibleLevel(record.instrument_id, 'ask', record.ask_px, BigInt(record.ask_sz), identity, record.ts_event),
    ];
  }

  applyTradeDepletion(input: {
    readonly instrument_id: number;
    readonly raw_symbol: string | null;
    readonly side: QueueBookSide;
    readonly price: bigint;
    readonly quantity: bigint;
    readonly ts_ns: UnixNs;
    readonly identity: QueueContractIdentity;
  }): QueueStateSnapshot {
    const existing = this.levels.get(this.key(input.instrument_id, input.side, input.price));
    const nextTradeDepletion = (existing?.estimated_trade_depletion ?? 0n) + input.quantity;
    const state = this.makeLevelState({
      instrument_id: input.instrument_id,
      raw_symbol: input.raw_symbol,
      side: input.side,
      price: input.price,
      queueAhead: existing?.estimated_queue_ahead ?? null,
      visibleSize: existing?.estimated_visible_size ?? null,
      tradeDepletion: nextTradeDepletion,
      visibleReduction: existing?.estimated_visible_reduction ?? 0n,
      identity: input.identity,
    });
    this.levels.set(this.key(input.instrument_id, input.side, input.price), state);
    return this.toSnapshot(state, input.ts_ns);
  }

  private adjustLevel(
    instrumentId: number,
    side: QueueBookSide,
    price: bigint,
    delta: bigint,
    visibleReduction: bigint,
    identity: QueueContractIdentity,
    tsNs: UnixNs,
  ): QueueStateSnapshot {
    const existing = this.levels.get(this.key(instrumentId, side, price));
    const previousVisible = existing?.estimated_visible_size ?? 0n;
    const visibleSize = maxBigint(0n, previousVisible + delta);
    const state = this.makeLevelState({
      instrument_id: instrumentId,
      raw_symbol: identity.raw_symbol,
      side,
      price,
      queueAhead: visibleSize,
      visibleSize,
      tradeDepletion: existing?.estimated_trade_depletion ?? 0n,
      visibleReduction: (existing?.estimated_visible_reduction ?? 0n) + visibleReduction,
      identity,
    });
    this.levels.set(this.key(instrumentId, side, price), state);
    return this.toSnapshot(state, tsNs);
  }

  private setVisibleLevel(
    instrumentId: number,
    side: QueueBookSide,
    price: bigint,
    visibleSize: bigint,
    identity: QueueContractIdentity,
    tsNs: UnixNs,
  ): QueueStateSnapshot {
    const existing = this.levels.get(this.key(instrumentId, side, price));
    const previousVisible = existing?.estimated_visible_size ?? visibleSize;
    const visibleReduction = previousVisible > visibleSize ? previousVisible - visibleSize : 0n;
    const state = this.makeLevelState({
      instrument_id: instrumentId,
      raw_symbol: identity.raw_symbol,
      side,
      price,
      queueAhead: visibleSize,
      visibleSize,
      tradeDepletion: existing?.estimated_trade_depletion ?? 0n,
      visibleReduction: (existing?.estimated_visible_reduction ?? 0n) + visibleReduction,
      identity,
    });
    this.levels.set(this.key(instrumentId, side, price), state);
    return this.toSnapshot(state, tsNs);
  }

  private makeLevelState(input: {
    readonly instrument_id: number;
    readonly raw_symbol: string | null;
    readonly side: QueueBookSide;
    readonly price: bigint;
    readonly queueAhead: bigint | null;
    readonly visibleSize: bigint | null;
    readonly tradeDepletion: bigint;
    readonly visibleReduction: bigint;
    readonly identity: QueueContractIdentity;
  }): PriceLevelState {
    const qualityFlags: QueueSynthesisQualityFlag[] = [...definitionQualityFlags(input.identity)];
    let confidence: QueueSynthesisConfidence =
      this.mode === 'mbo_reconstruction'
        ? 'high'
        : this.mode === 'mbp_proxy' || this.mode === 'mbp_trades_proxy'
          ? 'medium'
          : 'low';

    if (this.mode === 'mbp_proxy' || this.mode === 'mbp_trades_proxy') {
      qualityFlags.push('visible_size_proxy');
    }
    if (
      (this.mode === 'tbbo_trade_proxy' || this.mode === 'mbp_trades_proxy')
      && input.queueAhead === null
    ) {
      qualityFlags.push('trade_depletion_only', 'queue_ahead_unknown');
      confidence = 'unverified';
    }

    return {
      instrument_id: input.instrument_id,
      raw_symbol: input.raw_symbol,
      side: input.side,
      price: input.price,
      estimated_queue_ahead: input.queueAhead,
      estimated_visible_size: input.visibleSize,
      estimated_trade_depletion: input.tradeDepletion,
      estimated_visible_reduction: input.visibleReduction,
      source_metadata: createQueueSynthesisSourceMetadata({
        mode: this.mode,
        corpus_tier: this.options.corpus_tier,
        input_schemas: this.options.input_schemas,
        confidence,
        quality_flags: qualityFlags,
      }),
    };
  }

  private toSnapshot(state: PriceLevelState, tsNs: UnixNs): QueueStateSnapshot {
    return Object.freeze({
      type: 'queue_state_snapshot',
      ts_ns: tsNs,
      instrument_id: state.instrument_id,
      raw_symbol: state.raw_symbol,
      side: state.side,
      price: state.price,
      estimated_queue_ahead: state.estimated_queue_ahead,
      estimated_visible_size: state.estimated_visible_size,
      estimated_trade_depletion: state.estimated_trade_depletion,
      estimated_visible_reduction: state.estimated_visible_reduction,
      source_metadata: state.source_metadata,
    });
  }

  private key(instrumentId: number, side: QueueBookSide, price: bigint): string {
    return `${instrumentId}:${side}:${price.toString()}`;
  }
}

function maxBigint(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function minBigint(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
