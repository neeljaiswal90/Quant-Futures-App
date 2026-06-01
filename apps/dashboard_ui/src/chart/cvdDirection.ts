import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  AutoscaleInfo,
  Coordinate,
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  LineData,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from "lightweight-charts";

export type CvdDirection = "bullish" | "bearish" | "neutral";

export interface CvdFlipMarker {
  id: string;
  time: UTCTimestamp;
  direction: Exclude<CvdDirection, "neutral">;
  strong: boolean;
}

interface ProjectedCvdFlipMarker extends CvdFlipMarker {
  x: number;
  y: number;
}

type CoordinateFn<T> = (value: T) => Coordinate | number | null;

export const CVD_BULLISH_COLOR = "#3fb950";
export const CVD_BEARISH_COLOR = "#f85149";
export const CVD_NEUTRAL_COLOR = "#8b949e";
const MAX_CVD_FLIP_MARKERS = 500;

function sign(value: number): -1 | 0 | 1 {
  if (!Number.isFinite(value) || value === 0) return 0;
  return value > 0 ? 1 : -1;
}

export function cvdDirection(value: number): CvdDirection {
  const current = sign(value);
  if (current > 0) return "bullish";
  if (current < 0) return "bearish";
  return "neutral";
}

export function cvdPointColor(value: number): string {
  const direction = cvdDirection(value);
  if (direction === "bullish") return CVD_BULLISH_COLOR;
  if (direction === "bearish") return CVD_BEARISH_COLOR;
  return CVD_NEUTRAL_COLOR;
}

export function colorCvdPoint<T extends UTCTimestamp>(
  point: LineData<T>,
): LineData<T> {
  return { ...point, color: cvdPointColor(point.value) };
}

export function cvdFlipMarkerFromTransition(
  previousValue: number | null,
  nextValue: number,
  time: UTCTimestamp,
  strong = false,
): CvdFlipMarker | null {
  const previousSign = previousValue == null ? 0 : sign(previousValue);
  const nextSign = sign(nextValue);
  const localCross =
    previousSign !== 0 && nextSign !== 0 && previousSign !== nextSign;
  if (!localCross && (!strong || nextSign === 0)) return null;
  return {
    id: `cvd-flip:${time}:${nextSign}:${strong ? "strong" : "local"}`,
    time,
    direction: nextSign > 0 ? "bullish" : "bearish",
    strong,
  };
}

export function cvdFlipMarkersFromPoints(
  points: readonly LineData<UTCTimestamp>[],
): CvdFlipMarker[] {
  const markers: CvdFlipMarker[] = [];
  let previousValue: number | null = null;
  for (const point of points) {
    const marker = cvdFlipMarkerFromTransition(
      previousValue,
      point.value,
      point.time,
    );
    if (marker) markers.push(marker);
    if (sign(point.value) !== 0) previousValue = point.value;
  }
  return markers;
}

function projectCvdFlipMarkers(
  markers: readonly CvdFlipMarker[],
  timeToCoordinate: CoordinateFn<UTCTimestamp>,
  priceToCoordinate: CoordinateFn<number>,
): ProjectedCvdFlipMarker[] {
  const y = priceToCoordinate(0);
  if (y == null) return [];
  const projected: ProjectedCvdFlipMarker[] = [];
  for (const marker of markers) {
    const x = timeToCoordinate(marker.time);
    if (x == null) continue;
    projected.push({ ...marker, x: Number(x), y: Number(y) });
  }
  return projected;
}

class CvdFlipMarkerRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly markers: readonly ProjectedCvdFlipMarker[]) {}

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      for (const marker of this.markers) {
        if (marker.x < -4 || marker.x > mediaSize.width + 4) continue;
        const height = marker.strong ? 20 : 12;
        ctx.save();
        ctx.strokeStyle =
          marker.direction === "bullish" ? CVD_BULLISH_COLOR : CVD_BEARISH_COLOR;
        ctx.lineWidth = marker.strong ? 2.4 : 1.4;
        ctx.beginPath();
        ctx.moveTo(marker.x, marker.y - height / 2);
        ctx.lineTo(marker.x, marker.y + height / 2);
        ctx.stroke();
        if (marker.strong) {
          ctx.fillStyle = "rgba(254, 240, 138, 0.86)";
          ctx.beginPath();
          ctx.arc(marker.x, marker.y, 3.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    });
  }
}

class CvdFlipMarkerPaneView implements IPrimitivePaneView {
  private markers: readonly ProjectedCvdFlipMarker[] = [];

  update(markers: readonly ProjectedCvdFlipMarker[]): void {
    this.markers = markers;
  }

  renderer(): IPrimitivePaneRenderer {
    return new CvdFlipMarkerRenderer(this.markers);
  }
}

export class CvdFlipMarkerPrimitive implements ISeriesPrimitive<Time> {
  private readonly view = new CvdFlipMarkerPaneView();
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private markers: CvdFlipMarker[] = [];

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
    this.updateAllViews();
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
    this.view.update([]);
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  autoscaleInfo(): AutoscaleInfo | null {
    return null;
  }

  updateAllViews(): void {
    if (this.chart == null || this.series == null) {
      this.view.update([]);
      return;
    }
    this.view.update(
      projectCvdFlipMarkers(
        this.markers,
        (time) => this.chart?.timeScale().timeToCoordinate(time) ?? null,
        (price) => this.series?.priceToCoordinate(price) ?? null,
      ),
    );
  }

  setMarkers(markers: readonly CvdFlipMarker[]): void {
    this.markers = markers.slice(-MAX_CVD_FLIP_MARKERS);
    this.updateAllViews();
    this.requestUpdate?.();
  }
}
