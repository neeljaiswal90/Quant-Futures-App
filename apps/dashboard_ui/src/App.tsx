/**
 * App composition — dashboard-first layout.
 */
import { DashboardProvider, useDashboardSelector } from "./store/context";
import { AlertProvider } from "./alerts/AlertProvider";
import { TopBar } from "./components/TopBar";
import { Banners } from "./components/Banners";
import { Scenarios } from "./components/Scenarios";
import { LiveFeed } from "./components/LiveFeed";
import { PriceContext } from "./components/PriceContext";
import { TradePosture } from "./components/TradePosture";
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
  return (
    <div className="app">
      <TopBar />
      <Banners />
      <div className="main">
        {/*
         * Layout (operator-locked 2026-06-01):
         *   1. PriceContext (+ Scenarios when active) — compact summary row.
         *   2. Decision surface — chart is the dominant element (fills 1fr),
         *      DomLadder column to its right.
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
        <div className="bottom-row">
          <LiveFeed />
          <HistoryPanel />
          <TradePosture />
        </div>
      </div>
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
