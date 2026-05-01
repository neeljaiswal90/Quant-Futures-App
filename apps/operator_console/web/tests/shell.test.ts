import { describe, expect, it } from 'vitest';
import { createInitialShellState, OPERATOR_CONSOLE_APP_NAME } from '../src/App.js';

describe('operator console web shell scaffold', () => {
  it('starts in simulated-only read-only posture', () => {
    expect(createInitialShellState()).toEqual({
      app_name: OPERATOR_CONSOLE_APP_NAME,
      simulated_only: true,
      raw_envelope_rendering: false,
    });
  });
});
