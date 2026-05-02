import type { ReactElement } from 'react';
import type { PnlState } from '../../../server/src/types/snapshot.js';
import { MetricRow, PanelFrame, toneForAvailability } from './PanelFrame.js';
import { formatMaybeNumber, titleCaseValue } from './format.js';

export function PnlPanel({
  pnl,
}: {
  readonly pnl: PnlState;
}): ReactElement {
  return (
    <PanelFrame title="P&L" meta={titleCaseValue(pnl.source)}>
      <div className="metric-list">
        <MetricRow
          label="Realized"
          value={formatMaybeNumber(pnl.realized_pnl_usd, { currency: true })}
          tone={toneForAvailability(pnl.realized_pnl_usd.status)}
        />
        <MetricRow
          label="Unrealized"
          value={formatMaybeNumber(pnl.unrealized_pnl_usd, { currency: true })}
          tone={toneForAvailability(pnl.unrealized_pnl_usd.status)}
        />
        <MetricRow label="Source" value={titleCaseValue(pnl.source)} />
      </div>
    </PanelFrame>
  );
}
