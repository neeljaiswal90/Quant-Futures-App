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

const DEPTH_BACKFILL_POLL_INTERVAL_MS = 100;

export function useDepthHeatmap(
  chartRef: RefObject<IChartApi | null>,
  seriesRef: RefObject<ISeriesApi<"Line"> | null>,
): HoveredDepthCell | null {
  const { state, bookmapBackfillRef, bookmapBackfillEpoch } = useDashboard();
  const primitiveRef = useRef<DepthHeatmapPrimitive | null>(null);
  const [hovered, setHovered] = useState<HoveredDepthCell | null>(null);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const primitive = new DepthHeatmapPrimitive();
    series.attachPrimitive(primitive);
    primitiveRef.current = primitive;
    return () => {
      series.detachPrimitive(primitive);
      if (primitiveRef.current === primitive) primitiveRef.current = null;
    };
  }, [seriesRef]);

  useEffect(() => {
    if (!state.depth) return;
    primitiveRef.current?.appendSnapshot(state.depth);
  }, [state.depth]);

  useEffect(() => {
    let intervalId = 0;
    let lastEpoch = -1;
    const flushBackfill = () => {
      const epoch = bookmapBackfillEpoch.current;
      if (epoch !== lastEpoch) {
        lastEpoch = epoch;
        const backfill = bookmapBackfillRef.current;
        if (backfill) primitiveRef.current?.setHistory(backfill.depth);
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
