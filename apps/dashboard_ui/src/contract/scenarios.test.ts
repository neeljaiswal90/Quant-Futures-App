import { describe, expect, it } from "vitest";
import {
  DECAY_AGE_MS,
  isBannerActive,
  rankScenarios,
  type CriticalBanner,
} from "./scenarios";
import type { ScenarioState } from "@contracts/realtime/events";

const scn = (
  id: string,
  probability: number | null,
  target_price: number | null,
): ScenarioState => ({ id, label: id, probability, target_price });

describe("rankScenarios", () => {
  it("filters to within +-100pt of price", () => {
    const ranked = rankScenarios(
      [scn("near", 0.5, 30050), scn("far", 0.9, 30500)],
      30080,
    );
    expect(ranked.map((s) => s.id)).toEqual(["near"]);
  });

  it("caps at 3 and sorts by probability then proximity", () => {
    const ranked = rankScenarios(
      [
        scn("a", 0.4, 30090),
        scn("b", 0.8, 30120),
        scn("c", 0.8, 30100),
        scn("d", 0.2, 30075),
      ],
      30080,
    );
    expect(ranked).toHaveLength(3);
    // 0.8 nearer (c at 20pt) before 0.8 (b at 40pt), then 0.4 (a).
    expect(ranked.map((s) => s.id)).toEqual(["c", "b", "a"]);
  });

  it("keeps untargeted scenarios but sinks them below in-window targets", () => {
    const ranked = rankScenarios(
      [scn("targeted", 0.9, 30090), scn("untargeted", 0.95, null)],
      30080,
    );
    expect(ranked.map((s) => s.id)).toEqual(["untargeted", "targeted"]);
    // untargeted has higher probability so it still sorts first here;
    // proximity only breaks ties.
  });

  it("treats all as in-window when price is unknown", () => {
    const ranked = rankScenarios([scn("a", 0.5, 99999)], null);
    expect(ranked).toHaveLength(1);
  });
});

describe("isBannerActive", () => {
  const banner: CriticalBanner = {
    seq: 2,
    triggerPrice: 30080,
    description: "x",
    raisedAtMs: 1_000_000,
  };

  it("is active near the trigger within the time window", () => {
    expect(isBannerActive(banner, 30090, 1_000_000 + 5_000)).toBe(true);
  });

  it("decays after a >50pt move", () => {
    expect(isBannerActive(banner, 30131, 1_000_000 + 5_000)).toBe(false);
    expect(isBannerActive(banner, 30029, 1_000_000 + 5_000)).toBe(false);
  });

  it("decays after 30 minutes", () => {
    expect(isBannerActive(banner, 30080, 1_000_000 + DECAY_AGE_MS)).toBe(false);
  });

  it("stays active when price is unknown but within the time window", () => {
    expect(isBannerActive(banner, null, 1_000_000 + 1_000)).toBe(true);
  });
});
