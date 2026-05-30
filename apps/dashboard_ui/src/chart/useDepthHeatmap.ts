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

export function useDepthHeatmap(
  seriesRef: RefObject<ISeriesApi<"Line"> | null>,
): void {
  const { state } = useDashboard();
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
}
