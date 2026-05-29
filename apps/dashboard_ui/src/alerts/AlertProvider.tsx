/**
 * Alert provider — owns the AlertEngine instance + the live AlertConfig, and
 * fires tier alerts as new feed events arrive.
 *
 * Firing is edge-triggered on the store's last feed seq so each event alerts
 * at most once. Gating (enabled / audio_file / browser_notif) lives in the
 * engine + config; we just feed it the latest tiered event.
 */
/* eslint-disable react-refresh/only-export-components --
   Provider component + its consumer hook are intentionally colocated; this is
   a context module, not a fast-refreshable component file. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AlertConfig } from "@contracts/realtime/config";
import { AlertEngine } from "./AlertEngine";
import { DEFAULT_ALERT_CONFIG, loadConfig, saveConfig } from "./config";
import { useDashboard } from "../store/context";

interface AlertApi {
  enabled: boolean;
  notificationsGranted: boolean;
  enable: () => Promise<void>;
  config: AlertConfig;
  setConfig: (next: AlertConfig) => void;
  /** Persist current config; resolves to false on mock 404 (still applied). */
  persist: () => Promise<boolean>;
}

const AlertContext = createContext<AlertApi | null>(null);

export function AlertProvider({ children }: { children: ReactNode }) {
  const engineRef = useRef<AlertEngine>(new AlertEngine());
  const { state } = useDashboard();

  const [enabled, setEnabled] = useState(false);
  const [notificationsGranted, setNotificationsGranted] = useState(false);
  const [config, setConfigState] = useState<AlertConfig>(DEFAULT_ALERT_CONFIG);

  const lastFiredSeq = useRef<number>(-1);

  useEffect(() => {
    void loadConfig().then(setConfigState);
    const engine = engineRef.current;
    return () => engine.dispose();
  }, []);

  const enable = useCallback(async () => {
    await engineRef.current.enable();
    setEnabled(engineRef.current.isEnabled());
    setNotificationsGranted(engineRef.current.notificationsGranted());
  }, []);

  // Edge-trigger alerts on the newest tiered feed event.
  useEffect(() => {
    const latest = state.feed[state.feed.length - 1];
    if (!latest || !latest.tier) return;
    if (latest.seq <= lastFiredSeq.current) return;
    lastFiredSeq.current = latest.seq;
    engineRef.current.fire(
      {
        tier: latest.tier,
        title: `${latest.tier} — ${latest.family}`,
        body: latest.text,
      },
      config,
    );
  }, [state.feed, config]);

  const setConfig = useCallback((next: AlertConfig) => {
    setConfigState(next);
  }, []);

  const persist = useCallback(async () => {
    return saveConfig(config);
  }, [config]);

  const api = useMemo<AlertApi>(
    () => ({
      enabled,
      notificationsGranted,
      enable,
      config,
      setConfig,
      persist,
    }),
    [enabled, notificationsGranted, enable, config, setConfig, persist],
  );

  return <AlertContext.Provider value={api}>{children}</AlertContext.Provider>;
}

export function useAlerts(): AlertApi {
  const ctx = useContext(AlertContext);
  if (!ctx) throw new Error("useAlerts must be used within <AlertProvider>");
  return ctx;
}
