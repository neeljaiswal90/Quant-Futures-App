/**
 * Time x price depth heatmap layer.
 *
 * The store keeps only the latest DepthPayload; this hook/primitive retains a
 * bounded column history so high-frequency depth does not inflate React state.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import type { IChartApi, ISeriesApi, MouseEventParams, Time } from "lightweight-charts";
import { useDashboard } from "../store/context";
import {
  DEPTH_HEATMAP_ID_PREFIX,
  DepthHeatmapPrimitive,
  HYDRATION_DEPTH_CHUNK_SIZE,
  type HoveredDepthCell,
} from "./depthHeatmap";
import { PersistentLevelManager } from "./persistentLevels";
import { WallMarkerManager } from "./wallMarkers";

const DEPTH_BACKFILL_POLL_INTERVAL_MS = 100;

export function useDepthHeatmap(
  chartRef: RefObject<IChartApi | null>,
  seriesRef: RefObject<ISeriesApi<"Line"> | null>,
): HoveredDepthCell | null {
  const { state, bookmapBackfillRef, bookmapBackfillEpoch } = useDashboard();
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
    return () => {
      persistentLevelManager.clear();
      if (persistentLevelManagerRef.current === persistentLevelManager) {
        persistentLevelManagerRef.current = null;
      }
      wallManager.clear();
      if (wallManagerRef.current === wallManager) wallManagerRef.current = null;
      series.detachPrimitive(primitive);
      if (primitiveRef.current === primitive) primitiveRef.current = null;
    };
  }, [seriesRef]);

  useEffect(() => {
    if (!state.depth) return;
    primitiveRef.current?.appendSnapshot(state.depth);
    const snapshot = primitiveRef.current?.accumulatorSnapshot();
    if (snapshot) wallManagerRef.current?.update(snapshot.scores, snapshot.mid);
  }, [state.depth]);

  // RA-108: persistent-levels render. Updates whenever the store's
  // persistentLevels map changes (new emit / status transition) or when
  // current price moves (we sort top-K by absolute distance from mid).
  useEffect(() => {
    persistentLevelManagerRef.current?.update(
      state.persistentLevels,
      state.price.price,
    );
  }, [state.persistentLevels, state.price.price]);

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
