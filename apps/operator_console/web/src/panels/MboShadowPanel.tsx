import type { ReactElement } from 'react';
import type { MboShadowState } from '../../../server/src/types/snapshot.js';
import { EmptyState, MetricRow, PanelFrame, StatusDot } from './PanelFrame.js';
import { compactId } from './format.js';

interface MboShadowPanelProps {
  readonly mbo_shadow: MboShadowState | undefined;
}

export function MboShadowPanel({ mbo_shadow }: MboShadowPanelProps): ReactElement {
  if (mbo_shadow === undefined || mbo_shadow.status === 'absent') {
    return (
      <PanelFrame title="MBO Shadow" className="panel-wide">
        <EmptyState>No MBO shadow telemetry available</EmptyState>
      </PanelFrame>
    );
  }

  return (
    <PanelFrame
      title="MBO Shadow"
      meta={`decision_use=${mbo_shadow.decision_use ? 'enabled' : 'blocked'}`}
      className="panel-wide"
    >
      <div className="metric-list">
        <MetricRow
          label="Shadow status"
          value={mbo_shadow.status}
          tone={mbo_shadow.status === 'diagnostic' || mbo_shadow.status === 'shadow' ? 'warn' : 'good'}
        />
        <MetricRow
          label="Decision grade"
          value={mbo_shadow.decision_use ? 'enabled' : 'blocked'}
          tone={mbo_shadow.decision_use ? 'bad' : 'warn'}
        />
        <MetricRow label="Last shadow event" value={compactId(mbo_shadow.last_event_id)} />
      </div>

      <div className="metric-list">
        <StatusDot
          label="MBO telemetry is diagnostic; do not drive trading decisions"
          tone="warn"
        />
      </div>
    </PanelFrame>
  );
}
