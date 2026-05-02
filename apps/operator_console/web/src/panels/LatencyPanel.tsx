import { useEffect, useRef, useState, type ReactElement } from 'react';
import type {
  DataPipelineState,
  LatencyState,
} from '../../../server/src/types/snapshot.js';
import { MetricRow, PanelFrame, toneForAvailability } from './PanelFrame.js';
import { formatMaybeNumber } from './format.js';

interface LatencyPanelProps {
  readonly latency: LatencyState;
  readonly data_pipeline: DataPipelineState;
}

const MAX_BINS = 24;

export function LatencyPanel({
  latency,
  data_pipeline,
}: LatencyPanelProps): ReactElement {
  const topByType = Object.entries(data_pipeline.by_type)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3);
  const [lastEventLagHistory, setLastEventLagHistory] = useState<number[]>([]);
  const [pipelineAgeHistory, setPipelineAgeHistory] = useState<number[]>([]);
  const lastEventLag = useRef<number>(toNumber(latency.last_event_lag_ms));
  const lastPipelineAge = useRef<number>(toNumber(data_pipeline.last_event_age_ms));

  useEffect(() => {
    const nextEventLag = toNumber(latency.last_event_lag_ms);
    const nextPipelineAge = toNumber(data_pipeline.last_event_age_ms);

    if (Number.isFinite(nextEventLag)) {
      setLastEventLagHistory((history) => {
        const next = [...history, nextEventLag];
        return next.length > MAX_BINS ? next.slice(-MAX_BINS) : next;
      });
      lastEventLag.current = nextEventLag;
    }

    if (Number.isFinite(nextPipelineAge)) {
      setPipelineAgeHistory((history) => {
        const next = [...history, nextPipelineAge];
        return next.length > MAX_BINS ? next.slice(-MAX_BINS) : next;
      });
      lastPipelineAge.current = nextPipelineAge;
    }
  }, [latency.last_event_lag_ms, data_pipeline.last_event_age_ms]);

  const eventLagMax = Math.max(1, ...lastEventLagHistory, lastEventLag.current);
  const ageMax = Math.max(1, ...pipelineAgeHistory, lastPipelineAge.current);

  const eventLagHistogram = lastEventLagHistory.length === 0
    ? null
    : (
      <div className="sparkline" aria-label="Event lag histogram">
        {lastEventLagHistory.map((value, index) => {
          const width = Math.max(3, Math.round((value / eventLagMax) * 100));
          return (
            <span
              key={`event-lag-${index}-${value}`}
              className="sparkline-bar"
              style={{ '--sparkline-height': `${width}%` } as unknown as React.CSSProperties}
              title={`${value} ms lag`}
            />
          );
        })}
      </div>
    );

  const pipelineAgeHistogram = pipelineAgeHistory.length === 0
    ? null
    : (
      <div className="sparkline" aria-label="Pipeline age histogram">
        {pipelineAgeHistory.map((value, index) => {
          const width = Math.max(3, Math.round((value / ageMax) * 100));
          return (
            <span
              key={`pipeline-age-${index}-${value}`}
              className="sparkline-bar"
              style={{ '--sparkline-height': `${width}%` } as unknown as React.CSSProperties}
              title={`${value} ms pipeline age`}
            />
          );
        })}
      </div>
    );

  return (
    <PanelFrame title="Latency" className="panel-wide">
      <div className="metric-list">
        <MetricRow
          label="Telemetry-only stream"
          value={latency.telemetry_only ? 'yes' : 'no'}
          tone={latency.telemetry_only ? 'warn' : 'good'}
        />
        <MetricRow
          label="Event lag"
          value={formatMaybeNumber(latency.last_event_lag_ms, { unit: 'ms' })}
          tone={toneForAvailability(latency.last_event_lag_ms.status)}
        />
        <MetricRow
          label="Data pipeline age"
          value={formatMaybeNumber(data_pipeline.last_event_age_ms, { unit: 'ms' })}
          tone={toneForAvailability(data_pipeline.last_event_age_ms.status)}
        />
        <MetricRow
          label="By-type telemetry"
          value={topByType.length === 0 ? 'unavailable' : topByType[0]?.[0] ?? 'unavailable'}
        />
      </div>

      {topByType.length === 0 ? null : (
        <div className="metric-list margin-top-sm">
          {topByType.map(([type, count]) => (
            <div key={type} className="metric-row compact-metric">
              <span>{type.toLowerCase()} events (recently highest)</span>
              <strong>{count.toLocaleString()}</strong>
            </div>
          ))}
        </div>
      )}

      <div className="metric-list margin-top-sm">
        <MetricRow
          label="Event lag histogram"
          value={`${lastEventLag.current} ms`}
        />
        {eventLagHistogram}
        <MetricRow
          label="Pipeline age histogram"
          value={`${lastPipelineAge.current} ms`}
        />
        {pipelineAgeHistogram}
      </div>
    </PanelFrame>
  );
}

function toNumber(value: LatencyState['last_event_lag_ms'] | DataPipelineState['last_event_age_ms']): number {
  return value.status === 'available' && Number.isFinite(value.value) ? value.value : Number.NaN;
}
