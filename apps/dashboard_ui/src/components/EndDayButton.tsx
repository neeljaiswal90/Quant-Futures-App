import { useState } from "react";
import { defaultBackendUrl } from "../runtime/backendUrls";

const SHUTDOWN_URL =
  import.meta.env.VITE_SHUTDOWN_URL ?? defaultBackendUrl("/api/shutdown/end-day");

type ShutdownState = "idle" | "stopping" | "failed";

export function EndDayButton() {
  const [state, setState] = useState<ShutdownState>("idle");

  const requestShutdown = async () => {
    if (state === "stopping") return;
    const confirmed = window.confirm(
      "End trading day? This stops the dashboard UI, realtime backend, refresh loop, notification daemon, and Rithmic capture.",
    );
    if (!confirmed) return;

    setState("stopping");
    try {
      const response = await fetch(SHUTDOWN_URL, { method: "POST" });
      if (!response.ok) {
        throw new Error(`shutdown request failed: ${response.status}`);
      }
    } catch {
      setState("failed");
    }
  };

  return (
    <span className="end-day-control">
      <button
        className="btn btn-danger"
        disabled={state === "stopping"}
        onClick={() => void requestShutdown()}
        title="Stop the local dashboard stack and Rithmic capture"
      >
        {state === "stopping" ? "Stopping…" : "End day"}
      </button>
      {state === "failed" && (
        <span className="shutdown-status" role="status">
          stop failed
        </span>
      )}
    </span>
  );
}
