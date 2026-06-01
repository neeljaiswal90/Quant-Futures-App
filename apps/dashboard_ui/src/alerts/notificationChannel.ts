import type { Tier } from "@contracts/realtime/events";

export interface NotificationContext {
  tier: Tier;
  title: string;
  body: string;
}

export interface NotificationChannel {
  isSupported(): boolean;
  requestPermission(): Promise<boolean>;
  send(ctx: NotificationContext): boolean;
}

type TauriNotificationModule = typeof import("@tauri-apps/plugin-notification");

declare global {
  interface Window {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  }
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.location.origin === "http://tauri.localhost" ||
      window.__TAURI__ != null ||
      window.__TAURI_INTERNALS__ != null)
  );
}

class BrowserNotificationChannel implements NotificationChannel {
  isSupported(): boolean {
    if (typeof window === "undefined" || !("Notification" in window)) return false;
    const userAgent = window.navigator.userAgent.toLowerCase();
    // Codex runs inside an Electron/WindowsApps shell where browser
    // Notification activation can route back to the app package instead of the
    // dashboard. Native toast/audio daemon paths remain available.
    return !userAgent.includes("electron") && !userAgent.includes("codex");
  }

  async requestPermission(): Promise<boolean> {
    if (!this.isSupported()) return false;
    try {
      const perm = await Notification.requestPermission();
      return perm === "granted";
    } catch {
      return false;
    }
  }

  send(ctx: NotificationContext): boolean {
    if (!this.isSupported() || Notification.permission !== "granted") return false;
    try {
      new Notification(ctx.title, {
        body: ctx.body,
        tag: `mnq-${ctx.tier}`,
      });
      return true;
    } catch {
      // Some browser shells throw if constructed without a service worker.
      return false;
    }
  }
}

class TauriNotificationChannel implements NotificationChannel {
  private module: TauriNotificationModule | null = null;

  isSupported(): boolean {
    return isTauriRuntime();
  }

  async requestPermission(): Promise<boolean> {
    if (!this.isSupported()) return false;
    try {
      this.module = await import("@tauri-apps/plugin-notification");
      if (await this.module.isPermissionGranted()) return true;
      return (await this.module.requestPermission()) === "granted";
    } catch {
      this.module = null;
      return false;
    }
  }

  send(ctx: NotificationContext): boolean {
    if (!this.module) return false;
    try {
      this.module.sendNotification({
        title: ctx.title,
        body: ctx.body,
      });
      return true;
    } catch {
      return false;
    }
  }
}

export function createNotificationChannel(): NotificationChannel {
  if (isTauriRuntime()) return new TauriNotificationChannel();
  return new BrowserNotificationChannel();
}

export const notificationChannelInternals = {
  BrowserNotificationChannel,
  TauriNotificationChannel,
  isTauriRuntime,
};

