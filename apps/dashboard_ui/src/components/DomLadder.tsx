import { useEffect, useMemo, useState } from "react";
import type { DepthPayload } from "@contracts/realtime/events";
import { formatMnqPrice } from "../contract/render";
import { snapPrice } from "../chart/priceGrid";
import { useNow } from "../hooks/useNow";
import { useDashboard } from "../store/context";
import {
  buildDomLadderRows,
  shouldRecenterDomLadder,
} from "./domLadderModel";

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

  useEffect(() => {
    if (!depth || activePrice == null || depth.quality === "unavailable") return;
    if (
      centerNTicks !== depth.n_ticks ||
      shouldRecenterDomLadder(centerPrice, activePrice, depth.n_ticks)
    ) {
      setCenterPrice(snapPrice(activePrice));
      setCenterNTicks(depth.n_ticks);
    }
  }, [activePrice, centerNTicks, centerPrice, depth]);

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
        <span className="kv">
          {depth ? `${depth.quality} · ${ageLabel(depth.ts_ns)}` : "waiting"}
        </span>
      </div>
      {empty ? (
        <p className="empty">Waiting for depth…</p>
      ) : (
        <div className="dom-ladder-rows" role="table" aria-label="Depth ladder">
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
