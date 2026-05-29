/**
 * Event -> marker layer (Phase 3).
 *
 * Discrete contract events (signal / sweep / iceberg / absorption) become
 * chart markers via the v5 createSeriesMarkers primitive. The marker
 * descriptors come from the pure messageToMarker mapping; this hook only
 * owns the lightweight-charts plumbing + reconciliation.
 *
 * Markers are derived from the store's session history so they persist on the
 * chart as the price scrolls. Low-frequency -> React-state driven.
 */
import { useEffect, useRef, type RefObject } from "react";
import {
  createSeriesMarkers,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useDashboard } from "../store/context";
import type { MarkerDescriptor } from "../contract/render";
import type { FeedItem } from "../contract/render";

/** Rebuild a marker descriptor from a stored feed item (ts + tier + family). */
function feedItemToMarker(item: FeedItem): SeriesMarker<UTCTimestamp> | null {
  const time = Math.floor(item.tsNs / 1e9) as UTCTimestamp;
  const TIER_COLOR: Record<string, string> = {
    CRITICAL: "#f85149",
    HIGH: "#e3b341",
    MEDIUM: "#58a6ff",
  };
  const color = item.tier ? TIER_COLOR[item.tier] : "#8b949e";

  let marker: Omit<MarkerDescriptor, "time"> | null = null;
  switch (item.family) {
    case "signal":
      marker = { position: "aboveBar", shape: "circle", color, text: item.text.slice(0, 24) };
      break;
    case "sweep":
      marker = { position: "belowBar", shape: "arrowUp", color, text: "sweep" };
      break;
    case "iceberg":
      marker = { position: "belowBar", shape: "square", color, text: "iceberg" };
      break;
    case "absorption":
      marker = { position: "aboveBar", shape: "circle", color, text: "absorb" };
      break;
    default:
      return null; // vol_regime and others: no marker
  }
  return { time, position: marker.position, shape: marker.shape, color, text: marker.text };
}

export function useEventMarkers(
  seriesRef: RefObject<ISeriesApi<"Candlestick"> | null>,
) {
  const { state } = useDashboard();
  const pluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    let plugin = pluginRef.current;
    if (!plugin) {
      plugin = createSeriesMarkers(series, []);
      pluginRef.current = plugin;
    }
    const markers: SeriesMarker<Time>[] = state.history
      .map(feedItemToMarker)
      .filter((m): m is SeriesMarker<UTCTimestamp> => m !== null)
      // lightweight-charts requires markers sorted ascending by time.
      .sort((a, b) => (a.time as number) - (b.time as number));
    plugin.setMarkers(markers);
  }, [state.history, seriesRef]);

  useEffect(() => {
    return () => {
      pluginRef.current?.detach();
      pluginRef.current = null;
    };
  }, []);
}
