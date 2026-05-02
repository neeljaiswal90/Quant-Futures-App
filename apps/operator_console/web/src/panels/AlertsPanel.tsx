import type { ReactElement } from 'react';
import type { AlertState } from '@quant-futures/operator-console-contracts';
import { EmptyState, PanelFrame } from './PanelFrame.js';
import { compactId } from './format.js';

export function AlertsPanel({
  alerts,
}: {
  readonly alerts: readonly AlertState[];
}): ReactElement {
  const rows = alerts.slice(0, 8);

  return (
    <PanelFrame title="Alerts" meta={`${alerts.length.toLocaleString()} total`} className="panel-wide">
      {rows.length === 0 ? (
        <EmptyState>No current alerts</EmptyState>
      ) : (
        <div className="alert-list">
          {rows.map((alert) => (
            <article className={`alert-row alert-row-${alert.severity}`} key={alert.id}>
              <strong>{alert.severity}</strong>
              <span>{alert.message}</span>
              <small>{compactId(alert.event_id ?? alert.id)}</small>
            </article>
          ))}
        </div>
      )}
    </PanelFrame>
  );
}
