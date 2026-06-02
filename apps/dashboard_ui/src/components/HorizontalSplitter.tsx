/**
 * Drag-to-resize horizontal splitter between the decision surface (chart row)
 * and the bottom row. The drag updates a fraction in [MIN, MAX] that the
 * Shell pipes into the main grid as state-driven `fr` units, so the chart
 * row grows/shrinks against the bottom row in real time. Position is
 * persisted in localStorage so the operator's pick survives reloads.
 *
 * Pure mouse-driven; tests run through useChartFraction (logic) without
 * needing the DOM events here.
 */
import { useCallback, type RefObject } from "react";

export const MIN_CHART_FRACTION = 0.35;
export const MAX_CHART_FRACTION = 0.92;

interface Props {
  /** The `.main` grid container (used to compute the available drag range). */
  mainRef: RefObject<HTMLDivElement | null>;
  /** Called continuously during the drag with the new fraction in [MIN, MAX]. */
  onResize: (fraction: number) => void;
}

export function HorizontalSplitter({ mainRef, onResize }: Props): JSX.Element {
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const container = mainRef.current;
      if (!container) return;

      // The drag range is the slab between the top-context row's bottom edge
      // and the bottom of the main container. We compute it once at drag-start
      // and use it for every mousemove tick — avoids re-measuring on each
      // event (which would cause feedback if layout shifts).
      const containerRect = container.getBoundingClientRect();
      const topContext = container.querySelector(".top-context");
      const topContextBottom =
        topContext != null
          ? topContext.getBoundingClientRect().bottom
          : containerRect.top;
      const rangeTop = topContextBottom;
      const rangeBottom = containerRect.bottom;
      const range = rangeBottom - rangeTop;
      if (range <= 0) return;

      const handleMove = (ev: MouseEvent) => {
        const relativeY = ev.clientY - rangeTop;
        const raw = relativeY / range;
        const fraction = Math.max(
          MIN_CHART_FRACTION,
          Math.min(MAX_CHART_FRACTION, raw),
        );
        onResize(fraction);
      };
      const handleUp = () => {
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [mainRef, onResize],
  );

  return (
    <div
      className="splitter-h"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize chart vs bottom row"
      onMouseDown={handleMouseDown}
    >
      <div className="splitter-h-grip" />
    </div>
  );
}
