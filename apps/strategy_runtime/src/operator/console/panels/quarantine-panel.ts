import {
  formatBoolean,
  formatNs,
  noneIfEmpty,
  renderPanel,
  tone,
} from '../ansi-renderer.js';
import type { QuarantineOrderSummary, QuarantinePanelState } from '../console-state.js';

export function render(state: QuarantinePanelState): string {
  const summary = [
    `open_quarantine_count=${state.open_quarantine_count}`,
    `escalation_required=${formatBoolean(state.escalation_required)}`,
  ].join(' ');
  if (state.orders.length === 0) {
    return renderPanel('Quarantine', [summary, 'orders=none']);
  }
  return renderPanel('Quarantine', [summary, ...state.orders.map(renderOrder)]);
}

function renderOrder(order: QuarantineOrderSummary): string {
  const escalation = order.escalation_required ? tone('true', 'breach') : 'false';
  return [
    `intent_id=${order.intent_id}`,
    `reason=${order.quarantine_reason}`,
    `previous_state=${order.previous_state}`,
    `broker_order_id=${order.broker_order_id ?? '--'}`,
    `instrument=${order.instrument_symbol ?? '--'}`,
    `open_count=${order.open_quarantine_count}`,
    `escalation_required=${escalation}`,
    `provisional=${formatBoolean(order.is_provisional)}`,
    `entered_ts_ns=${formatNs(order.entered_ts_ns)}`,
  ].join(' ');
}

export function renderOrderIds(state: QuarantinePanelState): string {
  return noneIfEmpty(state.orders.map((order) => order.intent_id));
}