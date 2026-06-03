/**
 * Time x price depth heatmap layer.
 *
 * The store keeps only the latest DepthPayload; this hook/primitive retains a
 * bounded column history so high-frequency depth does not inflate React state.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import type { IChartApi, ISeriesApi, MouseEventParams, Time } from "lightweight-charts";
import { useDashboard, useDashboardSelector } from "../store/context";
import {
  DEPTH_HEATMAP_ID_PREFIX,
  DepthHeatmapPrimitive,
  HYDRATION_DEPTH_CHUNK_SIZE,
  type HoveredDepthCell,
} from "./depthHeatmap";
import { DepthHeatmapGPULayer } from "./gpu/depthHeatmapLayer";
import { PersistentLevelManager } from "./persistentLevels";
import { WallMarkerManager } from "./wallMarkers";

const DEPTH_BACKFILL_POLL_INTERVAL_MS = 100;

/**
 * RA-115 (Option D, Phase 1): rendering-backend feature flag. Default Canvas2D.
 * Set VITE_DEPTH_RENDERER=webgpu (in .env.local or the build env) to enable
 * the WebGPU overlay. If WebGPU init fails at runtime, this falls back to
 * Canvas2D automatically — no behavior change vs. flag-off.
 */
const USE_WEBGPU_DEPTH = import.meta.env.VITE_DEPTH_RENDERER === "webgpu";

export function useDepthHeatmap(
  chartRef: RefObject<IChartApi | null>,
  seriesRef: RefObject<ISeriesApi<"Line"> | null>,
): HoveredDepthCell | null {
  // RA-112: subscribe only to the depth + persistentLevels slices. The anchor
  // price for top-K level ranking is read from liveTickRef (NOT a reactive
  // subscription) inside the effect, so this hook does not re-render the chart
  // on every price tick — re-ranking instead rides the depth cadence.
  const { liveTickRef, bookmapBackfillRef, bookmapBackfillEpoch } = useDashboard();
  const depth = useDashboardSelector((s) => s.depth);
  const persistentLevels = useDashboardSelector((s) => s.persistentLevels);
  const primitiveRef = useRef<DepthHeatmapPrimitive | null>(null);
  const wallManagerRef = useRef<WallMarkerManager | null>(null);
  const persistentLevelManagerRef = useRef<PersistentLevelManager | null>(null);
  const [hovered, setHovered] = useState<HoveredDepthCell | null>(null);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const primitive = new DepthHeatmapPrimitive();
    series.attachPrimitive(primitive);
    primitiveRef.current = primitive;
    // RA-107a: top-N persistent-liquidity wall markers share the same series.
    // createPriceLine is layout-only (not a primitive) - no autoscale re-entry.
    const wallManager = new WallMarkerManager(series);
    wallManagerRef.current = wallManager;
    // RA-108: session-long structural levels (separate from RA-107a wall
    // markers). Different line style (solid/dotted/dashed by confidence,
    // vs RA-107a's dashed). Anchored even when price moves far from level.
    const persistentLevelManager = new PersistentLevelManager(series);
    persistentLevelManagerRef.current = persistentLevelManager;

    // RA-115 (Option D, Phase 1): when the WebGPU flag is set, attach the
    // overlay layer asynchronously. If init succeeds, swap the primitive's
    // backend to "gpu" so its Canvas2D paint becomes a no-op. If init fails
    // (no navigator.gpu, adapter rejected, etc.), the primitive stays on
    // Canvas2D and no behavior changes vs. flag-off.
    let gpuLayer: DepthHeatmapGPULayer | null = null;
    let cancelled = false;
    if (USE_WEBGPU_DEPTH) {
      const chart = chartRef.current;
      if (chart) {
        DepthHeatmapGPULayer.attach(chart, series, primitive)
          .then((layer) => {
            if (cancelled) {
              layer?.detach();
              return;
            }
            if (layer) {
              primitive.setBackend("gpu");
              gpuLayer = layer;
              // eslint-disable-next-line no-console
              console.info(
                "[gpu] depth heatmap → WebGPU overlay attached",
                layer.diagnostics(),
              );
            } else {
              // eslint-disable-next-line no-console
              console.warn(
                "[gpu] depth heatmap WebGPU init returned null; staying on Canvas2D",
              );
            }
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.warn("[gpu] depth heatmap WebGPU attach failed; staying on Canvas2D", err);
          });
      }
    }

    return () => {
      cancelled = true;
      gpuLayer?.detach();
      persistentLevelManager.clear();
      if (persistentLevelManagerRef.current === persistentLevelManager) {
        persistentLevelManagerRef.current = null;
      }
      wallManager.clear();
      if (wallManagerRef.current === wallManager) wallManagerRef.current = null;
      series.detachPrimitive(primitive);
      if (primitiveRef.current === primitive) primitiveRef.current = null;
    };
  }, [seriesRef, chartRef]);

  useEffect(() => {
    if (!depth) return;
    primitiveRef.current?.appendSnapshot(depth);
    const snapshot = primitiveRef.current?.accumulatorSnapshot();
    if (snapshot) wallManagerRef.current?.update(snapshot.scores, snapshot.mid);
    // RA-112: re-rank persistent levels against the latest price on each depth
    // tick. Reading liveTickRef (not a reactive price subscription) keeps the
    // top-K anchor current as price drifts WITHOUT re-rendering on every tick.
    persistentLevelManagerRef.current?.update(
      persistentLevels,
      liveTickRef.current?.price ?? null,
    );
  }, [depth, persistentLevels, liveTickRef]);

  // RA-108: persistent-levels render. Updates whenever the store's
  // persistentLevels map changes (new emit / status transition). Price-driven
  // re-ranking rides the depth effect above (anchored off liveTickRef).
  useEffect(() => {
    persistentLevelManagerRef.current?.update(
      persistentLevels,
      liveTickRef.current?.price ?? null,
    );
  }, [persistentLevels, liveTickRef]);

  useEffect(() => {
    let intervalId = 0;
    let rafId = 0;
    let lastEpoch = -1;
    let hydrationChunkIdx = 0;
    let hydrationPayloads: readonly import("@contracts/realtime/events").DepthPayload[] = [];

    const processChunk = () => {
      const primitive = primitiveRef.current;
      if (!primitive) return;
      const start = hydrationChunkIdx * HYDRATION_DEPTH_CHUNK_SIZE;
      const end = Math.min(start + HYDRATION_DEPTH_CHUNK_SIZE, hydrationPayloads.length);
      if (start < end) {
        primitive.appendHydrationChunk(hydrationPayloads.slice(start, end));
        const snapshot = primitive.accumulatorSnapshot();
        if (snapshot) wallManagerRef.current?.update(snapshot.scores, snapshot.mid);
      }
      hydrationChunkIdx += 1;
      if (end < hydrationPayloads.length) {
        // RA-111: rAF-yield between chunks so the renderer stays responsive
        // and we never trip the >50ms long-task threshold.
        rafId = window.requestAnimationFrame(processChunk);
      } else {
        primitive.finalizeHydration();
        hydrationPayloads = [];
        hydrationChunkIdx = 0;
        rafId = 0;
      }
    };

    const flushBackfill = () => {
      const epoch = bookmapBackfillEpoch.current;
      if (epoch !== lastEpoch) {
        lastEpoch = epoch;
        const backfill = bookmapBackfillRef.current;
        const primitive = primitiveRef.current;
        if (backfill && primitive) {
          // Cancel any in-flight hydration before starting a new one.
          if (rafId !== 0) {
            window.cancelAnimationFrame(rafId);
            rafId = 0;
          }
          primitive.beginHydration();
          hydrationPayloads = backfill.depth;
          hydrationChunkIdx = 0;
          if (hydrationPayloads.length === 0) {
            primitive.finalizeHydration();
          } else {
            rafId = window.requestAnimationFrame(processChunk);
          }
        }
      }
    };
    flushBackfill();
    intervalId = window.setInterval(flushBackfill, DEPTH_BACKFILL_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
      if (rafId !== 0) window.cancelAnimationFrame(rafId);
    };
  }, [bookmapBackfillEpoch, bookmapBackfillRef]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const handleMove = (param: MouseEventParams<Time>) => {
      // RA-115 perf: in GPU mode the primitive's projection is skipped during
      // pan/zoom (huge win). Hit-test needs the projected cells available, so
      // request one-shot projection just before querying.
      primitiveRef.current?.forceProjection();
      const objectId = param.hoveredInfo?.objectId ?? param.hoveredObjectId;
      if (
        typeof objectId === "string" &&
        objectId.startsWith(DEPTH_HEATMAP_ID_PREFIX) &&
        param.point
      ) {
        const item = primitiveRef.current?.itemById(objectId);
        if (item) {
          setHovered({ item, point: { x: param.point.x, y: param.point.y } });
          return;
        }
      }
      if (param.point) {
        const item = primitiveRef.current?.cellAtPoint(param.point.x, param.point.y);
        if (item) {
          setHovered({ item, point: { x: param.point.x, y: param.point.y } });
          return;
        }
      }
      setHovered(null);
    };
    chart.subscribeCrosshairMove(handleMove);
    return () => chart.unsubscribeCrosshairMove(handleMove);
  }, [chartRef]);

  return hovered;
}
