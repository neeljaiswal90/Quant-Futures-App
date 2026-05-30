import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_CONFIG } from "./config";
import {
  alertDecisionInternals,
  createAlertMemory,
  decideAlert,
} from "./decision";
import type { FeedItem } from "../contract/render";

const baseItem: FeedItem = {
  seq: 1,
  tsNs: 1,
  tier: "CRITICAL",
  family: "signal",
  text: "critical session event",
  strength: 1,
};

describe("decideAlert", () => {
  it("allows price-less critical events through the proximity gate", () => {
    const memory = createAlertMemory();
    const decision = decideAlert(baseItem, {
      currentPrice: 30300,
      config: DEFAULT_ALERT_CONFIG,
      nowMs: 1_000,
      memory,
    });
    expect(decision.banner).toBe(true);
    expect(decision.reason).toBeNull();
  });

  it("applies proximity only when an event price is present", () => {
    const memory = createAlertMemory();
    const decision = decideAlert(
      { ...baseItem, price: 30100, levelId: "vpoc" },
      {
        currentPrice: 30300,
        config: DEFAULT_ALERT_CONFIG,
        nowMs: 1_000,
        memory,
      },
    );
    expect(decision.reason).toBe("outside-proximity");
  });

  it("dedupes repeated logical alerts during the cooldown window", () => {
    const memory = createAlertMemory();
    const first = decideAlert(
      { ...baseItem, price: 30300, levelId: "vpoc" },
      { currentPrice: 30300, config: DEFAULT_ALERT_CONFIG, nowMs: 1_000, memory },
    );
    const second = decideAlert(
      { ...baseItem, seq: 2, price: 30300, levelId: "vpoc" },
      { currentPrice: 30300, config: DEFAULT_ALERT_CONFIG, nowMs: 2_000, memory },
    );
    expect(first.reason).toBeNull();
    expect(second.reason).toBe("cooldown");
  });

  it("uses the configured cooldown duration", () => {
    const memory = createAlertMemory();
    const config = { ...DEFAULT_ALERT_CONFIG, cooldown_seconds: 10 };
    const first = decideAlert(
      { ...baseItem, price: 30300, levelId: "vpoc" },
      { currentPrice: 30300, config, nowMs: 1_000, memory },
    );
    const within = decideAlert(
      { ...baseItem, seq: 2, price: 30300, levelId: "vpoc" },
      { currentPrice: 30300, config, nowMs: 10_000, memory },
    );
    const after = decideAlert(
      { ...baseItem, seq: 3, price: 30300, levelId: "vpoc" },
      { currentPrice: 30300, config, nowMs: 12_000, memory },
    );
    expect(first.reason).toBeNull();
    expect(within.reason).toBe("cooldown");
    expect(after.reason).toBeNull();
  });

  it("quiet hours audio_only suppresses audio but keeps visual channels", () => {
    const memory = createAlertMemory();
    const config = {
      ...DEFAULT_ALERT_CONFIG,
      quiet_hours: {
        enabled: true,
        start_pt: "00:00",
        end_pt: "23:59",
        audio_only: true,
      },
    };
    const decision = decideAlert(baseItem, {
      currentPrice: null,
      config,
      nowMs: Date.UTC(2026, 4, 29, 18, 0),
      now: new Date(Date.UTC(2026, 4, 29, 18, 0)),
      memory,
    });
    expect(decision.audio).toBe(false);
    expect(decision.notification).toBe(true);
    expect(decision.banner).toBe(true);
  });
});

describe("alertDecisionInternals", () => {
  it("handles overnight quiet-hour windows", () => {
    expect(
      alertDecisionInternals.inQuietHours(
        new Date("2026-05-29T05:30:00-07:00"),
        { enabled: true, start_pt: "22:00", end_pt: "06:00", audio_only: true },
      ),
    ).toBe(true);
  });
});
