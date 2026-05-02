import { useMemo, type ReactElement } from 'react';
import type { StrategyGateState } from '../../../server/src/types/snapshot.js';
import { EmptyState, MetricRow, PanelFrame, StatusDot } from './PanelFrame.js';
import { compactId, titleCaseValue } from './format.js';

interface StrategyPanelProps {
  readonly strategies: readonly StrategyGateState[];
}

type StrategyStatus = StrategyGateState['status'];

export function StrategyPanel({ strategies }: StrategyPanelProps): ReactElement {
  const statusCounts = useMemo(() => {
    const next: Record<string, number> = Object.create(null);
    for (const strategy of strategies) {
      const key = strategy.status;
      next[key] = (next[key] ?? 0) + 1;
    }
    return next;
  }, [strategies]);

  const statusText = formatStatusSummary(statusCounts);

  return (
    <PanelFrame
      title="Strategy Detail"
      meta={`${strategies.length.toLocaleString()} strategy rows`}
      className="panel-wide"
    >
      <div className="metric-list">
        <MetricRow label="Status split" value={statusText} />
      </div>

      {strategies.length === 0 ? (
        <EmptyState>No strategy state available</EmptyState>
      ) : (
        <div className="table-scroll">
          <table className="console-table" aria-label="strategy table">
            <thead>
              <tr>
                <th scope="col">Strategy</th>
                <th scope="col">Status</th>
                <th scope="col">Last Event</th>
              </tr>
            </thead>
            <tbody>
              {strategies.slice(0, 12).map((strategy) => (
                <tr key={strategy.strategy_id}>
                  <td>{compactId(strategy.strategy_id)}</td>
                  <td>
                    <StatusDot
                      label={titleCaseValue(strategy.status)}
                      tone={toneForStrategyStatus(strategy.status)}
                    />
                  </td>
                  <td>{compactId(strategy.last_event_id)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PanelFrame>
  );
}

function formatStatusSummary(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    return 'no active strategies';
  }

  return entries
    .map(([status, count]) => `${count.toLocaleString()} ${titleCaseValue(status)}`)
    .join(' / ');
}

function toneForStrategyStatus(status: StrategyStatus): 'good' | 'warn' | 'neutral' | 'bad' {
  if (status === 'available') {
    return 'good';
  }
  if (status === 'unavailable') {
    return 'warn';
  }
  return 'neutral';
}
