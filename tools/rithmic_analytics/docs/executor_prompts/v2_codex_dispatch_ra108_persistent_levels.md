# Codex Dispatch — RA-108: persistent-levels signal feed + chart anchors

Coordinator dispatch from operator review against a Bookmap reference screenshot dated 2026-06-01. Read `v2_codex_handoff.md` for invariants. Pre-build sweep → green-light → build → verify → ship.

## Why this exists

RA-104b widened the depth-emission window to ±50pt (n_ticks=200), letting the heatmap reach further from current price. RA-107a's wall markers surface the top-3 persistent levels — but ONLY within the currently-visible depth window, and ONLY for live persistence-accumulator scores that decay quickly (43s half-life).

The Bookmap-equivalent that operators expect: **levels that have defended the order book this session stay anchored on the chart even when price moves 30, 50, 100 points away**. Walls that absorbed buy aggression at 30,600 should still be marked when price has dropped to 30,520 — because the level WILL matter again on a retest.

This ticket adds a session-long persistent-levels detector + signal-family emission + UI anchor rendering. It's complementary to the heatmap (which shows visible-depth persistence) and to RA-107a wall markers (which show short-window dominant levels): RA-108 shows **long-window structural levels** that the operator should trade off of, irrespective of current price.

## Build

### 1. Contract — new `PersistentLevelPayload` family (additive)

In `contracts/realtime/events.py` + `contracts/realtime/events.ts`:

```python
class PersistentLevelEvidence(BaseModel):
    """Per-source evidence that contributed to a level becoming persistent."""
    source: Literal["resting_size", "iceberg_refill", "absorption", "sweep_anchor"]
    count: int = Field(ge=1)
    last_seen_ts_ns: int
    cumulative_size: float = Field(ge=0)

class PersistentLevelPayload(BaseModel):
    family: Literal["persistent_level"] = "persistent_level"
    level_id: str  # stable across emissions for the same (price, side) pair
    price: float
    side: Literal["bid", "ask", "unknown"]  # bid = floor, ask = ceiling
    persistence_seconds: float = Field(ge=0)  # how long the level has been observed
    confidence: Literal["high", "medium", "low"]
    evidence: list[PersistentLevelEvidence]  # what made it persistent
    last_active_ts_ns: int
    status: Literal["active", "deteriorating", "broken"]  # broken = price traded through decisively
    notes: str | None = None
```

Wire-side: this is a NEW payload family. Add to `KNOWN_FAMILIES` tuple in both contract files. The `Envelope` discriminated union extends additively. Run parity tripwire (`contracts/realtime/tests/test_parity.py`).

### 2. Backend detector — `services/realtime_backend/persistent_levels.py` (new)

A session-scoped detector that aggregates evidence across the existing live-signal streams:

- **Input streams** (existing, consumed read-only):
  - `iceberg` events (RA-059) — each iceberg detection at a level adds evidence
  - `absorption` events (RA-015) — same
  - `sweep` events with the sweep's anchor price — same
  - Depth frames — track which prices have sustained resting size ≥ threshold for ≥ duration
- **State**: `Map<level_id, LevelState>` where `level_id = f"{round_to_tick(price)}_{side}"`. State retains observations for the full session.
- **Promotion criteria** (level becomes "persistent" and is emitted):
  - **High confidence**: ≥ 3 distinct evidence types, OR ≥ 5 same-type observations spanning ≥ 5 min, OR an iceberg refill chain ≥ 4 refills
  - **Medium**: ≥ 2 distinct evidence types, OR ≥ 3 observations spanning ≥ 3 min
  - **Low**: 1 evidence type + ≥ 2 observations spanning ≥ 1 min — emitted but operator flagged as weak
  - Don't emit at all below the low threshold (noise)
- **Status transitions**:
  - `active` → `deteriorating` if no new evidence for ≥ 5 min
  - `deteriorating` → `broken` if price has traded through the level by ≥ 4 ticks with ≥ N lots volume
  - `broken` levels emit one final payload then stop emitting

Emit cadence: when a level changes state OR new evidence accumulates that crosses a confidence threshold. NOT every depth frame — operator should see ~5-30 persistent-level events per session, not thousands.

Config (env-driven):
- `RA108_LEVELS_MIN_PERSISTENCE_SECONDS` (default 60)
- `RA108_LEVELS_DETERIORATE_AFTER_SECONDS` (default 300)
- `RA108_LEVELS_BREAK_TICKS` (default 4)
- `RA108_LEVELS_ENABLED` (default true)

### 3. Backend wiring — `services/realtime_backend/watcher.py`

The detector module attaches to the existing live-signal dispatch path. Each existing signal-family event call triggers `persistent_levels.observe(event)`. When the detector promotes/transitions a level, it emits a `PersistentLevelPayload` via the same envelope-publish path the other families use.

No changes to the upstream detectors themselves — read-only consumption.

### 4. Frontend — anchor rendering

In `apps/dashboard_ui/src/chart/`:

- New `persistentLevels.ts` with a `PersistentLevelManager` class:
  - Consumes `PersistentLevelPayload` envelopes from the WS store
  - Maintains a `Map<level_id, IPriceLine>` of active price lines
  - Render rules:
    - **High confidence**: solid horizontal line, full alpha, label `"PERSIST <side> <price> (<persistence_seconds>s, <evidence_count>x)"`
    - **Medium**: dotted line, 70% alpha
    - **Low**: dashed, 50% alpha
    - **Deteriorating**: stroke fades to 40%
    - **Broken**: line removed after a 5s fade-out
  - Hue: pink-400 for ask (ceiling), sky-400 for bid (floor) — matches RA-107a palette
  - Spatially distinct from RA-107a wall markers (those are short-window dashed; RA-108 lines are session-long solid/dotted/dashed by confidence)
- LiveFeed integration: persistent-level events render as feed rows with a distinct chip (`LVL`) so operators can scroll back to see when each level was promoted

In `apps/dashboard_ui/src/store/`:
- Reducer handles `persistent_level` payloads, stores `levelsById: Map<string, PersistentLevelState>`
- Selector for active+deteriorating (skip broken)

### 5. Tests

Path-scoped:

- `contracts/realtime/tests/test_parity.py`: extend with `PersistentLevelPayload` round-trip + envelope union resolution.
- `services/realtime_backend/tests/test_persistent_levels.py` (new):
  - Fixture: synthetic stream of iceberg + absorption events at a known level. Assert promotion at high confidence after 3 distinct evidence types.
  - Time-window: events spanning < 1 min stay below threshold; spanning > 5 min promote to high.
  - Deterioration: no events for 5 min → status transitions to `deteriorating`.
  - Broken: simulated price-through with ≥ 4 ticks + ≥ N lots → `broken`, one final emit, then silent.
  - Determinism: same input stream → identical output sequence (hash-chain check).
- `apps/dashboard_ui/src/chart/persistentLevels.test.ts`:
  - Manager creates a price line on `active` event
  - Status update mutates line style (solid → dotted → fade)
  - `broken` event triggers line removal after the fade delay

## Hard invariants

- **Additive contract only.** New `persistent_level` family. Frozen-contract additive-only rule preserved.
- **No detector changes.** RA-059 (iceberg), RA-015 (absorption), RA-090a (sweep) untouched. RA-108 consumes their outputs read-only.
- **No capture/probe/scheduler/.env changes.** Backend module addition only.
- **Decision support only.** PersistentLevelPayload informs the operator; never triggers a trade.
- **Carve-out palette intact.** Pink/sky for liquidity context per RA-107a; saturated green/red still reserved for executions; RA-107b green-500/red-500 stays the volume-pane aggressor palette.
- **Autoscale re-entrancy preserved.** All UI rendering uses `createPriceLine` (layout-only API), never custom primitives.
- **Math.min(...arr) spread guard.** Grep before merging.
- **Surgical path-scoped commit.** Up to 3 commits acceptable: contract, backend, UI.

## Pre-build sweep gate

Sweep must cover:

1. **Promotion-threshold tuning** — show expected per-session emission count under typical RTH and Globex data volumes. Coordinator wants ~5-30 persistent levels per session, not 200. If thresholds emit too many, propose stricter cutoffs.
2. **Level merging** — when two promoted levels are within ±1 tick (rare but possible from the rounding), should they merge into one? Propose policy.
3. **Status transition timing** — coordinator default is 5 min deterioration window; verify that's reasonable against observed iceberg/absorption recurrence patterns in the captured sessions on disk.
4. **Backend state retention** — the level state Map is session-scoped. On session rollover (RTH→Globex or Globex→RTH), clear or persist? Propose policy. Default: clear at session boundary.
5. **Broken detection** — exact algorithm for "price traded through with N lots." Propose definition, edge cases (gap-through vs grind-through).
6. **UI line clutter** — at 30 persistent levels, the chart could have 30 horizontal price lines. Propose a top-K cap (e.g., only render the K nearest-to-mid active levels; the rest stay in the data store but don't render as lines).
7. **Confirmation no detector/capture/probe change.**

## Acceptance

- New `PersistentLevelPayload` round-trips py ⇄ ts. Parity tripwire green.
- Backend detector emits ~5-30 levels per RTH session against the captures on disk (verify against 2026-05-25_rth, 2026-05-27_rth, 2026-05-28_rth, 2026-05-29_rth — same sessions used for RA-096 research).
- UI renders persistent-level price lines visible at any zoom, even when price has moved far from the level.
- Levels transition through active → deteriorating → broken correctly under live conditions.
- Before/after screenshots — same dashboard state, with vs without RA-108's price lines. The "after" shot should show 3-10 labeled horizontal lines anchored at structural levels.
- pytest + vitest + tsc + lint + ruff + mypy targeted: all clean.
- No spread-pattern regressions.
- Surgical commits (contract, backend, UI separately if cleaner, or one combined commit if shipping atomically).

## Coordinator review focus

The ship report's headline is the **before/after screenshot pair**. Specifically I'll look at:
1. Are the price lines at levels that visually correlate with structural features on the chart (VWAP, VPOC, prior swing high/low)? If yes, the detector is finding the right things.
2. Do levels stay marked across operator-visible time even when price moves away?
3. Is the LiveFeed `LVL` chip event count reasonable (~1-3 per few minutes during active periods)?

If all three pass, RA-108 ships.

## Priority

Sequential after RA-104b (just landed). Independent of RA-094 (gated on RA-093b calibration report). Estimated 1-2 days for the full pipeline (contract + backend detector + UI rendering + tests).

If RA-094 calibration report lands during this work, RA-094 takes precedence — the persistent-level confidence tiers will pair naturally with scalp_score thresholds (a HIGH-confidence persistent level + HIGH scalp_score = strongest trade signal available from the dashboard).

## Future option (out of scope; for the operator)

- **RA-108a** — persistent-level performance backtesting. Run the detector across the captured session corpus, measure how often each level was retested + what % of retests held vs broke. Lets operator know which level-types (iceberg-anchored vs absorption-anchored vs sweep-anchored) have the best edge. Pairs naturally with RA-096 research findings.
- **RA-108b** — operator-set custom levels. Manual chart annotation + persistence across reloads. The same UI surface as RA-108 but with operator-defined `level_id` and confidence. Lets the operator mark "my premarket reference high" alongside detector-found levels.
- **RA-108c** — multi-day persistent levels. Levels that survived multiple sessions are extra-strong. Requires backend persistence (file or DB) across session boundaries. Defer until the single-session version is in operator hands.
