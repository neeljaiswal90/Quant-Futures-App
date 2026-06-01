/**
 * App composition — dashboard-first layout.
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
import { DomLadder } from "./components/DomLadder";
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
