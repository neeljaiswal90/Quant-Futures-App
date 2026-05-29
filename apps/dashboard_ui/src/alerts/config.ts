/**
 * Default alert config + persistence shim (RA-063 shape).
 *
 * RA-063 finalizes serving/persistence. Until then we ship a sensible default
 * matching the frozen AlertConfig contract and PUT changes to /config — but
 * tolerate a 404 (the mock has no /config route yet), keeping the edited
 * config in local memory so the settings UI still works.
 */
import type { AlertConfig } from "@contracts/realtime/config";

// The contract is consumed type-only (per RA-061 spec: import type, never a
// runtime import — that keeps esbuild from transforming the contract .ts and
// tripping the repo-root tsconfig's broken project references). This single
// literal mirrors the contract's CONFIG_SCHEMA_VERSION; it is bound to the
// AlertConfig["schema_version"] type so a contract drift still reds tsc here.
const CONFIG_SCHEMA_VERSION: AlertConfig["schema_version"] = 1;

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  schema_version: CONFIG_SCHEMA_VERSION,
  critical: {
    enabled: true,
    audio_file: "critical.wav",
    browser_notif: true,
    windows_toast: true,
  },
  high: {
    enabled: true,
    audio_file: "high.wav",
    browser_notif: true,
    windows_toast: false,
  },
  medium: {
    enabled: true,
    audio_file: null,
    browser_notif: false,
    windows_toast: false,
  },
  proximity: { critical_pt: 10, high_pt: 25, medium_pt: 50 },
  quiet_hours: {
    enabled: false,
    start_pt: "22:00",
    end_pt: "06:00",
    audio_only: false,
  },
};

const CONFIG_URL =
  import.meta.env.VITE_CONFIG_URL ?? "/config";

/** Best-effort GET of the served config; falls back to the default. */
export async function loadConfig(): Promise<AlertConfig> {
  try {
    const res = await fetch(CONFIG_URL, { cache: "no-store" });
    if (!res.ok) return DEFAULT_ALERT_CONFIG;
    const body: unknown = await res.json();
    // Shallow shape check; trust the contract otherwise.
    if (body && typeof body === "object" && "schema_version" in body) {
      return body as AlertConfig;
    }
    return DEFAULT_ALERT_CONFIG;
  } catch {
    return DEFAULT_ALERT_CONFIG;
  }
}

/**
 * PUT the config. Returns true if the server accepted it; false (and a no-op
 * for the caller) on 404 / network error — the mock has no /config endpoint.
 */
export async function saveConfig(config: AlertConfig): Promise<boolean> {
  try {
    const res = await fetch(CONFIG_URL, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    return res.ok;
  } catch {
    return false;
  }
}
