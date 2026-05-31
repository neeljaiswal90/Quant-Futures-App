import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertEngine, tierToAlertTier } from "./AlertEngine";

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
      { audio: true, notification: true },
    );
    expect(r).toEqual({ audio: false, notification: false });
  });

  it("fires audio + notification for CRITICAL when enabled", async () => {
    const e = new AlertEngine();
    await e.enable();
    expect(e.isEnabled()).toBe(true);
    const r = e.fire(
      { tier: "CRITICAL", title: "CRIT", body: "stacked" },
      { audio: true, notification: true },
    );
    expect(r.audio).toBe(true);
    expect(r.notification).toBe(true);
    expect(notifSpy).toHaveBeenCalledOnce();
  });

  it("suppresses browser notifications inside Codex/Electron shells", async () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(
      "OpenAI.Codex Electron",
    );
    const e = new AlertEngine();
    await e.enable();
    const r = e.fire(
      { tier: "CRITICAL", title: "CRIT", body: "stacked" },
      { audio: true, notification: true },
    );
    expect(r.audio).toBe(true);
    expect(r.notification).toBe(false);
    expect(notifSpy).not.toHaveBeenCalled();
  });

  it("respects the pure decision module returning no channels", async () => {
    const e = new AlertEngine();
    await e.enable();
    const r = e.fire(
      { tier: "HIGH", title: "h", body: "b" },
      { audio: false, notification: false },
    );
    expect(r).toEqual({ audio: false, notification: false });
  });

  it("MEDIUM (no audio_file, no browser_notif) fires no audio and no notif", async () => {
    const e = new AlertEngine();
    await e.enable();
    const r = e.fire(
      { tier: "MEDIUM", title: "m", body: "b" },
      { audio: false, notification: false },
    );
    expect(r.audio).toBe(false); // audio_file is null for medium by default
    expect(r.notification).toBe(false); // browser_notif false for medium
  });
});
