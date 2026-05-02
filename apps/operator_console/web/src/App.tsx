import { useMemo } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useLiveDeltas, type LiveDeltaState } from './hooks/useLiveDeltas.js';
import { useLiveSnapshot, type LiveSnapshotStatus } from './hooks/useLiveSnapshot.js';
import type { ConsoleSnapshot, MaybeAvailable } from '../../server/src/types/snapshot.js';

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
  const featureSummary = useMemo(() => summarizeFeatureSurface(snapshot), [snapshot]);
  const latestAlerts = snapshot.alerts.slice(0, 3);

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

      <section className="console-grid" aria-label="Operator overview">
        <OverviewPanel title="Data Pipeline">
          <Metric label="Events" value={snapshot.data_pipeline.source_event_count.toLocaleString()} />
          <Metric label="Malformed" value={snapshot.data_pipeline.malformed_or_schema_invalid_count.toString()} />
          <Metric label="Last Lag" value={formatMaybe(snapshot.data_pipeline.last_event_age_ms, 'ms')} />
        </OverviewPanel>

        <OverviewPanel title="Stream">
          <Metric label="WS" value={delta_state.status.replaceAll('_', ' ')} />
          <Metric label="Seq" value={delta_state.last_seq ?? 'unavailable'} />
          <Metric label="Clients" value={snapshot.system_health.ws_client_count.toString()} />
        </OverviewPanel>

        <OverviewPanel title="P&L">
          <Metric label="Realized" value={formatMaybe(snapshot.pnl.realized_pnl_usd, 'USD')} />
          <Metric label="Unrealized" value={formatMaybe(snapshot.pnl.unrealized_pnl_usd, 'USD')} />
          <Metric label="Source" value={snapshot.pnl.source.replaceAll('_', ' ')} />
        </OverviewPanel>

        <OverviewPanel title="System Health">
          <Metric label="Server" value={snapshot.system_health.server_status} />
          <Metric label="Backpressure" value={snapshot.system_health.ws_backpressure ? 'active' : 'clear'} />
          <Metric label="Critical Drops" value={snapshot.system_health.dropped_critical_frame_count.toString()} />
        </OverviewPanel>
      </section>

      <section className="alert-strip" aria-label="Alerts">
        <div className="section-heading">
          <h2>Alerts</h2>
          <span>{snapshot.alerts.length} total</span>
        </div>
        <div className="alert-list">
          {latestAlerts.length === 0 ? (
            <p className="empty-state">No current alerts</p>
          ) : latestAlerts.map((alert) => (
            <article className={`alert-row alert-row-${alert.severity}`} key={alert.id}>
              <strong>{alert.severity}</strong>
              <span>{alert.message}</span>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

function OverviewPanel({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <article className="overview-panel">
      <h2>{title}</h2>
      <div className="metric-list">{children}</div>
    </article>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div className="metric-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
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

function formatMaybe(value: MaybeAvailable<number>, unit: string): string {
  if (value.status === 'unavailable') {
    return 'unavailable';
  }
  const formatted = unit === 'USD'
    ? `$${value.value.toFixed(2)}`
    : `${Math.round(value.value).toLocaleString()} ${unit}`;
  return formatted;
}
