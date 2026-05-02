import { type CSSProperties, type ReactElement, useEffect, useRef, useState } from 'react';
import type { ConsoleSnapshot } from '../../../server/src/types/snapshot.js';
import { EmptyState, MetricRow, PanelFrame } from './PanelFrame.js';

interface PerformancePanelProps {
  readonly snapshot: ConsoleSnapshot;
}

const MAX_BARS = 20;

export function PerformancePanel({ snapshot }: PerformancePanelProps): ReactElement {
  const [eventDeltaHistory, setEventDeltaHistory] = useState<number[]>([]);
  const lastEventCount = useRef(snapshot.generated_from.event_count);

  useEffect(() => {
    const nextCount = snapshot.generated_from.event_count;
    const previousCount = lastEventCount.current;
    const delta = Math.max(0, nextCount - previousCount);
    lastEventCount.current = nextCount;

    setEventDeltaHistory((previous) => {
      const next = [...previous, delta];
      return next.length > MAX_BARS ? next.slice(-MAX_BARS) : next;
    });
  }, [snapshot.generated_from.event_count, snapshot.generated_from.last_event_id]);

  const maxEventRate = Math.max(1, ...eventDeltaHistory);
  const dropRate = snapshot.system_health.dropped_critical_frame_count;

  const bars = eventDeltaHistory.length === 0 ? null : (
    <div className="sparkline" aria-label="Throughput sparkline">
      {eventDeltaHistory.map((value, index) => {
        const width = Math.max(3, Math.round((value / maxEventRate) * 100));
        return (
          <span
            key={`${snapshot.generated_from.last_event_id ?? 'startup'}-${index}`}
            className="sparkline-bar"
            style={{ '--sparkline-height': `${width}%` } as CSSProperties}
            title={`${value} new events`}
          />
        );
      })}
    </div>
  );

  if (eventDeltaHistory.length === 0) {
    return (
      <PanelFrame title="Performance" meta="No history yet" className="panel-extra-wide">
        <EmptyState>Collecting live throughput for charted metrics</EmptyState>
      </PanelFrame>
    );
  }

  return (
    <PanelFrame title="Performance" meta="Throughput trend" className="panel-extra-wide">
      <div className="metric-list">
        <MetricRow
          label="Events this tick (max samples)"
          value={`${eventDeltaHistory[eventDeltaHistory.length - 1]}/${maxEventRate}`}
        />
        <MetricRow
          label="Current live events"
          value={snapshot.generated_from.event_count.toLocaleString()}
        />
        <MetricRow
          label="Dropped critical frames"
          value={dropRate.toLocaleString()}
        />
        <MetricRow
          label="WS clients"
          value={snapshot.system_health.ws_client_count.toLocaleString()}
        />
      </div>
      {bars}
    </PanelFrame>
  );
}
