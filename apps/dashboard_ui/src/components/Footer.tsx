/**
 * Footer with the TradingView lightweight-charts attribution link.
 * Required to satisfy the Apache-2.0 attribution obligation.
 */
export function Footer() {
  return (
    <div className="footer">
      Charting by{" "}
      <a
        href="https://www.tradingview.com/lightweight-charts/"
        target="_blank"
        rel="noopener noreferrer"
      >
        TradingView Lightweight Charts™
      </a>{" "}
      (Apache-2.0). Read-only decision support — no trade execution.
    </div>
  );
}
