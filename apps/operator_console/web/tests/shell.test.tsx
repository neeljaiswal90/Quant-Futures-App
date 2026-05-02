// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  createInitialShellState,
  OPERATOR_CONSOLE_APP_NAME,
  OperatorConsoleApp,
} from '../src/App.js';
import { createUnavailableSnapshot } from '../src/lib/console-state.js';
import type { LiveDeltaState } from '../src/hooks/useLiveDeltas.js';

const deltaState: LiveDeltaState = {
  status: 'open',
  last_seq: '12',
  resync_required: false,
  error_message: null,
};

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
});
