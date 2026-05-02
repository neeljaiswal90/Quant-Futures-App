import type { ReactElement } from 'react';
import type { PositionState } from '../../../server/src/types/snapshot.js';
import { EmptyState, PanelFrame } from './PanelFrame.js';
import { compactId, formatMaybeNumber, titleCaseValue } from './format.js';

export function PositionsPanel({
  positions,
}: {
  readonly positions: readonly PositionState[];
}): ReactElement {
  return (
    <PanelFrame title="Positions" meta={`${positions.length.toLocaleString()} tracked`} className="panel-wide">
      {positions.length === 0 ? (
        <EmptyState>No positions available</EmptyState>
      ) : (
        <div className="table-scroll">
          <table className="console-table">
            <thead>
              <tr>
                <th scope="col">Position</th>
                <th scope="col">Side</th>
                <th scope="col">Status</th>
                <th scope="col">Qty</th>
                <th scope="col">Avg Entry</th>
                <th scope="col">Mark</th>
                <th scope="col">Realized</th>
                <th scope="col">Unrealized</th>
                <th scope="col">Last Action</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => (
                <tr key={position.position_id}>
                  <td>{compactId(position.position_id)}</td>
                  <td>{titleCaseValue(position.side)}</td>
                  <td>{titleCaseValue(position.status)}</td>
                  <td>{formatMaybeNumber(position.quantity_open, { fractionDigits: 2 })}</td>
                  <td>{formatMaybeNumber(position.avg_entry_price, { fractionDigits: 2 })}</td>
                  <td>{formatMaybeNumber(position.mark_price, { fractionDigits: 2 })}</td>
                  <td>{formatMaybeNumber(position.realized_pnl_usd, { currency: true })}</td>
                  <td>{formatMaybeNumber(position.unrealized_pnl_usd, { currency: true })}</td>
                  <td>{position.last_management_action ?? 'unavailable'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PanelFrame>
  );
}
