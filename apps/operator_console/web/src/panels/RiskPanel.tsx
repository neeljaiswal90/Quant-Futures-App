import type { ReactElement } from 'react';
import type { RiskState } from '../../../server/src/types/snapshot.js';
import { MetricRow, PanelFrame, toneForAvailability } from './PanelFrame.js';
import { formatMaybeNumber, formatMaybeText, titleCaseValue } from './format.js';

export function RiskPanel({
  risk,
}: {
  readonly risk: RiskState;
}): ReactElement {
  const breaker = formatMaybeText(risk.circuit_breaker_state);

  return (
    <PanelFrame title="Risk" meta={titleCaseValue(breaker)}>
      <div className="metric-list">
        <MetricRow
          label="Circuit breaker"
          value={titleCaseValue(breaker)}
          tone={risk.circuit_breaker_state.status === 'available' && breaker === 'closed' ? 'good' : 'warn'}
        />
        <MetricRow
          label="Daily loss usage"
          value={formatMaybeNumber(risk.daily_loss_usage, { currency: true })}
          tone={toneForAvailability(risk.daily_loss_usage.status)}
        />
        <MetricRow
          label="Open trades"
          value={formatMaybeNumber(risk.open_trade_count)}
          tone={toneForAvailability(risk.open_trade_count.status)}
        />
        <MetricRow
          label="Rejected trades"
          value={formatMaybeNumber(risk.rejected_trade_count)}
          tone={risk.rejected_trade_count.status === 'available' && risk.rejected_trade_count.value > 0 ? 'warn' : 'good'}
        />
      </div>
    </PanelFrame>
  );
}
