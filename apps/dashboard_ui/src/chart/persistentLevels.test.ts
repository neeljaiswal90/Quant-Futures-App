import { describe, expect, it, vi } from "vitest";
import type { PersistentLevelPayload } from "@contracts/realtime/events";
import {
  DEFAULT_MAX_RENDERED_LEVELS,
  PersistentLevelManager,
  persistentLevelTitle,
  selectRenderableLevels,
} from "./persistentLevels";

function level(
  overrides: Partial<PersistentLevelPayload> = {},
): PersistentLevelPayload {
  return {
    family: "persistent_level",
    level_id: overrides.level_id ?? `${overrides.price ?? 30000}_${overrides.side ?? "ask"}`,
    price: 30000,
    side: "ask",
    persistence_seconds: 120,
    confidence: "medium",
    evidence: [],
    last_active_ts_ns: 1_000_000_000,
    status: "active",
    notes: null,
    ...overrides,
  };
}

describe("selectRenderableLevels", () => {
  it("excludes broken levels", () => {
    const out = selectRenderableLevels(
      [
        level({ price: 30000, status: "active" }),
        level({ price: 30005, status: "broken" }),
      ],
      30000,
      10,
    );
    expect(out.map((l) => l.price)).toEqual([30000]);
  });

  it("sorts by absolute distance from the anchor price (nearest first)", () => {
    const out = selectRenderableLevels(
      [
        level({ price: 30100, level_id: "a" }),
        level({ price: 29950, level_id: "b" }),
        level({ price: 30005, level_id: "c" }),
      ],
      30000,
      10,
    );
    expect(out.map((l) => l.level_id)).toEqual(["c", "b", "a"]);
  });

  it("caps at the requested K", () => {
    const out = selectRenderableLevels(
      [
        level({ price: 30001, level_id: "a" }),
        level({ price: 30002, level_id: "b" }),
        level({ price: 30003, level_id: "c" }),
        level({ price: 30004, level_id: "d" }),
      ],
      30000,
      2,
    );
    expect(out.map((l) => l.level_id)).toEqual(["a", "b"]);
  });

  it("falls back to numeric price order when anchor is null", () => {
    const out = selectRenderableLevels(
      [
        level({ price: 30010, level_id: "z" }),
        level({ price: 30005, level_id: "y" }),
        level({ price: 30001, level_id: "x" }),
      ],
      null,
      10,
    );
    expect(out.map((l) => l.level_id)).toEqual(["x", "y", "z"]);
  });

  it("DEFAULT_MAX_RENDERED_LEVELS = 12", () => {
    expect(DEFAULT_MAX_RENDERED_LEVELS).toBe(12);
  });
});

describe("persistentLevelTitle", () => {
  it("formats with side, price, confidence, persistence (minutes)", () => {
    expect(
      persistentLevelTitle(
        level({ price: 30525.5, side: "ask", confidence: "high", persistence_seconds: 315 }),
      ),
    ).toBe("LVL ask 30525.50 high (5m)");
  });

  it("falls back to seconds for sub-minute persistence", () => {
    expect(
      persistentLevelTitle(
        level({ price: 30490.25, side: "bid", confidence: "low", persistence_seconds: 30 }),
      ),
    ).toBe("LVL bid 30490.25 low (30s)");
  });
});

interface FakePriceLine {
  applied: Array<Record<string, unknown>>;
  _id: string;
}

function fakeSeries() {
  const created: Array<{ id: string; price: number; color: string; title: string }> = [];
  const removed: string[] = [];
  const series = {
    createPriceLine: vi.fn((options: { price: number; color: string; title: string }) => {
      const id = `${options.price}_${options.title}`;
      const line: FakePriceLine & {
        applyOptions: (opts: Record<string, unknown>) => void;
      } = {
        applied: [],
        _id: id,
        applyOptions: (opts) => {
          line.applied.push(opts);
        },
      };
      created.push({ id, price: options.price, color: options.color, title: options.title });
      return line;
    }),
    removePriceLine: vi.fn((line: { _id: string }) => {
      removed.push(line._id);
    }),
  };
  return { series, created, removed };
}

describe("PersistentLevelManager.update", () => {
  it("creates one price line per active level on first update", () => {
    const harness = fakeSeries();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new PersistentLevelManager(harness.series as any);

    mgr.update(
      {
        a: level({ level_id: "a", price: 30005 }),
        b: level({ level_id: "b", price: 30010 }),
      },
      30000,
    );

    expect(mgr.activeCount()).toBe(2);
    expect(harness.created.length).toBe(2);
  });

  it("removes levels that go broken", () => {
    const harness = fakeSeries();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new PersistentLevelManager(harness.series as any);

    mgr.update({ a: level({ level_id: "a", status: "active" }) }, 30000);
    expect(mgr.activeCount()).toBe(1);

    mgr.update({ a: level({ level_id: "a", status: "broken" }) }, 30000);
    expect(mgr.activeCount()).toBe(0);
    expect(harness.removed.length).toBe(1);
  });

  it("re-styles existing line when confidence changes (no remove+add churn)", () => {
    const harness = fakeSeries();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new PersistentLevelManager(harness.series as any);

    mgr.update({ a: level({ level_id: "a", confidence: "low" }) }, 30000);
    expect(harness.created.length).toBe(1);

    // Promote to high — same level_id, line should update not recreate.
    mgr.update({ a: level({ level_id: "a", confidence: "high" }) }, 30000);
    expect(harness.created.length).toBe(1);  // still just the one
    expect(harness.removed.length).toBe(0);
  });

  it("clear() removes all rendered lines", () => {
    const harness = fakeSeries();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new PersistentLevelManager(harness.series as any);

    mgr.update({ a: level({ level_id: "a" }), b: level({ level_id: "b", price: 30050 }) }, 30000);
    expect(mgr.activeCount()).toBe(2);

    mgr.clear();
    expect(mgr.activeCount()).toBe(0);
  });

  it("respects maxRenderedLevels cap (excess clipped to nearest-to-anchor)", () => {
    const harness = fakeSeries();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new PersistentLevelManager(harness.series as any, { maxRenderedLevels: 2 });

    mgr.update(
      {
        far: level({ level_id: "far", price: 30100 }),
        near: level({ level_id: "near", price: 30002 }),
        mid: level({ level_id: "mid", price: 30050 }),
      },
      30000,
    );

    expect(mgr.activeCount()).toBe(2);
    // Far level should NOT be rendered (it's the furthest of the three).
    expect(harness.created.map((c) => c.id)).toContain(
      `${30002}_LVL ask 30002.00 medium (2m)`,
    );
  });
});
