/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WS_URL?: string;
  readonly VITE_SNAPSHOT_URL?: string;
  readonly VITE_CONFIG_URL?: string;
  readonly VITE_BOOKMAP_BACKFILL_URL?: string;
  readonly VITE_SHUTDOWN_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
