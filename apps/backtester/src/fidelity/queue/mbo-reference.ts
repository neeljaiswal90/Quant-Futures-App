import type { DbnMboRecord, DbnSide } from '../../../../strategy_runtime/src/data/dbn-types.js';
import {
  type QueueFidelityProbe,
  type QueueFidelityProbeResult,
  type QueueFidelitySide,
} from './types.js';

interface MboOrderState {
  readonly side: DbnSide;
  readonly price: bigint;
  readonly size: bigint;
  readonly ahead_of_virtual_order: boolean;
}

interface ReplayState {
  readonly active_orders: Map<string, MboOrderState>;
  queue_ahead: bigint;
  filled: bigint;
}

export function computeMboReferenceFillFraction(
  probe: QueueFidelityProbe,
  mboRecords: readonly DbnMboRecord[],
): QueueFidelityProbeResult {
  const sortedRecords = sortMboRecords(mboRecords);
  const activeOrders = new Map<string, MboOrderState>();
  let cursor = 0;

  while (cursor < sortedRecords.length && sortedRecords[cursor]!.ts_event <= probe.ts_ns) {
    applyPreProbeRecord(activeOrders, sortedRecords[cursor]!);
    cursor += 1;
  }

  let queueAhead = 0n;
  for (const [orderId, order] of activeOrders.entries()) {
    const ahead = orderMatchesProbe(order, probe);
    if (ahead) {
      queueAhead += order.size;
    }
    activeOrders.set(orderId, {
      ...order,
      ahead_of_virtual_order: ahead,
    });
  }

  const state: ReplayState = {
    active_orders: activeOrders,
    queue_ahead: queueAhead,
    filled: 0n,
  };
  const horizonEnd = probe.ts_ns + probe.fill_horizon_ns;

  while (cursor < sortedRecords.length && sortedRecords[cursor]!.ts_event <= horizonEnd) {
    const record = sortedRecords[cursor]!;
    if (record.ts_event > probe.ts_ns) {
      applyPostProbeRecord(state, probe, record);
    }
    cursor += 1;
  }

  return Object.freeze({
    probe_id: probe.probe_id,
    ts_ns: probe.ts_ns,
    side: probe.side,
    limit_price: probe.limit_price,
    quantity: probe.quantity,
    reference_fill_probability_ppm: fillFractionPpm(state.filled, probe.quantity),
    synthesized_fill_probability_ppm: null,
    absolute_error_ppm: null,
    within_tolerance: null,
    status: 'compared',
    synthesized_source_mode: null,
  });
}

function applyPreProbeRecord(activeOrders: Map<string, MboOrderState>, record: DbnMboRecord): void {
  if (record.side === 'N') {
    return;
  }
  const orderKey = record.order_id.toString();
  const previous = activeOrders.get(orderKey);
  const size = BigInt(record.size);

  if (record.action === 'A') {
    activeOrders.set(orderKey, {
      side: record.side,
      price: record.price,
      size,
      ahead_of_virtual_order: false,
    });
    return;
  }

  if (record.action === 'M') {
    activeOrders.set(orderKey, {
      side: record.side,
      price: record.price,
      size,
      ahead_of_virtual_order: previous?.ahead_of_virtual_order ?? false,
    });
    return;
  }

  if (previous === undefined) {
    return;
  }
  const reduction = minBigint(size, previous.size);
  const remaining = previous.size - reduction;
  if (remaining > 0n) {
    activeOrders.set(orderKey, {
      ...previous,
      size: remaining,
    });
  } else {
    activeOrders.delete(orderKey);
  }
}

function applyPostProbeRecord(state: ReplayState, probe: QueueFidelityProbe, record: DbnMboRecord): void {
  if (record.side === 'N') {
    return;
  }
  const orderKey = record.order_id.toString();
  const previous = state.active_orders.get(orderKey);
  const size = BigInt(record.size);

  if (record.action === 'A') {
    state.active_orders.set(orderKey, {
      side: record.side,
      price: record.price,
      size,
      ahead_of_virtual_order: false,
    });
    return;
  }

  if (record.action === 'M') {
    if (previous?.ahead_of_virtual_order === true && orderMatchesProbe(previous, probe)) {
      state.queue_ahead = maxBigint(0n, state.queue_ahead - previous.size);
    }
    state.active_orders.set(orderKey, {
      side: record.side,
      price: record.price,
      size,
      ahead_of_virtual_order: false,
    });
    return;
  }

  const recordState = previous ?? {
    side: record.side,
    price: record.price,
    size,
    ahead_of_virtual_order: orderMatchesProbe(record, probe),
  };
  const reduction = previous === undefined ? size : minBigint(size, previous.size);
  const execution = record.action === 'T' || record.action === 'F';
  if (orderMatchesProbe(recordState, probe)) {
    applyReductionAtProbePrice(state, probe, reduction, execution);
  }

  if (previous === undefined) {
    return;
  }
  const remaining = previous.size - reduction;
  if (remaining > 0n) {
    state.active_orders.set(orderKey, {
      ...previous,
      size: remaining,
    });
  } else {
    state.active_orders.delete(orderKey);
  }
}

function applyReductionAtProbePrice(
  state: ReplayState,
  probe: QueueFidelityProbe,
  reduction: bigint,
  execution: boolean,
): void {
  const consumedAhead = minBigint(state.queue_ahead, reduction);
  state.queue_ahead -= consumedAhead;
  const remainingReduction = reduction - consumedAhead;
  if (!execution || remainingReduction <= 0n) {
    return;
  }

  const remainingProbeQty = probe.quantity - state.filled;
  const filledNow = minBigint(remainingProbeQty, remainingReduction);
  state.filled += filledNow;
}

function orderMatchesProbe(
  order: { readonly side: DbnSide; readonly price: bigint },
  probe: { readonly side: QueueFidelitySide; readonly limit_price: bigint },
): boolean {
  return order.side === probeSideToMboSide(probe.side) && order.price === probe.limit_price;
}

function probeSideToMboSide(side: QueueFidelitySide): DbnSide {
  return side === 'buy' ? 'B' : 'A';
}

function fillFractionPpm(filled: bigint, quantity: bigint): number {
  if (quantity <= 0n) {
    return 0;
  }
  const boundedFilled = minBigint(filled, quantity);
  return Number((boundedFilled * 1_000_000n) / quantity);
}

function sortMboRecords(records: readonly DbnMboRecord[]): readonly DbnMboRecord[] {
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      if (left.record.ts_event < right.record.ts_event) {
        return -1;
      }
      if (left.record.ts_event > right.record.ts_event) {
        return 1;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.record);
}

function minBigint(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function maxBigint(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}
