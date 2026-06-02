/**
 * RA-112e step 4c — wire the SigmaShelvesPrimitive to the live store.
 *
 * Subscribes to ``state.shelves`` via a selector so the chart only rerenders
 * shelves when they actually change (not on price ticks). Mirrors the
 * useZonePriceLines pattern so the call site in PriceChart stays uniform.
 */
import { useEffect, useRef, type RefObject } from "react";
import type { ISeriesApi, SeriesType } from "lightweight-charts";
import { useDashboardSelector } from "../store/context";
import { SigmaShelvesPrimitive } from "./sigmaShelves";

export function useSigmaShelves<T extends SeriesType>(
  seriesRef: RefObject<ISeriesApi<T> | null>,
) {
  // RA-112c-pattern: subscribe to the shelves slice only.
  const shelves = useDashboardSelector((s) => s.shelves);
  const primitiveRef = useRef<SigmaShelvesPrimitive | null>(null);

  // Mount the primitive once when the series exists.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const primitive = new SigmaShelvesPrimitive();
    series.attachPrimitive(primitive);
    primitiveRef.current = primitive;
    return () => {
      series.detachPrimitive(primitive);
      if (primitiveRef.current === primitive) primitiveRef.current = null;
    };
  }, [seriesRef]);

  // Push fresh shelves whenever the slice changes identity.
  useEffect(() => {
    primitiveRef.current?.setShelves(shelves);
  }, [shelves]);
}
