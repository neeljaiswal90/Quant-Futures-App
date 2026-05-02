import type { ReactElement } from 'react';
import type { DataPipelineState } from '@quant-futures/operator-console-contracts';
import { EmptyState, MetricRow, PanelFrame, toneForAvailability } from './PanelFrame.js';
import { formatMaybeNumber, titleCaseValue } from './format.js';

export function DataPipelinePanel({
  data,
}: {
  readonly data: DataPipelineState;
}): ReactElement {
  const eventTypes = Object.entries(data.by_type)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6);

  return (
    <PanelFrame title="Data Pipeline" meta={`${data.source_event_count.toLocaleString()} events`}>
      <div className="metric-list">
        <MetricRow label="Source events" value={data.source_event_count.toLocaleString()} />
        <MetricRow
          label="Malformed/schema invalid"
          value={data.malformed_or_schema_invalid_count.toLocaleString()}
          tone={data.malformed_or_schema_invalid_count > 0 ? 'warn' : 'good'}
        />
        <MetricRow
          label="Last event age"
          value={formatMaybeNumber(data.last_event_age_ms, { unit: 'ms' })}
          tone={toneForAvailability(data.last_event_age_ms.status)}
        />
      </div>
      <div className="event-type-list" aria-label="Event type mix">
        {eventTypes.length === 0 ? (
          <EmptyState>No event mix available</EmptyState>
        ) : eventTypes.map(([type, count]) => (
          <div className="event-type-row" key={type}>
            <span>{titleCaseValue(type)}</span>
            <strong>{count.toLocaleString()}</strong>
          </div>
        ))}
      </div>
    </PanelFrame>
  );
}
