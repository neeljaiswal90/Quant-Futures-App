import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/backtester/tests/**/*.test.ts',
      'apps/strategy_runtime/tests/unit/**/*.test.ts',
      'apps/operator_console/**/tests/**/*.test.ts',
      'apps/operator_console/**/tests/**/*.test.tsx',
    ],
  },
});
