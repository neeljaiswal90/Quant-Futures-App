import type { ReactElement, ReactNode } from 'react';
import { useLiveDeltas, type LiveDeltaState } from './hooks/useLiveDeltas.js';
import { useLiveSnapshot, type LiveSnapshotStatus } from './hooks/useLiveSnapshot.js';
import { AlertsPanel } from './panels/AlertsPanel.js';
import { DataPipelinePanel } from './panels/DataPipelinePanel.js';
import { PnlPanel } from './panels/PnlPanel.js';
import { PositionsPanel } from './panels/PositionsPanel.js';
import { RiskPanel } from './panels/RiskPanel.js';
import { SystemHealthPanel } from './panels/SystemHealthPanel.js';
import { TradeBlotterPanel } from './panels/TradeBlotterPanel.js';
import type { ConsoleSnapshot } from '../../server/src/types/snapshot.js';

export const OPERATOR_CONSOLE_APP_NAME = 'Live-Sim Operator Console';

export interface OperatorConsoleShellState {
  readonly app_name: typeof OPERATOR_CONSOLE_APP_NAME;
  readonly simulated_only: true;
  readonly raw_envelope_rendering: false;
}

export interface OperatorConsoleAppProps {
  readonly snapshot: ConsoleSnapshot;
  readonly snapshot_status: LiveSnapshotStatus;
  readonly delta_state: LiveDeltaState;
}

export function createInitialShellState(): OperatorConsoleShellState {
  return {
    app_name: OPERATOR_CONSOLE_APP_NAME,
    simulated_only: true,
    raw_envelope_rendering: false,
  };
}

export default function App(): ReactElement {
  const snapshotState = useLiveSnapshot();
  const deltaState = useLiveDeltas({
    enabled: snapshotState.status === 'ready',
    reloadSnapshot: snapshotState.reload,
    setSnapshot: snapshotState.setSnapshot,
  });

  return (
    <OperatorConsoleApp
      snapshot={snapshotState.snapshot}
      snapshot_status={snapshotState.status}
      delta_state={deltaState}
    />
  );
}

export function OperatorConsoleApp({
  snapshot,
  snapshot_status,
  delta_state,
}: OperatorConsoleAppProps): ReactElement {
  const featureSummary = summarizeFeatureSurface(snapshot);

  return (
    <main className="console-shell" aria-label={OPERATOR_CONSOLE_APP_NAME}>
      <header className="topbar">
        <div className="title-block">
          <p className="caption">MNQ live-sim operations</p>
          <h1>{OPERATOR_CONSOLE_APP_NAME}</h1>
        </div>
        <div className="status-rail" aria-label="Console status">
          <StatusPill tone="green">SIMULATED ONLY</StatusPill>
          <StatusPill tone="neutral">READ ONLY</StatusPill>
          <StatusPill tone={snapshot_status === 'ready' ? 'green' : 'amber'}>
            {snapshot_status.toUpperCase()}
          </StatusPill>
        </div>
      </header>

      <section className="feature-banner" aria-label="Feature surface">
        <div>
          <p className="caption">Feature Surface</p>
          <strong>{featureSummary.title}</strong>
        </div>
        <div className="banner-metrics">
          <span>{featureSummary.partitionText}</span>
          <span>{snapshot.feature_surface.recent_violations.length} recent violations</span>
          <span>MBO decision use blocked</span>
        </div>
      </section>

      <section className="dashboard-grid" aria-label="MVP panels">
        <DataPipelinePanel data={snapshot.data_pipeline} />
        <PnlPanel pnl={snapshot.pnl} />
        <RiskPanel risk={snapshot.risk} />
        <SystemHealthPanel snapshot={snapshot} snapshotStatus={snapshot_status} deltaState={delta_state} />
        <TradeBlotterPanel trades={snapshot.trades} />
        <PositionsPanel positions={snapshot.positions} />
        <AlertsPanel alerts={snapshot.alerts} />
      </section>
    </main>
  );
}

function StatusPill({
  tone,
  children,
}: {
  readonly tone: 'green' | 'amber' | 'neutral';
  readonly children: ReactNode;
}): ReactElement {
  return <span className={`status-pill status-pill-${tone}`}>{children}</span>;
}

function summarizeFeatureSurface(snapshot: ConsoleSnapshot): {
  readonly title: string;
  readonly partitionText: string;
} {
  const blocked = snapshot.feature_surface.partition_counts.blocked ?? 0;
  const advisory = snapshot.feature_surface.partition_counts.advisory_only ?? 0;
  return {
    title: `Mask v${snapshot.feature_surface.mask_version} from ${snapshot.feature_surface.mask_source}`,
    partitionText: `${blocked} blocked / ${advisory} advisory`,
  };
}
