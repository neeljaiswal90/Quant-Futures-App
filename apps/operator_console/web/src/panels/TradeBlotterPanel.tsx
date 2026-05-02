import type { ReactElement } from 'react';
import type { TradeBlotterState } from '../../../server/src/types/snapshot.js';
import { EmptyState, PanelFrame } from './PanelFrame.js';
import { compactId, formatNsTimestamp, titleCaseValue } from './format.js';

export function TradeBlotterPanel({
  trades,
}: {
  readonly trades: TradeBlotterState;
}): ReactElement {
  const rows = trades.rows.slice(-12).reverse();

  return (
    <PanelFrame title="Trade Blotter" meta={`${trades.rows.length.toLocaleString()} rows`} className="panel-extra-wide">
      {rows.length === 0 ? (
        <EmptyState>No trade lifecycle rows</EmptyState>
      ) : (
        <div className="table-scroll">
          <table className="console-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Type</th>
                <th scope="col">Event</th>
                <th scope="col">Summary</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.event_id}>
                  <td>{formatNsTimestamp(row.ts_ns)}</td>
                  <td>{titleCaseValue(row.type)}</td>
                  <td>{compactId(row.event_id)}</td>
                  <td>{row.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PanelFrame>
  );
}
