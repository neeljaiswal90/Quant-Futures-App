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
  type HoveredDepthCell,
} from "./depthHeatmap";
import { WallMarkerManager } from "./wallMarkers";

const DEPTH_BACKFILL_POLL_INTERVAL_MS = 100;

export function useDepthHeatmap(
  chartRef: RefObject<IChartApi | null>,
  seriesRef: RefObject<ISeriesApi<"Line"> | null>,
): HoveredDepthCell | null {
  const { state, bookmapBackfillRef, bookmapBackfillEpoch } = useDashboard();
  const primitiveRef = useRef<DepthHeatmapPrimitive | null>(null);
  const wallManagerRef = useRef<WallMarkerManager | null>(null);
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
    return () => {
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

  useEffect(() => {
    let intervalId = 0;
    let lastEpoch = -1;
    const flushBackfill = () => {
      const epoch = bookmapBackfillEpoch.current;
      if (epoch !== lastEpoch) {
        lastEpoch = epoch;
        const backfill = bookmapBackfillRef.current;
        if (backfill) {
          primitiveRef.current?.setHistory(backfill.depth);
          const snapshot = primitiveRef.current?.accumulatorSnapshot();
          if (snapshot) wallManagerRef.current?.update(snapshot.scores, snapshot.mid);
        }
      }
    };
    flushBackfill();
    intervalId = window.setInterval(flushBackfill, DEPTH_BACKFILL_POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
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
