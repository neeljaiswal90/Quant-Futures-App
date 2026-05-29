/**
 * Tier-3 live feed: the last 10 events ordered by recency + strength, with a
 * time-decay opacity so stale rows fade. Ordering + opacity come from the
 * pure sortFeed / feedOpacity helpers.
 */
import { useDashboard } from "../store/context";
import { useNow } from "../hooks/useNow";
import { orderedFeed } from "../store/selectors";
import { feedOpacity } from "../contract/render";

function tierClass(tier: string | null): string {
  return tier ? `tier-${tier}` : "tier-none";
}

export function LiveFeed() {
  const { state } = useDashboard();
  const now = useNow(2000);
  const feed = orderedFeed(state);

  return (
    <div className="panel">
      <h2>Live feed</h2>
      {feed.length === 0 ? (
        <p className="empty">Waiting for events…</p>
      ) : (
        feed.map((item) => {
          const ageMs = now - Math.floor(item.tsNs / 1e6);
          return (
            <div
              className="feed-row"
              key={`${item.seq}-${item.tsNs}`}
              style={{ opacity: feedOpacity(ageMs) }}
            >
              <span className={`tier-tag ${tierClass(item.tier)}`}>
                {item.tier ?? item.family.slice(0, 3).toUpperCase()}
              </span>
              <span>{item.text}</span>
            </div>
          );
        })
      )}
    </div>
  );
}
