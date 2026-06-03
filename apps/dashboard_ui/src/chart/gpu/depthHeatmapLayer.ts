/**
 * WebGPU overlay layer for the depth heatmap.
 *
 * Sits on top of the Lightweight Charts canvas as a transparent overlay.
 * Reads depth columns from `DepthHeatmapPrimitive.getColumns()` each frame,
 * projects them to per-instance attributes, and renders via the WebGPU
 * pipeline in `depthHeatmapGPU.ts`.
 *
 * Architecture:
 *   - The existing `DepthHeatmapPrimitive` stays attached to the LC series
 *     (so hit-testing, persistent levels, wall markers all keep working)
 *     but its Canvas2D paint becomes a no-op via setBackend("gpu").
 *   - This layer owns: the overlay canvas, the `DepthHeatmapGPU` renderer,
 *     and a RAF loop that re-renders ~60Hz so pan/zoom stays smooth.
 *   - Viewport (visible time + price range) is read from the chart on each
 *     render frame. No subscription needed for price-axis changes — RAF
 *     polling is cheap (the projection itself is <1ms even at 75k cells).
 *
 * Lifecycle:
 *   `await DepthHeatmapGPULayer.attach(chart, series, primitive)` — creates
 *   the overlay canvas, initializes WebGPU, starts the RAF loop. Returns
 *   null if WebGPU init fails (caller falls back to Canvas2D — set the
 *   primitive's backend back to "canvas2d").
 *   `layer.detach()` — stops the RAF loop, removes the overlay canvas,
 *   destroys GPU buffers.
 */

import type { IChartApi, ISeriesApi, SeriesType, Time } from "lightweight-charts";
import { MNQ_TICK } from "../contract/render";
import {
  DEPTH_CONTRAST_WINDOW_SECONDS,
  MAX_DEPTH_CELL_DURATION_SECONDS,
  MAX_DEPTH_CELLS,
  depthContrastStats,
  depthIntensity,
  type DepthHeatmapPrimitive,
  type DepthHistoryColumn,
} from "../depthHeatmap";
import {
  DEPTH_HEATMAP_MAX_INSTANCES,
  DepthHeatmapGPU,
  INSTANCE_STRIDE_FLOATS,
} from "./depthHeatmapGPU";

interface VisiblePriceRange {
  top: number;
  bottom: number;
}

export class DepthHeatmapGPULayer {
  private chart: IChartApi;
  private series: ISeriesApi<SeriesType, Time>;
  private primitive: DepthHeatmapPrimitive;
  private canvas: HTMLCanvasElement;
  private renderer: DepthHeatmapGPU;
  private rafId = 0;
  private detached = false;
  /** Per-instance scratch — re-used every frame, never re-allocated. */
  private instances = new Float32Array(
    DEPTH_HEATMAP_MAX_INSTANCES * INSTANCE_STRIDE_FLOATS,
  );

  /**
   * Async factory. Returns null if WebGPU is unavailable (caller should
   * stay on the Canvas2D path).
   */
  static async attach(
    chart: IChartApi,
    series: ISeriesApi<SeriesType, Time>,
    primitive: DepthHeatmapPrimitive,
  ): Promise<DepthHeatmapGPULayer | null> {
    const chartEl = chart.chartElement();
    if (!chartEl) return null;

    const canvas = document.createElement("canvas");
    // Absolute over the chart; pointer-events: none so LC keeps owning the
    // mouse (hit-testing, crosshair, scroll/zoom).
    canvas.style.position = "absolute";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.pointerEvents = "none";
    // Above the LC canvases but below DOM markers like the legend chips.
    canvas.style.zIndex = "1";
    // Ensure the chart container is positioned so absolute children land here.
    if (getComputedStyle(chartEl).position === "static") {
      (chartEl as HTMLElement).style.position = "relative";
    }
    chartEl.appendChild(canvas);

    let renderer: DepthHeatmapGPU;
    try {
      renderer = await DepthHeatmapGPU.create(canvas);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[gpu] DepthHeatmapGPU.create failed; staying on Canvas2D", err);
      canvas.remove();
      return null;
    }

    return new DepthHeatmapGPULayer(chart, series, primitive, canvas, renderer);
  }

  private constructor(
    chart: IChartApi,
    series: ISeriesApi<SeriesType, Time>,
    primitive: DepthHeatmapPrimitive,
    canvas: HTMLCanvasElement,
    renderer: DepthHeatmapGPU,
  ) {
    this.chart = chart;
    this.series = series;
    this.primitive = primitive;
    this.canvas = canvas;
    this.renderer = renderer;
    this.loop = this.loop.bind(this);
    this.rafId = window.requestAnimationFrame(this.loop);
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    if (this.rafId !== 0) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.renderer.destroy();
    this.canvas.remove();
  }

  /**
   * RAF tick. Read viewport + columns, project, render. Cheap when there's
   * no data (early-return after a single empty render).
   */
  private loop(): void {
    if (this.detached) return;
    try {
      this.renderFrame();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[gpu] DepthHeatmapGPULayer renderFrame threw", err);
      // Don't kill the loop on a single render error — try again next frame.
    }
    this.rafId = window.requestAnimationFrame(this.loop);
  }

  private renderFrame(): void {
    const columns = this.primitive.getColumns();
    const visibleTime = this.getVisibleTimeRange();
    const visiblePrice = this.getVisiblePriceRange();

    // If we don't have a layout yet, render an empty frame (clears the canvas).
    if (!visibleTime || !visiblePrice || columns.length === 0) {
      this.renderer.setCamera({
        timeRange: visibleTime ?? [0, 1],
        priceRange: visiblePrice ? [visiblePrice.top, visiblePrice.bottom] : [1, 0],
      });
      this.renderer.setInstances(this.instances.subarray(0, 0));
      void this.renderer.render();
      return;
    }

    // Build instances. Newest column is "live" — project forward by a small
    // duration so the right edge of the heatmap always shows current liquidity.
    const nowSeconds = Date.now() / 1000;
    const stats = depthContrastStats(columns, nowSeconds, DEPTH_CONTRAST_WINDOW_SECONDS);

    let instCount = 0;
    const buf = this.instances;
    const cap = Math.min(DEPTH_HEATMAP_MAX_INSTANCES, MAX_DEPTH_CELLS);

    // Iterate newest → oldest so the budget always protects the live edge
    // (matches the Canvas2D path's RA-112b ordering).
    for (let i = columns.length - 1; i >= 0; i--) {
      if (instCount >= cap) break;
      const col = columns[i];
      // Time culling: skip columns entirely outside the visible range.
      // Allow a small overshoot on the left so partially-visible columns render.
      if (col.seconds < visibleTime[0] - MAX_DEPTH_CELL_DURATION_SECONDS) continue;
      if (col.seconds > visibleTime[1]) continue;

      // Time width: distance to NEXT column (i+1) or, for the live column,
      // a small forward projection so the right edge shows current state.
      let timeWidth: number;
      if (i < columns.length - 1) {
        timeWidth = Math.min(
          MAX_DEPTH_CELL_DURATION_SECONDS,
          columns[i + 1].seconds - col.seconds,
        );
      } else {
        // Live column: project ~250ms forward (depth emit cadence).
        timeWidth = 0.25;
      }
      if (timeWidth <= 0) continue;

      for (let li = 0; li < col.levels.length; li++) {
        if (instCount >= cap) break;
        const level = col.levels[li];
        // Price culling
        if (level.price < visiblePrice.bottom || level.price > visiblePrice.top) continue;
        const intensity = depthIntensity(level.size, stats.rollingMaxSize, stats.floorSize);
        if (intensity <= 0) continue;

        const off = instCount * INSTANCE_STRIDE_FLOATS;
        buf[off + 0] = col.seconds;
        buf[off + 1] = timeWidth;
        buf[off + 2] = level.price;
        buf[off + 3] = MNQ_TICK;
        buf[off + 4] = intensity;
        buf[off + 5] = level.side === "bid" ? 0.0 : 1.0;
        instCount++;
      }
    }

    this.renderer.setCamera({
      timeRange: visibleTime,
      priceRange: [visiblePrice.top, visiblePrice.bottom],
      // Match the Canvas2D path's contrast curve exactly so the visual is
      // close to identical (Phase 2 will diverge with bloom/glow).
      intensityPower: 2.0,
      alphaFloor: 0.06,
      alphaCeil: 1.0,
    });
    this.renderer.setInstances(buf.subarray(0, instCount * INSTANCE_STRIDE_FLOATS));
    void this.renderer.render();
  }

  private getVisibleTimeRange(): [number, number] | null {
    const range = this.chart.timeScale().getVisibleRange();
    if (!range) return null;
    const from = toSeconds(range.from);
    const to = toSeconds(range.to);
    if (from == null || to == null) return null;
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    return [Math.min(from, to), Math.max(from, to)];
  }

  private getVisiblePriceRange(): VisiblePriceRange | null {
    let height: number;
    try {
      height = this.chart.paneSize().height;
    } catch {
      return null;
    }
    if (!Number.isFinite(height) || height <= 0) return null;
    // Small margin so cells straddling the edge still render.
    const margin = height * 0.05;
    const top = this.series.coordinateToPrice(-margin);
    const bottom = this.series.coordinateToPrice(height + margin);
    if (top == null || bottom == null) return null;
    const a = Number(top);
    const b = Number(bottom);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return { top: Math.max(a, b), bottom: Math.min(a, b) };
  }

  /** Diagnostics for the perf overlay (instance count + adapter info). */
  diagnostics(): { instances: number; vendor: string; architecture: string } {
    return this.renderer.diagnostics();
  }
}

function toSeconds(time: Time): number | null {
  if (typeof time === "number") return time;
  if (typeof time === "string") {
    const parsed = Date.parse(`${time}T00:00:00Z`);
    return Number.isFinite(parsed) ? parsed / 1000 : null;
  }
  // BusinessDay
  if (
    typeof time === "object" &&
    time != null &&
    "year" in time &&
    "month" in time &&
    "day" in time
  ) {
    const parsed = Date.UTC(time.year, time.month - 1, time.day) / 1000;
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
