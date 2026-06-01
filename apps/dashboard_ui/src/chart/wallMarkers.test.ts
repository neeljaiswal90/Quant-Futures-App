import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TOP_N_WALLS,
  WallMarkerManager,
  WALL_MIN_PERSISTENCE,
  selectTopWalls,
  wallMarkerColor,
  wallMarkerTitle,
} from "./wallMarkers";

describe("selectTopWalls", () => {
  it("picks the top-N by score, descending", () => {
    const scores = new Map<number, number>([
      [30100, 100],
      [30105, 200],
      [30095, 50],
      [30110, 800],
      [30090, 400],
    ]);

    const top = selectTopWalls(scores, 30100, 3, WALL_MIN_PERSISTENCE);

    expect(top.map((w) => w.price)).toEqual([30110, 30090, 30105]);
    expect(top.map((w) => Math.round(w.score))).toEqual([800, 400, 200]);
  });

  it("excludes levels below the noise floor", () => {
    const scores = new Map<number, number>([
      [30100, 80],   // below floor (default 100)
      [30105, 200],
      [30110, 50],   // below floor
    ]);

    const top = selectTopWalls(scores, 30100, 3, WALL_MIN_PERSISTENCE);

    expect(top.map((w) => w.price)).toEqual([30105]);
  });

  it("derives side from price vs mid for each wall (RA-107a polarization)", () => {
    const scores = new Map<number, number>([
      [30110, 800],  // > mid -> ask
      [30090, 400],  // < mid -> bid
    ]);

    const top = selectTopWalls(scores, 30100, 3, WALL_MIN_PERSISTENCE);

    const byPrice = new Map(top.map((w) => [w.price, w.side] as const));
    expect(byPrice.get(30110)).toBe("ask");
    expect(byPrice.get(30090)).toBe("bid");
  });

  it("treats unknown mid as ask (tie-break)", () => {
    const scores = new Map<number, number>([[30100, 500]]);
    const top = selectTopWalls(scores, null, 3, WALL_MIN_PERSISTENCE);
    expect(top[0].side).toBe("ask");
  });

  it("default topN is DEFAULT_TOP_N_WALLS", () => {
    expect(DEFAULT_TOP_N_WALLS).toBe(3);
  });
});

describe("wallMarkerTitle", () => {
  it("formats with side, price, and persistence score", () => {
    expect(
      wallMarkerTitle({ price: 30525.5, score: 4823.7, side: "ask" }),
    ).toBe("wall ask 30525.50 (p4824)");
    expect(
      wallMarkerTitle({ price: 30490.25, score: 1200.3, side: "bid" }),
    ).toBe("wall bid 30490.25 (p1200)");
  });
});

describe("wallMarkerColor", () => {
  it("returns pink-400 for ask and sky-400 for bid (RA-107a palette)", () => {
    expect(wallMarkerColor("ask")).toContain("248, 113, 113");
    expect(wallMarkerColor("bid")).toContain("56, 189, 248");
  });
});

interface FakePriceLine {
  applied: Array<{ title?: string; color?: string }>;
}

function fakeSeries() {
  const lines: FakePriceLine[] = [];
  const created: Array<{ price: number; color: string; title: string }> = [];
  const removed: number[] = [];
  const series = {
    createPriceLine: vi.fn((options: { price: number; color: string; title: string }) => {
      const line: FakePriceLine & {
        applyOptions: (opts: { title?: string; color?: string }) => void;
        _price: number;
      } = {
        applied: [],
        applyOptions: (opts) => {
          line.applied.push(opts);
        },
        _price: options.price,
      };
      lines.push(line);
      created.push({ price: options.price, color: options.color, title: options.title });
      return line;
    }),
    removePriceLine: vi.fn((line: { _price: number }) => {
      removed.push(line._price);
    }),
  };
  return { series, created, removed, lines };
}

describe("WallMarkerManager.update", () => {
  it("creates one price line per top-N wall on first update", () => {
    const harness = fakeSeries();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new WallMarkerManager(harness.series as any);

    mgr.update(
      new Map([
        [30100, 800],
        [30110, 400],
        [30095, 200],
      ]),
      30100,
    );

    expect(mgr.activeCount()).toBe(3);
    expect(harness.created.map((c) => c.price).sort()).toEqual([30095, 30100, 30110]);
    expect(harness.removed).toEqual([]);
  });

  it("diffs additions and removals as top-N shifts", () => {
    const harness = fakeSeries();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new WallMarkerManager(harness.series as any);

    mgr.update(
      new Map([
        [30100, 800],
        [30110, 400],
        [30095, 200],
      ]),
      30100,
    );
    expect(mgr.activeCount()).toBe(3);

    // 30095 drops out; 30115 enters
    mgr.update(
      new Map([
        [30100, 800],
        [30110, 400],
        [30115, 1200],
      ]),
      30100,
    );

    expect(mgr.activeCount()).toBe(3);
    expect(harness.removed).toContain(30095);
    expect(harness.created.map((c) => c.price)).toContain(30115);
  });

  it("clear() removes all rendered walls", () => {
    const harness = fakeSeries();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new WallMarkerManager(harness.series as any);

    mgr.update(new Map([[30100, 800]]), 30100);
    expect(mgr.activeCount()).toBe(1);

    mgr.clear();
    expect(mgr.activeCount()).toBe(0);
    expect(harness.removed).toContain(30100);
  });

  it("refreshes title when the same price's score changes (no remove+add churn)", () => {
    const harness = fakeSeries();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = new WallMarkerManager(harness.series as any);

    mgr.update(new Map([[30100, 800]]), 30100);
    expect(harness.created).toHaveLength(1);

    // Score changes but the price stays top-N: no remove, no second createPriceLine
    mgr.update(new Map([[30100, 1500]]), 30100);
    expect(harness.created).toHaveLength(1);
    expect(harness.removed).toEqual([]);

    const line = harness.lines[0];
    expect(line.applied.at(-1)?.title).toContain("p1500");
  });
});
