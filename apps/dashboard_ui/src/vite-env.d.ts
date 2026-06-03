/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WS_URL?: string;
  readonly VITE_SNAPSHOT_URL?: string;
  readonly VITE_CONFIG_URL?: string;
  readonly VITE_BOOKMAP_BACKFILL_URL?: string;
  readonly VITE_SHUTDOWN_URL?: string;
  /**
   * RA-115 (Option D, Phase 1): rendering backend for the depth heatmap.
   * "canvas2d" (default) keeps the existing per-cell fillRect path.
   * "webgpu" enables the WebGPU overlay (apps/dashboard_ui/src/chart/gpu/).
   * Set via `VITE_DEPTH_RENDERER=webgpu` in .env.local or the build env.
   */
  readonly VITE_DEPTH_RENDERER?: "canvas2d" | "webgpu";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
