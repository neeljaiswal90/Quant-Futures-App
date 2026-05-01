import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPERATOR_CONSOLE_APP_NAME = 'Live-Sim Operator Console';

export interface OperatorConsoleShellState {
  readonly app_name: typeof OPERATOR_CONSOLE_APP_NAME;
  readonly simulated_only: true;
  readonly raw_envelope_rendering: false;
}

export function createInitialShellState(): OperatorConsoleShellState {
  return {
    app_name: OPERATOR_CONSOLE_APP_NAME,
    simulated_only: true,
    raw_envelope_rendering: false,
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(`${OPERATOR_CONSOLE_APP_NAME} web scaffold ready`);
}
