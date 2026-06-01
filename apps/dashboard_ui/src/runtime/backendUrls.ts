/**
 * Backend URL resolution for browser dev/prod and the RA-101 Tauri shell.
 *
 * Vite dev serves the dashboard at 127.0.0.1:5173 and proxies relative REST
 * paths. Tauri production serves the built SPA from http://tauri.localhost,
 * where relative REST paths would hit Tauri's asset protocol instead of the
 * Python backend. In that shell context, default REST paths must target the
 * backend explicitly.
 */
const BACKEND_HTTP_ORIGIN = "http://127.0.0.1:8765";

export function isTauriWebViewOrigin(origin = window.location.origin): boolean {
  return origin === "http://tauri.localhost";
}

export function defaultBackendUrl(path: string): string {
  if (isTauriWebViewOrigin()) return `${BACKEND_HTTP_ORIGIN}${path}`;
  return path;
}

