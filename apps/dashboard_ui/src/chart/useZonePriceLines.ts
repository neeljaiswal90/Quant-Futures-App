/**
 * Zone -> price-line layer (Phase 3).
 *
 * Reconciles the store's zones onto the candlestick series as horizontal
 * price lines colored by kind (zoneToPriceLine). Low-frequency, so this is
 * driven by React state (the store), unlike the per-tick price path.
 *
 * Reconciliation is diff-based: a zone_update (merge-by-id) changes the zone
 * array; we add/update/remove price lines to match without recreating the
 * whole set every render.
 */
import { useEffect, useRef, type RefObject } from "react";
import { LineStyle, type IPriceLine, type ISeriesApi } from "lightweight-charts";
import { useDashboard } from "../store/context";
import { zoneToPriceLine } from "../contract/render";

export function useZonePriceLines(
  seriesRef: RefObject<ISeriesApi<"Candlestick"> | null>,
) {
  const { state } = useDashboard();
  const linesRef = useRef<Map<string, IPriceLine>>(new Map());

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const lines = linesRef.current;
    const seen = new Set<string>();

    for (const zone of state.zones) {
      const desc = zoneToPriceLine(zone);
      seen.add(desc.id);
      const existing = lines.get(desc.id);
      const options = {
        price: desc.price,
        color: desc.color,
        lineWidth: 1 as const,
        lineStyle: desc.dashed ? LineStyle.Dashed : LineStyle.Solid,
        axisLabelVisible: true,
        title: desc.title,
      };
      if (existing) {
        existing.applyOptions(options);
      } else {
        lines.set(desc.id, series.createPriceLine(options));
      }
    }

    // Remove lines whose zone disappeared (rare; merge-by-id is additive).
    for (const [id, line] of lines) {
      if (!seen.has(id)) {
        series.removePriceLine(line);
        lines.delete(id);
      }
    }
  }, [state.zones, seriesRef]);

  // Clear on unmount so a remounted chart starts clean.
  useEffect(() => {
    const lines = linesRef.current;
    return () => {
      lines.clear();
    };
  }, []);
}
