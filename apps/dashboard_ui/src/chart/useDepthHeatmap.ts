/**
 * Time x price depth heatmap layer.
 *
 * The store keeps only the latest DepthPayload; this hook/primitive retains a
 * bounded column history so high-frequency depth does not inflate React state.
 */
import { useEffect, useRef, type RefObject } from "react";
import type { ISeriesApi } from "lightweight-charts";
import { useDashboard } from "../store/context";
import { DepthHeatmapPrimitive } from "./depthHeatmap";

const DEPTH_BACKFILL_POLL_INTERVAL_MS = 100;

export function useDepthHeatmap(
  seriesRef: RefObject<ISeriesApi<"Line"> | null>,
): void {
  const { state, bookmapBackfillRef, bookmapBackfillEpoch } = useDashboard();
  const primitiveRef = useRef<DepthHeatmapPrimitive | null>(null);

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
}
