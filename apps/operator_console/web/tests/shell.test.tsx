// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createInitialShellState,
  OPERATOR_CONSOLE_APP_NAME,
  OperatorConsoleApp,
} from '../src/App.js';
import { createUnavailableSnapshot } from '../src/lib/console-state.js';
import type { LiveDeltaState } from '../src/hooks/useLiveDeltas.js';
import type { ConsoleSnapshot } from '../../server/src/types/snapshot.js';

const deltaState: LiveDeltaState = {
  status: 'open',
  last_seq: '12',
  resync_required: false,
  error_message: null,
};

afterEach(() => cleanup());

describe('operator console web shell', () => {
  it('starts in simulated-only read-only posture', () => {
    expect(createInitialShellState()).toEqual({
      app_name: OPERATOR_CONSOLE_APP_NAME,
      simulated_only: true,
      raw_envelope_rendering: false,
    });
  });

  it('renders the read-only app shell, simulated-only badge, and feature-surface banner', () => {
    render(
      <OperatorConsoleApp
        snapshot={createUnavailableSnapshot('fixture server unavailable')}
        snapshot_status="unavailable"
        delta_state={deltaState}
      />,
    );

    expect(screen.getByRole('main', { name: OPERATOR_CONSOLE_APP_NAME })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: OPERATOR_CONSOLE_APP_NAME })).toBeInTheDocument();
    expect(screen.getByText('SIMULATED ONLY')).toBeVisible();
    expect(screen.getByText('READ ONLY')).toBeVisible();
    expect(screen.getByLabelText('Feature surface')).toBeVisible();
    expect(screen.getByText(/MBO decision use blocked/i)).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText(/raw envelope/i)).not.toBeInTheDocument();
  });

  it('renders all MVP and deferred panels from aggregate snapshot state', () => {
    render(
      <OperatorConsoleApp
        snapshot={createFixtureSnapshot()}
        snapshot_status="ready"
        delta_state={deltaState}
      />,
    );

    expect(screen.getByLabelText('Data Pipeline')).toBeVisible();
    expect(screen.getByLabelText('Trade Blotter')).toBeVisible();
    expect(screen.getByLabelText('Positions')).toBeVisible();
    expect(screen.getByLabelText('P&L')).toBeVisible();
    expect(screen.getByLabelText('Risk')).toBeVisible();
    expect(screen.getByLabelText('Alerts')).toBeVisible();
    expect(screen.getByLabelText('System Health')).toBeVisible();
    expect(screen.getByLabelText('Strategy Detail')).toBeVisible();
    expect(screen.getByLabelText('Latency')).toBeVisible();
    expect(screen.getByLabelText('MBO Shadow')).toBeVisible();
    expect(screen.getByLabelText('Performance')).toBeVisible();

    expect(screen.getByText('3 blocked / 2 advisory')).toBeVisible();
    expect(screen.getByText('SIM_FILL lifecycle pos-1 fill')).toBeVisible();
    expect(screen.getByText('pos-1')).toBeVisible();
    expect(screen.getAllByText('$16.00')).toHaveLength(2);
    expect(screen.getAllByText('$42.25')).toHaveLength(2);
    expect(screen.getByText('feature-policy-mask-version-mismatch')).toBeVisible();
    expect(screen.getByText(/telemetry-only/i)).toBeVisible();
    expect(screen.getByText(/Throughput trend/i)).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText(/raw envelope/i)).not.toBeInTheDocument();
  });

  it('keeps realized P&L unavailable when explicit lifecycle facts are absent', () => {
    const snapshot = {
      ...createFixtureSnapshot(),
      pnl: {
        realized_pnl_usd: { status: 'unavailable', reason: 'no explicit realized pnl fact' },
        unrealized_pnl_usd: { status: 'available', value: -3.5 },
        source: 'unavailable',
      },
    } satisfies ConsoleSnapshot;

    render(
      <OperatorConsoleApp
        snapshot={snapshot}
        snapshot_status="ready"
        delta_state={deltaState}
      />,
    );

    const pnlPanel = within(screen.getByLabelText('P&L'));
    expect(pnlPanel.getAllByText('unavailable').length).toBeGreaterThanOrEqual(2);
    expect(pnlPanel.getByText('-$3.50')).toBeVisible();
  });
});

function createFixtureSnapshot(): ConsoleSnapshot {
  const base = createUnavailableSnapshot('fixture');
  return {
    ...base,
    run_id: 'run-1',
    session_id: 'session-1',
    generated_from: {
      journal_path: 'journal:live-sim:abcdef123456',
      journal_path_redacted: true,
      last_event_id: 'event-position-closed-000001',
      last_event_ts_ns: '1700000000000000000',
      event_count: 18,
    },
    data_pipeline: {
      source_event_count: 18,
      by_type: {
        ORDER_INTENT: 3,
        SIM_FILL: 2,
        POSITION: 1,
        RISK_GATE: 2,
      },
      last_event_age_ms: { status: 'available', value: 240 },
      malformed_or_schema_invalid_count: 1,
    },
    trades: {
      rows: [
        {
          event_id: 'trade-row-1',
          type: 'SIM_FILL',
          ts_ns: '1700000000000000000',
          summary: 'SIM_FILL lifecycle pos-1 fill',
        },
      ],
    },
    positions: [
      {
        position_id: 'pos-1',
        side: 'long',
        status: 'open',
        quantity_open: { status: 'available', value: 1 },
        avg_entry_price: { status: 'available', value: 18123.5 },
        mark_price: { status: 'available', value: 18165.75 },
        realized_pnl_usd: { status: 'available', value: 16 },
        unrealized_pnl_usd: { status: 'available', value: 42.25 },
        last_management_action: 'PARTIAL_EXIT',
      },
    ],
    pnl: {
      realized_pnl_usd: { status: 'available', value: 16 },
      unrealized_pnl_usd: { status: 'available', value: 42.25 },
      source: 'explicit_lifecycle_fact',
    },
    risk: {
      circuit_breaker_state: { status: 'available', value: 'closed' },
      daily_loss_usage: { status: 'unavailable', reason: 'no daily_loss_usage fact' },
      open_trade_count: { status: 'available', value: 1 },
      rejected_trade_count: { status: 'available', value: 0 },
    },
    latency: {
      last_event_lag_ms: { status: 'available', value: 85 },
      telemetry_only: true,
    },
    strategies: [
      {
        strategy_id: 'strat-alpha-01',
        status: 'available',
        last_event_id: 'strategy-event-alpha',
        last_event_ts_ns: '1700000000000000000',
      },
      {
        strategy_id: 'strat-beta-01',
        status: 'unavailable',
        last_event_id: null,
        last_event_ts_ns: '1700000000000000001',
      },
    ],
    alerts: [
      {
        id: 'feature-policy-mask-version-mismatch',
        severity: 'critical',
        message: 'feature-policy-mask-version-mismatch',
        event_id: 'feature-mask-1',
      },
    ],
    system_health: {
      server_status: 'running',
      ws_client_count: 1,
      ws_backpressure: false,
      dropped_critical_frame_count: 0,
      checkpoint_status: { status: 'available', value: 'checkpointed' },
    },
    feature_surface: {
      ...base.feature_surface,
      mask_version: 5,
      mask_id: 'feature-mask-v5',
      mask_hash: 'hash-v5',
      mask_source: 'embedded',
      partition_counts: {
        authoritative: 7,
        subscope: 1,
        diagnostic_only: 4,
        shadow_only: 2,
        advisory_only: 2,
        blocked: 3,
        available: 5,
      },
      recent_violations: [
        {
          id: 'feature-policy-mask-version-mismatch',
          severity: 'critical',
          message: 'feature-policy-mask-version-mismatch',
          event_id: 'feature-mask-1',
        },
      ],
    },
    mbo_shadow: {
      status: 'shadow',
      decision_use: false,
      last_event_id: 'mbo-shadow-1',
    },
  };
}
