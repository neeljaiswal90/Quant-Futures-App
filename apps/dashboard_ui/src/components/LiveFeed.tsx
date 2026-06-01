/**
 * Tier-3 live feed: the last 10 events ordered by recency + strength, with a
 * time-decay opacity so stale rows fade. Ordering + opacity come from the
 * pure sortFeed / feedOpacity helpers.
 */
import { useMemo } from "react";
import { useDashboard } from "../store/context";
import { useNow } from "../hooks/useNow";
import { feedBias, feedOpacity, sortFeed, type FeedBias } from "../contract/render";

function tierClass(tier: string | null): string {
  return tier ? `tier-${tier}` : "tier-none";
}

const BIAS_LABEL: Record<FeedBias, string> = {
  bullish: "BULL",
  bearish: "BEAR",
  neutral: "NEUT",
};

export function LiveFeed() {
  const { state } = useDashboard();
  const now = useNow(2000);
  const feed = useMemo(() => sortFeed(state.feed), [state.feed]);
  const rowNodes = useMemo(
    () =>
      feed.map((item) => {
        const ageMs = now - Math.floor(item.tsNs / 1e6);
        const bias = feedBias(item);
        return (
          <div
            className={`feed-row feed-row-${bias}`}
            key={`${item.seq}-${item.tsNs}`}
            style={{ opacity: feedOpacity(ageMs) }}
          >
            <span className={`feed-bias feed-bias-${bias}`}>
              {BIAS_LABEL[bias]}
            </span>
            <span className={`tier-tag ${tierClass(item.tier)}`}>
              {item.tier ?? item.family.slice(0, 3).toUpperCase()}
            </span>
            <span>{item.text}</span>
          </div>
        );
      }),
    [feed, now],
  );

  return (
    <div className="panel">
      <h2>Live feed</h2>
      {feed.length === 0 ? (
        <p className="empty">Waiting for events…</p>
      ) : (
        rowNodes
      )}
    </div>
  );
}
