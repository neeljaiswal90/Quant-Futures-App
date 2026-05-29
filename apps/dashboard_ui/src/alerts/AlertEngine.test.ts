import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertEngine, tierToAlertTier } from "./AlertEngine";
import { DEFAULT_ALERT_CONFIG } from "./config";
import type { AlertConfig } from "@contracts/realtime/config";

// Minimal AudioContext stub so beep() does not throw in jsdom.
class FakeAudioContext {
  state = "running";
  currentTime = 0;
  destination = {};
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  createOscillator() {
    return {
      type: "sine",
      frequency: { value: 0 },
      connect: () => ({ connect: () => undefined }),
      start: vi.fn(),
      stop: vi.fn(),
    };
  }
  createGain() {
    return {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: (n: unknown) => n,
    };
  }
}

describe("tierToAlertTier", () => {
  it("lowercases the envelope tier to the config key", () => {
    expect(tierToAlertTier("CRITICAL")).toBe("critical");
    expect(tierToAlertTier("HIGH")).toBe("high");
    expect(tierToAlertTier("MEDIUM")).toBe("medium");
  });
});

describe("AlertEngine gating", () => {
  let notifSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as unknown as { AudioContext: unknown }).AudioContext =
      FakeAudioContext;
    notifSpy = vi.fn();
    class FakeNotification {
      static permission = "granted";
      static requestPermission = vi.fn().mockResolvedValue("granted");
      constructor(title: string, opts?: unknown) {
        notifSpy(title, opts);
      }
    }
    (globalThis as unknown as { Notification: unknown }).Notification =
      FakeNotification;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires nothing before enable()", () => {
    const e = new AlertEngine();
    const r = e.fire(
      { tier: "CRITICAL", title: "t", body: "b" },
      DEFAULT_ALERT_CONFIG,
    );
    expect(r).toEqual({ audio: false, notification: false });
  });

  it("fires audio + notification for CRITICAL when enabled", async () => {
    const e = new AlertEngine();
    await e.enable();
    expect(e.isEnabled()).toBe(true);
    const r = e.fire(
      { tier: "CRITICAL", title: "CRIT", body: "stacked" },
      DEFAULT_ALERT_CONFIG,
    );
    expect(r.audio).toBe(true);
    expect(r.notification).toBe(true);
    expect(notifSpy).toHaveBeenCalledOnce();
  });

  it("respects per-tier disable", async () => {
    const e = new AlertEngine();
    await e.enable();
    const cfg: AlertConfig = {
      ...DEFAULT_ALERT_CONFIG,
      high: { ...DEFAULT_ALERT_CONFIG.high, enabled: false },
    };
    const r = e.fire({ tier: "HIGH", title: "h", body: "b" }, cfg);
    expect(r).toEqual({ audio: false, notification: false });
  });

  it("MEDIUM (no audio_file, no browser_notif) fires no audio and no notif", async () => {
    const e = new AlertEngine();
    await e.enable();
    const r = e.fire({ tier: "MEDIUM", title: "m", body: "b" }, DEFAULT_ALERT_CONFIG);
    expect(r.audio).toBe(false); // audio_file is null for medium by default
    expect(r.notification).toBe(false); // browser_notif false for medium
  });
});
