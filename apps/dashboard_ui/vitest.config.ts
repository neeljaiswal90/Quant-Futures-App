import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Local vitest config (jsdom). Independent of the repo-root vitest.config.ts;
// wiring into the root solution is RA-068 convergence work.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@contracts/realtime": fileURLToPath(
        new URL("../../contracts/realtime", import.meta.url),
      ),
    },
  },
  // Pin an inline tsconfig so esbuild never walks the filesystem to find one.
  // Importing the contract .ts files directly (under ../../contracts) would
  // otherwise make tsconfck discover the repo-root tsconfig, which references
  // a sibling package that has no tsconfig.json — a parse error we must not
  // fix (root configs + contracts/ are off-limits to RA-061).
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        useDefineForClassFields: true,
        verbatimModuleSyntax: false,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: false,
  },
});
