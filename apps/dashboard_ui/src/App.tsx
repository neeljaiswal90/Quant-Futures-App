/**
 * App composition — the 5-tier layout.
 *
 *   Tier 1  alert banner (CRITICAL) + degraded link banner
 *   Tier 2  active scenarios
 *   Tier 3  live feed
 *   Tier 4  price context + chart
 *   Tier 5  collapsed history + settings
 *
 * Providers: DashboardProvider (single store + WS) wraps AlertProvider (which
 * reads the store to fire tier alerts).
 */
import { DashboardProvider, useDashboard } from "./store/context";
import { AlertProvider } from "./alerts/AlertProvider";
import { TopBar } from "./components/TopBar";
import { Banners } from "./components/Banners";
import { Scenarios } from "./components/Scenarios";
import { LiveFeed } from "./components/LiveFeed";
import { PriceContext } from "./components/PriceContext";
import { HistoryPanel } from "./components/HistoryPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { Footer } from "./components/Footer";
import { PriceChart } from "./chart/PriceChart";
import { ChartErrorBoundary } from "./chart/ChartErrorBoundary";
import { isEmpty } from "./store/selectors";

function ChartArea() {
  const { state } = useDashboard();
  return (
    <div className="chart-panel">
      {isEmpty(state) ? (
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
        <div className="chart-col">
          <PriceContext />
          <ChartArea />
        </div>
        <div className="side-col">
          <Scenarios />
          <LiveFeed />
          <div style={{ overflow: "auto", display: "grid", gap: 8 }}>
            <HistoryPanel />
            <SettingsPanel />
          </div>
        </div>
      </div>
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
