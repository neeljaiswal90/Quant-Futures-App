import type { ReactElement } from 'react';
import type { LiveDeltaState } from '../hooks/useLiveDeltas.js';
import type { LiveSnapshotStatus } from '../hooks/useLiveSnapshot.js';
import type { ConsoleSnapshot } from '@quant-futures/operator-console-contracts';
import { MetricRow, PanelFrame, StatusDot, toneForAvailability } from './PanelFrame.js';
import { compactId, formatMaybeNumber, formatMaybeText, formatNsTimestamp, titleCaseValue } from './format.js';

export function SystemHealthPanel({
  snapshot,
  snapshotStatus,
  deltaState,
}: {
  readonly snapshot: ConsoleSnapshot;
  readonly snapshotStatus: LiveSnapshotStatus;
  readonly deltaState: LiveDeltaState;
}): ReactElement {
  const health = snapshot.system_health;
  const streamTone = deltaState.status === 'open' ? 'good' : deltaState.status === 'reconnecting' ? 'warn' : 'neutral';

  return (
    <PanelFrame
      title="System Health"
      meta={titleCaseValue(health.server_status)}
      className="panel-tall"
    >
      <div className="health-summary">
        <StatusDot label={titleCaseValue(health.server_status)} tone={health.server_status === 'running' ? 'good' : 'warn'} />
        <StatusDot label={titleCaseValue(deltaState.status)} tone={streamTone} />
      </div>
      <div className="metric-list">
        <MetricRow label="Snapshot" value={titleCaseValue(snapshotStatus)} />
        <MetricRow label="WS sequence" value={deltaState.last_seq ?? 'unavailable'} />
        <MetricRow label="WS clients" value={health.ws_client_count.toLocaleString()} />
        <MetricRow label="Backpressure" value={health.ws_backpressure ? 'active' : 'clear'} tone={health.ws_backpressure ? 'warn' : 'good'} />
        <MetricRow label="Critical drops" value={health.dropped_critical_frame_count.toLocaleString()} tone={health.dropped_critical_frame_count > 0 ? 'bad' : 'good'} />
        <MetricRow label="Checkpoint" value={formatMaybeText(health.checkpoint_status)} tone={toneForAvailability(health.checkpoint_status.status)} />
        <MetricRow label="Journal events" value={snapshot.generated_from.event_count.toLocaleString()} />
        <MetricRow label="Last event" value={compactId(snapshot.generated_from.last_event_id)} />
        <MetricRow label="Last event time" value={formatNsTimestamp(snapshot.generated_from.last_event_ts_ns)} />
        <MetricRow label="Latency" value={formatMaybeNumber(snapshot.latency.last_event_lag_ms, { unit: 'ms' })} tone={toneForAvailability(snapshot.latency.last_event_lag_ms.status)} />
      </div>
    </PanelFrame>
  );
}
