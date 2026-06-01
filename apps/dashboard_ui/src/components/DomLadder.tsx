import { useCallback, useEffect, useMemo, useState } from "react";
import type { DepthPayload } from "@contracts/realtime/events";
import { formatMnqPrice } from "../contract/render";
import { priceToTickKey, snapPrice, tickKeyToPrice } from "../chart/priceGrid";
import { useNow } from "../hooks/useNow";
import { useDashboard } from "../store/context";
import {
  buildDomLadderRows,
  domLadderWheelShift,
  shouldRecenterDomLadder,
} from "./domLadderModel";

type DomLadderMode = "follow" | "manual";

function qualityClass(quality: DepthPayload["quality"]): string {
  return `dom-quality-${quality}`;
}

function ageLabel(tsNs: number): string {
  const ageMs = Date.now() - Math.floor(tsNs / 1e6);
  if (ageMs < 1000) return "<1s";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s`;
  return `${Math.floor(ageMs / 60_000)}m`;
}

export function DomLadder() {
  const { state } = useDashboard();
  const now = useNow(1000);
  const depth = state.depth;
  const activePrice = depth?.mid ?? state.price.price;
  const [centerPrice, setCenterPrice] = useState<number | null>(null);
  const [centerNTicks, setCenterNTicks] = useState<number | null>(null);
  const [mode, setMode] = useState<DomLadderMode>("follow");

  useEffect(() => {
    if (!depth || activePrice == null || depth.quality === "unavailable") return;
    if (mode === "manual") {
      if (centerNTicks !== depth.n_ticks) setCenterNTicks(depth.n_ticks);
      return;
    }
    if (
      centerNTicks !== depth.n_ticks ||
      shouldRecenterDomLadder(centerPrice, activePrice, depth.n_ticks)
    ) {
      setCenterPrice(snapPrice(activePrice));
      setCenterNTicks(depth.n_ticks);
    }
  }, [activePrice, centerNTicks, centerPrice, depth, mode]);

  const shiftCenter = useCallback(
    (ticks: number) => {
      if (ticks === 0 || (!centerPrice && activePrice == null)) return;
      const basePrice = centerPrice ?? activePrice;
      if (basePrice == null) return;
      setCenterPrice(tickKeyToPrice(priceToTickKey(basePrice) + ticks));
      if (depth) setCenterNTicks(depth.n_ticks);
      setMode("manual");
    },
    [activePrice, centerPrice, depth],
  );

  const recenter = useCallback(() => {
    if (activePrice == null) return;
    setCenterPrice(snapPrice(activePrice));
    if (depth) setCenterNTicks(depth.n_ticks);
  }, [activePrice, depth]);

  const followPrice = useCallback(() => {
    setMode("follow");
    recenter();
  }, [recenter]);

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      shiftCenter(domLadderWheelShift(event.deltaY));
    },
    [shiftCenter],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowUp") {
        event.preventDefault();
        shiftCenter(1);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        shiftCenter(-1);
      }
    },
    [shiftCenter],
  );

  const rows = useMemo(() => {
    if (!depth || centerPrice == null) return [];
    return buildDomLadderRows({
      depth,
      centerPrice,
      lastPrice: state.price.price,
      zones: state.zones,
      history: state.history,
      nowMs: now,
    });
  }, [centerPrice, depth, now, state.history, state.price.price, state.zones]);

  const empty =
    !depth ||
    depth.quality === "unavailable" ||
    centerPrice == null ||
    rows.length === 0;

  return (
    <div className={`panel dom-ladder ${depth ? qualityClass(depth.quality) : ""}`}>
      <div className="dom-ladder-head">
        <h2>DOM ladder</h2>
        <div className="dom-ladder-status">
          <span className={`dom-mode-chip dom-mode-${mode}`}>
            {mode === "follow" ? "Follow" : "Manual"}
          </span>
          <span className="kv">
            {depth ? `${depth.quality} · ${ageLabel(depth.ts_ns)}` : "waiting"}
          </span>
        </div>
      </div>
      {!empty && (
        <div className="dom-ladder-controls" aria-label="DOM ladder controls">
          <button
            type="button"
            className={`dom-control ${mode === "follow" ? "dom-control-on" : ""}`}
            onClick={followPrice}
            aria-pressed={mode === "follow"}
          >
            Follow price
          </button>
          <button type="button" className="dom-control" onClick={recenter}>
            Recenter
          </button>
        </div>
      )}
      {empty ? (
        <p className="empty">Waiting for depth…</p>
      ) : (
        <div
          className="dom-ladder-rows"
          role="table"
          aria-label="Depth ladder"
          tabIndex={0}
          onWheel={onWheel}
          onKeyDown={onKeyDown}
        >
          {rows.map((row) => (
            <div
              className={[
                "dom-row",
                row.isLastPrice ? "dom-row-last" : "",
                row.isLiveRestingPrice ? "dom-row-live" : "",
              ].join(" ")}
              key={row.price}
              role="row"
            >
              <div className="dom-cell dom-bid" role="cell">
                {row.bidSize > 0 && (
                  <span
                    className="dom-size-bar dom-size-bid"
                    style={{ width: `${Math.max(8, row.bidPct * 100)}%` }}
                  />
                )}
                <span>{row.bidSize || ""}</span>
              </div>
              <div className="dom-cell dom-price" role="cell">
                {formatMnqPrice(row.price)}
              </div>
              <div className="dom-cell dom-ask" role="cell">
                {row.askSize > 0 && (
                  <span
                    className="dom-size-bar dom-size-ask"
                    style={{ width: `${Math.max(8, row.askPct * 100)}%` }}
                  />
                )}
                <span>{row.askSize || ""}</span>
              </div>
              <div className="dom-cell dom-tags" role="cell">
                {row.icebergOpacity > 0 && (
                  <span
                    className="dom-chip dom-chip-iceberg"
                    style={{ opacity: row.icebergOpacity }}
                  >
                    ICE
                  </span>
                )}
                {row.zoneLabels.slice(0, 2).map((label) => (
                  <span className="dom-chip" key={label}>
                    {label}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
