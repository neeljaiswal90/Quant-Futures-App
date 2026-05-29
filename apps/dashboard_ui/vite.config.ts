import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// RA-061 dashboard UI. Self-contained Vite app under apps/dashboard_ui.
//
// - Contract types are imported via the @contracts/realtime alias pointing
//   directly at ../../contracts/realtime (type-only — never copied, so the
//   parity tripwire stays intact).
// - The WS endpoint is hit directly via VITE_WS_URL (default
//   ws://127.0.0.1:8765/ws). The REST /snapshot resync path is proxied in
//   dev to the mock emitter so a same-origin fetch("/snapshot") works.
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
  // a sibling package with no tsconfig.json — a parse error we must not fix
  // (root configs + contracts/ are off-limits to RA-061).
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        useDefineForClassFields: true,
        verbatimModuleSyntax: false,
      },
    },
  },
  server: {
    // Bind IPv4 loopback explicitly. Vite's default host is `localhost`, which
    // on Windows resolves to ::1 (IPv6) — so http://127.0.0.1:5173 (the URL the
    // launcher + docs print, and what the backend binds) was refused. Pinning
    // 127.0.0.1 makes the documented URL work and keeps the dev server
    // loopback-only (not exposed on the LAN).
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/snapshot": {
        target: "http://127.0.0.1:8765",
        changeOrigin: true,
      },
      "/health": {
        target: "http://127.0.0.1:8765",
        changeOrigin: true,
      },
      // RA-068: proxy the alert-config endpoint to the backend so the
      // settings panel's same-origin fetch/PUT reaches RA-063's router.
      "/api/config": {
        target: "http://127.0.0.1:8765",
        changeOrigin: true,
      },
    },
  },
});
