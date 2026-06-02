/**
 * RA-112e step 4c — σ supply/demand shelves chart primitive.
 *
 * Renders the v3 + v2-legacy shelves from the wire contract as filled bands
 * behind the price line. v3 is the production geometry (anchored at the
 * rolling 60-min VWAP — see the methodology doc); v2 is rendered as a
 * subordinate dashed outline alongside so the operator can compare the two
 * during the shadow-mode validation window.
 *
 * Per the operator's locked decisions (2026-06-01):
 *   - v3: normal fill, normal labels, primary interaction target
 *   - v2: low-opacity dashed outline, label suffix "(v2 legacy)"
 *
 * Color palette (matches the standing convention in
 * convention_sigma_zone_construction memory + the Tradesea draws):
 *   - σ1/σ2/σ3 supply: #f85149 / #c14842 / #9e3a35
 *   - σ1/σ2/σ3 demand: #3fb950 / #308a3d / #256e32
 */
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type {
  AutoscaleInfo,
  Coordinate,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { Shelf } from "@contracts/realtime/events";

export const FAMILY_V3 = "sigma_v3_vwap_anchor";
export const FAMILY_V3_QUANTILE = "sigma_v3_vwap_anchor_quantile";
export const FAMILY_V2 = "sigma_v2_session_value_anchor";

/** Fill opacity (0 = transparent .. 1 = opaque) for v3 RMS shelves. */
const V3_FILL_ALPHA = 0.18;
/** Outline opacity for the v3 quantile shadow (RA-112e step 6). */
const V3_QUANTILE_OUTLINE_ALPHA = 0.7;
/** Outline (no fill) opacity for v2 legacy shelves. */
const V2_OUTLINE_ALPHA = 0.55;

interface SupplyDemandPalette {
  supply: readonly [string, string, string]; // tier 1, 2, 3
  demand: readonly [string, string, string];
}

const PALETTE: SupplyDemandPalette = {
  supply: ["#f85149", "#c14842", "#9e3a35"],
  demand: ["#3fb950", "#308a3d", "#256e32"],
};

function shelfFillColor(shelf: Shelf, alpha: number): string {
  const tier = Math.max(1, Math.min(3, Math.round(shelf.tier))) - 1;
  const ramp = shelf.name.startsWith("SUP_") ? PALETTE.supply : PALETTE.demand;
  return hexWithAlpha(ramp[tier], alpha);
}

function hexWithAlpha(hex: string, alpha: number): string {
  // #RRGGBB -> rgba(r, g, b, a)
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
}

interface ProjectedShelf {
  shelf: Shelf;
  /** Top edge y-coord (the lower y value in screen space). */
  top: number;
  /** Bottom edge y-coord (the higher y value in screen space). */
  bottom: number;
  fillColor: string;
  outlineColor: string;
}

type CoordinateFn<T> = (value: T) => Coordinate | number | null;

/**
 * Project shelves into screen coordinates. Skips any shelf whose
 * priceToCoordinate returns null (off-screen / unsupported price).
 * Exported for unit testing.
 */
export function projectShelves(
  shelves: readonly Shelf[],
  priceToCoordinate: CoordinateFn<number>,
): ProjectedShelf[] {
  const projected: ProjectedShelf[] = [];
  for (const shelf of shelves) {
    const top = priceToCoordinate(shelf.high);
    const bottom = priceToCoordinate(shelf.low);
    if (top == null || bottom == null) continue;
    // Fill only the production v3 RMS family. Quantile + v2 render as
    // outlined-only (different stroke styles in the renderer pick them
    // apart visually). Outline alpha differs by family so v3 quantile
    // reads as a foreground comparison vs v2 as a subordinate legacy.
    const isV3Rms = shelf.family === FAMILY_V3;
    const isV3Quantile = shelf.family === FAMILY_V3_QUANTILE;
    const outlineAlpha = isV3Quantile
      ? V3_QUANTILE_OUTLINE_ALPHA
      : V2_OUTLINE_ALPHA;
    projected.push({
      shelf,
      top: Number(top),
      bottom: Number(bottom),
      fillColor: shelfFillColor(shelf, isV3Rms ? V3_FILL_ALPHA : 0),
      outlineColor: shelfFillColor(shelf, outlineAlpha),
    });
  }
  return projected;
}

class SigmaShelvesRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly shelves: readonly ProjectedShelf[]) {}

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      // Three passes so the visual hierarchy is consistent:
      //   1. v3 RMS — filled (primary, production).
      //   2. v3 quantile — dotted outline (RA-112e step 6 shadow estimator).
      //   3. v2 legacy — dashed outline (older shadow comparison).
      for (const p of this.shelves) {
        if (p.shelf.family !== FAMILY_V3) continue;
        if (p.bottom < 0 || p.top > mediaSize.height) continue;
        ctx.fillStyle = p.fillColor;
        ctx.fillRect(0, p.top, mediaSize.width, Math.max(1, p.bottom - p.top));
      }
      for (const p of this.shelves) {
        if (p.shelf.family !== FAMILY_V3_QUANTILE) continue;
        if (p.bottom < 0 || p.top > mediaSize.height) continue;
        ctx.save();
        ctx.strokeStyle = p.outlineColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);  // dotted, distinct from v2 dashed
        ctx.strokeRect(
          0,
          p.top,
          mediaSize.width,
          Math.max(1, p.bottom - p.top),
        );
        ctx.restore();
      }
      for (const p of this.shelves) {
        if (p.shelf.family !== FAMILY_V2) continue;
        if (p.bottom < 0 || p.top > mediaSize.height) continue;
        ctx.save();
        ctx.strokeStyle = p.outlineColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(
          0,
          p.top,
          mediaSize.width,
          Math.max(1, p.bottom - p.top),
        );
        ctx.restore();
      }
    });
  }
}

class SigmaShelvesPaneView implements IPrimitivePaneView {
  private shelves: readonly ProjectedShelf[] = [];

  update(shelves: readonly ProjectedShelf[]): void {
    this.shelves = shelves;
  }

  zOrder(): "bottom" {
    return "bottom";
  }

  renderer(): IPrimitivePaneRenderer {
    return new SigmaShelvesRenderer(this.shelves);
  }
}

export class SigmaShelvesPrimitive implements ISeriesPrimitive<Time> {
  private readonly view = new SigmaShelvesPaneView();
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private shelves: readonly Shelf[] = [];

  attached(param: SeriesAttachedParameter<Time>): void {
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
    this.updateAllViews();
  }

  detached(): void {
    this.series = null;
    this.requestUpdate = null;
    this.shelves = [];
    this.view.update([]);
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  autoscaleInfo(): AutoscaleInfo | null {
    // The primitive projects via series.priceToCoordinate during pane updates;
    // returning an autoscaleInfo here could re-enter the primitive while the
    // chart resolves the same scale. The price line + zone lines own the scale.
    return null;
  }

  updateAllViews(): void {
    if (this.series == null) {
      this.view.update([]);
      return;
    }
    const series = this.series;
    this.view.update(
      projectShelves(this.shelves, (price) => series.priceToCoordinate(price)),
    );
  }

  setShelves(shelves: readonly Shelf[]): void {
    this.shelves = shelves;
    this.updateAllViews();
    this.requestUpdate?.();
  }
}
