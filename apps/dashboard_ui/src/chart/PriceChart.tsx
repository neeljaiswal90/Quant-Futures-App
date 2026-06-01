/**
 * Decision-map price surface — TradingView lightweight-charts v5 (Apache-2.0).
 *
 * Per-tick updates come from refs (NOT React state), so a price_tick never
 * triggers a component re-render:
 *
 *   - a poll loop reads `tickEpoch` and updates the price line, volume bars,
 *     and CVD line imperatively
 *   - setData() is used ONLY for the initial snapshot / resync seed
 *
 * The chart intentionally draws a price line rather than OHLC candles. This
 * keeps the surface focused on decision context: current price, zones,
 * event bubbles, volume, and orderflow delta.
 */
import { useEffect, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  type MouseEventParams,
  type Time,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
  createChart,
} from "lightweight-charts";
import { useDashboard } from "../store/context";
import { CandleAggregator } from "./candles";
import { MNQ_TICK, formatMnqPrice } from "../contract/render";
import { useZonePriceLines } from "./useZonePriceLines";
import { eventBubbleTooltip, useEventMarkers } from "./useEventMarkers";
import { EVENT_LEGEND_ITEMS, type EventBubbleShape } from "./eventBubbles";
import { isPriceTick } from "../contract/guards";
import { useDepthHeatmap } from "./useDepthHeatmap";
import { formatChartAxisTimePT, formatChartCrosshairTimePT } from "./timeFormat";
import {
  TradeBubblePrimitive,
  tradeBubbleFromBackfillTick,
  tradeBubbleTooltip,
  TRADE_BUBBLE_ID_PREFIX,
  type HoveredTradeBubble,
} from "./tradeBubbles";

export function PriceChart() {
  const {
    liveTickRef,
    snapshotRef,
    tickEpoch,
    bookmapBackfillRef,
    bookmapBackfillEpoch,
  } = useDashboard();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const eventAnchorRef = useRef<ISeriesApi<"Line"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const cvdRef = useRef<ISeriesApi<"Line"> | null>(null);
  const tradeBubbleRef = useRef<TradeBubblePrimitive | null>(null);
  const aggRef = useRef(new CandleAggregator(1));
  const [hoveredTrade, setHoveredTrade] = useState<HoveredTradeBubble | null>(null);
  const [showExecutions, setShowExecutions] = useState(true);
  const [showIcebergCoverage, setShowIcebergCoverage] = useState(true);
  const [legendOpen, setLegendOpen] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const agg = aggRef.current;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#0d1117" },
        textColor: "#c9d1d9",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "#161b22" },
        horzLines: { color: "#161b22" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#30363d" },
      timeScale: {
        borderColor: "#30363d",
        timeVisible: true,
        secondsVisible: true,
        tickMarkFormatter: (time: Time) => formatChartAxisTimePT(time),
      },
      localization: {
        priceFormatter: (p: number) => formatMnqPrice(p),
        timeFormatter: (time: Time) => formatChartCrosshairTimePT(time),
      },
    });
    chartRef.current = chart;

    const priceLine = chart.addSeries(LineSeries, {
      color: "#2dd4bf",
      lineWidth: 2,
      crosshairMarkerVisible: true,
      lastValueVisible: true,
      priceFormat: { type: "price", precision: 2, minMove: MNQ_TICK },
    });
    priceLineRef.current = priceLine;
    const tradeBubbles = new TradeBubblePrimitive();
    priceLine.attachPrimitive(tradeBubbles);
    tradeBubbleRef.current = tradeBubbles;

    const eventAnchor = chart.addSeries(LineSeries, {
      color: "rgba(0, 0, 0, 0)",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    eventAnchorRef.current = eventAnchor;

    const volume = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: "volume" },
        priceScaleId: "vol",
      },
      1,
    );
    volume.priceScale().applyOptions({
      scaleMargins: { top: 0.1, bottom: 0.4 },
    });
    volumeRef.current = volume;

    const cvd = chart.addSeries(
      LineSeries,
      {
        color: "#a371f7",
        lineWidth: 2,
        priceScaleId: "cvd",
        priceFormat: { type: "price", precision: 0, minMove: 1 },
      },
      1,
    );
    cvd.priceScale().applyOptions({
      scaleMargins: { top: 0.6, bottom: 0.05 },
    });
    cvdRef.current = cvd;

    const snap = snapshotRef.current;
    if (snap && isPriceTick(snap.payload) === false && "price" in snap.payload) {
      const price = (snap.payload as { price: number | null }).price;
      if (typeof price === "number") {
        const seeded = agg.seedFromSnapshot(price, snap.ts_ns);
        priceLine.setData([
          {
            time: seeded.time as UTCTimestamp,
            value: seeded.close,
          } satisfies LineData<UTCTimestamp>,
        ]);
      }
    }

    return () => {
      priceLine.detachPrimitive(tradeBubbles);
      if (tradeBubbleRef.current === tradeBubbles) tradeBubbleRef.current = null;
      chart.remove();
      chartRef.current = null;
      priceLineRef.current = null;
      eventAnchorRef.current = null;
      volumeRef.current = null;
      cvdRef.current = null;
      agg.reset();
    };
  }, [snapshotRef]);

  useEffect(() => {
    let raf = 0;
    let lastEpoch = -1;
    let lastBackfillEpoch = -1;

    const loop = () => {
      const backfillEpoch = bookmapBackfillEpoch.current;
      if (backfillEpoch !== lastBackfillEpoch) {
        lastBackfillEpoch = backfillEpoch;
        const backfill = bookmapBackfillRef.current;
        const priceLine = priceLineRef.current;
        if (backfill && priceLine) {
          const seeded = aggRef.current.seedFromHistory(
            backfill.price_ticks.map((tick) => ({
              tsNs: tick.ts_ns,
              price: tick.price,
              bid: tick.bid,
              ask: tick.ask,
              volume: tick.volume,
              lastTradeDelta: tick.last_trade_delta,
            })),
          );
          priceLine.setData(seeded.prices);
          volumeRef.current?.setData(seeded.volumes);
          cvdRef.current?.setData(seeded.cvd);
          tradeBubbleRef.current?.setHistory(
            backfill.price_ticks.map(tradeBubbleFromBackfillTick),
          );
        }
      }
      const epoch = tickEpoch.current;
      if (epoch !== lastEpoch) {
        lastEpoch = epoch;
        const tick = liveTickRef.current;
        const priceLine = priceLineRef.current;
        if (tick && tick.price != null && priceLine) {
          if (tick.source === "snapshot") {
            const seeded = aggRef.current.seedFromSnapshot(tick.price, tick.tsNs);
            priceLine.update({
              time: seeded.time as UTCTimestamp,
              value: seeded.close,
            });
            raf = requestAnimationFrame(loop);
            return;
          }
          const { candle, volume, cvd } = aggRef.current.ingest(
            {
              family: "price_tick",
              price: tick.price,
              bid: tick.bid,
              ask: tick.ask,
              volume: tick.volume,
              orderflow: tick.orderflow,
            },
            tick.tsNs,
          );
          priceLine.update({
            time: candle.time as UTCTimestamp,
            value: candle.close,
          });
          volumeRef.current?.update({
            time: volume.time as UTCTimestamp,
            value: volume.value,
            color: volume.color,
          });
          cvdRef.current?.update({
            time: cvd.time as UTCTimestamp,
            value: cvd.value,
          });
          tradeBubbleRef.current?.appendTick({
            seq: tick.seq,
            tsNs: tick.tsNs,
            price: tick.price,
            volume: tick.volume,
            aggressorSide:
              tick.orderflow?.last_trade_aggressor === "buy" ||
              tick.orderflow?.last_trade_aggressor === "sell"
                ? tick.orderflow.last_trade_aggressor
                : "unknown",
            lastTradeDelta: tick.orderflow?.last_trade_delta ?? null,
          });
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [bookmapBackfillEpoch, bookmapBackfillRef, liveTickRef, tickEpoch]);

  useEffect(() => {
    tradeBubbleRef.current?.setVisible(showExecutions);
  }, [showExecutions]);

  useZonePriceLines(priceLineRef);
  useDepthHeatmap(priceLineRef);
  const hoveredEvent = useEventMarkers(chartRef, priceLineRef, eventAnchorRef, {
    showIcebergCoverage,
  });

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const handleMove = (param: MouseEventParams<Time>) => {
      const objectId = param.hoveredInfo?.objectId ?? param.hoveredObjectId;
      if (
        typeof objectId === "string" &&
        objectId.startsWith(TRADE_BUBBLE_ID_PREFIX) &&
        param.point
      ) {
        const item = tradeBubbleRef.current?.itemById(objectId);
        if (item) {
          setHoveredTrade({ item, point: { x: param.point.x, y: param.point.y } });
          return;
        }
      }
      setHoveredTrade(null);
    };
    chart.subscribeCrosshairMove(handleMove);
    return () => chart.unsubscribeCrosshairMove(handleMove);
  }, []);

  return (
    <div
      style={{ position: "relative", width: "100%", height: "100%", minHeight: 320 }}
    >
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%" }}
        aria-label="MNQ decision map"
      />
      <div className="chart-layer-controls" aria-label="Chart layer controls">
        <button
          type="button"
          className={`chart-toggle ${showExecutions ? "chart-toggle-on" : ""}`}
          onClick={() => setShowExecutions((value) => !value)}
          aria-pressed={showExecutions}
        >
          {showExecutions ? "Executions on" : "Executions off"}
        </button>
        <button
          type="button"
          className={`chart-toggle ${showIcebergCoverage ? "chart-toggle-on" : ""}`}
          onClick={() => setShowIcebergCoverage((value) => !value)}
          aria-pressed={showIcebergCoverage}
        >
          {showIcebergCoverage ? "Icebergs on" : "Icebergs off"}
        </button>
        <button
          type="button"
          className="chart-toggle"
          onClick={() => setLegendOpen((value) => !value)}
          aria-expanded={legendOpen}
        >
          Legend
        </button>
        {legendOpen && (
          <div className="chart-legend" role="list">
            <div className="chart-legend-row chart-legend-execution" role="listitem">
              <span className="chart-legend-exec chart-legend-exec-buy" />
              <span>Buy execution</span>
            </div>
            <div className="chart-legend-row chart-legend-execution" role="listitem">
              <span className="chart-legend-exec chart-legend-exec-sell" />
              <span>Sell execution</span>
            </div>
            {EVENT_LEGEND_ITEMS.map((item) => (
              <div key={item.family} className="chart-legend-row" role="listitem">
                <span
                  className={`chart-legend-shape chart-legend-shape-${shapeClass(item.shape)}`}
                  style={{ backgroundColor: item.fillColor, color: item.fillColor }}
                />
                <span>{item.label}</span>
              </div>
            ))}
            <div className="chart-legend-side" role="listitem">
              <span className="chart-legend-side-bid">bid/long</span>
              <span className="chart-legend-side-ask">ask/short</span>
            </div>
          </div>
        )}
      </div>
      {hoveredEvent && (
        <div
          className="event-bubble-tooltip"
          style={{
            left: hoveredEvent.point.x + 12,
            top: hoveredEvent.point.y + 12,
          }}
        >
          {eventBubbleTooltip(hoveredEvent.item)}
        </div>
      )}
      {hoveredTrade && (
        <div
          className="event-bubble-tooltip"
          style={{
            left: hoveredTrade.point.x + 12,
            top: hoveredTrade.point.y + 12,
          }}
        >
          {tradeBubbleTooltip(hoveredTrade.item)}
        </div>
      )}
    </div>
  );
}

function shapeClass(shape: EventBubbleShape): string {
  if (shape === "triangleUp" || shape === "triangleDown") return "triangle";
  return shape;
}
