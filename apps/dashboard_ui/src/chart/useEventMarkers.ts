/**
 * Event bubble layer.
 *
 * Series markers are time/bar-anchored, so they cannot answer "what price did
 * this event happen at?" RA-077a replaces them with a lightweight-charts series
 * primitive that draws dots at the event's actual `(time, price)` coordinate.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type {
  IChartApi,
  ISeriesApi,
  MouseEventParams,
  SeriesType,
  Time,
} from "lightweight-charts";
import { useDashboard } from "../store/context";
import {
  anchorSeriesData,
  EVENT_BUBBLE_ID_PREFIX,
  EventBubblePrimitive,
  eventBubbleTooltip,
  feedItemToBubbleItem,
  projectBubbleItems,
  type EventBubbleItem,
  type HoveredEventBubble,
} from "./eventBubbles";

const MAX_DRAWN_EVENT_BUBBLES = 600;

export function useEventMarkers<T extends SeriesType>(
  chartRef: RefObject<IChartApi | null>,
  seriesRef: RefObject<ISeriesApi<T> | null>,
  anchorSeriesRef?: RefObject<ISeriesApi<"Line"> | null>,
): HoveredEventBubble | null {
  const { state } = useDashboard();
  const primitiveRef = useRef<EventBubblePrimitive | null>(null);
  const [hovered, setHovered] = useState<HoveredEventBubble | null>(null);

  const items = useMemo(
    () =>
      state.history
        .map(feedItemToBubbleItem)
        .filter((item): item is EventBubbleItem => item !== null),
    [state.history],
  );
  const drawnItems = useMemo(
    () => items.slice(-MAX_DRAWN_EVENT_BUBBLES),
    [items],
  );

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const primitive = new EventBubblePrimitive();
    series.attachPrimitive(primitive);
    primitiveRef.current = primitive;
    return () => {
      series.detachPrimitive(primitive);
      if (primitiveRef.current === primitive) primitiveRef.current = null;
    };
  }, [seriesRef]);

  useEffect(() => {
    primitiveRef.current?.setItems(drawnItems);
    // setData requires strictly-ascending UNIQUE times; minute-bucketed signals
    // share timestamps, so dedupe before feeding the transparent anchor series.
    anchorSeriesRef?.current?.setData(anchorSeriesData(drawnItems));
  }, [anchorSeriesRef, drawnItems]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const handleMove = (param: MouseEventParams<Time>) => {
      const objectId = param.hoveredInfo?.objectId ?? param.hoveredObjectId;
      if (
        typeof objectId === "string" &&
        objectId.startsWith(EVENT_BUBBLE_ID_PREFIX) &&
        param.point
      ) {
        const item = primitiveRef.current?.itemById(objectId);
        if (item) {
          setHovered({
            item,
            point: { x: param.point.x, y: param.point.y },
          });
          return;
        }
      }
      const series = seriesRef.current;
      if (param.point && series) {
        const nearest = projectBubbleItems(
          drawnItems,
          (time) => chart.timeScale().timeToCoordinate(time),
          (price) => series.priceToCoordinate(price),
        )
          .map((point) => ({
            point,
            distance: Math.hypot(point.x - param.point!.x, point.y - param.point!.y),
          }))
          .filter(({ point, distance }) => distance <= point.radius + 6)
          .sort((a, b) => a.distance - b.distance)[0];
        if (nearest) {
          setHovered({
            item: nearest.point,
            point: { x: nearest.point.x, y: nearest.point.y },
          });
          return;
        }
      }
      setHovered(null);
    };
    chart.subscribeCrosshairMove(handleMove);
    return () => {
      chart.unsubscribeCrosshairMove(handleMove);
    };
  }, [chartRef, drawnItems, seriesRef]);

  return hovered;
}

export { eventBubbleTooltip };
