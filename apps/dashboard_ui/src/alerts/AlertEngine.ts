/**
 * Alert engine — Web Audio + Browser Notifications, gesture-gated.
 *
 * Browsers block both AudioContext and (effectively) Notification.requestPermission
 * outside a user gesture. So all audible/notification alerting sits behind a
 * one-time "Enable alerts" button (see AlertControls). Before that gesture the
 * UI is visual-only.
 *
 * Per-tier firing is gated by the RA-063 AlertConfig: a tier fires audio only
 * if `enabled && audio_file != null`, and a browser notification only if
 * `enabled && browser_notif`. We map the envelope's UPPERCASE Tier
 * (CRITICAL/HIGH/MEDIUM) to the config's lowercase AlertTier.
 *
 * HARD RULE: read-only decision support. An alert never triggers an action;
 * it only notifies the human.
 */
import type { AlertConfig, AlertTier } from "@contracts/realtime/config";
import type { Tier } from "@contracts/realtime/events";

export function tierToAlertTier(tier: Tier): AlertTier {
  return tier.toLowerCase() as AlertTier;
}

export interface AlertContext {
  tier: Tier;
  title: string;
  body: string;
}

export class AlertEngine {
  private ctx: AudioContext | null = null;
  private enabled = false;
  private notifGranted = false;

  isEnabled(): boolean {
    return this.enabled;
  }

  notificationsGranted(): boolean {
    return this.notifGranted;
  }

  /**
   * Call from within a user gesture. Creates/resumes the AudioContext and
   * requests Notification permission. Idempotent.
   */
  async enable(): Promise<void> {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (Ctor) this.ctx = new Ctor();
    }
    if (this.ctx && this.ctx.state === "suspended") {
      await this.ctx.resume().catch(() => undefined);
    }
    if ("Notification" in window) {
      try {
        const perm = await Notification.requestPermission();
        this.notifGranted = perm === "granted";
      } catch {
        this.notifGranted = false;
      }
    }
    this.enabled = true;
  }

  /** Tear down (component unmount). */
  dispose(): void {
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.enabled = false;
  }

  private tierConfig(config: AlertConfig, tier: Tier) {
    const key = tierToAlertTier(tier);
    return config[key];
  }

  /**
   * Fire alert side-effects for an event, gated by config + permission state.
   * Returns the channels actually fired (useful for tests / UI feedback).
   */
  fire(
    ctx: AlertContext,
    config: AlertConfig,
  ): { audio: boolean; notification: boolean } {
    const tierCfg = this.tierConfig(config, ctx.tier);
    const result = { audio: false, notification: false };
    if (!this.enabled || !tierCfg.enabled) return result;

    if (tierCfg.audio_file != null) {
      this.beep(ctx.tier);
      result.audio = true;
    }

    if (tierCfg.browser_notif && this.notifGranted && "Notification" in window) {
      try {
        new Notification(ctx.title, { body: ctx.body, tag: `mnq-${ctx.tier}` });
        result.notification = true;
      } catch {
        // some browsers throw if constructed without a service worker
      }
    }

    return result;
  }

  /** A short synthesized tone whose pitch encodes the tier (no asset files). */
  private beep(tier: Tier): void {
    if (!this.ctx) return;
    const freq = tier === "CRITICAL" ? 880 : tier === "HIGH" ? 660 : 440;
    const dur = tier === "CRITICAL" ? 0.35 : 0.18;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, this.ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + dur);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + dur + 0.02);
  }
}
