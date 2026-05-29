// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

// Local flat ESLint config for apps/dashboard_ui. Self-contained — does not
// inherit from any repo-root config (RA-068 convergence work owns that).
export default tseslint.config(
  {
    ignores: ["dist", "coverage", "node_modules"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Config + test files run in Node and may use devDependencies freely.
    files: [
      "*.config.{js,ts}",
      "vitest.setup.ts",
      "src/**/*.{test,spec}.{ts,tsx}",
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
