/**
 * A wall-clock pulse hook. Returns Date.now() refreshed every `intervalMs`.
 * Drives client-side decay (Tier-1 banner >50pt/30min) and staleness
 * re-evaluation at render time without coupling to the WS frame cadence.
 */
import { useEffect, useState } from "react";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
