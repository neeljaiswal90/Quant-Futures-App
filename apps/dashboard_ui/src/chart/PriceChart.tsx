/**
 * Price surface — TradingView lightweight-charts v5 (Apache-2.0).
 *
 * React integration is the documented useRef + useEffect lifecycle with NO
 * community wrapper. Per-tick updates come from refs (NOT React state), so a
 * price_tick never triggers a component re-render:
 *
 *   - a poll loop reads `tickEpoch` (bumped by the WS hook on each tick) and
 *     calls candleSeries.update() / volumeSeries.update() / cvdSeries.update()
 *   - setData() is used ONLY for the initial snapshot / resync seed
 *
 * v5 API used: chart.addSeries(CandlestickSeries, …), a 2nd pane (paneIndex 1)
 * for volume + CVD, series.createPriceLine for zones (Phase 3), and
 * createSeriesMarkers for discrete events (Phase 3). Custom 0.25-tick price
 * formatter. chart.remove() on cleanup.
 */
import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  createChart,
} from "lightweight-charts";
import { useDashboard } from "../store/context";
import { CandleAggregator } from "./candles";
import { MNQ_TICK, formatMnqPrice } from "../contract/render";
import { useZonePriceLines } from "./useZonePriceLines";
import { useEventMarkers } from "./useEventMarkers";
import { isPriceTick } from "../contract/guards";

export function PriceChart() {
  const { liveTickRef, snapshotRef, tickEpoch } = useDashboard();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const cvdRef = useRef<ISeriesApi<"Line"> | null>(null);
  const aggRef = useRef(new CandleAggregator(1));

  // --- chart lifecycle -----------------------------------------------------
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
      timeScale: { borderColor: "#30363d", timeVisible: true, secondsVisible: true },
      localization: {
        // Custom 0.25-tick price formatter for the whole chart.
        priceFormatter: (p: number) => formatMnqPrice(p),
      },
    });
    chartRef.current = chart;

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderUpColor: "#26a69a",
      borderDownColor: "#ef5350",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
      priceFormat: { type: "price", precision: 2, minMove: MNQ_TICK },
    });
    candleRef.current = candle;

    // Second pane (index 1) for volume + CVD.
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

    // Seed from the latest snapshot price if present.
    const snap = snapshotRef.current;
    if (snap && isPriceTick(snap.payload) === false && "price" in snap.payload) {
      const price = (snap.payload as { price: number | null }).price;
      if (typeof price === "number") {
        const seeded = agg.seedFromSnapshot(price, snap.ts_ns);
        candle.setData([
          {
            time: seeded.time as UTCTimestamp,
            open: seeded.open,
            high: seeded.high,
            low: seeded.low,
            close: seeded.close,
          } satisfies CandlestickData<UTCTimestamp>,
        ]);
      }
    }

    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      cvdRef.current = null;
      agg.reset();
    };
  }, [snapshotRef]);

  // --- per-tick update loop (refs only, no React state) --------------------
  useEffect(() => {
    let raf = 0;
    let lastEpoch = -1;

    const loop = () => {
      const epoch = tickEpoch.current;
      if (epoch !== lastEpoch) {
        lastEpoch = epoch;
        const tick = liveTickRef.current;
        const candle = candleRef.current;
        if (tick && tick.price != null && candle) {
          const { candle: c, volume, cvd } = aggRef.current.ingest(
            {
              family: "price_tick",
              price: tick.price,
              bid: tick.bid,
              ask: tick.ask,
              volume: tick.volume,
            },
            tick.tsNs,
          );
          // update() — NOT setData() — so realtime never full-redraws.
          candle.update({
            time: c.time as UTCTimestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
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
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [liveTickRef, tickEpoch]);

  // Phase 3 layers: zones -> price lines, events -> markers.
  useZonePriceLines(candleRef);
  useEventMarkers(candleRef);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", minHeight: 320 }}
      aria-label="MNQ price chart"
    />
  );
}
