import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ChartErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("chart failed", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="chart-error" role="alert">
          <strong>Chart paused</strong>
          <span>{this.state.error.message}</span>
          <button
            className="btn"
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
