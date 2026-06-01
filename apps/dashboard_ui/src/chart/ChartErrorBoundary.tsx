import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

export class ChartErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, componentStack: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("chart failed", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="chart-error" role="alert">
          <strong>Chart paused</strong>
          <span>{this.state.error.message}</span>
          <details style={{ maxWidth: 800, textAlign: "left" }}>
            <summary style={{ cursor: "pointer", opacity: 0.7 }}>
              show stack trace
            </summary>
            <pre
              style={{
                fontSize: 10,
                maxHeight: 280,
                overflow: "auto",
                padding: 8,
                background: "rgba(0,0,0,0.4)",
                borderRadius: 4,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {this.state.error.stack ?? "(no stack)"}
              {this.state.componentStack && (
                <>
                  {"\n\n--- component stack ---\n"}
                  {this.state.componentStack}
                </>
              )}
            </pre>
          </details>
          <button
            className="btn"
            onClick={() => this.setState({ error: null, componentStack: null })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
