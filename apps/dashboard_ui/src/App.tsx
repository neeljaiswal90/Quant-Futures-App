/**
 * App composition — dashboard-first layout.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { DashboardProvider, useDashboardSelector } from "./store/context";
import { AlertProvider } from "./alerts/AlertProvider";
import { TopBar } from "./components/TopBar";
import { Banners } from "./components/Banners";
import { Scenarios } from "./components/Scenarios";
import { LiveFeed } from "./components/LiveFeed";
import { PriceContext } from "./components/PriceContext";
import { TradePosture } from "./components/TradePosture";
import { MethodologyHealth } from "./components/MethodologyHealth";
import {
  HorizontalSplitter,
  MAX_CHART_FRACTION,
  MIN_CHART_FRACTION,
} from "./components/HorizontalSplitter";

const CHART_FRACTION_STORAGE_KEY = "ui.chartFraction.v1";
const DEFAULT_CHART_FRACTION = 0.78;

function loadStoredFraction(): number {
  try {
    const raw = localStorage.getItem(CHART_FRACTION_STORAGE_KEY);
    if (raw == null) return DEFAULT_CHART_FRACTION;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_CHART_FRACTION;
    return Math.max(
      MIN_CHART_FRACTION,
      Math.min(MAX_CHART_FRACTION, parsed),
    );
  } catch {
    return DEFAULT_CHART_FRACTION;
  }
}
import { HistoryPanel } from "./components/HistoryPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { DomLadder } from "./components/DomLadder";
import { Footer } from "./components/Footer";
import { PriceChart } from "./chart/PriceChart";
import { ChartErrorBoundary } from "./chart/ChartErrorBoundary";
import { isEmpty } from "./store/selectors";

function ChartArea() {
  // RA-112: subscribe to the derived emptiness boolean only — flips once
  // (awaiting → live), never re-renders the chart panel on data churn.
  const empty = useDashboardSelector(isEmpty);
  return (
    <div className="chart-panel">
      {empty ? (
        <div className="empty" style={{ padding: 16 }}>
          Awaiting first snapshot from the realtime feed…
        </div>
      ) : (
        <ChartErrorBoundary>
          <PriceChart />
        </ChartErrorBoundary>
      )}
    </div>
  );
}

function Shell() {
  // Drag-resizable chart vs bottom-row split. Default ~78% chart, 22% bottom.
  // Operator's pick persists across reloads via localStorage.
  const mainRef = useRef<HTMLDivElement | null>(null);
  const [chartFraction, setChartFraction] = useState<number>(loadStoredFraction);

  // Persist drag updates with light debounce — the splitter fires on every
  // mousemove; we only need to checkpoint after the user lets go.
  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        localStorage.setItem(CHART_FRACTION_STORAGE_KEY, String(chartFraction));
      } catch {
        // ignore (private browsing, etc.)
      }
    }, 200);
    return () => window.clearTimeout(id);
  }, [chartFraction]);

  const handleResize = useCallback((f: number) => setChartFraction(f), []);

  // grid-template-rows piped from state so the chart row / bottom row sizes
  // track the splitter in real time. 6px is the splitter handle.
  const gridRows = `auto ${chartFraction}fr 6px ${1 - chartFraction}fr`;

  return (
    <div className="app">
      <TopBar />
      <Banners />
      <div className="main" ref={mainRef} style={{ gridTemplateRows: gridRows }}>
        {/*
         * Layout (operator-locked 2026-06-01, resizable 2026-06-02):
         *   1. PriceContext (+ Scenarios when active) — compact summary row.
         *   2. Decision surface — chart is the dominant element. The grid
         *      row height is state-driven; the operator drags the splitter
         *      below to grow/shrink the chart against the bottom row.
         *   3. Bottom row — three equal columns: LiveFeed / HistoryPanel /
         *      TradePosture (the trade-strategy synthesis panel).
         */}
        <div className="top-context">
          <PriceContext />
          <Scenarios />
        </div>
        <div className="decision-surface">
          <ChartArea />
          <DomLadder />
        </div>
        <HorizontalSplitter mainRef={mainRef} onResize={handleResize} />
        <div className="bottom-row">
          <LiveFeed />
          <HistoryPanel />
          <TradePosture />
        </div>
      </div>
      <MethodologyHealth />
      <SettingsPanel />
      <Footer />
    </div>
  );
}

export function App() {
  return (
    <DashboardProvider>
      <AlertProvider>
        <Shell />
      </AlertProvider>
    </DashboardProvider>
  );
}
